/**
 * SearchEnginePicker — Settings → Search engine.
 *
 * Replaces the old freeform template input with an engine picker: preset
 * engines (Google, Brave, DuckDuckGo, Startpage, Ecosia) each with a keyword
 * shortcut, plus a Custom row that keeps the previous freeform template
 * working (existing values migrate to Custom automatically).
 */

import { useEffect, useState } from "react";
import { Check, Search } from "lucide-react";
import type { SearchEngineConfig } from "../../shared/ipc";
import {
  CUSTOM_ENGINE_ID,
  SEARCH_ENGINE_PRESETS,
} from "../../shared/searchEngines";
import { nt } from "../nt";

export function SearchEnginePicker() {
  const [cfg, setCfg] = useState<SearchEngineConfig | null>(null);
  const [custom, setCustom] = useState("");
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let alive = true;
    nt()
      .settingsGetSearchEngine()
      .then((c) => {
        if (!alive) return;
        setCfg(c);
        if (c.id === CUSTOM_ENGINE_ID) setCustom(c.template);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const choose = (id: string, template = "") => {
    nt()
      .settingsSetSearchEngine(id, template)
      .then((c) => {
        setCfg(c);
        if (c.id === CUSTOM_ENGINE_ID) setCustom(c.template);
        setSavedTick(true);
        window.setTimeout(() => setSavedTick(false), 1600);
      })
      .catch(() => {});
  };

  const saveCustom = () => {
    if (!custom.trim()) return;
    choose(CUSTOM_ENGINE_ID, custom.trim());
  };

  if (!cfg) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading…
      </p>
    );
  }

  return (
    <div>
      <div className="space-y-1.5">
        {SEARCH_ENGINE_PRESETS.map((p) => {
          const active = cfg.id === p.id;
          return (
            <button
              key={p.id}
              onClick={() => choose(p.id)}
              aria-pressed={active}
              className="nt-r-sm flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{
                borderColor: active
                  ? "var(--nt-accent)"
                  : "var(--nt-border)",
                background: active
                  ? "var(--nt-accent-soft)"
                  : "transparent",
              }}
            >
              <span
                className="nt-r-full flex h-5 w-5 shrink-0 items-center justify-center"
                style={{
                  border: "1px solid var(--nt-border-strong)",
                  color: active ? "var(--nt-accent)" : "transparent",
                }}
              >
                {active && <Check size={13} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="flex items-center gap-2 text-[13px] font-medium"
                  style={{ color: "var(--nt-text-1)" }}
                >
                  {p.name}
                  <kbd
                    className="nt-r-sm border px-1.5 py-px font-mono text-[10.5px]"
                    style={{
                      borderColor: "var(--nt-border)",
                      color: "var(--nt-text-3)",
                    }}
                  >
                    {p.keyword}
                  </kbd>
                </span>
                <span
                  className="block truncate text-[12px]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  {p.blurb}
                </span>
              </span>
            </button>
          );
        })}

        {/* Custom template row */}
        <div
          className="nt-r-sm border px-3 py-2"
          style={{
            borderColor:
              cfg.id === CUSTOM_ENGINE_ID
                ? "var(--nt-accent)"
                : "var(--nt-border)",
            background:
              cfg.id === CUSTOM_ENGINE_ID
                ? "var(--nt-accent-soft)"
                : "transparent",
          }}
        >
          <div className="flex items-center gap-3">
            <span
              className="nt-r-full flex h-5 w-5 shrink-0 items-center justify-center"
              style={{
                border: "1px solid var(--nt-border-strong)",
                color:
                  cfg.id === CUSTOM_ENGINE_ID
                    ? "var(--nt-accent)"
                    : "transparent",
              }}
            >
              {cfg.id === CUSTOM_ENGINE_ID && (
                <Check size={13} strokeWidth={3} />
              )}
            </span>
            <span
              className="text-[13px] font-medium"
              style={{ color: "var(--nt-text-1)" }}
            >
              Custom
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCustom();
              }}
              placeholder="https://example.com/search?q=%s"
              spellCheck={false}
              aria-label="Custom search engine template"
              className="nt-r-sm flex-1 border bg-[var(--nt-bg-base)] px-3 py-1.5 text-[13px] outline-none placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)]"
              style={{
                borderColor: "var(--nt-border)",
                color: "var(--nt-text-1)",
              }}
            />
            <button
              onClick={saveCustom}
              className="nt-r-sm px-4 py-1.5 text-[13px] font-semibold transition-transform hover:scale-[1.02]"
              style={{
                background: "var(--nt-accent)",
                color: "var(--nt-accent-text)",
              }}
            >
              {savedTick && cfg.id === CUSTOM_ENGINE_ID ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>
      </div>
      <p
        className="mt-2 flex items-start gap-1.5 text-[12px]"
        style={{ color: "var(--nt-text-3)" }}
      >
        <Search size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>
          Type a keyword first in the address bar to search that engine
          directly — e.g. <code className="nt-mono">g cats</code>,{" "}
          <code className="nt-mono">ddg rust</code>,{" "}
          <code className="nt-mono">brv news</code>. Use{" "}
          <code className="nt-r-sm bg-[var(--nt-bg-hover)] px-1">%s</code> for
          the query in a custom template.
        </span>
      </p>
    </div>
  );
}
