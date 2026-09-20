/**
 * Next Token — renderer shell on the new design system.
 *
 * Layout: [sidebar] [top strip + webview content] [agent panel]
 *         + command bar + settings overlays.
 *
 * Every tab is a real <webview> guest (TabViews) composited by the
 * main process — the middle region is chrome only. The active space's
 * tokens are applied as inline style on the app root (id="nt-root"),
 * so switching spaces visibly re-skins the chrome (delight moment).
 *
 * Global shortcuts:
 *   ⌘/Ctrl+K ……… command bar
 *   ⌘/Ctrl+T ……… new tab
 *   ⌘/Ctrl+1…9 …… switch space
 *   ⌘/Ctrl+S ……… toggle sidebar
 *   Alt+V / ⌘/Ctrl+Shift+V … voice command listening
 *   Esc …………… close topmost overlay / cancel split-pick
 */

import { Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, useBrowser } from "./BrowserContext";
import { AgentPanel } from "./components/AgentPanel";
import { CommandBar } from "./components/CommandBar";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TabViews } from "./components/TabView";
import { TopStrip } from "./components/TopStrip";
import { nt } from "./nt";
import { rootStyleProp } from "./theme";

function Shell() {
  const {
    snapshot,
    bridgeError,
    activeTab,
    theme,
    splitPick,
    setSplitPick,
  } = useBrowser();
  const [commandOpen, setCommandOpen] = useState(false);
  // Delight moment: gentle overshoot when the space (and theme) changes.
  const [delight, setDelight] = useState(false);
  const activeSpaceId = snapshot?.activeSpaceId;

  useEffect(() => {
    if (!activeSpaceId) return;
    setDelight(true);
    const t = setTimeout(() => setDelight(false), 340);
    return () => clearTimeout(t);
  }, [activeSpaceId]);

  const closeOverlays = useCallback(() => {
    if (commandOpen) setCommandOpen(false);
    else if (splitPick) setSplitPick(false);
    else if (snapshot?.settingsOpen) void nt().uiSetSettingsOpen(false);
  }, [commandOpen, splitPick, setSplitPick, snapshot?.settingsOpen]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // Voice hotkey works everywhere (the hook listens for this event).
      if (
        (e.altKey && (e.key === "v" || e.key === "V")) ||
        (mod && e.shiftKey && (e.key === "V" || e.key === "v"))
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("nt:voice-toggle"));
        return;
      }

      if (e.key === "Escape") {
        closeOverlays();
        return;
      }
      if (!mod || typing) return;

      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setCommandOpen((o) => !o);
      } else if (k === "t") {
        e.preventDefault();
        void nt().tabsCreate({});
      } else if (k === "s") {
        e.preventDefault();
        if (snapshot)
          void nt().uiSetSidebarCollapsed(!snapshot.sidebarCollapsed);
      } else if (k >= "1" && k <= "9") {
        const target = snapshot?.spaces[Number(k) - 1];
        if (target) {
          e.preventDefault();
          void nt().spacesSwitch(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot, closeOverlays]);

  if (bridgeError) {
    return (
      <div
        id="nt-root"
        className="flex h-full items-center justify-center p-8 text-center"
        style={{ background: "var(--nt-bg-base)", color: "var(--nt-text-1)" }}
      >
        <div>
          <p className="text-[15px] font-semibold">Couldn't reach the browser</p>
          <p className="mt-2 max-w-md text-[13px]" style={{ color: "var(--nt-text-2)" }}>
            {bridgeError} Make sure the preload script exposes{" "}
            <code className="nt-r-sm bg-[var(--nt-bg-hover)] px-1">window.nt</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        id="nt-root"
        className="flex h-full items-center justify-center gap-2.5"
        style={{ background: "var(--nt-bg-base)", color: "var(--nt-text-3)" }}
      >
        <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
        <p className="text-[13px]">Connecting to the browser…</p>
      </div>
    );
  }

  const tabCount = snapshot.spaces.reduce((n, s) => n + s.tabs.length, 0);

  return (
    <div
      id="nt-root"
      className={`flex h-full overflow-hidden ${delight ? "nt-space-switch" : ""}`}
      style={{
        ...(theme ? rootStyleProp(theme) : undefined),
        background: "var(--nt-bg-base)",
        color: "var(--nt-text-1)",
      }}
    >
      {!snapshot.sidebarCollapsed && <Sidebar />}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopStrip />
        {/* Real tab content: webview guests mounted by <TabViews/>. */}
        <main className="relative min-h-0 flex-1" style={{ background: "var(--nt-bg-base)" }}>
          <TabViews />
          {tabCount === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-[15px] font-semibold tracking-[-0.01em]" style={{ color: "var(--nt-text-1)" }}>
                Nothing open yet
              </p>
              <p className="max-w-xs text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                Press{" "}
                <kbd
                  className="nt-r-sm nt-num border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  ⌘T
                </kbd>{" "}
                or hit the button to open your first tab.
              </p>
              <button
                onClick={() => void nt().tabsCreate({})}
                className="nt-r-sm pointer-events-auto mt-1 flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.03]"
                style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
              >
                <Plus size={14} strokeWidth={1.75} /> New tab
              </button>
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {activeTab ? activeTab.title || "New tab" : "No tabs open"}
          </span>
        </main>
      </div>

      {snapshot.agentPanelOpen && <AgentPanel />}
      {commandOpen && <CommandBar onClose={() => setCommandOpen(false)} />}
      {snapshot.settingsOpen && (
        <Settings onClose={() => void nt().uiSetSettingsOpen(false)} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserProvider>
      <Shell />
    </BrowserProvider>
  );
}
