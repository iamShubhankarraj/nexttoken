/**
 * DownloadPill — floating download manager, bottom-right of the window.
 *
 * Main shows the native save dialog for every guest download; progress and
 * completion events arrive here via nt.onDownloadsEvent. Active downloads
 * show an ember progress bar; finished ones offer "Reveal in Finder" and
 * auto-dismiss after a few seconds.
 */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, FolderOpen, XCircle } from "lucide-react";
import { nt } from "../nt";
import type { DownloadUiEvent } from "../../shared/ipc";

interface Item {
  id: string;
  filename: string;
  percent: number; // -1 = unknown
  state: "active" | "done" | "failed";
  path?: string;
}

const DISMISS_MS = 9000;

export function DownloadPill() {
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const dismissLater = (id: string) => {
      if (timers.current.has(id)) return;
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          setItems((prev) => prev.filter((i) => i.id !== id));
        }, DISMISS_MS),
      );
    };
    const off = nt().onDownloadsEvent((e: DownloadUiEvent) => {
      if (e.kind === "started" || e.kind === "progress") {
        setItems((prev) => {
          const next = prev.filter((i) => i.id !== e.id);
          next.unshift({
            id: e.id,
            filename: e.filename,
            percent: e.kind === "progress" ? e.percent : 0,
            state: "active",
          });
          return next.slice(0, 4);
        });
      } else if (e.kind === "done") {
        setItems((prev) => {
          const next = prev.filter((i) => i.id !== e.id);
          next.unshift({
            id: e.id,
            filename: e.filename,
            percent: 100,
            state: "done",
            path: e.path,
          });
          return next.slice(0, 4);
        });
        dismissLater(e.id);
      } else {
        // failed (including user-cancelled from the save dialog — keep it
        // quiet: just drop cancelled ones, show real failures briefly)
        if (e.reason === "cancelled") {
          setItems((prev) => prev.filter((i) => i.id !== e.id));
          return;
        }
        setItems((prev) => {
          const next = prev.filter((i) => i.id !== e.id);
          next.unshift({
            id: e.id,
            filename: e.filename,
            percent: 0,
            state: "failed",
          });
          return next.slice(0, 4);
        });
        dismissLater(e.id);
      }
    });
    return () => {
      off();
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="nt-download-pill" role="status" aria-label="Downloads">
      {items.map((it) => (
        <div key={it.id} className="nt-download-row">
          <span className="nt-download-icon" aria-hidden="true">
            {it.state === "done" ? (
              <CheckCircle2 size={14} strokeWidth={2} style={{ color: "var(--nt-accent)" }} />
            ) : it.state === "failed" ? (
              <XCircle size={14} strokeWidth={2} style={{ color: "#e06c5b" }} />
            ) : (
              <Download size={14} strokeWidth={2} style={{ color: "var(--nt-text-2)" }} />
            )}
          </span>
          <div className="nt-download-main">
            <span className="nt-download-name" title={it.filename}>
              {it.filename}
            </span>
            {it.state === "active" ? (
              <span className="nt-download-bar" aria-hidden="true">
                <span
                  className="nt-download-fill"
                  style={{ width: `${Math.max(0, it.percent)}%` }}
                />
              </span>
            ) : (
              <span className="nt-download-sub">
                {it.state === "done" ? "Download complete" : "Download failed"}
              </span>
            )}
          </div>
          {it.state === "done" && it.path ? (
            <button
              type="button"
              className="nt-download-reveal"
              onClick={() => void nt().downloadsReveal(it.path!)}
              title="Reveal in Finder"
            >
              <FolderOpen size={13} strokeWidth={2} />
              <span>Reveal</span>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
