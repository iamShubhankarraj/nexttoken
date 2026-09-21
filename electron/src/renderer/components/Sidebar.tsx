/**
 * Arc-style sidebar: Bits (the user-facing name for spaces), favorites
 * dock, pinned tabs, per-Bit folders, open tabs, bookmarks, auto-archive.
 *
 * - Every tab row shows its real site favicon (Favicon component).
 * - Tabs are draggable: reorder within a list, drop onto a folder to file,
 *   drop onto Pinned to pin.
 * - Each Bit keeps its own tabs, pinned tabs, folders, and bookmarks;
 *   switching Bits swaps the whole workspace. Bit state persists per Bit
 *   (open tabs restore on launch; see TabManager.persistSession).
 * - "Tidy tabs" asks a LOCAL model to propose folder groupings + closures
 *   and opens a review dialog — nothing is applied without confirmation.
 */

import {
  Archive,
  ArchiveRestore,
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sparkles,
  Star,
  Trash2,
  X,
  PanelLeftClose,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArchivedTab,
  BitFolder,
  BookmarkState,
  SpaceState,
  TabState,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { domainOf, nt } from "../nt";
import { Favicon } from "./Favicon";
import { TidyDialog } from "./TidyDialog";
import { VirtualList } from "./VirtualList";

const ROW_H = 36;
const MAX_LIST_H = 440;
const DRAG_MIME = "text/nt-tab-id";

/**
 * Read our tab id back out of a drag event's DataTransfer. Returns null for
 * foreign drags (no nt-tab MIME type). Used as a fallback when the in-memory
 * drag ref/state is stale — e.g. the sidebar tree remounted mid-drag.
 */
function tabIdFromDataTransfer(e: React.DragEvent): string | null {
  try {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      return e.dataTransfer.getData(DRAG_MIME) || null;
    }
  } catch {
    /* DataTransfer may be unavailable on some synthetic events */
  }
  return null;
}

/* --------------------------------- shell ---------------------------------- */

