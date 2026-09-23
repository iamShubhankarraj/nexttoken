/**
 * AppStore — the sidebar's App Store. Pinned tabs live HERE.
 *
 * A self-contained, bordered box ABOVE the tab list:
 *
 *  - FIXED and outside the scroll container, so browsing tabs never moves it.
 *  - Owns its horizontal gesture (`data-nt-bit-scroll-exclude`): hover the
 *    box and slide/shift-scroll to page through saved apps — never switches
 *    Bits, never fights the sidebar's own gestures.
 *  - Resizable: drag the bottom edge, or use the − / + buttons. Height is
 *    persisted (snapshot.appStoreHeight) so the box keeps its size.
 *  - Tiles show real favicons (cached data URL, else Google s2 via main).
 *
 * Right-click a tab → "Add to App Store" (or the hover pin button) adds the
 * site here. The grid is global — the same apps in every Bit.
 */
import { Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PinnedApp } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { domainOf, nt } from "../nt";
import { Favicon } from "./Favicon";

/** Tiles per row. 4 keeps a ~34px tile and its label legible at rest width. */
const COLS = 4;
/** Default body height when no explicit size is stored (2 rows). */
const DEFAULT_H = 148;
const MIN_H = 96;
const MAX_H = 480;
/** Approximate row pitch used to derive tiles-per-page from height. */
const ROW_H = 56;
/** Accumulated horizontal delta (px) that turns one page. */
const PAGE_COMMIT_PX = 60;
/** Lockout so one flick cannot page more than once. */
const PAGE_COOLDOWN_MS = 420;

/** Same-site comparison for focusing an already-open tab. */
function sameSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "");
  } catch {
    return a === b;
  }
}

function clampH(h: number): number {
  return Math.min(MAX_H, Math.max(MIN_H, Math.round(h)));
}

