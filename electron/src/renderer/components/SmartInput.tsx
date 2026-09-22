/**
 * SmartInput — a single-line input with Dia-style completions:
 *   @mention → open tabs (favicon + title), for pulling tabs into context
 *   /skill   → saved skills, one Enter to run
 *
 * Used by the omnibox, the new-tab hero, and the agent panel input.
 * Parents own the value; this only handles the completion UX.
 */

import { Globe, Zap } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { SkillDef } from "../../shared/ipc";
import { domainOf, fuzzy, iconForUrl } from "../nt";

export interface SmartTab {
  id: string;
  title: string;
  url: string;
  spaceName?: string;
}

interface SmartInputProps {
  value: string;
  onChange(v: string): void;
  /** Enter with no completion open. */
  onSubmit(): void;
  /** A skill was picked from /-completion. Parent should clear the input. */
  onRunSkill(skill: SkillDef): void;
  tabs: SmartTab[];
  skills: SkillDef[];
  placeholder?: string;
  autoFocus?: boolean;
  /** Render the dropdown above the input (agent panel) instead of below. */
  dropUp?: boolean;
  large?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  ariaLabel?: string;
  disabled?: boolean;
  /**
   * Sibling suggestion list (omnibox) that wants first dibs on ↑↓/Enter/Escape
   * while it is open. onPick returns false when there is nothing to pick, in
   * which case the key falls through to the normal handlers.
   */
  suggestionNav?: {
    open: boolean;
    onMove(dir: 1 | -1): void;
    onPick(): boolean;
    onClose(): void;
  };
}

interface Completion {
  kind: "mention" | "skill";
  /** Start index of the "@query" / "/query" token being completed. */
  start: number;
  query: string;
}

