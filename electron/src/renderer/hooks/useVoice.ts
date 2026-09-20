/**
 * Voice control for Next Token, renderer-side via the Web Speech API
 * (webkitSpeechRecognition in Chromium/Electron).
 *
 * Two modes:
 *   - "command": one final transcript is parsed by runVoiceCommand() and
 *     executed against window.nt; recognition stops after the command.
 *   - "dictate": continuous recognition; final transcripts are appended
 *     into the agent chat input via onDictation.
 *
 * Alt+V (or Cmd/Ctrl+Shift+V) toggles command listening from anywhere —
 * the hook listens for a "nt:voice-toggle" CustomEvent dispatched by the
 * global key handler.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceState } from "../../shared/ipc";
import { fuzzy, nt } from "../nt";

export type VoiceMode = "command" | "dictate";

interface VoiceCommandContext {
  spaces: SpaceState[];
  activeSpaceId: string;
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
}

/**
 * Parse a spoken command and run it. Returns feedback text for the UI,
 * or null when the transcript matched nothing.
 */
export async function runVoiceCommand(
  raw: string,
  ctx: VoiceCommandContext,
): Promise<string | null> {
  const t = raw.toLowerCase().trim().replace(/[.?!,]+$/, "");
  const a = nt();

  const match = (re: RegExp) => re.test(t);
  const rest = (re: RegExp) => t.replace(re, "").trim();

  if (match(/^(open a |open |create )?(new tab|newtab)/)) {
    await a.tabsCreate({});
    return "Opened a new tab.";
  }
  if (match(/^close (this |the |current )?tab/)) {
    if (ctx.activeTabId) {
      await a.tabsClose(ctx.activeTabId);
      return "Closed the current tab.";
    }
    return "There is no active tab to close.";
  }
  if (match(/^go back/)) {
    await a.navBack();
    return "Went back.";
  }
  if (match(/^go forward/)) {
    await a.navForward();
    return "Went forward.";
  }
  if (match(/^(reload|refresh)( the| this)? page?/)) {
    await a.navReload();
    return "Reloaded the page.";
  }
  if (match(/^stop (loading|the page)/)) {
    await a.navStop();
    return "Stopped loading.";
  }
  if (match(/^open settings/)) {
    await a.uiSetSettingsOpen(true);
    return "Opened settings.";
  }
  if (match(/^close settings/)) {
    await a.uiSetSettingsOpen(false);
    return "Closed settings.";
  }
  if (match(/^toggle sidebar/)) {
    await a.uiSetSidebarCollapsed(!ctx.sidebarCollapsed);
    return ctx.sidebarCollapsed ? "Showed the sidebar." : "Hid the sidebar.";
  }
  if (match(/^toggle (agent|copilot)/)) {
    await a.uiSetAgentPanelOpen(!ctx.agentPanelOpen);
    return ctx.agentPanelOpen ? "Closed the agent panel." : "Opened the agent panel.";
  }
  if (match(/^summariz(e|e this page|e the page|e this)/)) {
    await a.agentChat("Summarize the current page");
    return "Asking the agent to summarize this page.";
  }
  if (match(/^(switch to|go to space|open space) /)) {
    const name = rest(/^(switch to|go to space|open space) /);
    let best: { id: string; score: number } | null = null;
    for (const s of ctx.spaces) {
      const score = fuzzy(name, s.name);
      if (score !== null && (!best || score > best.score)) {
        best = { id: s.id, score };
      }
    }
    if (best) {
      await a.spacesSwitch(best.id);
      const space = ctx.spaces.find((s) => s.id === best!.id);
      return `Switched to the ${space?.name ?? "space"}.`;
    }
    return `No space matches “${name}”.`;
  }
  if (match(/^go to /)) {
    const dest = rest(/^go to /);
    if (dest) {
      await a.navGo(dest);
      return `Navigating to ${dest}.`;
    }
  }
  if (match(/^search (for )?/)) {
    const q = rest(/^search (for )?/);
    if (q) {
      await a.navGo(q);
      return `Searching for ${q}.`;
    }
  }
  return null;
}

interface UseVoiceHandlers {
  onCommand: (text: string) => void;
  onDictation: (text: string) => void;
  /** Renderer asks the panel's voice settings: is voice control enabled? */
  isEnabled: () => boolean;
}

interface UseVoiceResult {
  supported: boolean;
  listening: boolean;
  mode: VoiceMode | null;
  /** Live interim transcript while listening. */
  interim: string;
  /** Graceful notice (unsupported / disabled / mic blocked / errors). */
  notice: string | null;
  clearNotice: () => void;
  toggleCommand: () => void;
  toggleDictate: () => void;
  stop: () => void;
}

export function useVoice(handlers: UseVoiceHandlers): UseVoiceResult {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const recRef = useRef<SpeechRecognition | null>(null);
  const toggleCommandRef = useRef<() => void>(() => {});

  const [listening, setListening] = useState(false);
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    (!!window.webkitSpeechRecognition || !!window.SpeechRecognition);

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const start = useCallback(
    (nextMode: VoiceMode) => {
      const Ctor = window.webkitSpeechRecognition ?? window.SpeechRecognition;
      if (!Ctor) {
        setNotice(
          "Voice input isn't available here — it needs Chromium's Web Speech API.",
        );
        return;
      }
      if (!handlersRef.current.isEnabled()) {
        setNotice("Voice is turned off. Enable it in Settings → Voice.");
        return;
      }
      stop();
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = nextMode === "dictate";
      rec.maxAlternatives = 1;

      rec.onresult = (e: SpeechRecognitionEvent) => {
        let interimText = "";
        let finalText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        setInterim(interimText);
        const final = finalText.trim();
        if (!final) return;
        if (nextMode === "command") {
          handlersRef.current.onCommand(final);
        } else {
          handlersRef.current.onDictation(`${final} `);
        }
      };
      rec.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setNotice(
            "Microphone access was blocked. Allow it in the browser's site settings and try again.",
          );
        } else if (e.error === "no-speech") {
          setNotice("Didn't hear anything — try again.");
        } else if (e.error !== "aborted") {
          setNotice(`Voice error: ${e.error}.`);
        }
        setListening(false);
        setMode(null);
      };
      rec.onend = () => {
        setListening(false);
        setMode(null);
        setInterim("");
        recRef.current = null;
      };

      recRef.current = rec;
      setNotice(null);
      setInterim("");
      setMode(nextMode);
      setListening(true);
      try {
        rec.start();
      } catch {
        setListening(false);
        setMode(null);
        recRef.current = null;
      }
    },
    [stop],
  );

  const toggleCommand = useCallback(() => {
    if (listening && mode === "command") stop();
    else start("command");
  }, [listening, mode, start, stop]);

  const toggleDictate = useCallback(() => {
    if (listening && mode === "dictate") stop();
    else start("dictate");
  }, [listening, mode, start, stop]);

  toggleCommandRef.current = toggleCommand;

  // Global hotkey bus: Alt+V or Cmd/Ctrl+Shift+V → command listening.
  useEffect(() => {
    const onToggle = () => toggleCommandRef.current();
    window.addEventListener("nt:voice-toggle", onToggle);
    return () => window.removeEventListener("nt:voice-toggle", onToggle);
  }, []);

  useEffect(() => stop, [stop]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    supported,
    listening,
    mode,
    interim,
    notice,
    clearNotice,
    toggleCommand,
    toggleDictate,
    stop,
  };
}
