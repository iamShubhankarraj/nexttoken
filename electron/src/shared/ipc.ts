/**
 * Shared contract between main, preload, and renderer.
 *
 * Naming: IPC channels are `nt.<domain>.<action>` (invoke) and
 * `nt.<domain>.<event>` (main → renderer pushes).
 * The preload exposes everything under `window.nt`.
 */

// ---------------------------------------------------------------------------
// Tabs & spaces (real BrowserView state, owned by main)
// ---------------------------------------------------------------------------

export interface TabState {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  loading: boolean;
  pinned: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Favicon captured from the page (page-favicon-updated), cached per host. data: URL. */
  favicon?: string;
  /** Folder this tab is filed into; null = ungrouped. */
  folderId: string | null;
}

/** A tab folder inside one Bit (user-facing name for spaces is "Bits"). */
export interface BitFolder {
  id: string;
  name: string;
}

export interface BookmarkState {
  id: string;
  name: string;
  url: string;
  favicon?: string;
  createdAt: number;
  /** Folder path from browser import, e.g. "Bookmarks bar/Work". Absent for manual bookmarks. */
  folder?: string;
}

export interface SpaceState {
  id: string;
  name: string;
  /** Hex accent color for this space. */
  accent: string;
  tabs: TabState[];
  activeTabId: string | null;
  favorites: FavoriteState[];
  folders: BitFolder[];
  bookmarks: BookmarkState[];
}

export interface FavoriteState {
  id: string;
  name: string;
  url: string;
}

export interface DetectedBrowserState {
  id: string;
  name: string;
  kind: string;
  profileDir: string;
  profileLabel: string;
  accessDenied?: boolean;
}

export interface ImportReportState {
  bookmarksAdded: number;
  bookmarksSkippedDupes: number;
  tabsOpened: number;
  tabsPinned: number;
  warnings: string[];
}

export interface PasswordGuidance {
  supported: false;
  title: string;
  steps: string[];
}

export interface ImportRunResult {
  ok: boolean;
  report?: ImportReportState;
  /** Set when macOS denied file access — renderer shows the access guide. */
  accessDeniedPath?: string;
  passwordGuidance?: PasswordGuidance;
  error?: string;
}

export interface BrowserSnapshot {
  spaces: SpaceState[];
  activeSpaceId: string;
  archived: ArchivedTab[];
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
  settingsOpen: boolean;
}

/** A tab swept up by auto-archive (or manually). Restorable. */
export interface ArchivedTab {
  id: string;
  spaceId: string;
  spaceName: string;
  url: string;
  title: string;
  archivedAt: number;
}

/**
 * Per-site restyling ("Boosts", Arc-style). PLANNED follow-up, not v0.1:
 * the store already persists these and main has a marked injection point
 * (tabs.ts: maybeInjectBoost) that applies `css` to matching hosts on
 * did-finish-load. No UI yet — keep the shape stable.
 */
export interface SiteBoost {
  id: string;
  /** Host suffix match, e.g. "youtube.com". */
  host: string;
  css: string;
  enabled: boolean;
}

