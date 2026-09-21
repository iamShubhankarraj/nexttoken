/**
 * Minimal windowed list: only the visible rows (+overscan) are mounted,
 * so the sidebar stays fast no matter how many tabs are open.
 */

import { useEffect, useRef, useState } from "react";

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  keyOf: (item: T) => string;
  renderRow: (item: T, index: number) => React.ReactNode;
}

export function VirtualList<T>({
  items,
  rowHeight,
  keyOf,
  renderRow,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const overscan = 3;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + viewportH) / rowHeight) + overscan,
  );

  const rows = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    rows.push(
      <div
        key={keyOf(item)}
        style={{
          position: "absolute",
          top: i * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
        }}
      >
        {renderRow(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="nt-tablist-scroll relative h-full overflow-y-auto"
    >
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        {rows}
      </div>
    </div>
  );
}
