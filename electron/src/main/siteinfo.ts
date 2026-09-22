/**
 * siteinfo.ts — per-site connection info for the address-bar site panel.
 *
 * Certificate health is *observed*, not re-verified: Chromium already walks
 * the certificate chain on every navigation, so a page that loaded over
 * HTTPS without a certificate-error event has a valid certificate. This
 * module only records failures (observe-only — never preventDefault, so
 * navigation behavior is unchanged) and surfaces one when the failing
 * origin still matches the tab's current origin.
 */

import { app } from 'electron';
import { guardedHandle } from './ipcGuard';
import type { TabManager } from './tabs';
import type { SiteConnectionInfo } from '../shared/ipc';

interface CertFailure {
  origin: string;
  error: string;
  at: number;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function registerSiteInfoIpc(tabs: TabManager): void {
  const failures = new Map<string, CertFailure>();

  app.on('certificate-error', (event, wc, url, error) => {
    // Observe only: the default handling (cancel the navigation) is untouched.
    void event;
    let tabId: string | null = null;
    tabs.forEachWebContents((tab, w) => {
      if (w.id === wc.id) tabId = tab.id;
    });
    if (!tabId) return;
    failures.set(tabId, { origin: originOf(url), error: String(error ?? ''), at: Date.now() });
  });

  guardedHandle('nt.siteinfo.get', (): SiteConnectionInfo | null => {
    const id = tabs.activeTabId;
    const tab = id ? tabs.tabs.get(id) : undefined;
    if (!tab) return null;
    const url = tab.url ?? '';
    let protocol = '';
    let host = '';
    try {
      const u = new URL(url);
      protocol = u.protocol.replace(/:$/, '');
      host = u.hostname.toLowerCase();
    } catch {
      /* non-standard URL */
    }
    const origin = originOf(url);
    const internal =
      url === '' || /^(about|data|file|chrome|nt)$/i.test(protocol);
    const rec = id ? failures.get(id) : undefined;
    const certError =
      rec && rec.origin && rec.origin === origin ? rec.error : null;
    return {
      url,
      protocol,
      host,
      origin,
      security: internal ? 'internal' : protocol === 'https' ? 'secure' : 'not-secure',
      certError,
    };
  });
}