export function AppStore() {
  const { snapshot, activeSpace, activeTab } = useBrowser();
  const apps: PinnedApp[] = snapshot?.pinnedApps ?? [];

  const [page, setPage] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Live height while dragging; null = follow snapshot. */
  const [dragH, setDragH] = useState<number | null>(null);

  const storedH = snapshot?.appStoreHeight ?? DEFAULT_H;
  const height = dragH ?? clampH(storedH);

  // Rows visible at this height → how many tiles fit one page.
  const rows = Math.max(1, Math.floor((height - 36) / ROW_H));
  const perPage = COLS * Math.max(1, rows);
  const pageCount = Math.max(1, Math.ceil(apps.length / perPage));
  const current = Math.min(page, pageCount - 1);

  const pages = useMemo(() => {
    const out: PinnedApp[][] = [];
    for (let i = 0; i < apps.length; i += perPage) {
      out.push(apps.slice(i, i + perPage));
    }
    return out.length ? out : [[]];
  }, [apps, perPage]);

  // Horizontal gesture turns pages. Registered here (not via React's onWheel,
  // which is passive and so cannot preventDefault) and only when there is more
  // than one page to turn.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || pageCount < 2) return;
    let acc = 0;
    let lastAt = 0;
    let cooldownUntil = 0;
    const onWheel = (e: WheelEvent) => {
      // Shift+wheel is how a mouse reports a horizontal scroll.
      const shift = e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const dx = shift ? e.deltaY : e.deltaX;
      const dy = shift ? 0 : e.deltaY;
      // Let vertical scrolling through untouched.
      if (Math.abs(dx) <= Math.abs(dy)) {
        acc = 0;
        return;
      }
      const now = performance.now();
      if (now - lastAt > 180) acc = 0;
      lastAt = now;
      acc += dx;
      if (Math.abs(acc) < PAGE_COMMIT_PX) return;
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      // Consume it: this gesture belongs to the grid, not to Bit switching and
      // not to macOS's history swipe.
      e.preventDefault();
      if (now < cooldownUntil) return;
      cooldownUntil = now + PAGE_COOLDOWN_MS;
      setPage((p) => Math.min(pageCount - 1, Math.max(0, Math.min(p, pageCount - 1) + dir)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pageCount]);

  const persistH = (h: number) => {
    const c = clampH(h);
    setDragH(null);
    void nt().uiSetAppStoreHeight(c);
  };

  const nudge = (delta: number) => {
    persistH(height + delta);
  };

  // Drag the bottom edge to resize. Pointer-capture style: listeners on
  // window for the duration of the drag so leaving the box mid-drag still tracks.
  const onResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      setDragH(clampH(startH + (ev.clientY - startY)));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      persistH(startH + (ev.clientY - startY));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const openApp = (url: string) => {
    // Focus an existing tab for this site in the CURRENT Bit, else open one.
    const existing = activeSpace?.tabs.find((t) => sameSite(t.url, url));
    if (existing) void nt().tabsActivate(existing.id);
    else void nt().tabsCreate({ url });
  };

  const addCurrent = () => {
    if (!activeTab) return;
    void nt().pinnedAppsAdd(
      activeTab.url,
      activeTab.title?.trim() || domainOf(activeTab.url),
    );
    if (!activeTab.pinned) void nt().tabsPin(activeTab.id, true);
  };

  return (
    <div className="nt-appstore-wrap">
      <div
        ref={rootRef}
        className="nt-appstore"
        style={{ height }}
        /* Owns horizontal gestures: paging the grid must not switch Bits. */
        data-nt-bit-scroll-exclude=""
      >
        <div className="nt-appstore-head">
          <span className="nt-micro">App Store</span>
          <span className="ml-auto flex items-center gap-0.5">
            {pageCount > 1 && (
              <span className="nt-appstore-dots" role="tablist" aria-label="App Store pages">
                {Array.from({ length: pageCount }, (_, i) => (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={i === current}
                    aria-label={`Page ${i + 1} of ${pageCount}`}
                    onClick={() => setPage(i)}
                    className="nt-appstore-dot"
                    data-on={i === current ? "true" : "false"}
                  />
                ))}
              </span>
            )}
            <button
              title="Make the App Store smaller"
              onClick={() => nudge(-ROW_H)}
              disabled={height <= MIN_H}
              className="nt-r-sm p-0.5 transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30"
              style={{ color: "var(--nt-text-3)" }}
              aria-label="Decrease App Store size"
            >
              <Minus size={12} strokeWidth={2} />
            </button>
            <button
              title="Make the App Store larger"
              onClick={() => nudge(ROW_H)}
              disabled={height >= MAX_H}
              className="nt-r-sm p-0.5 transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30"
              style={{ color: "var(--nt-text-3)" }}
              aria-label="Increase App Store size"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
            <button
              title={
                activeTab
                  ? `Add this page to the App Store\n${activeTab.title || activeTab.url}`
                  : "Open a page first, then add it"
              }
              onClick={addCurrent}
              disabled={!activeTab}
              className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30"
              style={{ color: "var(--nt-text-3)" }}
            >
              <Plus size={14} strokeWidth={1.75} />
            </button>
          </span>
        </div>

        {/* The pager: one full-width page at a time, sliding between them. */}
        <div className="nt-appstore-viewport">
          <div
            className="nt-appstore-track"
            style={{ transform: `translate3d(${-current * 100}%, 0, 0)` }}
          >
            {pages.map((tiles, pi) => {
              // Page-turn. Pages rotate away from the viewer around the edge
              // they are hinged on — the outgoing page hinges left, the incoming
              // one right — so the track reads as a book rather than a flat
              // carousel. `opacity` is graded by distance so a neighbour stays
              // faintly visible mid-turn instead of the view blanking out.
              const dist = Math.abs(pi - current);
              return (
              <div
                key={pi}
                className="nt-appstore-page"
                aria-hidden={pi !== current}
                style={{
                  /* Offscreen pages must not be clickable. */
                  pointerEvents: pi === current ? "auto" : "none",
                  transform: `rotateY(${(pi - current) * -26}deg) scale(${
                    pi === current ? 1 : 0.9
                  })`,
                  opacity: dist === 0 ? 1 : dist === 1 ? 0.5 : 0,
                  transformOrigin:
                    pi < current ? "left center" : "right center",
                  gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                }}
              >
                {tiles.map((app) => (
                  <button
                    key={app.id}
                    className="nt-appstore-tile"
                    title={`${app.title}\n${app.url}\n\nRight-click to remove from the App Store`}
                    onClick={() => openApp(app.url)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void nt().pinnedAppsRemove(app.id);
                    }}
                  >
                    <span className="nt-appstore-icon">
                      <Favicon url={app.url} favicon={app.favicon} size={17} />
                    </span>
                    <span className="nt-appstore-label">
                      {app.title?.trim() || domainOf(app.url)}
                    </span>
                  </button>
                ))}
                {tiles.length === 0 && (
                  <p className="nt-appstore-empty">
                    No apps yet. Open a page and hit + (or right-click a tab →
                    Add to App Store) to keep it here in every Bit.
                  </p>
                )}
              </div>
              );
            })}
          </div>
        </div>

        {/* Drag the bottom edge to resize the box. */}
        <div
          className="nt-appstore-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize App Store"
          title="Drag to resize the App Store"
          onPointerDown={onResizePointerDown}
          onDoubleClick={(e) => {
            e.preventDefault();
            persistH(DEFAULT_H);
          }}
        />
      </div>
    </div>
  );
}

/** Small badge used elsewhere to hint that a tab is in the App Store grid. */
export function AppStoreRemoveHint({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      className="nt-r-sm p-0.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
      title="Remove from the App Store"
      onClick={onRemove}
      style={{ color: "var(--nt-text-3)" }}
    >
      <X size={12} strokeWidth={2} />
    </button>
  );
}
