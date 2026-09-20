/**
 * Arc-style sidebar on the new design system (research §4–§5):
 * warm-charcoal layered surfaces, 2px space-color top-edge wash,
 * space identity tinting only the active-tab bar / space icon / wash.
 *
 * Sections: space switcher, favorites dock, pinned tabs, tabs of the
 * active space (virtualized, memoized rows, CSS-only loading shimmer —
 * never a whole-sidebar re-render), auto-archive section with restore.
 * Right-click a tab for the context menu (Archive now / pin / close).
 * Every action goes through window.nt — no mock state.
 */

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sparkles,
  Star,
  X,
  PanelLeftClose,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ArchivedTab, SpaceState, TabState } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { domainOf, iconForUrl, nt } from "../nt";
import { VirtualList } from "./VirtualList";

const ROW_H = 36;
const MAX_LIST_H = 440;

export function Sidebar() {
  const { snapshot, activeSpace } = useBrowser();
  if (!snapshot || !activeSpace) return null;

  const pinned = activeSpace.tabs.filter((t) => t.pinned);
  const tabs = activeSpace.tabs.filter((t) => !t.pinned);

  return (
    <aside
      className="flex h-full w-[248px] shrink-0 flex-col border-r"
      style={{ background: "var(--nt-bg-subtle)", borderColor: "var(--nt-border)" }}
    >
      {/* 2px space-identity wash on the top edge */}
      <div className="nt-space-wash shrink-0" />

      <SpaceSwitcher
        spaces={snapshot.spaces}
        activeId={activeSpace.id}
        activeName={activeSpace.name}
      />

      <FavoritesDock space={activeSpace} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pinned.length > 0 && (
          <section className="mt-2">
            <SectionLabel label="Pinned" />
            <div className="space-y-1">
              {pinned.map((t, i) => (
                <TabRow
                  key={t.id}
                  tab={t}
                  index={i}
                  active={t.id === activeSpace.activeTabId}
                />
              ))}
            </div>
          </section>
        )}

        <section className="mt-3">
          <div className="flex items-center">
            <SectionLabel label="Tabs" />
            <span
              className="nt-num ml-1 text-[11px]"
              style={{ color: "var(--nt-text-faint)" }}
            >
              {tabs.length}
            </span>
            <button
              title="New tab (⌘T)"
              onClick={() => void nt().tabsCreate({})}
              className="nt-r-sm ml-auto p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ color: "var(--nt-text-3)" }}
            >
              <Plus size={14} strokeWidth={1.75} />
            </button>
          </div>
          {tabs.length === 0 ? (
            <p className="px-2.5 py-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              No tabs here yet. Open one with ⌘T.
            </p>
          ) : (
            <div style={{ height: Math.min(tabs.length * ROW_H, MAX_LIST_H) }}>
              <VirtualList
                items={tabs}
                rowHeight={ROW_H}
                keyOf={(t) => t.id}
                renderRow={(t, i) => (
                  <TabRow
                    tab={t}
                    index={i}
                    active={t.id === activeSpace.activeTabId}
                  />
                )}
              />
            </div>
          )}
        </section>

        <ArchiveSection />
      </div>

      <button
        onClick={() => void nt().tabsCreate({})}
        className="nt-r-sm mx-2 mb-2 flex items-center justify-center gap-1.5 border py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
      >
        <Plus size={14} strokeWidth={1.75} /> New tab
      </button>

      <SidebarFooter />
    </aside>
  );
}

/* ---------------------------- space switcher ---------------------------- */

function SpaceSwitcher({
  spaces,
  activeId,
  activeName,
}: {
  spaces: SpaceState[];
  activeId: string;
  activeName: string;
}) {
  return (
    <div className="flex items-center gap-1 px-3 pb-2 pt-3">
      {spaces.map((s, i) => {
        const active = s.id === activeId;
        const initial = (s.name.trim()[0] ?? "·").toUpperCase();
        return (
          <button
            key={s.id}
            title={`${s.name} (Ctrl/⌘+${i + 1})`}
            onClick={() => void nt().spacesSwitch(s.id)}
            className="nt-r-sm flex h-8 w-8 shrink-0 items-center justify-center transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={
              active
                ? {
                    background:
                      "color-mix(in srgb, var(--nt-space) 16%, transparent)",
                  }
                : undefined
            }
          >
            {/* Space identity: the active space's icon is tinted --nt-space. */}
            <span
              className="text-[12px] font-semibold"
              style={{
                color: active ? "var(--nt-space)" : "var(--nt-text-3)",
              }}
            >
              {initial}
            </span>
          </button>
        );
      })}
      <span
        className="ml-1.5 truncate text-[13px] font-medium"
        style={{ color: "var(--nt-text-1)" }}
      >
        {activeName}
      </span>
    </div>
  );
}

