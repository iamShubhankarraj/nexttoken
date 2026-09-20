/**
 * Top strip on the new design system: sidebar toggle, back/forward,
 * reload/stop, address bar, split-view toggle, agent toggle.
 *
 * The address bar shows the active tab's URL; Enter navigates (main
 * decides URL-vs-search). Disabled states come from canGoBack /
 * canGoForward. When split-pick is armed, a hint chip appears and the
 * next clicked sidebar tab becomes the split partner.
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
import { useEffect, useRef, useState } from "react";
import { useBrowser } from "../BrowserContext";
import { domainOf, nt } from "../nt";

export function TopStrip() {
  const { snapshot, activeTab, split, setSplit, splitPick, setSplitPick } =
    useBrowser();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(activeTab?.url ?? "");
    setEditing(true);
  };

  const commit = () => {
    const v = draft.trim();
    if (v) void nt().navGo(v);
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft("");
  };

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

      {/* Address bar */}
      <div className="flex flex-1 justify-center px-3">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
            }}
            onBlur={commit}
            placeholder="Search or enter address"
            spellCheck={false}
            className="nt-r-full w-full max-w-xl border bg-[var(--nt-bg-raised)] px-4 py-1.5 text-center text-[13px] outline-none"
            style={{ borderColor: "var(--nt-accent)", color: "var(--nt-text-1)" }}
          />
        ) : (
          <button
            title={activeTab?.url ?? "New tab"}
            onClick={startEditing}
            className="nt-r-full flex max-w-xl items-center gap-2 border border-transparent px-4 py-1.5 text-[13px] transition-colors hover:border-[var(--nt-border)] hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-2)" }}
          >
            {activeTab?.loading ? (
              <span className="nt-shimmer" />
            ) : (
              <span
                className="nt-r-full h-1.5 w-1.5 shrink-0"
                style={{ background: "var(--nt-space)" }}
              />
            )}
            <span className="nt-mono truncate">
              {activeTab
                ? activeTab.loading
                  ? "Loading…"
                  : domainOf(activeTab.url)
                : "New tab"}
            </span>
          </button>
        )}
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