export function Sidebar() {
  const { snapshot, activeSpace } = useBrowser();
  const [tidyOpen, setTidyOpen] = useState(false);
  const [dragId, setDragIdState] = useState<string | null>(null);
  /** Insertion indicator: the tab id to insert before (null = end of list). */
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [dropBeforeKey, setDropBeforeKey] = useState<string | null>(null);
  /** Folder currently highlighted as a drop target (folder id, "pinned", "ungrouped"). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(true);

  // Stable drag id readable inside memoized callbacks.
  const dragIdRef = useRef<string | null>(null);
  const setDragId = (id: string | null) => {
    dragIdRef.current = id;
    setDragIdState(id);
  };
  /**
   * Recover the dragged tab's id for this drag event. The live ref is the
   * primary source; the DataTransfer payload is the fallback (e.g. if the
   * sidebar tree remounted mid-drag). Foreign drags (no nt-tab MIME type)
   * never resolve to an id, so they can't trigger tab moves.
   */
  const draggedTabId = (e: React.DragEvent): string | null =>
    dragIdRef.current || tabIdFromDataTransfer(e);
  const clearDnd = useCallback(() => {
    dragIdRef.current = null;
    setDragIdState(null);
    setDropBefore(null);
    setDropBeforeKey(null);
    setDropTarget(null);
  }, []);

  // ⌘/Ctrl+1..9 switches Bits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key >= "1" &&
        e.key <= "9"
      ) {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        const s = snapshot?.spaces[Number(e.key) - 1];
        if (s && s.id !== activeSpace?.id) {
          e.preventDefault();
          void nt().spacesSwitch(s.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot?.spaces, activeSpace?.id]);

  // Memoized once: only stable setters + nt() + the drag id ref, so memoized
  // TabRows keep their memoization during drags.
  const dnd: DndApi = useMemo(
    () => ({
      onDragStart: (e: React.DragEvent, tabId: string) => {
        e.dataTransfer.setData(DRAG_MIME, tabId);
        // Standard-type mirror: macOS drag sessions are more reliable when a
        // standard type rides alongside the custom one.
        e.dataTransfer.setData("text/plain", tabId);
        e.dataTransfer.effectAllowed = "move";
        setDragId(tabId);
      },
      onDragEnd: clearDnd,
      /** Row-level: show an insertion indicator above this row. */
      onRowDragOver: (e: React.DragEvent, tab: TabState, listKey: string) => {
        const id = draggedTabId(e);
        if (!id || id === tab.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDropBefore(tab.id);
        setDropBeforeKey(listKey);
        setDropTarget(null);
      },
      onRowDrop: (e: React.DragEvent, tab: TabState, listKey: string) => {
        const id = draggedTabId(e);
        if (!id || id === tab.id) return;
        e.preventDefault();
        e.stopPropagation();
        clearDnd();
        // Pin state follows the target section: dropping a pinned tab into an
        // unpinned section unpins it (and vice versa).
        const folderId = listKey.startsWith("folder:") ? listKey.slice("folder:".length) : null;
        const wantPinned = listKey === "pinned";
        const api = nt();
        void api.tabsPin(id, wantPinned).then(() => api.tabsReorder(id, tab.id, wantPinned ? null : folderId));
      },
      /** End-of-list zone: append to this folder/section. */
      onEndDragOver: (e: React.DragEvent, listKey: string) => {
        if (!draggedTabId(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDropBefore(null);
        setDropBeforeKey(listKey);
        setDropTarget(null);
      },
      onEndDrop: (e: React.DragEvent, listKey: string, folderId: string | null) => {
        const id = draggedTabId(e);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        clearDnd();
        const wantPinned = listKey === "pinned";
        const api = nt();
        void api.tabsPin(id, wantPinned).then(() => api.tabsReorder(id, null, wantPinned ? null : folderId));
      },
      /** Folder header: highlight + file on drop. */
      onFolderDragOver: (e: React.DragEvent, folderId: string) => {
        if (!draggedTabId(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(folderId);
        setDropBefore(null);
        setDropBeforeKey(null);
      },
      onFolderDrop: (e: React.DragEvent, folderId: string) => {
        const id = draggedTabId(e);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        clearDnd();
        // Folders are unpinned sections — unpin first so the filing sticks.
        const api = nt();
        void api.tabsPin(id, false).then(() => api.tabsSetFolder(id, folderId));
      },
    }),
    [clearDnd],
  );

  // Every hook above this line — the early return must come after all hooks.
  if (!snapshot || !activeSpace) return null;

  const pinned = activeSpace.tabs.filter((t) => t.pinned);
  const unpinned = activeSpace.tabs.filter((t) => !t.pinned);
  const ungrouped = unpinned.filter((t) => !t.folderId);
  const folderTabs = (f: BitFolder) => unpinned.filter((t) => t.folderId === f.id);

  const toggleFolder = (id: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <aside
      className="flex h-full w-[248px] shrink-0 select-none flex-col border-r"
      style={{ background: "var(--nt-sidebar-bg)", borderColor: "var(--nt-border)" }}
    >
      {/* 2px bit-identity wash on the top edge */}
      <div className="nt-space-wash shrink-0" />

      <BitSwitcher
        spaces={snapshot.spaces}
        activeId={activeSpace.id}
        activeName={activeSpace.name}
        dragId={dragId}
      />

      <FavoritesDock space={activeSpace} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* Pinned section doubles as the pin drop zone — visible while
            dragging even when there are no pinned tabs yet. */}
        {(pinned.length > 0 || dragId) && (
          <section
            className="mt-2"
            onDragOver={(e) => {
              if (!(dragId ?? tabIdFromDataTransfer(e))) return;
              e.preventDefault();
              setDropTarget("pinned");
            }}
            onDragLeave={() => setDropTarget((t) => (t === "pinned" ? null : t))}
            onDrop={(e) => {
              const id = dragId ?? tabIdFromDataTransfer(e);
              if (!id) return;
              e.preventDefault();
              clearDnd();
              void nt().tabsPin(id, true);
            }}
          >
            <button
              onClick={() => setPinnedCollapsed((c) => !c)}
              aria-expanded={!pinnedCollapsed}
              className="nt-r-sm flex w-full items-center gap-1.5 px-1 py-1 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
            >
              {pinnedCollapsed ? (
                <ChevronRight size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
              ) : (
                <ChevronDown size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
              )}
              <Pin size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
              <span className="nt-micro">Pinned</span>
              <span
                className="nt-num ml-auto pr-1 text-[11px]"
                style={{ color: "var(--nt-text-faint)" }}
              >
                {pinned.length}
              </span>
            </button>
            {!pinnedCollapsed && (
            <div
              className="nt-r-sm space-y-1 p-0.5 transition-colors"
              style={
                dropTarget === "pinned"
                  ? { background: "var(--nt-accent-soft)", outline: "1px dashed var(--nt-accent)" }
                  : undefined
              }
            >
              {pinned.map((t) => (
                <TabRow
                  key={t.id}
                  tab={t}
                  active={t.id === activeSpace.activeTabId}
                  dnd={dnd}
                  listKey="pinned"
                  dragId={dragId}
                  dropBefore={dropBefore}
                  dropBeforeKey={dropBeforeKey}
                />
              ))}
            </div>
            )}
          </section>
        )}

        {activeSpace.folders.map((f) => {
          const tabs = folderTabs(f);
          const collapsed = collapsedFolders.has(f.id);
          return (
            <section key={f.id} className="mt-3">
              <FolderHeader
                folder={f}
                count={tabs.length}
                collapsed={collapsed}
                onToggle={() => toggleFolder(f.id)}
                highlighted={dropTarget === f.id}
                dnd={dnd}
                spaceId={activeSpace.id}
                tabs={tabs}
              />
              {!collapsed && (
                <div className="mt-0.5 space-y-1">
                  {tabs.map((t) => (
                    <TabRow
                      key={t.id}
                      tab={t}
                      active={t.id === activeSpace.activeTabId}
                      dnd={dnd}
                      listKey={`folder:${f.id}`}
                      dragId={dragId}
                      dropBefore={dropBefore}
                      dropBeforeKey={dropBeforeKey}
                    />
                  ))}
                  <EndDropZone
                    dnd={dnd}
                    dragId={dragId}
                    dropBefore={dropBefore}
                    dropBeforeKey={dropBeforeKey}
                    listKey={`folder:${f.id}`}
                    folderId={f.id}
                    visible={tabs.length > 0}
                  />
                </div>
              )}
            </section>
          );
        })}

        <section
          className="mt-3"
          onDragOver={(e) => {
            // Ungrouped area: dropping here ungroups the tab.
            if (!(dragId ?? tabIdFromDataTransfer(e))) return;
            if ((e.target as HTMLElement).closest("[data-tab-row],[data-folder]"))
              return;
            e.preventDefault();
            setDropTarget("ungrouped");
          }}
          onDragLeave={() => setDropTarget((t) => (t === "ungrouped" ? null : t))}
          onDrop={(e) => {
            if ((e.target as HTMLElement).closest("[data-tab-row],[data-folder]"))
              return;
            const id = dragId ?? tabIdFromDataTransfer(e);
            if (!id) return;
            e.preventDefault();
            clearDnd();
            void nt().tabsSetFolder(id, null);
          }}
        >
          <div className="flex items-center">
            <SectionLabel label="Tabs" />
            <span
              className="nt-num ml-1 text-[11px]"
              style={{ color: "var(--nt-text-faint)" }}
            >
              {ungrouped.length}
            </span>
            <span className="ml-auto flex items-center">
              <button
                title="Tidy tabs with local AI"
                onClick={() => setTidyOpen(true)}
                className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <Sparkles size={14} strokeWidth={1.75} />
              </button>
              <button
                title="New folder"
                onClick={() => {
                  const name = window.prompt("Folder name:");
                  if (name?.trim()) void nt().foldersCreate(activeSpace.id, name.trim());
                }}
                className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <FolderPlus size={14} strokeWidth={1.75} />
              </button>
              <button
                title="New tab (⌘T)"
                onClick={() => void nt().tabsCreate({})}
                className="nt-r-sm p-1 transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <Plus size={14} strokeWidth={1.75} />
              </button>
            </span>
          </div>
          <div
            className="nt-r-sm p-0.5 transition-colors"
            style={
              dropTarget === "ungrouped"
                ? { background: "var(--nt-accent-soft)", outline: "1px dashed var(--nt-accent)" }
                : undefined
            }
          >
            {ungrouped.length === 0 && activeSpace.folders.length === 0 ? (
              <p className="px-2.5 py-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                No tabs here yet. Open one with ⌘T.
              </p>
            ) : ungrouped.length === 0 ? null : (
              <div style={{ height: Math.min(ungrouped.length * ROW_H, MAX_LIST_H) }}>
                <VirtualList
                  items={ungrouped}
                  rowHeight={ROW_H}
                  keyOf={(t) => t.id}
                  renderRow={(t) => (
                    <TabRow
                      tab={t}
                      active={t.id === activeSpace.activeTabId}
                      dnd={dnd}
                      listKey="ungrouped"
                      dragId={dragId}
                      dropBefore={dropBefore}
                      dropBeforeKey={dropBeforeKey}
                    />
                  )}
                />
              </div>
            )}
            <EndDropZone dnd={dnd} dragId={dragId} dropBefore={dropBefore} dropBeforeKey={dropBeforeKey} listKey="ungrouped" folderId={null} visible={ungrouped.length > 0} />
          </div>
        </section>

        <BookmarksSection
          space={activeSpace}
          open={bookmarksOpen}
          onToggle={() => setBookmarksOpen((o) => !o)}
        />

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
      {tidyOpen && (
        <TidyDialog spaceId={activeSpace.id} onClose={() => setTidyOpen(false)} />
      )}
    </aside>
  );
}

/* ----------------------------- bit switcher ------------------------------ */

function BitSwitcher({
  spaces,
  activeId,
  activeName,
  dragId,
}: {
  spaces: SpaceState[];
  activeId: string;
  activeName: string;
  dragId: string | null;
}) {
  const [menuBit, setMenuBit] = useState<{ x: number; y: number; id: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dropBit, setDropBit] = useState<string | null>(null);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if ((creating || renaming) && inputRef.current) inputRef.current.focus();
  }, [creating, renaming]);

  const activeSpace = spaces.find((s) => s.id === activeId);
  // Tab count for the Bit actually being deleted (not necessarily the active one).
  const deleteTarget = menuBit ? spaces.find((s) => s.id === menuBit.id) : undefined;
  const tabCount = deleteTarget?.tabs.length ?? 0;

  const submitCreate = () => {
    const clean = name.trim();
    if (clean) void nt().spacesCreate(clean);
    setCreating(false);
    setName("");
  };
  const submitRename = () => {
    const clean = name.trim();
    if (clean && menuBit) void nt().spacesRename(menuBit.id, clean);
    setRenaming(false);
    setMenuBit(null);
    setName("");
  };

  return (
    <div className="px-3 pb-2 pt-3">
      <div className="flex items-center gap-1">
        {spaces.map((s, i) => {
          const active = s.id === activeId;
          const initial = (s.name.trim()[0] ?? "·").toUpperCase();
          return (
            <button
              key={s.id}
              title={`${s.name} (Ctrl/⌘+${i + 1}) — right-click for options · drop a tab here to move it`}
              onClick={() => void nt().spacesSwitch(s.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuBit({ x: e.clientX, y: e.clientY, id: s.id, name: s.name });
              }}
              onDragOver={
                s.id !== activeId
                  ? (e) => {
                      if (!(dragId ?? tabIdFromDataTransfer(e))) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDropBit(s.id);
                    }
                  : undefined
              }
              onDragLeave={() => setDropBit((b) => (b === s.id ? null : b))}
              onDrop={
                s.id !== activeId
                  ? (e) => {
                      const id = dragId ?? tabIdFromDataTransfer(e);
                      if (!id) return;
                      e.preventDefault();
                      setDropBit(null);
                      void nt().tabsMove(id, s.id);
                    }
                  : undefined
              }
              className="nt-r-sm flex h-8 w-8 shrink-0 items-center justify-center transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={
                dropBit === s.id
                  ? { background: "var(--nt-accent-soft)", outline: "1px dashed var(--nt-accent)" }
                  : active
                    ? { background: "color-mix(in srgb, var(--nt-space) 16%, transparent)" }
                    : undefined
              }
            >
              <span
                className="text-[12px] font-semibold"
                style={{ color: active ? "var(--nt-space)" : "var(--nt-text-3)" }}
              >
                {initial}
              </span>
            </button>
          );
        })}
        <button
          title="New Bit"
          onClick={() => {
            setName("");
            setCreating(true);
          }}
          className="nt-r-sm flex h-8 w-8 shrink-0 items-center justify-center transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-3)" }}
        >
          <Plus size={14} strokeWidth={1.75} />
        </button>
        {renaming && menuBit ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") {
                setRenaming(false);
                setMenuBit(null);
              }
            }}
            onBlur={submitRename}
            maxLength={32}
            className="nt-r-sm ml-1.5 min-w-0 flex-1 border bg-transparent px-1.5 py-0.5 text-[13px] font-medium outline-none"
            style={{ borderColor: "var(--nt-border-strong)", color: "var(--nt-text-1)" }}
            aria-label="Bit name"
          />
        ) : (
          <span
            className="ml-1.5 truncate text-[13px] font-medium"
            style={{ color: "var(--nt-text-1)" }}
            onDoubleClick={() => {
              if (menuBit == null) {
                const s = spaces.find((x) => x.id === activeId);
                if (s) {
                  setMenuBit({ x: 0, y: 0, id: s.id, name: s.name });
                  setName(s.name);
                  setRenaming(true);
                }
              }
            }}
            title="Double-click to rename"
          >
            {activeName}
          </span>
        )}
      </div>

      {creating && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Bit name…"
            maxLength={32}
            className="nt-r-sm min-w-0 flex-1 border bg-transparent px-2 py-1.5 text-[13px] outline-none"
            style={{
              borderColor: "var(--nt-border-strong)",
              color: "var(--nt-text-1)",
              background: "var(--nt-bg-raised)",
            }}
            aria-label="New Bit name"
          />
          <button
            onClick={submitCreate}
            disabled={!name.trim()}
            className="nt-r-sm px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-40"
            style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
          >
            Add
          </button>
        </div>
      )}

      {menuBit && !renaming && (
        <BitMenu
          x={menuBit.x}
          y={menuBit.y}
          onClose={() => setMenuBit(null)}
          onRename={() => {
            setName(menuBit.name);
            setRenaming(true);
          }}
          onDelete={() => {
            setName(menuBit.name);
            setDeleting(true);
          }}
          canDelete={spaces.length > 1}
        />
      )}

      {deleting && menuBit && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setDeleting(false);
              setMenuBit(null);
            }
          }}
          role="alertdialog"
          aria-modal="true"
          aria-label={`Delete Bit ${menuBit.name}`}
        >
          <div
            className="nt-r-lg nt-fade-in w-[380px] border p-5 shadow-2xl"
            style={{ background: "var(--nt-bg-overlay)", borderColor: "var(--nt-border)" }}
          >
            <h2 className="text-[15px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
              Delete “{menuBit.name}”?
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--nt-text-2)" }}>
              Its {tabCount} {tabCount === 1 ? "tab" : "tabs"} will be moved to the Archive —
              nothing is lost, and you can restore tabs from there. Its folders
              and bookmarks will be removed with the Bit.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleting(false);
                  setMenuBit(null);
                }}
                className="nt-r-sm px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-2)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const id = menuBit.id;
                  setDeleting(false);
                  setMenuBit(null);
                  void nt().spacesDelete(id).catch(() => {});
                }}
                className="nt-r-sm px-4 py-2 text-[13px] font-semibold"
                style={{ background: "#D97362", color: "#0B0B0D" }}
              >
                Delete Bit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BitMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
  canDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  canDelete: boolean;
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
    "nt-r-sm flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-40";
  return (
    <div
      ref={ref}
      className="nt-popover nt-r-md fixed z-[70] w-44 border p-1.5 shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 190),
        top: Math.min(y, window.innerHeight - 120),
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
      }}
      role="menu"
    >
      <button className={itemCls} style={{ color: "var(--nt-text-1)" }} onClick={() => { onClose(); onRename(); }} role="menuitem">
        <Pencil size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} /> Rename Bit
      </button>
      <button
        className={itemCls}
        style={{ color: "#D97362" }}
        disabled={!canDelete}
        title={canDelete ? undefined : "You need at least one Bit"}
        onClick={() => { onClose(); onDelete(); }}
        role="menuitem"
      >
        <Trash2 size={15} strokeWidth={1.75} /> Delete Bit
      </button>
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
        {space.favorites.map((f) => (
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
            <Favicon url={f.url} size={16} />
          </button>
        ))}
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

