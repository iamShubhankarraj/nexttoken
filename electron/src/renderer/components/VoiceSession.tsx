/**
 * VoiceSession — the always-mounted owner of the voice pipeline.
 *
 * AgentPanel unmounts when the panel closes, but voice must keep working:
 * the toolbar chip, barge-in (Alt+V / tap), and the agent-acting
 * overlay all live outside the panel. So the mic/TTS hook lives here, at
 * App level, and the panel (plus omnibox / top strip) consumes this context.
 *
 * Handler delegation: the panel registers its command handler (voice
 * commands → agent), its dictation sink (append to chat input), and its
 * take-over handler (cancel the active agent run). When the panel is
 * closed, commands still route to the brain; dictation asks the user to
 * open the panel.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVoice, stopLocalSpeech, type VoiceMode, type VoiceGuide } from "../hooks/useVoice";
import type { AgentActingEvent, VoiceEngineState } from "../../shared/ipc";
import { nt } from "../nt";

export interface VoiceSessionValue {
  // mic session (from useVoice)
  supported: boolean;
  listening: boolean;
  mode: VoiceMode | null;
  interim: string;
  notice: string | null;
  clearNotice: () => void;
  /** Guided setup card (missing STT model/binary, mic denied). */
  guide: VoiceGuide | null;
  clearGuide: () => void;
  downloadSttModel: () => void;
  downloadingStt: boolean;
  useWebSpeechFallback: () => void;
  toggleCommand: () => void;
  toggleDictate: () => void;
  beginCommand: () => void;
  beginDictate: () => void;
  stop: () => void;
  // activity state (from the main process)
  engine: VoiceEngineState;
  playbackSpeaking: boolean;
  voiceError: string | null;
  amplitude: number;
  /** True when anything voice is happening — drives the toolbar voice chip. */
  active: boolean;
  // handler registries (the agent panel fills these in)
  registerCommandHandler: (fn: ((text: string) => void) | null) => void;
  registerDictationSink: (fn: ((text: string) => void) | null) => void;
  registerTakeoverHandler: (fn: (() => void) | null) => void;
  // agent browser actions (viewport overlay + panel Steps list)
  /** The action currently in flight, if any. */
  acting: AgentActingEvent | null;
  /** This voice turn's action history (with thumbnails). */
  actingSteps: AgentActingEvent[];
  /** Last in-page dictation, for the "⌘Z to undo" toast. */
  dictated: { tabId: string; chars: number; at: number } | null;
}

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function useVoiceSession(): VoiceSessionValue {
  const v = useContext(VoiceSessionContext);
  if (!v) throw new Error("useVoiceSession must be used inside <VoiceSession>");
  return v;
}

