/**
 * Skills section in Settings: the user's saved reusable prompts.
 *
 * Skills are one-click chips in the agent panel and /-commands in any
 * input. Six built-ins ship with the app; everything is user-editable
 * and "Reset to defaults" restores the built-ins.
 */

import { Pencil, Plus, RotateCcw, Trash2, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { SkillDef } from "../../shared/ipc";
import { nt } from "../nt";

interface Draft {
  id?: string;
  name: string;
  trigger: string;
  prompt: string;
  category: string;
}

const EMPTY: Draft = { name: "", trigger: "", prompt: "", category: "" };

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    nt().skillsList().then(setSkills).catch(() => {});
  };

  useEffect(refresh, []);

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const next = await nt().skillsSave({
        id: draft.id,
        name: draft.name,
        trigger: draft.trigger,
        prompt: draft.prompt,
        category: draft.category,
      });
      setSkills(next);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    const next = await nt().skillsRemove(id).catch(() => null);
    if (next) setSkills(next);
  };

  const reset = async () => {
    const next = await nt().skillsReset().catch(() => null);
    if (next) setSkills(next);
  };

  const field =
    "nt-r-sm w-full border bg-[var(--nt-bg-raised)] px-3 py-2 text-[13px] outline-none placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)]";

  return (
    <div>
      <p className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
        Saved prompts you can run with one click or by typing{" "}
        <code className="nt-mono" style={{ color: "var(--nt-accent)" }}>/trigger</code>{" "}
        in any input.
      </p>

      <div className="mt-4 space-y-1.5">
        {skills.map((s) => (
          <div
            key={s.id}
            className="nt-r-md border px-3 py-2.5"
            style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="nt-r-sm flex h-6 w-6 shrink-0 items-center justify-center"
                style={{ background: "var(--nt-accent-soft)", color: "var(--nt-accent)" }}
              >
                <Zap size={12} strokeWidth={1.75} />
              </span>
              <code className="nt-mono shrink-0 text-[12px]" style={{ color: "var(--nt-accent)" }}>
                {s.trigger}
              </code>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                {s.name}
              </span>
              <span className="nt-micro hidden shrink-0 sm:block">{s.category}</span>
              <button
                title={s.builtIn ? "Edit built-in skill" : "Edit skill"}
                onClick={() =>
                  setDraft({
                    id: s.id,
                    name: s.name,
                    trigger: s.trigger,
                    prompt: s.prompt,
                    category: s.category,
                  })
                }
                className="nt-r-sm shrink-0 p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <Pencil size={13} strokeWidth={1.75} />
              </button>
              <button
                title="Delete skill"
                onClick={() => void remove(s.id)}
                className="nt-r-sm shrink-0 p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <Trash2 size={13} strokeWidth={1.75} />
              </button>
            </div>
            <p className="mt-1.5 line-clamp-2 pl-8 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              {s.prompt}
            </p>
          </div>
        ))}
        {skills.length === 0 && (
          <p className="py-4 text-center text-[13px]" style={{ color: "var(--nt-text-faint)" }}>
            No skills yet — add your first below.
          </p>
        )}
      </div>

      {/* editor */}
      {draft ? (
        <div
          className="nt-r-md nt-fade-in mt-3 space-y-2.5 border p-4"
          style={{ borderColor: "var(--nt-accent)", background: "var(--nt-bg-raised)" }}
        >
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="nt-micro mb-1 block">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Summarize"
                className={field}
                style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
              />
            </label>
            <label className="block">
              <span className="nt-micro mb-1 block">Trigger</span>
              <input
                value={draft.trigger}
                onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                placeholder="/summarize"
                spellCheck={false}
                className={`${field} nt-mono`}
                style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
              />
            </label>
          </div>
          <label className="block">
            <span className="nt-micro mb-1 block">Category</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              placeholder="Reading"
              className={field}
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            />
          </label>
          <label className="block">
            <span className="nt-micro mb-1 block">Prompt</span>
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="What should the agent do when this skill runs? @mentions and the current page are available."
              rows={4}
              className={`${field} resize-y`}
              style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
            />
          </label>
          {error && (
            <p className="text-[12px]" style={{ color: "#d97362" }}>{error}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void save()}
              disabled={!draft.name.trim() || !draft.prompt.trim()}
              className="nt-r-sm px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.02] disabled:opacity-40"
              style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
            >
              {draft.id ? "Save skill" : "Add skill"}
            </button>
            <button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="nt-r-sm px-4 py-2 text-[13px]"
              style={{ color: "var(--nt-text-2)", background: "var(--nt-bg-hover)" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => setDraft({ ...EMPTY })}
            className="nt-r-sm flex items-center gap-1.5 border px-3 py-2 text-[13px] font-medium transition-colors hover:border-[var(--nt-accent)]"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
          >
            <Plus size={14} strokeWidth={1.75} /> New skill
          </button>
          <span className="flex-1" />
          <button
            onClick={() => void reset()}
            title="Restore the six built-in skills"
            className="nt-r-sm flex items-center gap-1.5 px-3 py-2 text-[12px] transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <RotateCcw size={12} strokeWidth={1.75} /> Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
