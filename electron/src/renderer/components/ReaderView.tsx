/**
 * ReaderView.tsx — reader-mode chrome.
 *
 * - `ReaderControls`: mounted inside the Omnibox (unfocused state). Shows
 *   the Reader button when the active tab's page looks like an article
 *   (`readerAvailable` from tab deltas / snapshot) and portals the floating
 *   toolbar while the article view is active.
 * - `ReaderToolbar`: floating actions for the active article view —
 *   Print…, Save as PDF, Screenshot (copy to clipboard / save as PNG),
 *   the per-site auto-reader toggle, and Exit reader.
 *
 * No global shortcuts are registered here: ⌘P keeps Chromium's native
 * print preview in guests, and ⌘S / ⌘⇧S stay with the sidebar until
 * Implementer 1 finishes the shortcut pass. Everything is button-driven.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  BookOpenText,
  Camera,
  Check,
  ChevronDown,
  FileDown,
  Loader2,
  Printer,
  X,
} from "lucide-react";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

type BusyKey = "print" | "pdf" | "shot" | null;

function ToolButton({
  title,
  label,
  onClick,
  busy,
  disabled,
  children,
}: {
  title: string;
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled || busy}
      className="nt-r-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-50"
      style={{ color: "var(--nt-text-2)" }}
    >
      {busy ? (
        <Loader2 size={14} strokeWidth={2} className="animate-spin" />
      ) : (
        children
      )}
      {label}
    </button>
  );
}

function ReaderToolbar({
  tabId,
  origin,
  host,
}: {
  tabId: string;
  origin: string;
  host: string;
}) {
  const [busy, setBusy] = useState<BusyKey>(null);
  const [shotOpen, setShotOpen] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shotRef = useRef<HTMLDivElement | null>(null);

  // Per-site auto-reader state for this origin.
  useEffect(() => {
    if (!origin.startsWith("http")) {
      setAutoOn(false);
      return;
    }
    let live = true;
    nt()
      .readerAutoState(origin)
      .then((v) => {
        if (live) setAutoOn(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [origin]);

  // Close the screenshot menu on outside click.
  useEffect(() => {
    if (!shotOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!shotRef.current?.contains(e.target as Node)) setShotOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [shotOpen]);

  // Auto-dismiss the error note.
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [note]);

  const run = async (
    key: Exclude<BusyKey, null>,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    quietCancel = true,
  ) => {
    setBusy(key);
    try {
      const r = await fn();
      if (!r.ok && !(quietCancel && r.error === "cancelled")) {
        setNote(`Couldn't complete that (${r.error ?? "unknown error"})`);
      }
    } catch {
      setNote("Couldn't complete that (unexpected error)");
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = () => {
    if (!origin.startsWith("http")) return;
    nt()
      .readerSetAuto(origin, !autoOn)
      .then((snap) => setAutoOn(!!snap.autoReader[origin]))
      .catch(() => {});
  };

  return createPortal(
    <div className="fixed left-1/2 top-[52px] z-[70] -translate-x-1/2">
      <div
        className="nt-r-full flex items-center gap-0.5 border px-2 py-1 shadow-xl"
        style={{
          background: "var(--nt-bg-raised)",
          borderColor: "var(--nt-border)",
        }}
        role="toolbar"
        aria-label="Reader tools"
      >
        <span
          className="flex items-center gap-1.5 px-2 text-[12px] font-semibold"
          style={{ color: "var(--nt-accent)" }}
        >
          <BookOpenText size={14} strokeWidth={2} />
          Reader
        </span>
        <span
          className="mx-1 h-4 w-px"
          style={{ background: "var(--nt-border)" }}
        />
        <ToolButton
          title="Print the article…"
          label="Print"
          busy={busy === "print"}
          onClick={() => void run("print", () => nt().printDialog(tabId))}
        >
          <Printer size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          title="Save the article as a PDF"
          label="PDF"
          busy={busy === "pdf"}
          onClick={() => void run("pdf", () => nt().printPdf(tabId))}
        >
          <FileDown size={14} strokeWidth={1.75} />
        </ToolButton>
        <div ref={shotRef} className="relative">
          <ToolButton
            title="Screenshot this page"
            label="Shot"
            busy={busy === "shot"}
            onClick={() => setShotOpen((o) => !o)}
          >
            <Camera size={14} strokeWidth={1.75} />
            <ChevronDown size={11} strokeWidth={2} />
          </ToolButton>
          {shotOpen && (
            <div
              className="nt-r-md absolute left-0 top-full mt-1 min-w-44 border py-1 shadow-xl"
              style={{
                background: "var(--nt-bg-raised)",
                borderColor: "var(--nt-border)",
              }}
            >
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-[12px] hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-1)" }}
                onClick={() => {
                  setShotOpen(false);
                  void run("shot", () =>
                    nt().captureScreenshot({ dest: "clipboard", tabId }),
                  );
                }}
              >
                Copy to clipboard
              </button>
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-[12px] hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-1)" }}
                onClick={() => {
                  setShotOpen(false);
                  void run("shot", () =>
                    nt().captureScreenshot({ dest: "file", tabId }),
                  );
                }}
              >
                Save as PNG…
              </button>
            </div>
          )}
        </div>
        <span
          className="mx-1 h-4 w-px"
          style={{ background: "var(--nt-border)" }}
        />
        <button
          type="button"
          title={
            origin.startsWith("http")
              ? `Always use Reader on ${host}`
              : "Auto-reader needs a web page"
          }
          aria-label={`Always use Reader on ${host}`}
          aria-pressed={autoOn}
          onClick={toggleAuto}
          disabled={!origin.startsWith("http")}
          className="nt-r-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-40"
          style={
            autoOn
              ? { color: "var(--nt-accent)" }
              : { color: "var(--nt-text-3)" }
          }
        >
          <span
            className="nt-r-sm flex h-3.5 w-3.5 items-center justify-center border"
            style={{
              borderColor: autoOn
                ? "var(--nt-accent)"
                : "var(--nt-text-3)",
              background: autoOn ? "var(--nt-accent-soft)" : "transparent",
            }}
          >
            {autoOn && <Check size={11} strokeWidth={3} />}
          </span>
          Auto
        </button>
        <ToolButton
          title="Exit Reader view"
          label="Exit"
          onClick={() => void nt().readerExit(tabId).catch(() => {})}
        >
          <X size={14} strokeWidth={1.75} />
        </ToolButton>
      </div>
      {note && (
        <div
          className="nt-r-full mx-auto mt-2 w-fit px-3 py-1.5 text-[12px] shadow-lg"
          style={{
            background: "var(--nt-bg-raised)",
            border: "1px solid var(--nt-border)",
            color: "var(--nt-text-1)",
          }}
          role="status"
        >
          {note}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function ReaderControls() {
  const { activeTab } = useBrowser();
  const tabId = activeTab?.id;
  const url = activeTab?.url ?? "";
  const available = !!activeTab?.readerAvailable;
  const active = !!activeTab?.readerActive;

  if (!tabId || !available) return null;

  const toggle = () => {
    if (active) void nt().readerExit(tabId).catch(() => {});
    else void nt().readerEnter(tabId).catch(() => {});
  };

  return (
    <>
      <button
        type="button"
        title={active ? "Exit Reader view" : "Show Reader view"}
        aria-label={active ? "Exit Reader view" : "Show Reader view"}
        aria-pressed={active}
        onClick={toggle}
        className="nt-r-full flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={
          active
            ? {
                color: "var(--nt-accent)",
                background: "var(--nt-accent-soft)",
              }
            : { color: "var(--nt-text-3)" }
        }
      >
        {active ? (
          <BookOpenText size={14} strokeWidth={2} />
        ) : (
          <BookOpen size={14} strokeWidth={2} />
        )}
        <span className="hidden xl:inline">Reader</span>
      </button>
      {active && (
        <ReaderToolbar tabId={tabId} origin={originOf(url)} host={hostOf(url)} />
      )}
    </>
  );
}