/* ------------------------------ folder header ---------------------------- */

function FolderHeader({
  folder,
  count,
  collapsed,
  onToggle,
  highlighted,
  dnd,
  spaceId,
  tabs,
}: {
  folder: BitFolder;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  highlighted: boolean;
  dnd: DndApi;
  spaceId: string;
  tabs: TabState[];
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) inputRef.current.focus();
  }, [renaming ]);

  const submitRename = () => {
    const clean = name.trim();
    if (clean && clean !== folder.name) void nt().foldersRename(spaceId, folder.id, clean);
    else setName(folder.name);
    setRenaming(false);
  };

  return (
    <div data-folder={folder.id}>
      <div
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => dnd.onFolderDragOver(e, folder.id)}
        onDrop={(e) => dnd.onFolderDrop(e, folder.id)}
        className="nt-r-sm flex w-full cursor-pointer items-center gap-1.5 px-1 py-1 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={
          highlighted
            ? { background: "var(--nt-accent-soft)", outline: "1px dashed var(--nt-accent)" }
            : undefined
        }
        role="button"
        aria-expanded={!collapsed}
        title="Right-click for folder options"
      >
        {collapsed ? (
          <ChevronRight size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <ChevronDown size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        <Folder size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        {/* Stacked favicon preview of the first few tabs in the folder. */}
        {tabs.length > 0 && (
          <span className="flex shrink-0 items-center" aria-hidden>
            {tabs.slice(0, 3).map((t, i) => (
              <span
                key={t.id}
                className="overflow-hidden rounded-full"
                style={{
                  width: 14,
                  height: 14,
                  marginLeft: i === 0 ? 0 : -6,
                  outline: "1px solid var(--nt-bg)",
                  background: "var(--nt-bg)",
                  zIndex: 3 - i,
                }}
              >
                <Favicon url={t.url} favicon={t.favicon} size={14} />
              </span>
            ))}
          </span>
        )}
        {renaming ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") {
                setName(folder.name);
                setRenaming(false);
              }
            }}
            onBlur={submitRename}
            maxLength={40}
            className="nt-r-sm min-w-0 flex-1 border bg-transparent px-1 py-0.5 text-[12px] font-medium outline-none"
            style={{ borderColor: "var(--nt-border-strong)", color: "var(--nt-text-1)" }}
            aria-label="Folder name"
          />
        ) : (
          <span className="nt-micro flex-1 truncate">{folder.name}</span>
        )}
        <span className="nt-num text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
          {count}
        </span>
      </div>
      {menu && (
        <FolderMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setName(folder.name);
            setRenaming(true);
          }}
          onDelete={() => void nt().foldersRemove(spaceId, folder.id)}
        />
      )}
    </div>
  );
}

function FolderMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
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
  return (
    <div
      ref={ref}
      className="nt-popover nt-r-md fixed z-[70] w-48 border p-1.5 shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 210),
        top: Math.min(y, window.innerHeight - 120),
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
      }}
      role="menu"
    >
      <button className={itemCls} style={{ color: "var(--nt-text-1)" }} onClick={() => { onClose(); onRename(); }} role="menuitem">
        <Pencil size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} /> Rename folder
      </button>
      <button className={itemCls} style={{ color: "var(--nt-text-1)" }} onClick={() => { onClose(); onDelete(); }} role="menuitem">
        <Trash2 size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} /> Delete folder
      </button>
      <p className="px-3 pb-1 pt-1 text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
        Tabs inside stay open, ungrouped.
      </p>
    </div>
  );
}

/* ------------------------------ drag & drop ------------------------------- */

interface DndApi {
  onDragStart: (e: React.DragEvent, tabId: string) => void;
  onDragEnd: () => void;
  onRowDragOver: (e: React.DragEvent, tab: TabState, listKey: string) => void;
  onRowDrop: (e: React.DragEvent, tab: TabState, listKey: string) => void;
  onEndDragOver: (e: React.DragEvent, listKey: string) => void;
  onEndDrop: (e: React.DragEvent, listKey: string, folderId: string | null) => void;
  onFolderDragOver: (e: React.DragEvent, folderId: string) => void;
  onFolderDrop: (e: React.DragEvent, folderId: string) => void;
}

