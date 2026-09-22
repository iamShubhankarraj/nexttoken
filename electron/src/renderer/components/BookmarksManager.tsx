/**
 * BookmarksManager — Settings → Bookmarks (v0.6.3, impl-5).
 *
 * The manager over the existing per-Bit bookmarks: search across every Bit,
 * rename, delete, move between Bits, add new ones, and the bookmarks-bar
 * visibility + scope toggles. The flat sidebar list keeps working as-is.
 */
import { useEffect, useMemo, useState } from "react";
import { Bookmark, FolderInput, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useBrowser } from "../BrowserContext";
import { nt, domainOf } from "../nt";
import { refreshBookmarksBar } from "./BookmarksBar";

interface Row {
  id: string;
  name: string;
  url: string;
  folder?: string;
  createdAt: number;
  spaceId: string;
  spaceName: string;
}

export function BookmarksManager() {
  const { snapshot } = useBrowser();
  const [query, setQuery] = useState("");
  const [bar, setBar] = useState<{ visible: boolean; scope: "bit" | "all" }>({
    visible: true,
    scope: "bit",
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newSpace, setNewSpace] = useState("");

  useEffect(() => {
    nt().bookmarksBarGet().then(setBar).catch(() => {});
  }, []);

  const spaces = useMemo(
    () => snapshot?.spaces.map((s) => ({ id: s.id, name: s.name })) ?? [],
    [snapshot]
  );

  useEffect(() => {
    if (!newSpace && spaces.length > 0) setNewSpace(spaces[0]!.id);
  }, [spaces, newSpace]);

  const rows: Row[] = useMemo(() => {
    if (!snapshot) return [];
    const all: Row[] = snapshot.spaces.flatMap((s) =>
      s.bookmarks.map((b) => ({
        id: b.id,
        name: b.name,
        url: b.url,
        folder: b.folder,
        createdAt: b.createdAt,
        spaceId: s.id,
        spaceName: s.name,
      }))
    );
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.url.toLowerCase().includes(q) ||
            (r.folder ?? "").toLowerCase().includes(q)
        )
      : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }, [snapshot, query]);

  const setBarOpts = (v: { visible?: boolean; scope?: "bit" | "all" }) => {
    nt().bookmarksBarSet(v).then((s) => {
      setBar(s);
      refreshBookmarksBar();
    }).catch(() => {});
  };

  const startEdit = (r: Row) => {
    setEditing(r.id);
    setEditName(r.name);
  };
  const commitEdit = (r: Row) => {
    const name = editName.trim();
    setEditing(null);
    if (!name || name === r.name) return;
    void nt().bookmarksRename(r.spaceId, r.id, name).catch(() => {});
  };

  const remove = (r: Row) => {
    if (!window.confirm(`Remove the bookmark “${r.name}”?`)) return;
    void nt().bookmarksRemove(r.spaceId, r.id).catch(() => {});
  };

  const move = (r: Row, toSpaceId: string) => {
    if (!toSpaceId || toSpaceId === r.spaceId) return;
    void nt().bookmarksMove(r.spaceId, r.id, toSpaceId).catch(() => {});
  };

  const add = () => {
    const url = newUrl.trim();
    if (!url || !newSpace) return;
    void nt()
      .bookmarksAdd(newSpace, newName.trim() || url, url)
      .then(() => {
        setAdding(false);
        setNewName("");
        setNewUrl("");
      })
      .catch((e) => window.alert(String(e?.message ?? e)));
  };

  return (
    <div className="space-y-6">
      {/* ---- bar visibility ------------------------------------------------ */}
      <div>
        <h4 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
          Bookmarks bar
        </h4>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={bar.visible}
              onChange={(e) => setBarOpts({ visible: e.target.checked })}
              className="accent-[#E8A33D]"
            />
            <span className="text-[13px]" style={{ color: "var(--nt-text-1)" }}>
              Show the bookmarks bar under the toolbar
            </span>
          </label>
          <div className="flex items-center gap-2 pl-6">
            {(["bit", "all"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => setBarOpts({ scope })}
                className="nt-r-full border px-3 py-1 text-[12px] font-medium transition-colors"
                style={{
                  borderColor: bar.scope === scope ? "var(--nt-accent)" : "var(--nt-border)",
                  background: bar.scope === scope ? "var(--nt-accent-soft)" : "transparent",
                  color: bar.scope === scope ? "var(--nt-accent)" : "var(--nt-text-3)",
                }}
              >
                {scope === "bit" ? "Current Bit" : "All Bits"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ---- search + add -------------------------------------------------- */}
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
            placeholder="Search bookmarks"
            spellCheck={false}
            className="nt-r-sm w-full border py-1.5 pl-8 pr-3 text-[13px]"
            style={{
              borderColor: "var(--nt-border)",
              background: "var(--nt-bg-base)",
              color: "var(--nt-text-1)",
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-[12.5px] font-medium"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          <Plus size={13} strokeWidth={1.75} /> Add
        </button>
      </div>

      {adding && (
        <div
          className="nt-r-sm space-y-2 border p-3"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (optional — defaults to the URL)"
            className="nt-r-sm w-full border px-3 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)", color: "var(--nt-text-1)" }}
          />
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://…"
            spellCheck={false}
            className="nt-r-sm nt-mono w-full border px-3 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)", color: "var(--nt-text-1)" }}
          />
          <div className="flex items-center gap-2">
            <select
              value={newSpace}
              onChange={(e) => setNewSpace(e.target.value)}
              className="nt-r-sm border px-2 py-1.5 text-[12.5px]"
              style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)", color: "var(--nt-text-1)" }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} Bit
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={add}
              disabled={!newUrl.trim()}
              className="nt-r-sm px-4 py-1.5 text-[12.5px] font-medium disabled:opacity-40"
              style={{ background: "var(--nt-accent)", color: "#1c1512" }}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* ---- the list ------------------------------------------------------- */}
      {rows.length === 0 ? (
        <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          {query.trim() ? "No matches." : "No bookmarks yet."}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className="nt-r-sm group flex items-center gap-2.5 border px-3 py-1.5"
              style={{ borderColor: "var(--nt-border)" }}
            >
              <Bookmark size={13} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--nt-text-3)" }} />
              <div className="min-w-0 flex-1">
                {editing === r.id ? (
                  <input
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => commitEdit(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(r);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="nt-r-sm w-full border px-2 py-0.5 text-[12.5px]"
                    style={{ borderColor: "var(--nt-accent)", background: "var(--nt-bg-base)", color: "var(--nt-text-1)" }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => void nt().navGo(r.url)}
                    title={r.url}
                    className="block w-full text-left"
                  >
                    <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                      {r.name || domainOf(r.url)}
                    </span>
                    <span className="nt-mono block truncate text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                      {r.url}
                      {r.folder ? ` · ${r.folder}` : ""} · {r.spaceName} Bit
                    </span>
                  </button>
                )}
              </div>
              <select
                value={r.spaceId}
                onChange={(e) => move(r, e.target.value)}
                title="Move to Bit"
                className="nt-r-sm shrink-0 border px-1.5 py-1 text-[11.5px]"
                style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)", color: "var(--nt-text-3)" }}
              >
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="Rename"
                  onClick={() => startEdit(r)}
                  className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <Pencil size={12} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title="Remove bookmark"
                  onClick={() => remove(r)}
                  className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
        <FolderInput size={12} strokeWidth={1.75} />
        Use the Bit dropdown on a row to move it to another Bit.
      </p>
    </div>
  );
}
