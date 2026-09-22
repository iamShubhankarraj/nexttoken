/**
 * HistoryPage — Settings → History (v0.6.3, impl-5).
 *
 * The full history manager: full-text search over the recorded history,
 * per-item delete, and clear-by-time-range (last hour / day / week / all).
 * Clearing asks for confirmation — it's destructive.
 */
import { useCallback, useEffect, useState } from "react";
import { Clock, Search, Trash2 } from "lucide-react";
import { nt, domainOf, iconForUrl } from "../nt";
import type { HistoryEntry } from "../../shared/ipc";

type Range = "hour" | "day" | "week" | "all";
const RANGES: Array<{ id: Range; label: string }> = [
  { id: "hour", label: "Last hour" },
  { id: "day", label: "Last 24 hours" },
  { id: "week", label: "Last 7 days" },
  { id: "all", label: "All time" },
];

function fmtTime(at: number): string {
  const d = new Date(at);
  const now = Date.now();
  const diff = now - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function HistoryPage() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [range, setRange] = useState<Range>("all");
  const [clearing, setClearing] = useState(false);

  const load = useCallback(
    (q: string) => {
      const p = q.trim()
        ? nt().historySearch(q.trim(), 300)
        : nt().historyList(300);
      p.then(setEntries).catch(() => {});
    },
    []
  );

  useEffect(() => {
    load("");
  }, [load]);

  useEffect(() => {
    const t = window.setTimeout(() => load(query), 250);
    return () => window.clearTimeout(t);
  }, [query, load]);

  const deleteOne = (e: HistoryEntry) => {
    void nt().historyDelete(e.at, e.url).then(() => load(query)).catch(() => {});
  };

  const clearRange = () => {
    const label = RANGES.find((r) => r.id === range)?.label ?? "history";
    if (!window.confirm(`Clear ${label.toLowerCase()} of browsing history? This can't be undone.`)) return;
    setClearing(true);
    void nt()
      .historyClearRange(range)
      .then(() => {
        setClearing(false);
        load(query);
      })
      .catch(() => setClearing(false));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            strokeWidth={2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--nt-text-3)" }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history"
            spellCheck={false}
            className="nt-r-sm w-full border py-1.5 pl-8 pr-3 text-[13px]"
            style={{
              borderColor: "var(--nt-border)",
              background: "var(--nt-bg-base)",
              color: "var(--nt-text-1)",
            }}
          />
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
          aria-label="Time range to clear"
          className="nt-r-sm shrink-0 border px-2 py-1.5 text-[12.5px]"
          style={{
            borderColor: "var(--nt-border)",
            background: "var(--nt-bg-base)",
            color: "var(--nt-text-1)",
          }}
        >
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={clearRange}
          disabled={clearing || entries.length === 0}
          className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-[12.5px] font-medium transition-opacity disabled:opacity-40"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          <Trash2 size={13} strokeWidth={1.75} />
          {clearing ? "Clearing…" : "Clear"}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="flex items-center gap-2 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          <Clock size={13} strokeWidth={1.75} />
          {query.trim() ? "No matches." : "No browsing history yet."}
        </p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const Icon = iconForUrl(e.url);
            return (
              <li
                key={`${e.at}-${e.url}`}
                className="nt-r-sm group flex items-center gap-2.5 border px-3 py-1.5"
                style={{ borderColor: "var(--nt-border)" }}
              >
                <Icon size={13} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--nt-text-3)" }} />
                <button
                  type="button"
                  onClick={() => void nt().navGo(e.url)}
                  title={e.url}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                    {e.title || domainOf(e.url)}
                  </span>
                  <span className="nt-mono block truncate text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                    {e.url}
                  </span>
                </button>
                <span className="shrink-0 text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                  {fmtTime(e.at)}
                </span>
                <button
                  type="button"
                  title="Delete this entry"
                  onClick={() => deleteOne(e)}
                  className="nt-r-sm shrink-0 p-1 opacity-0 transition-opacity hover:bg-[var(--nt-bg-hover)] group-hover:opacity-100"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {entries.length >= 300 && (
        <p className="text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
          Showing the first 300 matches — refine your search to narrow it down.
        </p>
      )}
    </div>
  );
}
