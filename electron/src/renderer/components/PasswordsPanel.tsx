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

import { Copy, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
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