/** Live per-tab updates pushed from main. */
export interface TabDelta {
  tabId: string;
  type: 'title' | 'url' | 'loading' | 'nav-state' | 'favicon' | 'folder';
  value: string | boolean | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

// ---------------------------------------------------------------------------
// AI tab tidy — local models only (tab URLs never leave the device)
// ---------------------------------------------------------------------------

/** One proposed folder grouping from the tidy pass. */
export interface TidyGroupProposal {
  name: string;
  tabIds: string[];
}

/** One proposed tab closure, with the model's reasoning. */
export interface TidyCloseProposal {
  tabId: string;
  reason: string;
}

/** The reviewable plan produced by the local model. Nothing is applied until the user confirms. */
export interface TidyPlan {
  groups: TidyGroupProposal[];
  close: TidyCloseProposal[];
  /** Which local model produced the plan, e.g. "Apple Foundation Models". */
  via: string;
}

/** The user's confirmed actions — built from the reviewed plan in the renderer. */
export interface TidyActions {
  newFolders: { name: string; tabIds: string[] }[];
  closeTabIds: string[];
}

// ---------------------------------------------------------------------------
// Themes — token-driven. THIS IS THE ONE FILE: applying new design tokens
// (e.g. a future research pass) means editing the defaults/palettes below.
// Source: research/browser-ui-research.md §5 (warm charcoal + ember accent).
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  // Layered warm-charcoal surfaces (never flat black)
  bgBase: string; // #0B0B0D — app base, deepest layer
  bgSubtle: string; // #101013 — sidebar background
  bgRaised: string; // #16161A — cards, panels
  bgOverlay: string; // #1E1E24 — popovers, command bar, modals
  bgHover: string; // #232329 — hover states
  border: string; // rgba(255,255,255,0.08) — 1px structural rules
  borderStrong: string; // rgba(255,255,255,0.14) — focused edges
  // Strict text hierarchy (warm off-white, never pure white)
  text1: string; // 95% — primary
  text2: string; // 64% — secondary
  text3: string; // 40% — tertiary / placeholder
  textFaint: string; // 24% — disabled, ghost labels
  // ONE accent: ember amber. ~5% of chrome, precise highlights only.
  accent: string; // #E8A33D
  accentSoft: string; // rgba(232,163,61,0.14) — active fills, selection wash
  accentText: string; // #0B0B0D — text on accent fills
  // Per-Space identity (Arc-style color pair): tints the active-tab
  // indicator, the space icon, and a 2px top-edge wash — never large surfaces.
  spaceColor: string;
  // Corner roundness 0..1 → multiplier 0.25x–1.25x over the 6/10/14px scale.
  radiusScale: number;
  mode: 'dark' | 'light';
}

/** Curated desaturated per-Space hues — no neon. */
export const SPACE_PALETTE: { name: string; value: string }[] = [
  { name: 'Teal', value: '#7FA6A3' },
  { name: 'Sage', value: '#9CAF88' },
  { name: 'Clay', value: '#C08552' },
  { name: 'Slate', value: '#8E9AAF' },
  { name: 'Plum', value: '#A67C8E' },
  { name: 'Taupe', value: '#B08968' }
];

/** Desaturated semantic colors — never neon. */
export const SEMANTIC_COLORS = {
  success: '#6FA287',
  warning: '#D9A441',
  danger: '#D97362',
  info: '#7FA6C9'
} as const;

/** Radii scale — no ad-hoc values. r-full is for badges/dots ONLY. */
export const RADII = { sm: 6, md: 10, lg: 14 } as const;

/** Motion curves — compositor-only (transform/opacity), never layout. */
export const MOTION = {
  functional: 'cubic-bezier(0.32, 0.72, 0, 1)', // 180–240ms
  delight: 'cubic-bezier(0.34, 1.3, 0.64, 1)', // ≤320ms, delight moments only
  popover: 'cubic-bezier(0.32, 0.72, 0, 1)' // fade + 4px rise, 150ms
} as const;

export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  bgBase: '#0B0B0D',
  bgSubtle: '#101013',
  bgRaised: '#16161A',
  bgOverlay: '#1E1E24',
  bgHover: '#232329',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text1: '#F4F2ED',
  text2: 'rgba(244,242,237,0.64)',
  text3: 'rgba(244,242,237,0.40)',
  textFaint: 'rgba(244,242,237,0.24)',
  accent: '#E8A33D',
  accentSoft: 'rgba(232,163,61,0.14)',
  accentText: '#0B0B0D',
  spaceColor: '#7FA6A3',
  radiusScale: 0.6,
  mode: 'dark'
};

