/**
 * Minimal top strip: window controls on the left, a domain-only URL pill in
 * the center, and view controls on the right. Deliberately quiet — the
 * sidebar is the primary navigation surface, Arc-style.
 */

import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  PanelLeft,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { domainOf, useStore } from "../store";

export function TopStrip() {
  const { state, dispatch, space, activeTab } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const v = draft.trim();
    if (v && activeTab) {
      const url = v.startsWith("http") || v.startsWith("nexttoken://") ? v : `https://${v}`;
      dispatch({ type: "NAVIGATE_ACTIVE", url });
    }
    setEditing(false);
  };

  return (
    <header className="relative flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.07] bg-[#0a0a0e] px-2">
      <button
        title="Toggle sidebar (⌘S)"
        onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
        className={`rounded-lg p-2 transition-colors ${state.sidebarOpen ? "text-white/80 bg-white/[0.07]" : "text-white/40 hover:bg-white/[0.07] hover:text-white"}`}
      >
        <PanelLeft size={16} />
      </button>
      <button
        title="Previous tab"
        onClick={() => dispatch({ type: "STEP_TAB", dir: -1 })}
        className="rounded-lg p-2 text-white/40 hover:bg-white/[0.07] hover:text-white transition-colors"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        title="Next tab"
        onClick={() => dispatch({ type: "STEP_TAB", dir: 1 })}
        className="rounded-lg p-2 text-white/40 hover:bg-white/[0.07] hover:text-white transition-colors"
      >
        <ChevronRight size={16} />
      </button>
      <button
        title="Reload (prototype)"
        onClick={() => activeTab && dispatch({ type: "ACTIVATE_TAB", tabId: activeTab.id })}
        className="rounded-lg p-2 text-white/40 hover:bg-white/[0.07] hover:text-white transition-colors"
      >
        <RotateCw size={14} />
      </button>

      {/* Domain-only URL pill */}
      <div className="flex flex-1 justify-center px-4">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            placeholder="Search or enter address"
            className="w-full max-w-md rounded-full border border-[var(--accent)]/50 bg-white/[0.06] px-4 py-1.5 text-center text-[13px] outline-none"
          />
        ) : (
          <button
            title={activeTab?.url ?? ""}
            onClick={() => {
              setDraft(activeTab?.url ?? "");
              setEditing(true);
            }}
            className="flex max-w-md items-center gap-2 rounded-full border border-transparent px-4 py-1.5 text-[13px] text-white/60 hover:border-white/10 hover:bg-white/[0.04] hover:text-white/85 transition-all"
          >
            <span
              className="h-1.5 w-1.5 rounded-full shrink-0"
              style={{ background: space.accent }}
            />
            {activeTab ? domainOf(activeTab.url) : "New tab"}
          </button>
        )}
      </div>

      {state.splitPick && (
        <span className="nt-pop-in absolute left-1/2 top-12 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--accent)]/40 bg-[#14141c] px-3 py-1.5 text-xs text-white/80 shadow-lg">
          Click a tab in the sidebar to tile it side-by-side · <span className="text-white/40">esc to cancel</span>
        </span>
      )}

      <button
        title={state.split ? "Close split view" : "Split view…"}
        onClick={() =>
          state.split
            ? dispatch({ type: "CLEAR_SPLIT" })
            : dispatch({ type: "SET_SPLIT_PICK", picking: !state.splitPick })
        }
        className={`rounded-lg p-2 transition-colors ${
          state.split || state.splitPick
            ? "bg-[var(--accent)]/20 text-[var(--accent)]"
            : "text-white/40 hover:bg-white/[0.07] hover:text-white"
        }`}
      >
        {state.split ? <X size={16} /> : <Columns2 size={16} />}
      </button>
      <button
        title="Toggle copilot"
        onClick={() => dispatch({ type: "TOGGLE_COPILOT" })}
        className={`rounded-lg p-2 transition-colors ${
          state.copilotOpen
            ? "bg-[var(--accent)]/20 text-[var(--accent)]"
            : "text-white/40 hover:bg-white/[0.07] hover:text-white"
        }`}
      >
        <Sparkles size={16} />
      </button>
    </header>
  );
}
