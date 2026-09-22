/**
 * tabActions.ts — shell & tabs extras for v0.6.3, kept out of index.ts so
 * the main entry stays a thin wiring layer.
 *
 * Registers the IPC surface for: per-tab mute, duplicate, targeted
 * reload, close-others / close-tabs-to-the-right, and ⌘⇧T reopen-closed.
 * Reopen restores via the same create+activate path the archive restore
 * uses (not the archive itself).
 */

import type { guardedHandle } from './ipcGuard';
import type { TabManager } from './tabs';
import type { ClosedTabStack } from './closedTabs';

export interface TabActionDeps {
  tabs: TabManager;
  closedStack: ClosedTabStack;
  /** Same restore path as archive restore: create + activate in the Bit. */
  createTabActivated: (
    spaceId: string,
    url: string | undefined,
    activate?: boolean,
  ) => string;
}

export function registerTabActions(
  handle: typeof guardedHandle,
  deps: TabActionDeps,
): void {
  const { tabs, closedStack, createTabActivated } = deps;

  // Per-tab mute toggle (sidebar speaker icon / tab context menu).
  handle('nt.tabs.mute', (_e, tabId: string, muted: boolean) => {
    tabs.setMuted(String(tabId), muted === true);
  });

  // Duplicate a tab right after the original, in the same Bit.
  handle('nt.tabs.duplicate', (_e, tabId: string) => {
    tabs.duplicate(String(tabId));
  });

  // Reload a specific tab (navReload only targets the active one).
  handle('nt.tabs.reload-tab', (_e, tabId: string) => {
    tabs.reloadTab(String(tabId));
  });

  // Close every other unpinned tab in the tab's Bit.
  handle('nt.tabs.close-others', (_e, tabId: string) => {
    tabs.closeOthers(String(tabId));
  });

  // Close unpinned tabs to the right in sidebar order.
  handle('nt.tabs.close-right', (_e, tabId: string) => {
    tabs.closeRight(String(tabId));
  });

  // ⌘⇧T: reopen the most recently user-closed tab. The create call
  // validates the Bit and falls back to the active Bit when the original
  // was deleted; nothing happens when the stack is empty.
  handle('nt.tabs.reopen-closed', () => {
    const entry = closedStack.reopen();
    if (!entry) return;
    const id = createTabActivated(entry.spaceId, entry.url, true);
    const tab = tabs.tabs.get(id);
    if (tab && entry.title) tab.title = entry.title;
  });
}