export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  // Dia-inspired calm light chrome: warm paper base, white cards, hairline
  // borders, soft warm-gray text hierarchy. The ember accent stays #E8A33D
  // (brand); text on accent fills goes dark for contrast.
  bgBase: '#FAF9F6',
  bgSubtle: '#F1EFE9',
  bgRaised: '#FFFFFF',
  bgOverlay: '#FFFFFF',
  bgHover: '#ECE9E1',
  border: 'rgba(28,26,21,0.08)',
  borderStrong: 'rgba(28,26,21,0.16)',
  text1: '#1D1B16',
  text2: 'rgba(29,27,22,0.66)',
  text3: 'rgba(29,27,22,0.44)',
  textFaint: 'rgba(29,27,22,0.28)',
  accent: '#E8A33D',
  accentSoft: 'rgba(232,163,61,0.16)',
  accentText: '#1C1503',
  spaceColor: '#5F7F7C',
  radiusScale: 0.6,
  mode: 'light'
};

export const TOKEN_FIELDS: { key: keyof ThemeTokens; label: string; kind: 'color' | 'slider' | 'toggle'; advanced?: boolean }[] = [
  { key: 'spaceColor', label: 'Space color', kind: 'color' },
  { key: 'accent', label: 'Accent', kind: 'color' },
  { key: 'bgBase', label: 'Base', kind: 'color', advanced: true },
  { key: 'bgSubtle', label: 'Sidebar', kind: 'color', advanced: true },
  { key: 'bgRaised', label: 'Cards', kind: 'color', advanced: true },
  { key: 'bgOverlay', label: 'Overlays', kind: 'color', advanced: true },
  { key: 'radiusScale', label: 'Corner roundness', kind: 'slider' },
  { key: 'mode', label: 'Dark mode', kind: 'toggle' }
];

/**
 * Maps ThemeTokens keys to CSS variable names. The renderer sets these on
 * the app root per active space: --nt-bg-base, --nt-text-1, ...
 */
export function tokensToCssVars(t: ThemeTokens): Record<string, string> {
  const v: Record<string, string> = {};
  const map: [keyof ThemeTokens, string][] = [
    ['bgBase', '--nt-bg-base'], ['bgSubtle', '--nt-bg-subtle'], ['bgRaised', '--nt-bg-raised'],
    ['bgOverlay', '--nt-bg-overlay'], ['bgHover', '--nt-bg-hover'],
    ['border', '--nt-border'], ['borderStrong', '--nt-border-strong'],
    ['text1', '--nt-text-1'], ['text2', '--nt-text-2'], ['text3', '--nt-text-3'], ['textFaint', '--nt-text-faint'],
    ['accent', '--nt-accent'], ['accentSoft', '--nt-accent-soft'], ['accentText', '--nt-accent-text'],
    ['spaceColor', '--nt-space']
  ];
  for (const [k, css] of map) v[css] = t[k] as string;
  const m = 0.25 + (t.radiusScale ?? 0.6); // 0.25x–1.25x over the 6/10/14 scale
  v['--nt-r-sm'] = `${Math.round(RADII.sm * m)}px`;
  v['--nt-r-md'] = `${Math.round(RADII.md * m)}px`;
  v['--nt-r-lg'] = `${Math.round(RADII.lg * m)}px`;
  v['--nt-accent-glow'] = t.mode === 'dark'
    ? '0 0 16px rgba(232,163,61,0.28)'
    : '0 0 12px rgba(232,163,61,0.22)';
  // Theme-aware elevation: quiet on light (Dia-like), deeper on dark.
  v['--nt-shadow-card'] = t.mode === 'dark'
    ? '0 16px 48px rgba(0,0,0,0.45)'
    : '0 16px 40px rgba(31,28,22,0.10), 0 2px 8px rgba(31,28,22,0.06)';
  v['--nt-shadow-overlay'] = t.mode === 'dark'
    ? '0 24px 64px rgba(0,0,0,0.55)'
    : '0 24px 64px rgba(31,28,22,0.14), 0 4px 16px rgba(31,28,22,0.08)';
  v['--nt-shadow-pop'] = t.mode === 'dark'
    ? '0 12px 32px rgba(0,0,0,0.45)'
    : '0 12px 32px rgba(31,28,22,0.12), 0 2px 6px rgba(31,28,22,0.06)';
  v['color-scheme'] = t.mode;
  return v;
}

