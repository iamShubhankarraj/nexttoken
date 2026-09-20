/**
 * Tab content area: renders the active tab's page, or two panes side-by-side
 * in split view with a draggable divider.
 *
 * In the product each <PageRenderer/> is swapped for a WebContentsView; the
 * split layout (two tiled views + draggable divider) is owned here in the
 * UI layer, not in C++ — which is exactly why the web-tech UI approach wins.
 */

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { PageRenderer } from "./Pages";

export function TabArea() {
  const { state, space } = useStore();

  if (!state.split) {
    const tab = space.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return null;
    return (
      <div className="h-full flex-1 bg-[#08080c]">
        <PageRenderer tab={tab} />
      </div>
    );
  }

  const left = space.tabs.find((t) => t.id === state.split!.leftId);
  const right = space.tabs.find((t) => t.id === state.split!.rightId);
  if (!left || !right) return null;
  return <SplitView leftId={left.id} rightId={right.id} />;
}

function SplitView({ leftId, rightId }: { leftId: string; rightId: string }) {
  const { dispatch, space } = useStore();
  const [leftPct, setLeftPct] = useState(50);
  const dragging = useRef(false);
  const container = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current || !container.current) return;
    const rect = container.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(80, Math.max(20, pct)));
  }, []);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", up);
    };
  }, [onMove]);

  const left = space.tabs.find((t) => t.id === leftId);
  const right = space.tabs.find((t) => t.id === rightId);
  if (!left || !right) return null;

  const pane = (tabId: string, title: string) => (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] bg-[#0a0a0e] px-3 py-1.5">
        <span className="truncate text-[12px] text-white/50">{title}</span>
        <button
          title="Close split view"
          onClick={() => dispatch({ type: "CLEAR_SPLIT" })}
          className="ml-auto rounded p-1 text-white/35 hover:bg-white/10 hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 bg-[#08080c]">
        <PageRenderer tab={space.tabs.find((t) => t.id === tabId)!} />
      </div>
    </div>
  );

  return (
    <div ref={container} className="flex h-full flex-1 nt-fade-in">
      <div style={{ width: `${leftPct}%` }} className="min-w-0">
        {pane(leftId, left.title)}
      </div>
      <div
        onMouseDown={() => (dragging.current = true)}
        className="w-1.5 shrink-0 cursor-col-resize bg-white/[0.06] hover:bg-[var(--accent)]/60 transition-colors"
        title="Drag to resize"
      />
      <div style={{ width: `${100 - leftPct}%` }} className="min-w-0">
        {pane(rightId, right.title)}
      </div>
    </div>
  );
}
