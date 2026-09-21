/**
 * "Browser in use by voice" — translates agent browser actions into the
 * event stream the renderer's AgentActingOverlay consumes:
 *
 *   nt:agent-acting      { tabId, action, label, targetRect? }  (before)
 *   nt:agent-acting-done { tabId, action, label, summary?, screenshot? } (after)
 *
 * For page.click / agent.dictate the wrapper first locates the target
 * element's rect in-page, emits the acting event, then waits ~550 ms so
 * the ember target ring can pulse *before* the action lands (Comet's
 * "watch it click" pattern). The done event carries a thumbnail screenshot
 * for click actions (Comet's step-screenshot analog) and records dictation
 * insertions so the renderer can offer ⌘Z-style undo.
 */

import type { ControlEnv, ControlResult } from "../brain/control";

export type AgentActionKind =
  | "click"
  | "type"
  | "navigate"
  | "scroll"
  | "tab"
  | "other";

export interface AgentActingPayload {
  tabId: string | null;
  action: AgentActionKind;
  /** Present-tense label for the viewport capsule, e.g. `Clicking "Subscribe"…` */
  label: string;
  targetRect?: { x: number; y: number; w: number; h: number };
}

export interface AgentActingDonePayload extends AgentActingPayload {
  summary?: string;
  /** dataURL thumbnail (click actions only), for the panel Steps list. */
  screenshot?: string;
}

export type EmitActing = (channel: "nt:agent-acting" | "nt:agent-acting-done", payload: AgentActingPayload | AgentActingDonePayload) => void;

export interface LastDictation {
  tabId: string;
  chars: number;
  at: number;
}

const PRE_ACTION_PAUSE_MS = 550;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function jsStr(s: string): string {
  return JSON.stringify(s);
}

async function runInPage(env: ControlEnv, js: string): Promise<unknown> {
  const wc = env.tabs.activeWebContents();
  if (!wc) return null;
  return wc.executeJavaScript(js).catch(() => null);
}

/** Locate the click target's label + viewport rect without clicking it. */
async function locateClickTarget(
  env: ControlEnv,
  target: string,
): Promise<{ label: string; rect: { x: number; y: number; w: number; h: number } } | null> {
  const r = await runInPage(
    env,
    `(() => {
      const needle = ${jsStr(target.toLowerCase())};
      const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')];
      const el = els.find(e => {
        const label = ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').toLowerCase();
        return label && (label.includes(needle) || needle.split(/\\s+/).every(w => label.includes(w)));
      });
      if (!el) return null;
      const b = el.getBoundingClientRect();
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r2 = el.getBoundingClientRect();
      return { label: (el.innerText || el.value || '').trim().slice(0, 60), rect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height } };
    })()`,
  );
  if (!r || typeof r !== "object") return null;
  const { label, rect } = r as { label?: string; rect?: { x: number; y: number; w: number; h: number } };
  if (!rect || typeof rect.x !== "number") return null;
  return { label: label || target, rect };
}

/** Rect of the currently focused editable element (for dictation). */
async function locateActiveField(env: ControlEnv): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const r = await runInPage(
    env,
    `(() => {
      const el = document.activeElement;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    })()`,
  );
  if (!r || typeof r !== "object") return null;
  const rect = r as { x: number; y: number; w: number; h: number };
  return typeof rect.x === "number" ? rect : null;
}

function actionKind(intent: string): AgentActionKind {
  if (intent === "page.click") return "click";
  if (intent === "agent.dictate") return "type";
  if (intent.startsWith("browser.nav")) return "navigate";
  if (intent.startsWith("page.scroll")) return "scroll";
  if (intent.startsWith("browser.tab")) return "tab";
  return "other";
}

