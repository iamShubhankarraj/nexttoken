/**
 * The 100%-voice-CONTROL command map for Next Token.
 *
 * Voice CONTROL is not voice mode (a conversational chat). It means every
 * browser capability is addressable by voice: tabs, navigation, Spaces, the
 * sidebar, the command bar, agent tasks, model switching, settings, the
 * terminal, and page actions. The orchestrator classifies an utterance into
 * one of these intents (via Jev, with the local heuristic below as fallback)
 * and dispatches it to the matching specialist.
 *
 * Conventions:
 * - `intent` ids are stable API: `domain.action`. The UI renderer and the
 *   control executor switch on them, so renaming one is a breaking change.
 * - `requiresConfirmation` marks actions that must always ask the user in
 *   plain words before executing, regardless of classification confidence.
 *   Terminal commands are in this set by standing rule.
 * - `specialist` names the model pipeline that serves the intent:
 *   'control' = direct browser action, no LLM needed;
 *   'chat' = chat model via the tier router;
 *   'vision' = vision model (structured page grounding) then chat;
 *   'agent' = full tool-using agent run;
 *   'dictate' = type the words into the focused field/page.
 */

export type VoiceSpecialist = 'control' | 'chat' | 'vision' | 'agent' | 'dictate';

export interface VoiceSlotDef {
  name: string;
  type: 'number' | 'text' | 'url' | 'choice';
  description: string;
  choices?: string[];
}

export interface VoiceCommandDef {
  intent: string;
  category: string;
  /** One-line description — also used as the Jev Choice criterion text. */
  description: string;
  slots: VoiceSlotDef[];
  /** 2–3 example utterances (also the training signal for the local fallback). */
  examples: string[];
  requiresConfirmation: boolean;
  specialist: VoiceSpecialist;
}

const cmd = (
  intent: string,
  category: string,
  description: string,
  examples: string[],
  opts: Partial<Pick<VoiceCommandDef, 'slots' | 'requiresConfirmation' | 'specialist'>> = {}
): VoiceCommandDef => ({
  intent,
  category,
  description,
  examples,
  slots: opts.slots ?? [],
  requiresConfirmation: opts.requiresConfirmation ?? false,
  specialist: opts.specialist ?? 'control'
});

const ordinalSlot: VoiceSlotDef = {
  name: 'ordinal',
  type: 'number',
  description: 'Which tab, by position (1-based) or by name/title fragment'
};

