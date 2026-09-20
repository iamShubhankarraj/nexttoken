/**
 * Arc-style per-Bit theme editor — the star feature.
 *
 * Fields are driven by TOKEN_FIELDS (src/shared/ipc.ts):
 * - Space color: swatches from SPACE_PALETTE + a custom color input.
 *   Tints only the active-tab indicator bar, the space icon, and the
 *   2px sidebar top-edge wash — never large surfaces.
 * - Accent: the single ember accent (buttons, focus rings, selection).
 * - "Advanced" disclosure: the four layered surface tokens
 *   (bgBase / bgSubtle / bgRaised / bgOverlay).
 * - Corner roundness slider → multiplier over the 6/10/14px scale.
 * - Dark / light mode toggle.
 *
 * Tokens are read only through nt.themesGet() — never hardcoded.
 * Edits live-apply to the chrome instantly (preview) and persist via
 * nt.themesSet() with a short debounce; Reset restores main defaults.
 */

import { Check, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  SPACE_PALETTE,
  TOKEN_FIELDS,
  type ThemeTokens,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";
import { rootThemeStyle } from "../theme";

/** Paint tokens straight onto the app root for instant live preview. */
function applyPreview(tokens: ThemeTokens): void {
  const root = document.getElementById("nt-root");
  if (!root) return;
  const { vars, colorScheme } = rootThemeStyle(tokens);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.setProperty("color-scheme", colorScheme);
}

export function ThemeEditor({ spaceId }: { spaceId: string }) {
  const { refreshTheme } = useBrowser();
  const [tokens, setTokens] = useState<ThemeTokens | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setTokens(null);
    setLoadError(null);
    nt()
      .themesGet(spaceId)
      .then((t) => {
        if (alive) setTokens(t);
      })
      .catch((err) => {
        if (alive)
          setLoadError(
            err instanceof Error ? err.message : "Couldn't load theme tokens.",
          );
      });
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [spaceId]);

  const persist = (next: ThemeTokens) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      nt()
        .themesSet(spaceId, next)
        .then(() => refreshTheme())
        .catch(() => {
          /* preview stays; main keeps its copy */
        });
    }, 350);
  };

  const update = <K extends keyof ThemeTokens>(key: K, value: ThemeTokens[K]) => {
    setTokens((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      applyPreview(next); // instant chrome re-skin
      persist(next);
      return next;
    });
  };

  const reset = async () => {
    await nt().themesReset(spaceId);
    const fresh = await nt().themesGet(spaceId);
    setTokens(fresh);
    applyPreview(fresh);
    refreshTheme();
  };

  if (loadError) {
    return (
      <p className="text-[13px]" style={{ color: "#d97362" }}>
        {loadError}
      </p>
    );
  }
  if (!tokens) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading theme tokens…
      </p>
    );
  }

  const advancedFields = TOKEN_FIELDS.filter((f) => f.advanced);

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-3">
        <p className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
          This space's identity. Edits re-skin the chrome live; switching
          spaces is the delight moment — the whole browser changes with you.
        </p>
        <button
          onClick={() => void reset()}
          title="Reset to defaults"
          className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
        >
          <RotateCcw size={13} strokeWidth={1.75} /> Reset
        </button>
      </div>

      {/* Bit color — swatches + custom */}
      <FieldBlock label="Bit color" hint="Active-tab bar · Bit icon · sidebar wash">
        <div className="flex items-center gap-2">
          {SPACE_PALETTE.map((s) => {
            const active = tokens.spaceColor.toLowerCase() === s.value.toLowerCase();
            return (
              <button
                key={s.value}
                title={s.name}
                onClick={() => update("spaceColor", s.value)}
                className="nt-r-full flex h-8 w-8 items-center justify-center transition-transform hover:scale-110"
                style={{
                  background: s.value,
                  boxShadow: active
                    ? "0 0 0 2px var(--nt-bg-base), 0 0 0 4px var(--nt-accent)"
                    : "0 0 0 1px var(--nt-border-strong)",
                }}
              >
                {active && (
                  <Check size={14} strokeWidth={2.5} style={{ color: "#0b0b0d" }} />
                )}
              </button>
            );
          })}
          <label
            title="Custom space color"
            className="nt-r-full relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden transition-transform hover:scale-110"
            style={{
              background:
                "conic-gradient(#e8a33d, #9caf88, #7fa6a3, #8e9aaf, #a67c8e, #e8a33d)",
              boxShadow: "0 0 0 1px var(--nt-border-strong)",
            }}
          >
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(tokens.spaceColor) ? tokens.spaceColor : "#7fa6a3"}
              onChange={(e) => update("spaceColor", e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Custom space color"
            />
          </label>
        </div>
      </FieldBlock>

      {/* Accent */}
      <FieldBlock label="Accent" hint="Buttons · focus rings · selection (~5% of chrome)">
        <ColorRow
          value={tokens.accent}
          onChange={(v) => update("accent", v)}
        />
      </FieldBlock>

      {/* Corner roundness */}
      <FieldBlock label="Corner roundness" hint="Multiplier over the 6 / 10 / 14px scale">
        <span className="flex w-56 items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={tokens.radiusScale}
            onChange={(e) => update("radiusScale", Number(e.target.value))}
            className="nt-range w-full"
            aria-label="Corner roundness"
          />
          <span
            className="nt-num w-10 text-right text-[12px]"
            style={{ color: "var(--nt-text-2)" }}
          >
            {Math.round(tokens.radiusScale * 100)}%
          </span>
        </span>
      </FieldBlock>

      {/* Dark / light */}
      <FieldBlock label="Appearance" hint="Dark or light chrome">
        <div
          className="nt-r-sm flex border p-0.5"
          style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-base)" }}
          role="radiogroup"
          aria-label="Appearance"
        >
          {(["dark", "light"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={tokens.mode === m}
              onClick={() => update("mode", m)}
              className="nt-r-sm px-4 py-1.5 text-[12.5px] font-medium capitalize transition-colors"
              style={
                tokens.mode === m
                  ? { background: "var(--nt-accent-soft)", color: "var(--nt-accent)" }
                  : { color: "var(--nt-text-3)" }
              }
            >
              {m}
            </button>
          ))}
        </div>
      </FieldBlock>

      {/* Advanced: the four layered surfaces */}
      <button
        onClick={() => setAdvancedOpen((o) => !o)}
        className="nt-r-sm mt-1 flex w-full items-center gap-1.5 px-1 py-2 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
        aria-expanded={advancedOpen}
      >
        {advancedOpen ? (
          <ChevronDown size={14} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        ) : (
          <ChevronRight size={14} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
        )}
        <span className="nt-micro">Advanced surfaces</span>
        <span className="text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
          base · sidebar · cards · overlays
        </span>
      </button>
      {advancedOpen && (
        <div className="nt-fade-in mt-1 space-y-3 border-l-2 pl-4" style={{ borderColor: "var(--nt-border)" }}>
          {advancedFields.map(
            (f) =>
              f.kind === "color" && (
                <FieldBlock
                  key={f.key}
                  label={f.label}
                  hint={surfaceHint(f.key)}
                >
                  <ColorRow
                    value={tokens[f.key] as string}
                    onChange={(v) => update(f.key, v as never)}
                  />
                </FieldBlock>
              ),
          )}
        </div>
      )}

      {/* Preview strip */}
      <div
        className="nt-r-md mt-6 border p-3.5"
        style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
      >
        <p className="nt-micro">Preview</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span
            className="nt-r-sm px-3 py-1.5 text-[12.5px] font-semibold"
            style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
          >
            Accent button
          </span>
          <span
            className="nt-r-sm border px-3 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--nt-border-strong)", color: "var(--nt-text-1)" }}
          >
            Raised card
          </span>
          <span
            className="nt-r-sm px-3 py-1.5 text-[12.5px]"
            style={{ background: "var(--nt-accent-soft)", color: "var(--nt-accent)" }}
          >
            Selection wash
          </span>
          <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
            <span className="nt-r-full inline-block h-2.5 w-2.5" style={{ background: "var(--nt-space)" }} />
            Bit identity
          </span>
        </div>
      </div>
    </div>
  );
}

function surfaceHint(key: keyof ThemeTokens): string {
  switch (key) {
    case "bgBase":
      return "App base — deepest layer";
    case "bgSubtle":
      return "Sidebar background";
    case "bgRaised":
      return "Cards, panels";
    case "bgOverlay":
      return "Command bar, modals";
    default:
      return "";
  }
}

function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <p className="text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
        {label}
      </p>
      <p className="mb-2.5 mt-0.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
        {hint}
      </p>
      {children}
    </div>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="flex items-center gap-2.5">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#e8a33d"}
        onChange={(e) => onChange(e.target.value)}
        className="nt-color h-9 w-14"
        aria-label="Color"
      />
      <code className="nt-mono text-[12px]" style={{ color: "var(--nt-text-2)" }}>
        {value}
      </code>
    </span>
  );
}