export function VoiceSession({ children }: { children: ReactNode }) {
  const commandRef = useRef<((text: string) => void) | null>(null);
  const dictationRef = useRef<((text: string) => void) | null>(null);
  const takeoverRef = useRef<(() => void) | null>(null);

  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const enabledRef = useRef(false);
  enabledRef.current = voiceEnabled;
  const [voiceControl, setVoiceControl] = useState(false);
  const voiceControlRef = useRef(false);
  voiceControlRef.current = voiceControl;

  const voice = useVoice({
    onCommand: (t) => {
      // Single dispatch: the agent panel owns the transcript when it's open.
      // Panel closed + voice-control on → route straight to the brain so a
      // spoken command still works (main never dispatches; this is the only
      // path, so nothing runs twice).
      if (commandRef.current) {
        commandRef.current(t);
      } else if (voiceControlRef.current) {
        void nt()
          .brainHandleUtterance(t, "voice")
          .catch(() => {});
      }
    },
    onDictation: (t) => dictationRef.current?.(t),
    isEnabled: () => enabledRef.current,
  });
  const beginRef = useRef(voice.beginCommand);
  beginRef.current = voice.beginCommand;

  // Keep the enabled flag fresh (Settings → Voice can change at runtime).
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      nt()
        .settingsGetVoice()
        .then((v) => {
          if (!alive) return;
          setVoiceEnabled(!!v?.enabled);
          setVoiceControl(!!v?.voiceControl);
        })
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const [engine, setEngine] = useState<VoiceEngineState>("idle");
  const [playbackSpeaking, setPlaybackSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [acting, setActing] = useState<AgentActingEvent | null>(null);
  const [actingSteps, setActingSteps] = useState<AgentActingEvent[]>([]);
  const [dictated, setDictated] = useState<{ tabId: string; chars: number; at: number } | null>(null);

  useEffect(() => {
    const offs = [
      nt().onVoiceEngineState((s) => {
        setEngine(s);
        // A fresh voice turn clears a stale error — and starts a fresh steps list.
        if (s !== "idle") setVoiceError(null);
        if (s === "listening") setActingSteps([]);
      }),
      nt().onVoicePlaybackState((speaking) => setPlaybackSpeaking(speaking)),
      nt().onVoiceError((message) => setVoiceError(message)),
      // Throttle re-renders: only meaningful amplitude steps propagate.
      nt().onVoiceAmplitude((level) =>
        setAmplitude((prev) => (Math.abs(prev - level) > 0.04 ? level : prev)),
      ),
      // Agent browser actions — the viewport overlay + panel Steps list.
      nt().onAgentActing((e) => {
        setActing(e);
        setActingSteps((prev) => [...prev.slice(-19), e]);
      }),
      nt().onAgentActingDone(() => setActing(null)),
      nt().onVoiceDictated((d) => setDictated({ ...d, at: Date.now() })),
      // Barge-in from the voice chip / Alt+V: kill TTS at once, start listening fresh.
      nt().onVoiceBargeIn(() => {
        stopLocalSpeech();
        if (enabledRef.current) beginRef.current();
      }),
      // "Take over" from the viewport capsule: halt the voice-driven agent.
      nt().onVoiceTakeover(() => {
        takeoverRef.current?.();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const registerCommandHandler = useCallback(
    (fn: ((text: string) => void) | null) => {
      commandRef.current = fn;
    },
    [],
  );
  const registerDictationSink = useCallback(
    (fn: ((text: string) => void) | null) => {
      dictationRef.current = fn;
    },
    [],
  );
  const registerTakeoverHandler = useCallback((fn: (() => void) | null) => {
    takeoverRef.current = fn;
  }, []);

  const value = useMemo<VoiceSessionValue>(
    () => ({
      supported: voice.supported,
      listening: voice.listening,
      mode: voice.mode,
      interim: voice.interim,
      notice: voice.notice,
      clearNotice: voice.clearNotice,
      guide: voice.guide,
      clearGuide: voice.clearGuide,
      downloadSttModel: voice.downloadSttModel,
      downloadingStt: voice.downloadingStt,
      useWebSpeechFallback: voice.useWebSpeechFallback,
      toggleCommand: voice.toggleCommand,
      toggleDictate: voice.toggleDictate,
      beginCommand: voice.beginCommand,
      beginDictate: voice.beginDictate,
      stop: voice.stop,
      engine,
      playbackSpeaking,
      voiceError,
      amplitude,
      active: engine !== "idle" || playbackSpeaking || voiceError !== null,
      registerCommandHandler,
      registerDictationSink,
      registerTakeoverHandler,
      acting,
      actingSteps,
      dictated,
    }),
    [
      voice.supported,
      voice.listening,
      voice.mode,
      voice.interim,
      voice.notice,
      voice.clearNotice,
      voice.guide,
      voice.clearGuide,
      voice.downloadSttModel,
      voice.downloadingStt,
      voice.useWebSpeechFallback,
      voice.toggleCommand,
      voice.toggleDictate,
      voice.beginCommand,
      voice.beginDictate,
      voice.stop,
      engine,
      playbackSpeaking,
      voiceError,
      amplitude,
      registerCommandHandler,
      registerDictationSink,
      registerTakeoverHandler,
      acting,
      actingSteps,
      dictated,
    ],
  );

  // LM Phase 6: publish the turn state on the window root. CSS in index.css
  // turns these into the learned "AI is working" ember treatments — rail
  // glow while listening/speaking, favicon pulse while speaking, a dialed-
  // down perimeter pulse while acting. Nothing renders: it's an attribute.
  useEffect(() => {
    const root = document.documentElement;
    const state =
      engine !== "idle"
        ? engine
        : playbackSpeaking
          ? "speaking"
          : "idle";
    if (root.dataset.agenticState !== state) root.dataset.agenticState = state;
    return () => {
      // On unmount, never leave a stale working state behind.
      root.dataset.agenticState = "idle";
    };
  }, [engine, playbackSpeaking]);

  return <VoiceSessionContext.Provider value={value}>{children}</VoiceSessionContext.Provider>;
}
