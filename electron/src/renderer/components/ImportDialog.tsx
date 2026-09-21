/**
 * "Import from another browser" dialog.
 *
 * Explicit-click only: nothing is read until the user picks a browser and
 * presses Import. Main process owns all file/Keychain access; the renderer
 * only sees safe summaries and per-item counts.
 *
 * Opened from anywhere via: window.dispatchEvent(new CustomEvent("nt:open-import"))
 */
import { AlertTriangle, CheckCircle2, Download, Loader2, Lock, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  DetectedBrowserState,
  ImportRunResult,
  PasswordGuidance,
} from "../../shared/ipc";
import { nt } from "../nt";

export function openImportDialog() {
  window.dispatchEvent(new CustomEvent("nt:open-import"));
}

type Step = "loading" | "pick" | "running" | "done";
type Kind = "bookmarks" | "tabs" | "passwords";

const KIND_LABELS: Record<Kind, { label: string; hint: string }> = {
  bookmarks: {
    label: "Bookmarks",
    hint: "Folder structure preserved, added to this Bit",
  },
  tabs: {
    label: "Open & pinned tabs",
    hint: "Pinned tabs arrive pinned, opened in this Bit",
  },
  passwords: {
    label: "Saved passwords",
    hint: "macOS asks for permission; stored encrypted in this Mac's keychain",
  },
};

const BROWSER_ICONS: Record<string, string> = {
  chrome: "🌐",
  brave: "🦁",
  edge: "🌊",
  arc: "🖥️",
  safari: "🧭",
  firefox: "🦊",
};

