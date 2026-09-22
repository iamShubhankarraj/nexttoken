/**
 * reader.ts — Reader mode: article detection + a clean in-tab reading view.
 *
 * How it works:
 * - On page-load completion (observed via tab deltas — `noteReaderTabDelta`
 *   is called from the TabManager delta callback in index.ts), main runs
 *   @mozilla/readability's `isProbablyReaderable` inside the guest with
 *   `executeJavaScript`. Only http(s)/file pages are probed; the probe
 *   script is injected per page and is a no-op when already present.
 * - When the page looks like an article, the renderer learns through the
 *   normal tab-delta channel ('reader-available' / 'reader-active') and
 *   shows the Reader button in the omnibox. Snapshot patching
 *   (`readerFlagsFor`, applied in index.ts's snapshot()) keeps the flags
 *   across full-snapshot refreshes.
 * - Entering reader extracts the article with Readability in the guest and
 *   renders it into a fixed full-viewport overlay styled in the app's
 *   warm-charcoal + ember (#E8A33D) palette. The page underneath is left
 *   intact, so exiting restores it exactly. Embedded `@media print` CSS
 *   keeps the system print dialog / Save-as-PDF scoped to the article.
 * - Per-site auto-reader persists in `store.d.privacy.autoReader` — the
 *   same per-origin pattern as mute/autoplay in privacy.ts. When a page on
 *   an opted-in origin proves readable, reader mode opens on its own.
 *
 * Third-party: @mozilla/readability (Apache-2.0; see THIRD-PARTY-NOTICES.md),
 * loaded at runtime from node_modules (main-process deps are externalized,
 * never bundled — see electron.vite.config.ts) and executed in the guest's
 * main world. If the library is missing, detection quietly stays off and
 * manual entry reports 'reader-unavailable'.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { WebContents } from 'electron';
import { guardedHandle } from './ipcGuard';
import type { Store } from './store';
import type { TabManager } from './tabs';
import type { PrivacySnapshot, TabDelta } from '../shared/ipc';
import { snapshot as snapshotPrivacy } from './privacy';

const require = createRequire(import.meta.url);

function vendorText(spec: string): string {
  try {
    return fs.readFileSync(require.resolve(spec), 'utf8');
  } catch {
    return '';
  }
}

const READABLE_JS = vendorText(
  '@mozilla/readability/Readability-readerable.js'
);
const READABILITY_JS = vendorText('@mozilla/readability/Readability.js');

function readerLibsAvailable(): boolean {
  return READABLE_JS.length > 1000 && READABILITY_JS.length > 1000;
}

/**
 * Guest-side driver (injected once per page, on demand). Defines
 * `window.__ntReader` with `enter()` / `exit()`. Written in ES5 with no
 * template literals so it can live inside the TS template literal below.
 */
