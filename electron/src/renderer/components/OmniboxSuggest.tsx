/**
 * OmniboxSuggest — dropdown suggestions under the omnibox input.
 *
 * Mixes four sources, capped and fuzzy-matched:
 *   1. open tabs        (switch to tab)
 *   2. bookmarks        (open URL)
 *   3. history          (open URL)
 *   4. web suggestions  (search) — from the default engine's suggest API,
 *      debounced ~200ms, cancellable, only when the query isn't a URL.
 *
 * Keyboard (↑↓/Enter/Esc) is delegated from SmartInput via the imperative
 * api; the mouse uses onMouseDown so the input never blurs before a pick.
 * Rows follow the app's popover styling (warm charcoal, ember accents).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Clock, Search, Star } from "lucide-react";
import type { BookmarkState, HistoryEntry } from "../../shared/ipc";
import { domainOf, fuzzy, iconForUrl, looksLikeUrl, nt } from "../nt";
import {
  parseEngineKeyword,
  presetById,
  suggestUrl,
} from "../../shared/searchEngines";
import type { SmartTab } from "./SmartInput";

export type SuggestKind = "tab" | "bookmark" | "history" | "web";

export interface SuggestItem {
  kind: SuggestKind;
  key: string;
  title: string;
  /** tab / bookmark / history target */
  url: string;
  /** web suggestion query text */
  text: string;
  tabId?: string;
  /** engine the web suggestion came from */
  engineId?: string;
  spaceName?: string;
}

export interface OmniboxSuggestApi {
  move(dir: 1 | -1): void;
  /** Act on the highlighted row. Returns false when there is nothing to pick. */
  pick(): boolean;
  close(): void;
}

interface OmniboxSuggestProps {
  query: string;
  tabs: SmartTab[];
  bookmarks: BookmarkState[];
  /** True while SmartInput has an @ or / completion open — stay hidden. */
  suppressed: boolean;
  /** Default engine id (drives the suggest endpoint). */
  defaultEngineId: string;
  onOpenChange(open: boolean): void;
  onActivateTab(tabId: string): void;
  onOpenUrl(url: string): void;
  onSearch(text: string, engineId?: string): void;
}

const KIND_LABEL: Record<SuggestKind, string> = {
  tab: "Tab",
  bookmark: "Bookmark",
  history: "History",
  web: "Search",
};

/** Tolerant parser: OpenSearch [q,[s…]], DDG ac [{phrase}], or {suggestions:[…]}. */
function parseSuggestResponse(data: unknown): string[] {
  const str = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const p = (v as Record<string, unknown>).phrase;
      if (typeof p === "string") return p;
    }
    return "";
  };
  if (Array.isArray(data)) {
    if (data.length >= 2 && Array.isArray(data[1])) {
      return data[1].map(str).filter(Boolean);
    }
    return data.map(str).filter(Boolean);
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["suggestions", "results"]) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).map(str).filter(Boolean);
    }
  }
  return [];
}

function normUrl(u: string): string {
  return u.replace(/\/$/, "").toLowerCase();
}

