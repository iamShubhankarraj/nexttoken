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
}

export interface SpaceState {
  id: string;
  name: string;
  /** Hex accent color for this space. */
  accent: string;
  tabs: TabState[];
  activeTabId: string | null;
  favorites: FavoriteState[];
}

export interface FavoriteState {
  id: string;
  name: string;
  url: string;
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
  type: 'title' | 'url' | 'loading' | 'nav-state';
  value: string | boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
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
  bgBase: '#F4F2ED',
  bgSubtle: '#ECE9E2',
  bgRaised: '#FBFAF6',
  bgOverlay: '#FFFFFF',
  bgHover: '#E6E2D8',
  border: 'rgba(28,26,21,0.10)',
  borderStrong: 'rgba(28,26,21,0.20)',
  text1: '#1C1A15',
  text2: 'rgba(28,26,21,0.68)',
  text3: 'rgba(28,26,21,0.45)',
  textFaint: 'rgba(28,26,21,0.28)',
  accent: '#B97A1F',
  accentSoft: 'rgba(185,122,31,0.14)',
  accentText: '#FFFFFF',
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
    : '0 0 12px rgba(185,122,31,0.25)';
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

/** What the renderer is allowed to see — the key itself never leaves main. */
export interface ProviderConfigPublic {
  presetId: ProviderId;
  name: string;
  baseUrl: string;
  model: string;
  api: 'openai' | 'anthropic';
  keyConfigured: boolean;
}

export interface ProviderConfigInput {
  presetId: ProviderId;
  baseUrl: string;
  apiKey: string; // empty string = keep existing
  model: string;
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

export interface ModelAssignment {
  chat: ModelRef;
  vision: ModelRef;
}

export interface AppleFmStatus {
  available: boolean;
  reason?: string;
}

export type VoiceEngineState = 'idle' | 'listening' | 'transcribing' | 'speaking';

/** Voice settings. voiceControl routes STT transcripts into the brain (voice commands). */
export interface VoiceSettings {
  enabled: boolean;
  speakReplies: boolean;
  voiceControl: boolean;
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
  tabsPin(tabId: string, pinned: boolean): Promise<void>;
  tabsMove(tabId: string, spaceId: string): Promise<void>;
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
  // spaces
  spacesCreate(name: string): Promise<string>;
  spacesSwitch(id: string): Promise<void>;
  spacesRename(id: string, name: string): Promise<void>;
  spacesSetAccent(id: string, accent: string): Promise<void>;
  spacesAddFavorite(spaceId: string, name: string, url: string): Promise<void>;
  spacesRemoveFavorite(spaceId: string, favId: string): Promise<void>;
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
  // settings (BYOK)
  settingsGetProvider(): Promise<ProviderConfigPublic>;
  settingsSetProvider(input: ProviderConfigInput): Promise<ProviderConfigPublic>;
  settingsTestConnection(): Promise<{ ok: boolean; error?: string; model?: string }>;
  settingsGetVoice(): Promise<VoiceSettings>;
  settingsSetVoice(v: { enabled: boolean; speakReplies: boolean; voiceControl?: boolean }): Promise<void>;
  settingsGetSearchEngine(): Promise<string>;
  settingsSetSearchEngine(url: string): Promise<void>;
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
  modelsAppleFm(): Promise<AppleFmStatus>;
  modelsDiskUsage(): Promise<number>;
  onModelEvent(cb: (e: ModelEvent) => void): () => void;
  // voice engine (local STT/TTS sidecars; Web Speech remains the fallback)
  voiceSttAvailable(): Promise<boolean>;
  voiceStartListening(): Promise<void>;
  voiceAudioChunk(data: Uint8Array): Promise<void>;
  voiceStopListening(): Promise<string>;
  voiceCancelListening(): Promise<void>;
  voiceSpeak(text: string): Promise<Uint8Array>;
  onVoiceEngineState(cb: (s: VoiceEngineState) => void): () => void;
  /** Raw WAV bytes (number[]) for a brain TTS reply — renderer decodes and plays. */
  onVoicePlayback(cb: (bytes: number[]) => void): () => void;
  /** Brain asked the renderer to open its command bar. */
  onCommandBar(cb: () => void): () => void;
  /** Brain asked the renderer to start/stop microphone capture. */
  onVoiceRequestListen(cb: (start: boolean) => void): () => void;
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
