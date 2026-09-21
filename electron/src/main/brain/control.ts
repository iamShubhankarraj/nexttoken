/**
 * Voice-control executor: maps brain intent ids to real browser actions.
 *
 * Every case delegates to the same TabManager / Store operations the
 * `nt.tabs.*`, `nt.nav.*`, `nt.spaces.*`, and `nt.ui.*` IPC handlers use —
 * no duplicated browser logic. Intents the brain marks as sensitive
 * (terminal.run) never reach the switch directly: they route through
 * runTerminalControl, whose native confirmation dialog (exact command +
 * working directory) is the non-negotiable gate — the orchestrator's
 * safety stage forces its own confirmation first, so a voice terminal
 * command is confirmed twice before it runs.
 *
 * Renderer-only affordances (command bar, listen/stop-listening) go through
 * the ControlEnv callbacks, which main/index.ts wires to webContents events.
 */

import type { TabManager } from '../tabs';
import type { Store } from '../store';
import type { BrowserWindow } from 'electron';
import { runTerminal } from '../terminal';

export interface ControlResult {
  /** One-line description for the event log. */
  summary: string;
  /** Short spoken confirmation; defaults to "Done." when omitted. */
  speak?: string;
}

export interface ControlEnv {
  tabs: TabManager;
  store: Store;
  setSidebarCollapsed(c: boolean): void;
  setAgentPanelOpen(o: boolean): void;
  setSettingsOpen(o: boolean): void;
  /** Ask the renderer to open its command bar. */
  openCommandBar(): void;
  /** Ask the renderer to start/stop microphone capture. */
  requestListen(start: boolean): void;
  /** Push a fresh BrowserSnapshot to the renderer. */
  refreshSnapshot(): void;
  saveSoon(): void;
}

type Slots = Record<string, unknown>;

function str(slots: Slots, name: string): string {
  const v = slots[name];
  return typeof v === 'string' ? v : '';
}

