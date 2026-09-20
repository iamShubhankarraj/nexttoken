/**
 * VoiceSteps — the voice-mode checklist inside the agent panel:
 * the cleaned transcript, then one row per browser action, each with an
 * optional thumbnail of the page right after the action ran.
 */

import type { AgentActingEvent } from "../../shared/ipc";

interface Props {
  transcript: string;
  steps: AgentActingEvent[];
}

const ACTION_ICON: Record<AgentActingEvent["action"], string> = {
  click: "⌖",
  type: "⌨",
  navigate: "↗",
  scroll: "⇅",
  tab: "▭",
  other: "✦",
};

export function VoiceSteps({ transcript, steps }: Props) {
  if (!transcript && steps.length === 0) return null;
  return (
    <div className="voice-steps">
      {transcript ? (
        <div className="voice-steps-transcript">
          <span className="voice-steps-transcript-label">You said</span>
          <p className="voice-steps-transcript-text">“{transcript}”</p>
        </div>
      ) : null}
      <ol className="voice-steps-list">
        {steps.map((s, i) => (
          <li key={i} className="voice-steps-row">
            <span className="voice-steps-icon" aria-hidden="true">
              {ACTION_ICON[s.action] ?? "✦"}
            </span>
            <div className="voice-steps-body">
              <span className="voice-steps-label">{s.label}</span>
              {s.screenshot ? (
                <img
                  className="voice-steps-shot"
                  src={s.screenshot}
                  alt={`Page after: ${s.label}`}
                  loading="lazy"
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
