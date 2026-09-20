/**
 * Agent panel (right side) on the new design system: page-aware chat
 * against the real agent runtime in the main process.
 *
 * - History loads from nt.agentHistory() (roles: user | assistant | tool).
 * - Send goes through nt.agentChat(); streaming chunks, tool calls,
 *   denials, errors, and completion arrive on nt.onAgentEvent.
 * - Tool activity is rendered as clearly labeled compact rows.
 * - Cancel stops the active run; Clear wipes history via nt.agentClearHistory().
 * - Mic button + Alt/V voice commands (see hooks/useVoice), dictation
 *   appends into the input. Assistant replies are spoken when
 *   voice.speakReplies is on.
 */

import {
  AlertTriangle,
  Keyboard,
  Loader2,
  Mic,
  Send,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentMessage, BrowserSnapshot } from "../../shared/ipc";
import { useBrowser } from "../BrowserContext";
import { useVoice, runVoiceCommand, speakLocal } from "../hooks/useVoice";
import { domainOf, nt } from "../nt";

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

const SUGGESTIONS = [
  "Summarize this page",
  "Extract key points",
  "Explain like I'm 5",
];

export function AgentPanel() {
  const { snapshot, activeTab } = useBrowser();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [voiceCfg, setVoiceCfg] = useState({ enabled: false, speakReplies: false });
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);

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

  // History + voice config + event subscription.
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
    const off = nt().onAgentEvent(handleEvent);
    return () => {
      alive = false;
      off();
    };
  }, [handleEvent]);

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

  const cancel = useCallback(() => {
    if (!activeRun) return;
    nt()
      .agentCancel(activeRun)
      .catch(() => {});
  }, [activeRun]);

  const clear = useCallback(() => {
    nt()
      .agentClearHistory()
      .then(() => setMsgs([]))
      .catch(() => {});
  }, []);

  /* --------------------------------- voice ------------------------------- */

  const handleVoiceCommand = useCallback(async (text: string) => {
    const lower = text.toLowerCase().trim();
    // "dictate <text>" → straight into the input.
    if (lower.startsWith("dictate ")) {
      setInput((v) => `${v}${text.slice(8).trim()} `);
      inputRef.current?.focus();
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

  const busy = activeRun !== null;
  const streamingText = activeRun ? (streams.get(activeRun) ?? "") : "";

  return (
    <aside
      className="nt-fade-slide-in flex h-full w-[320px] shrink-0 flex-col border-l"
      style={{ background: "var(--nt-bg-subtle)", borderColor: "var(--nt-border)" }}
    >
      {/* header */}
      <div
        className="flex items-center gap-2 border-b px-3.5 py-3"
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
        <button
          title="Clear history"
          onClick={clear}
          className="nt-r-sm p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-3)" }}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
        <button
          title="Close agent panel"
          onClick={() => void nt().uiSetAgentPanelOpen(false)}
          className="nt-r-sm ml-auto p-1.5 transition-colors hover:bg-[var(--nt-bg-hover)]"
          style={{ color: "var(--nt-text-3)" }}
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      {/* page-context indicator */}
      <div
        className="border-b px-3.5 py-2.5"
        style={{ borderColor: "var(--nt-border)" }}
      >
        <p className="nt-micro">Reading</p>
        <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--nt-text-1)" }}>
          {activeTab ? activeTab.title || "New tab" : "No tab"}
        </p>
        <p className="nt-mono truncate text-[11px]" style={{ color: "var(--nt-text-3)" }}>
          {activeTab ? domainOf(activeTab.url) : ""}
        </p>
      </div>

      {/* messages */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {msgs.length === 0 && !busy && (
          <p className="px-1 pt-6 text-center text-[13px]" style={{ color: "var(--nt-text-3)" }}>
            Ask about the page you're reading, or tell me to do something
            with it.
          </p>
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

      {/* input */}
      <div className="border-t p-3" style={{ borderColor: "var(--nt-border)" }}>
        {!busy && msgs.length === 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="nt-r-full border px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--nt-accent)]"
                style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-2)" }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
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
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) send(input);
            }}
            placeholder={busy ? "Agent is working…" : "Ask about this page…"}
            disabled={busy}
            spellCheck={false}
            className="nt-r-sm w-full border bg-[var(--nt-bg-raised)] px-3.5 py-2.5 text-[13px] outline-none transition-colors placeholder:text-[var(--nt-text-3)] focus:border-[var(--nt-accent)] disabled:opacity-50"
            style={{ borderColor: "var(--nt-border)", color: "var(--nt-text-1)" }}
          />
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
      </div>
    </aside>
  );
}
