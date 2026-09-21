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
 *   ⌘/Ctrl+E ……… toggle agent panel
 *   ⌘/Ctrl+T ……… new tab
 *   ⌘/Ctrl+1…9 …… switch space
 *   ⌘/Ctrl+S ……… toggle sidebar
 *   Alt+V / ⌘/Ctrl+Shift+V … voice command listening
 *   Esc …………… close topmost overlay / cancel split-pick
 */

import { Loader2, Plus, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, useBrowser } from "./BrowserContext";
import { AgentPanel } from "./components/AgentPanel";
import { AgentActingOverlay } from "./components/AgentActingOverlay";
import { CommandBar } from "./components/CommandBar";
import { DownloadPill } from "./components/DownloadPill";
import { FindBar } from "./components/FindBar";
import { ImportDialog } from "./components/ImportDialog";
import { NewTabHero } from "./components/NewTabHero";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TabViews } from "./components/TabView";
import { VoiceSession } from "./components/VoiceSession";
import { TopStrip } from "./components/TopStrip";
import { WritingHint } from "./components/WritingHint";
import { useBrainAudio } from "./hooks/useBrainAudio";
import { isNewTabUrl, nt } from "./nt";

/** Listens for "nt:open-import" and mounts the import dialog. */
function ImportDialogHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("nt:open-import", handler);
    return () => window.removeEventListener("nt:open-import", handler);
  }, []);
  if (!open) return null;
  return <ImportDialog onClose={() => setOpen(false)} />;
}

function Shell() {
  // Brain TTS playback + brain-driven listen/command-bar requests.
  useBrainAudio();
  const {
    snapshot,
    bridgeError,
    activeTab,
    splitPick,
    setSplitPick,
  } = useBrowser();
  const [commandOpen, setCommandOpen] = useState(false);
  // Models nudge: main asks us to open Settings → Models, optionally
  // highlighting one task section (vision-missing nudge).
  const [modelsFocus, setModelsFocus] = useState<{ task?: string } | undefined>(
    undefined,
  );
  // Delight moment: gentle overshoot when the space (and theme) changes.
  const [delight, setDelight] = useState(false);
  // Find-in-page bar (⌘F) for the active tab.
  const [findOpen, setFindOpen] = useState(false);
  // Blocked-popup indicator (main denied an opener-scripted window).
  const [popupBlocked, setPopupBlocked] = useState<{ url: string } | null>(
    null,
  );
  const activeSpaceId = snapshot?.activeSpaceId;

  useEffect(() => {
    if (!activeSpaceId) return;
    setDelight(true);
    const t = setTimeout(() => setDelight(false), 340);
    return () => clearTimeout(t);
  }, [activeSpaceId]);

  // Brain-driven command-bar opens (voice: "open the command bar").
  useEffect(() => {
    const open = () => setCommandOpen(true);
    window.addEventListener("nt:open-command-bar", open);
    return () => window.removeEventListener("nt:open-command-bar", open);
  }, []);

  // Main-process nudge: open Settings → Models (e.g. a vision task found no
  // vision model). The focus object is recreated per nudge so repeated nudges
  // re-fire the Settings highlight effect.
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = nt().onOpenModels((focus) => {
        setModelsFocus({ ...(focus ?? {}) });
        void nt().uiSetSettingsOpen(true);
      });
    } catch {
      /* bridge unavailable */
    }
    return () => off?.();
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    void nt().findStop();
  }, []);

  const closeOverlays = useCallback(() => {
    if (findOpen) closeFind();
    else if (commandOpen) setCommandOpen(false);
    else if (splitPick) setSplitPick(false);
    else if (snapshot?.settingsOpen) void nt().uiSetSettingsOpen(false);
  }, [commandOpen, splitPick, setSplitPick, snapshot?.settingsOpen, findOpen, closeFind]);

  // Main denied an opener-scripted popup — show the blocked indicator.
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = nt().onPopupBlocked((info) => setPopupBlocked({ url: info.url }));
    } catch {
      /* bridge unavailable */
    }
    return () => off?.();
  }, []);

  // Auto-dismiss the blocked-popup indicator after a while.
  useEffect(() => {
    if (!popupBlocked) return;
    const t = window.setTimeout(() => setPopupBlocked(null), 12000);
    return () => window.clearTimeout(t);
  }, [popupBlocked]);

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
      // Find in page (⌘F) and guest zoom (⌘= / ⌘- / ⌘0). Find is skipped
      // while typing in our own inputs; zoom is harmless anywhere.
      if (mod && !e.shiftKey && !e.altKey) {
        const k2 = e.key.toLowerCase();
        if (k2 === "f" && !typing) {
          e.preventDefault();
          setFindOpen(true);
          return;
        }
        if (k2 === "=" || k2 === "+") {
          e.preventDefault();
          void nt().tabsZoom("in");
          return;
        }
        if (k2 === "-" || k2 === "_") {
          e.preventDefault();
          void nt().tabsZoom("out");
          return;
        }
        if (k2 === "0") {
          e.preventDefault();
          void nt().tabsZoom("reset");
          return;
        }
      }
      if (!mod || typing) return;

      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setCommandOpen((o) => !o);
      } else if (k === "e") {
        e.preventDefault();
        if (snapshot)
          void nt().uiSetAgentPanelOpen(!snapshot.agentPanelOpen);
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
      // Theme CSS vars live on documentElement (:root) — painted by
      // applyTokensToRoot() (theme.ts), never inlined here, so React
      // re-renders can't clobber a live preview.
      style={{
        background: "var(--nt-bg-base)",
        color: "var(--nt-text-1)",
      }}
    >
      {!snapshot.sidebarCollapsed && <Sidebar />}

      {/* Content shell: rounded left corners interlock with the sidebar's
          liquid scoops (puzzle pieces, no straight seam). */}
      <div className="nt-content-liquid flex min-w-0 flex-1 flex-col">
        <TopStrip />
        {/* Real tab content: webview guests mounted by <TabViews/>. */}
        <main
          id="nt-content"
          className="relative min-h-0 flex-1"
          style={{ background: "var(--nt-bg-base)" }}
        >
          <TabViews />
          {/* Voice-agent browser indicators: target ring, AI cursor, capsule. */}
          <AgentActingOverlay />
          {/* Fresh tabs get the large centered command bar (Dia pattern). */}
          {activeTab && isNewTabUrl(activeTab.url) && <NewTabHero />}
          <WritingHint />
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
      {findOpen && <FindBar onClose={closeFind} />}
      <DownloadPill />
      {popupBlocked && (
        <div className="nt-toast" role="alert">
          <ShieldAlert size={15} strokeWidth={2} style={{ color: "var(--nt-accent)" }} />
          <span className="nt-toast-text">
            A popup was blocked. Some sign-in buttons open this way.
          </span>
          <button
            type="button"
            className="nt-toast-action"
            onClick={() => {
              const url = popupBlocked.url;
              setPopupBlocked(null);
              void nt().popupOpenBlocked(url);
            }}
          >
            Open anyway
          </button>
          <button
            type="button"
            className="nt-toast-dismiss"
            onClick={() => setPopupBlocked(null)}
            aria-label="Dismiss"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      {snapshot.settingsOpen && (
        <Settings
          onClose={() => void nt().uiSetSettingsOpen(false)}
          modelsFocus={modelsFocus}
        />
      )}
      <ImportDialogHost />
    </div>
  );
}

export default function App() {
  return (
    <BrowserProvider>
      <VoiceSession>
        <Shell />
      </VoiceSession>
    </BrowserProvider>
  );
}