function actionLabel(intent: string, slots: Record<string, unknown>): string {
  const s = (k: string) => (typeof slots[k] === "string" ? (slots[k] as string) : "");
  switch (intent) {
    case "page.click": return `Clicking “${s("target") || s("elementLabel") || "…"}”…`;
    case "agent.dictate": return "Typing…";
    case "terminal.run": return `Running “${s("command").slice(0, 60) || "command"}”…`;
    case "browser.nav.go": return `Opening ${s("destination") || "page"}…`;
    case "browser.nav.search": return `Searching for “${s("query")}”…`;
    case "browser.nav.back": return "Going back…";
    case "browser.nav.forward": return "Going forward…";
    case "browser.nav.reload": return "Reloading…";
    case "page.scroll.up": return "Scrolling up…";
    case "page.scroll.down": return "Scrolling down…";
    case "page.scroll.top": return "Scrolling to top…";
    case "page.scroll.bottom": return "Scrolling to bottom…";
    case "browser.tab.new": return "Opening a new tab…";
    case "browser.tab.close": return "Closing the tab…";
    case "browser.tab.switch": return "Switching tabs…";
    case "browser.space.switch": return `Switching to “${s("name")}”…`;
    default: return "Working…";
  }
}

/**
 * Wrap an executeControl-style function with acting events. Returns the
 * control result, and records dictation insertions for undo.
 */
export function wrapWithActing(
  env: ControlEnv,
  execute: (intent: string, slots: Record<string, unknown>) => Promise<ControlResult>,
  emit: EmitActing,
  onDictation: (d: LastDictation) => void,
): (intent: string, slots: Record<string, unknown>) => Promise<ControlResult> {
  return async (intent, slots) => {
    const tabId = env.tabs.activeTabId ?? null;
    const kind = actionKind(intent);
    const label = actionLabel(intent, slots);

    // Locate the target first so the ring pulses before the action.
    let targetRect: { x: number; y: number; w: number; h: number } | undefined;
    if (intent === "page.click") {
      const target = (typeof slots.target === "string" && slots.target) ||
        (typeof slots.elementLabel === "string" && slots.elementLabel) || "";
      if (target) {
        const found = await locateClickTarget(env, target).catch(() => null);
        if (found) targetRect = found.rect;
      }
    } else if (intent === "agent.dictate") {
      targetRect = (await locateActiveField(env).catch(() => null)) ?? undefined;
    }

    const base: AgentActingPayload = { tabId, action: kind, label, targetRect };
    emit("nt:agent-acting", base);
    if (targetRect) await sleep(PRE_ACTION_PAUSE_MS);

    try {
      const result = await execute(intent, slots);
      let screenshot: string | undefined;
      if (intent === "page.click") {
        screenshot = await captureThumbnail(env).catch(() => undefined);
      }
      if (intent === "agent.dictate" && typeof slots.text === "string" && tabId) {
        onDictation({ tabId, chars: slots.text.length, at: Date.now() });
      }
      emit("nt:agent-acting-done", { ...base, summary: result.summary, screenshot });
      return result;
    } catch (e) {
      emit("nt:agent-acting-done", { ...base, summary: undefined });
      throw e;
    }
  };
}

/** Small dataURL thumbnail of the active page (best-effort). */
async function captureThumbnail(env: ControlEnv): Promise<string | undefined> {
  const wc = env.tabs.activeWebContents();
  if (!wc) return undefined;
  const img = await wc.capturePage().catch(() => null);
  if (!img || img.isEmpty()) return undefined;
  const size = img.getSize();
  const maxW = 320;
  const scale = size.width > maxW ? maxW / size.width : 1;
  const small = scale < 1
    ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
    : img;
  return small.toDataURL();
}

/** Build the in-page JS that removes the last `chars` of a dictation insertion. */
export function dictateUndoJs(chars: number): string {
  return `(() => {
    const el = document.activeElement;
    const n = ${Math.max(1, Math.floor(chars))};
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const end = el.selectionEnd ?? el.value.length;
      const start = Math.max(0, end - n);
      el.value = el.value.slice(0, start) + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      // execCommand insertions sit on the native undo stack.
      return document.execCommand('undo');
    }
    return false;
  })()`;
}
