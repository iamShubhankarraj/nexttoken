/**
 * BookmarksBar — the bookmarks strip under the toolbar (v0.6.3, impl-5).
 *
 * Toggleable (Settings → Bookmarks), showing either the current Bit's
 * bookmarks or every Bit's. Bookmarks with an import folder path render as
 * folder menus. The flat per-Bit sidebar list is untouched — this is the
 * Chrome-style bar on top of it.
 */
import { useEffect, useMemo, useState } from "react";
import { Bookmark, ChevronDown, Folder } from "lucide-react";
import { useBrowser } from "../BrowserContext";
import { nt, domainOf } from "../nt";
import type { BookmarkState } from "../../shared/ipc";
import { requestSettingsSection } from "./settingsNav";

interface BarBookmark extends BookmarkState {
  spaceName?: string;
}

function folderOf(b: BookmarkState): string | null {
  const f = (b.folder ?? "").trim();
  if (!f) return null;
  return f.split("/")[0]!.trim() || null;
}

export function BookmarksBar() {
  const { snapshot } = useBrowser();
  const [settings, setSettings] = useState<{ visible: boolean; scope: "bit" | "all" } | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);

  useEffect(() => {
    nt().bookmarksBarGet().then(setSettings).catch(() => {});
    const onRefresh = () => nt().bookmarksBarGet().then(setSettings).catch(() => {});
    window.addEventListener("nt:bookmarks-bar", onRefresh);
    return () => window.removeEventListener("nt:bookmarks-bar", onRefresh);
  }, []);

  const items: BarBookmark[] = useMemo(() => {
    if (!snapshot || !settings) return [];
    if (settings.scope === "all") {
      return snapshot.spaces.flatMap((s) =>
        s.bookmarks.map((b) => ({ ...b, spaceName: s.name }))
      );
    }
    const active = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId);
    return (active?.bookmarks ?? []).map((b) => ({ ...b }));
  }, [snapshot, settings]);

  if (!settings?.visible) return null;

  const folders = new Map<string, BarBookmark[]>();
  const loose: BarBookmark[] = [];
  for (const b of items) {
    const f = folderOf(b);
    if (f) {
      const arr = folders.get(f) ?? [];
      arr.push(b);
      folders.set(f, arr);
    } else {
      loose.push(b);
    }
  }

  const open = (b: BarBookmark) => {
    setOpenFolder(null);
    void nt().navGo(b.url);
  };

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2"
      style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)" }}
      role="toolbar"
      aria-label="Bookmarks bar"
    >
      {items.length === 0 && (
        <span className="px-2 text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
          No bookmarks yet — star a page to keep it here.
        </span>
      )}
      {[...folders.entries()].map(([name, list]) => (
        <div key={`folder:${name}`} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOpenFolder(openFolder === name ? null : name)}
            className="nt-r-sm flex items-center gap-1.5 px-2 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-2)" }}
            aria-expanded={openFolder === name}
          >
            <Folder size={12} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
            <span className="max-w-28 truncate">{name}</span>
            <ChevronDown size={11} strokeWidth={2} style={{ color: "var(--nt-text-3)" }} />
          </button>
          {openFolder === name && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpenFolder(null)} />
              <div
                className="nt-r-sm nt-popover absolute left-0 top-full z-50 mt-1 min-w-48 max-w-64 border py-1"
                style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-overlay)" }}
              >
                {list.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => open(b)}
                    title={b.url}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--nt-bg-hover)]"
                    style={{ color: "var(--nt-text-1)" }}
                  >
                    {b.favicon ? (
                      <img src={b.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Bookmark size={12} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--nt-text-3)" }} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{b.name || domainOf(b.url)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
      {loose.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => open(b)}
          title={b.spaceName ? `${b.url} · ${b.spaceName} Bit` : b.url}
          className="nt-r-sm flex max-w-44 shrink-0 items-center gap-1.5 px-2 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-2)" }}
        >
          {b.favicon ? (
            <img src={b.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Bookmark size={12} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--nt-text-3)" }} />
          )}
          <span className="truncate">{b.name || domainOf(b.url)}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          void nt().uiSetSettingsOpen(true);
          requestSettingsSection("bookmarks");
        }}
        className="ml-auto shrink-0 px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] nt-r-sm"
        style={{ color: "var(--nt-text-3)" }}
      >
        Manage
      </button>
    </div>
  );
}

/** Notify mounted bars that the bar settings changed (toggle/scope). */
export function refreshBookmarksBar(): void {
  window.dispatchEvent(new Event("nt:bookmarks-bar"));
}
