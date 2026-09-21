/**
 * AI Tidy review dialog.
 *
 * The local model proposes folder groupings + closures; NOTHING is applied
 * until the user explicitly confirms. Every group and every closure has
 * its own checkbox (all on by default), folder names are editable, and
 * closures are framed as "move to Archive" — restorable, never destroyed.
 */

import { Archive, FolderPlus, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TabState, TidyActions, TidyPlan } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { domainOf, nt } from "../nt";
import { Favicon } from "./Favicon";

interface GroupDraft {
  key: number;
  name: string;
  tabIds: string[];
  checked: boolean;
}

interface CloseDraft {
  tabId: string;
  reason: string;
  checked: boolean;
}

export function TidyDialog({
  spaceId,
  onClose,
}: {
  spaceId: string;
  onClose: () => void;
}) {
  const { activeSpace } = useBrowser();
  const [phase, setPhase] = useState<"loading" | "review" | "error" | "applying">("loading");
  const [error, setError] = useState("");
  const [via, setVia] = useState("");
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [closes, setCloses] = useState<CloseDraft[]>([]);

  const tabsById = useMemo(() => {
    const m = new Map<string, TabState>();
    for (const t of activeSpace?.tabs ?? []) m.set(t.id, t);
    return m;
  }, [activeSpace]);

  useEffect(() => {
    let alive = true;
    nt()
      .tidyPlan(spaceId)
      .then((plan: TidyPlan) => {
        if (!alive) return;
        setVia(plan.via);
        setGroups(
          plan.groups.map((g, i) => ({
            key: i,
            name: g.name,
            tabIds: g.tabIds,
            checked: true,
          })),
        );
        setCloses(
          plan.close.map((c) => ({ tabId: c.tabId, reason: c.reason, checked: true })),
        );
        setPhase("review");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [spaceId]);

  const chosenGroups = groups.filter((g) => g.checked && g.tabIds.length > 0 && g.name.trim());
  const chosenCloses = closes.filter((c) => c.checked);
  const nothingChosen = chosenGroups.length === 0 && chosenCloses.length === 0;

  const apply = () => {
    if (nothingChosen) return;
    setPhase("applying");
    const actions: TidyActions = {
      newFolders: chosenGroups.map((g) => ({ name: g.name.trim(), tabIds: g.tabIds })),
      closeTabIds: chosenCloses.map((c) => c.tabId),
    };
    nt()
      .tidyApply(spaceId, actions)
      .then(onClose)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Tidy tabs"
    >
      <div
        className="nt-popover nt-r-lg nt-fade-in flex max-h-[80vh] w-[520px] flex-col border shadow-2xl"
        style={{
          background: "var(--nt-bg-overlay)",
          borderColor: "var(--nt-border)",
          boxShadow: "var(--nt-shadow-overlay)",
        }}
      >
        <div
          className="flex items-center gap-2.5 border-b px-5 py-4"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <Sparkles size={17} strokeWidth={1.75} style={{ color: "var(--nt-accent)" }} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
              Tidy tabs
            </h2>
            <p className="truncate text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              {phase === "loading"
                ? "Asking a local model to organize your tabs…"
                : via
                  ? `Suggested locally by ${via} — nothing leaves this device`
                  : "Review before anything changes"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase === "loading" && (
            <div className="flex items-center justify-center gap-2.5 py-14">
              <Loader2 size={18} strokeWidth={1.75} className="animate-spin" style={{ color: "var(--nt-accent)" }} />
              <p className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
                Reading your open tabs (on-device)…
              </p>
            </div>
          )}

          {phase === "error" && (
            <div className="py-8 text-center">
              <p className="text-[14px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                Couldn't tidy right now
              </p>
              <p className="mx-auto mt-2 max-w-sm text-[13px]" style={{ color: "var(--nt-text-2)" }}>
                {error}
              </p>
              <button
                onClick={onClose}
                className="nt-r-sm mt-4 border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
                style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
              >
                Close
              </button>
            </div>
          )}

          {phase === "review" && (
            <div className="space-y-5">
              {chosenGroups.length === 0 && chosenCloses.length === 0 && (
                <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
                  Uncheck everything to skip — nothing will change.
                </p>
              )}

              {groups.length > 0 && (
                <section>
                  <p className="nt-micro mb-2 flex items-center gap-1.5">
                    <FolderPlus size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
                    New folders
                  </p>
                  <div className="space-y-2.5">
                    {groups.map((g) => (
                      <div
                        key={g.key}
                        className="nt-r-md border p-3"
                        style={{
                          borderColor: "var(--nt-border)",
                          background: "var(--nt-bg-raised)",
                          opacity: g.checked ? 1 : 0.55,
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={g.checked}
                            onChange={() =>
                              setGroups((gs) =>
                                gs.map((x) => (x.key === g.key ? { ...x, checked: !x.checked } : x)),
                              )
                            }
                            className="h-4 w-4 shrink-0 accent-[#E8A33D]"
                            aria-label={`Include folder ${g.name}`}
                          />
                          <input
                            value={g.name}
                            onChange={(e) =>
                              setGroups((gs) =>
                                gs.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)),
                              )
                            }
                            className="nt-r-sm min-w-0 flex-1 border bg-transparent px-2 py-1 text-[13px] font-medium outline-none"
                            style={{
                              borderColor: "var(--nt-border)",
                              color: "var(--nt-text-1)",
                            }}
                            maxLength={40}
                            aria-label="Folder name"
                          />
                          <span className="nt-num shrink-0 text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
                            {g.tabIds.length} tabs
                          </span>
                        </div>
                        <div className="mt-2 space-y-1 pl-7">
                          {g.tabIds.map((id) => {
                            const t = tabsById.get(id);
                            if (!t) return null;
                            return (
                              <div key={id} className="flex items-center gap-2">
                                <Favicon url={t.url} favicon={t.favicon} size={13} />
                                <p className="truncate text-[12px]" style={{ color: "var(--nt-text-2)" }}>
                                  {t.title || "New tab"}
                                </p>
                                <p className="nt-mono shrink-0 text-[10px]" style={{ color: "var(--nt-text-faint)" }}>
                                  {domainOf(t.url)}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {closes.length > 0 && (
                <section>
                  <p className="nt-micro mb-2 flex items-center gap-1.5">
                    <Archive size={13} strokeWidth={1.75} style={{ color: "var(--nt-text-3)" }} />
                    Move to Archive
                  </p>
                  <div
                    className="nt-r-md space-y-1 border p-2"
                    style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
                  >
                    {closes.map((c) => {
                      const t = tabsById.get(c.tabId);
                      if (!t) return null;
                      return (
                        <label
                          key={c.tabId}
                          className="nt-r-sm flex cursor-pointer items-center gap-2.5 px-2 py-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
                          style={{ opacity: c.checked ? 1 : 0.55 }}
                        >
                          <input
                            type="checkbox"
                            checked={c.checked}
                            onChange={() =>
                              setCloses((cs) =>
                                cs.map((x) => (x.tabId === c.tabId ? { ...x, checked: !x.checked } : x)),
                              )
                            }
                            className="h-4 w-4 shrink-0 accent-[#E8A33D]"
                          />
                          <Favicon url={t.url} favicon={t.favicon} size={13} />
                          <div className="min-w-0 flex-1 leading-tight">
                            <p className="truncate text-[12px] font-medium" style={{ color: "var(--nt-text-1)" }}>
                              {t.title || "New tab"}
                            </p>
                            <p className="truncate text-[11px]" style={{ color: "var(--nt-text-3)" }}>
                              {c.reason}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
                    Archived tabs stay restorable from the Archive section.
                  </p>
                </section>
              )}
            </div>
          )}

          {phase === "applying" && (
            <div className="flex items-center justify-center gap-2.5 py-14">
              <Loader2 size={18} strokeWidth={1.75} className="animate-spin" style={{ color: "var(--nt-accent)" }} />
              <p className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
                Applying your choices…
              </p>
            </div>
          )}
        </div>

        {phase === "review" && (
          <div
            className="flex items-center justify-end gap-2 border-t px-5 py-3.5"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <button
              onClick={onClose}
              className="nt-r-sm px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{ color: "var(--nt-text-2)" }}
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={nothingChosen}
              className="nt-r-sm px-4 py-2 text-[13px] font-semibold transition-all hover:brightness-110 disabled:opacity-40"
              style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
            >
              Apply changes
              {(chosenGroups.length > 0 || chosenCloses.length > 0) &&
                ` (${chosenGroups.length + chosenCloses.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
