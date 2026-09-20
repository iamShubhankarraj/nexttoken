/**
 * The sidebar — the soul of the Next Token UI.
 *
 * Three tiers, top to bottom:
 *   1. Favorites dock (per-space app icons)
 *   2. Pinned tabs + collapsible folders (persistent working set)
 *   3. "Today" tabs (ephemeral; idle ones auto-archive — see store.tsx)
 * Plus an Archive section (collapsed) where archived tabs can be restored.
 *
 * Performance: the Today list renders through <VirtualList/>, so only the
 * visible window is mounted no matter how many tabs are open.
 */

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  Pin,
  PinOff,
  Plus,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { memo, useState } from "react";
import { iconForUrl } from "../data";
import { domainOf, IDLE_ARCHIVE_MS, useStore } from "../store";
import type { Folder as FolderT, Space, TabItem } from "../types";
import { VirtualList } from "./VirtualList";

const ROW_H = 40;
const MAX_LIST_H = 400;

export function Sidebar() {
  const { state, space } = useStore();

  return (
    <aside
      className="nt-sidebar flex h-full shrink-0 flex-col border-r border-white/[0.07] bg-[#0c0c11]"
      style={{ width: 264 }}
    >
      <SpaceSwitcher spaces={state.spaces} activeId={space.id} />

      <FavoritesDock space={space} />

      {/* Scrollable middle: pinned, today, archive */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <PinnedSection space={space} />
        <TodaySection space={space} />
        <ArchiveSection />
      </div>

      <ProfileFooter />
    </aside>
  );
}

/* ---------------------------- space switcher ---------------------------- */

function SpaceSwitcher({ spaces, activeId }: { spaces: Space[]; activeId: string }) {
  const { dispatch } = useStore();
  return (
    <div className="flex items-center gap-1 px-3 pt-3 pb-2">
      {spaces.map((s, i) => {
        const Icon = s.icon;
        const active = s.id === activeId;
        return (
          <button
            key={s.id}
            title={`${s.name} (Ctrl+${i + 1})`}
            onClick={() => dispatch({ type: "SWITCH_SPACE", spaceId: s.id })}
            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              active ? "bg-white/10" : "hover:bg-white/[0.06]"
            }`}
          >
            <Icon
              size={17}
              style={{ color: active ? s.accent : undefined }}
              className={active ? "" : "text-white/50 group-hover:text-white/80"}
            />
            <span
              className="absolute -bottom-0.5 h-1 w-1 rounded-full transition-opacity"
              style={{ background: s.accent, opacity: active ? 1 : 0 }}
            />
          </button>
        );
      })}
      <span className="ml-2 text-[13px] font-medium text-white/70">
        {spaces.find((s) => s.id === activeId)?.name}
      </span>
      <kbd className="ml-auto hidden text-[10px] text-white/25">spaces</kbd>
    </div>
  );
}

/* ----------------------------- favorites dock ---------------------------- */

function FavoritesDock({ space }: { space: Space }) {
  const { dispatch } = useStore();
  return (
    <div className="px-3 pb-1">
      <div className="flex flex-wrap gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
        {space.favorites.map((f) => {
          const Icon = f.icon;
          return (
            <button
              key={f.id}
              title={f.name}
              onClick={() => dispatch({ type: "OPEN_URL", url: f.url })}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-white/55 hover:bg-white/[0.07] hover:text-white transition-all hover:scale-105"
            >
              <Icon size={17} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- tab rows -------------------------------- */

interface RowProps {
  tab: TabItem;
  active: boolean;
  index: number;
  splitPick: boolean;
}

const TabRow = memo(function TabRow({ tab, active, index, splitPick }: RowProps) {
  const { dispatch } = useStore();
  const Icon = iconForUrl(tab.url);
  const idleMs = Date.now() - tab.lastActive;
  // Amber dot when a today-tab is approaching auto-archive (demo affordance).
  const expiring = !tab.pinned && idleMs > IDLE_ARCHIVE_MS * 0.55;

  return (
    <div
      onClick={() => dispatch({ type: "ACTIVATE_TAB", tabId: tab.id })}
      title={`${tab.title}\n${tab.url}`}
      style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
      className={`nt-stagger group relative flex h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 transition-colors ${
        active ? "nt-active-tab" : "hover:bg-white/[0.05]"
      } ${splitPick ? "hover:outline hover:outline-1 hover:outline-[var(--accent)]" : ""}`}
    >
      <Icon size={15} className="shrink-0 text-white/45" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] text-white/85">{tab.title}</p>
        <p className="truncate text-[11px] text-white/30">{domainOf(tab.url)}</p>
      </div>
      {expiring && !active && (
        <span title="Idle — will auto-archive soon" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/80" />
      )}
      {splitPick ? (
        <Plus size={14} className="shrink-0 text-[var(--accent)]" />
      ) : (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            title={tab.pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "TOGGLE_PIN", tabId: tab.id });
            }}
            className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
          >
            {tab.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "CLOSE_TAB", tabId: tab.id });
            }}
            className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
          >
            <X size={13} />
          </button>
        </span>
      )}
    </div>
  );
});

/* ------------------------------ pinned ---------------------------------- */

function PinnedSection({ space }: { space: Space }) {
  const { state } = useStore();
  const pinnedTop = space.tabs.filter((t) => t.pinned && !t.folderId);

  return (
    <section className="mt-2">
      <SectionLabel label="Pinned" />
      <div className="space-y-0.5">
        {pinnedTop.map((t, i) => (
          <TabRow key={t.id} tab={t} index={i} active={t.id === state.activeTabId} splitPick={state.splitPick} />
        ))}
      </div>
      {space.folders.map((f) => (
        <PinFolder key={f.id} folder={f} space={space} />
      ))}
    </section>
  );
}

function PinFolder({ folder, space }: { folder: FolderT; space: Space }) {
  const { dispatch, state } = useStore();
  const tabs = space.tabs.filter((t) => t.pinned && t.folderId === folder.id);
  return (
    <div className="mt-0.5">
      <button
        onClick={() => dispatch({ type: "TOGGLE_FOLDER", folderId: folder.id })}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.05] transition-colors"
      >
        {folder.open ? <ChevronDown size={13} className="text-white/40" /> : <ChevronRight size={13} className="text-white/40" />}
        <Folder size={13} className="text-white/40" />
        <span className="text-[12px] font-medium text-white/60">{folder.name}</span>
        <span className="ml-auto text-[11px] text-white/25">{tabs.length}</span>
      </button>
      {folder.open && (
        <div className="ml-3 space-y-0.5 border-l border-white/[0.07] pl-1">
          {tabs.map((t, i) => (
            <TabRow key={t.id} tab={t} index={i} active={t.id === state.activeTabId} splitPick={state.splitPick} />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- today ---------------------------------- */

function TodaySection({ space }: { space: Space }) {
  const { dispatch, state } = useStore();
  const today = space.tabs.filter((t) => !t.pinned);
  const listH = Math.max(Math.min(today.length * ROW_H, MAX_LIST_H), ROW_H);

  return (
    <section className="mt-3">
      <div className="flex items-center">
        <SectionLabel label={`Today · ${today.length}`} />
        <button
          title="New tab"
          onClick={() => dispatch({ type: "NEW_TAB" })}
          className="ml-auto rounded-md p-1 text-white/35 hover:bg-white/10 hover:text-white transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
      {today.length === 0 ? (
        <p className="px-2.5 py-3 text-[12px] text-white/30">
          All clear. Idle tabs auto-archive after {Math.round(IDLE_ARCHIVE_MS / 1000)}s.
        </p>
      ) : (
        <div style={{ height: listH }} className="rounded-lg">
          <VirtualList
            items={today}
            rowHeight={ROW_H}
            keyOf={(t) => t.id}
            renderRow={(t, i) => (
              <TabRow tab={t} index={i} active={t.id === state.activeTabId} splitPick={state.splitPick} />
            )}
          />
        </div>
      )}
    </section>
  );
}

/* -------------------------------- archive --------------------------------- */

function ArchiveSection() {
  const { dispatch, state } = useStore();
  const [open, setOpen] = useState(false);
  const archived = state.archived;

  return (
    <section className="mt-3">
      <div className="flex items-center">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-white/[0.05] transition-colors"
        >
          {open ? <ChevronDown size={13} className="text-white/40" /> : <ChevronRight size={13} className="text-white/40" />}
          <Archive size={13} className="text-white/40" />
          <span className="text-[12px] font-medium uppercase tracking-wider text-white/40">
            Archive · {archived.length}
          </span>
        </button>
        {archived.length > 0 && (
          <button
            title="Archive all idle tabs now (demo)"
            onClick={() => dispatch({ type: "ARCHIVE_ALL_IDLE" })}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-white/35 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Zap size={12} /> archive idle
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1 space-y-0.5">
          {archived.length === 0 && (
            <p className="px-2.5 py-2 text-[12px] text-white/30">
              Nothing archived yet. Leave a Today tab idle for {Math.round(IDLE_ARCHIVE_MS / 1000)}s and watch it land here.
            </p>
          )}
          {archived.map((t) => {
            const Icon = iconForUrl(t.url);
            return (
              <div
                key={t.id}
                className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/[0.05] transition-colors"
              >
                <Icon size={14} className="shrink-0 text-white/35" />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-[12px] text-white/60">{t.title}</p>
                  <p className="truncate text-[10px] text-white/25">
                    {t.fromSpaceName} · {new Date(t.archivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <button
                  title="Restore tab"
                  onClick={() => dispatch({ type: "RESTORE_TAB", archiveId: t.id })}
                  className="rounded p-1 text-white/35 opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-white transition-all"
                >
                  <ArchiveRestore size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- misc ---------------------------------- */

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-widest text-white/30">
      {label}
    </p>
  );
}

function ProfileFooter() {
  return (
    <div className="flex items-center gap-2.5 border-t border-white/[0.07] px-3 py-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-semibold text-white"
        style={{ background: "linear-gradient(135deg, var(--accent), #ec4899)" }}>
        S
      </span>
      <div className="leading-tight">
        <p className="text-[13px] font-medium">Founder</p>
        <p className="text-[11px] text-white/35">Prototype build</p>
      </div>
      <button
        title="Settings (prototype)"
        className="ml-auto rounded-lg p-2 text-white/40 hover:bg-white/[0.07] hover:text-white transition-colors"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}
