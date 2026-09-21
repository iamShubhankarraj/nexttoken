/**
 * Model switcher for the Agent tab header.
 *
 * One click, always visible: shows the current active model and opens a
 * grouped dropdown — Local (Apple Foundation Models, downloaded on-device
 * models) and Cloud (every enabled BYOK provider). Switching sets the
 * ACTIVE model, persisted in the store; the unified ModelRouter then uses
 * it for every LLM call in the app.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, Cpu } from "lucide-react";
import type { ActiveModelRef, ModelChoice } from "../../shared/ipc";
import { nt } from "../nt";

function refKey(r: ActiveModelRef): string {
  return `${r.kind}:${r.id ?? ""}`;
}

export function ModelSwitcher() {
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [active, setActive] = useState<ActiveModelRef | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [c, a] = await Promise.all([nt().modelsChoices(), nt().modelsGetActive()]);
      setChoices(c);
      setActive(a);
    } catch {
      /* bridge unavailable — the button degrades to "Model" */
    }
  };

  useEffect(() => {
    void load();
    let off: (() => void) | undefined;
    try {
      off = nt().onActiveModel((r) => {
        setActive(r);
        void nt().modelsChoices().then(setChoices).catch(() => {});
      });
    } catch {
      /* no bridge */
    }
    return () => off?.();
  }, []);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open ]);

  const pick = async (choice: ModelChoice) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const saved = await nt().modelsSetActive(choice.ref);
      setActive(saved);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  const activeKey = active ? refKey(active) : "";
  const activeChoice = choices?.find((c) => refKey(c.ref) === activeKey);
  const localChoices = choices?.filter((c) => c.group === "local") ?? [];
  const cloudChoices = choices?.filter((c) => c.group === "cloud") ?? [];

  const row = (c: ModelChoice) => {
    const selected = refKey(c.ref) === activeKey;
    return (
      <button
        key={refKey(c.ref)}
        disabled={!c.available || switching}
        onClick={() => void pick(c)}
        title={c.available ? `Switch to ${c.label}` : c.unavailableReason}
        className="nt-r-sm flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-[var(--nt-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className="nt-r-sm flex h-6 w-6 shrink-0 items-center justify-center"
          style={{
            background: "var(--nt-accent-soft)",
            color: "var(--nt-accent)",
          }}
        >
          {c.group === "local" ? (
            <Cpu size={13} strokeWidth={1.75} />
          ) : (
            <Cloud size={13} strokeWidth={1.75} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
              {c.label}
            </span>
            {selected && (
              <Check size={13} strokeWidth={2.5} className="shrink-0" style={{ color: "var(--nt-accent)" }} />
            )}
          </span>
          <span className="block truncate text-[11px]" style={{ color: "var(--nt-text-3)" }}>
            {c.available ? c.detail : c.unavailableReason}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
          if (!open) void load();
        }}
        title="Switch model — used for everything the agent does"
        aria-label="Switch model"
        aria-expanded={open}
        className="nt-r-full flex max-w-[190px] items-center gap-1.5 border px-2.5 py-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
        style={{
          borderColor: open ? "var(--nt-accent)" : "var(--nt-border)",
          background: "var(--nt-bg-raised)",
        }}
      >
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: "var(--nt-text-1)" }}>
          {activeChoice ? activeChoice.label : "Model"}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className="shrink-0 transition-transform"
          style={{ color: "var(--nt-text-3)", transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>

      {open && (
        <div
          className="nt-fade-in nt-r-md absolute left-0 top-full z-50 mt-1.5 w-[280px] border p-1.5 shadow-xl"
          style={{
            background: "var(--nt-bg-overlay)",
            borderColor: "var(--nt-border)",
            boxShadow: "var(--nt-shadow-card)",
          }}
          role="menu"
          aria-label="Choose model"
        >
          {choices === null ? (
            <p className="px-2.5 py-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              Loading models…
            </p>
          ) : (
            <>
              <p className="nt-micro px-2.5 pb-1 pt-1.5">Local</p>
              {localChoices.length === 0 && (
                <p className="px-2.5 py-1 text-[12px]" style={{ color: "var(--nt-text-faint)" }}>
                  No local models yet.
                </p>
              )}
              {localChoices.map(row)}
              <p className="nt-micro px-2.5 pb-1 pt-2">Cloud · BYOK</p>
              {cloudChoices.length === 0 && (
                <p className="px-2.5 py-1 text-[12px]" style={{ color: "var(--nt-text-faint)" }}>
                  No providers — add one in Settings → Providers.
                </p>
              )}
              {cloudChoices.map(row)}
              {error && (
                <p className="px-2.5 py-1.5 text-[12px]" style={{ color: "#d97362" }}>
                  {error}
                </p>
              )}
              <p className="border-t px-2.5 pb-1 pt-2 text-[11px] leading-snug" style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-faint)" }}>
                This model answers everything: agent chat, skills, writing help, summaries, and voice.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
