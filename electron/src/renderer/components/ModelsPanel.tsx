/**
 * Model Manager panel (rendered inside Settings by the integrator).
 *
 * On-device model catalog, per-task assignment, downloads with progress,
 * and disk usage — all through the window.nt bridge. The integrator
 * implements the models* methods in the preload; this file only declares
 * the local interface and casts.
 */

import {
  Brain,
  Check,
  ChevronDown,
  Cpu,
  Download,
  Eye,
  HardDrive,
  Loader2,
  Mic,
  RefreshCw,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { nt } from "../nt";

/* ------------------------- bridge (local contract) ------------------------ */

interface ModelEntryPublic {
  id: string;
  name: string;
  task: "chat" | "vision" | "stt" | "tts";
  params: string;
  quant: string;
  sizeBytes: number;
  description: string;
  license: string;
  downloaded: boolean;
  downloading: boolean;
  bytesDownloaded: number;
  totalBytes: number;
}

type ModelEvent =
  | { kind: "progress"; id: string; bytesDownloaded: number; totalBytes: number }
  | { kind: "done"; id: string }
  | { kind: "error"; id: string; error: string };

interface NtModels {
  modelsList(): Promise<ModelEntryPublic[]>;
  modelsDownload(id: string): Promise<void>;
  modelsCancelDownload(id: string): Promise<void>;
  modelsRemove(id: string): Promise<void>;
  modelsGetAssignment(): Promise<{ chat: string; vision: string }>;
  modelsSetAssignment(task: "chat" | "vision", ref: string): Promise<void>;
  modelsAppleFm(): Promise<{ available: boolean; reason?: string }>;
  modelsDiskUsage(): Promise<number>;
  onModelEvent(cb: (e: ModelEvent) => void): () => void;
  // HF token (registered in main/models/ipc.ts; needs the matching preload
  // methods — the panel degrades gracefully when they're absent).
  modelsHfTokenSet?(token: string): Promise<{ ok: true }>;
  modelsHfTokenHas?(): Promise<boolean>;
  modelsHfTokenClear?(): Promise<void>;
  modelsGatedIds?(): Promise<string[]>;
}

/** Bridge handle; throws the same way nt() does when unavailable. */
function modelsApi(): NtModels {
  return nt() as unknown as NtModels;
}

/**
 * Sentinel assignment refs understood by the main process:
 * APPLE_FM_REF = Apple's Foundation Models, CLOUD_REF = BYOK cloud fallback.
 * Anything else is a catalog model id.
 */
const APPLE_FM_REF = "apple-fm";
const CLOUD_REF = "cloud";

const GROUPS: Array<{
  task: ModelEntryPublic["task"];
  label: string;
  icon: typeof Brain;
}> = [
  { task: "chat", label: "Chat", icon: Brain },
  { task: "vision", label: "Vision", icon: Eye },
  { task: "stt", label: "Voice input (STT)", icon: Mic },
  { task: "tts", label: "Voice output (TTS)", icon: Volume2 },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function progressPct(e: ModelEntryPublic): number {
  if (!e.totalBytes || e.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((e.bytesDownloaded / e.totalBytes) * 100));
}

/* -------------------------------- component ------------------------------- */

export function ModelsPanel() {
  const [entries, setEntries] = useState<ModelEntryPublic[] | null>(null);
  const [apple, setApple] = useState<{
    available: boolean;
    reason?: string;
    /** True when only the sidecar binary is missing — show setup steps, not an error. */
    setupRequired?: boolean;
  } | null>(null);
  const [assignment, setAssignment] = useState<{ chat: string; vision: string }>({
    chat: CLOUD_REF,
    vision: CLOUD_REF,
  });
  const [diskBytes, setDiskBytes] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [assignBusy, setAssignBusy] = useState<"" | "chat" | "vision">("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [activeModelLabel, setActiveModelLabel] = useState<string | null>(null);
  // HF token: null = preload doesn't support it yet (older build) → hide card.
  const [hfTokenSaved, setHfTokenSaved] = useState<boolean | null>(null);
  const [hfTokenInput, setHfTokenInput] = useState("");
  const [hfTokenBusy, setHfTokenBusy] = useState(false);
  const [hfTokenError, setHfTokenError] = useState<string | null>(null);
  const [gatedIds, setGatedIds] = useState<string[]>([]);

  /** The unified active model drives every LLM call — keep its label fresh. */
  const loadActiveModelLabel = useCallback(async () => {
    try {
      const [choices, active] = await Promise.all([
        nt().modelsChoices(),
        nt().modelsGetActive(),
      ]);
      const key = `${active.kind}:${active.id ?? ""}`;
      const match = choices.find((c) => `${c.ref.kind}:${c.ref.id ?? ""}` === key);
      setActiveModelLabel(match ? match.label : "—");
    } catch {
      /* bridge unavailable */
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const api = modelsApi();
      const [list, fm, assign, usage] = await Promise.all([
        api.modelsList(),
        api.modelsAppleFm(),
        api.modelsGetAssignment(),
        api.modelsDiskUsage(),
      ]);
      setEntries(list);
      setApple(fm);
      setAssignment(assign);
      setDiskBytes(usage);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadActiveModelLabel();
    // HF token state lives behind new preload methods; a missing bridge
    // (older build) hides the token card instead of breaking the panel.
    void (async () => {
      try {
        const api = modelsApi();
        if (!api.modelsHfTokenHas || !api.modelsGatedIds) return;
        const [has, gated] = await Promise.all([
          api.modelsHfTokenHas(),
          api.modelsGatedIds(),
        ]);
        setHfTokenSaved(has);
        setGatedIds(gated);
      } catch {
        /* token bridge unavailable — card stays hidden */
      }
    })();
    let off: (() => void) | undefined;
    try {
      off = nt().onActiveModel(() => void loadActiveModelLabel());
    } catch {
      /* no bridge */
    }
    return () => off?.();
  }, [load, loadActiveModelLabel]);

  // Live updates: progress ticks update the row in place; done/error do a
  // full refresh (list, assignment options, disk usage).
  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = modelsApi().onModelEvent((e) => {
        if (e.kind === "progress") {
          setEntries((prev) =>
            prev?.map((m) =>
              m.id === e.id
                ? {
                    ...m,
                    downloading: true,
                    bytesDownloaded: e.bytesDownloaded,
                    totalBytes: e.totalBytes,
                  }
                : m,
            ) ?? prev,
          );
        } else if (e.kind === "done") {
          setRowErrors((prev) => {
            const next = { ...prev };
            delete next[e.id];
            return next;
          });
          void load();
        } else {
          // A user-cancelled download is a quiet state reset, not an error:
          // the main process already cleared its progress map, so the row
          // goes back to the Download button and can be retried (resuming).
          if (/cancelled/i.test(e.error ?? "")) {
            setRowErrors((prev) => {
              const next = { ...prev };
              delete next[e.id];
              return next;
            });
          } else {
            setRowErrors((prev) => ({ ...prev, [e.id]: e.error }));
          }
          void load();
        }
      });
    } catch {
      // Bridge unavailable — the load error state already covers this.
    }
    return () => {
      unsub?.();
    };
  }, [load]);

  /* --------------------------------- actions ------------------------------ */

  const clearRowError = (id: string) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const download = async (id: string) => {
    clearRowError(id);
    // Optimistic state; the real progress arrives via ModelEvent.
    setEntries((prev) =>
      prev?.map((m) => (m.id === id ? { ...m, downloading: true } : m)) ?? prev,
    );
    try {
      await modelsApi().modelsDownload(id);
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err),
      }));
      void load();
    }
  };

  const cancelDownload = async (id: string) => {
    try {
      await modelsApi().modelsCancelDownload(id);
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      void load();
    }
  };

  const remove = async (id: string) => {
    setConfirmRemoveId(null);
    try {
      await modelsApi().modelsRemove(id);
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      void load();
    }
  };

  const setAssign = async (task: "chat" | "vision", ref: string) => {
    setAssignBusy(task);
    setAssignError(null);
    try {
      await modelsApi().modelsSetAssignment(task, ref);
      setAssignment((prev) => ({ ...prev, [task]: ref }));
      // The chat assignment IS the active model for everything the agent does:
      // choosing a local chat model here switches the unified active model too.
      if (task === "chat") {
        const activeRef =
          ref === APPLE_FM_REF
            ? { kind: "local-applefm" as const }
            : ref !== CLOUD_REF
              ? { kind: "local" as const, id: ref }
              : null;
        if (activeRef) await nt().modelsSetActive(activeRef);
        await loadActiveModelLabel();
      }
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssignBusy("");
    }
  };

  /* ------------------------------ HF token -------------------------------- */

  const saveHfToken = async () => {
    const api = modelsApi();
    if (!api.modelsHfTokenSet) return;
    setHfTokenBusy(true);
    setHfTokenError(null);
    try {
      await api.modelsHfTokenSet(hfTokenInput);
      setHfTokenInput("");
      setHfTokenSaved(true);
    } catch (err) {
      setHfTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setHfTokenBusy(false);
    }
  };

  const clearHfToken = async () => {
    const api = modelsApi();
    if (!api.modelsHfTokenClear) return;
    setHfTokenBusy(true);
    setHfTokenError(null);
    try {
      await api.modelsHfTokenClear();
      setHfTokenSaved(false);
    } catch (err) {
      setHfTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setHfTokenBusy(false);
    }
  };

  /* --------------------------------- render ------------------------------- */

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[13px]" style={{ color: "#d97362" }}>
          Couldn't load models: {loadError}
        </p>
        <button
          onClick={() => void load()}
          className="nt-r-sm flex items-center gap-1.5 border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          <RefreshCw size={14} strokeWidth={1.75} />
          Retry
        </button>
      </div>
    );
  }

  if (!entries || !apple) {
    return (
      <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
        Loading models…
      </p>
    );
  }

  const downloadedFor = (task: "chat" | "vision") =>
    entries.filter((e) => e.task === task && e.downloaded);

  const chatValue = [APPLE_FM_REF, CLOUD_REF, ...downloadedFor("chat").map((e) => e.id)].includes(
    assignment.chat,
  )
    ? assignment.chat
    : CLOUD_REF;
  const visionValue = [CLOUD_REF, ...downloadedFor("vision").map((e) => e.id)].includes(
    assignment.vision,
  )
    ? assignment.vision
    : CLOUD_REF;

  return (
    <div>
      {/* ------------------------- On-device / Apple FM ---------------------- */}
      <h3
        className="mb-2 text-[13px] font-semibold"
        style={{ color: "var(--nt-text-1)" }}
      >
        On-device
      </h3>
      <div
        className="nt-r-md border p-4"
        style={{
          borderColor: "var(--nt-border)",
          background: "var(--nt-bg-raised)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Cpu
              size={18}
              strokeWidth={1.75}
              className="shrink-0"
              style={{ color: "var(--nt-text-2)" }}
            />
            <div className="min-w-0">
              <p
                className="text-[13px] font-medium"
                style={{ color: "var(--nt-text-1)" }}
              >
                Apple Foundation Models
              </p>
              <p
                className="mt-0.5 text-[12px]"
                style={{ color: "var(--nt-text-3)" }}
              >
                Free, private, always on-device (macOS 26+).
              </p>
            </div>
          </div>
          <span
            className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-[12px] font-medium"
            style={{
              borderColor: apple.available
                ? "rgba(111,162,135,0.4)"
                : apple.setupRequired
                  ? "rgba(196,158,74,0.45)"
                  : "rgba(217,115,98,0.4)",
              color: apple.available
                ? "#6fa287"
                : apple.setupRequired
                  ? "#c49e4a"
                  : "#d97362",
              background: apple.available
                ? "rgba(111,162,135,0.08)"
                : apple.setupRequired
                  ? "rgba(196,158,74,0.08)"
                  : "rgba(217,115,98,0.08)",
            }}
          >
            {apple.available ? (
              <Check size={13} strokeWidth={2.5} />
            ) : apple.setupRequired ? (
              <Cpu size={13} strokeWidth={1.75} />
            ) : (
              <X size={13} strokeWidth={2.5} />
            )}
            {apple.available
              ? "Available"
              : apple.setupRequired
                ? "Setup required"
                : "Unavailable"}
          </span>
        </div>
        {apple.setupRequired ? (
          <div className="mt-3">
            <p className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
              One-time setup — build Apple's on-device bridge on your Mac:
            </p>
            <ol
              className="mt-1.5 list-decimal space-y-1 pl-5 text-[12.5px]"
              style={{ color: "var(--nt-text-2)" }}
            >
              <li>Open Terminal on your Mac.</li>
              <li>
                Run the build script from the Next Token source:{" "}
                <code
                  className="nt-r-sm px-1.5 py-0.5 text-[12px]"
                  style={{
                    background: "var(--nt-bg-hover)",
                    color: "var(--nt-text-1)",
                  }}
                >
                  cd electron/native/applefm &amp;&amp; ./build.sh
                </code>
              </li>
              <li>Restart Next Token — it picks the bridge up automatically.</li>
            </ol>
            <p
              className="mt-1.5 text-[12px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              Requires macOS 26 (Tahoe) or later with Apple Intelligence
              enabled, plus Xcode 26+ command line tools. The script installs
              the bridge into the app for you — nothing else to configure.
            </p>
          </div>
        ) : (
          !apple.available &&
          apple.reason && (
            <p className="mt-2 text-[12px]" style={{ color: "#d97362" }}>
              {apple.reason}
            </p>
          )
        )}
      </div>

      {/* ------------------------- Hugging Face token ------------------------ */}
      {hfTokenSaved !== null && (
        <div
          className="nt-r-md mt-4 border p-4"
          style={{
            borderColor: "var(--nt-border)",
            background: "var(--nt-bg-raised)",
          }}
        >
          <p
            className="text-[13px] font-medium"
            style={{ color: "var(--nt-text-1)" }}
          >
            Hugging Face token{" "}
            <span
              className="font-normal"
              style={{ color: "var(--nt-text-3)" }}
            >
              (optional)
            </span>
          </p>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            Every model below downloads with no sign-in. The token is an
            optional fallback in case a repo ever gates access. Stored in
            your OS keychain — never leaves this device.
          </p>
          {hfTokenSaved ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <span
                className="flex items-center gap-1.5 text-[12.5px] font-medium"
                style={{ color: "#6fa287" }}
              >
                <Check size={13} strokeWidth={2.5} />
                Token saved
              </span>
              <button
                onClick={() => void clearHfToken()}
                disabled={hfTokenBusy}
                className="nt-r-sm border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
                style={{
                  borderColor: "var(--nt-border)",
                  color: "var(--nt-text-2)",
                }}
              >
                {hfTokenBusy ? "Working…" : "Remove"}
              </button>
            </div>
          ) : (
            <div className="mt-2.5 flex items-center gap-2">
              <input
                type="password"
                value={hfTokenInput}
                onChange={(e) => setHfTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveHfToken();
                }}
                placeholder="hf_…"
                autoComplete="off"
                spellCheck={false}
                className="nt-r-sm min-w-0 flex-1 border bg-[var(--nt-bg-base)] px-3 py-1.5 text-[13px] outline-none focus:border-[var(--nt-accent)]"
                style={{
                  borderColor: "var(--nt-border)",
                  color: "var(--nt-text-1)",
                }}
              />
              <button
                onClick={() => void saveHfToken()}
                disabled={hfTokenBusy || !hfTokenInput.trim()}
                className="nt-r-sm shrink-0 px-3 py-1.5 text-[12.5px] font-semibold transition-transform hover:scale-[1.03] disabled:opacity-60"
                style={{
                  background: "var(--nt-accent)",
                  color: "var(--nt-accent-text)",
                }}
              >
                {hfTokenBusy ? "Saving…" : "Save"}
              </button>
            </div>
          )}
          {hfTokenError && (
            <p className="mt-2 text-[12.5px]" style={{ color: "#d97362" }}>
              {hfTokenError}
            </p>
          )}
        </div>
      )}

      {/* --------------------------- Per-task assignment --------------------- */}
      <h3
        className="mb-2 mt-6 text-[13px] font-semibold"
        style={{ color: "var(--nt-text-1)" }}
      >
        Model assignment
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <AssignmentSelect
            label="Chat model"
            value={chatValue}
            busy={assignBusy === "chat"}
            disabled={assignBusy !== ""}
            onChange={(v) => void setAssign("chat", v)}
            options={[
              ...(apple.available
                ? [{ value: APPLE_FM_REF, label: "Apple Foundation Models" }]
                : []),
              ...downloadedFor("chat").map((e) => ({
                value: e.id,
                label: `${e.name} (${formatBytes(e.sizeBytes)})`,
              })),
              { value: CLOUD_REF, label: "Cloud (BYOK fallback)" },
            ]}
          />
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--nt-text-3)" }}>
            Active model:{" "}
            <span className="font-medium" style={{ color: "var(--nt-accent)" }}>
              {activeModelLabel ?? "…"}
            </span>{" "}
            — answers everything, everywhere. Pick a cloud model from the switcher in the
            Agent tab.
          </p>
        </div>
        <AssignmentSelect
          label="Vision model"
          value={visionValue}
          busy={assignBusy === "vision"}
          disabled={assignBusy !== ""}
          onChange={(v) => void setAssign("vision", v)}
          options={[
            ...downloadedFor("vision").map((e) => ({
              value: e.id,
              label: `${e.name} (${formatBytes(e.sizeBytes)})`,
            })),
            { value: CLOUD_REF, label: "Cloud (BYOK fallback)" },
          ]}
        />
      </div>
      {assignError && (
        <p className="mt-2 text-[12.5px]" style={{ color: "#d97362" }}>
          Couldn't save assignment: {assignError}
        </p>
      )}

      {/* ------------------------------- Catalog ----------------------------- */}
      {GROUPS.map((g) => {
        const rows = entries.filter((e) => e.task === g.task);
        if (rows.length === 0) return null;
        const Icon = g.icon;
        return (
          <div key={g.task} className="mt-6">
            <h3
              className="mb-2 flex items-center gap-2 text-[13px] font-semibold"
              style={{ color: "var(--nt-text-1)" }}
            >
              <Icon size={14} strokeWidth={1.75} />
              {g.label}
            </h3>
            <div className="space-y-2">
              {rows.map((e) => (
                <ModelRow
                  key={e.id}
                  entry={e}
                  gated={gatedIds.includes(e.id)}
                  error={rowErrors[e.id]}
                  confirmRemove={confirmRemoveId === e.id}
                  onDownload={() => void download(e.id)}
                  onCancel={() => void cancelDownload(e.id)}
                  onRemove={() =>
                    confirmRemoveId === e.id
                      ? void remove(e.id)
                      : setConfirmRemoveId(e.id)
                  }
                  onCancelRemove={() => setConfirmRemoveId(null)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* -------------------------------- Footer ----------------------------- */}
      <div
        className="mt-6 flex items-center gap-2 border-t pt-4"
        style={{ borderColor: "var(--nt-border)" }}
      >
        <HardDrive
          size={14}
          strokeWidth={1.75}
          style={{ color: "var(--nt-text-3)" }}
        />
        <p className="text-[13px]" style={{ color: "var(--nt-text-2)" }}>
          Models use {formatBytes(diskBytes)} on disk.
        </p>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
        Cloud (BYOK) remains available as a fallback — configure it in
        Settings → AI Provider.
      </p>
    </div>
  );
}

/* --------------------------------- bits ---------------------------------- */

function AssignmentSelect({
  label,
  value,
  options,
  busy,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  busy: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span
        className="mb-1.5 block text-[12px] font-medium"
        style={{ color: "var(--nt-text-1)" }}
      >
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="nt-r-sm w-full appearance-none border bg-[var(--nt-bg-base)] py-2 pl-3 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--nt-accent)] disabled:opacity-60"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
          style={{ color: "var(--nt-text-3)" }}
        >
          {busy ? (
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              className="pointer-events-none"
            />
          )}
        </span>
      </div>
    </label>
  );
}

function ModelRow({
  entry: e,
  gated,
  error,
  confirmRemove,
  onDownload,
  onCancel,
  onRemove,
  onCancelRemove,
}: {
  entry: ModelEntryPublic;
  gated: boolean;
  error?: string;
  confirmRemove: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onCancelRemove: () => void;
}) {
  const pct = progressPct(e);
  return (
    <div
      className="nt-r-md border p-3.5"
      style={{
        borderColor: "var(--nt-border)",
        background: "var(--nt-bg-raised)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium"
            style={{ color: "var(--nt-text-1)" }}
          >
            {e.name}
            {gated && (
              <span
                className="nt-r-sm border px-1.5 py-0.5 text-[11px] font-medium"
                title="This model is access-gated on Hugging Face — add an HF token above to download it."
                style={{
                  borderColor: "rgba(196,158,74,0.45)",
                  color: "#c49e4a",
                  background: "rgba(196,158,74,0.08)",
                }}
              >
                Requires HF token
              </span>
            )}
          </p>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            {e.params} · {e.quant} · {formatBytes(e.sizeBytes)} · {e.license}
          </p>
          {e.description && (
            <p
              className="mt-1 text-[12.5px]"
              style={{ color: "var(--nt-text-2)" }}
            >
              {e.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!e.downloading && !e.downloaded && (
            <button
              onClick={onDownload}
              className="nt-r-sm flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-semibold transition-transform hover:scale-[1.03]"
              style={{
                background: "var(--nt-accent)",
                color: "var(--nt-accent-text)",
              }}
            >
              <Download size={13} strokeWidth={1.75} />
              Download
            </button>
          )}
          {e.downloaded && (
            <>
              <span
                className="flex items-center gap-1.5 text-[12.5px] font-medium"
                style={{ color: "#6fa287" }}
              >
                <Check size={13} strokeWidth={2.5} />
                Installed
              </span>
              {confirmRemove ? (
                <>
                  <button
                    onClick={onRemove}
                    title={`Remove ${e.name}`}
                    className="nt-r-sm flex items-center gap-1 px-2.5 py-1.5 text-[12.5px] font-semibold"
                    style={{
                      background: "#d97362",
                      color: "var(--nt-accent-text)",
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={onCancelRemove}
                    title="Keep model"
                    className="nt-r-sm border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-[var(--nt-bg-hover)]"
                    style={{
                      borderColor: "var(--nt-border)",
                      color: "var(--nt-text-2)",
                    }}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  onClick={onRemove}
                  title={`Remove ${e.name}`}
                  className="nt-r-sm flex items-center gap-1 border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
                  style={{
                    borderColor: "var(--nt-border)",
                    color: "var(--nt-text-2)",
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {e.downloading && (
        <div className="mt-2.5">
          <div
            className="nt-r-sm h-1.5 overflow-hidden"
            style={{ background: "var(--nt-bg-hover)" }}
          >
            <div
              className="h-full transition-all"
              style={{
                width: `${pct}%`,
                background: "var(--nt-accent)",
              }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
              {pct}% · {formatBytes(e.bytesDownloaded)} of{" "}
              {e.totalBytes > 0 ? formatBytes(e.totalBytes) : "…"}
            </p>
            <button
              onClick={onCancel}
              className="nt-r-sm flex items-center gap-1 border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
              style={{
                borderColor: "var(--nt-border)",
                color: "var(--nt-text-2)",
              }}
            >
              <X size={12} strokeWidth={1.75} />
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[12.5px]" style={{ color: "#d97362" }}>
          {error}
        </p>
      )}
    </div>
  );
}