/* ----------------------------- favorites dock ---------------------------- */

function FavoritesDock({ space }: { space: SpaceState }) {
  const { activeTab } = useBrowser();

  const addCurrent = () => {
    if (!activeTab) return;
    void nt().spacesAddFavorite(
      space.id,
      activeTab.title || domainOf(activeTab.url),
      activeTab.url,
    );
  };

  return (
    <div className="px-3 pb-1">
      <div
        className="nt-r-md flex flex-wrap gap-1 border p-1.5"
        style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
      >
        {space.favorites.map((f) => {
          const Icon = iconForUrl(f.url);
          return (
            <button
              key={f.id}
              title={`${f.name}\n${f.url} — right-click to remove`}
              onClick={() => void nt().tabsCreate({ url: f.url })}
              onContextMenu={(e) => {
                e.preventDefault();
                void nt().spacesRemoveFavorite(space.id, f.id);
              }}
              className="nt-r-sm group relative flex h-8 w-8 items-center justify-center transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ color: "var(--nt-text-2)" }}
            >
              <Icon size={16} strokeWidth={1.75} />
            </button>
          );
        })}
        <button
          title={
            activeTab
              ? `Add current page to favorites\n${activeTab.title}`
              : "Open a tab first, then add it as a favorite"
          }
          onClick={addCurrent}
          disabled={!activeTab}
          className="nt-r-sm flex h-8 w-8 items-center justify-center transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-30"
          style={{ color: "var(--nt-text-3)" }}
        >
          <Star size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------- tab context menu ----------------------------- */

interface MenuState {
  x: number;
  y: number;
  tab: TabState;
}

function TabContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const itemCls =
    "nt-r-sm flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--nt-bg-hover)]";

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div
      ref={ref}
      className="nt-popover nt-r-md fixed z-[70] w-52 border p-1.5 shadow-xl"
      style={{
        left: Math.min(menu.x, window.innerWidth - 220),
        top: Math.min(menu.y, window.innerHeight - 180),
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
      }}
      role="menu"
    >
      <button
        className={itemCls}
        style={{ color: "var(--nt-text-1)" }}
        onClick={act(() => void nt().tabsArchive(menu.tab.id))}
        role="menuitem"
      >
        <Archive size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        Archive now
      </button>
      <button
        className={itemCls}
        style={{ color: "var(--nt-text-1)" }}
        onClick={act(() => void nt().tabsPin(menu.tab.id, !menu.tab.pinned))}
        role="menuitem"
      >
        {menu.tab.pinned ? (
          <PinOff size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <Pin size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        {menu.tab.pinned ? "Unpin" : "Pin"}
      </button>
      <button
        className={itemCls}
        style={{ color: "var(--nt-text-1)" }}
        onClick={act(() => void nt().tabsClose(menu.tab.id))}
        role="menuitem"
      >
        <X size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        Close tab
      </button>
    </div>
  );
}

/* -------------------------------- tab rows ------------------------------- */

interface RowProps {
  tab: TabState;
  active: boolean;
  index: number;
}

/**
 * Memoized so a title/loading change on one tab never re-renders the rest
 * of the list (anti-Vivaldi rule). The loading shimmer is pure CSS — it
 * animates without any React state or parent repaints.
 */
const TabRow = memo(function TabRow({ tab, active, index }: RowProps) {
  const { activeSpace, splitPick, setSplitPick, setSplit, split } = useBrowser();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const Icon = iconForUrl(tab.url);

  const onClick = useCallback(() => {
    if (splitPick) {
      // "Split view with…" — this tab becomes the split partner.
      const left = split?.leftTabId ?? activeSpace?.activeTabId ?? tab.id;
      if (left !== tab.id) {
        setSplit({ leftTabId: left, rightTabId: tab.id, ratio: 0.5 });
      }
      setSplitPick(false);
      return;
    }
    void nt().tabsActivate(tab.id);
  }, [splitPick, split, activeSpace, tab.id, setSplit, setSplitPick]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, tab });
    },
    [tab],
  );

  return (
    <>
      <div
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={`${tab.title || "New tab"}\n${tab.url}`}
        style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
        className={`nt-stagger nt-r-sm group relative flex h-9 cursor-pointer items-center gap-2.5 px-2.5 transition-colors ${
          active ? "nt-active-tab" : "hover:bg-[var(--nt-bg-hover)]"
        } ${splitPick ? "hover:outline hover:outline-1 hover:outline-[var(--nt-accent)]" : ""}`}
      >
        {tab.loading ? (
          <span className="nt-shimmer" title="Loading" />
        ) : (
          <Icon
            size={16}
            strokeWidth={1.75}
            className="shrink-0"
            style={{ color: "var(--nt-text-3)" }}
          />
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <p
            className="truncate text-[13px] font-medium"
            style={{ color: "var(--nt-text-1)" }}
          >
            {tab.title || "New tab"}
          </p>
          <p
            className="nt-mono truncate text-[11px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            {tab.loading ? "Loading…" : domainOf(tab.url)}
          </p>
        </div>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            title={tab.pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              void nt().tabsPin(tab.id, !tab.pinned);
            }}
            className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            {tab.pinned ? (
              <PinOff size={13} strokeWidth={1.75} />
            ) : (
              <Pin size={13} strokeWidth={1.75} />
            )}
          </button>
          <button
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              void nt().tabsClose(tab.id);
            }}
            className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </span>
      </div>
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
});

