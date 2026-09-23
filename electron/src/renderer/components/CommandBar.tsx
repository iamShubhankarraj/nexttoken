/**
 * Spotlight-style command bar (⌘K / Ctrl+K) on the new design system.
 *
 * Fuzzy-searches open tabs (all Bits), favorites, Bits, and actions.
 * Selection uses the ember accent wash (nt-selected). Popover motion:
 * fade + 4px rise, 150ms. Includes "Split view with…" (arms split-pick)
 * and "Close split view".
 */

import {
  Archive,
  Columns2,
  Compass,
  Globe,
  Keyboard,
  LayoutGrid,
  PanelLeft,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { BrowserSnapshot } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { domainOf, fuzzy, iconForUrl, nt } from "../nt";

interface Item {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  run: () => void;
}

const GROUP_ORDER = ["Go to", "Tabs", "Favorites", "Bits", "Actions"];

export function CommandBar({ onClose }: { onClose: () => void }) {
  const { snapshot, activeTab, split, setSplit, setSplitPick } = useBrowser();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    if (!snapshot) return [];
    const s: BrowserSnapshot = snapshot;
    const all: Array<{ item: Item; score: number }> = [];
    const push = (item: Item, hay: string) => {
      const score = fuzzy(query, hay);
      if (score !== null) all.push({ item, score });
    };
    const run = (fn: () => unknown) => () => {
      onClose();
      void fn();
    };
    const api = nt();

    // Tabs across every Bit.
    for (const space of s.spaces) {
      for (const t of space.tabs) {
        const Icon = iconForUrl(t.url);
        push(
          {
            id: `tab-${t.id}`,
            group: "Tabs",
            title: t.title || "New tab",
            subtitle: `${space.name} · ${domainOf(t.url)}${t.pinned ? " · App Store" : ""}`,
            icon: Icon,
            run: run(async () => {
              if (space.id !== s.activeSpaceId) await api.spacesSwitch(space.id);
              await api.tabsActivate(t.id);
            }),
          },
          `${t.title} ${t.url} ${space.name}`,
        );
      }
    }

    // Favorites across every Bit.
    for (const space of s.spaces) {
      for (const f of space.favorites) {
        push(
          {
            id: `fav-${f.id}`,
            group: "Favorites",
            title: f.name,
            subtitle: `${space.name} · ${domainOf(f.url)}`,
            icon: Star,
            run: run(() => api.tabsCreate({ url: f.url })),
          },
          `${f.name} ${f.url} favorite`,
        );
      }
    }

    // Bits.
    s.spaces.forEach((space, i) => {
      push(
        {
          id: `space-${space.id}`,
          group: "Bits",
          title: `Switch to ${space.name}`,
          subtitle: `Ctrl/⌘+${i + 1} · ${space.tabs.length} tabs`,
          icon: LayoutGrid,
          run: run(() => api.spacesSwitch(space.id)),
        },
        `${space.name} Bit switch`,
      );
    });

    // Actions.
    const actions: Array<[string, string, LucideIcon, () => unknown]> = [
      ["New tab", "Open a fresh tab", Plus, () => api.tabsCreate({})],
      [
        "Close active tab",
        activeTab ? activeTab.title || "Close the current tab" : "No active tab",
        X,
        () => activeTab && api.tabsClose(activeTab.id),
      ],
      [
        "Archive active tab",
        "Sweep the current tab into the archive",
        Archive,
        () => activeTab && api.tabsArchive(activeTab.id),
      ],
      [
        "Reload page",
        "Reload the active tab",
        RotateCw,
        () => activeTab && api.navReload(),
      ],
      [
        split ? "Close split view" : "Split view with…",
        split
          ? "Return to a single pane"
          : "Pick a second tab to tile side-by-side",
        Columns2,
        () => {
          if (split) setSplit(null);
          else setSplitPick(true);
        },
      ],
      [
        "Toggle sidebar",
        "Show or hide the sidebar",
        PanelLeft,
        () => api.uiSetSidebarCollapsed(!s.sidebarCollapsed),
      ],
      [
        "Toggle agent panel",
        "Show or hide the AI agent panel",
        Sparkles,
        () => api.uiSetAgentPanelOpen(!s.agentPanelOpen),
      ],
      [
        "Open settings",
        "Providers, voice, search, themes",
        Settings,
        () => api.uiSetSettingsOpen(true),
      ],
      [
        "Keyboard shortcuts",
        "Every shortcut in one place",
        Keyboard,
        () => window.dispatchEvent(new CustomEvent("nt:open-shortcuts")),
      ],
      [
        "New Bit",
        "Create a new Bit",
        LayoutGrid,
        () => {
          const name = window.prompt("Bit name:");
          if (name?.trim()) return api.spacesCreate(name.trim());
        },
      ],
    ];
    for (const [title, subtitle, icon, fn] of actions) {
      push(
        { id: `act-${title}`, group: "Actions", title, subtitle, icon, run: run(fn) },
        title,
      );
    }

    // URL-ish input → direct navigation shortcut.
    const q = query.trim();
    if (q && q.includes(".") && !q.includes(" ")) {
      const display = q.startsWith("http") ? q : `https://${q}`;
      all.unshift({
        item: {
          id: "go-url",
          group: "Go to",
          title: display,
          subtitle: "Open this address",
          icon: Globe,
          run: run(() => api.navGo(q)),
        },
        score: Infinity,
      });
    }

    return all
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item)
      .sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
      )
      .slice(0, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, snapshot, activeTab, split, onClose, setSplit, setSplitPick]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (cursor >= items.length) setCursor(0);
  }, [items.length, cursor]);

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
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div
      className="nt-fade-in fixed inset-0 z-50 flex justify-center bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="nt-popover nt-r-lg mt-[14vh] h-fit w-full max-w-xl overflow-hidden border"
        style={{
          borderColor: "var(--nt-border)",
          background: "var(--nt-bg-overlay)",
          boxShadow: "var(--nt-shadow-overlay)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-3 border-b px-4"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <Compass size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search tabs, favorites, Bits, actions…"
            spellCheck={false}
            className="w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-[var(--nt-text-3)]"
            style={{ color: "var(--nt-text-1)" }}
          />
          <kbd
            className="nt-r-sm border px-1.5 py-0.5 text-[10px]"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-3)" }}
          >
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <p
              className="px-3 py-6 text-center text-[13px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              No matches. Try a URL, a tab title, or an action like “split”.
            </p>
          )}
          {items.map((item, i) => {
            const header =
              item.group !== lastGroup ? (
                <p key={`h-${item.group}`} className="nt-micro px-3 pb-1 pt-2.5">
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
                  className={`nt-r-sm flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === cursor ? "nt-selected" : ""
                  }`}
                >
                  <Icon
                    size={16}
                    strokeWidth={1.75}
                    className="shrink-0"
                    style={{
                      color:
                        i === cursor ? "var(--nt-accent)" : "var(--nt-text-3)",
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px]"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {item.title}
                    </span>
                    <span
                      className="block truncate text-[12px]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      {item.subtitle}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="flex items-center gap-4 border-t px-4 py-2 text-[11px]"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-3)" }}
        >
          <span>
            <kbd className="nt-r-sm mr-1 bg-[var(--nt-bg-hover)] px-1">↑↓</kbd>navigate
          </span>
          <span>
            <kbd className="nt-r-sm mr-1 bg-[var(--nt-bg-hover)] px-1">↵</kbd>open
          </span>
          <span className="nt-num ml-auto">
            {items.length} result{items.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}