const DRIVER_JS = `(function () {
  if (window.__ntReader) return;
  var OVERLAY_ID = '__nt_reader_overlay';
  var STYLE_ID = '__nt_reader_style';
  var ATTR = 'data-nt-reader-on';
  var savedOverflow = '';
  var CSS = [
    '#__nt_reader_overlay{position:fixed;inset:0;z-index:2147483647;overflow-y:auto;overflow-x:hidden;background:#211c17;color:#ece6da;font-family:Georgia,\\'Times New Roman\\',Times,serif;-webkit-font-smoothing:antialiased;}',
    '.nt-rd-wrap{max-width:44rem;margin:0 auto;padding:3.5rem 1.75rem 5rem;}',
    '.nt-rd-kicker{font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',Inter,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#E8A33D;margin:0 0 1rem;}',
    '.nt-rd-title{font-size:2rem;line-height:1.25;letter-spacing:-0.01em;margin:0 0 .9rem;color:#f5f1e8;font-weight:700;}',
    '.nt-rd-meta{font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',Inter,sans-serif;font-size:13px;color:#a89e8d;margin:0 0 2.2rem;}',
    '.nt-rd-body{font-size:1.13rem;line-height:1.78;color:#e4ddd0;}',
    '.nt-rd-body p{margin:0 0 1.4em;}',
    '.nt-rd-body h2,.nt-rd-body h3,.nt-rd-body h4{font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',Inter,sans-serif;color:#f5f1e8;line-height:1.35;margin:1.8em 0 .7em;}',
    '.nt-rd-body a{color:#E8A33D;text-decoration:underline;text-underline-offset:3px;}',
    '.nt-rd-body img{max-width:100%;height:auto;border-radius:10px;margin:1.2em 0;}',
    '.nt-rd-body figure{margin:1.4em 0;}',
    '.nt-rd-body figcaption{font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',Inter,sans-serif;font-size:13px;color:#a89e8d;margin-top:.5em;}',
    '.nt-rd-body blockquote{border-left:3px solid #E8A33D;margin:1.4em 0;padding:.2em 0 .2em 1.1em;color:#cfc6b4;}',
    '.nt-rd-body pre{background:#171310;border:1px solid #3a332b;border-radius:10px;padding:1em;overflow-x:auto;font-size:.85em;}',
    '.nt-rd-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;}',
    '.nt-rd-body ul,.nt-rd-body ol{margin:0 0 1.4em;padding-left:1.6em;}',
    '.nt-rd-body li{margin-bottom:.5em;}',
    '.nt-rd-body iframe{max-width:100%;border:0;border-radius:10px;margin:1.2em 0;}',
    '@media print{body>*:not(#__nt_reader_overlay){display:none!important;}#__nt_reader_overlay{position:static!important;overflow:visible!important;background:#fff!important;color:#111!important;}.nt-rd-wrap{max-width:none!important;padding:0!important;}.nt-rd-title{color:#000!important;}.nt-rd-kicker{color:#8a6d1f!important;}.nt-rd-meta{color:#555!important;}.nt-rd-body{color:#111!important;}.nt-rd-body a{color:#111!important;}}'
  ].join('');
  function readingMinutes(chars) {
    var words = Math.max(1, Math.round(chars / 5));
    return Math.max(1, Math.round(words / 200));
  }
  function sanitize(root) {
    var kill = root.querySelectorAll('script,object,embed,form');
    for (var i = kill.length - 1; i >= 0; i--) {
      var n = kill[i];
      if (n.parentNode) n.parentNode.removeChild(n);
    }
    var els = root.querySelectorAll('*');
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      var attrs = el.attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        if (attrs[k].name.slice(0, 2).toLowerCase() === 'on') el.removeAttribute(attrs[k].name);
      }
      if (el.hasAttribute('href')) {
        var href = (el.getAttribute('href') || '').replace(/^\\s+/, '').toLowerCase();
        if (href.indexOf('javascript:') === 0 || href.indexOf('data:text/html') === 0) el.removeAttribute('href');
      }
    }
    return root;
  }
  function buildOverlay(article) {
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'article');
    var wrap = document.createElement('div');
    wrap.className = 'nt-rd-wrap';
    var kicker = document.createElement('div');
    kicker.className = 'nt-rd-kicker';
    kicker.textContent = article.siteName || '';
    var h1 = document.createElement('h1');
    h1.className = 'nt-rd-title';
    h1.textContent = article.title || document.title || '';
    var meta = document.createElement('div');
    meta.className = 'nt-rd-meta';
    var parts = [];
    if (article.byline) parts.push(article.byline);
    parts.push(readingMinutes(article.length || 0) + ' min read');
    meta.textContent = parts.join('  \\u00B7  ');
    var body = document.createElement('div');
    body.className = 'nt-rd-body';
    var tmp = document.createElement('div');
    tmp.innerHTML = article.content || '';
    sanitize(tmp);
    while (tmp.firstChild) body.appendChild(tmp.firstChild);
    wrap.appendChild(kicker);
    wrap.appendChild(h1);
    wrap.appendChild(meta);
    wrap.appendChild(body);
    overlay.appendChild(wrap);
    return overlay;
  }
  function enter() {
    try {
      exit();
      if (typeof window.Readability !== 'function') return { ok: false, error: 'reader-unavailable' };
      var article = null;
      try {
        article = new window.Readability(document.cloneNode(true)).parse();
      } catch (e) {
        return { ok: false, error: 'parse-failed' };
      }
      if (!article || !article.content) return { ok: false, error: 'no-article' };
      var head = document.head || document.documentElement;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      head.appendChild(style);
      (document.body || document.documentElement).appendChild(buildOverlay(article));
      if (document.body) {
        savedOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      document.documentElement.setAttribute(ATTR, '1');
      var ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.scrollTop = 0;
      return { ok: true, title: article.title || '' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function exit() {
    try {
      var ov = document.getElementById(OVERLAY_ID);
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      var st = document.getElementById(STYLE_ID);
      if (st && st.parentNode) st.parentNode.removeChild(st);
      if (document.body) document.body.style.overflow = savedOverflow || '';
      document.documentElement.removeAttribute(ATTR);
    } catch (e) {}
    return true;
  }
  window.__ntReader = { enter: enter, exit: exit };
})();`;

