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
  const bgLum = luminance(t.bgBase);
  const surfaceMatchesMode =
    (t.mode === "light" && bgLum >= 0.4) ||
    (t.mode === "dark" && bgLum < 0.4);
  if (surfaceMatchesMode) return t;
  const base = t.mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  return {
    ...base,
    spaceColor: t.spaceColor,
    radiusScale: t.radiusScale,
    mode: t.mode,
  };
}

/** localStorage key: Bit ids whose themes were seen by the default migration. */
const THEME_TOUCHED_KEY = "nt.theme.touched.v1";

/** Token fields compared when detecting the untouched legacy dark default. */
const PRISTINE_COMPARE_KEYS: (keyof ThemeTokens)[] = [
  "bgBase", "bgSubtle", "bgRaised", "bgOverlay", "bgHover",
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
