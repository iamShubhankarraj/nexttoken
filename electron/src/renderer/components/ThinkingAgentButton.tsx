/**
 * ThinkingAgentButton — the Agent entry point, redesigned.
 *
 * A glassy dark pill with an ember orb core instead of a plain sparkle icon.
 * The orb carries the agent's state:
 *  - idle:    the core "breathes" gently with a slow expanding ring
 *  - thinking (working): an ember gradient border sweep rotates around the
 *             pill, three particles orbit the core on a tilted gyroscope,
 *             the inner glow intensifies, and the label shimmers
 *  - web:     radiating signal pings emanate from the orb — the "internet
 *             use" state, when the agent is out browsing/fetching
 *
 * The same orb is exported standalone (ThinkingOrb) for the Agent panel
 * header so both surfaces share one visual language. Warm charcoal + ember
 * #E8A33D only — no violet AI clichés.
 */
import type { AgentPhase } from "../hooks/useAgentPhase";

function orbClasses(phase: AgentPhase): string {
  const working = phase !== "idle";
  return (
    "nt-agent-orb" +
    (working ? " is-working" : "") +
    (phase === "web" ? " is-web" : "")
  );
}

function OrbInner() {
  return (
    <>
      <span className="nt-agent-orb-core" />
      <span className="nt-agent-orb-ring" />
      <span className="nt-agent-orb-orbit">
        <i />
        <i />
        <i />
      </span>
      <span className="nt-agent-orb-ping" />
    </>
  );
}

/** The orb on its own (Agent panel header identity mark). */
export function ThinkingOrb({
  phase,
  size = 24,
  title,
}: {
  phase: AgentPhase;
  size?: number;
  title?: string;
}) {
  return (
    <span
      className={orbClasses(phase)}
      style={{ width: size, height: size }}
      aria-hidden="true"
      title={title}
    >
      <OrbInner />
    </span>
  );
}

export function ThinkingAgentButton({
  phase,
  open,
  onToggle,
}: {
  phase: AgentPhase;
  open: boolean;
  onToggle: () => void;
}) {
  const working = phase !== "idle";
  const stateLabel =
    phase === "web"
      ? "Agent is browsing the web"
      : working
        ? "Agent is working"
        : "Agent";
  return (
    <button
      type="button"
      className={
        "nt-agent-btn" +
        (open ? " is-open" : "") +
        (working ? " is-working" : "") +
        (phase === "web" ? " is-web" : "")
      }
      onClick={onToggle}
      title={`${stateLabel} — toggle agent panel (⌘E)`}
      aria-label={`${stateLabel}. Toggle agent panel.`}
      aria-expanded={open}
    >
      <span className={orbClasses(phase)} aria-hidden="true">
        <OrbInner />
      </span>
      <span className="nt-agent-label">Agent</span>
    </button>
  );
}