function num(slots: Slots, name: string): number | null {
  const v = slots[name];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

function spaceTabs(env: ControlEnv) {
  const sid = env.store.d.activeSpaceId;
  return [...env.tabs.tabs.values()].filter((t) => t.spaceId === sid);
}

function tabLabel(t: { title: string; url: string }): string {
  return t.title && t.title !== 'New Tab' ? t.title : t.url;
}

/** Resolve ordinal (1-based, within the active space) or title fragment; default: active tab. */
function resolveTab(env: ControlEnv, slots: Slots) {
  const list = spaceTabs(env);
  const ordinal = num(slots, 'ordinal');
  if (ordinal !== null) {
    const t = list[ordinal - 1];
    if (t) return t;
    throw new Error(`There is no tab ${ordinal} in this Space.`);
  }
  const target = str(slots, 'target').toLowerCase();
  if (target) {
    const t = list.find((x) => tabLabel(x).toLowerCase().includes(target));
    if (t) return t;
    throw new Error(`I couldn't find a tab matching "${str(slots, 'target')}".`);
  }
  const active = env.tabs.activeTabId ? env.tabs.tabs.get(env.tabs.activeTabId) : undefined;
  if (!active) throw new Error('There is no active tab.');
  return active;
}

function withScheme(raw: string): string {
  const t = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  return `https://${t}`;
}

async function runInPage(env: ControlEnv, js: string): Promise<unknown> {
  const wc = env.tabs.activeWebContents();
  if (!wc) throw new Error('There is no active page.');
  return wc.executeJavaScript(js).catch(() => null);
}

/** Escape a string for safe interpolation into executeJavaScript. */
function jsStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * terminal.run: the ONE brain execution path for shell commands. Routes
 * through runTerminal, whose native dialog is non-negotiable: it shows the
 * exact command + working directory and nothing executes unless the user
 * clicks "Run command". The brain's safety stage has already asked once
 * (exact command + cwd in the confirm text); this dialog is the final gate.
 */
export async function runTerminalControl(
  win: BrowserWindow | null,
  slots: Slots
): Promise<ControlResult> {
  const command = str(slots, 'command');
  if (!command.trim()) throw new Error('What command should I run?');
  const cwd = str(slots, 'cwd').trim() || undefined;
  const res = await runTerminal(win, command, cwd);
  if (res.denied) {
    return { summary: 'terminal command declined at the confirmation dialog', speak: "Okay, I won't run that." };
  }
  const out: string[] = [`exit code ${res.exitCode ?? 'unknown'}${res.timedOut ? ' (timed out at 60s)' : ''}`];
  if (res.stdout.trim()) out.push(`stdout:\n${res.stdout.trim().slice(0, 2000)}`);
  if (res.stderr.trim()) out.push(`stderr:\n${res.stderr.trim().slice(0, 2000)}`);
  return { summary: `ran "${command.slice(0, 80)}" — ${out[0]}`, speak: `Command finished with ${out[0]}.` };
}

export async function executeControl(
  env: ControlEnv,
  intent: string,
  slots: Slots
): Promise<ControlResult> {
  const { tabs, store } = env;

  switch (intent) {
    // -- Tabs -------------------------------------------------------------
    case 'browser.tab.new': {
      const t = tabs.create(store.d.activeSpaceId);
      tabs.activate(t.id);
      env.refreshSnapshot();
      return { summary: 'opened a new tab', speak: 'New tab opened.' };
    }
    case 'browser.tab.close': {
      const t = resolveTab(env, slots);
      const label = tabLabel(t);
      tabs.close(t.id);
      env.refreshSnapshot();
      return { summary: `closed tab "${label}"`, speak: 'Tab closed.' };
    }
    case 'browser.tab.switch': {
      const t = resolveTab(env, slots);
      tabs.activate(t.id);
      env.refreshSnapshot();
      return { summary: `switched to "${tabLabel(t)}"`, speak: `Switched to ${tabLabel(t)}.` };
    }
    case 'browser.tab.pin':
    case 'browser.tab.unpin': {
      const t = resolveTab(env, slots);
      const pinned = intent === 'browser.tab.pin';
      t.pinned = pinned;
      tabs.persistPinned();
      env.refreshSnapshot();
      return { summary: `${pinned ? 'pinned' : 'unpinned'} "${tabLabel(t)}"` };
    }
    case 'browser.tab.mute':
    case 'browser.tab.unmute': {
      const wc = tabs.activeWebContents();
      if (!wc) throw new Error('There is no active tab.');
      wc.setAudioMuted(intent === 'browser.tab.mute');
      return { summary: `${intent === 'browser.tab.mute' ? 'muted' : 'unmuted'} the tab` };
    }
    case 'browser.tab.reload': {
      tabs.reload();
      return { summary: 'reloaded the tab' };
    }
    case 'browser.tab.duplicate': {
      const t = resolveTab(env, slots);
      const copy = tabs.create(t.spaceId, t.url);
      tabs.activate(copy.id);
      env.refreshSnapshot();
      return { summary: `duplicated "${tabLabel(t)}"` };
    }
    case 'browser.tab.move': {
      const t = resolveTab(env, slots);
      const name = str(slots, 'space').toLowerCase();
      const space = store.d.spaces.find((s) => s.name.toLowerCase() === name)
        ?? store.d.spaces.find((s) => s.name.toLowerCase().includes(name));
      if (!space) throw new Error(`I couldn't find a Space named "${str(slots, 'space')}".`);
      t.spaceId = space.id;
      env.refreshSnapshot();
      return { summary: `moved "${tabLabel(t)}" to ${space.name}`, speak: `Moved to ${space.name}.` };
    }
    case 'browser.tab.archive': {
      const t = resolveTab(env, slots);
      tabs.archive(t.id, true);
      env.refreshSnapshot();
      return { summary: `archived "${tabLabel(t)}"`, speak: 'Tab archived. You can restore it later.' };
    }
    case 'browser.tab.list': {
      const list = spaceTabs(env);
      const names = list.map((t, i) => `${i + 1}. ${tabLabel(t)}`).join('; ');
      const summary = list.length === 0 ? 'no tabs open' : names;
      return {
        summary: `tabs: ${summary}`,
        speak: list.length === 0 ? 'No tabs are open.' : `You have ${list.length} tabs: ${names}.`
      };
    }

    // -- Navigation ---------------------------------------------------------
    case 'browser.nav.go': {
      const dest = str(slots, 'destination');
      if (!dest) throw new Error('Where should I go?');
      tabs.go(withScheme(dest));
      return { summary: `navigated to ${dest}` };
    }
    case 'browser.nav.search': {
      const q = str(slots, 'query');
      if (!q) throw new Error('What should I search for?');
      tabs.go(`${store.d.searchEngine}${encodeURIComponent(q)}`);
      return { summary: `searched for "${q}"` };
    }
    case 'browser.nav.back': tabs.back(); return { summary: 'went back' };
    case 'browser.nav.forward': tabs.forward(); return { summary: 'went forward' };
    case 'browser.nav.reload': tabs.reload(); return { summary: 'reloaded the page' };
    case 'browser.nav.stop': tabs.stop(); return { summary: 'stopped loading' };

    // -- Spaces ---------------------------------------------------------------
    case 'browser.space.switch': {
      const name = str(slots, 'name').toLowerCase();
      const space = store.d.spaces.find((s) => s.name.toLowerCase() === name)
        ?? store.d.spaces.find((s) => s.name.toLowerCase().includes(name));
      if (!space) throw new Error(`I couldn't find a Space named "${str(slots, 'name')}".`);
      store.d.activeSpaceId = space.id;
      env.saveSoon();
      if (![...tabs.tabs.values()].some((t) => t.spaceId === space.id)) {
        tabs.create(space.id);
      }
      const first = [...tabs.tabs.values()].find((t) => t.spaceId === space.id);
      if (first) tabs.activate(first.id);
      env.refreshSnapshot();
      return { summary: `switched to Space "${space.name}"`, speak: `Switched to ${space.name}.` };
    }
    case 'browser.space.create': {
      const name = str(slots, 'name') || 'New Space';
      const s = store.addSpace(name);
      store.d.activeSpaceId = s.id;
      env.saveSoon();
      const t = tabs.create(s.id);
      tabs.activate(t.id);
      env.refreshSnapshot();
      return { summary: `created Space "${name}"`, speak: `Created the ${name} space.` };
    }
    case 'browser.space.list': {
      const names = store.d.spaces.map((s) => s.name).join(', ');
      return { summary: `spaces: ${names}`, speak: `Your spaces are: ${names}.` };
    }

    // -- Interface --------------------------------------------------------------
    case 'ui.sidebar.toggle': {
      const next = !store.d.sidebarCollapsed;
      env.setSidebarCollapsed(next);
      return { summary: next ? 'collapsed the sidebar' : 'expanded the sidebar' };
    }
    case 'ui.agent.open': env.setAgentPanelOpen(true); return { summary: 'opened the assistant panel' };
    case 'ui.agent.close': env.setAgentPanelOpen(false); return { summary: 'closed the assistant panel' };
    case 'ui.settings.open': env.setSettingsOpen(true); return { summary: 'opened Settings' };
    case 'ui.commandbar.open': env.openCommandBar(); return { summary: 'opened the command bar' };

    // -- Page actions -------------------------------------------------------------
    case 'page.scroll.up':
      await runInPage(env, `window.scrollBy({ top: -Math.max(400, window.innerHeight * 0.8), behavior: 'smooth' })`);
      return { summary: 'scrolled up' };
    case 'page.scroll.down':
      await runInPage(env, `window.scrollBy({ top: Math.max(400, window.innerHeight * 0.8), behavior: 'smooth' })`);
      return { summary: 'scrolled down' };
    case 'page.scroll.top':
      await runInPage(env, `window.scrollTo({ top: 0, behavior: 'smooth' })`);
      return { summary: 'scrolled to the top' };
    case 'page.scroll.bottom':
      await runInPage(env, `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`);
      return { summary: 'scrolled to the bottom' };
    case 'page.click': {
      const target = str(slots, 'target') || str(slots, 'elementLabel');
      if (!target) throw new Error('What should I click?');
      const clicked = await runInPage(
        env,
        `(() => {
          const needle = ${jsStr(target.toLowerCase())};
          const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')];
          const el = els.find(e => {
            const label = ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').toLowerCase();
            return label && (label.includes(needle) || needle.split(/\\s+/).every(w => label.includes(w)));
          });
          if (el) { el.click(); return (el.innerText || el.value || '').trim().slice(0, 60); }
          return null;
        })()`
      );
      if (!clicked) throw new Error(`I couldn't find anything matching "${target}" on this page.`);
      return { summary: `clicked "${clicked}"`, speak: `Clicked ${clicked}.` };
    }

    // -- Dictation ------------------------------------------------------------------
    case 'agent.dictate': {
      const text = str(slots, 'text');
      if (!text) throw new Error('What should I type?');
      const ok = await runInPage(
        env,
        `(() => {
          const el = document.activeElement;
          if (!el) return false;
          const tag = (el.tagName || '').toLowerCase();
          const insert = ${jsStr(text)};
          if (tag === 'input' || tag === 'textarea') {
            const start = el.selectionStart ?? el.value.length;
            el.value = el.value.slice(0, start) + insert + el.value.slice(el.selectionEnd ?? start);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          if (el.isContentEditable) {
            document.execCommand('insertText', false, insert);
            return true;
          }
          return false;
        })()`
      );
      if (!ok) throw new Error('I could not find a text field to type into — click one first.');
      return { summary: `dictated ${text.length} characters`, speak: 'Typed.' };
    }

    // -- Voice itself -----------------------------------------------------------------
    case 'voice.listen.start': env.requestListen(true); return { summary: 'started listening' };
    case 'voice.listen.stop': env.requestListen(false); return { summary: 'stopped listening' };

    // -- Terminal --------------------------------------------------------------------
    // GATED: never run directly — use runTerminalControl, which shows the
    // native confirmation dialog (exact command + working directory).
    case 'terminal.run':
      throw new Error('terminal.run must go through runTerminalControl (confirmation dialog).');

    default:
      throw new Error(`Voice control can't do "${intent}" yet.`);
  }
}
