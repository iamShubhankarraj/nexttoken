/**
 * PasswordsPanel.tsx — Settings → Passwords.
 *
 * Lists every login in the encrypted vault (imported passwords and ones
 * saved via the save prompt share the vault): origin, username, masked
 * password, with:
 *  - Reveal: masked password shown only after the native approval dialog
 *    in main confirms (auto re-masks after 15s).
 *  - Copy: same approval gate; the password goes straight to the OS
 *    clipboard in main and never enters the renderer.
 *  - Delete: two-step inline confirmation.
 *  - "Never ask" sites: the per-origin save-prompt blocklist, with
 *    "Allow again" to remove an entry.
 *
 * Passwords themselves are never listed by any IPC — only the
 * reveal channel returns one, behind approval.
 */

import { Copy, Download, Eye, EyeOff, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { domainOf, nt } from "../nt";

interface StoredEntry {
  origin: string;
  username: string;
}

export function PasswordsPanel() {
  const [entries, setEntries] = useState<StoredEntry[] | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<{ key: string; password: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    nt()
      .passwordsList()
      .then((list) => setEntries(list))
      .catch(() => setEntries([]));
    nt()
      .passwordsBlocked()
      .then((b) => setBlocked(b))
      .catch(() => setBlocked([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto re-mask a revealed password after 15s.
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 15_000);
    return () => clearTimeout(t);
  }, [revealed]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4_000);
  };

  const keyOf = (e: StoredEntry) => `${e.origin}\u0000${e.username}`;

  const onReveal = (e: StoredEntry) => {
    const key = keyOf(e);
    if (revealed?.key === key) {
      setRevealed(null);
      return;
    }
    setBusy(key);
    nt()
      .passwordsReveal(e.origin, e.username)
      .then((pw) => {
        setBusy(null);
        if (pw) setRevealed({ key, password: pw });
        else flash("Reveal cancelled.");
      })
      .catch(() => {
        setBusy(null);
        flash("Could not reveal the password.");
      });
  };

  const onCopy = (e: StoredEntry) => {
    const key = keyOf(e);
    setBusy(key);
    nt()
      .passwordsCopy(e.origin, e.username)
      .then((r) => {
        setBusy(null);
        flash(r.ok ? "Password copied to clipboard." : "Copy cancelled.");
      })
      .catch(() => {
        setBusy(null);
        flash("Could not copy the password.");
      });
  };

  const onDelete = (e: StoredEntry) => {
    const key = keyOf(e);
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      return;
    }
    setConfirmDelete(null);
    setBusy(key);
    nt()
      .passwordsDelete(e.origin, e.username)
      .then((r) => {
        setBusy(null);
        if (r.ok) {
          if (revealed?.key === key) setRevealed(null);
          refresh();
          flash("Login deleted.");
        } else {
          flash("Could not delete the login.");
        }
      })
      .catch(() => {
        setBusy(null);
        flash("Could not delete the login.");
      });
  };

  const onUnblock = (origin: string) => {
    nt()
      .passwordsUnblock(origin)
      .then(() => refresh())
      .catch(() => flash("Could not update the list."));
  };

  // -- manual add / edit --------------------------------------------------
  const [editing, setEditing] = useState<
    { mode: "add" } | { mode: "edit"; original: StoredEntry } | null
  >(null);
  const [form, setForm] = useState({ origin: "", username: "", password: "" });

  const startAdd = () => {
    setForm({ origin: "https://", username: "", password: "" });
    setEditing({ mode: "add" });
  };

  const startEdit = (e: StoredEntry) => {
    // Editing never needs the stored password: the field is blank and an
    // empty password field means "keep the current one" in main.
    setForm({ origin: e.origin, username: e.username, password: "" });
    setEditing({ mode: "edit", original: e });
  };

  const submitForm = () => {
    if (!editing) return;
    const origin = form.origin.trim();
    const username = form.username.trim();
    if (!origin || !username || (editing.mode === "add" && !form.password)) {
      flash("Website, username, and a password are required.");
      return;
    }
    setBusy("form");
    nt()
      .passwordsAdd(
        origin,
        username,
        form.password,
        editing.mode === "edit" ? editing.original.username : undefined,
      )
      .then((r) => {
        setBusy(null);
        if (r.ok) {
          setEditing(null);
          refresh();
          flash(editing.mode === "add" ? "Login added." : "Login updated.");
        } else {
          flash(r.error ?? "Could not save the login.");
        }
      })
      .catch(() => {
        setBusy(null);
        flash("Could not save the login.");
      });
  };

  const onCsvImport = () => {
    setBusy("csv");
    nt()
      .passwordsCsvImport()
      .then((r) => {
        setBusy(null);
        if (r.ok) {
          refresh();
          flash(r.added > 0 ? `Imported ${r.added} login${r.added === 1 ? "" : "s"}.` : "Import canceled.");
        } else {
          flash(r.error ?? "Import failed.");
        }
      })
      .catch(() => {
        setBusy(null);
        flash("Import failed.");
      });
  };

  const onCsvExport = () => {
    setBusy("csv");
    nt()
      .passwordsCsvExport()
      .then((r) => {
        setBusy(null);
        if (r.ok && r.path) {
          flash("Passwords exported. Keep the file somewhere safe.");
        } else if (r.ok) {
          flash("Export canceled.");
        } else {
          flash(r.error ?? "Export failed.");
        }
      })
      .catch(() => {
        setBusy(null);
        flash("Export failed.");
      });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: "var(--nt-text-1)" }}
        >
          <KeyRound size={14} strokeWidth={1.75} /> Saved passwords
        </h3>
        <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Stored encrypted in this Mac's keychain. Passwords are filled,
          revealed, or copied only with your approval — never automatically.
        </p>
        {notice && (
          <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-2)" }}>
            {notice}
          </p>
        )}
        {editing && (
          <div
            className="nt-r-md mb-3 space-y-2 border p-3"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <div className="text-[12px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
              {editing.mode === "add" ? "Add login" : `Edit ${domainOf(editing.original.origin)}`}
            </div>
            <input
              type="url"
              className="nt-r-sm w-full border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--nt-border)", background: "var(--nt-surface-2)", color: "var(--nt-text-1)" }}
              placeholder="https://example.com"
              value={form.origin}
              readOnly={editing.mode === "edit"}
              onChange={(e) => setForm({ ...form, origin: e.target.value })}
            />
            <input
              type="text"
              className="nt-r-sm w-full border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--nt-border)", background: "var(--nt-surface-2)", color: "var(--nt-text-1)" }}
              placeholder="Username"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <input
              type="password"
              className="nt-r-sm w-full border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--nt-border)", background: "var(--nt-surface-2)", color: "var(--nt-text-1)" }}
              placeholder={editing.mode === "edit" ? "New password (blank = keep current)" : "Password"}
              value={form.password}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="nt-r-sm px-2.5 py-1 text-[12px] font-medium"
                style={{ background: "var(--nt-accent)", color: "#1a1208" }}
                disabled={busy === "form"}
                onClick={submitForm}
              >
                {busy === "form" ? "Saving…" : editing.mode === "add" ? "Add login" : "Save changes"}
              </button>
              <button
                type="button"
                className="nt-r-sm px-2.5 py-1 text-[12px]"
                style={{ color: "var(--nt-text-2)" }}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
            style={{ color: "var(--nt-accent)" }}
            onClick={startAdd}
          >
            <Plus size={13} /> Add login
          </button>
          <button
            type="button"
            className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
            style={{ color: "var(--nt-text-2)" }}
            disabled={busy === "csv"}
            onClick={onCsvImport}
          >
            <Upload size={13} /> {busy === "csv" ? "Working…" : "Import CSV"}
          </button>
          <button
            type="button"
            className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
            style={{ color: "var(--nt-text-2)" }}
            disabled={busy === "csv"}
            onClick={onCsvExport}
          >
            <Download size={13} /> Export CSV
          </button>
        </div>
        {entries === null ? (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            Checking…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            No saved passwords yet. When you sign in on a website, Next Token
            will ask before saving the password — or import them from another
            browser under Settings → Import.
          </p>
        ) : (
          <ul className="space-y-2">
            {entries.map((e) => {
              const key = keyOf(e);
              const isRevealed = revealed?.key === key;
              const isConfirming = confirmDelete === key;
              const isBusy = busy === key;
              return (
                <li
                  key={key}
                  className="nt-r-md flex flex-wrap items-center gap-x-3 gap-y-1 border px-3 py-2"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-[13px] font-medium"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {domainOf(e.origin)}
                    </div>
                    <div
                      className="truncate text-[12px]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      {e.username || "—"}
                    </div>
                  </div>
                  <div
                    className="nt-num text-[13px]"
                    style={{ color: "var(--nt-text-2)" }}
                    aria-label={isRevealed ? "Revealed password" : "Hidden password"}
                  >
                    {isRevealed ? revealed.password : "••••••••"}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
                      style={{ color: "var(--nt-text-2)" }}
                      disabled={isBusy}
                      onClick={() => onReveal(e)}
                      title={isRevealed ? "Hide password" : "Reveal password (asks first)"}
                    >
                      {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                      {isRevealed ? "Hide" : "Reveal"}
                    </button>
                    <button
                      type="button"
                      className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
                      style={{ color: "var(--nt-text-2)" }}
                      disabled={isBusy}
                      onClick={() => onCopy(e)}
                      title="Copy password to clipboard (asks first)"
                    >
                      <Copy size={13} /> Copy
                    </button>
                    <button
                      type="button"
                      className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
                      style={{ color: "var(--nt-text-2)" }}
                      disabled={isBusy}
                      onClick={() => startEdit(e)}
                      title="Change the username or password for this site"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="nt-r-sm flex items-center gap-1 px-2 py-1 text-[12px]"
                      style={{
                        color: isConfirming ? "#fff" : "#c0392b",
                        background: isConfirming ? "#c0392b" : "transparent",
                      }}
                      disabled={isBusy}
                      onClick={() => onDelete(e)}
                      title="Delete this login"
                    >
                      <Trash2 size={13} />
                      {isConfirming ? "Confirm delete" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {blocked.length > 0 && (
        <div>
          <h3
            className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
            style={{ color: "var(--nt-text-1)" }}
          >
            <EyeOff size={14} strokeWidth={1.75} /> Never ask to save
          </h3>
          <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            These sites won't trigger the save-password prompt.
          </p>
          <ul className="space-y-1.5">
            {blocked.map((origin) => (
              <li
                key={origin}
                className="nt-r-md flex items-center justify-between border px-3 py-1.5"
                style={{ borderColor: "var(--nt-border)" }}
              >
                <span
                  className="text-[13px]"
                  style={{ color: "var(--nt-text-2)" }}
                >
                  {domainOf(origin)}
                </span>
                <button
                  type="button"
                  className="nt-r-sm px-2 py-1 text-[12px]"
                  style={{ color: "var(--nt-accent)" }}
                  onClick={() => onUnblock(origin)}
                >
                  Allow again
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
