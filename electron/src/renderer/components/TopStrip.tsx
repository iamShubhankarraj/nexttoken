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
  X,
} from "lucide-react";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";
import { Omnibox } from "./Omnibox";
import { ShieldButton } from "./ShieldButton";

export function TopStrip() {
  const { snapshot, activeTab, split, setSplit, splitPick, setSplitPick } =
    useBrowser();

  const iconBtn =
    "nt-r-sm p-2 transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <header
      className="relative flex h-11 shrink-0 items-center gap-1 border-b px-2"
      style={{ background: "var(--nt-bg-subtle)", borderColor: "var(--nt-border)" }}
    >
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
