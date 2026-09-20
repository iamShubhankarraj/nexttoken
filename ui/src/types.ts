/**
 * Shared domain types for the Next Token prototype UI.
 *
 * In the real product these same shapes will be produced by the C++ bridge
 * (tabs / navigation / sessions) and consumed here unchanged — the reducer
 * in store.tsx is intentionally shaped like bridge events so this UI code
 * survives the transition from prototype to product.
 */

import type { LucideIcon } from "lucide-react";

/** Which mock page renderer a tab uses. */
export type PageKind = "start" | "article" | "dashboard" | "generic";

export interface TabItem {
  id: string;
  title: string;
  url: string;
  kind: PageKind;
  pinned: boolean;
  /** Pinned tabs may live inside a folder; today-tabs never do. */
  folderId?: string;
  /** Epoch ms of last activation/interaction. Drives auto-archive. */
  lastActive: number;
}

export interface Folder {
  id: string;
  name: string;
  open: boolean;
}

export interface Favorite {
  id: string;
  name: string;
  url: string;
  icon: LucideIcon;
}

export interface Space {
  id: string;
  name: string;
  icon: LucideIcon;
  /** Hex accent used for the active-tab indicator, space dot, etc. */
  accent: string;
  favorites: Favorite[];
  folders: Folder[];
  tabs: TabItem[];
  /** Remembers where you were when you switch away and back. */
  activeTabId: string | null;
}

export interface ArchivedTab extends TabItem {
  archivedAt: number;
  fromSpaceId: string;
  fromSpaceName: string;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  url: string;
  visitedAt: number;
}
