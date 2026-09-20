/**
 * Tab content: every tab is a real <webview> guest owned by the main
 * process. ALL tabs' webviews stay mounted at all times (all spaces) —
 * unmounting destroys the guest. Inactive ones are display:none.
 *
 * Rules:
 * - Each tab's FIRST-SEEN url is captured in a ref map and used as `src`
 *   exactly once. Never re-bind src on snapshot updates (that would
 *   reload the page).
 * - On `dom-ready`, call nt.tabsAttach(tab.id, el.getWebContentsId())
 *   so main can wire the WebContents.
 * - `new-window` (target=_blank / window.open) opens a new tab via
 *   nt.tabsCreate({ url }) instead of a popup window.
 * - Split view is two webviews side by side with a draggable divider.
 */

import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useBrowser, type SplitState } from "../BrowserContext";
import { nt } from "../nt";
import type { WebviewElement, WebviewNewWindowEvent } from "../webview";

/** First-seen URL per tab id — captured once, used as webview `src` once. */
const firstSeenUrl = new Map<string, string>();

function srcFor(tabId: string, currentUrl: string): string {
  let src = firstSeenUrl.get(tabId);
  if (!src) {
    src = currentUrl;
    firstSeenUrl.set(tabId, src);
  }
  return src;
}

function attachWebview(el: WebviewElement, tabId: string): void {
  const marker = "__ntAttached";
  if ((el as unknown as Record<string, unknown>)[marker]) return;
  (el as unknown as Record<string, unknown>)[marker] = true;

  el.addEventListener("dom-ready", () => {
    try {
      const wcId = el.getWebContentsId();
      void nt().tabsAttach(tabId, wcId);
    } catch {
      /* main will retry on next snapshot if needed */
    }
  });

  el.addEventListener("new-window", (e: Event) => {
    const url = (e as unknown as WebviewNewWindowEvent).url;
    e.preventDefault();
    if (url) void nt().tabsCreate({ url });
  });
}

export function TabViews() {
  const { snapshot, split, setSplit } = useBrowser();

  const allTabs = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.spaces.flatMap((space) =>
      space.tabs.map((tab) => ({ tab, spaceId: space.id })),
    );
  }, [snapshot]);

  const tabById = useMemo(() => {
    const m = new Map<string, (typeof allTabs)[number]>();
    for (const t of allTabs) m.set(t.tab.id, t);
    return m;
  }, [allTabs]);

  // If a split tab was closed/archived, drop the split rather than
  // rendering a dead pane.
  useEffect(() => {
    if (!split) return;
    if (!tabById.has(split.leftTabId) || !tabById.has(split.rightTabId)) {
      setSplit(null);
    }
  }, [split, tabById, setSplit]);

  if (!snapshot) return null;

  if (split) {
    const left = tabById.get(split.leftTabId);
    const right = tabById.get(split.rightTabId);
    return (
      <SplitPanes
        left={left?.tab ?? null}
        right={right?.tab ?? null}
        split={split}
        allTabs={allTabs}
      />
    );
  }

  const activeTabId =
    snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId)?.activeTabId ??
    null;

  return (
    <div className="relative h-full w-full">
      {allTabs.map(({ tab }) => (
        <TabWebview
          key={tab.id}
          tabId={tab.id}
          url={tab.url}
          visible={tab.id === activeTabId}
          absolute
        />
      ))}
    </div>
  );
}

/* ------------------------------ split panes ----------------------------- */

function SplitPanes({
  left,
  right,
  split,
  allTabs,
}: {
  left: { id: string; url: string } | null;
  right: { id: string; url: string } | null;
  split: SplitState;
  allTabs: Array<{ tab: { id: string; url: string }; spaceId: string }>;
}) {
  const { setSplit } = useBrowser();
  const containerRef = useRef<HTMLDivElement>(null);

  const onDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const move = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const ratio = Math.min(
          0.8,
          Math.max(0.2, (ev.clientX - rect.left) / rect.width),
        );
        setSplit({ ...split, ratio });
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [split, setSplit],
  );

  const closeSplit = useCallback(() => setSplit(null), [setSplit]);

  return (
    <div ref={containerRef} className="flex h-full w-full">
      {/* Left and right guests fill their panes; every OTHER tab stays
          mounted but hidden so its guest survives. */}
      <div style={{ width: `${split.ratio * 100}%` }} className="h-full min-w-0">
        {left && (
          <TabWebview tabId={left.id} url={left.url} visible absolute={false} />
        )}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize split panes"
        onMouseDown={onDividerDown}
        className="flex w-2 shrink-0 cursor-col-resize items-center justify-center"
        style={{ background: "var(--nt-bg-base)" }}
        title="Drag to resize"
      >
        <span
          className="h-8 w-[3px] rounded-full"
          style={{ background: "var(--nt-border-strong)" }}
        />
      </div>

      <div className="h-full min-w-0 flex-1">
        {right && (
          <TabWebview tabId={right.id} url={right.url} visible absolute={false} />
        )}
      </div>

      {/* Hidden guests for every tab not in the split. */}
      {allTabs.map(
        ({ tab }) =>
          tab.id !== split.leftTabId &&
          tab.id !== split.rightTabId && (
            <TabWebview
              key={tab.id}
              tabId={tab.id}
              url={tab.url}
              visible={false}
              absolute={false}
            />
          ),
      )}

      <button
        onClick={closeSplit}
        title="Close split view"
        className="nt-r-sm absolute right-3 top-3 z-10 flex items-center gap-1.5 border px-2.5 py-1.5 text-[12px] shadow-lg"
        style={{
          background: "var(--nt-bg-overlay)",
          borderColor: "var(--nt-border)",
          color: "var(--nt-text-2)",
        }}
      >
        <X size={13} strokeWidth={1.75} /> Close split
      </button>
    </div>
  );
}

/* ------------------------------- one guest ------------------------------ */

function TabWebview({
  tabId,
  url,
  visible,
  absolute,
}: {
  tabId: string;
  url: string;
  visible: boolean;
  absolute: boolean;
}) {
  const src = srcFor(tabId, url);

  const ref = useCallback(
    (el: WebviewElement | null) => {
      if (el) attachWebview(el, tabId);
    },
    [tabId],
  );

  if (!visible) {
    // Kept mounted so the guest survives; hidden from layout.
    return (
      <webview
        ref={ref}
        src={src}
        partition="persist:nexttoken"
        allowpopups
        style={{ display: "none" }}
      />
    );
  }

  return (
    <webview
      ref={ref}
      src={src}
      partition="persist:nexttoken"
      allowpopups
      style={
        absolute
          ? {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              background: "var(--nt-bg-base)",
            }
          : {
              width: "100%",
              height: "100%",
              background: "var(--nt-bg-base)",
            }
      }
    />
  );
}
