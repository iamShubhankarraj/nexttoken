/**
 * useAgentPhase — derives the agent's activity phase from the main-process
 * agent event stream ('started' / 'tool' / 'message' / 'done' / 'error').
 *
 * - 'idle':     nothing running
 * - 'thinking': an agent run is active (reasoning, composing, non-web tools)
 * - 'web':      the run is currently using internet/web tools (navigate,
 *               extract_text, page snapshots, …) — the button's "internet
 *               use" state, with the radiating signal animation
 */
import { useEffect, useState } from "react";
import { nt } from "../nt";

export type AgentPhase = "idle" | "thinking" | "web";

/** Tool names that mean "the agent is out on the internet". */
const WEB_TOOLS = new Set([
  "navigate",
  "click",
  "fill",
  "scroll",
  "press_key",
  "extract_text",
  "get_page_snapshot",
  "open_tab",
  "list_tabs",
  "switch_tab",
  "describe_screen",
  "web_search",
  "web_fetch",
]);

export function useAgentPhase(): AgentPhase {
  const [phase, setPhase] = useState<AgentPhase>("idle");

  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    try {
      off = nt().onAgentEvent((e) => {
        if (!alive) return;
        if (e.kind === "started") setPhase("thinking");
        else if (e.kind === "tool")
          setPhase(WEB_TOOLS.has(e.name) ? "web" : "thinking");
        else if (e.kind === "message") setPhase("thinking");
        else if (e.kind === "denied") setPhase("thinking");
        else if (e.kind === "done" || e.kind === "error") setPhase("idle");
      });
    } catch {
      /* bridge unavailable (tests) — stays idle */
    }
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  return phase;
}
