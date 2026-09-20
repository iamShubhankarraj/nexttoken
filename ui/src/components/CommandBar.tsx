/**
 * Spotlight-style command bar (⌘K / ⌘T).
 *
 * Fuzzy-searches open tabs, bookmarks, history, spaces, and actions in one
 * input. Fully keyboard navigable. In the product this same component will
 * query the bridge instead of the in-memory store — the item contract
 * (group, title, subtitle, icon, run) stays identical.
 */

import {
  Archive,
  Bookmark as BookmarkIcon,
  Clock,
  Columns2,
  Compass,
  Globe,
  LayoutGrid,
  PanelLeft,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { iconForUrl } from "../data";
import { domainOf, orderedTabs, useStore } from "../store";

interface Item {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  run: () => void;
}

/** Subsequence fuzzy match; higher = better. Null = no match. */
function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let last = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    if (idx === last + 1) score += 2; // consecutive streak bonus
    if (idx === 0 || /[\s/\-_.]/.test(t[idx - 1] ?? "")) score += 3; // word-start bonus
    score += 1;
    last = idx;
    ti = idx + 1;
  }
  return score - t.length * 0.01; // slight preference for shorter strings
}

export function CommandBar() {
  const { state, dispatch, space } = useStore();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: "SET_COMMAND_BAR", open: false });

  const items = useMemo<Item[]>(() => {
    const all: Array<{ item: Item; score: number }> = [];
    const push = (item: Item, hay: string) => {
      const s = fuzzy(query, hay);
      if (s !== null) all.push({ item, score: s });
    };
    const run = (fn: () => void) => () => {
      fn();
      close();
    };

    // Open tabs (current space)
    for (const t of orderedTabs(space)) {
      const Icon = iconForUrl(t.url);
      push(
        {
          id: `tab-${t.id}`,
          group: "Tabs",
          title: t.title,
          subtitle: `${domainOf(t.url)}${t.pinned ? " · pinned" : ""}`,
          icon: Icon,
          run: run(() => dispatch({ type: "ACTIVATE_TAB", tabId: t.id })),
        },
        `${t.title} ${t.url}`,
      );
    }
    // Bookmarks
    for (const b of state.bookmarks) {
      push(
        {
          id: `bm-${b.id}`,
          group: "Bookmarks",
          title: b.title,
          subtitle: domainOf(b.url),
          icon: BookmarkIcon,
          run: run(() => dispatch({ type: "OPEN_URL", url: b.url, title: b.title })),
        },
        `${b.title} ${b.url}`,
      );
    }
    // History
    for (const h of state.history.slice(0, 12)) {
      const Icon = iconForUrl(h.url);
      push(
        {
          id: `hist-${h.id}`,
          group: "History",
          title: h.title,
          subtitle: domainOf(h.url),
          icon: Icon,
          run: run(() => dispatch({ type: "OPEN_URL", url: h.url, title: h.title })),
        },
        `${h.title} ${h.url}`,
      );
    }
    // Spaces
    state.spaces.forEach((s, i) => {
      push(
        {
          id: `space-${s.id}`,
          group: "Spaces",
          title: `Switch to ${s.name}`,
          subtitle: `Ctrl+${i + 1}`,
          icon: s.icon,
          run: run(() => dispatch({ type: "SWITCH_SPACE", spaceId: s.id })),
        },
        `${s.name} space switch`,
      );
    });
    // Actions
    const actions: Array<[string, string, LucideIcon, () => void]> = [
      ["New tab", "Open a fresh tab", Plus, () => dispatch({ type: "NEW_TAB" })],
      ["Split view…", "Pick a second tab to tile side-by-side", Columns2, () =>
        dispatch({ type: "SET_SPLIT_PICK", picking: true })],
      ["Toggle sidebar", "Show or hide the sidebar", PanelLeft, () => dispatch({ type: "TOGGLE_SIDEBAR" })],
      ["Toggle copilot", "Show or hide the AI copilot", Sparkles, () => dispatch({ type: "TOGGLE_COPILOT" })],
      ["Close current tab", "Close the active tab", X, () =>
        state.activeTabId && dispatch({ type: "CLOSE_TAB", tabId: state.activeTabId })],
      ["Archive idle tabs", "Sweep idle tabs into the archive now", Archive, () =>
        dispatch({ type: "ARCHIVE_ALL_IDLE" })],
      ["Open start page", "Go to the Next Token start page", Compass, () =>
        dispatch({ type: "OPEN_URL", url: "nexttoken://start" })],
    ];
    for (const [title, subtitle, icon, fn] of actions) {
      push({ id: `act-${title}`, group: "Actions", title, subtitle, icon, run: run(fn) }, title);
    }

    // URL-ish input → direct navigation shortcut
    const q = query.trim();
    if (q && q.includes(".") && !q.includes(" ")) {
      const url = q.startsWith("http") ? q : `https://${q}`;
      all.unshift({
        item: {
          id: "go-url",
          group: "Go to",
          title: url,
          subtitle: "Open this address",
          icon: Globe,
          run: run(() => dispatch({ type: "OPEN_URL", url })),
        },
        score: Infinity,
      });
    }

    const groupOrder = ["Go to", "Tabs", "Actions", "Spaces", "Bookmarks", "History"];
    return all
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item)
      .sort(
        (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
      )
      .slice(0, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, space, state.bookmarks, state.history, state.spaces, state.activeTabId]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (cursor >= items.length) setCursor(0);
  }, [items.length, cursor]);

  // Keep the cursor visible while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % Math.max(items.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + items.length) % Math.max(items.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[cursor]?.run();
    } else if (e.key === "Escape") {
      close();
    }
  };

  let lastGroup = "";
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 backdrop-blur-[2px] nt-fade-in"
      onMouseDown={close}
    >
      <div
        className="nt-pop-in mt-[14vh] h-fit w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#121218]/95 shadow-2xl shadow-black/60"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4">
          <Compass size={17} className="text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search tabs, bookmarks, history, actions…"
            className="w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-white/30"
          />
          <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-white/35">
              No matches. Try a URL, a tab title, or an action like “split”.
            </p>
          )}
          {items.map((item, i) => {
            const header =
              item.group !== lastGroup ? (
                <p
                  key={`h-${item.group}`}
                  className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-widest text-white/30"
                >
                  {item.group}
                </p>
              ) : null;
            lastGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {header}
                <button
                  data-idx={i}
                  onClick={item.run}
                  onMouseMove={() => setCursor(i)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    i === cursor ? "bg-white/[0.08]" : ""
                  }`}
                >
                  <Icon size={16} className="shrink-0 text-white/45" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white/85">{item.title}</span>
                    <span className="block truncate text-xs text-white/35">{item.subtitle}</span>
                  </span>
                  {item.group === "Spaces" && <LayoutGrid size={13} className="text-white/25" />}
                  {item.group === "History" && <Clock size={13} className="text-white/25" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-white/[0.07] px-4 py-2 text-[11px] text-white/30">
          <span><kbd className="mr-1 rounded bg-white/5 px-1">↑↓</kbd>navigate</span>
          <span><kbd className="mr-1 rounded bg-white/5 px-1">↵</kbd>open</span>
          <span className="ml-auto">{items.length} result{items.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}
