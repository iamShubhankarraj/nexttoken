/**
 * closedTabs.ts — bounded stack of user-closed tabs for ⌘⇧T reopen.
 *
 * Only explicit closes push here (the 'nt.tabs.close' IPC handler calls
 * noteClosed BEFORE tabs.close destroys the record). Archive sweeps,
 * Bit deletes, and tidy closures do NOT push — those are restorable via
 * the Archive. Blank new-tab pages are skipped; nothing persists to disk.
 */

import { randomUUID } from 'node:crypto';
import type { TabRec } from './tabs';

/** One recently-closed tab, restorable via ⌘⇧T. */
export interface ClosedTabEntry {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  closedAt: number;
}

/** Cap: a browser keeps a short memory, not an infinite one. */
const MAX_CLOSED_TABS = 25;

export class ClosedTabStack {
  private entries: ClosedTabEntry[] = [];

  /** Record a tab the user closed explicitly. Call BEFORE tabs.close(). */
  noteClosed(tab: TabRec): void {
    const url = tab.url ?? '';
    // Blank new-tab pages carry no state worth restoring.
    if (!url || url.startsWith('data:') || url === 'about:blank') return;
    this.entries.push({
      id: randomUUID(),
      spaceId: tab.spaceId,
      url,
      title: tab.title,
      closedAt: Date.now(),
    });
    if (this.entries.length > MAX_CLOSED_TABS) {
      this.entries.splice(0, this.entries.length - MAX_CLOSED_TABS);
    }
  }

  /** Pop the most recently closed tab, or undefined when the stack is empty. */
  reopen(): ClosedTabEntry | undefined {
    return this.entries.pop();
  }

  get size(): number {
    return this.entries.length;
  }
}
