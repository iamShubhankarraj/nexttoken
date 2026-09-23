/**
 * Theme tokens → CSS variables on documentElement (:root).
 *
 * Pipeline (fixed 2026-09-21):
 * - The active Bit's tokens are the single source of truth (main store).
 * - BrowserContext fetches them and calls applyTokensToRoot(): every
 *   --nt-* variable lands on document.documentElement, so the whole
 *   chrome (sidebar, top strip, panels, overlays) re-skins at once.
 * - The computed vars are mirrored to localStorage; theme-boot.js (a
 *   parser-blocking script in index.html) re-applies them before first
 *   paint on relaunch, so there is no dark→light flash.
 * - repairLegacyTokens() heals themes saved while the Appearance toggle
 *   only flipped `mode` without swapping the palette (pre-fix bug left
 *   {mode:'light'} on dark surfaces and vice versa).
 */

import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  asTriple,
  tokensToCssVars,
  type ThemeTokens,
} from "../shared/ipc";

export interface RootThemeStyle {
  vars: Record<string, string>;
  colorScheme: "dark" | "light";
}

export function rootThemeStyle(tokens: ThemeTokens): RootThemeStyle {
  const all = tokensToCssVars(tokens);
  const colorScheme = (all["color-scheme"] === "light" ? "light" : "dark") as
    | "dark"
    | "light";
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k !== "color-scheme") vars[k] = v;
  }
  return { vars, colorScheme };
}

/** localStorage key for the pre-paint vars mirror (see public/theme-boot.js). */
export const THEME_MIRROR_KEY = "nt.theme.vars.mirror.v1";

/**
 * Paint tokens onto documentElement (:root) immediately and mirror the
 * computed vars for the next launch's pre-paint boot script.
 */
export function applyTokensToRoot(tokens: ThemeTokens): void {
  const { vars, colorScheme } = rootThemeStyle(tokens);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.setProperty("color-scheme", colorScheme);
  try {
    localStorage.setItem(
      THEME_MIRROR_KEY,
      JSON.stringify({ vars, colorScheme }),
    );
  } catch {
    /* private mode / quota — the live paint above already applied */
  }
}

/** Relative luminance of a #rrggbb / #rgb color, 0..1. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return 0.5; // unknown format — don't trigger a repair
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const c = [0, 2, 4].map((i) => {
    const s = parseInt(h.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Heal themes persisted while the Appearance toggle only flipped `mode`
 * without swapping the surface palette: light mode on dark surfaces (or
 * dark mode on light surfaces) never rendered as intended. Re-seed from
 * the matching mode defaults, preserving the Bit's identity (spaceColor)
 * and geometry (radiusScale). Returns the input unchanged when healthy.
 */
export function repairLegacyTokens(t: ThemeTokens): ThemeTokens {
  const filled = fillSidebarPaint(fillMissingSidebarBg(t));
  const healed = healSidebarVsMode(filled);
  const bgLum = luminance(healed.bgBase);
  const surfaceMatchesMode =
    (healed.mode === "light" && bgLum >= 0.4) ||
    (healed.mode === "dark" && bgLum < 0.4);
  if (surfaceMatchesMode) return healed;
  const base = healed.mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  return {
    ...base,
    spaceColor: healed.spaceColor,
    radiusScale: healed.radiusScale,
    mode: healed.mode,
  };
}

/**
 * Sidebar paint guard: a mid-tone gray sidebarBg on a dark theme (or a
 * near-black one on a light theme) is a stale experiment, not intent — the
 * design direction is warm charcoal. Heal it back to the mode default so
 * the sidebar can never render the wrong theme. Subtle customs (Bit-color
 * tints, near-default charcoals) are left alone.
 */
function healSidebarVsMode(t: ThemeTokens): ThemeTokens {
  const lum = luminance(t.sidebarBg ?? "");
  const darkMode = t.mode === "dark";
  const wrong = darkMode ? lum >= 0.12 : lum <= 0.5;
  if (!wrong) return t;
  const base = darkMode ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
  return { ...t, sidebarBg: base.sidebarBg };
}

