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
  Sparkles,
  Square,
  Stethoscope,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { nt } from "../nt";
import type { LocalModelMetrics, TaskModelSlotInfo } from "../../shared/ipc";

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

/** Step-by-step Apple FM diagnostic result (main/models/applefm.ts). */
interface AppleFmDiagStep {
  name: string;
  label: string;
  ok: boolean;
  ms: number;
  detail: string;
}
interface AppleFmDiagnosis {
  ok: boolean;
  summary: string;
  steps: AppleFmDiagStep[];
}
/** Model Advisor types (main/models/advisor.ts). */
interface AdvisorPickEntry {
  id: string;
  name: string;
  params: string;
  quant: string;
  sizeBytes: number;
  description: string;
  license: string;
}
interface AdvisorPick {
  entry: AdvisorPickEntry;
  weightsBytes: number;
  kvBytes: number;
  overheadBytes: number;
  requiredBytes: number;
  utilization: number;
  verdict: "comfortable" | "fits" | "tight" | "too-big";
  verdictLabel: string;
  estTokPerSec: number | null;
  kvEstimated: boolean;
  score: number;
  reasons: string[];
}
interface AdvisorResult {
  device: {
    chipLabel: string;
    cpuCores: number;
    totalRamBytes: number;
    budgetBytes: number;
    bandwidthGBps: number | null;
    note: string | null;
    fullyDetected: boolean;
  };
  picks: AdvisorPick[];
  considered: number;
  nothingFits: boolean;
}

