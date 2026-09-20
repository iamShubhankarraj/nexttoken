/**
 * Mock page renderers for the prototype's tab content area.
 *
 * In the real product these are replaced by actual WebContents. The
 * `PageRenderer` contract (props: a TabItem, renders scrollable content)
 * is what the product shell will keep — each pane just hosts a webview
 * instead of these components.
 */

import {
  ArrowRight,
  Database,
  Clock,
  Compass,
  Globe,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { iconForUrl } from "../data";
import { domainOf, useStore } from "../store";
import type { TabItem } from "../types";

export function PageRenderer({ tab }: { tab: TabItem }) {
  // Remount page content when switching tabs so scroll positions reset,
  // exactly like a real tab switch.
  return (
    <div key={tab.id} className="h-full overflow-y-auto nt-fade-in">
      {tab.kind === "start" && <StartPage />}
      {tab.kind === "article" && <ArticlePage tab={tab} />}
      {tab.kind === "dashboard" && <DashboardPage />}
      {tab.kind === "generic" && <GenericPage tab={tab} />}
    </div>
  );
}

/* ------------------------------- start ------------------------------ */

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function StartPage() {
  const { state, dispatch, space } = useStore();
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const recent = state.history.slice(0, 4);

  return (
    <div className="min-h-full flex flex-col items-center px-8 py-14 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.08),transparent_60%)]">
      <div className="w-full max-w-2xl">
        <p className="text-sm text-white/40 tabular-nums">
          {time.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </p>
        <h1 className="text-4xl font-semibold tracking-tight mt-1">
          {greeting()}.{" "}
          <span className="text-white/35">What are we building today?</span>
        </h1>

        <button
          onClick={() => dispatch({ type: "SET_COMMAND_BAR", open: true })}
          className="mt-6 w-full flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left text-white/45 hover:border-white/20 hover:bg-white/[0.06] transition-colors"
        >
          <Compass size={17} />
          <span className="text-sm">Search tabs, bookmarks, history, or type a URL…</span>
          <kbd className="ml-auto text-[11px] border border-white/10 rounded px-1.5 py-0.5 bg-white/5">⌘K</kbd>
        </button>

        <h2 className="text-xs font-medium uppercase tracking-widest text-white/35 mt-10 mb-3">
          Favorites — {space.name}
        </h2>
        <div className="grid grid-cols-4 gap-3">
          {space.favorites.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                onClick={() => dispatch({ type: "OPEN_URL", url: f.url })}
                className="group flex flex-col items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] p-4 hover:bg-white/[0.06] hover:border-white/15 transition-all"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-white/70 group-hover:text-white transition-colors">
                  <Icon size={18} />
                </span>
                <span className="text-xs text-white/60">{f.name}</span>
              </button>
            );
          })}
        </div>

        <h2 className="text-xs font-medium uppercase tracking-widest text-white/35 mt-8 mb-3">
          Pick up where you left off
        </h2>
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] divide-y divide-white/[0.06]">
          {recent.map((h) => {
            const Icon = iconForUrl(h.url);
            return (
              <button
                key={h.id}
                onClick={() => dispatch({ type: "OPEN_URL", url: h.url, title: h.title })}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.04] transition-colors"
              >
                <Icon size={15} className="text-white/40 shrink-0" />
                <span className="text-sm text-white/75 truncate">{h.title}</span>
                <span className="ml-auto text-xs text-white/30 shrink-0 flex items-center gap-1">
                  <Clock size={12} />
                  {domainOf(h.url)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ article ----------------------------- */

const ARTICLES: Record<string, { title: string; dek: string; body: string[]; pull: string }> = {
  "https://dev.to/arc-review": {
    title: "Arc, 18 months later: a browser that thinks differently",
    dek: "The sidebar ate the tab bar, tabs became ephemeral, and somehow browsing got calmer. What the rest of the industry should steal.",
    body: [
      "Eighteen months in, the strangest thing about Arc isn't any single feature — it's the absence of tab anxiety. Tabs are ephemeral by default. They archive themselves after half a day of neglect. Closing a tab feels like tidying, not like losing something.",
      "The sidebar does the heavy lifting. Favorites sit at the top like an app dock, pinned tabs hold your working set, and everything else is a 'today tab' — a visitor, not a resident. The hierarchy maps onto how attention actually works: a few things you always need, a few things you're working on, and a stream of things passing through.",
      "Spaces turned out to be the sleeper feature. Giving each project its own sidebar, its own pinned tabs, its own color — it sounds cosmetic until you feel the cognitive exhale of switching contexts and having the browser switch with you.",
      "The command bar finished the job. When ⌘T finds tabs, bookmarks, history, actions, and spaces faster than you can reach for the mouse, the address bar starts to feel like a legacy interface. Which, of course, it is.",
      "None of this required a new rendering engine. It required someone to treat the browser chrome as a design problem instead of a settings page. The engine wars are over; the chrome wars are just beginning.",
    ],
    pull: "Tabs are ephemeral by default. Closing a tab feels like tidying, not like losing something.",
  },
  "https://example.com/personal-websites": {
    title: "The quiet comeback of the personal website",
    dek: "While everyone was building audiences on rented land, a few thousand people kept tending small gardens. The gardens are winning.",
    body: [
      "The personal website never died. It just went quiet for a decade while the feeds were loud. Now the feeds are exhausting, the algorithms are hostile, and the small, hand-made website feels radical again.",
      "There's a specific pleasure to a site that doesn't want anything from you. No signup wall, no infinite scroll, no engagement metrics shaping every sentence. Just a person, some HTML, and the strange confidence that this is enough.",
      "The tools got better while nobody was looking. You can publish a fast, beautiful site from a markdown file in minutes. The barrier isn't technical anymore — it's the belief that your corner of the internet is worth tending.",
      "Maybe the next era of the web isn't a platform at all. Maybe it's a million small gardens, linked to each other, tended by people who'd rather own their words than rent an audience.",
    ],
    pull: "A site that doesn't want anything from you feels radical again.",
  },
};

function ArticlePage({ tab }: { tab: TabItem }) {
  const a = ARTICLES[tab.url] ?? {
    title: tab.title,
    dek: "A prototype article. In the real product this pane renders the live web.",
    body: [
      "This is a stand-in article page so the prototype feels like a real browser. Headings, pull quotes, and typography are all here — the content is placeholder.",
      "Open the command bar (⌘K) and try the agent copilot: ask it to summarize this page and you'll get a mock summary back, demonstrating the page-context loop the real agent will use.",
    ],
    pull: "Prototype content — the layout is the point.",
  };

  return (
    <article className="mx-auto max-w-2xl px-8 py-14">
      <p className="text-xs uppercase tracking-widest text-white/35 mb-3 flex items-center gap-2">
        <Globe size={13} /> {domainOf(tab.url)} · 6 min read
      </p>
      <h1 className="text-4xl font-semibold tracking-tight leading-tight">{a.title}</h1>
      <p className="mt-4 text-lg text-white/55 leading-relaxed">{a.dek}</p>
      <div className="mt-6 flex items-center gap-3 border-y border-white/10 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm font-medium">
          {a.title.charAt(0)}
        </span>
        <div>
          <p className="text-sm font-medium">Staff Writer</p>
          <p className="text-xs text-white/40">Prototype Press · Sep 2026</p>
        </div>
      </div>
      {a.body.slice(0, 2).map((p, i) => (
        <p key={i} className="mt-6 text-[17px] leading-8 text-white/80">{p}</p>
      ))}
      <blockquote className="my-8 border-l-2 pl-5 text-xl leading-9 text-white/90 italic" style={{ borderColor: "var(--accent)" }}>
        “{a.pull}”
      </blockquote>
      {a.body.slice(2).map((p, i) => (
        <p key={i} className="mt-6 text-[17px] leading-8 text-white/80">{p}</p>
      ))}
      <p className="mt-10 text-xs text-white/30 border-t border-white/10 pt-4">
        Prototype note — this article is mock content for the UI demo.
      </p>
    </article>
  );
}

/* ----------------------------- dashboard ---------------------------- */

function DashboardPage() {
  const bars = [42, 68, 55, 80, 62, 90, 74, 58, 84, 96, 71, 88];
  const line = "0,38 30,34 60,36 90,28 120,30 150,22 180,24 210,16 240,18 270,10 300,12 330,6";
  const stats = [
    { label: "Speedometer 3.1", value: "61.4", delta: "+8.2%", icon: Zap },
    { label: "Cold start", value: "0.84s", delta: "-12%", icon: Clock },
    { label: "Idle memory", value: "212 MB", delta: "-9%", icon: Database },
    { label: "JetStream 3", value: "469", delta: "+10%", icon: Sparkles },
  ];
  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Performance Dashboard</h1>
      <p className="text-sm text-white/40 mt-1">Prototype build metrics · mock data</p>

      <div className="grid grid-cols-4 gap-3 mt-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-4">
            <div className="flex items-center justify-between">
              <s.icon size={15} className="text-white/40" />
              <span className="text-[11px] font-medium text-emerald-400">{s.delta}</span>
            </div>
            <p className="text-2xl font-semibold mt-2 tabular-nums">{s.value}</p>
            <p className="text-xs text-white/40 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-3 mt-3">
        <div className="col-span-3 rounded-xl border border-white/[0.07] bg-white/[0.03] p-5">
          <p className="text-sm font-medium mb-1">Speedometer trend</p>
          <p className="text-xs text-white/35 mb-4">Last 12 nightly builds</p>
          <svg viewBox="0 0 330 44" className="w-full h-24">
            <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
            {line.split(" ").map((pt, i) => {
              const [x, y] = pt.split(",").map(Number);
              return <circle key={i} cx={x} cy={y} r="2.5" fill="var(--accent)" opacity="0.7" />;
            })}
          </svg>
        </div>
        <div className="col-span-2 rounded-xl border border-white/[0.07] bg-white/[0.03] p-5">
          <p className="text-sm font-medium mb-1">Build time by config</p>
          <p className="text-xs text-white/35 mb-4">Minutes, clean build</p>
          <div className="flex items-end gap-2 h-24">
            {bars.map((v, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-white/15 hover:bg-[var(--accent)] transition-colors"
                style={{ height: `${v}%`, opacity: 0.5 + (v / 200) }}
                title={`${v} min`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.03] p-5">
        <p className="text-sm font-medium mb-3">Recent benchmark runs</p>
        <div className="divide-y divide-white/[0.06] text-sm">
          {[
            ["M153 nightly #142", "61.4", "0.84s", "pass"],
            ["M153 nightly #141", "60.9", "0.86s", "pass"],
            ["M153 nightly #140", "60.2", "0.91s", "pass"],
            ["M152 release", "58.7", "0.97s", "pass"],
          ].map(([run, score, start, status]) => (
            <div key={run} className="flex items-center py-2.5">
              <span className="text-white/75">{run}</span>
              <span className="ml-auto tabular-nums text-white/50">{score}</span>
              <span className="ml-6 tabular-nums text-white/50 w-14">{start}</span>
              <span className="ml-4 text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ generic ----------------------------- */

const HEROES = [
  "Built for people who live in their browser.",
  "Fast is a feature. Calm is a feature.",
  "Your tabs, organized the way you think.",
  "The web, without the noise.",
];
const CARD_TITLES = [
  ["Ship faster", "A workflow that gets out of your way."],
  ["Stay in flow", "Context switching without the whiplash."],
  ["Own your data", "Local-first. Private by default."],
  ["Designed calm", "Every pixel earns its place."],
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function GenericPage({ tab }: { tab: TabItem }) {
  const { dispatch } = useStore();
  const domain = domainOf(tab.url);
  const h = hashStr(tab.url);
  const hero = HEROES[h % HEROES.length];
  const Icon = iconForUrl(tab.url);
  const cards = [0, 1, 2].map((i) => CARD_TITLES[(h + i) % CARD_TITLES.length]);

  return (
    <div className="min-h-full">
      <div className="border-b border-white/[0.07] bg-white/[0.02]">
        <div className="mx-auto max-w-4xl px-8 py-4 flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06]">
            <Icon size={16} className="text-white/70" />
          </span>
          <span className="font-medium">{domain}</span>
          <div className="ml-auto flex gap-5 text-sm text-white/45">
            {["Product", "Docs", "Pricing"].map((l) => (
              <span key={l} className="hover:text-white cursor-pointer transition-colors">{l}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-8 py-16 text-center">
        <p className="text-xs uppercase tracking-widest text-white/35">Prototype page · {domain}</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight leading-tight">{hero}</h1>
        <p className="mt-4 text-white/50 max-w-xl mx-auto">
          This is a generated stand-in for <span className="text-white/80 font-mono text-sm">{domain}</span> so
          the prototype feels like a complete browser. In the real product this pane renders the live web.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={() => dispatch({ type: "SET_COMMAND_BAR", open: true })}
            className="flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.02]"
            style={{ background: "var(--accent)" }}
          >
            Open command bar <ArrowRight size={15} />
          </button>
          <button
            onClick={() => dispatch({ type: "NEW_TAB" })}
            className="flex items-center gap-2 rounded-lg border border-white/15 px-5 py-2.5 text-sm text-white/70 hover:bg-white/5 transition-colors"
          >
            <Plus size={15} /> New tab
          </button>
        </div>
        <div className="mt-12 grid grid-cols-3 gap-3 text-left">
          {cards.map(([t, d]) => (
            <div key={t} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-5 hover:bg-white/[0.05] transition-colors">
              <p className="font-medium">{t}</p>
              <p className="mt-1 text-sm text-white/45">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tiny helper so the start page clock ticks without re-render storms. */
export function useNowTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}