export const VOICE_COMMANDS: VoiceCommandDef[] = [
  // -- Tabs -----------------------------------------------------------------
  cmd('browser.tab.new', 'Tabs', 'Open a brand-new empty tab', [
    'new tab', 'open a new tab', 'open new tab'
  ]),
  cmd('browser.tab.close', 'Tabs', 'Close the current tab, or a named/numbered tab', [
    'close this tab', 'close tab three', 'close the YouTube tab'
  ], { slots: [ordinalSlot] }),
  cmd('browser.tab.switch', 'Tabs', 'Switch to another tab by number or by page name', [
    'go to tab 3', 'switch to the third tab', 'go to the GitHub tab'
  ], { slots: [{ name: 'target', type: 'text', description: 'Tab number or title fragment to switch to' }] }),
  cmd('browser.tab.pin', 'Tabs', 'Pin the current tab so it stays put', [
    'pin this tab', 'pin the current tab'
  ]),
  cmd('browser.tab.unpin', 'Tabs', 'Unpin the current tab', ['unpin this tab']),
  cmd('browser.tab.mute', 'Tabs', 'Mute the current tab', ['mute this tab', 'mute the tab']),
  cmd('browser.tab.unmute', 'Tabs', 'Unmute the current tab', ['unmute this tab']),
  cmd('browser.tab.reload', 'Tabs', 'Reload the current tab', ['reload this tab', 'refresh the page']),
  cmd('browser.tab.duplicate', 'Tabs', 'Open a copy of the current tab', [
    'duplicate this tab', 'clone this tab'
  ]),
  cmd('browser.tab.move', 'Tabs', 'Move the current tab to another Space', [
    'move this tab to Work', 'send this tab to the Research space'
  ], { slots: [{ name: 'space', type: 'text', description: 'Destination Space name' }] }),
  cmd('browser.tab.archive', 'Tabs', 'Archive (sweep away) the current tab, restorable later', [
    'archive this tab', 'sweep this tab away'
  ]),
  cmd('browser.tab.list', 'Tabs', 'Tell me which tabs are open right now', [
    'what tabs are open', 'list my tabs', 'which tabs do I have open'
  ]),

  // -- Navigation ------------------------------------------------------------
  cmd('browser.nav.go', 'Navigation', 'Go to a website address', [
    'go to youtube.com', 'open github.com', 'take me to nytimes.com'
  ], { slots: [{ name: 'destination', type: 'url', description: 'Domain or full URL to navigate to' }] }),
  cmd('browser.nav.search', 'Navigation', 'Search the web for something', [
    'search for best mechanical keyboards', 'google quantum computing news'
  ], { slots: [{ name: 'query', type: 'text', description: 'The search query' }] }),
  cmd('browser.nav.back', 'Navigation', 'Go back one page', ['go back', 'back one page']),
  cmd('browser.nav.forward', 'Navigation', 'Go forward one page', ['go forward']),
  cmd('browser.nav.reload', 'Navigation', 'Reload the current page', ['reload the page', 'refresh']),
  cmd('browser.nav.stop', 'Navigation', 'Stop the page loading', ['stop loading', 'stop']),

  // -- Spaces -----------------------------------------------------------------
  cmd('browser.space.switch', 'Spaces', 'Switch to a different Space', [
    'switch to Work space', 'go to the Research space'
  ], { slots: [{ name: 'name', type: 'text', description: 'Space name to switch to' }] }),
  cmd('browser.space.create', 'Spaces', 'Create a new Space with a name', [
    'create a space called Reading', 'new space named Side Project'
  ], { slots: [{ name: 'name', type: 'text', description: 'Name for the new Space' }] }),
  cmd('browser.space.list', 'Spaces', 'List all my Spaces', [
    'which spaces do I have', 'list my spaces'
  ]),

  // -- Interface ---------------------------------------------------------------
  cmd('ui.sidebar.toggle', 'Interface', 'Collapse or expand the sidebar', [
    'collapse the sidebar', 'hide the sidebar', 'show the sidebar'
  ]),
  cmd('ui.agent.open', 'Interface', 'Open the AI assistant panel', [
    'open the assistant', 'show the AI panel'
  ]),
  cmd('ui.agent.close', 'Interface', 'Close the AI assistant panel', ['close the assistant']),
  cmd('ui.settings.open', 'Interface', 'Open Settings', ['open settings', 'show settings']),
  cmd('ui.commandbar.open', 'Interface', 'Open the command bar', [
    'open the command bar', 'show commands'
  ]),

  // -- Assistant -----------------------------------------------------------------
  cmd('agent.ask', 'Assistant', 'Ask a question about the current page or anything', [
    'what is this page about', 'who wrote this article', 'explain this to me'
  ], { slots: [{ name: 'question', type: 'text', description: 'The question to answer' }], specialist: 'chat' }),
  cmd('agent.summarize', 'Assistant', 'Summarize the current page', [
    'summarize this page', 'give me the key points of this article', 'tldr of this page'
  ], { specialist: 'chat' }),
  cmd('agent.dictate', 'Assistant', 'Type or dictate text into the page', [
    'type hello world', 'dictate: dear team, thanks for the update'
  ], { slots: [{ name: 'text', type: 'text', description: 'Text to type' }], specialist: 'dictate' }),
  cmd('agent.task', 'Assistant', 'Give the agent a multi-step task to work on', [
    'find the cheapest flight to Delhi and draft a booking note',
    'research the best budget phones and compare them'
  ], { slots: [{ name: 'task', type: 'text', description: 'The task to perform' }], specialist: 'agent' }),
  cmd('agent.stop', 'Assistant', 'Stop the agent, cancel what it is doing', [
    'stop', 'cancel that', 'never mind'
  ]),
  cmd('agent.newchat', 'Assistant', 'Start a fresh chat, archive this one', [
    'start a new chat', 'new conversation'
  ]),

  // -- Models --------------------------------------------------------------------
  cmd('models.switch.chat', 'Models', 'Change which model handles chat', [
    'use Qwen3 for chat', 'switch the chat model to SmolLM3'
  ], { slots: [{ name: 'model', type: 'text', description: 'Model name or id for chat' }] }),
  cmd('models.switch.vision', 'Models', 'Change which model handles vision', [
    'use the small vision model', 'switch vision to Qwen VL'
  ], { slots: [{ name: 'model', type: 'text', description: 'Model name or id for vision' }] }),
  cmd('models.list', 'Models', 'Tell me which local models are downloaded', [
    'which models are downloaded', 'list my models', 'what models do I have'
  ]),
  cmd('models.download', 'Models', 'Download a model from the catalog', [
    'download SmolLM3', 'get the Qwen3 model'
  ], { slots: [{ name: 'model', type: 'text', description: 'Model name or id to download' }] }),
  cmd('models.applefm.status', 'Models', 'Check whether Apple on-device AI is available', [
    'is Apple intelligence available', 'can you use the on-device model'
  ]),

  // -- Settings -------------------------------------------------------------------
  cmd('settings.voice.enable', 'Settings', 'Turn voice control on', [
    'turn voice on', 'enable voice control'
  ]),
  cmd('settings.voice.disable', 'Settings', 'Turn voice control off', [
    'turn voice off', 'disable voice control'
  ]),
  cmd('settings.searchengine', 'Settings', 'Change the default search engine', [
    'use DuckDuckGo for search', 'switch search to Brave'
  ], { slots: [{ name: 'engine', type: 'text', description: 'Search engine name' }] }),

  // -- Terminal --------------------------------------------------------------------
  cmd('terminal.run', 'Terminal', 'Run a terminal command (ALWAYS asks for confirmation first)', [
    'run ls minus la in the terminal', 'run npm test', 'open the terminal and run git status'
  ], {
    slots: [{ name: 'command', type: 'text', description: 'The exact shell command to run' }],
    requiresConfirmation: true
  }),

  // -- Page actions ------------------------------------------------------------------
  cmd('page.scroll.up', 'Page', 'Scroll the page up', ['scroll up', 'scroll up a bit']),
  cmd('page.scroll.down', 'Page', 'Scroll the page down', ['scroll down', 'scroll down a bit']),
  cmd('page.scroll.top', 'Page', 'Scroll to the top of the page', ['scroll to the top', 'go to the top']),
  cmd('page.scroll.bottom', 'Page', 'Scroll to the bottom of the page', ['scroll to the bottom']),
  cmd('page.click', 'Page', 'Click something on the page by its label', [
    'click the sign in button', 'click the first result'
  ], {
    slots: [{ name: 'target', type: 'text', description: 'Label of the element to click' }],
    specialist: 'vision'
  }),
  cmd('page.read', 'Page', 'Read the page aloud to me', [
    'read this page to me', 'read this article aloud'
  ], { specialist: 'chat' }),
  cmd('page.find', 'Page', 'Find something on the current page', [
    'find pricing on this page', 'look for the download link'
  ], { slots: [{ name: 'query', type: 'text', description: 'What to look for' }], specialist: 'chat' }),

  // -- Voice itself --------------------------------------------------------------------
  cmd('voice.listen.start', 'Voice', 'Start listening for voice commands', [
    'start listening', 'listen to me'
  ]),
  cmd('voice.listen.stop', 'Voice', 'Stop listening', ['stop listening']),
  cmd('voice.repeat', 'Voice', 'Repeat the last thing you said', [
    'say that again', 'repeat that', 'what did you say'
  ])
];