/**
 * Backfill the whole-sidebar paint for themes saved before it existed
 * (v0.5.5): missing/invalid sidebarBg falls back to the mode default, so
 * old themes render exactly as before and the pristine-default migration
 * keeps working.
 */
function fillMissingSidebarBg(t: ThemeTokens): ThemeTokens {
  if (/^#[0-9a-f]{6}$/i.test(t.sidebarBg ?? "")) return t;
  const base = t.mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  return { ...t, sidebarBg: base.sidebarBg };
}

/**
 * Backfill the sidebar paint fields added later (grain strength + the two
 * 3-stop gradients). Themes saved before these existed have none of them, so
 * they normalise to explicit defaults — flat, untextured — which is exactly
 * how those themes already rendered. Also drops a partially-filled gradient
 * (a half-valid triple would paint a broken wash).
 */
function fillSidebarPaint(t: ThemeTokens): ThemeTokens {
  const tex = typeof t.sidebarTexture === "number" ? t.sidebarTexture : 0;
  return {
    ...t,
    sidebarTexture: Math.min(1, Math.max(0, tex)),
    sidebarGrad: asTriple(t.sidebarGrad),
    agentGrad: asTriple(t.agentGrad),
  };
}

/** Mix two #rrggbb colors: t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a)?.[1] ?? "808080";
  const pb = /^#([0-9a-f]{6})$/i.exec(b)?.[1] ?? "808080";
  const ch = (i: number) =>
    Math.round(
      parseInt(pa.slice(i, i + 2), 16) * (1 - t) +
        parseInt(pb.slice(i, i + 2), 16) * t,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

/** localStorage key: Bit ids whose themes were seen by the default migration. */
const THEME_TOUCHED_KEY = "nt.theme.touched.v1";

/** Token fields compared when detecting the untouched legacy dark default. */
const PRISTINE_COMPARE_KEYS: (keyof ThemeTokens)[] = [
  "bgBase", "bgSubtle", "sidebarBg", "bgRaised", "bgOverlay", "bgHover",
  "border", "borderStrong",
  "text1", "text2", "text3", "textFaint",
  "accent", "accentSoft", "accentText",
  "radiusScale", "mode",
];

function readTouched(): Record<string, true> {
  try {
    const raw = localStorage.getItem(THEME_TOUCHED_KEY);
    if (raw) return JSON.parse(raw) as Record<string, true>;
  } catch {
    /* corrupted — treat as untouched */
  }
  return {};
}

function writeTouched(touched: Record<string, true>): void {
  try {
    localStorage.setItem(THEME_TOUCHED_KEY, JSON.stringify(touched));
  } catch {
    /* private mode / quota — migration simply re-runs next launch */
  }
}

/**
 * Mark a Bit's theme as deliberately seen/touched (any ThemeEditor edit or
 * a completed migration check). After this, the one-time light-default
 * migration never fires for the Bit again.
 */
export function stampThemeTouched(bitId: string): void {
  const touched = readTouched();
  if (touched[bitId]) return;
  touched[bitId] = true;
  writeTouched(touched);
}

/** True when the tokens are byte-identical to the legacy dark seed. */
function isPristineDarkDefault(t: ThemeTokens): boolean {
  return PRISTINE_COMPARE_KEYS.every((k) => t[k] === DEFAULT_DARK_TOKENS[k]);
}

/**
 * One-time migration to the Dia-inspired light default: Bits that still
 * carry the untouched legacy dark seed (fresh installs from before the
 * default flipped) are re-seeded to the light palette, preserving the
 * Bit's identity color and corner geometry. A deliberately chosen or
 * customized dark theme is never "pristine", so it is left alone.
 * Returns the reseeded tokens, or null when no migration applies.
 */
export function migrateLegacyDefault(
  bitId: string,
  tokens: ThemeTokens,
): ThemeTokens | null {
  const touched = readTouched();
  if (touched[bitId]) return null;
  touched[bitId] = true;
  writeTouched(touched);
  if (tokens.mode === "dark" && isPristineDarkDefault(tokens)) {
    return {
      ...DEFAULT_LIGHT_TOKENS,
      spaceColor: tokens.spaceColor,
      radiusScale: tokens.radiusScale,
      mode: "light",
    };
  }
  return null;
}