interface NtModels {  modelsList(): Promise<ModelEntryPublic[]>;
  modelsDownload(id: string): Promise<void>;
  modelsCancelDownload(id: string): Promise<void>;
  modelsRemove(id: string): Promise<void>;
  /** Running llama-server state per slot (newer builds). */
  modelsServerStatus?(): Promise<{
    chat: { running: boolean; modelId: string | null };
    vision: { running: boolean; modelId: string | null };
  }>;
  /** Stop a running local-model server immediately (newer builds). */
  modelsStopServer?(slot: "chat" | "vision"): Promise<void>;
  modelsGetAssignment(): Promise<{ chat: string; vision: string }>;
  modelsSetAssignment(task: "chat" | "vision", ref: string): Promise<void>;
  /** Task-model registry (newer builds): the four task slots and what serves each. */
  modelsTaskModels?(): Promise<TaskModelSlotInfo[]>;
  modelsSetVision?(ref: string): Promise<void>;
  modelsAppleFm(): Promise<{ available: boolean; reason?: string }>;
  /** Step-by-step diagnostics with the bridge's real stderr (newer builds). */
  modelsAppleFmDiagnose?(): Promise<AppleFmDiagnosis>;
  /** Device capabilities for the Model Advisor (newer builds). */
  modelsDeviceInfo?(): Promise<AdvisorResult["device"]>;
  /** Ranked chat-model recommendations for the detected device (newer builds). */
  modelsAdvisor?(): Promise<AdvisorResult>;
  modelsDiskUsage(): Promise<number>;
  onModelEvent(cb: (e: ModelEvent) => void): () => void;
  // HF token (registered in main/models/ipc.ts; needs the matching preload
  // methods — the panel degrades gracefully when they're absent).
  modelsHfTokenSet?(token: string): Promise<{ ok: true }>;
  modelsHfTokenHas?(): Promise<boolean>;
  modelsHfTokenClear?(): Promise<void>;
  modelsGatedIds?(): Promise<string[]>;
  /** Latest measured local-model turn (newer builds; null until the first local turn). */
  modelsLocalMetrics?(): Promise<LocalModelMetrics | null>;
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

export function ModelsPanel({ focusTask }: { focusTask?: string }) {
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
  // Task-model registry: one serving model per task. null = older build without the bridge.
  const [slots, setSlots] = useState<TaskModelSlotInfo[] | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  // Focus highlight: when the vision-missing nudge opens this panel, draw the
  // eye to the Vision slot card.
  const [visionFocus, setVisionFocus] = useState(false);
  // HF token: null = preload doesn't support it yet (older build) → hide card.
  const [hfTokenSaved, setHfTokenSaved] = useState<boolean | null>(null);
  const [hfTokenInput, setHfTokenInput] = useState("");
  const [hfTokenBusy, setHfTokenBusy] = useState(false);
  const [hfTokenError, setHfTokenError] = useState<string | null>(null);
  const [gatedIds, setGatedIds] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<LocalModelMetrics | null>(null);
  // Running local-model servers (llama-server): null = preload doesn't
  // support it yet (older build) → hide the "Running now" card.
  const [serverStatus, setServerStatus] = useState<{
    chat: { running: boolean; modelId: string | null };
    vision: { running: boolean; modelId: string | null };
  } | null>(null);
  const [stoppingSlot, setStoppingSlot] = useState<"" | "chat" | "vision">("");
  // Apple FM diagnostics: null = not run yet.
  const [diag, setDiag] = useState<AppleFmDiagnosis | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  // Model Advisor: null = not loaded yet (or bridge too old).
  const [advisor, setAdvisor] = useState<AdvisorResult | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(false);
  // Advisor one-click flow: model id being downloaded so it can be activated.
  const [pendingUseId, setPendingUseId] = useState<string | null>(null);

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

  /** Run the Apple FM step-by-step diagnostics (probe + test inference). */
  const runDiagnostics = useCallback(async () => {
    const api = modelsApi();
    if (!api.modelsAppleFmDiagnose) return;
    setDiagRunning(true);
    setDiag(null);
    try {
      const result = await api.modelsAppleFmDiagnose();
      setDiag(result);
    } catch (err) {
      setDiag({
        ok: false,
        summary: `Diagnostics themselves failed: ${err instanceof Error ? err.message : String(err)}`,
        steps: [],
      });
    } finally {
      setDiagRunning(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);    try {
      const api = modelsApi();
      const [list, fm, assign, usage, taskSlots, lm] = await Promise.all([
        api.modelsList(),
        api.modelsAppleFm(),
        api.modelsGetAssignment(),
        api.modelsDiskUsage(),
        api.modelsTaskModels ? api.modelsTaskModels().catch(() => null) : Promise.resolve(null),
        api.modelsLocalMetrics ? api.modelsLocalMetrics().catch(() => null) : Promise.resolve(null),
      ]);
      setEntries(list);
      setApple(fm);
      setAssignment(assign);
      setDiskBytes(usage);
      setSlots(taskSlots);
      setMetrics(lm);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadActiveModelLabel();
    // Running local-model servers: poll while the panel is open so the
    // "Running now" card (and its Stop buttons) stays truthful.
    const pollServers = () => {
      try {
        const api = modelsApi();
        if (!api.modelsServerStatus) return;
        void api.modelsServerStatus().then(setServerStatus).catch(() => {});
      } catch {
        /* bridge unavailable — card stays hidden */
      }
    };
    pollServers();
    const serverTimer = setInterval(pollServers, 5000);
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
    // Model Advisor (newer builds): device detection spawns sysctl, so load
    // it separately from the main list — the panel stays usable if it's slow.
    void (async () => {
      try {
        const api = modelsApi();
        if (!api.modelsAdvisor) return;
        setAdvisorLoading(true);
        const result = await api.modelsAdvisor();
        setAdvisor(result);
      } catch {
        /* advisor bridge unavailable — card stays hidden */
      } finally {
        setAdvisorLoading(false);
      }
    })();
    return () => {
      clearInterval(serverTimer);
      off?.();
    };
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

  /**
   * Advisor one-click flow: download the recommended model if needed, then
   * make it the agent's chat model. When a download is required, the
   * pendingUseId effect below activates it as soon as the entry flips to
   * downloaded.
   */
  const useRecommended = async (pick: AdvisorPick) => {
    const id = pick.entry.id;
    const already = entries?.find((e) => e.id === id)?.downloaded === true;
    if (already) {
      await setAssign("chat", id);
      return;
    }
    setPendingUseId(id);
    await download(id);
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

  /** Stop a running local-model server immediately (user-triggered). */
  const stopServer = async (slot: "chat" | "vision") => {
    const api = modelsApi();
    if (!api.modelsStopServer) return;
    setStoppingSlot(slot);
    try {
      await api.modelsStopServer(slot);
      // Refresh immediately — don't wait for the 5s poll.
      const s = await api.modelsServerStatus?.();
      if (s) setServerStatus(s);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingSlot("");
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

  // Advisor one-click flow, part 2: when the pending model's entry flips to
  // downloaded, make it the agent's chat model automatically.
  useEffect(() => {
    if (!pendingUseId || !entries) return;
    const entry = entries.find((e) => e.id === pendingUseId);
    if (entry?.downloaded) {
      const id = pendingUseId;
      setPendingUseId(null);
      void setAssign("chat", id);
    } else if (entry && !entry.downloading && !entry.downloaded) {
      // Download failed or was cancelled — stop waiting.
      setPendingUseId(null);
    }
  }, [entries, pendingUseId]);

  // Vision slot assignment goes through the task-model registry (not the
  // legacy chat/vision assignment setter).
  const setVision = async (ref: string) => {
    const api = modelsApi();
    if (!api.modelsSetVision) return;
    setVisionBusy(true);
    setAssignError(null);
    try {
      await api.modelsSetVision(ref);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : String(err));
    } finally {
      setVisionBusy(false);
      void load();
    }
  };

  // Vision-missing nudge: scroll the Vision slot card into view and hold a
  // highlight ring on it briefly.
  useEffect(() => {
    if (focusTask !== "vision" || slots === null) return;
    setVisionFocus(true);
    const el = document.getElementById("nt-vision-slot");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setVisionFocus(false), 6000);
    return () => clearTimeout(t);
  }, [focusTask, slots]);

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
  // Legacy builds without the task-model registry still show the old vision
  // dropdown; new builds configure vision in the Task models card above.
  const legacyVision = !slots;

  return (
    <div>
      {/* --------------------------- Running now --------------------------- */}
      {serverStatus && (serverStatus.chat.running || serverStatus.vision.running) && (
        <div
          className="nt-r-md mb-4 border p-4"
          style={{
            borderColor: "var(--nt-accent)",
            background: "var(--nt-bg-raised)",
          }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#7fc97f" }}
            />
            <h3
              className="text-[13px] font-semibold"
              style={{ color: "var(--nt-text-1)" }}
            >
              Running now
            </h3>
          </div>
          <p className="mb-3 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            A local model is loaded and using CPU/GPU — that's what makes the
            computer run hot. Stop it any time; it restarts automatically the
            next time the agent needs it.
          </p>
          <div className="space-y-2">
            {(["chat", "vision"] as const).map((slot) => {
              const s = serverStatus[slot];
              if (!s.running) return null;
              const entry = entries?.find((e) => e.id === s.modelId);
              const name = entry?.name ?? s.modelId ?? slot;
              const busy = stoppingSlot === slot;
              return (
                <div
                  key={slot}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p
                      className="truncate text-[13px] font-medium"
                      style={{ color: "var(--nt-text-1)" }}
                    >
                      {name}
                    </p>
                    <p
                      className="text-[12px]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      {slot === "chat" ? "Agent chat" : "Vision"} server · running
                    </p>
                  </div>
                  <button
                    onClick={() => void stopServer(slot)}
                    disabled={busy}
                    className="nt-r-sm flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-[12.5px] font-semibold transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
                    style={{
                      borderColor: "var(--nt-border)",
                      color: "var(--nt-text-1)",
                    }}
                  >
                    {busy ? (
                      <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                    ) : (
                      <Square size={12} strokeWidth={0} fill="currentColor" />
                    )}
                    {busy ? "Stopping…" : "Stop"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* --------------------------- Model Advisor --------------------------- */}
      {(advisorLoading || advisor) && (
        <div
          className="nt-r-md mb-4 border p-4"
          style={{
            borderColor: "var(--nt-border)",
            background: "var(--nt-bg-raised)",
          }}
        >
          <div className="mb-1 flex items-center gap-2">
            <Sparkles
              size={15}
              strokeWidth={1.75}
              style={{ color: "var(--nt-accent)" }}
            />
            <h3
              className="text-[13px] font-semibold"
              style={{ color: "var(--nt-text-1)" }}
            >
              Recommended for this device
            </h3>
          </div>
          {advisorLoading && !advisor ? (
            <p
              className="flex items-center gap-1.5 text-[12px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
              Detecting your hardware…
            </p>
          ) : (
            advisor && (
              <>
                <p
                  className="mb-3 text-[12px]"
                  style={{ color: "var(--nt-text-3)" }}
                >
                  {advisor.device.chipLabel} ·{" "}
                  {formatBytes(advisor.device.totalRamBytes)} memory ·{" "}
                  {formatBytes(advisor.device.budgetBytes)} usable for models
                  {advisor.device.note ? ` — ${advisor.device.note}` : ""}
                </p>
                {advisor.nothingFits ? (
                  <p
                    className="text-[12.5px]"
                    style={{ color: "var(--nt-text-2)" }}
                  >
                    Nothing in the catalog fits this device comfortably right
                    now. The smallest options need more headroom than is
                    available — you can still download any model manually
                    below, or keep using the cloud fallback.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {advisor.picks.map((pick, i) => {
                      const row = entries?.find((e) => e.id === pick.entry.id);
                      const busy =
                        pendingUseId === pick.entry.id || row?.downloading;
                      const chipColor =
                        pick.verdict === "comfortable" || pick.verdict === "fits"
                          ? ["rgba(111,162,135,0.4)", "#6fa287", "rgba(111,162,135,0.08)"]
                          : pick.verdict === "tight"
                            ? ["rgba(196,158,74,0.45)", "#c49e4a", "rgba(196,158,74,0.08)"]
                            : ["rgba(217,115,98,0.4)", "#d97362", "rgba(217,115,98,0.08)"];
                      const total = pick.requiredBytes || 1;
                      const dlPct =
                        row && row.downloading
                          ? progressPct({
                              ...row,
                              totalBytes:
                                row.totalBytes || pick.entry.sizeBytes,
                            })
                          : 0;
                      return (
                        <div
                          key={pick.entry.id}
                          className="nt-r-sm border p-3"
                          style={{ borderColor: "var(--nt-border)" }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p
                                className="truncate text-[13px] font-medium"
                                style={{ color: "var(--nt-text-1)" }}
                              >
                                {i === 0 && (
                                  <span
                                    className="mr-1.5"
                                    style={{ color: "var(--nt-accent)" }}
                                  >
                                    ★
                                  </span>
                                )}
                                {pick.entry.name}
                                <span
                                  className="ml-1.5 font-normal"
                                  style={{ color: "var(--nt-text-3)" }}
                                >
                                  {pick.entry.params} · {pick.entry.quant} ·{" "}
                                  {formatBytes(pick.entry.sizeBytes)}
                                </span>
                              </p>
                            </div>
                            <span
                              className="nt-r-sm shrink-0 border px-2 py-0.5 text-[11.5px] font-medium"
                              style={{
                                borderColor: chipColor[0],
                                color: chipColor[1],
                                background: chipColor[2],
                              }}
                            >
                              {pick.verdictLabel}
                            </span>
                          </div>
                          {/* memory breakdown: weights / KV cache / overhead */}
                          <div
                            className="nt-r-sm mt-2 flex h-1.5 w-full overflow-hidden"
                            style={{ background: "var(--nt-bg-hover)" }}
                            title={`Weights ${formatBytes(pick.weightsBytes)} · KV cache ${formatBytes(pick.kvBytes)}${pick.kvEstimated ? " (estimated)" : ""} · Overhead ${formatBytes(pick.overheadBytes)}`}
                          >
                            <div
                              style={{
                                width: `${(pick.weightsBytes / total) * 100}%`,
                                background: "var(--nt-accent)",
                              }}
                            />
                            <div
                              style={{
                                width: `${(pick.kvBytes / total) * 100}%`,
                                background: "#7aa2c9",
                              }}
                            />
                            <div
                              style={{
                                width: `${(pick.overheadBytes / total) * 100}%`,
                                background: "var(--nt-text-3)",
                                opacity: 0.5,
                              }}
                            />
                          </div>
                          <ul className="mt-2 space-y-0.5">
                            {pick.reasons.slice(0, 3).map((r, j) => (
                              <li
                                key={j}
                                className="text-[12px]"
                                style={{ color: "var(--nt-text-2)" }}
                              >
                                • {r}
                              </li>
                            ))}
                            {pick.estTokPerSec !== null && (
                              <li
                                className="text-[12px]"
                                style={{ color: "var(--nt-text-3)" }}
                              >
                                • About {Math.round(pick.estTokPerSec)} tok/s
                                estimated on your chip
                                {pick.kvEstimated ? " · memory math estimated" : ""}
                              </li>
                            )}
                          </ul>
                          <div className="mt-2">
                            <button
                              onClick={() => void useRecommended(pick)}
                              disabled={busy || assignBusy !== ""}
                              className="nt-r-sm flex items-center gap-1.5 border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
                              style={{
                                borderColor: "var(--nt-border)",
                                color: "var(--nt-text-1)",
                              }}
                            >
                              {busy ? (
                                <Loader2
                                  size={13}
                                  strokeWidth={2}
                                  className="animate-spin"
                                />
                              ) : row?.downloaded ? (
                                <Check size={13} strokeWidth={2} />
                              ) : (
                                <Download size={13} strokeWidth={1.75} />
                              )}
                              {busy
                                ? row?.downloading
                                  ? `Downloading… ${dlPct}%`
                                  : "Preparing…"
                                : row?.downloaded
                                  ? "Use as agent model"
                                  : i === 0
                                    ? "Use recommended"
                                    : "Download & use"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
      {/* --------------------------- Task models --------------------------- */}
      {slots && (
        <>
          <h3
            className="mb-2 text-[13px] font-semibold"
            style={{ color: "var(--nt-text-1)" }}
          >
            Task models
          </h3>
          <p
            className="mb-2.5 text-[12px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            Every job the app does is served by exactly one model. Voice input
            and speech output always stay on-device; vision needs a downloaded
            model or an explicit cloud opt-in.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {slots.map((s) => (
              <TaskSlotCard
                key={s.slot}
                slot={s}
                focused={visionFocus && s.slot === "vision"}
                visionOptions={
                  s.slot === "vision"
                    ? [
                        { value: "none", label: "No vision model — download one below" },
                        ...downloadedFor("vision").map((e) => ({
                          value: e.id,
                          label: `${e.name} (${formatBytes(e.sizeBytes)})`,
                        })),
                        { value: "cloud", label: "Cloud (BYOK fallback)" },
                      ]
                    : undefined
                }
                visionBusy={visionBusy}
                onSetVision={setVision}
              />
            ))}
          </div>
        </>
      )}

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
              the bridge into{" "}
              <code
                className="nt-r-sm px-1.5 py-0.5 text-[12px]"
                style={{
                  background: "var(--nt-bg-hover)",
                  color: "var(--nt-text-1)",
                }}
              >
                ~/Library/Application Support/Next Token/sidecars/
              </code>{" "}
              — outside the app bundle, so it survives app updates: a bridge
              you built once is reused automatically after updating, no
              rebuild needed.
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
        {/* ------------------- Apple FM diagnostics ------------------- */}
        <div
          className="mt-3 border-t pt-3"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <p
              className="text-[12.5px] font-medium"
              style={{ color: "var(--nt-text-2)" }}
            >
              Diagnostics
            </p>
            <button
              onClick={() => void runDiagnostics()}
              disabled={diagRunning}
              className="nt-r-sm flex items-center gap-1.5 border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)] disabled:opacity-60"
              style={{
                borderColor: "var(--nt-border)",
                color: "var(--nt-text-2)",
              }}
            >
              {diagRunning ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Stethoscope size={13} strokeWidth={1.75} />
              )}
              {diagRunning ? "Running…" : "Run diagnostics"}
            </button>
          </div>
          <p
            className="mt-1 text-[12px]"
            style={{ color: "var(--nt-text-3)" }}
          >
            Probes the bridge and runs a tiny test inference, then shows the
            real error text — useful when chat fails even though the probe
            says “Available”.
          </p>
          {diagRunning && !diag && (
            <p
              className="mt-2 flex items-center gap-1.5 text-[12px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
              Probing bridge, then running a test inference (up to ~90s)…
            </p>
          )}
          {diag && (
            <div className="mt-2 space-y-1.5">
              <p
                className="text-[12.5px] font-medium"
                style={{ color: diag.ok ? "#6fa287" : "#d97362" }}
              >
                {diag.ok ? <Check size={13} className="mr-1 inline" /> : <X size={13} className="mr-1 inline" />}
                {diag.summary}
              </p>
              {diag.steps.map((s) => (
                <div
                  key={s.name}
                  className="nt-r-sm border p-2.5"
                  style={{ borderColor: "var(--nt-border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className="flex items-center gap-1.5 text-[12.5px] font-medium"
                      style={{ color: s.ok ? "#6fa287" : "#d97362" }}
                    >
                      {s.ok ? <Check size={13} /> : <X size={13} />}
                      {s.label}
                    </p>
                    <span
                      className="shrink-0 text-[11px]"
                      style={{ color: "var(--nt-text-3)" }}
                    >
                      {(s.ms / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <pre
                    className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed"
                    style={{ color: "var(--nt-text-2)" }}
                  >
                    {s.detail}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ------------------- Local model performance -------------------- */}
      <div
        className="nt-r-md mt-4 border p-4"
        style={{
          borderColor: "var(--nt-border)",
          background: "var(--nt-bg-raised)",
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <h4
            className="text-[13px] font-semibold"
            style={{ color: "var(--nt-text-1)" }}
          >
            Local model performance
          </h4>
          <button
            title="Refresh metrics"
            onClick={() =>
              void modelsApi()
                .modelsLocalMetrics?.()
                .then(setMetrics)
                .catch(() => {})
            }
            className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-text-3)" }}
          >
            <RefreshCw size={13} strokeWidth={1.75} />
          </button>
        </div>
        {metrics ? (
          <div>
            <p className="text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
              Last turn on{" "}
              <span className="nt-mono" style={{ color: "var(--nt-text-1)" }}>
                {metrics.modelId}
              </span>{" "}
              {metrics.warm ? "(model was already loaded)" : "(model loaded fresh)"}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
              {(
                [
                  ["Speed", `${metrics.tokensPerSec} tok/s`],
                  ["Generated", `~${metrics.genTokens} tokens`],
                  ["First token", `${metrics.firstTokenMs} ms`],
                  ["Total", `${metrics.totalMs} ms`],
                  [
                    "Model load",
                    metrics.warm ? "0 ms (warm)" : `${metrics.loadMs} ms`,
                  ],
                  [
                    "Measured",
                    new Date(metrics.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  ],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-2">
                  <span style={{ color: "var(--nt-text-3)" }}>{k}</span>
                  <span
                    className="nt-mono font-medium"
                    style={{ color: "var(--nt-text-1)" }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>
            <p
              className="mt-2 text-[11.5px]"
              style={{ color: "var(--nt-text-3)" }}
            >
              Token counts are estimated from streamed characters (~4
              chars/token). The model stays loaded in memory between turns, so
              repeat turns skip the load wait.
            </p>
          </div>
        ) : (
          <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
            No local-model turns measured yet — run the agent on a downloaded
            GGUF model and the latest speed appears here.
          </p>
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
        {legacyVision && (
          <AssignmentSelect
            label="Vision model"
            value={
              [ "none", CLOUD_REF, ...downloadedFor("vision").map((e) => e.id) ].includes(
                assignment.vision,
              )
                ? assignment.vision
                : CLOUD_REF
            }
            busy={assignBusy === "vision"}
            disabled={assignBusy !== ""}
            onChange={(v) => void setAssign("vision", v)}
            options={[
              { value: "none", label: "No vision model — download one below" },
              ...downloadedFor("vision").map((e) => ({
                value: e.id,
                label: `${e.name} (${formatBytes(e.sizeBytes)})`,
              })),
              { value: CLOUD_REF, label: "Cloud (BYOK fallback)" },
            ]}
          />
        )}
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

const SLOT_ICONS: Record<TaskModelSlotInfo["slot"], typeof Mic> = {
  transcription: Mic,
  agent: Brain,
  speech: Volume2,
  vision: Eye,
};

/** One task-model slot card: fixed slots are read-only, vision is configurable. */
function TaskSlotCard({
  slot,
  focused,
  visionOptions,
  visionBusy,
  onSetVision,
}: {
  slot: TaskModelSlotInfo;
  focused: boolean;
  visionOptions?: Array<{ value: string; label: string }>;
  visionBusy: boolean;
  onSetVision: (ref: string) => void;
}) {
  const Icon = SLOT_ICONS[slot.slot];
  return (
    <div
      id={slot.slot === "vision" ? "nt-vision-slot" : undefined}
      className="nt-r-md border p-3.5"
      style={{
        borderColor: focused ? "var(--nt-accent)" : "var(--nt-border)",
        background: "var(--nt-bg-raised)",
        boxShadow: focused ? "0 0 0 2px var(--nt-accent-soft)" : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon size={15} strokeWidth={1.75} style={{ color: "var(--nt-text-2)" }} />
          <p className="text-[13px] font-semibold" style={{ color: "var(--nt-text-1)" }}>
            {slot.title}
          </p>
        </div>
        <span
          className="nt-r-sm shrink-0 px-2 py-0.5 text-[11px] font-medium"
          style={
            slot.available
              ? { background: "rgba(111,162,135,0.1)", color: "#6fa287" }
              : { background: "rgba(196,158,74,0.1)", color: "#c49e4a" }
          }
        >
          {slot.available ? "Ready" : "Needs setup"}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] font-medium" style={{ color: "var(--nt-text-1)" }}>
        {slot.label}
      </p>
      <p className="text-[12px]" style={{ color: "var(--nt-text-3)" }}>
        {slot.detail}
      </p>
      <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--nt-text-2)" }}>
        {slot.description}
      </p>
      {slot.missingHint && (
        <p className="mt-1.5 text-[12px] font-medium" style={{ color: "#c49e4a" }}>
          {slot.missingHint}
        </p>
      )}
      {slot.slot === "vision" && visionOptions && (
        <div className="relative mt-2.5">
          <select
            value={visionOptions.some((o) => o.value === slot.ref) ? slot.ref : "none"}
            disabled={visionBusy}
            onChange={(e) => onSetVision(e.target.value)}
            aria-label="Vision model"
            className="nt-r-sm w-full appearance-none border bg-[var(--nt-bg-base)] py-2 pl-3 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--nt-accent)] disabled:opacity-60"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
          >
            {visionOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: "var(--nt-text-3)" }}
          >
            {visionBusy ? (
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
            ) : (
              <ChevronDown size={14} strokeWidth={1.75} className="pointer-events-none" />
            )}
          </span>
        </div>
      )}
      {slot.slot === "agent" && (
        <p className="mt-1.5 text-[12px]" style={{ color: "var(--nt-text-3)" }}>
          Change it any time in the Agent tab model switcher.
        </p>
      )}
    </div>
  );
}

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