/** Fast probe: use the readable check when already injected, else ask for it. */
const PROBE_SRC = `(function(){try{if(typeof isProbablyReaderable==='function'){return isProbablyReaderable(document)?'yes':'no';}return 'need';}catch(e){return 'no';}})();`;

export interface ReaderDeps {
  store: Store;
  tabs: TabManager;
  /** Forward a tab delta to the renderer over the 'nt.tab-delta' channel. */
  sendDelta: (d: TabDelta) => void;
}

interface ReaderTabState {
  available: boolean;
  active: boolean;
}

let deps: ReaderDeps | null = null;
const state = new Map<string, ReaderTabState>();
const detectTimers = new Map<string, NodeJS.Timeout>();

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Push reader deltas, but only for flags that actually changed. */
function pushState(tabId: string, available: boolean, active: boolean): void {
  const d = deps;
  if (!d) return;
  const prev = state.get(tabId);
  if (prev && prev.available === available && prev.active === active) return;
  state.set(tabId, { available, active });
  try {
    if (!prev || prev.available !== available) {
      d.sendDelta({ tabId, type: 'reader-available', value: available });
    }
    if (!prev || prev.active !== active) {
      d.sendDelta({ tabId, type: 'reader-active', value: active });
    }
  } catch {
    /* renderer gone */
  }
}

/**
 * Called from the TabManager delta callback (index.ts) for every tab delta.
 * - 'url': navigation replaces the guest DOM, so any overlay is gone —
 *   reset the flags (detection re-runs on load completion).
 * - 'loading' = false: the page settled — probe it for article content.
 */
export function noteReaderTabDelta(d: TabDelta): void {
  if (!deps) return;
  if (d.type === 'url') {
    const prev = state.get(d.tabId);
    if (prev && (prev.available || prev.active)) pushState(d.tabId, false, false);
    else state.delete(d.tabId);
    return;
  }
  if (d.type === 'loading' && d.value === false) scheduleDetect(d.tabId);
}

/** Snapshot patch for index.ts: reader flags + lazy pruning of closed tabs. */
export function readerFlagsFor(tabId: string): {
  readerAvailable: boolean;
  readerActive: boolean;
} {
  if (deps && !deps.tabs.tabs.has(tabId)) state.delete(tabId);
  const s = state.get(tabId);
  return { readerAvailable: !!s?.available, readerActive: !!s?.active };
}

function scheduleDetect(tabId: string): void {
  if (!readerLibsAvailable() || detectTimers.has(tabId)) return;
  detectTimers.set(
    tabId,
    setTimeout(() => {
      detectTimers.delete(tabId);
      void detect(tabId);
    }, 600)
  );
}