export function SmartInput({
  value,
  onChange,
  onSubmit,
  onRunSkill,
  tabs,
  skills,
  placeholder,
  autoFocus,
  dropUp,
  large,
  inputRef,
  ariaLabel,
  disabled,
  suggestionNav,
}: SmartInputProps) {
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [cursor, setCursor] = useState(0);
  const caretRef = useRef(0);
  const localRef = useRef<HTMLInputElement | null>(null);

  const setRefs = (el: HTMLInputElement | null) => {
    localRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") inputRef.current = el;
  };

  // Recompute the completion from the token before the caret.
  const recompute = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const mAt = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (mAt) {
      setCompletion({
        kind: "mention",
        start: caret - mAt[1].length - 1,
        query: mAt[1],
      });
      setCursor(0);
      return;
    }
    const mSlash = /(?:^|\s)\/(\w*)$/.exec(before);
    if (mSlash) {
      setCompletion({
        kind: "skill",
        start: caret - mSlash[1].length - 1,
        query: mSlash[1],
      });
      setCursor(0);
      return;
    }
    setCompletion(null);
  };

  const trackCaret = () => {
    const el = localRef.current;
    caretRef.current = el?.selectionStart ?? value.length;
  };

  const handleChange = (v: string) => {
    onChange(v);
    // Caret moves after React commits; recompute on next tick.
    requestAnimationFrame(() => {
      trackCaret();
      recompute(v, caretRef.current);
    });
  };

  const items = useMemo(() => {
    if (!completion) return [];
    if (completion.kind === "mention") {
      const q = completion.query.toLowerCase();
      return tabs
        .map((t) => ({
          tab: t,
          score: q
            ? (fuzzy(q, `${t.title} ${t.url}`) ?? -Infinity)
            : 0,
        }))
        .filter((x) => x.score > -Infinity)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((x) => x.tab);
    }
    const q = completion.query.toLowerCase();
    return skills
      .filter(
        (s) =>
          !q ||
          s.trigger.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [completion, tabs, skills]);

  useEffect(() => {
    if (cursor >= items.length) setCursor(0);
  }, [items.length, cursor]);

  const applyMention = (tab: SmartTab) => {
    if (!completion) return;
    const caret = caretRef.current;
    const insert = `@${tab.title || "New tab"} `;
    const next =
      value.slice(0, completion.start) + insert + value.slice(caret);
    onChange(next);
    setCompletion(null);
    requestAnimationFrame(() => {
      const el = localRef.current;
      if (el) {
        const pos = completion.start + insert.length;
        el.focus();
        el.setSelectionRange(pos, pos);
        caretRef.current = pos;
      }
    });
  };

  const pickSkill = (skill: SkillDef) => {
    setCompletion(null);
    onRunSkill(skill);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A sibling suggestion list (omnibox) gets first dibs while open.
    const sn = suggestionNav;
    if (sn?.open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sn.onMove(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sn.onMove(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!sn.onPick()) onSubmit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        sn.onClose();
        return;
      }
    }
    const navOpen = completion !== null && items.length > 0;
    if (navOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = items[cursor];
        if (completion && completion.kind === "mention") applyMention(item as SmartTab);
        else pickSkill(item as SkillDef);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCompletion(null);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
    // Escape otherwise falls through to the parent (overlay) handler.
  };

  const open = completion !== null && items.length > 0;

  return (
    <div className="relative w-full">
      <input
        ref={setRefs}
        value={value}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={trackCaret}
        onKeyUp={trackCaret}
        onSelect={trackCaret}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        aria-label={ariaLabel}
        className={`w-full bg-transparent outline-none placeholder:text-[var(--nt-text-3)] disabled:opacity-50 ${
          large ? "text-[17px]" : "text-[13px]"
        }`}
        style={{ color: "var(--nt-text-1)" }}
      />
      {open && completion && (
        <div
          className={`nt-popover nt-r-md absolute z-50 max-h-64 w-full min-w-[280px] overflow-y-auto border p-1.5 shadow-xl ${
            dropUp ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          style={{
            background: "var(--nt-bg-overlay)",
            borderColor: "var(--nt-border)",
            boxShadow: "var(--nt-shadow-pop)",
          }}
          role="listbox"
          aria-label={completion.kind === "mention" ? "Mention a tab" : "Run a skill"}
        >
          <p className="nt-micro px-2.5 pb-1 pt-1.5">
            {completion.kind === "mention" ? "Mention a tab" : "Skills"}
          </p>
          {items.map((item, i) => {
            const active = i === cursor;
            if (completion.kind === "mention") {
              const t = item as SmartTab;
              const Icon = iconForUrl(t.url);
              return (
                <button
                  key={t.id}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(t);
                  }}
                  onMouseMove={() => setCursor(i)}
                  className={`nt-r-sm flex w-full items-center gap-2.5 px-2.5 py-2 text-left ${
                    active ? "nt-selected" : ""
                  }`}
                >
                  <Icon
                    size={15}
                    strokeWidth={1.75}
                    className="shrink-0"
                    style={{ color: "var(--nt-text-3)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px]"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {t.title || "New tab"}
                    </span>
                    <span
                      className="nt-mono block truncate text-[11px]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      {t.spaceName ? `${t.spaceName} · ` : ""}
                      {domainOf(t.url)}
                    </span>
                  </span>
                </button>
              );
            }
            const s = item as SkillDef;
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSkill(s);
                }}
                onMouseMove={() => setCursor(i)}
                className={`nt-r-sm flex w-full items-center gap-2.5 px-2.5 py-2 text-left ${
                  active ? "nt-selected" : ""
                }`}
              >
                <span
                  className="nt-r-sm flex h-6 w-6 shrink-0 items-center justify-center"
                  style={{
                    background: "var(--nt-accent-soft)",
                    color: "var(--nt-accent)",
                  }}
                >
                  <Zap size={13} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[13px]"
                    style={{ color: "var(--nt-text-1)" }}
                  >
                    <span
                      className="nt-mono mr-1.5 text-[12px]"
                      style={{ color: "var(--nt-accent)" }}
                    >
                      {s.trigger}
                    </span>
                    {s.name}
                  </span>
                  <span
                    className="block truncate text-[11px]"
                    style={{ color: "var(--nt-text-3)" }}
                  >
                    {s.category}
                  </span>
                </span>
              </button>
            );
          })}
          {completion.kind === "mention" && (
            <p
              className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px]"
              style={{ color: "var(--nt-text-faint)" }}
            >
              <Globe size={11} strokeWidth={1.75} />
              Pulls the tab into the AI's context
            </p>
          )}
        </div>
      )}
    </div>
  );
}
