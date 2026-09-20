/**
 * Central state for the Next Token prototype UI.
 *
 * The reducer is deliberately shaped like the events the real C++ bridge
 * will emit (tab created / activated / closed / archived …). When the
 * prototype graduates to a real browser shell, this store keeps its shape
 * and the bridge simply dispatches the same actions.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import type { ReactNode } from "react";
import { seedBookmarks, seedHistory, seedSpaces } from "./data";
import type {
  ArchivedTab,
  Bookmark,
  HistoryItem,
  PageKind,
  Space,
  TabItem,
} from "./types";

/** Idle time after which an unpinned tab is auto-archived (demo: 45s). */
export const IDLE_ARCHIVE_MS = 45_000;

export interface SplitState {
  leftId: string;
  rightId: string;
}

interface State {
  spaces: Space[];
  activeSpaceId: string;
  /** Globally active tab id (mirrors active space's activeTabId). */
  activeTabId: string | null;
  archived: ArchivedTab[];
  sidebarOpen: boolean;
  copilotOpen: boolean;
  commandBarOpen: boolean;
  /** When true, the next sidebar tab click becomes the split partner. */
  splitPick: boolean;
  split: SplitState | null;
  bookmarks: Bookmark[];
  history: HistoryItem[];
}

export type Action =
  | { type: "SWITCH_SPACE"; spaceId: string }
  | { type: "ACTIVATE_TAB"; tabId: string }
  | { type: "NEW_TAB"; url?: string; title?: string; kind?: PageKind }
  | { type: "OPEN_URL"; url: string; title?: string; kind?: PageKind }
  | { type: "CLOSE_TAB"; tabId: string }
  | { type: "TOGGLE_PIN"; tabId: string }
  | { type: "TOGGLE_FOLDER"; folderId: string }
  | { type: "ARCHIVE_IDLE" }
  | { type: "ARCHIVE_TAB"; tabId: string }
  | { type: "ARCHIVE_ALL_IDLE" }
  | { type: "RESTORE_TAB"; archiveId: string }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_COPILOT" }
  | { type: "SET_COMMAND_BAR"; open: boolean }
  | { type: "SET_SPLIT_PICK"; picking: boolean }
  | { type: "SET_SPLIT"; leftId: string; rightId: string }
  | { type: "CLEAR_SPLIT" }
  | { type: "STEP_TAB"; dir: 1 | -1 }
  | { type: "NAVIGATE_ACTIVE"; url: string };

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;