async function detect(tabId: string): Promise<void> {
  const d = deps;
  if (!d) return;
  const wc = d.tabs.webContentsFor(tabId);
  if (!wc) return;
  let url = '';
  try {
    url = wc.getURL();
  } catch {
    return;
  }
  // Only real web/file pages — never probes, devtools, or the new-tab page.
  if (!/^(https?|file):/i.test(url)) {
    pushState(tabId, false, false);
    return;
  }
  const origin = originOfUrl(url);
  try {
    let probe: unknown = await wc.executeJavaScript(PROBE_SRC);
    if (probe === 'need') {
      await wc.executeJavaScript(READABLE_JS);
      probe = await wc.executeJavaScript(PROBE_SRC);
    }
    const readable = probe === 'yes';
    const wasActive = !!state.get(tabId)?.active;
    pushState(tabId, readable, readable && wasActive);
    // Per-site auto-reader: open the article view on its own.
    if (readable && !wasActive && origin && d.store.d.privacy.autoReader[origin]) {
      await enterReader(tabId);
    }
  } catch {
    /* guest went away mid-probe */
  }
}

function targetTab(tabId?: string): { id: string; wc: WebContents } | null {
  const d = deps;
  if (!d) return null;
  const id = tabId || d.tabs.activeTabId || '';
  if (!id) return null;
  const wc = d.tabs.webContentsFor(id);
  if (!wc) return null;
  return { id, wc };
}

async function ensureDriver(wc: WebContents): Promise<boolean> {
  try {
    const has: unknown = await wc.executeJavaScript(
      '(typeof window.__ntReader!=="undefined")'
    );
    if (has === true) return true;
    if (!readerLibsAvailable()) return false;
    await wc.executeJavaScript(READABILITY_JS + '\n' + DRIVER_JS);
    const has2: unknown = await wc.executeJavaScript(
      '(typeof window.__ntReader!=="undefined")'
    );
    return has2 === true;
  } catch {
    return false;
  }
}

interface EnterResult {
  ok: boolean;
  title?: string;
  error?: string;
}

async function enterReader(tabId?: string): Promise<EnterResult> {
  const t = targetTab(tabId);
  if (!t) return { ok: false, error: 'no-tab' };
  try {
    if (!(await ensureDriver(t.wc))) {
      return { ok: false, error: 'reader-unavailable' };
    }
    const res = (await t.wc.executeJavaScript(
      `(function(){try{return window.__ntReader.enter();}catch(e){return {ok:false,error:String((e&&e.message)||e)};}})();`
    )) as EnterResult;
    if (res && res.ok) pushState(t.id, true, true);
    return res && typeof res.ok === 'boolean'
      ? res
      : { ok: false, error: 'no-result' };
  } catch {
    return { ok: false, error: 'guest-gone' };
  }
}

async function exitReader(tabId?: string): Promise<void> {
  const t = targetTab(tabId);
  if (!t) return;
  try {
    await t.wc.executeJavaScript(
      `(function(){try{return window.__ntReader.exit();}catch(e){return false;}})();`
    );
  } catch {
    /* guest gone — nothing to remove */
  }
  const prev = state.get(t.id);
  pushState(t.id, !!prev?.available, false);
}

/** Per-site auto-reader toggle — same per-origin pattern as mute/autoplay. */
function setAutoReader(origin: string, enabled: boolean): PrivacySnapshot {
  const d = deps;
  if (!d) throw new Error('reader not initialized');
  const p = d.store.d.privacy;
  if (enabled) p.autoReader[origin] = true;
  else delete p.autoReader[origin];
  d.store.saveSoon();
  return snapshotPrivacy(d.store);
}

export function registerReaderIpc(d: ReaderDeps): void {
  deps = d;
  guardedHandle('nt.reader.enter', async (_e, tabId?: string) =>
    enterReader(tabId)
  );
  guardedHandle('nt.reader.exit', async (_e, tabId?: string) => {
    await exitReader(tabId);
  });
  guardedHandle('nt.reader.status', async (_e, tabId?: string) => {
    const t = targetTab(tabId);
    const s = t ? state.get(t.id) : undefined;
    return { available: !!s?.available, active: !!s?.active };
  });
  guardedHandle('nt.reader.set-auto', (_e, origin: string, enabled: boolean) =>
    setAutoReader(String(origin), !!enabled)
  );
  guardedHandle('nt.reader.auto-state', (_e, origin: string) => {
    const d2 = deps;
    return !!d2?.store.d.privacy.autoReader[String(origin)];
  });
}
