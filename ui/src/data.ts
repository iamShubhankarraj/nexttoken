/**
 * Realistic demo data for the Next Token prototype.
 * Three spaces (Research / Build / Chill), each with favorites, pinned tabs,
 * folders, and ephemeral "today" tabs. Timestamps are relative to load time
 * so the auto-archive demo behaves sensibly on first run.
 */

import {
  AtSign,
  BookOpen,
  Clapperboard,
  Code,
  Coffee,
  Compass,
  FileText,
  FlaskConical,
  GitBranch,
  Globe,
  Hammer,
  Layers,
  Library,
  Music,
  Newspaper,
  Palette,
  PenTool,
  Rss,
  ChartLine,
} from "lucide-react";
import type { Bookmark, HistoryItem, Space } from "./types";

const now = Date.now();
const min = 60_000;

let n = 0;
const id = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 7)}`;

export function seedSpaces(): Space[] {
  return [
    {
      id: "space-research",
      name: "Research",
      icon: FlaskConical,
      accent: "#8b5cf6",
      activeTabId: null,
      favorites: [
        { id: id("fav"), name: "GitHub", url: "https://github.com", icon: GitBranch },
        { id: id("fav"), name: "MDN", url: "https://developer.mozilla.org", icon: BookOpen },
        { id: id("fav"), name: "arXiv", url: "https://arxiv.org", icon: Library },
        { id: id("fav"), name: "Hacker News", url: "https://news.ycombinator.com", icon: Rss },
      ],
      folders: [{ id: "folder-papers", name: "Papers", open: true }],
      tabs: [
        {
          id: id("tab"), title: "Chromium Design Documents", url: "https://chromium.googlesource.com/chromium/src/+/main/docs",
          kind: "generic", pinned: true, lastActive: now - 40 * min,
        },
        {
          id: id("tab"), title: "zen-browser/desktop — GitHub", url: "https://github.com/zen-browser/desktop",
          kind: "generic", pinned: true, lastActive: now - 90 * min,
        },
        {
          id: id("tab"), title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762",
          kind: "generic", pinned: true, folderId: "folder-papers", lastActive: now - 120 * min,
        },
        {
          id: id("tab"), title: "Browser Architecture: Multi-process", url: "https://chromium.org/developers/design-documents/multi-process-architecture",
          kind: "generic", pinned: true, folderId: "folder-papers", lastActive: now - 130 * min,
        },
        {
          id: id("tab"), title: "Vite — Next Generation Frontend Tooling", url: "https://vite.dev",
          kind: "generic", pinned: false, lastActive: now - 3 * min,
        },
        {
          id: id("tab"), title: "Tailwind CSS v4 — What's new", url: "https://tailwindcss.com/blog/tailwindcss-v4",
          kind: "generic", pinned: false, lastActive: now - 8 * min,
        },
        {
          id: id("tab"), title: "Arc, 18 months later: a browser that thinks differently", url: "https://dev.to/arc-review",
          kind: "article", pinned: false, lastActive: now - 15 * min,
        },
        {
          id: id("tab"), title: "Speedometer 3.0 — Browser Benchmark", url: "https://browserbench.org/Speedometer3.1",
          kind: "generic", pinned: false, lastActive: now - 26 * min,
        },
        {
          id: id("tab"), title: "Next Token — Perf Dashboard", url: "nexttoken://dashboard",
          kind: "dashboard", pinned: false, lastActive: now - 32 * min,
        },
      ],
    },
    {
      id: "space-build",
      name: "Build",
      icon: Hammer,
      accent: "#10b981",
      activeTabId: null,
      favorites: [
        { id: id("fav"), name: "Linear", url: "https://linear.app", icon: Layers },
        { id: id("fav"), name: "Figma", url: "https://figma.com", icon: PenTool },
        { id: id("fav"), name: "Dribbble", url: "https://dribbble.com", icon: Palette },
      ],
      folders: [],
      tabs: [
        {
          id: id("tab"), title: "next-token — repository", url: "https://github.com/next-token/next-token",
          kind: "generic", pinned: true, lastActive: now - 70 * min,
        },
        {
          id: id("tab"), title: "Vite Documentation", url: "https://vite.dev/guide",
          kind: "generic", pinned: true, lastActive: now - 100 * min,
        },
        {
          id: id("tab"), title: "Welcome to Next Token", url: "nexttoken://start",
          kind: "start", pinned: false, lastActive: now - 1 * min,
        },
        {
          id: id("tab"), title: "shadcn/ui — Components", url: "https://ui.shadcn.com",
          kind: "generic", pinned: false, lastActive: now - 6 * min,
        },
        {
          id: id("tab"), title: "Lucide Icons", url: "https://lucide.dev",
          kind: "generic", pinned: false, lastActive: now - 12 * min,
        },
        {
          id: id("tab"), title: "TypeScript Handbook", url: "https://typescriptlang.org/docs",
          kind: "generic", pinned: false, lastActive: now - 20 * min,
        },
      ],
    },
    {
      id: "space-chill",
      name: "Chill",
      icon: Coffee,
      accent: "#f59e0b",
      activeTabId: null,
      favorites: [
        { id: id("fav"), name: "YouTube", url: "https://youtube.com", icon: Clapperboard },
        { id: id("fav"), name: "Spotify", url: "https://open.spotify.com", icon: Music },
        { id: id("fav"), name: "X", url: "https://x.com", icon: AtSign },
      ],
      folders: [],
      tabs: [
        {
          id: id("tab"), title: "lofi hip hop radio — beats to relax/study to", url: "https://youtube.com/watch?v=jfKfPfyJRdk",
          kind: "generic", pinned: true, lastActive: now - 200 * min,
        },
        {
          id: id("tab"), title: "The quiet comeback of the personal website", url: "https://example.com/personal-websites",
          kind: "article", pinned: false, lastActive: now - 5 * min,
        },
        {
          id: id("tab"), title: "A field guide to mechanical keyboards", url: "https://example.com/keyboards",
          kind: "generic", pinned: false, lastActive: now - 18 * min,
        },
        {
          id: id("tab"), title: "Bandcamp Daily", url: "https://daily.bandcamp.com",
          kind: "generic", pinned: false, lastActive: now - 44 * min,
        },
      ],
    },
  ];
}

export function seedBookmarks(): Bookmark[] {
  return [
    { id: id("bm"), title: "Chromium Source", url: "https://chromium.googlesource.com" },
    { id: id("bm"), title: "web.dev", url: "https://web.dev" },
    { id: id("bm"), title: "Smashing Magazine", url: "https://smashingmagazine.com" },
    { id: id("bm"), title: "Vercel Documentation", url: "https://vercel.com/docs" },
    { id: id("bm"), title: "Raycast Store", url: "https://raycast.com/store" },
    { id: id("bm"), title: "Linear Method", url: "https://linear.app/method" },
    { id: id("bm"), title: "Tailwind Play", url: "https://play.tailwindcss.com" },
    { id: id("bm"), title: "The Pudding", url: "https://pudding.cool" },
  ];
}

export function seedHistory(): HistoryItem[] {
  const items: Array<[string, string, number]> = [
    ["Vite — Next Generation Frontend Tooling", "https://vite.dev", 4],
    ["Arc, 18 months later", "https://dev.to/arc-review", 16],
    ["The quiet comeback of the personal website", "https://example.com/personal-websites", 35],
    ["Lucide Icons", "https://lucide.dev", 61],
    ["Speedometer 3.0", "https://browserbench.org/Speedometer3.1", 95],
    ["Chromium Design Documents", "https://chromium.googlesource.com/chromium/src/+/main/docs", 140],
    ["A field guide to mechanical keyboards", "https://example.com/keyboards", 200],
    ["Tailwind CSS v4 — What's new", "https://tailwindcss.com/blog/tailwindcss-v4", 260],
    ["Hacker News", "https://news.ycombinator.com", 400],
    ["lofi hip hop radio", "https://youtube.com/watch?v=jfKfPfyJRdk", 700],
  ];
  return items.map(([title, url, minsAgo]) => ({
    id: id("hist"),
    title,
    url,
    visitedAt: now - minsAgo * min,
  }));
}

/** Small icon map for tab favicons, keyed by domain hint. */
export function iconForUrl(url: string) {
  if (url.includes("github")) return GitBranch;
  if (url.includes("arxiv") || url.includes("developer.mozilla")) return BookOpen;
  if (url.includes("ycombinator") || url.includes("dev.to")) return Newspaper;
  if (url.includes("youtube") || url.includes("spotify")) return Music;
  if (url.includes("figma")) return PenTool;
  if (url.includes("linear")) return Layers;
  if (url.includes("vite")) return Code;
  if (url.includes("tailwind") || url.includes("shadcn") || url.includes("lucide")) return Compass;
  if (url.includes("browserbench")) return ChartLine;
  if (url.includes("nexttoken")) return Compass;
  if (url.includes("typescript")) return FileText;
  return Globe;
}
