/**
 * New-tab hero (Dia pattern): a fresh tab shows a large centered command
 * bar — not a tile page. Same routing as the omnibox (web / AI / skill),
 * with @-mentions and a visible Ask/Web override.
 */

import { Globe, Import, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { SkillDef } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { nt } from "../nt";
import { routeSubmit, type RouteOverride } from "../routing";
import { openImportDialog } from "./ImportDialog";
import { SmartInput, type SmartTab } from "./SmartInput";

export function NewTabHero() {
  const { snapshot, activeSpace } = useBrowser();
  const [text, setText] = useState("");
  const [override, setOverride] = useState<RouteOverride>("auto");
  const [skills, setSkills] = useState<SkillDef[]>([]);

  useEffect(() => {
    nt().skillsList().then(setSkills).catch(() => {});
  }, []);

  // Reset the draft when the active tab changes.
  useEffect(() => {
    setText("");
    setOverride("auto");
  }, [activeSpace?.activeTabId]);

  const allTabs: SmartTab[] = (snapshot?.spaces ?? []).flatMap((s) =>
    s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      spaceName: s.name,
    })),
  );

  const submit = (raw: string) => {
    const value = raw;
    setText("");
    setOverride("auto");
    if (!value.trim()) return;
    void routeSubmit(value, { tabs: allTabs, skills, override }).catch(() => {});
  };

  const runSkill = (skill: SkillDef) => {
    setText("");
    void routeSubmit(skill.trigger, { tabs: allTabs, skills, override: "auto" }).catch(() => {});
  };

  const askMode = override === "ai";

  return (
    <div className="nt-fade-in pointer-events-auto absolute inset-0 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        <p
          className="mb-5 text-center text-[22px] font-semibold tracking-[-0.02em]"
          style={{ color: "var(--nt-text-1)" }}
        >
          Where to?
        </p>

        <div
          className="nt-r-lg border bg-[var(--nt-bg-raised)] px-5 py-4"
          style={{
            borderColor: "var(--nt-border-strong)",
            boxShadow: "var(--nt-shadow-card)",
          }}
        >
          <SmartInput
            value={text}
            onChange={setText}
            onSubmit={() => submit(text)}
            onRunSkill={runSkill}
            tabs={allTabs}
            skills={skills}
            placeholder="Ask anything, or type a URL…"
            autoFocus
            large
            ariaLabel="New tab command bar"
          />
          <div
            className="mt-3 flex items-center gap-2 border-t pt-3"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <div
              className="nt-r-full flex items-center border p-0.5"
              style={{ borderColor: "var(--nt-border)" }}
              role="group"
              aria-label="Route input to"
            >
              {(
                [
                  { id: "auto", label: "Auto", icon: null },
                  { id: "ai", label: "Ask", icon: Sparkles },
                  { id: "web", label: "Web", icon: Globe },
                ] as const
              ).map((o) => {
                const active = override === o.id;
                const Icon = o.icon;
                return (
                  <button
                    key={o.id}
                    onClick={() => setOverride(o.id)}
                    aria-pressed={active}
                    className="nt-r-full flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold transition-colors"
                    style={
                      active
                        ? {
                            background: "var(--nt-accent-soft)",
                            color: "var(--nt-accent)",
                          }
                        : { color: "var(--nt-text-3)" }
                    }
                  >
                    {Icon && <Icon size={11} strokeWidth={2} />}
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p
              className="ml-1 hidden text-[11px] sm:block"
              style={{ color: "var(--nt-text-faint)" }}
            >
              {askMode
                ? "Sends to the AI agent · @ pulls in a tab · / runs a skill"
                : "Auto: URLs and searches go to the web, questions go to the AI"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center">
          <button
            onClick={openImportDialog}
            className="nt-r-full flex items-center gap-2 border px-4 py-2 text-[13px] font-medium transition-colors hover:border-[var(--nt-accent)]"
            style={{
              borderColor: "var(--nt-border-strong)",
              color: "var(--nt-text-2)",
              background: "var(--nt-bg-raised)",
            }}
          >
            <Import size={14} style={{ color: "var(--nt-accent)" }} />
            Import from another browser
          </button>
        </div>

        {skills.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {skills.slice(0, 6).map((s) => (
              <button
                key={s.id}
                onClick={() => runSkill(s)}
                title={s.prompt}
                className="nt-r-full border px-3 py-1.5 text-[12px] transition-colors hover:border-[var(--nt-accent)]"
                style={{
                  borderColor: "var(--nt-border)",
                  color: "var(--nt-text-2)",
                }}
              >
                <span
                  className="nt-mono mr-1.5"
                  style={{ color: "var(--nt-accent)" }}
                >
                  {s.trigger}
                </span>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
