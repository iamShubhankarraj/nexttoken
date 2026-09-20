/**
 * Agent panel — the large right-docked AI chat (Dia pattern).
 *
 * - Closable, toggled with ⌘/Ctrl+E, current-tab aware (context chip)
 * - Ephemeral chats: one-click new chat (archives), recent sessions —
 *   only the last few are kept (main caps at 5)
 * - Skills: one-click chips + /-commands in the input
 * - Tappable follow-up suggestions after each assistant reply
 * - @-mentions pull open tabs into context; external ask/prefill arrives
 *   via the agent bus (omnibox, new-tab hero, writing hint)
 *
 * The agent run itself is unchanged: same event protocol, tool rows,
 * voice commands, dictation, cancellation, and spoken replies.
 */

import {
  AlertTriangle,
  ChevronRight,
  Globe,
  History,
  Keyboard,
  Loader2,
  Mic,
  Plus,
  Send,
  Sparkles,
  Square,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  AgentMessage,
  BrainEvent,
  BrowserSnapshot,
  ChatSession,
  SkillDef,
} from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { registerAskHandler, registerPrefillHandler } from "../agentBus";
import { useVoice, runVoiceCommand, speakLocal } from "../hooks/useVoice";
import { registerBrainVoiceControl } from "../hooks/useBrainAudio";
import { domainOf, nt } from "../nt";
import { ModelSwitcher } from "./ModelSwitcher";

/** One-line label for a brain pipeline event in the trace feed. */
function brainEventLabel(e: BrainEvent): string {
  switch (e.kind) {
    case "heard": return `“${e.text}” (${e.source})`;
    case "classified": return `${e.intent} · ${(e.confidence * 100).toFixed(0)}% via ${e.via}`;
    case "gated": return `${e.outcome} — ${e.reason}`;
    case "safety": return `${e.verdict} · ${e.checks.filter((c) => c.passed).length}/${e.checks.length} checks passed`;
    case "dispatched": return e.specialist + (e.via ? ` (${e.via})` : "");
    case "acted": return e.summary;
    case "ask": return e.question;
    case "spoken": return `“${e.text}”`;
    case "note": return `Note: ${e.text}`;
    case "error": return e.message;
  }
}
import { SmartInput, type SmartTab } from "./SmartInput";

type ChatRole = "user" | "assistant" | "tool" | "system";

interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  /** For tool rows: the tool's display name. */
  toolName?: string;
  /** Whether this is a tool-denial / error row. */
  tone?: "error";
}

let msgN = 0;
const mid = () => `m${Date.now().toString(36)}-${msgN++}`;

