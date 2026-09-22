/**
 * StartupSettings — Settings → On startup (v0.6.3, impl-5).
 *
 * On-launch behavior: restore the last session (today's always-behavior),
 * open a fresh new-tab page, or open a fixed set of pages. Plus the
 * default-browser control (protocol registration + first-run nudge state).
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Globe, Plus, X } from "lucide-react";
import { nt } from "../nt";

type Mode = "restore" | "newtab" | "pages";

const MODES: Array<{ id: Mode; title: string; hint: string }> = [
  {
    id: "restore",
    title: "Restore the last session",
    hint: "Reopen the tabs you had open, per Bit. Pinned tabs always come back.",
  },
  {
    id: "newtab",
    title: "Open a new tab page",
    hint: "Start fresh with a single new tab in the active Bit.",
  },
  {
    id: "pages",
    title: "Open specific pages",
    hint: "Open the same set of pages every launch.",
  },
];

export function StartupSettings() {
  const [mode, setMode] = useState<Mode>("restore");
  const [pages, setPages] = useState<string[]>([]);
  const [newPage, setNewPage] = useState("");
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [making, setMaking] = useState(false);

  useEffect(() => {
    nt().startupGet().then((s) => {
      setMode(s.mode);
      setPages(s.pages);
    }).catch(() => {});
    nt().startupIsDefaultBrowser().then(setIsDefault).catch(() => {});
  }, []);

  const save = (m: Mode, p: string[]) => {
    nt().startupSet({ mode: m, pages: p }).then((s) => {
      setMode(s.mode);
      setPages(s.pages);
    }).catch(() => {});
  };

  const pickMode = (m: Mode) => {
    setMode(m);
    save(m, pages);
  };

  const addPage = () => {
    const u = newPage.trim();
    if (!/^https?:\/\//i.test(u) || pages.length >= 10) return;
    const next = [...pages, u];
    setPages(next);
    setNewPage("");
    save(mode, next);
  };

  const removePage = (u: string) => {
    const next = pages.filter((p) => p !== u);
    setPages(next);
    save(mode, next);
  };

  const makeDefault = () => {
    setMaking(true);
    void nt()
      .startupMakeDefaultBrowser()
      .then((r) => {
        setMaking(false);
        setIsDefault(r.isDefault);
      })
      .catch(() => setMaking(false));
  };

  return (
    <div className="space-y-7">
      {/* ---- on launch ------------------------------------------------------ */}
      <div>
        <h4 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
          On launch
        </h4>
        <div className="space-y-1.5">
          {MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => pickMode(m.id)}
                aria-pressed={active}
                className="nt-r-sm flex w-full items-start gap-3 border px-3 py-2.5 text-left transition-colors"
                style={{
                  borderColor: active ? "var(--nt-accent)" : "var(--nt-border)",
                  background: active ? "var(--nt-accent-soft)" : "transparent",
                }}
              >
                <span
                  className="nt-r-full mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border"
                  style={{ borderColor: active ? "var(--nt-accent)" : "var(--nt-border-strong)" }}
                >
                  {active && <span className="nt-r-full h-2 w-2" style={{ background: "var(--nt-accent)" }} />}
                </span>
                <span>
                  <span className="block text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                    {m.title}
                  </span>
                  <span className="block text-[12px]" style={{ color: "var(--nt-text-3)" }}>
                    {m.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {mode === "pages" && (
          <div className="mt-3 space-y-1.5">
            {pages.map((p) => (
              <div
                key={p}
                className="nt-r-sm flex items-center gap-2 border px-3 py-1.5"
                style={{ borderColor: "var(--nt-border)" }}
              >
                <span className="nt-mono min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--nt-text-2)" }}>
                  {p}
                </span>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => removePage(p)}
                  className="nt-r-sm shrink-0 p-1 hover:bg-[var(--nt-bg-hover)]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
            {pages.length < 10 && (
              <div className="flex items-center gap-2">
                <input
                  value={newPage}
                  onChange={(e) => setNewPage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addPage()}
                  placeholder="https://…"
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
                  onClick={addPage}
                  disabled={!/^https?:\/\//i.test(newPage.trim())}
                  className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-40"
                  style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
                >
                  <Plus size={13} strokeWidth={1.75} /> Add
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- default browser ------------------------------------------------ */}
      <div>
        <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
          <Globe size={14} strokeWidth={1.75} /> Default browser
        </h4>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
            {isDefault === null ? (
              "Checking…"
            ) : isDefault ? (
              <span className="flex items-center gap-1.5" style={{ color: "var(--nt-accent)" }}>
                <CheckCircle2 size={14} strokeWidth={2} /> Next Token is your default browser.
              </span>
            ) : (
              "Next Token is not your default browser."
            )}
          </p>
          {!isDefault && (
            <button
              type="button"
              onClick={makeDefault}
              disabled={making}
              className="nt-r-sm shrink-0 px-4 py-1.5 text-[13px] font-medium disabled:opacity-40"
              style={{ background: "var(--nt-accent)", color: "#1c1512" }}
            >
              {making ? "Working…" : "Make default"}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          On macOS the system-level default lives in System Settings → Desktop
          &amp; Dock → Default web browser — pick Next Token there too if the
          button alone doesn't stick.
        </p>
      </div>
    </div>
  );
}
