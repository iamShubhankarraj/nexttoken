/**
 * httpsUpgrade.ts — Brave-style HTTPS-Strict upgrade (v0.6.3, impl-5).
 *
 * Off by default (Settings → Privacy → Connection security). When enabled,
 * plain-http:// main-frame navigations are retried over https://. The
 * upgrade deliberately does NOT hook webRequest.onBeforeRequest — the
 * native ad blocker owns that single listener per session, and a second
 * registration would replace it. Instead the upgrade happens at the
 * navigation layer (index.ts's TabDelta 'url' wire): the http load is
 * stopped and re-issued as https. If the https load fails, we fall back to
 * the original http URL once — an https upgrade must never strand a page.
 */
import type { WebContents } from 'electron';
import type { Store } from './store';

/** tabId -> the https URL we attempted (loop + fallback bookkeeping). */
const pending = new Map<string, { httpUrl: string; httpsUrl: string }>();

function isUpgradeable(raw: string): boolean {
  if (!raw.startsWith('http://')) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.onion')) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    if (host === '[::1]' || host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}

/** Maybe upgrade an http:// navigation. Called on every TabDelta 'url'. */
export function maybeUpgrade(
  store: Store,
  tab: { wc?: WebContents | null } | undefined,
  tabId: string,
  url: string
): void {
  if (store.d.privacy.httpsUpgrade !== true) {
    pending.delete(tabId);
    return;
  }
  if (!isUpgradeable(url)) {
    // An https:// arrival clears a pending attempt for this tab.
    pending.delete(tabId);
    return;
  }
  const wc = tab?.wc;
  if (!wc || wc.isDestroyed()) return;
  const existing = pending.get(tabId);
  if (existing && existing.httpUrl === url) return; // already upgrading this nav
  const httpsUrl = 'https://' + url.slice('http://'.length);
  pending.set(tabId, { httpUrl: url, httpsUrl });
  const onFail = (
    _e: unknown,
    _code: number,
    _desc: string,
    validatedURL: string,
    isMainFrame: boolean
  ): void => {
    const p = pending.get(tabId);
    if (!p || p.httpsUrl !== validatedURL || !isMainFrame) return;
    pending.delete(tabId);
    // The site doesn't serve https — fall back to the original http URL.
    try {
      if (!wc.isDestroyed()) wc.loadURL(p.httpUrl);
    } catch {
      /* noop */
    }
  };
  wc.once('did-fail-load', onFail as (...args: unknown[]) => void);
  try {
    wc.stop();
    wc.loadURL(httpsUrl);
  } catch {
    pending.delete(tabId);
  }
}

/** Forget pending state (tab closed). Best-effort; the map self-heals. */
export function forgetTab(tabId: string): void {
  pending.delete(tabId);
}
