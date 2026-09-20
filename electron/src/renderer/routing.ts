/**
 * Shared submit routing for the omnibox and the new-tab hero.
 *
 * One input, three modes (Dia pattern): web navigation/search, AI chat,
 * and /skill invocation. Intent detection is a default — callers pass a
 * manual override when the user set one. @-mentions are resolved against
 * open tabs into explicit [Tab: "…" (url)] context markers.
 */

import type { SkillDef } from "../shared/ipc";
import { askAgent } from "./agentBus";
import { detectIntent, resolveMentions, type MentionTab } from "./nt";
import { nt } from "./nt";

export type RouteOverride = "auto" | "web" | "ai";
export type RouteResult = "web" | "ai" | "skill" | "none";

export async function routeSubmit(
  raw: string,
  opts: { tabs: MentionTab[]; skills: SkillDef[]; override?: RouteOverride },
): Promise<RouteResult> {
  const text = raw.trim();
  if (!text) return "none";
  const api = nt();
  const tabs = opts.tabs;
  let intent = detectIntent(text);
  if (opts.override === "web") intent = "web";
  else if (opts.override === "ai") intent = "ai";

  if (intent === "skill") {
    const trigger = text.split(/\s/)[0].toLowerCase();
    const skill = opts.skills.find((s) => s.trigger.toLowerCase() === trigger);
    if (skill) {
      const extra = text.slice(trigger.length).trim();
      const prompt = extra ? `${skill.prompt}\n\n${extra}` : skill.prompt;
      const { text: resolved } = resolveMentions(prompt, tabs);
      await api.uiSetAgentPanelOpen(true);
      askAgent(resolved);
      return "skill";
    }
    // Unknown /trigger — fall through to AI rather than failing.
    intent = "ai";
  }

  if (intent === "ai") {
    const { text: resolved } = resolveMentions(text, tabs);
    await api.uiSetAgentPanelOpen(true);
    askAgent(resolved);
    return "ai";
  }

  await api.navGo(text);
  return "web";
}