/** Jev Choice criteria map: intent id -> description. Add an 'other' at call time. */
export function intentCriteria(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of VOICE_COMMANDS) out[c.intent] = c.description;
  return out;
}

export function commandFor(intent: string): VoiceCommandDef | undefined {
  return VOICE_COMMANDS.find((c) => c.intent === intent);
}

// ---------------------------------------------------------------------------
// Local fallback classifier (used when Jev is unavailable: no key/offline)
// ---------------------------------------------------------------------------

export interface HeuristicIntent {
  intent: string;
  /** Token-overlap score 0..1. */
  confidence: number;
  via: 'local';
}

const STOP = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'on', 'in', 'me', 'my', 'it', 'this', 'that',
  'is', 'are', 'do', 'please', 'just', 'now', 'out', 'over'
  // NOTE: 'up' and 'down' are intentionally NOT stop words — they are the
  // discriminating token in "scroll up" vs "scroll down".
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/**
 * Token-overlap match of the utterance against every example utterance.
 * Returns the best command when its score clears the threshold.
 * This is deliberately simple: it only runs when Jev is unavailable, and the
 * orchestrator's confidence gate treats low scores as "ask", never "execute".
 */
export function heuristicClassify(text: string): HeuristicIntent | null {
  const textTokens = new Set(tokens(text));
  if (textTokens.size === 0) return null;

  let best: VoiceCommandDef | null = null;
  let bestScore = 0;
  for (const c of VOICE_COMMANDS) {
    for (const ex of c.examples) {
      const exTokens = tokens(ex);
      if (exTokens.length === 0) continue;
      let hits = 0;
      for (const t of exTokens) {
        if (textTokens.has(t)) hits++;
        // light plural tolerance: "tabs" matches "tab"
        else if (t.endsWith('s') && textTokens.has(t.slice(0, -1))) hits++;
        else if (textTokens.has(`${t}s`)) hits++;
      }
      const score = hits / exTokens.length;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  // Threshold: need a solid majority of an example's content words to match.
  if (!best || bestScore < 0.5) return null;
  return { intent: best.intent, confidence: Math.min(1, bestScore), via: 'local' };
}

// ---------------------------------------------------------------------------
// Slot extraction (local; Jev supplies slots only via intent description)
// ---------------------------------------------------------------------------

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10
};

function extractOrdinal(text: string): number | null {
  const digit = text.match(/\btab\s+(\d+)\b/i) ?? text.match(/\b(\d+)\b/);
  if (digit) return parseInt(digit[1], 10);
  const word = text.toLowerCase().match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/
  );
  if (word) return ORDINAL_WORDS[word[1]] ?? null;
  return null;
}