// ---------------------------------------------------------------------------
// BYOK provider settings
// ---------------------------------------------------------------------------

export type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  baseUrl: string;
  /** Model placeholder shown in the UI. */
  modelHint: string;
  /** Which chat API shape to speak. */
  api: 'openai' | 'anthropic';
  needsKey: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-5', api: 'openai', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', modelHint: 'claude-opus-4-6', api: 'anthropic', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'anthropic/claude-opus-4-6', api: 'openai', needsKey: true },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', modelHint: 'qwen3:8b', api: 'openai', needsKey: false },
  { id: 'custom', name: 'Custom OpenAI-compatible', baseUrl: '', modelHint: 'model-id', api: 'openai', needsKey: true }
];

/** What the renderer is allowed to see of one BYOK provider — keys never cross IPC. */
export interface ProviderPublic {
  id: string;
  presetId: ProviderId;
  name: string;
  baseUrl: string;
  model: string;
  api: 'openai' | 'anthropic';
  enabled: boolean;
  keyConfigured: boolean;
  needsKey: boolean;
}

/** Payload for creating or updating one provider in the manager. */
export interface ProviderInput {
  id?: string;
  presetId: ProviderId;
  name: string;
  baseUrl: string;
  model: string;
  api: 'openai' | 'anthropic';
  enabled: boolean;
  /** Plaintext key only at submit time; stored via Electron safeStorage. */
  apiKey?: string;
}