function baseIdOf(id: string) {
  return id.split(":")[0];
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("loading");
  const [browsers, setBrowsers] = useState<DetectedBrowserState[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Kind[]>(["bookmarks", "tabs"]);
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    nt()
      .importDetect()
      .then((list) => {
        if (!alive) return;
        setBrowsers(list);
        setSelected(list.length > 0 ? list[0].id : null);
        setStep("pick");
      })
      .catch(() => {
        if (!alive) return;
        setLoadError("Could not look for installed browsers.");
        setStep("pick");
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleKind = useCallback((k: Kind) => {
    setKinds((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
  }, []);

  const run = useCallback(() => {
    if (!selected || kinds.length === 0) return;
    setStep("running");
    setResult(null);
    nt()
      .importRun(selected, kinds)
      .then((r) => {
        setResult(r);
        setStep("done");
      })
      .catch(() => {
        setResult({ ok: false, error: "Import failed. Nothing was changed." });
        setStep("done");
      });
  }, [selected, kinds]);

  const selectedBrowser = browsers.find((b) => b.id === selected) ?? null;

  return (
    <div
      className="nt-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Import from another browser"
    >
      <div
        className="nt-r-lg mt-[10vh] w-[min(560px,92vw)] border bg-[var(--nt-bg-raised)] p-5"
        style={{
          borderColor: "var(--nt-border-strong)",
          boxShadow: "var(--nt-shadow-card)",
          color: "var(--nt-text-1)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">
            Import from another browser
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <X size={16} />
          </button>
        </div>

        {step === "loading" && (
          <div className="flex items-center gap-2 py-8 text-[13px]" style={{ color: "var(--nt-text-3)" }}>
            <Loader2 size={16} className="animate-spin" />
            Looking for installed browsers…
          </div>
        )}

        {step === "pick" && (
          <>
            {loadError && (
              <p className="mb-3 text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                {loadError}
              </p>
            )}
            {browsers.length === 0 && !loadError ? (
              <p className="py-6 text-center text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                No other browsers were found on this Mac.
              </p>
            ) : (
              <>
                <p className="mb-2 text-[12px] font-medium" style={{ color: "var(--nt-text-3)" }}>
                  1 · Pick a browser
                </p>
                <div className="mb-4 space-y-1.5">
                  {browsers.map((b) => {
                    const active = selected === b.id;
                    return (
                      <button
                        key={b.id}
                        onClick={() => setSelected(b.id)}
                        aria-pressed={active}
                        className="nt-r-md flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors"
                        style={{
                          borderColor: active ? "var(--nt-accent)" : "var(--nt-border)",
                          background: active ? "var(--nt-accent-soft)" : "transparent",
                        }}
                      >
                        <span className="text-[18px]" aria-hidden>
                          {BROWSER_ICONS[baseIdOf(b.id)] ?? "🌐"}
                        </span>
                        <span className="flex-1">
                          <span className="block text-[13px] font-medium">{b.name}</span>
                          <span className="block text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                            {b.profileLabel}
                            {b.accessDenied ? " · needs file access (see below)" : ""}
                          </span>
                        </span>
                        {active && <CheckCircle2 size={16} style={{ color: "var(--nt-accent)" }} />}
                      </button>
                    );
                  })}
                </div>

                <p className="mb-2 text-[12px] font-medium" style={{ color: "var(--nt-text-3)" }}>
                  2 · Choose what to import
                </p>
                <div className="mb-4 space-y-1.5">
                  {(Object.keys(KIND_LABELS) as Kind[]).map((k) => {
                    const on = kinds.includes(k);
                    return (
                      <button
                        key={k}
                        onClick={() => toggleKind(k)}
                        aria-pressed={on}
                        className="nt-r-md flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors"
                        style={{
                          borderColor: on ? "var(--nt-accent)" : "var(--nt-border)",
                          background: on ? "var(--nt-accent-soft)" : "transparent",
                        }}
                      >
                        <span
                          className="nt-r-sm flex h-4 w-4 items-center justify-center border"
                          style={{
                            borderColor: on ? "var(--nt-accent)" : "var(--nt-border-strong)",
                            background: on ? "var(--nt-accent)" : "transparent",
                            color: "white",
                          }}
                          aria-hidden
                        >
                          {on && <CheckCircle2 size={12} />}
                        </span>
                        <span className="flex-1">
                          <span className="block text-[13px] font-medium">
                            {KIND_LABELS[k].label}
                          </span>
                          <span className="block text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                            {KIND_LABELS[k].hint}
                          </span>
                        </span>
                        {k === "passwords" && (
                          <Lock size={14} style={{ color: "var(--nt-text-faint)" }} aria-hidden />
                        )}
                      </button>
                    );
                  })}
                </div>

                {kinds.includes("passwords") && selectedBrowser && (
                  <PasswordConsentNote browserId={baseIdOf(selectedBrowser.id)} />
                )}

                <button
                  onClick={run}
                  disabled={!selected || kinds.length === 0}
                  className="nt-r-md flex w-full items-center justify-center gap-2 px-4 py-2.5 text-[14px] font-semibold transition-opacity disabled:opacity-40"
                  style={{ background: "var(--nt-accent)", color: "white" }}
                >
                  <Download size={15} />
                  Import into this Bit
                </button>
                <p className="mt-2 text-center text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
                  Nothing is read until you press Import. Duplicates are skipped, never overwritten.
                </p>
              </>
            )}
          </>
        )}

        {step === "running" && (
          <div className="flex items-center gap-2 py-8 text-[13px]" style={{ color: "var(--nt-text-3)" }}>
            <Loader2 size={16} className="animate-spin" />
            Importing…{kinds.includes("passwords") ? " macOS may ask for keychain permission." : ""}
          </div>
        )}

        {step === "done" && result && (
          <ImportResult result={result} onClose={onClose} onRetry={() => setStep("pick")} />
        )}
      </div>
    </div>
  );
}

function PasswordConsentNote({ browserId }: { browserId: string }) {
  const manual = browserId === "safari" || browserId === "firefox";
  return (
    <div
      className="nt-r-md mb-4 flex gap-2.5 border px-3 py-2.5 text-[12px]"
      style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-subtle)" }}
    >
      <Lock size={14} className="mt-0.5 shrink-0" style={{ color: "var(--nt-accent)" }} />
      <p style={{ color: "var(--nt-text-2)" }}>
        {manual ? (
          <>
            {browserId === "safari" ? "Safari" : "Firefox"} passwords can't be read
            automatically — after importing, you'll see steps to export them yourself.
          </>
        ) : (
          <>
            macOS will show a permission prompt to read this browser's saved-password
            key. Passwords are decrypted in memory only and stored encrypted in this
            Mac's keychain — never logged or sent anywhere.
          </>
        )}
      </p>
    </div>
  );
}

function ImportResult({
  result,
  onClose,
  onRetry,
}: {
  result: ImportRunResult;
  onClose: () => void;
  onRetry: () => void;
}) {
  if (result.accessDeniedPath) {
    return <FileAccessGuide path={result.accessDeniedPath} onRetry={onRetry} onClose={onClose} />;
  }
  if (result.passwordGuidance) {
    return <GuidanceSteps guidance={result.passwordGuidance} onClose={onClose} />;
  }
  if (!result.ok || !result.report) {
    return (
      <div className="py-4 text-center">
        <AlertTriangle size={22} className="mx-auto mb-2" style={{ color: "var(--nt-accent)" }} />
        <p className="text-[14px] font-medium">{result.error ?? "Import failed."}</p>
        <p className="mt-1 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Nothing was changed.
        </p>
        <button
          onClick={onClose}
          className="nt-r-md mt-4 px-4 py-2 text-[13px] font-medium"
          style={{ background: "var(--nt-accent)", color: "white" }}
        >
          Done
        </button>
      </div>
    );
  }
  const r = result.report;
  const rows: Array<[string, number]> = [
    ["Bookmarks added", r.bookmarksAdded],
    ["Bookmarks skipped (duplicates)", r.bookmarksSkippedDupes],
    ["Tabs opened", r.tabsOpened],
    ["Tabs pinned", r.tabsPinned],
  ];
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 size={18} style={{ color: "var(--nt-accent)" }} />
        <p className="text-[14px] font-semibold">Import complete</p>
      </div>
      <div className="nt-r-md mb-3 border" style={{ borderColor: "var(--nt-border)" }}>
        {rows.map(([label, n], i) => (
          <div
            key={label}
            className="flex items-center justify-between px-3 py-2 text-[13px]"
            style={{
              borderTop: i === 0 ? undefined : "1px solid var(--nt-border)",
              color: "var(--nt-text-2)",
            }}
          >
            <span>{label}</span>
            <span className="nt-num font-semibold" style={{ color: "var(--nt-text-1)" }}>
              {n}
            </span>
          </div>
        ))}
      </div>
      {r.warnings.length > 0 && (
        <div className="mb-3 max-h-40 overflow-y-auto">
          {r.warnings.map((w, i) => (
            <p key={i} className="mb-1 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              · {w}
            </p>
          ))}
        </div>
      )}
      <button
        onClick={onClose}
        className="nt-r-md w-full px-4 py-2.5 text-[14px] font-semibold"
        style={{ background: "var(--nt-accent)", color: "white" }}
      >
        Done
      </button>
    </div>
  );
}

function FileAccessGuide({
  path,
  onRetry,
  onClose,
}: {
  path: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle size={18} style={{ color: "var(--nt-accent)" }} />
        <p className="text-[14px] font-semibold">macOS blocked file access</p>
      </div>
      <p className="mb-3 text-[13px]" style={{ color: "var(--nt-text-2)" }}>
        Next Token couldn't read the other browser's data because macOS denied access.
        Grant access once, then retry:
      </p>
      <ol
        className="nt-r-md mb-3 list-decimal space-y-1.5 border px-3 py-2.5 pl-8 text-[13px]"
        style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
      >
        <li>Open System Settings → Privacy &amp; Security → Files and Folders</li>
        <li>Find <strong>Next Token</strong> in the list and allow access</li>
        <li>
          If it's not listed, use <strong>Full Disk Access</strong> on the same page and
          add Next Token with the <strong>+</strong> button
        </li>
        <li>Come back here and press Retry</li>
      </ol>
      <div className="flex gap-2">
        <button
          onClick={onRetry}
          className="nt-r-md flex-1 px-4 py-2.5 text-[14px] font-semibold"
          style={{ background: "var(--nt-accent)", color: "white" }}
        >
          Retry
        </button>
        <button
          onClick={onClose}
          className="nt-r-md px-4 py-2.5 text-[13px] font-medium border"
          style={{ borderColor: "var(--nt-border-strong)", color: "var(--nt-text-2)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function GuidanceSteps({
  guidance,
  onClose,
}: {
  guidance: PasswordGuidance;
  onClose: () => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[14px] font-semibold">{guidance.title}</p>
      <ol
        className="nt-r-md mb-4 list-decimal space-y-1.5 border px-3 py-2.5 pl-8 text-[13px]"
        style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
      >
        {guidance.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <button
        onClick={onClose}
        className="nt-r-md w-full px-4 py-2.5 text-[14px] font-semibold"
        style={{ background: "var(--nt-accent)", color: "white" }}
      >
        Done
      </button>
    </div>
  );
}
