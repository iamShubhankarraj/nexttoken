/**
 * Renderer-side helpers. `nt()` is the only bridge to the main process
 * (window.nt, defined by the preload from src/shared/ipc.ts). Never
 * import 'electron' in the renderer.
 */

import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  BookOpen,
  Briefcase,
  CalendarDays,
  Clapperboard,
  Cloud,
  Code2,
  FileText,
  GitBranch,
  Globe,
  Hash,
  Mail,
  MapPin,
  MessageCircle,
  Music,
  Newspaper,
  PenTool,
  ShoppingCart,
  Video,
} from "lucide-react";
import type { NextTokenAPI } from "../shared/ipc";

export function nt(): NextTokenAPI {
  if (!window.nt) {
    throw new Error("window.nt bridge is unavailable — is the preload script loaded?");
  }
  return window.nt;
}

/** Host (or best-effort fallback) for a URL string. */
export function domainOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

const ICON_RULES: Array<[RegExp, LucideIcon]> = [
  [/github|gitlab/, GitBranch],
  [/youtube|youtu\.be/, Clapperboard],
  [/(^|\.)x\.com|twitter/, AtSign],
  [/gmail|mail\.|outlook|proton/, Mail],
  [/calendar/, CalendarDays],
  [/figma|design/, PenTool],
  [/slack/, Hash],
  [/spotify|music/, Music],
  [/notion|docs\.google|confluence|wiki/, FileText],
  [/stackoverflow|stackexchange/, MessageCircle],
  [/reddit|discord/, MessageCircle],
  [/amazon|ebay|shop|store/, ShoppingCart],
  [/news|medium|substack|blog/, Newspaper],
  [/vercel|netlify|aws|cloud|azure/, Cloud],
  [/meet|zoom|teams|call/, Video],
  [/maps/, MapPin],
  [/dev\.|code|repl|jsfiddle|codepen/, Code2],
  [/drive|dropbox/, Briefcase],
  [/classroom|course|learn|book/, BookOpen],
];

/** Pick a Lucide icon for a URL's domain. */
export function iconForUrl(url: string): LucideIcon {
  const host = domainOf(url).toLowerCase();
  for (const [re, Icon] of ICON_RULES) {
    if (re.test(host)) return Icon;
  }
  return Globe;
}

/**
 * Subsequence fuzzy match; higher = better. Null = no match.
 * Consecutive-character and word-start bonuses keep good hits on top.
 */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let last = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    if (idx === last + 1) score += 2;
    if (idx === 0 || /[\s/\-_.]/.test(t[idx - 1] ?? "")) score += 3;
    score += 1;
    last = idx;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}
