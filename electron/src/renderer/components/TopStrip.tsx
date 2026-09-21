/**
 * Top strip on the new design system: sidebar toggle, back/forward,
 * reload/stop, the omnibox (navigation + search + AI, Dia pattern),
 * split-view toggle, agent toggle.
 *
 * Disabled states come from canGoBack / canGoForward. When split-pick is
 * armed, a hint chip appears and the next clicked sidebar tab becomes the
 * split partner.
 */

import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  PanelLeft,
  Plus,
  RotateCw,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { useBrowser } from "../BrowserContext";
import { domainOf, nt } from "../nt";
import { AppLogo } from "./AppLogo";
import { Omnibox } from "./Omnibox";
import { ShieldButton } from "./ShieldButton";
import { useVoiceSession } from "./VoiceSession";
import { VoiceOrb, type VoiceOrbMode } from "./VoiceOrb";

/**
 * Temporary toolbar chip, visible only while voice is active. Clicking it
 * opens the agent panel to the live voice surface.
 */
function VoiceChip() {
  const voice = useVoiceSession();
  if (!voice.active) return null;
  const speaking = voice.playbackSpeaking || voice.engine === "speaking";
  const label = voice.voiceError
    ? "Voice error"
    : voice.engine === "listening"
      ? "Listening"
      : voice.engine === "transcribing"
        ? "Transcribing"
        : voice.engine === "thinking"
          ? (voice.acting ? voice.acting.label : "Working")
          : speaking
            ? "Speaking — tap to interrupt"
            : "Voice";
  const orbMode = (
    voice.engine === "listening"
      ? "listening"
      : voice.engine === "transcribing" || voice.engine === "thinking"
        ? "thinking"
        : speaking
          ? "speaking"
          : "idle"
  ) as VoiceOrbMode;
  return (
    <button
      className="voice-chip nt-r-full flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-[11px] font-medium"
      style={{
        borderColor: "var(--nt-accent)",
        color: "var(--nt-text-1)",
        background: "var(--nt-accent-soft)",
      }}
      onClick={() => {
        // Tap while speaking = barge-in: stop TTS, start listening fresh.
        // Otherwise open the agent panel to the live voice surface.
        if (speaking) void nt().voiceStopSpeaking();
        else void nt().uiSetAgentPanelOpen(true);
      }}
      title={speaking ? "Interrupt speech and start listening" : "Voice is active — open the agent panel"}
      role="status"
      aria-label={`Voice is active: ${label}. ${speaking ? "Interrupt speech and start listening." : "Open the agent panel."}`}
    >
      <VoiceOrb mode={orbMode} amplitude={voice.amplitude} size={14} />
      <span className="max-w-[200px] truncate">{label}</span>
    </button>
  );
}