function extractQuoted(text: string): string | null {
  const m = text.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  return m ? m[1].trim() : null;
}

function extractUrl(text: string): string | null {
  const m = text.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)/i);
  return m ? m[1] : null;
}

/** Best-effort slot filling from the raw utterance. Missing slots -> orchestrator asks. */
export function extractSlots(intent: string, text: string): Record<string, string> {
  const slots: Record<string, string> = {};
  const quoted = extractQuoted(text);

  switch (intent) {
    case 'browser.tab.close':
    case 'browser.tab.switch': {
      const n = extractOrdinal(text);
      if (n !== null) slots.ordinal = String(n);
      else {
        // "the YouTube tab" / "the GitHub tab" -> title fragment
        const m = text.match(/\bthe\s+([a-z0-9][a-z0-9 ._-]*?)\s+tab\b/i);
        if (m) slots.target = m[1].trim();
        else if (quoted) slots.target = quoted;
      }
      break;
    }
    case 'browser.nav.go': {
      const url = extractUrl(text);
      if (url) slots.destination = url;
      else if (quoted) slots.destination = quoted;
      break;
    }
    case 'browser.nav.search':
    case 'page.find': {
      const m = text.match(/\b(?:search|google|look|find)(?:\s+for)?\s+(.+)$/i);
      if (m) slots.query = (quoted ?? m[1]).trim();
      else if (quoted) slots.query = quoted;
      break;
    }
    case 'browser.space.switch':
    case 'browser.space.create': {
      const m = text.match(/\bspace\s+(?:called|named)?\s*["“”'‘’]?([a-z0-9][a-z0-9 ._-]*)/i);
      if (m) slots.name = (quoted ?? m[1]).trim();
      else if (quoted) slots.name = quoted;
      break;
    }
    case 'browser.tab.move': {
      const m = text.match(/\bto\s+(?:the\s+)?([a-z0-9][a-z0-9 ._-]*?)(?:\s+space)?$/i);
      if (m) slots.space = (quoted ?? m[1]).trim();
      break;
    }
    case 'agent.ask':
    case 'agent.summarize':
    case 'agent.task':
    case 'agent.dictate': {
      const m = text.match(/[:—–-]\s*(.+)$/);
      if (m) slots.text = m[1].trim();
      else if (quoted) slots.text = quoted;
      else slots.text = text.trim();
      break;
    }
    case 'terminal.run': {
      // Keep the raw command text; the confirmation dialog shows it verbatim.
      const m = text.match(/\brun\s+(.+?)(?:\s+in the terminal)?$/i);
      if (m) slots.command = m[1].trim();
      else slots.command = text.trim();
      break;
    }
    case 'page.click': {
      const m = text.match(/\bclick\s+(?:the\s+)?(.+?)(?:\s+button|\s+link)?$/i);
      if (m) slots.target = (quoted ?? m[1]).trim();
      break;
    }
    case 'models.switch.chat':
    case 'models.switch.vision':
    case 'models.download': {
      const m = text.match(/\b(?:to|download|get|use)\s+(?:the\s+)?([a-z0-9][a-z0-9 ._-]*?)$/i);
      if (m) slots.model = (quoted ?? m[1]).trim();
      break;
    }
    case 'settings.searchengine': {
      const m = text.match(/\buse\s+([a-z0-9][a-z0-9 ._-]*?)(?:\s+for search)?$/i);
      if (m) slots.engine = (quoted ?? m[1]).trim();
      break;
    }
    default:
      break;
  }
  return slots;
}
