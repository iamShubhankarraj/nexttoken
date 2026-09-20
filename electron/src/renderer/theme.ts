/**
 * Theme tokens → inline style for the app root.
 *
 * tokensToCssVars() (src/shared/ipc.ts) is the single mapping from
 * ThemeTokens to --nt-* CSS variables. This file only splits the
 * `color-scheme` entry out so React gets a camelCase `colorScheme`
 * property; everything else passes through as custom properties.
 */

import type { CSSProperties } from "react";
import { tokensToCssVars, type ThemeTokens } from "../shared/ipc";

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

export function rootStyleProp(style: RootThemeStyle): CSSProperties {
  return { ...style.vars, colorScheme: style.colorScheme } as CSSProperties;
}
