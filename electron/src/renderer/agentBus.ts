/**
 * Tiny event bus so anything (omnibox, new-tab hero, writing hint) can ask
 * the agent without racing the AgentPanel's mount. If the panel isn't
 * mounted yet, requests queue and flush when it registers.
 */

type AskHandler = (text: string) => void;

let handler: AskHandler | null = null;
const pending: string[] = [];

export function registerAskHandler(h: AskHandler | null): void {
  handler = h;
  if (h) {
    while (pending.length > 0) {
      const text = pending.shift();
      if (text) h(text);
    }
  }
}

/** Ask the agent something. Opens nothing itself — the caller decides. */
export function askAgent(text: string): void {
  const t = text.trim();
  if (!t) return;
  if (handler) handler(t);
  else pending.push(t);
}

type PrefillHandler = (text: string) => void;

let prefillHandler: PrefillHandler | null = null;
const pendingPrefill: string[] = [];

/**
 * Put text into the agent's input draft without sending — used by the
 * writing hint's "insert tab context" action.
 */
export function registerPrefillHandler(h: PrefillHandler | null): void {
  prefillHandler = h;
  if (h) {
    while (pendingPrefill.length > 0) {
      const text = pendingPrefill.shift();
      if (text) h(text);
    }
  }
}

export function prefillAgent(text: string): void {
  if (!text) return;
  if (prefillHandler) prefillHandler(text);
  else pendingPrefill.push(text);
}
