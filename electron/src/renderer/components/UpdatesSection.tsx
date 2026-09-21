/**
 * Settings → Updates: the in-app updater UI.
 *
 * Custom feed checker (NOT electron-updater — the app is unsigned, so
 * Squirrel.Mac can't install). Honest UX: check on demand / on launch,
 * download with progress, then "Restart to update" performs a scripted
 * .app swap. No silent background updates, ever.
 */

import { ArrowDownToLine, Check, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { nt } from "../nt";
import type { UpdateEvent, UpdateStatus } from "../../shared/ipc";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatRate(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [feedInput, setFeedInput] = useState("");
  const [feedSaved, setFeedSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await nt().updatesStatus();
      setStatus(s);
      setFeedInput((prev) => (feedSaved ? prev : s.feedUrl));
    } catch {
      /* bridge unavailable */
    }
  }, [feedSaved]);

  useEffect(() => {
    void refresh();
    let off: (() => void) | undefined;
    try {
      off = nt().onUpdateEvent((e: UpdateEvent) => {
        if (e.type === "progress") {
          setRate(e.bytesPerSec);
          setStatus((prev) =>
            prev ? { ...prev, state: "downloading", progressPct: e.pct } : prev,
          );
          return;
        }
        // All other events: re-pull the canonical status.
        void refresh();
      });
    } catch {
      /* no bridge */
    }
    return () => off?.();
  }, [refresh]);

  const doCheck = async () => {
    setBusy(true);
    try {
      await nt().updatesCheck();
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const doDownload = async () => {
    setBusy(true);
    try {
      await nt().updatesDownload();
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const doInstall = async () => {
    // The main process quits the app to perform the swap — no post-call UI.
    await nt().updatesInstall();
  };

  const saveFeed = async () => {
    setBusy(true);
    try {
      const s = await nt().updatesSetFeedUrl(feedInput.trim());
      setStatus(s);
      setFeedSaved(true);
      setTimeout(() => setFeedSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (on: boolean) => {
    const s = await nt().updatesSetAutoCheck(on);
    setStatus(s);
  };

  const stateLine = () => {
    if (!status) return null;
    switch (status.state) {
      case "checking":
        return (
          <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            Checking for updates…
          </p>
        );
      case "available":
        return (
          <p className="text-[12.5px]" style={{ color: "var(--nt-text-1)" }}>
            <span style={{ color: "var(--nt-accent)" }} className="font-medium">
              Next Token {status.availableVersion} is available
            </span>
            {status.availableSize ? ` (${formatBytes(status.availableSize)} download)` : ""}.
          </p>
        );
      case "downloading":
        return (
          <div>
            <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              Downloading {status.availableVersion}… {status.progressPct ?? 0}%
              {rate > 0 && ` (${formatRate(rate)})`}
            </p>
            <div
              className="nt-r-sm mt-2 h-1.5 w-full overflow-hidden"
              style={{ background: "var(--nt-bg-hover)" }}
            >
              <div
                className="h-full transition-all"
                style={{
                  width: `${status.progressPct ?? 0}%`,
                  background: "var(--nt-accent)",
                }}
              />
            </div>
          </div>
        );
      case "downloaded":
        return (
          <p className="text-[12.5px]" style={{ color: "#6fa287" }}>
            <Check size={13} className="mr-1 inline" />
            Next Token {status.availableVersion} downloaded and verified — ready to install.
          </p>
        );
      case "error":
        return (
          <p className="text-[12.5px]" style={{ color: "#d97362" }}>
            <X size={13} className="mr-1 inline" />
            {status.detail || "Update failed."}
          </p>
        );
      case "no-feed":
        return (
          <p className="text-[12.5px]" style={{ color: "#c49e4a" }}>
            No update feed configured yet — paste one below to enable in-app updates.
          </p>
        );
      default:
        return (
          <p className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
            You're on the latest version.
            {status.lastCheckedAt
              ? ` Last checked ${new Date(status.lastCheckedAt).toLocaleString()}.`
              : " Never checked."}
          </p>
        );
    }
  };

  return (
    <div>
      <h3 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
        Updates
      </h3>
      <div
        className="nt-r-md border p-4"
        style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ArrowDownToLine size={18} strokeWidth={1.75} style={{ color: "var(--nt-text-2)" }} />
            <div>
              <p className="text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                Next Token {status?.version ?? "…"}
              </p>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                One click to download, one click to restart — no re-download from Drive.
              </p>
            </div>
          </div>
          <button
            onClick={() => void doCheck()}
            disabled={busy || status?.state === "checking" || status?.state === "downloading"}
            className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
          >
            <RefreshCw size={13} strokeWidth={1.75} />
            Check for updates
          </button>
        </div>

        <div className="mt-3">{stateLine()}</div>

        {status?.state === "available" && (
          <button
            onClick={() => void doDownload()}
            disabled={busy}
            className="nt-r-sm mt-3 flex items-center gap-1.5 border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
            style={{
              borderColor: "var(--nt-accent)",
              color: "var(--nt-accent)",
            }}
          >
            <ArrowDownToLine size={14} strokeWidth={1.75} />
            Download update
          </button>
        )}
        {status?.state === "downloaded" && (
          <button
            onClick={() => void doInstall()}
            className="nt-r-sm mt-3 px-3 py-1.5 text-[12.5px] font-medium transition-opacity hover:opacity-90"
            style={{ background: "var(--nt-accent)", color: "#1a1512" }}
          >
            Restart to update
          </button>
        )}

        {/* ------------------------- feed settings ------------------------- */}
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--nt-border)" }}>
          <p className="text-[12.5px] font-medium" style={{ color: "var(--nt-text-2)" }}>
            Update feed
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            Static HTTPS location serving <code>latest-mac.yml</code> and the release zip.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              value={feedInput}
              onChange={(e) => setFeedInput(e.target.value)}
              placeholder="https://updates.example.com/mac-arm64"
              spellCheck={false}
              className="nt-r-sm min-w-0 flex-1 border bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            />
            <button
              onClick={() => void saveFeed()}
              disabled={busy}
              className="nt-r-sm shrink-0 border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            >
              {feedSaved ? "Saved ✓" : "Save"}
            </button>
          </div>
          <label
            className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12.5px]"
            style={{ color: "var(--nt-text-2)" }}
          >
            <input
              type="checkbox"
              checked={status?.autoCheck ?? true}
              onChange={(e) => void toggleAuto(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#E8A33D]"
            />
            Check automatically on launch and every 12 hours
          </label>
        </div>

        <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: "var(--nt-text-3)" }}>
          Honest note: this app is unsigned, so updates can't install silently like Chrome.
          "Restart to update" swaps the app bundle via a helper script (your old copy is kept
          as a backup until the new one launches). If the app lives somewhere Next Token
          can't write to, you'll get the new app in Downloads with three manual steps instead.
        </p>
      </div>
    </div>
  );
}
