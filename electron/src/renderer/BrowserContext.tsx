/**
 * The single source of renderer truth.
 *
 * - Initial state comes from nt.onSnapshot (no mock data, ever).
 * - Live per-tab updates arrive via nt.onTabDelta and are folded into
 *   the snapshot locally.
 * - The active space's theme tokens are fetched via nt.themesGet() and
 *   mapped with tokensToCssVars(); App applies them as inline style on
 *   the app root. Switching spaces re-skins the chrome.
 * - document.title follows the active tab, like a real browser.
 * - Split view is renderer-local state (never persisted):
 *   { leftTabId, rightTabId, ratio } | null, plus a `splitPick` mode
 *   where the next clicked tab becomes the split partner.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  BrowserSnapshot,
  SpaceState,
  TabDelta,
  TabState,
} from "../shared/ipc";
import { rootThemeStyle, applyTokensToRoot, repairLegacyTokens, migrateLegacyDefault, type RootThemeStyle } from "./theme";

function applyDeltaToTab(tab: TabState, d: TabDelta): TabState {
  switch (d.type) {
    case "title":
      return typeof d.value === "string" ? { ...tab, title: d.value } : tab;
    case "url":
      return typeof d.value === "string" ? { ...tab, url: d.value } : tab;
    case "loading":
      return typeof d.value === "boolean" ? { ...tab, loading: d.value } : tab;
    case "nav-state":
      return {
        ...tab,
        canGoBack: d.canGoBack ?? tab.canGoBack,
        canGoForward: d.canGoForward ?? tab.canGoForward,
      };
    case "favicon":
      return typeof d.value === "string" ? { ...tab, favicon: d.value } : tab;
    case "folder":
      return d.value === null || typeof d.value === "string"
        ? { ...tab, folderId: d.value }
        : tab;
    default:
      return tab;
  }
}

function applyDelta(snapshot: BrowserSnapshot, d: TabDelta): BrowserSnapshot {
  return {
    ...snapshot,
    spaces: snapshot.spaces.map((space) => ({
      ...space,
      tabs: space.tabs.map((tab) =>
        tab.id === d.tabId ? applyDeltaToTab(tab, d) : tab,
      ),
    })),
  };
}

export interface SplitState {
  leftTabId: string;
  rightTabId: string;
  /** 0..1 — fraction of the width given to the left pane. */
  ratio: number;
}

interface BrowserContextValue {
  snapshot: BrowserSnapshot | null;
  bridgeError: string | null;
  activeSpace: SpaceState | null;
  activeTab: TabState | null;
  /** tokensToCssVars(active space tokens) — applied inline on the app root. */
  theme: RootThemeStyle | null;
  /** Re-fetch the active space's theme tokens and re-apply them. */
  refreshTheme: () => void;
  split: SplitState | null;
  setSplit: (s: SplitState | null) => void;
  /** When true, the next clicked tab becomes the split partner. */
  splitPick: boolean;
  setSplitPick: (v: boolean) => void;
}

const BrowserContext = createContext<BrowserContextValue | null>(null);

export function BrowserProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [theme, setTheme] = useState<RootThemeStyle | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [split, setSplit] = useState<SplitState | null>(null);
  const [splitPick, setSplitPick] = useState(false);

  // Subscribe to the main process. This is where all browser state comes from.
  useEffect(() => {
    if (!window.nt) {
      setBridgeError("The browser bridge (window.nt) is unavailable.");
      return;
    }
    const offSnapshot = window.nt.onSnapshot(setSnapshot);
    const offDelta = window.nt.onTabDelta((delta) =>
      setSnapshot((prev) => (prev ? applyDelta(prev, delta) : prev)),
    );
    // Pull initial state: main's boot-time push can race this subscription.
    window.nt.snapshotGet().then(setSnapshot).catch((e) =>
      setBridgeError(String(e?.message ?? e)),
    );
    return () => {
      offSnapshot();
      offDelta();
    };
  }, []);

  const activeSpace: SpaceState | null = useMemo(
    () =>
      snapshot?.spaces.find((s) => s.id === snapshot.activeSpaceId) ?? null,
    [snapshot],
  );

  const activeTab: TabState | null = useMemo(
    () =>
      activeSpace?.tabs.find((t) => t.id === activeSpace.activeTabId) ?? null,
    [activeSpace],
  );

  // Fetch the active space's theme tokens (from main, never hardcoded) and
  // paint them onto documentElement (:root). Switching spaces re-skins
  // the chrome; the vars are mirrored to localStorage so the pre-paint
  // boot script restores them before first paint on relaunch.
  useEffect(() => {
    const spaceId = snapshot?.activeSpaceId;
    if (!spaceId || !window.nt) return;
    let alive = true;
    window.nt
      .themesGet(spaceId)
      .then((tokens) => {
        if (!alive) return;
        // Heal themes saved while the Appearance toggle flipped `mode`
        // without swapping the palette (they never rendered as intended).
        let healed = repairLegacyTokens(tokens);
        let healedChanged = healed !== tokens;
        // One-time migration: pristine legacy dark defaults become the
        // Dia-inspired light default. Deliberate dark themes are untouched.
        const migrated = migrateLegacyDefault(spaceId, healed);
        if (migrated) {
          healed = migrated;
          healedChanged = true;
        }
        if (healedChanged) {
          // Persist the repair so the broken combo doesn't come back.
          window.nt?.themesSet(spaceId, healed).catch(() => {});
        }
        applyTokensToRoot(healed);
        setTheme(rootThemeStyle(healed));
      })
      .catch(() => {
        /* keep previous theme on failure */
      });
    return () => {
      alive = false;
    };
  }, [snapshot?.activeSpaceId, themeTick]);

  // Tab title follows the active tab.
  useEffect(() => {
    document.title = activeTab
      ? `${activeTab.title || "New tab"} — Next Token`
      : "Next Token";
  }, [activeTab]);

  const refreshTheme = useCallback(() => setThemeTick((t) => t + 1), []);

  const value = useMemo<BrowserContextValue>(
    () => ({
      snapshot,
      bridgeError,
      activeSpace,
      activeTab,
      theme,
      refreshTheme,
      split,
      setSplit,
      splitPick,
      setSplitPick,
    }),
    [
      snapshot,
      bridgeError,
      activeSpace,
      activeTab,
      theme,
      refreshTheme,
      split,
      splitPick,
    ],
  );

  return (
    <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>
  );
}

export function useBrowser(): BrowserContextValue {
  const ctx = useContext(BrowserContext);
  if (!ctx) throw new Error("useBrowser must be used inside <BrowserProvider>");
  return ctx;
}