function toChatMsg(m: AgentMessage): ChatMsg {
  return { id: m.id, role: m.role, text: m.text, at: m.at };
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/** Tappable follow-ups derived from the last assistant reply. */
function followUpsFor(text: string): string[] {
  const out: string[] = [];
  if (/```/.test(text)) out.push("Explain this code step by step");
  if (text.length > 800) out.push("Make it shorter");
  out.push("Summarize in one sentence");
  out.push("What should I do next?");
  return out.slice(0, 3);
}

export function AgentPanel() {
  const { snapshot, activeTab } = useBrowser();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [voiceCfg, setVoiceCfg] = useState({ enabled: false, speakReplies: false, voiceControl: false });
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  /** Compact trace of brain pipeline events (heard → classified → acted). */
  const [brainTrace, setBrainTrace] = useState<BrainEvent[]>([]);
  const [showBrainTrace, setShowBrainTrace] = useState(false);

  const voiceCfgRef = useRef(voiceCfg);
  voiceCfgRef.current = voiceCfg;
  const snapshotRef = useRef<BrowserSnapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  /** Accumulated streamed text per runId (guards against chunk vs cumulative). */
  const accumRef = useRef(new Map<string, string>());

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pushMsg = useCallback((m: Omit<ChatMsg, "id" | "at"> & { id?: string }) => {
    setMsgs((prev) => [
      ...prev,
      { id: m.id ?? mid(), at: Date.now(), ...m } as ChatMsg,
    ]);
  }, []);

  const speak = useCallback((text: string) => {
    if (!voiceCfgRef.current.speakReplies) return;
    // Prefer the on-device Kokoro voice; fall back to system speech.
    void speakLocal(text).then((ok) => {
      if (ok) return;
      if (!("speechSynthesis" in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text.slice(0, 1200));
        utter.rate = 1.05;
        window.speechSynthesis.speak(utter);
      } catch {
        /* speech is best-effort */
      }
    });
  }, []);

  /* ------------------------- agent event handling ------------------------ */

  const handleEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.kind) {
        case "started":
          setActiveRun(e.runId);
          accumRef.current.set(e.runId, "");
          break;
        case "message": {
          const prev = accumRef.current.get(e.runId) ?? "";
          // Behave whether main sends deltas or cumulative text.
          const next =
            prev && e.text.startsWith(prev) ? e.text : prev + e.text;
          accumRef.current.set(e.runId, next);
          setStreams((m) => new Map(m).set(e.runId, next));
          if (e.done) {
            const text = next.trim();
            accumRef.current.delete(e.runId);
            setStreams((m) => {
              const copy = new Map(m);
              copy.delete(e.runId);
              return copy;
            });
            setActiveRun((r) => (r === e.runId ? null : r));
            if (text) {
              pushMsg({ role: "assistant", text });
              speak(text);
            }
          }
          break;
        }
        case "tool":
          pushMsg({
            role: "tool",
            text: e.summary || "Working…",
            toolName: e.name,
          });
          break;
        case "denied":
          pushMsg({
            role: "tool",
            text: e.reason,
            toolName: e.name,
            tone: "error",
          });
          break;
        case "error":
          pushMsg({ role: "system", text: `Agent error: ${e.error}` });
          accumRef.current.delete(e.runId);
          setStreams((m) => {
            const copy = new Map(m);
            copy.delete(e.runId);
            return copy;
          });
          setActiveRun((r) => (r === e.runId ? null : r));
          break;
        case "done": {
          // Flush any stream that never got a final message event.
          const leftover = accumRef.current.get(e.runId);
          if (leftover?.trim()) {
            pushMsg({ role: "assistant", text: leftover.trim() });
            speak(leftover.trim());
          }
          accumRef.current.delete(e.runId);
          setStreams((m) => {
            const copy = new Map(m);
            copy.delete(e.runId);
            return copy;
          });
          setActiveRun((r) => (r === e.runId ? null : r));
          break;
        }
      }
    },
    [pushMsg, speak],
  );

  const refreshSessions = useCallback(() => {
    nt().agentSessions().then(setSessions).catch(() => {});
  }, []);

  const refreshSkills = useCallback(() => {
    nt().skillsList().then(setSkills).catch(() => {});
  }, []);

  // History + voice config + sessions + skills + event subscription.
  useEffect(() => {
    let alive = true;
    nt()
      .agentHistory()
      .then((h) => {
        if (alive) setMsgs(h.map(toChatMsg));
      })
      .catch(() => {});
    nt()
      .settingsGetVoice()
      .then((v) => {
        if (alive) setVoiceCfg(v);
      })
      .catch(() => {});
    refreshSessions();
    refreshSkills();
    const off = nt().onAgentEvent(handleEvent);
    return () => {
      alive = false;
      off();
    };
  }, [handleEvent, refreshSessions, refreshSkills]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streams, activeRun]);

  /* -------------------------------- actions ------------------------------ */

  const send = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || activeRun) return;
      pushMsg({ role: "user", text: q });
      setInput("");
      setVoiceFeedback(null);
      setShowSessions(false);
      nt()
        .agentChat(q)
        .catch((err) =>
          pushMsg({
            role: "system",
            text: `Couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
    },
    [activeRun, pushMsg],
  );

  // External ask/prefill (omnibox, new-tab hero, writing hint) — via a
  // ref so registration happens once.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    registerAskHandler((text) => {
      void sendRef.current(text);
    });
    registerPrefillHandler((text) => {
      setInput(text);
      inputRef.current?.focus();
    });
    return () => {
      registerAskHandler(null);
      registerPrefillHandler(null);
    };
  }, []);

  const cancel = useCallback(() => {
    if (!activeRun) return;
    nt()
      .agentCancel(activeRun)
      .catch(() => {});
  }, [activeRun]);

  /** Archive the current chat and start fresh (one-click, Dia pattern). */
  const newChat = useCallback(async () => {
    cancel();
    await nt().agentNewChat().catch(() => {});
    setMsgs([]);
    setShowSessions(false);
    refreshSessions();
  }, [cancel, refreshSessions]);

  const openSession = useCallback(
    async (id: string) => {
      cancel();
      await nt().agentOpenSession(id).catch(() => {});
      const h = await nt().agentHistory().catch(() => []);
      setMsgs(h.map(toChatMsg));
      setShowSessions(false);
    },
    [cancel],
  );

  /* --------------------------------- voice ------------------------------- */

  const handleVoiceCommand = useCallback(async (text: string) => {
    const lower = text.toLowerCase().trim();
    // "dictate <text>" → straight into the input.
    if (lower.startsWith("dictate ")) {
      setInput((v) => `${v}${text.slice(8).trim()} `);
      inputRef.current?.focus();
      return;
    }
    // Voice-control mode: the Jev brain owns the transcript end to end
    // (intent → confidence gate → safety → control.ts → TTS reply).
    if (voiceCfgRef.current.voiceControl) {
      setVoiceFeedback(`Heard “${text}” — routing…`);
      nt()
        .brainHandleUtterance(text, "voice")
        .catch((err) =>
          setVoiceFeedback(
            `Brain error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }
    const s = snapshotRef.current;
    if (!s) return;
    const space = s.spaces.find((x) => x.id === s.activeSpaceId);
    const fb = await runVoiceCommand(text, {
      spaces: s.spaces,
      activeSpaceId: s.activeSpaceId,
      activeTabId: space?.activeTabId ?? null,
      sidebarCollapsed: s.sidebarCollapsed,
      agentPanelOpen: s.agentPanelOpen,
    }).catch(
      (err) =>
        `Command failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    setVoiceFeedback(fb ?? `Heard “${text}” — no command matched.`);
    if (fb) inputRef.current?.focus();
  }, []);

  const voice = useVoice({
    onCommand: handleVoiceCommand,
    onDictation: (t) => {
      setInput((v) => `${v}${t}`);
      inputRef.current?.focus();
    },
    isEnabled: () => voiceCfgRef.current.enabled,
  });

  // Let the brain start/stop microphone capture (voice.listen.start/stop intents).
  const voiceCtlRef = useRef(voice);
  voiceCtlRef.current = voice;
  useEffect(() => {
    registerBrainVoiceControl({
      startListening: () => {
        const v = voiceCtlRef.current;
        if (!v.listening) v.toggleCommand();
      },
      stopListening: () => voiceCtlRef.current.stop(),
    });
    return () => registerBrainVoiceControl(null);
  }, []);

  // Brain pipeline trace — compact feed of heard → classified → acted events.
  useEffect(() => {
    const off = nt().onBrainEvent((e) => {
      setBrainTrace((prev) => [...prev.slice(-29), e]);
      if (e.kind === "acted") setVoiceFeedback(e.summary);
      else if (e.kind === "ask") setVoiceFeedback(e.question);
      else if (e.kind === "error") setVoiceFeedback(`Brain: ${e.message}`);
    });
    return off;
  }, []);

  const busy = activeRun !== null;
  const streamingText = activeRun ? (streams.get(activeRun) ?? "") : "";

  const allTabs: SmartTab[] = (snapshot?.spaces ?? []).flatMap((s) =>
    s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      spaceName: s.name,
    })),
  );

  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => m.role === "assistant" && m.text.trim().length > 0);
  const followUps = !busy && lastAssistant ? followUpsFor(lastAssistant.text) : [];

  const domain = activeTab ? domainOf(activeTab.url) : "";

  return (
    <aside
      className="nt-fade-slide-in flex h-full w-[400px] shrink-0 flex-col border-l"
      style={{ background: "var(--nt-bg-subtle)", borderColor: "var(--nt-border)" }}
    >
      {/* header */}
      <div
        className="flex items-center gap-1 border-b px-3.5 py-3"
        style={{ borderColor: "var(--nt-border)" }}
      >
        <span
          className="nt-r-sm flex h-7 w-7 items-center justify-center"
          style={{ background: "var(--nt-accent-soft)" }}
        >
          <Sparkles size={15} strokeWidth={1.75} style={{ color: "var(--nt-accent)" }} />
        </span>
        <p className="text-[15px] font-semibold tracking-[-0.01em]" style={{ color: "var(--nt-text-1)" }}>
          Agent
        </p>
        {/* model switcher — the active model drives everything the agent does */}
        <div className="ml-2">
          <ModelSwitcher />
        </div>
        <span className="flex-1" />
        <button
          title="New chat (archives this one)"
          aria-label="New chat"
          onClick={() => void newChat()}
          className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-2)" }}
        >
          <Plus size={15} strokeWidth={1.75} />
        </button>
        <button
          title="Recent chats"
          aria-label="Recent chats"
          aria-expanded={showSessions}
          onClick={() => {
            refreshSessions();
            setShowSessions((s) => !s);
          }}
          className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{
            color: showSessions ? "var(--nt-accent)" : "var(--nt-text-2)",
            background: showSessions ? "var(--nt-accent-soft)" : undefined,
          }}
        >
          <History size={15} strokeWidth={1.75} />
        </button>
        <button
          title="Close agent panel (⌘E)"
          aria-label="Close agent panel"
          onClick={() => void nt().uiSetAgentPanelOpen(false)}
          className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-3)" }}
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      {/* recent sessions — ephemeral, only the last few are kept */}
      {showSessions && (
        <div
          className="nt-fade-in border-b px-2 py-1.5"
          style={{ borderColor: "var(--nt-border)" }}
        >
          <button
            onClick={() => void newChat()}
            className="nt-r-sm flex w-full items-center gap-2 px-2.5 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{ color: "var(--nt-accent)" }}
          >
            <Plus size={14} strokeWidth={1.75} /> Start new chat
          </button>
          {sessions.length === 0 && (
            <p className="px-2.5 py-2 text-[12px]" style={{ color: "var(--nt-text-faint)" }}>
              No recent chats yet.
            </p>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => void openSession(s.id)}
              className="nt-r-sm flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--nt-bg-hover)]"
            >
              <ChevronRight size={12} strokeWidth={1.75} style={{ color: "var(--nt-text-faint)" }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]" style={{ color: "var(--nt-text-1)" }}>
                  {s.title}
                </span>
                <span className="nt-micro block">{timeAgo(s.at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* current-tab context chip */}
      {activeTab && (
        <div className="px-3.5 pt-2.5">
          <div
            className="nt-r-full flex items-center gap-2 border px-3 py-1.5"
            style={{ borderColor: "var(--nt-border)", background: "var(--nt-bg-raised)" }}
            title={activeTab.title ? `${activeTab.title}\n${activeTab.url}` : activeTab.url}
          >
            <Globe size={12} strokeWidth={1.75} className="shrink-0" style={{ color: "var(--nt-accent)" }} />
            <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--nt-text-2)" }}>
              {activeTab.title || "New tab"}
            </span>
            {domain && (
              <span className="nt-mono shrink-0 text-[11px]" style={{ color: "var(--nt-text-faint)" }}>
                {domain}
              </span>
            )}
          </div>
        </div>
      )}

      {/* messages */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {msgs.length === 0 && !busy && (
          <div className="nt-fade-in px-1 pt-6 text-center">
            <p className="text-[13px]" style={{ color: "var(--nt-text-3)" }}>
              Ask about the page you're reading, or tell me to do something
              with it.
            </p>
            {skills.length > 0 && (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {skills.slice(0, 6).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void send(s.prompt)}
                    title={s.prompt}
                    className="nt-r-full border px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--nt-accent)]"
                    style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
                  >
                    <Zap size={10} strokeWidth={1.75} className="mr-1 inline" style={{ color: "var(--nt-accent)" }} />
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {msgs.map((m) => {
          if (m.role === "system") {
            return (
              <p
                key={m.id}
                className="flex items-center justify-center gap-1.5 px-2 text-center text-[12px]"
                style={{ color: "var(--nt-text-3)" }}
              >
                <AlertTriangle size={12} strokeWidth={1.75} className="shrink-0" /> {m.text}
              </p>
            );
          }
          if (m.role === "tool") {
            const denied = m.tone === "error";
            return (
              <div
                key={m.id}
                className="nt-r-md flex items-start gap-2.5 border px-3 py-2"
                style={{
                  borderColor: denied ? "rgba(217,115,98,0.4)" : "var(--nt-border)",
                  background: "var(--nt-bg-raised)",
                }}
              >
                <span
                  className="nt-r-sm mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center"
                  style={{
                    background: denied
                      ? "rgba(217,115,98,0.14)"
                      : "var(--nt-accent-soft)",
                    color: denied ? "#d97362" : "var(--nt-accent)",
                  }}
                >
                  {denied ? (
                    <AlertTriangle size={13} strokeWidth={1.75} />
                  ) : (
                    <Wrench size={13} strokeWidth={1.75} />
                  )}
                </span>
                <div className="min-w-0">
                  <p
                    className="nt-micro"
                    style={{ color: denied ? "#d97362" : "var(--nt-accent)" }}
                  >
                    {denied ? "Tool blocked" : "Tool"} · {m.toolName ?? "tool"}
                  </p>
                  <p
                    className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed"
                    style={{ color: "var(--nt-text-2)" }}
                  >
                    {m.text}
                  </p>
                </div>
              </div>
            );
          }
          return (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`nt-r-md max-w-[92%] whitespace-pre-wrap px-3.5 py-2.5 text-[13px] leading-relaxed ${
                  m.role === "user" ? "rounded-br-[4px]" : "rounded-bl-[4px] border"
                }`}
                style={
                  m.role === "user"
                    ? {
                        background: "var(--nt-accent)",
                        color: "var(--nt-accent-text)",
                        fontWeight: 500,
                      }
                    : {
                        borderColor: "var(--nt-border)",
                        background: "var(--nt-bg-raised)",
                        color: "var(--nt-text-1)",
                      }
                }
              >
                {m.text}
              </div>
            </div>
          );
        })}

        {/* live streaming chunk */}
        {busy && (
          <div className="flex justify-start">
            <div
              className="nt-r-md max-w-[92%] whitespace-pre-wrap rounded-bl-[4px] border px-3.5 py-2.5 text-[13px] leading-relaxed"
              style={{
                borderColor: "var(--nt-border)",
                background: "var(--nt-bg-raised)",
                color: "var(--nt-text-1)",
              }}
            >
              {streamingText || (
                <span className="flex items-center gap-1.5 py-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="nt-typing-dot nt-r-full h-1.5 w-1.5"
                      style={{
                        background: "var(--nt-text-3)",
                        animationDelay: `${i * 150}ms`,
                      }}
                    />
                  ))}
                </span>
              )}
              {streamingText && (
                <span
                  className="nt-typing-dot ml-0.5 inline-block h-3.5 w-[2px] align-text-bottom"
                  style={{ background: "var(--nt-accent)" }}
                />
              )}
            </div>
          </div>
        )}

        {/* follow-up suggestions */}
        {followUps.length > 0 && (
          <div className="nt-fade-in flex flex-wrap gap-1.5">
            {followUps.map((f) => (
              <button
                key={f}
                onClick={() => void send(f)}
                className="nt-r-full border px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--nt-accent)]"
                style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* voice status / feedback */}
      {(voice.listening || voice.notice || voiceFeedback || voice.interim) && (
        <div
          className="border-t px-3.5 py-2 text-[12px]"
          style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
        >
          {voice.listening && (
            <p className="flex items-center gap-1.5">
              <Loader2 size={12} strokeWidth={1.75} className="animate-spin" style={{ color: "var(--nt-accent)" }} />
              Listening{voice.mode === "dictate" ? " — dictating into the input" : " — say a command"}
              {voice.interim && (
                <span className="truncate italic" style={{ color: "var(--nt-text-3)" }}>
                  “{voice.interim}”
                </span>
              )}
            </p>
          )}
          {voice.notice && (
            <p className="flex items-start justify-between gap-2">
              <span>{voice.notice}</span>
              <button onClick={voice.clearNotice} className="shrink-0 underline">
                dismiss
              </button>
            </p>
          )}
          {voiceFeedback && !voice.listening && <p>{voiceFeedback}</p>}
        </div>
      )}

      {/* brain pipeline trace */}
      {brainTrace.length > 0 && (
        <div className="border-t px-3.5 py-1.5" style={{ borderColor: "var(--nt-border)" }}>
          <button
            onClick={() => setShowBrainTrace((v) => !v)}
            className="flex w-full items-center gap-1.5 py-1 text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "var(--nt-text-3)" }}
          >
            <Zap size={11} strokeWidth={1.75} style={{ color: "var(--nt-accent)" }} />
            Brain trace
            <span style={{ color: "var(--nt-text-3)" }}>
              {showBrainTrace ? "▾" : "▸"}
            </span>
          </button>
          {showBrainTrace && (
            <ol className="max-h-36 space-y-1 overflow-y-auto pb-1.5 text-[11px]" style={{ color: "var(--nt-text-2)" }}>
              {brainTrace.map((e, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="shrink-0 font-mono" style={{ color: "var(--nt-text-3)" }}>
                    {e.kind}
                  </span>
                  <span className="truncate">{brainEventLabel(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* input */}
      <div className="border-t p-3" style={{ borderColor: "var(--nt-border)" }}>
        <div className="flex items-center gap-2">
          <button
            title={
              voice.supported
                ? voice.listening && voice.mode === "command"
                  ? "Stop listening"
                  : "Voice command (Alt+V) — try “new tab”, “go to github”, “summarize this page”"
                : "Voice input isn't available in this build"
            }
            onClick={voice.toggleCommand}
            className={`nt-r-sm shrink-0 p-2.5 transition-colors hover:bg-[var(--nt-bg-hover)]`}
            style={{
              color:
                voice.listening && voice.mode === "command"
                  ? "var(--nt-accent)"
                  : "var(--nt-text-3)",
              opacity: voice.supported ? 1 : 0.4,
            }}
          >
            <Mic size={15} strokeWidth={1.75} />
          </button>
          <button
            title={
              voice.supported
                ? voice.listening && voice.mode === "dictate"
                  ? "Stop dictating"
                  : "Dictate into the input"
                : "Voice input isn't available in this build"
            }
            onClick={voice.toggleDictate}
            className="nt-r-sm shrink-0 p-2.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
            style={{
              color:
                voice.listening && voice.mode === "dictate"
                  ? "var(--nt-accent)"
                  : "var(--nt-text-3)",
              opacity: voice.supported ? 1 : 0.4,
            }}
          >
            <Keyboard size={15} strokeWidth={1.75} />
          </button>
          <div
            className="nt-r-sm min-w-0 flex-1 border bg-[var(--nt-bg-raised)] px-3.5 py-2.5"
            style={{ borderColor: "var(--nt-border)" }}
          >
            <SmartInput
              value={input}
              onChange={setInput}
              onSubmit={() => send(input)}
              onRunSkill={(s) => void send(s.prompt)}
              tabs={allTabs}
              skills={skills}
              placeholder={busy ? "Agent is working…" : "Ask anything — @ for a tab, / for a skill"}
              dropUp
              inputRef={inputRef}
              ariaLabel="Ask the agent"
              disabled={busy}
            />
          </div>
          {busy ? (
            <button
              onClick={cancel}
              title="Cancel this run"
              className="nt-r-sm shrink-0 p-2.5 transition-transform hover:scale-105"
              style={{ background: "#d97362", color: "#0b0b0d" }}
            >
              <Square size={15} strokeWidth={1.75} />
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              title="Send"
              className="nt-r-sm shrink-0 p-2.5 transition-transform hover:scale-105"
              style={{ background: "var(--nt-accent)", color: "var(--nt-accent-text)" }}
            >
              <Send size={15} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <p className="nt-micro mt-1.5 px-1">
          Enter to send · @ mentions a tab · / runs a skill
        </p>
      </div>
    </aside>
  );
}
