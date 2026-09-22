/**
 * DownloadsPage — Settings → Downloads (v0.6.3, impl-5).
 *
 * The full download manager: every recent download with size, progress,
 * state and time; pause / resume / cancel / retry / reveal / open; clear
 * finished; the download-location setting; auto-open file types.
 * The DownloadPill stays as the transient floating companion.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { nt } from "../nt";
import type { DownloadRecord, DownloadUiEvent } from "../../shared/ipc";
import { requestSettingsSection } from "./settingsNav";

export function openDownloadsSettings(): void {
  // Called from the DownloadPill's "All downloads" footer.
  void nt().uiSetSettingsOpen(true);
  requestSettingsSection("downloads");
}

function fmtBytes(n: number): string {
  if (n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const now = Date.now();
  const diff = now - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  const today = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

const STATE_LABEL: Record<DownloadRecord["state"], string> = {
  active: "Downloading",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function applyEvent(prev: DownloadRecord[], e: DownloadUiEvent): DownloadRecord[] {
  const merge = (patch: Partial<DownloadRecord>): DownloadRecord[] => {
    const found = prev.find((r) => r.id === e.id);
    const next: DownloadRecord = found
      ? { ...found, ...patch }
      : {
          id: e.id,
          filename: e.filename,
          url: "",
          received: 0,
          total: -1,
          state: "active",
          startedAt: Date.now(),
          ...patch,
        };
    return [next, ...prev.filter((r) => r.id !== e.id)].slice(0, 120);
  };
  switch (e.kind) {
    case "started":
      return merge({ state: "active", received: 0, total: -1, startedAt: Date.now() });
    case "progress":
      return merge({ state: "active", received: e.received, total: e.total });
    case "paused":
      return merge({ state: "paused" });
    case "resumed":
      return merge({ state: "active" });
    case "done":
      return merge({ state: "done", path: e.path, endedAt: Date.now() });
    case "failed":
      return merge({
        state: e.reason === "cancelled" ? "cancelled" : "failed",
        reason: e.reason,
        endedAt: Date.now(),
      });
  }
}

export function DownloadsPage() {
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [dir, setDir] = useState<{ dir: string | null; defaultDir: string } | null>(null);
  const [autoOpen, setAutoOpen] = useState("");
  const [autoOpenSaved, setAutoOpenSaved] = useState(false);

  const refreshDir = useCallback(() => {
    nt().downloadsGetDir().then(setDir).catch(() => {});
  }, []);

  useEffect(() => {
    nt().downloadsList().then(setRecords).catch(() => {});
    nt().downloadsAutoOpenGet().then((t) => setAutoOpen(t.join(", "))).catch(() => {});
    refreshDir();
    const off = nt().onDownloadsEvent((e) => setRecords((prev) => applyEvent(prev, e)));
    return () => off();
  }, [refreshDir]);

  const hasFinished = useMemo(
    () => records.some((r) => r.state === "done" || r.state === "failed" || r.state === "cancelled"),
    [records]
  );

  const saveAutoOpen = () => {
    const exts = autoOpen.split(/[,\s]+/).filter(Boolean);
    nt().downloadsAutoOpenSet(exts).then((clean) => {
      setAutoOpen(clean.join(", "));
      setAutoOpenSaved(true);
      window.setTimeout(() => setAutoOpenSaved(false), 2500);
    }).catch(() => {});
  };

  return (
    <div className="space-y-6">
      {/* ---- location + auto-open --------------------------------------- */}
      <div>
        <h4 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
          Location
        </h4>
        <div className="flex items-center justify-between gap-3">
          <p className="nt-mono min-w-0 truncate text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
            {dir ? (dir.dir ?? `${dir.defaultDir} (ask every time)`) : "…"}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => nt().downloadsPickDir().then(() => refreshDir()).catch(() => {})}
              className="nt-r-sm border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            >
              Change…
            </button>
            <button
              type="button"
              onClick={() => nt().downloadsSetDir(null).then(() => refreshDir()).catch(() => {})}
              className="nt-r-sm border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            >
              Always ask
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          “Always ask” shows the save dialog for every download, like today.
        </p>
      </div>

      <div>
        <h4 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
          Auto-open file types
        </h4>
        <div className="flex items-center gap-2">
          <input
            value={autoOpen}
            onChange={(e) => setAutoOpen(e.target.value)}
            placeholder="pdf, png, dmg"
            spellCheck={false}
            className="nt-r-sm nt-mono min-w-0 flex-1 border px-3 py-1.5 text-[12.5px]"
            style={{
              borderColor: "var(--nt-border)",
              background: "var(--nt-bg-base)",
              color: "var(--nt-text-1)",
            }}
          />
          <button
            type="button"
            onClick={saveAutoOpen}
            className="nt-r-sm shrink-0 px-3 py-1.5 text-[12.5px] font-medium"
            style={{ background: "var(--nt-accent)", color: "#1c1512" }}
          >
            Save
          </button>
          {autoOpenSaved && (
            <span className="text-[12px]" style={{ color: "var(--nt-accent)" }}>
              Saved.
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Comma-separated extensions (no dots). Finished downloads of these
          types open automatically.
        </p>
      </div>

      {/* ---- the list ---------------------------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
            Downloads
          </h4>
          <button
            type="button"
            disabled={!hasFinished}
            onClick={() =>
              nt().downloadsClearFinished().then(() => nt().downloadsList().then(setRecords)).catch(() => {})
            }
            className="nt-r-sm flex items-center gap-1.5 border px-2.5 py-1 text-[12px] font-medium transition-opacity disabled:opacity-40"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
          >
            <Trash2 size={12} strokeWidth={1.75} /> Clear finished
          </button>
        </div>
        {records.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            Nothing downloaded yet this session.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {records.map((r) => {
              const pct =
                r.total > 0 ? Math.max(0, Math.min(100, Math.round((r.received / r.total) * 100))) : -1;
              const live = r.state === "active" || r.state === "paused";
              return (
                <li
                  key={r.id}
                  className="nt-r-sm border px-3 py-2"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  <div className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="shrink-0">
                      {r.state === "done" ? (
                        <CheckCircle2 size={15} strokeWidth={2} style={{ color: "var(--nt-accent)" }} />
                      ) : r.state === "failed" || r.state === "cancelled" ? (
                        <XCircle size={15} strokeWidth={2} style={{ color: "#e06c5b" }} />
                      ) : (
                        <Download size={15} strokeWidth={2} style={{ color: "var(--nt-text-3)" }} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium" style={{ color: "var(--nt-text-1)" }} title={r.filename}>
                        {r.filename}
                      </p>
                      <p className="text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
                        {STATE_LABEL[r.state]}
                        {live && r.received >= 0 && (
                          <> · {fmtBytes(r.received)}{r.total > 0 ? ` of ${fmtBytes(r.total)}` : ""}</>
                        )}
                        {" · "}{fmtTime(r.startedAt)}
                        {r.state === "failed" && r.reason && r.reason !== "cancelled" && (
                          <> · {r.reason}</>
                        )}
                      </p>
                      {live && (
                        <span className="nt-download-bar mt-1.5 block" aria-hidden="true">
                          <span className="nt-download-fill block" style={{ width: `${Math.max(0, pct)}%` }} />
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {r.state === "active" && (
                        <button type="button" title="Pause" onClick={() => void nt().downloadsPause(r.id)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                          <Pause size={13} strokeWidth={2} />
                        </button>
                      )}
                      {r.state === "paused" && (
                        <button type="button" title="Resume" onClick={() => void nt().downloadsResume(r.id)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                          <Play size={13} strokeWidth={2} />
                        </button>
                      )}
                      {live && (
                        <button type="button" title="Cancel" onClick={() => void nt().downloadsCancel(r.id)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                          <X size={13} strokeWidth={2} />
                        </button>
                      )}
                      {(r.state === "failed" || r.state === "cancelled") && (
                        <button type="button" title="Retry download" onClick={() => void nt().downloadsRetry(r.id)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                          <RotateCcw size={13} strokeWidth={2} />
                        </button>
                      )}
                      {r.state === "done" && r.path && (
                        <>
                          <button type="button" title="Open file" onClick={() => void nt().downloadsOpen(r.path!)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                            <ExternalLink size={13} strokeWidth={2} />
                          </button>
                          <button type="button" title="Reveal in Finder" onClick={() => void nt().downloadsReveal(r.path!)} className="nt-r-sm p-1.5 hover:bg-[var(--nt-bg-hover)]" style={{ color: "var(--nt-text-2)" }}>
                            <FolderOpen size={13} strokeWidth={2} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