/** Slim end-of-list drop zone — appending to a folder or section. */
function EndDropZone({
  dnd,
  dragId,
  dropBefore,
  dropBeforeKey,
  listKey,
  folderId,
  visible,
}: {
  dnd: DndApi;
  dragId: string | null;
  dropBefore: string | null;
  dropBeforeKey: string | null;
  listKey: string;
  folderId: string | null;
  visible: boolean;
}) {
  if (!dragId || !visible) return null;
  const active = dropBefore === null && dropBeforeKey === listKey;
  return (
    <div
      onDragOver={(e) => dnd.onEndDragOver(e, listKey)}
      onDrop={(e) => dnd.onEndDrop(e, listKey, folderId)}
      className="nt-r-sm mx-1 transition-colors"
      style={{
        height: 14,
        background: active ? "var(--nt-accent-soft)" : "transparent",
        outline: active ? "1px dashed var(--nt-accent)" : "none",
        outlineOffset: -1,
      }}
      aria-hidden
    />
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
  folders,
  spaceId,
  spaces,
}: {
  menu: MenuState;
  onClose: () => void;
  folders: BitFolder[];
  spaceId: string;
  spaces: SpaceState[];
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

  // Bookmark toggle: avoid duplicates — offer removal when already saved.
  const existingBookmark = spaces
    .find((s) => s.id === spaceId)
    ?.bookmarks.find((b) => b.url === menu.tab.url);

  return (
    <div
      ref={ref}
      className="nt-popover nt-r-md fixed z-[70] w-56 border p-1.5 shadow-xl"
      style={{
        left: Math.min(menu.x, window.innerWidth - 240),
        top: Math.min(menu.y, window.innerHeight - 380),
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
        boxShadow: "var(--nt-shadow-pop)",
      }}
      role="menu"
    >
      <button
        className={itemCls}
        style={{ color: "var(--nt-text-1)" }}
        onClick={act(() =>
          existingBookmark
            ? void nt().bookmarksRemove(spaceId, existingBookmark.id)
            : void nt().bookmarksAdd(
                spaceId,
                menu.tab.title || domainOf(menu.tab.url),
                menu.tab.url,
              ),
        )}
        role="menuitem"
      >
        {existingBookmark ? (
          <BookmarkIcon size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <BookmarkPlus size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        {existingBookmark ? "Remove bookmark" : "Bookmark this tab"}
      </button>
      <div className="my-1 border-t" style={{ borderColor: "var(--nt-border)" }} />
      <p className="nt-micro px-3 pb-1 pt-1">Move to folder</p>
      {menu.tab.folderId && (
        <button
          className={itemCls}
          style={{ color: "var(--nt-text-1)" }}
          onClick={act(() => void nt().tabsSetFolder(menu.tab.id, null))}
          role="menuitem"
        >
          <Folder size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
          Ungrouped
        </button>
      )}
      {folders
        .filter((f) => f.id !== menu.tab.folderId)
        .map((f) => (
          <button
            key={f.id}
            className={itemCls}
            style={{ color: "var(--nt-text-1)" }}
            onClick={act(() => void nt().tabsSetFolder(menu.tab.id, f.id))}
            role="menuitem"
          >
            <Folder size={16} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      {folders.length === 0 && (
        <p className="px-3 pb-1 text-[12px]" style={{ color: "var(--nt-text-faint)" }}>
          No folders yet — create one from the Tabs header.
        </p>
      )}
      <div className="my-1 border-t" style={{ borderColor: "var(--nt-border)" }} />
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
      {spaces.length > 1 && (
        <>
          <div className="my-1 border-t" style={{ borderColor: "var(--nt-border)" }} />
          <p className="nt-micro px-3 pb-1 pt-1">Move to Bit</p>
          {spaces
            .filter((s) => s.id !== spaceId)
            .map((s) => (
              <button
                key={s.id}
                className={itemCls}
                style={{ color: "var(--nt-text-1)" }}
                onClick={act(() => void nt().tabsMove(menu.tab.id, s.id))}
                role="menuitem"
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold"
                  style={{ color: "var(--nt-space)" }}
                >
                  {(s.name.trim()[0] ?? "·").toUpperCase()}
                </span>
                <span className="truncate">{s.name}</span>
              </button>
            ))}
        </>
      )}
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
  dnd: DndApi;
  /** Identifies the list this row lives in ("pinned" | "ungrouped" | "folder:<id>"). */
  listKey: string;
  dragId: string | null;
  dropBefore: string | null;
  dropBeforeKey: string | null;
}

/**
 * Memoized so a title/loading change on one tab never re-renders the rest
 * of the list (anti-Vivaldi rule). The loading shimmer is pure CSS — it
 * animates without any React state or parent repaints.
 */
const TabRow = memo(function TabRow({
  tab,
  active,
  dnd,
  listKey,
  dragId,
  dropBefore,
  dropBeforeKey,
}: RowProps) {
  const { snapshot, activeSpace, splitPick, setSplitPick, setSplit, split } = useBrowser();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const showDropBefore = dropBefore === tab.id && dropBeforeKey === listKey;
  const isDragging = dragId === tab.id;
  const folderId = listKey.startsWith("folder:") ? listKey.slice("folder:".length) : null;

  const onClick = useCallback(() => {
    if (splitPick) {
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
      <div data-tab-row={tab.id}>
        {showDropBefore && (
          <div
            className="mx-2"
            style={{ height: 3, background: "var(--nt-accent)", borderRadius: 2 }}
            aria-hidden
          />
        )}
        <div
          onClick={onClick}
          onContextMenu={onContextMenu}
          draggable
          onDragStart={(e) => dnd.onDragStart(e, tab.id)}
          onDragEnd={dnd.onDragEnd}
          onDragOver={(e) => dnd.onRowDragOver(e, tab, listKey)}
          onDrop={(e) => dnd.onRowDrop(e, tab, listKey)}
          title={`${tab.title || "New tab"}\n${tab.url}`}
          className={`nt-r-sm group relative flex h-9 cursor-pointer items-center gap-2.5 px-2.5 transition-colors ${
            active ? "nt-active-tab" : "hover:bg-[var(--nt-bg-hover)]"
          } ${splitPick ? "hover:outline hover:outline-1 hover:outline-[var(--nt-accent)]" : ""}`}
          style={{
            ...(isDragging ? { opacity: 0.4 } : undefined),
            ...(showDropBefore && !isDragging ? { background: "var(--nt-accent-soft)" } : undefined),
          }}
        >
          {tab.loading ? (
            <span className="nt-shimmer" title="Loading" />
          ) : (
            <Favicon url={tab.url} favicon={tab.favicon} size={16} />
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
      </div>
      {menu && activeSpace && (
        <TabContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          folders={activeSpace.folders}
          spaceId={activeSpace.id}
          spaces={snapshot?.spaces ?? []}
        />
      )}
    </>
  );
});

/* -------------------------------- bookmarks ------------------------------ */

function BookmarkRow({
  b,
  space,
  renamingId,
  renameValue,
  setRenameValue,
  setRenamingId,
  setMenu,
}: {
  b: BookmarkState;
  space: SpaceState;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  setRenamingId: (id: string | null) => void;
  setMenu: (m: { x: number; y: number; bm: BookmarkState } | null) => void;
}) {
  return (
            <div key={b.id} data-bookmark={b.id}>
              {renamingId === b.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = renameValue.trim();
                      if (v) void nt().bookmarksRename(space.id, b.id, v);
                      setRenamingId(null);
                    }
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => setRenamingId(null)}
                  maxLength={80}
                  className="nt-r-sm mx-1 my-0.5 w-[calc(100%-8px)] border bg-transparent px-2 py-1.5 text-[13px] outline-none"
                  style={{ borderColor: "var(--nt-border-strong)", color: "var(--nt-text-1)" }}
                  aria-label="Bookmark name"
                />
              ) : (
                <div
                  onClick={() => void nt().tabsCreate({ url: b.url })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, bm: b });
                  }}
                  title={`${b.name}\n${b.url}`}
                  className="nt-r-sm group flex cursor-pointer items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
                >
                  <Favicon url={b.url} favicon={b.favicon} size={14} />
                  <p
                    className="min-w-0 flex-1 truncate text-[13px]"
                    style={{ color: "var(--nt-text-2)" }}
                  >
                    {b.name}
                  </p>
                  <button
                    title="Remove bookmark"
                    onClick={(e) => {
                      e.stopPropagation();
                      void nt().bookmarksRemove(space.id, b.id);
                    }}
                    className="nt-r-sm shrink-0 p-1 opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--nt-bg-hover)]"
                    style={{ color: "var(--nt-text-3)" }}
                  >
                    <X size={13} strokeWidth={1.75} />
                  </button>
                </div>
              )}
            </div>
  );
}

function BookmarksSection({
  space,
  open,
  onToggle,
}: {
  space: SpaceState;
  open: boolean;
  onToggle: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; bm: BookmarkState } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  return (
    <section className="mt-3">
      <button
        onClick={onToggle}
        className="nt-r-sm flex w-full items-center gap-1.5 px-1 py-1 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
      >
        {open ? (
          <ChevronDown size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <ChevronRight size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        <BookmarkIcon size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        <span className="nt-micro">Bookmarks</span>
        <span
          className="nt-num ml-auto pr-1 text-[11px]"
          style={{ color: "var(--nt-text-faint)" }}
        >
          {space.bookmarks.length}
        </span>
      </button>
      {open && (
        <div className="nt-fade-in mt-1 space-y-1">
          {space.bookmarks.length === 0 && (
            <p className="px-2.5 py-2 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              Star a page in the toolbar to keep it here.
            </p>
          )}
          {(() => {
            const groups = new Map<string | null, BookmarkState[]>();
            for (const b of space.bookmarks) {
              const key = b.folder?.trim() ? b.folder!.trim() : null;
              const arr = groups.get(key);
              if (arr) arr.push(b);
              else groups.set(key, [b]);
            }
            const ordered = [...groups.entries()].sort(([a], [b]) => {
              if (a === null) return -1;
              if (b === null) return 1;
              return a.localeCompare(b);
            });
            return ordered.map(([folder, items]) => (
              <div key={folder ?? "__unfiled"}>
                {folder && (
                  <p
                    className="nt-micro mt-2 px-2.5 pb-0.5"
                    style={{ color: "var(--nt-text-faint)" }}
                  >
                    {folder}
                  </p>
                )}
                {items.map((b) => (
                  <BookmarkRow
                    key={b.id}
                    b={b}
                    space={space}
                    renamingId={renamingId}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    setRenamingId={setRenamingId}
                    setMenu={setMenu}
                  />
                ))}
              </div>
            ));
          })()}
        </div>
      )}
      {menu && (
        <BookmarkMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setRenameValue(menu.bm.name);
            setRenamingId(menu.bm.id);
          }}
          onRemove={() => void nt().bookmarksRemove(space.id, menu.bm.id)}
        />
      )}
    </section>
  );
}

function BookmarkMenu({
  x,
  y,
  onClose,
  onRename,
  onRemove,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onRemove: () => void;
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
  return (
    <div
      ref={ref}
      className="nt-popover nt-r-md fixed z-[70] w-44 border p-1.5 shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 190),
        top: Math.min(y, window.innerHeight - 120),
        background: "var(--nt-bg-overlay)",
        borderColor: "var(--nt-border)",
      }}
      role="menu"
    >
      <button className={itemCls} style={{ color: "var(--nt-text-1)" }} onClick={() => { onClose(); onRename(); }} role="menuitem">
        <Pencil size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} /> Rename
      </button>
      <button className={itemCls} style={{ color: "var(--nt-text-1)" }} onClick={() => { onClose(); onRemove(); }} role="menuitem">
        <Trash2 size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} /> Remove
      </button>
    </div>
  );
}

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
          {archived.map((a) => (
            <div
              key={a.id}
              className="nt-r-sm group flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-[var(--nt-bg-hover)]"
            >
              <Favicon url={a.url} size={14} />
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
          ))}
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
