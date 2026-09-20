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

/* ------------------- omnibox intent routing (Dia pattern) ------------------- */

/** Fresh-tab pages get the large centered command bar, not a tile page. */
export function isNewTabUrl(url: string): boolean {
  return url === "" || url === "about:blank" || url.startsWith("data:text/html");
}

export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes(" ")) return false;
  if (/^(https?|file|ftp):\/\//i.test(t)) return true;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(t)) return true;
  if (/^\S+\.[a-z]{2,}(\/\S*)?$/i.test(t)) return true;
  return false;
}

export type RouteIntent = "web" | "ai" | "skill";

/**
 * One input, three modes. URL-ish → web; "/trigger" → skill;
 * natural language → AI; a lone word → web search. This is a default —
 * the UI always offers a manual override.
 */
export function detectIntent(text: string): RouteIntent {
  const t = text.trim();
  if (!t) return "web";
  if (t.startsWith("/")) return "skill";
  if (looksLikeUrl(t)) return "web";
  if (/\s/.test(t) || /[?]/.test(t)) return "ai";
  return "web";
}

/* ------------------------------ @-mentions -------------------------------- */

export interface MentionTab {
  id: string;
  title: string;
  url: string;
}

export interface ResolvedMentions {
  text: string;
  mentioned: MentionTab[];
}

/**
 * Resolve @-mentions against open tabs. Each "@…" is matched to the open
 * tab whose title is the longest case-insensitive prefix of the text
 * after the "@" (handles multi-word titles). Matches become explicit
 * [Tab: "title" (url)] context markers the agent can act on; unmatched
 * "@…" text is left untouched.
 */
export function resolveMentions(
  text: string,
  tabs: MentionTab[],
): ResolvedMentions {
  const mentioned: MentionTab[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1 || (at > 0 && !/[\s(]/.test(text[at - 1]))) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    const rest = text.slice(at + 1).toLowerCase();
    let best: MentionTab | null = null;
    let bestLen = 0;
    for (const t of tabs) {
      const title = (t.title || "New tab").toLowerCase();
      if (rest.startsWith(title) && title.length > bestLen) {
        best = t;
        bestLen = title.length;
      }
    }
    if (best) {
      mentioned.push(best);
      out += `[Tab: "${best.title || "New tab"}" (${best.url})]`;
      i = at + 1 + bestLen;
    } else {
      out += "@";
      i = at + 1;
    }
  }
  return { text: out, mentioned };
}
