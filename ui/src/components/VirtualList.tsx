/**
 * Minimal fixed-row-height virtual list.
 *
 * Only the visible window (plus overscan) is mounted, so tab rows stay
 * cheap even with hundreds of open tabs — the same technique the product
 * shell will use for its sidebar (Vivaldi's many-tab sluggishness is the
 * failure mode this guards against). Rows are absolutely positioned inside
 * a tall spacer so native scrolling behaves normally.
 */

import { useEffect, useRef, useState } from "react";

interface Props<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  renderRow: (item: T, index: number) => React.ReactNode;
  keyOf: (item: T) => string;
}

export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 4,
  renderRow,
  keyOf,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.min(
    items.length,
    Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan,
  );

  return (
    <div ref={ref} className="h-full overflow-y-auto overscroll-contain">
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        {items.slice(start, end).map((item, i) => (
          <div
            key={keyOf(item)}
            style={{
              position: "absolute",
              top: (start + i) * rowHeight,
              left: 0,
              right: 0,
              height: rowHeight,
            }}
          >
            {renderRow(item, start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}