export function TopStrip() {
  const { snapshot, activeSpace, activeTab, split, setSplit, splitPick, setSplitPick } =
    useBrowser();

  const iconBtn =
    "nt-r-sm p-2 transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent";

  const bookmarked = Boolean(
    activeSpace &&
      activeTab &&
      activeSpace.bookmarks.some((b) => b.url === activeTab.url),
  );

  const toggleBookmark = () => {
    if (!activeTab || !activeSpace) return;
    const existing = activeSpace.bookmarks.find((b) => b.url === activeTab.url);
    if (existing) void nt().bookmarksRemove(activeSpace.id, existing.id);
    else
      void nt().bookmarksAdd(
        activeSpace.id,
        activeTab.title || domainOf(activeTab.url),
        activeTab.url,
      );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "d"
      ) {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        toggleBookmark();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <header
      className="relative flex h-11 shrink-0 items-center gap-1 border-b px-2"
      style={{ background: "var(--nt-bg-subtle)", borderColor: "var(--nt-border)" }}
    >
      <div className="flex items-center pl-1 pr-0.5" title="Next Token">
        <AppLogo size={20} />
      </div>
      <button
        title="Toggle sidebar (⌘S)"
        onClick={() =>
          void nt().uiSetSidebarCollapsed(!(snapshot?.sidebarCollapsed ?? false))
        }
        className={iconBtn}
        style={{
          color: snapshot?.sidebarCollapsed
            ? "var(--nt-text-3)"
            : "var(--nt-text-2)",
        }}
      >
        <PanelLeft size={16} strokeWidth={1.75} />
      </button>
      <button
        title="Go back"
        disabled={!activeTab?.canGoBack}
        onClick={() => void nt().navBack()}
        className={iconBtn}
        style={{ color: "var(--nt-text-2)" }}
      >
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <button
        title="Go forward"
        disabled={!activeTab?.canGoForward}
        onClick={() => void nt().navForward()}
        className={iconBtn}
        style={{ color: "var(--nt-text-2)" }}
      >
        <ChevronRight size={16} strokeWidth={1.75} />
      </button>
      {activeTab?.loading ? (
        <button
          title="Stop loading"
          onClick={() => void nt().navStop()}
          className={iconBtn}
          style={{ color: "var(--nt-accent)" }}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      ) : (
        <button
          title="Reload"
          disabled={!activeTab}
          onClick={() => void nt().navReload()}
          className={iconBtn}
          style={{ color: "var(--nt-text-2)" }}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </button>
      )}

      {/* Ad-block shield: live blocked count + per-site toggle */}
      <ShieldButton />

      {/* Temporary voice chip — only while voice is active */}
      <VoiceChip />

      {/* Omnibox: navigation + search + AI with visible intent routing */}
      <div className="flex flex-1 justify-center px-3">
        <Omnibox />
      </div>

      {splitPick && (
        <span
          className="nt-popover nt-r-full absolute left-1/2 top-12 z-20 -translate-x-1/2 whitespace-nowrap border px-3 py-1.5 text-[12px] shadow-lg"
          style={{
            background: "var(--nt-bg-overlay)",
            borderColor: "var(--nt-accent)",
            color: "var(--nt-text-2)",
          }}
        >
          Click a tab in the sidebar to split with it ·{" "}
          <span style={{ color: "var(--nt-text-3)" }}>esc to cancel</span>
        </span>
      )}

      <button
        title={split ? "Close split view" : "Split view…"}
        onClick={() => {
          if (split) setSplit(null);
          else setSplitPick(!splitPick);
        }}
        className={iconBtn}
        style={
          split || splitPick
            ? { color: "var(--nt-accent)", background: "var(--nt-accent-soft)" }
            : { color: "var(--nt-text-3)" }
        }
      >
        {split ? (
          <X size={16} strokeWidth={1.75} />
        ) : (
          <Columns2 size={16} strokeWidth={1.75} />
        )}
      </button>
      <button
        title="New tab (⌘T)"
        onClick={() => void nt().tabsCreate({})}
        className={iconBtn}
        style={{ color: "var(--nt-text-3)" }}
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
      <button
        title={bookmarked ? "Remove bookmark" : "Bookmark this page (⌘D)"}
        disabled={!activeTab || !activeSpace}
        onClick={toggleBookmark}
        className={iconBtn}
        style={
          bookmarked
            ? { color: "var(--nt-accent)" }
            : { color: "var(--nt-text-3)" }
        }
      >
        <Star
          size={16}
          strokeWidth={1.75}
          fill={bookmarked ? "currentColor" : "none"}
        />
      </button>
      <button
        title="Toggle agent panel"
        onClick={() =>
          void nt().uiSetAgentPanelOpen(!(snapshot?.agentPanelOpen ?? false))
        }
        className={iconBtn}
        style={
          snapshot?.agentPanelOpen
            ? { color: "var(--nt-accent)", background: "var(--nt-accent-soft)" }
            : { color: "var(--nt-text-3)" }
        }
      >
        <Sparkles size={16} strokeWidth={1.75} />
      </button>
    </header>
  );
}
