/**
 * Omnibox — one input for navigation, search, and AI (Dia pattern).
 *
 * Intent routing is a visible default, never a lock-in: the chip on the
 * left shows where the input will go (Web / Ask / Skill) and clicking it
 * cycles a manual override (auto → web → ai → auto). @-mentions pull open
 * tabs into the AI's context; /-triggers run saved skills.
 */

import { Globe, Mic, Sparkles, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BookmarkState, SkillDef } from "../../shared/ipc";
import { buildSearchUrl, presetById } from "../../shared/searchEngines";
import { useBrowser } from "../BrowserContext";
import { detectIntent, domainOf, isNewTabUrl, nt } from "../nt";
import { routeSubmit, type RouteOverride } from "../routing";
import { OmniboxSuggest, type OmniboxSuggestApi } from "./OmniboxSuggest";
import { ReaderControls } from "./ReaderView";
import { SmartInput, type SmartTab } from "./SmartInput";
import { useVoiceSession } from "./VoiceSession";

const OVERRIDE_ORDER: RouteOverride[] = ["auto", "web", "ai"];

export function Omnibox() {
  const { snapshot, activeTab } = useBrowser();
  const voice = useVoiceSession();
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const [override, setOverride] = useState<RouteOverride>("auto");
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [defaultEngineId, setDefaultEngineId] = useState("google");
  const suggestApi = useRef<OmniboxSuggestApi | null>(null);

  useEffect(() => {
    if (!focused) return;
    nt().skillsList().then(setSkills).catch(() => {});
    nt()
      .settingsGetSearchEngine()
      .then((c) => setDefaultEngineId(c.id))
      .catch(() => {});
  }, [focused]);

  const allTabs: SmartTab[] = (snapshot?.spaces ?? []).flatMap((s) =>
    s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      spaceName: s.name,
    })),
  );

  const allBookmarks: BookmarkState[] = (snapshot?.spaces ?? []).flatMap(
    (s) => s.bookmarks ?? [],
  );

  const startEditing = () => {
    const url = activeTab?.url ?? "";
    setText(url && !isNewTabUrl(url) ? url : "");
    setFocused(true);
  };

  const cancel = () => {
    setFocused(false);
    setText("");
    setOverride("auto");
  };

  // ⌘L (focus omnibox) — dispatched by the shell shortcut handler.
  useEffect(() => {
    const focus = () => startEditing();
    window.addEventListener("nt:focus-omnibox", focus);
    return () => window.removeEventListener("nt:focus-omnibox", focus);
  }, []);

  const submit = (raw: string) => {
    const value = raw;
    cancel();
    if (!value.trim()) return;
    void routeSubmit(value, { tabs: allTabs, skills, override }).catch(() => {});
  };

  const runSkill = (skill: SkillDef) => {
    cancel();
    void routeSubmit(skill.trigger, { tabs: allTabs, skills, override: "auto" }).catch(() => {});
  };

  const effective =
    override === "auto" ? detectIntent(text) : override;

  const chip =
    effective === "ai"
      ? { icon: Sparkles, label: "Ask" }
      : effective === "skill"
        ? { icon: Zap, label: "Skill" }
        : { icon: Globe, label: "Web" };
  const ChipIcon = chip.icon;

  // -- omnibox suggestions (tabs / bookmarks / history / web) --------------
  // Hidden while SmartInput has an @ or / completion open (same regexes it uses).
  const suggestSuppressed =
    /(?:^|\s)@([^\s@]*)$/.test(text) || /(?:^|\s)\/(\w*)$/.test(text);

  const pickTab = (tabId: string) => {
    cancel();
    void nt().tabsActivate(tabId).catch(() => {});
  };
  const openUrl = (url: string) => {
    cancel();
    void nt().navGo(url).catch(() => {});
  };
  const searchSuggestion = (s: string, engineId?: string) => {
    cancel();
    // A suggestion that came from a keyword engine ("ddg cats" → ddg
    // suggestions) searches that engine; otherwise the default engine.
    if (engineId && engineId !== defaultEngineId) {
      const p = presetById(engineId);
      if (p) {
        void nt().navGo(buildSearchUrl(p.template, s)).catch(() => {});
        return;
      }
    }
    void routeSubmit(s, { tabs: allTabs, skills, override: "web" }).catch(() => {});
  };

  const suggestionNav = useMemo(
    () => ({
      open: suggestOpen,
      onMove: (dir: 1 | -1) => suggestApi.current?.move(dir),
      onPick: () => suggestApi.current?.pick() ?? false,
      onClose: () => suggestApi.current?.close(),
    }),
    [suggestOpen],
  );

  if (!focused) {
    const isNew = !activeTab || isNewTabUrl(activeTab.url);
    return (
      <div className="flex min-w-0 max-w-xl flex-1 items-center gap-1">
        <button
          title={activeTab?.url ?? "New tab"}
          onClick={startEditing}
          className="nt-r-full flex min-w-0 flex-1 items-center gap-2 border border-transparent px-4 py-1.5 text-[13px] transition-colors hover:border-[var(--nt-border)] hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-2)" }}
        >
          {activeTab?.loading ? (
            <span className="nt-shimmer" />
          ) : (
            <span
              className="nt-r-full h-1.5 w-1.5 shrink-0"
              style={{ background: "var(--nt-space)" }}
            />
          )}
          <span className="nt-mono truncate">
            {activeTab
              ? activeTab.loading
                ? "Loading…"
                : isNew
                  ? "Ask anything, or type a URL"
                  : domainOf(activeTab.url)
              : "New tab"}
          </span>
        </button>
        <ReaderControls />
      </div>
    );
  }

  return (
    <div
      className="nt-r-full relative flex max-w-xl flex-1 items-center gap-1 border bg-[var(--nt-bg-raised)] py-1 pl-1.5 pr-2"
      style={{ borderColor: "var(--nt-accent)" }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) cancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <button
        title={
          override === "auto"
            ? `Will go to: ${chip.label}. Click to override.`
            : `Override: ${chip.label}. Click to change.`
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          setOverride(OVERRIDE_ORDER[(OVERRIDE_ORDER.indexOf(override) + 1) % OVERRIDE_ORDER.length])
        }
        className="nt-r-full flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={
          override === "auto"
            ? { color: "var(--nt-text-3)" }
            : {
                color: "var(--nt-accent)",
                background: "var(--nt-accent-soft)",
              }
        }
      >
        <ChipIcon size={13} strokeWidth={2} />
        {chip.label}
      </button>
      <div className="min-w-0 flex-1 px-1">
        <SmartInput
          value={text}
          onChange={setText}
          onSubmit={() => submit(text)}
          onRunSkill={runSkill}
          tabs={allTabs}
          skills={skills}
          placeholder="Ask anything, or type a URL — @ mentions a tab, / runs a skill"
          autoFocus
          ariaLabel="Address and AI command bar"
          suggestionNav={suggestionNav}
        />
      </div>
      <kbd
        className="nt-r-sm shrink-0 border px-1.5 py-0.5 text-[10px]"
        style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-3)" }}
      >
        esc
      </kbd>
      <button
        title={voice.listening ? "Stop listening" : "Voice command (Alt+V)"}
        aria-label={voice.listening ? "Stop listening" : "Start voice command"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => voice.toggleCommand()}
        className="voice-mic-btn nt-r-full shrink-0 p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
        data-active={voice.listening}
        style={{ color: voice.listening ? "var(--nt-accent)" : "var(--nt-text-3)" }}
      >
        <Mic size={14} strokeWidth={1.75} />
      </button>
      <OmniboxSuggest
        ref={suggestApi}
        query={text}
        tabs={allTabs}
        bookmarks={allBookmarks}
        suppressed={suggestSuppressed}
        defaultEngineId={defaultEngineId}
        onOpenChange={setSuggestOpen}
        onActivateTab={pickTab}
        onOpenUrl={openUrl}
        onSearch={searchSuggestion}
      />
    </div>
  );
}