/* ------------------------------ auto-archive ----------------------------- */

function ArchiveSection() {
  const { snapshot } = useBrowser();
  const [open, setOpen] = useState(false);
  const archived: ArchivedTab[] = snapshot?.archived ?? [];

  return (
    <section className="mt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="nt-r-sm flex w-full items-center gap-1.5 px-1 py-1 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
      >
        {open ? (
          <ChevronDown size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <ChevronRight size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        <Archive size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        <span className="nt-micro">Archive</span>
        <span
          className="nt-num ml-auto pr-1 text-[11px]"
          style={{ color: "var(--nt-text-faint)" }}
        >
          {archived.length}
        </span>
      </button>
      {open && (
        <div className="nt-fade-in mt-1 space-y-1">
          {archived.length === 0 && (
            <p className="px-2.5 py-2 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              Nothing archived yet. Idle tabs sweep here automatically.
            </p>
          )}
          {archived.map((a) => {
            const Icon = iconForUrl(a.url);
            return (
              <div
                key={a.id}
                className="nt-r-sm group flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
              >
                <Icon
                  size={14}
                  strokeWidth={1.75}
                  className="shrink-0"
                  style={{ color: "var(--nt-text-3)" }}
                />
                <div className="min-w-0 flex-1 leading-tight">
                  <p
                    className="truncate text-[12px]"
                    style={{ color: "var(--nt-text-2)" }}
                  >
                    {a.title || "Untitled"}
                  </p>
                  <p
                    className="truncate text-[10px]"
                    style={{ color: "var(--nt-text-faint)" }}
                  >
                    {a.spaceName} ·{" "}
                    {new Date(a.archivedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <button
                  title="Restore tab"
                  onClick={() => void nt().tabsRestore(a.id)}
                  className="nt-r-sm p-1 opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--nt-bg-hover)]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <ArchiveRestore size={14} strokeWidth={1.75} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- footer --------------------------------- */

function SidebarFooter() {
  const { snapshot } = useBrowser();
  return (
    <div
      className="flex items-center gap-1 border-t px-3 py-2"
      style={{ borderColor: "var(--nt-border)" }}
    >
      <button
        title="Collapse sidebar (⌘S)"
        onClick={() => void nt().uiSetSidebarCollapsed(true)}
        className="nt-r-sm p-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{ color: "var(--nt-text-3)" }}
      >
        <PanelLeftClose size={16} strokeWidth={1.75} />
      </button>
      <button
        title="Toggle agent panel"
        onClick={() =>
          void nt().uiSetAgentPanelOpen(!(snapshot?.agentPanelOpen ?? false))
        }
        className="nt-r-sm p-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{
          color: snapshot?.agentPanelOpen
            ? "var(--nt-accent)"
            : "var(--nt-text-3)",
        }}
      >
        <Sparkles size={16} strokeWidth={1.75} />
      </button>
      <button
        title="Settings"
        onClick={() => void nt().uiSetSettingsOpen(true)}
        className="nt-r-sm ml-auto p-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{ color: "var(--nt-text-3)" }}
      >
        <Settings size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return <p className="nt-micro px-2.5 pb-1">{label}</p>;
}