function domainOf(url: string): string {
  try {
    if (url.startsWith("nexttoken://")) return "Next Token";
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function guessKind(url: string): PageKind {
  if (url === "nexttoken://start") return "start";
  if (url === "nexttoken://dashboard") return "dashboard";
  return "generic";
}

function guessTitle(url: string): string {
  if (url === "nexttoken://start") return "Welcome to Next Token";
  if (url === "nexttoken://dashboard") return "Next Token — Perf Dashboard";
  const d = domainOf(url);
  const slug = url.split("/").filter(Boolean).pop() ?? "";
  const pretty = slug
    .replace(/[-_]/g, " ")
    .replace(/\.\w+$/, "")
    .slice(0, 48);
  return pretty ? `${pretty} — ${d}` : d;
}

function activeSpace(state: State): Space {
  return state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0];
}

/** Sidebar order: pinned (folder-grouped) first, then today tabs. */
function orderedTabs(space: Space): TabItem[] {
  const pinned = space.tabs.filter((t) => t.pinned);
  const today = space.tabs.filter((t) => !t.pinned);
  return [...pinned, ...today];
}

function withSpace(state: State, spaceId: string, fn: (s: Space) => Space): State {
  return {
    ...state,
    spaces: state.spaces.map((s) => (s.id === spaceId ? fn(s) : s)),
  };
}

function ensureActiveTab(state: State): State {
  const space = activeSpace(state);
  let activeTabId = space.activeTabId;
  if (!activeTabId || !space.tabs.some((t) => t.id === activeTabId)) {
    activeTabId = orderedTabs(space)[0]?.id ?? null;
  }
  // Drop split panes that no longer exist in this space.
  const tabIds = new Set(space.tabs.map((t) => t.id));
  const rawSplit = state.split;
  const split: SplitState | null =
    rawSplit && tabIds.has(rawSplit.leftId) && tabIds.has(rawSplit.rightId)
      ? rawSplit
      : null;
  return {
    ...state,
    activeTabId,
    split,
    splitPick: split ? state.splitPick : false,
    spaces: state.spaces.map((s) =>
      s.id === space.id ? { ...s, activeTabId } : s,
    ),
  };
}

function makeTab(url: string, title?: string, kind?: PageKind): TabItem {
  return {
    id: uid(),
    title: title ?? guessTitle(url),
    url,
    kind: kind ?? guessKind(url),
    pinned: false,
    lastActive: Date.now(),
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SWITCH_SPACE": {
      if (action.spaceId === state.activeSpaceId) return state;
      return ensureActiveTab({ ...state, activeSpaceId: action.spaceId, split: null, splitPick: false });
    }

    case "ACTIVATE_TAB": {
      const space = activeSpace(state);
      if (!space.tabs.some((t) => t.id === action.tabId)) return state;
      // In split-pick mode a click chooses the split partner instead.
      if (state.splitPick && action.tabId !== state.activeTabId) {
        return {
          ...state,
          splitPick: false,
          split: { leftId: state.activeTabId ?? action.tabId, rightId: action.tabId },
        };
      }
      const now = Date.now();
      return ensureActiveTab(
        withSpace(state, space.id, (s) => ({
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === action.tabId ? { ...t, lastActive: now } : t,
          ),
          activeTabId: action.tabId,
        })),
      );
    }

    case "NEW_TAB": {
      const space = activeSpace(state);
      const tab = makeTab(action.url ?? "nexttoken://start", action.title, action.kind);
      return ensureActiveTab(
        withSpace(state, space.id, (s) => ({
          ...s,
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
        })),
      );
    }

    case "OPEN_URL": {
      // Focus the tab if the URL is already open, otherwise open it.
      const space = activeSpace(state);
      const existing = space.tabs.find((t) => t.url === action.url);
      if (existing) {
        return reducer(state, { type: "ACTIVATE_TAB", tabId: existing.id });
      }
      return reducer(state, {
        type: "NEW_TAB",
        url: action.url,
        title: action.title,
        kind: action.kind,
      });
    }

    case "CLOSE_TAB": {
      const space = activeSpace(state);
      const tabs = space.tabs.filter((t) => t.id !== action.tabId);
      let next = withSpace(state, space.id, (s) => ({ ...s, tabs }));
      if (tabs.length === 0) {
        // Never leave a space tab-less: open a fresh start page.
        const tab = makeTab("nexttoken://start");
        next = withSpace(next, space.id, (s) => ({
          ...s,
          tabs: [tab],
          activeTabId: tab.id,
        }));
      }
      return ensureActiveTab(next);
    }

    case "TOGGLE_PIN": {
      const space = activeSpace(state);
      return withSpace(state, space.id, (s) => ({
        ...s,
        tabs: s.tabs.map((t) =>
          t.id === action.tabId
            ? { ...t, pinned: !t.pinned, folderId: t.pinned ? t.folderId : undefined }
            : t,
        ),
      }));
    }

    case "TOGGLE_FOLDER": {
      const space = activeSpace(state);
      return withSpace(state, space.id, (s) => ({
        ...s,
        folders: s.folders.map((f) =>
          f.id === action.folderId ? { ...f, open: !f.open } : f,
        ),
      }));
    }

    case "ARCHIVE_TAB":
    case "ARCHIVE_IDLE":
    case "ARCHIVE_ALL_IDLE": {
      const now = Date.now();
      let archived = state.archived;
      const spaces = state.spaces.map((space) => {
        const keep: TabItem[] = [];
        const toArchive: ArchivedTab[] = [];
        for (const t of space.tabs) {
          const idleTooLong = now - t.lastActive > IDLE_ARCHIVE_MS;
          const shouldArchive =
            !t.pinned &&
            t.id !== state.activeTabId &&
            (action.type === "ARCHIVE_TAB"
              ? t.id === action.tabId
              : action.type === "ARCHIVE_ALL_IDLE"
                ? true
                : idleTooLong);
          if (shouldArchive) {
            toArchive.push({
              ...t,
              archivedAt: now,
              fromSpaceId: space.id,
              fromSpaceName: space.name,
            });
          } else {
            keep.push(t);
          }
        }
        if (toArchive.length) archived = [...toArchive, ...archived];
        return { ...space, tabs: keep };
      });
      // Cap the archive at 50 entries (oldest dropped) — keeps memory flat.
      archived = archived.slice(0, 50);
      return ensureActiveTab({ ...state, spaces, archived });
    }

    case "RESTORE_TAB": {
      const entry = state.archived.find((a) => a.id === action.archiveId);
      if (!entry) return state;
      const restored: TabItem = {
        id: entry.id,
        title: entry.title,
        url: entry.url,
        kind: entry.kind,
        pinned: false,
        lastActive: Date.now(),
      };
      const next = withSpace(state, entry.fromSpaceId, (s) => ({
        ...s,
        tabs: [...s.tabs, restored],
        activeTabId: entry.fromSpaceId === state.activeSpaceId ? restored.id : s.activeTabId,
      }));
      return ensureActiveTab({
        ...next,
        archived: next.archived.filter((a) => a.id !== action.archiveId),
        ...(entry.fromSpaceId !== state.activeSpaceId
          ? { activeSpaceId: entry.fromSpaceId }
          : {}),
      });
    }

    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "TOGGLE_COPILOT":
      return { ...state, copilotOpen: !state.copilotOpen };
    case "SET_COMMAND_BAR":
      return { ...state, commandBarOpen: action.open };
    case "SET_SPLIT_PICK":
      return { ...state, splitPick: action.picking };

    case "SET_SPLIT":
      return { ...state, split: { leftId: action.leftId, rightId: action.rightId }, splitPick: false };
    case "CLEAR_SPLIT":
      return { ...state, split: null };

    case "STEP_TAB": {
      const space = activeSpace(state);
      const list = orderedTabs(space);
      if (list.length < 2) return state;
      const idx = list.findIndex((t) => t.id === state.activeTabId);
      const nextTab = list[(idx + action.dir + list.length) % list.length];
      return reducer(state, { type: "ACTIVATE_TAB", tabId: nextTab.id });
    }

    case "NAVIGATE_ACTIVE": {
      const space = activeSpace(state);
      const tab = space.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return state;
      const url = action.url;
      return withSpace(state, space.id, (s) => ({
        ...s,
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, url, title: guessTitle(url), kind: guessKind(url), lastActive: Date.now() }
            : t,
        ),
      }));
    }

    default:
      return state;
  }
}

function initState(): State {
  const spaces = seedSpaces();
  // Default each space to a sensible active tab (start page if present).
  for (const s of spaces) {
    s.activeTabId =
      s.tabs.find((t) => t.kind === "start")?.id ?? s.tabs[0]?.id ?? null;
  }
  return {
    spaces,
    activeSpaceId: spaces[0].id,
    activeTabId: spaces[0].activeTabId,
    archived: [],
    sidebarOpen: true,
    copilotOpen: false,
    commandBarOpen: false,
    splitPick: false,
    split: null,
    bookmarks: seedBookmarks(),
    history: seedHistory(),
  };
}

interface Store {
  state: State;
  dispatch: React.Dispatch<Action>;
  space: Space;
  activeTab: TabItem | null;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState);

  // Auto-archive ticker: every 10s, sweep idle unpinned tabs into Archive.
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "ARCHIVE_IDLE" }), 10_000);
    return () => clearInterval(timer);
  }, []);

  const value = useMemo<Store>(() => {
    const space = activeSpace(state);
    const activeTab =
      space.tabs.find((t) => t.id === state.activeTabId) ?? null;
    return { state, dispatch, space, activeTab };
  }, [state]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

export { domainOf, orderedTabs };