export const OmniboxSuggest = forwardRef<OmniboxSuggestApi, OmniboxSuggestProps>(
  function OmniboxSuggest(props, ref) {
    const {
      query,
      tabs,
      bookmarks,
      suppressed,
      defaultEngineId,
      onOpenChange,
      onActivateTab,
      onOpenUrl,
      onSearch,
    } = props;

    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [web, setWeb] = useState<Array<{ text: string; engineId: string }>>([]);
    const [cursor, setCursor] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

    // History is loaded once per omnibox session (component mounts on focus).
    useEffect(() => {
      let alive = true;
      nt()
        .privacyHistory()
        .then((h) => {
          if (alive) setHistory(h);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, []);

    const q = query.trim();

    const localSections = useMemo(() => {
      if (!q || suppressed) return [];
      const seen = new Set<string>();
      const match = <T,>(
        list: T[],
        hay: (t: T) => string,
        toItem: (t: T) => SuggestItem,
        cap: number,
      ): SuggestItem[] =>
        list
          .map((t) => ({ t, score: fuzzy(q, hay(t)) ?? -Infinity }))
          .filter((x) => x.score > -Infinity)
          .sort((a, b) => b.score - a.score)
          .slice(0, cap)
          .map((x) => toItem(x.t))
          .filter((it) => {
            const n = normUrl(it.url);
            if (seen.has(n)) return false;
            seen.add(n);
            return true;
          });

      const tabItems = match(
        tabs,
        (t) => `${t.title} ${t.url}`,
        (t) => ({
          kind: "tab",
          key: `tab-${t.id}`,
          title: t.title || "New tab",
          url: t.url,
          text: "",
          tabId: t.id,
          spaceName: t.spaceName,
        }),
        4,
      );
      const bookmarkItems = match(
        bookmarks,
        (b) => `${b.name} ${b.url}`,
        (b) => ({
          kind: "bookmark",
          key: `bm-${b.id}`,
          title: b.name || b.url,
          url: b.url,
          text: "",
        }),
        3,
      );
      const historyItems = match(
        history,
        (h) => `${h.title} ${h.url}`,
        (h) => ({
          kind: "history",
          key: `h-${h.at}-${h.url}`,
          title: h.title || h.url,
          url: h.url,
          text: "",
        }),
        4,
      );
      return [
        { header: "Open tabs", items: tabItems },
        { header: "Bookmarks", items: bookmarkItems },
        { header: "History", items: historyItems },
      ].filter((s) => s.items.length > 0);
    }, [q, suppressed, tabs, bookmarks, history]);

    // Web suggestions: debounced ~200ms, cancellable, never for URLs.
    useEffect(() => {
      setWeb([]);
      if (!q || suppressed || looksLikeUrl(q)) return;
      const kw = parseEngineKeyword(q);
      const preset = kw ? kw.preset : presetById(defaultEngineId);
      const effQuery = kw ? kw.query : q;
      if (!preset || effQuery.length < 2) return;
      const url = suggestUrl(preset, effQuery);
      if (!url) return; // engine has no suggest API (e.g. Ecosia)
      const engineId = preset.id;
      const ctrl = new AbortController();
      const timer = window.setTimeout(async () => {
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          if (!res.ok) return;
          const data = await res.json();
          const list = parseSuggestResponse(data)
            .filter((s) => s.trim().length > 0)
            .slice(0, 6);
          setWeb(list.map((text) => ({ text, engineId })));
        } catch {
          /* aborted, offline, or CORS — local matches still work */
        }
      }, 200);
      return () => {
        window.clearTimeout(timer);
        ctrl.abort();
      };
    }, [q, suppressed, defaultEngineId]);

    const sections = useMemo(() => {
      const out = [...localSections];
      if (web.length > 0) {
        const preset = presetById(web[0].engineId);
        out.push({
          header: preset ? `Suggestions · ${preset.name}` : "Suggestions",
          items: web.map<SuggestItem>((w, i) => ({
            kind: "web",
            key: `web-${i}-${w.text}`,
            title: w.text,
            url: "",
            text: w.text,
            engineId: w.engineId,
          })),
        });
      }
      return out;
    }, [localSections, web]);

    const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
    const open = !suppressed && !dismissed && q.length > 0 && flat.length > 0;

    useEffect(() => {
      onOpenChangeRef.current(open);
    }, [open ]);

    // A new query re-arms the dropdown after an Esc dismissal.
    useEffect(() => {
      setDismissed(false);
    }, [q, suppressed ]);

    useEffect(() => {
      setCursor(0);
    }, [flat.length]);

    const act = (item: SuggestItem) => {
      if (item.kind === "tab" && item.tabId) onActivateTab(item.tabId);
      else if (item.kind === "web") onSearch(item.text, item.engineId);
      else if (item.url) onOpenUrl(item.url);
    };

    useImperativeHandle(
      ref,
      () => ({
        move(dir: 1 | -1) {
          if (flat.length === 0) return;
          setCursor((c) => (c + dir + flat.length) % flat.length);
        },
        pick() {
          const item = flat[cursor];
          if (!item) return false;
          act(item);
          return true;
        },
        close() {
          setDismissed(true);
          onOpenChangeRef.current(false);
        },
      }),
      [flat, cursor, onActivateTab, onOpenUrl, onSearch],
    );

    if (!open) return null;

    let rowIndex = -1;
    return (
      <div
        className="nt-popover nt-r-md absolute left-0 right-0 top-full z-50 mt-2 max-h-80 overflow-y-auto border p-1.5"
        style={{
          background: "var(--nt-bg-overlay)",
          borderColor: "var(--nt-border)",
          boxShadow: "var(--nt-shadow-pop)",
        }}
        role="listbox"
        aria-label="Address bar suggestions"
      >
        {sections.map((s) => (
          <div key={s.header}>
            <p className="nt-micro px-2.5 pb-1 pt-1.5">{s.header}</p>
            {s.items.map((item) => {
              rowIndex += 1;
              const active = rowIndex === cursor;
              const idx = rowIndex;
              const Icon =
                item.kind === "bookmark"
                  ? Star
                  : item.kind === "history"
                    ? Clock
                    : item.kind === "web"
                      ? Search
                      : iconForUrl(item.url);
              return (
                <button
                  key={item.key}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    act(item);
                  }}
                  onMouseMove={() => setCursor(idx)}
                  className={`nt-r-sm flex w-full items-center gap-2.5 px-2.5 py-2 text-left ${
                    active ? "nt-selected" : ""
                  }`}
                >
                  <Icon
                    size={15}
                    strokeWidth={1.75}
                    className="shrink-0"
                    style={{ color: "var(--nt-text-3)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px]"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {item.title}
                    </span>
                    {item.kind !== "web" && (
                      <span
                        className="nt-mono block truncate text-[11px]"
                        style={{ color: "var(--nt-text-3)" }}
                      >
                        {item.spaceName ? `${item.spaceName} · ` : ""}
                        {domainOf(item.url)}
                      </span>
                    )}
                  </span>
                  <span
                    className="nt-micro shrink-0"
                    style={{ color: "var(--nt-text-faint)" }}
                  >
                    {KIND_LABEL[item.kind]}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
);