/** Validate/Test button payload — tests the CURRENT form values, saved or not. */
export interface ProviderValidateInput {
  id?: string;
  presetId: ProviderId;
  baseUrl: string;
  api: 'openai' | 'anthropic';
  /** Plaintext key only for this test; when empty, the stored key (if any) is used. */
  apiKey?: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Unified model routing + BYOK provider manager
// ---------------------------------------------------------------------------

/**
 * The user's active model choice — the single selection that drives every
 * LLM call in the app (agent chat, skills, slash commands, writing help,
 * follow-ups, summarization, brain/voice pipeline).
 */
export interface ActiveModelRef {
  /** 'local-applefm' = Apple Foundation Models; 'local' = downloaded GGUF; 'cloud' = BYOK provider. */
  kind: 'local-applefm' | 'local' | 'cloud';
  /** Model catalog id when kind='local'; provider id when kind='cloud'. */
  id?: string;
}

/** One selectable model in the Agent tab switcher, grouped Local / Cloud. */
export interface ModelChoice {
  ref: ActiveModelRef;
  /** Display label, e.g. "Apple Foundation Models", "SmolLM3 3B", "OpenAI". */
  label: string;
  /** Secondary line, e.g. "On-device · 3B", "gpt-5". */
  detail: string;
  group: 'local' | 'cloud';
  available: boolean;
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: number;
}

export type AgentEvent =
  | { kind: 'started'; runId: string }
  | { kind: 'message'; runId: string; text: string; done: boolean }
  | { kind: 'tool'; runId: string; name: string; summary: string }
  | { kind: 'denied'; runId: string; name: string; reason: string }
  | { kind: 'error'; runId: string; error: string }
  | { kind: 'done'; runId: string };

// ---------------------------------------------------------------------------
// Local models (on-device tier) + voice engine
// ---------------------------------------------------------------------------

export type ModelTask = 'chat' | 'vision' | 'stt' | 'tts';

/** 'applefm' | 'cloud' | a catalog model id. */
export type ModelRef = string;

/** Catalog entry merged with local download state. */
export interface ModelEntryPublic {
  id: string;
  name: string;
  task: ModelTask;
  params: string;
  quant: string;
  sizeBytes: number;
  description: string;
  license: string;
  downloaded: boolean;
  downloading: boolean;
  bytesDownloaded: number;
  totalBytes: number;
}

export type ModelEvent =
  | { kind: 'progress'; id: string; bytesDownloaded: number; totalBytes: number }
  | { kind: 'done'; id: string }
  | { kind: 'error'; id: string; error: string };

/** Per-task model slots — the single source of truth lives in main (task-models.ts). */
export type TaskSlot = 'transcription' | 'agent' | 'speech' | 'vision';

/** One row of the task-model registry, as shown in Settings → Models. */
export interface TaskModelSlotInfo {
  slot: TaskSlot;
  title: string;
  description: string;
  /** Human label of what serves the slot, e.g. "Whisper base.en", "No vision model". */
  label: string;
  detail: string;
  available: boolean;
  /** Machine ref: 'none' | 'cloud' | 'apple-fm' | catalog id, used by selectors. */
  ref: string;
  missingHint?: string;
}

export interface ModelAssignment {
  chat: ModelRef;
  vision: ModelRef;
}

export interface AppleFmStatus {
  available: boolean;
  reason?: string;
}

export type VoiceEngineState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting' | 'speaking';

/** Voice settings. voiceControl routes STT transcripts into the brain (voice commands). */
export interface VoiceSettings {
  enabled: boolean;
  speakReplies: boolean;
  voiceControl: boolean;
  /** Transcript cleanup pass (Flow quick-clean → LLM → vocab guard). */
  cleanupEnabled: boolean;
  /** Quick-clean eligibility: word counts >= this defer to the LLM pass. */
  quickCleanMaxWords: number;
  /** Preferred microphone deviceId ("" = system default). */
  micDeviceId: string;
}

/** Result of one stop-listening turn (main → renderer). */
export interface VoiceTranscript {
  text: string;
  rawText: string;
  silent: boolean;
  cleaned: boolean;
  fillersRemoved: number;
}

/** One agent browser action, for the "in use by voice" overlay + Steps list. */
export interface AgentActingEvent {
  tabId: string | null;
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'tab' | 'other';
  label: string;
  targetRect?: { x: number; y: number; w: number; h: number };
  summary?: string;
  screenshot?: string;
}

// ---------------------------------------------------------------------------
// Brain — Jev System-One orchestration + 100% voice control
// ---------------------------------------------------------------------------

/** What the renderer may see — the key itself never leaves main. */
export interface JevConfigPublic {
  configured: boolean;
  baseUrl: string;
}

export interface JevConfigInput {
  /** Empty = keep the existing stored key. */
  apiKey: string;
  baseUrl?: string;
}

/** Structured pipeline events emitted by the orchestrator (see src/main/brain/orchestrator.ts). */
export type BrainEvent =
  | { kind: 'heard'; text: string; source: 'voice' | 'text' }
  | { kind: 'classified'; intent: string; confidence: number; via: 'jev' | 'local'; slots: Record<string, string> }
  | { kind: 'gated'; outcome: 'execute' | 'confirm' | 'ask' | 'escalate'; reason: string }
  | { kind: 'safety'; verdict: 'allow' | 'confirm' | 'deny'; checks: Array<{ name: string; passed: boolean; detail: string }> }
  | { kind: 'dispatched'; specialist: string; via?: string }
  | { kind: 'acted'; intent: string; summary: string }
  | { kind: 'ask'; question: string }
  | { kind: 'spoken'; text: string }
  /** Informational note, e.g. the model router fell back to another model. Never spoken aloud. */
  | { kind: 'note'; text: string }
  /** A vision task was requested but no vision model is downloaded — the UI should nudge the model manager. */
  | { kind: 'vision-missing' }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Skills — saved reusable prompts (slash commands + one-click chips)
// ---------------------------------------------------------------------------

export interface SkillDef {
  id: string;
  /** Human name, e.g. "Summarize". */
  name: string;
  /** Slash trigger, e.g. "/summarize" — lowercase, no spaces. */
  trigger: string;
  /** The prompt template sent to the agent. */
  prompt: string;
  category: string;
  builtIn: boolean;
}

export interface SkillInput {
  /** Absent = create a new skill. */
  id?: string;
  name: string;
  trigger: string;
  prompt: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Chat sessions — ephemeral chats; only a few recent ones are kept
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string;
  title: string;
  messages: AgentMessage[];
  at: number;
}

/** Ephemeral by design: at most this many recent chats are retained. */
export const MAX_CHAT_SESSIONS = 5;

// ---------------------------------------------------------------------------
// Native ad blocker (main-process network filter, bundled filter list)
// ---------------------------------------------------------------------------

/** What the renderer may see — global switch + per-site allowlist. */
export interface AdBlockState {
  enabled: boolean;
  allowedHosts: string[];
}

/** Live per-tab blocked-request counts pushed from main. */
export interface AdBlockStats {
  tabId: string;
  count: number;
}

// ---------------------------------------------------------------------------
// The window.nt API (implemented in preload via contextBridge)
// ---------------------------------------------------------------------------

export interface NextTokenAPI {
  // tabs
  tabsCreate(opts?: { spaceId?: string; url?: string }): Promise<string>;
  tabsClose(tabId: string): Promise<void>;
  tabsActivate(tabId: string): Promise<void>;
  /** Picture in Picture for the active tab's video. */
  tabsPip(): Promise<{ ok: boolean; error?: string }>;
  tabsPin(tabId: string, pinned: boolean): Promise<void>;
  tabsMove(tabId: string, spaceId: string): Promise<void>;
  /** Reorder a tab: move it before `beforeTabId` (null = end of its folder/section). */
  tabsReorder(tabId: string, beforeTabId: string | null, folderId: string | null): Promise<void>;
  /** File a tab into a folder (null = ungrouped). */
  tabsSetFolder(tabId: string, folderId: string | null): Promise<void>;
  /** webview guest calls this once its webContents exists. */
  tabsAttach(tabId: string, webContentsId: number): Promise<void>;
  tabsArchive(tabId: string): Promise<void>;
  tabsRestore(archivedId: string): Promise<void>;
  // navigation (active tab)
  navGo(raw: string): Promise<void>;
  navBack(): Promise<void>;
  navForward(): Promise<void>;
  navReload(): Promise<void>;
  navStop(): Promise<void>;
  // spaces (user-facing name: Bits)
  spacesCreate(name: string): Promise<string>;
  spacesSwitch(id: string): Promise<void>;
  spacesRename(id: string, name: string): Promise<void>;
  /** Delete a Bit after user confirmation — its tabs are moved to Archive, never lost. */
  spacesDelete(id: string): Promise<void>;
  spacesSetAccent(id: string, accent: string): Promise<void>;
  spacesAddFavorite(spaceId: string, name: string, url: string): Promise<void>;
  spacesRemoveFavorite(spaceId: string, favId: string): Promise<void>;
  // folders (per Bit)
  foldersCreate(spaceId: string, name: string): Promise<BitFolder>;
  foldersRename(spaceId: string, folderId: string, name: string): Promise<void>;
  foldersRemove(spaceId: string, folderId: string): Promise<void>;
  // bookmarks (per Bit)
  bookmarksAdd(spaceId: string, name: string, url: string): Promise<BookmarkState[]>;
  bookmarksRename(spaceId: string, id: string, name: string): Promise<BookmarkState[]>;
  bookmarksRemove(spaceId: string, id: string): Promise<BookmarkState[]>;
  // import from other browsers (explicit user action only; main owns all secrets)
  importDetect(): Promise<DetectedBrowserState[]>;
  importRun(
    browserId: string,
    kinds: Array<'bookmarks' | 'tabs' | 'passwords'>,
  ): Promise<ImportRunResult>;
  importPasswordGuidance(browserId: 'safari' | 'firefox'): Promise<PasswordGuidance>;
  importLoginsCount(): Promise<number>;
  // AI tidy — local models only; tab URLs never leave the device
  /** Produce a reviewable tidy plan. Nothing is applied until tidyApply is called. */
  tidyPlan(spaceId: string): Promise<TidyPlan>;
  /** Apply the user's confirmed tidy actions. Closed tabs go to Archive (restorable). */
  tidyApply(spaceId: string, actions: TidyActions): Promise<void>;
  // ui
  uiSetSidebarCollapsed(collapsed: boolean): Promise<void>;
  uiSetAgentPanelOpen(open: boolean): Promise<void>;
  uiSetSettingsOpen(open: boolean): Promise<void>;
  // agent
  agentChat(message: string, opts?: { voice?: boolean }): Promise<string>;
  agentCancel(runId: string): Promise<void>;
  agentHistory(): Promise<AgentMessage[]>;
  agentClearHistory(): Promise<void>;
  /** Archive the current conversation into recent sessions and start fresh. */
  agentNewChat(): Promise<void>;
  agentSessions(): Promise<ChatSession[]>;
  agentOpenSession(id: string): Promise<void>;
  // skills (saved reusable prompts)
  skillsList(): Promise<SkillDef[]>;
  skillsSave(skill: SkillInput): Promise<SkillDef[]>;
  skillsRemove(id: string): Promise<SkillDef[]>;
  skillsReset(): Promise<SkillDef[]>;
  // settings (voice, search)
  settingsGetVoice(): Promise<VoiceSettings>;
  settingsSetVoice(v: Partial<VoiceSettings>): Promise<void>;
  settingsGetSearchEngine(): Promise<string>;
  settingsSetSearchEngine(url: string): Promise<void>;
  // BYOK providers — the provider manager (multiple API gateway providers)
  providersList(): Promise<ProviderPublic[]>;
  providersSave(input: ProviderInput): Promise<ProviderPublic[]>;
  providersRemove(id: string): Promise<ProviderPublic[]>;
  providersSetEnabled(id: string, enabled: boolean): Promise<ProviderPublic[]>;
  providersValidate(input: ProviderValidateInput): Promise<{ ok: boolean; message: string }>;
  // unified model routing — the active model drives every LLM call in the app
  modelsChoices(): Promise<ModelChoice[]>;
  modelsGetActive(): Promise<ActiveModelRef>;
  modelsSetActive(ref: ActiveModelRef): Promise<ActiveModelRef>;
  /** Fires whenever the active model changes (any surface). */
  onActiveModel(cb: (ref: ActiveModelRef) => void): () => void;
  // themes
  themesGet(spaceId: string): Promise<ThemeTokens>;
  themesSet(spaceId: string, tokens: ThemeTokens): Promise<void>;
  themesReset(spaceId: string): Promise<void>;
  // local models (on-device tier; cloud BYOK stays the fallback)
  modelsList(): Promise<ModelEntryPublic[]>;
  modelsDownload(id: string): Promise<void>;
  modelsCancelDownload(id: string): Promise<void>;
  modelsRemove(id: string): Promise<void>;
  modelsGetAssignment(): Promise<ModelAssignment>;
  modelsSetAssignment(task: 'chat' | 'vision', ref: ModelRef): Promise<void>;
  /** The four task slots (transcription / agent / speech / vision) and what serves each. */
  modelsTaskModels(): Promise<TaskModelSlotInfo[]>;
  /** Assign the vision slot: 'none', 'cloud', or a downloaded vision catalog id. */
  modelsSetVision(ref: string): Promise<void>;
  modelsAppleFm(): Promise<AppleFmStatus>;
  modelsDiskUsage(): Promise<number>;
  onModelEvent(cb: (e: ModelEvent) => void): () => void;
  /** Optional Hugging Face token for gated repos (safeStorage; never returned). */
  modelsHfTokenSet(token: string): Promise<{ ok: true }>;
  modelsHfTokenHas(): Promise<boolean>;
  modelsHfTokenClear(): Promise<void>;
  /** Catalog ids currently flagged as access-gated. */
  modelsGatedIds(): Promise<string[]>;
  // voice engine (local STT/TTS sidecars; Web Speech remains the fallback)
  voiceSttAvailable(): Promise<boolean>;
  /** Granular STT readiness for the guided voice-setup card. */
  voiceSttStatus(): Promise<{ model: boolean; binary: boolean; binarySteps: string }>;
  voiceStartListening(): Promise<void>;
  /** Main-process macOS mic permission check (properly attributed prompt). */
  voiceEnsureMic(): Promise<{ granted: boolean }>;
  voiceAudioChunk(data: Uint8Array): Promise<void>;
  voiceStopListening(): Promise<VoiceTranscript>;
  voiceCancelListening(): Promise<void>;
  voiceSpeak(text: string): Promise<Uint8Array>;
  /** Barge-in: stop TTS at once so a new listen can start. */
  voiceStopSpeaking(): Promise<void>;
  /** Fire-and-forget mic amplitude (0..1) for the toolbar voice chip, ~15 Hz, ~15 Hz. */
  voiceAmplitude(level: number): void;
  /** Renderer started/stopped TTS audio playback (drives the toolbar voice chip). */
  voicePlaybackStarted(): void;
  voicePlaybackEnded(): void;
  /** Undo the last voice dictation inserted into the page. */
  voiceDictateUndo(): Promise<boolean>;
  /** User hit "Take over" — halt the voice-driven agent. */
  voiceTakeover(): Promise<void>;
  /** Self-heal Kokoro TTS (fetch espeak-ng-data when a manual model lacks it). */
  voiceRepairTts(): Promise<{ ok: boolean; error?: string }>;
  onVoiceEngineState(cb: (s: VoiceEngineState) => void): () => void;
  /** Plain-language voice error for the voice surface (never a stack trace). */
  onVoiceError(cb: (message: string) => void): () => void;
  /** Mic amplitude forwarded to the voice chip. */
  onVoiceAmplitude(cb: (level: number) => void): () => void;
  /** TTS playback started/ended in the renderer (drives the toolbar voice chip). */
  onVoicePlaybackState(cb: (speaking: boolean) => void): () => void;
  /** Agent is acting on a tab (before) / finished (after). */
  onAgentActing(cb: (e: AgentActingEvent) => void): () => void;
  onAgentActingDone(cb: (e: AgentActingEvent) => void): () => void;
  /** Main asks the renderer to barge in: stop local speech, start listening. */
  onVoiceBargeIn(cb: () => void): () => void;
  /** "Take over" pressed in the viewport capsule — halt the voice agent. */
  onVoiceTakeover(cb: () => void): () => void;
  /** In-page voice dictation completed — drives the viewport toast. */
  onVoiceDictated(cb: (d: { tabId: string; chars: number }) => void): () => void;
  /** Raw WAV bytes (number[]) for a brain TTS reply — renderer decodes and plays. */
  onVoicePlayback(cb: (bytes: number[]) => void): () => void;
  /** Brain asked the renderer to open its command bar. */
  onCommandBar(cb: () => void): () => void;
  /** Brain asked the renderer to start/stop microphone capture. */
  onVoiceRequestListen(cb: (start: boolean) => void): () => void;
  /** Main asks the renderer to open Settings → Models, optionally focused on one task section. */
  onOpenModels(cb: (focus: { task?: string }) => void): () => void;
  // brain — Jev System-One orchestration (key in OS keychain, never exposed)
  brainGetJev(): Promise<JevConfigPublic>;
  brainSetJev(input: JevConfigInput): Promise<JevConfigPublic>;
  brainTestJev(): Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
  /** Validate a typed-but-unsaved key with one lightweight decide() call. */
  brainValidateJev(apiKey: string, baseUrl?: string): Promise<{ ok: boolean; error?: string }>;
  brainHandleUtterance(text: string, source: 'voice' | 'text'): Promise<void>;
  onBrainEvent(cb: (e: BrainEvent) => void): () => void;
  // native ad blocker
  adblockGet(): Promise<AdBlockState>;
  adblockSetEnabled(enabled: boolean): Promise<AdBlockState>;
  /** allowed=true adds the host to the allowlist (ads show on that site). */
  adblockSetSiteAllowed(host: string, allowed: boolean): Promise<AdBlockState>;
  onAdBlockStats(cb: (s: AdBlockStats) => void): () => void;
  // events
  onSnapshot(cb: (s: BrowserSnapshot) => void): () => void;
  snapshotGet(): Promise<BrowserSnapshot>;
  onTabDelta(cb: (d: TabDelta) => void): () => void;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    nt: NextTokenAPI;
  }
}
