import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LIGHT_TOKENS, MAX_CHAT_SESSIONS, PROVIDER_PRESETS, SPACE_PALETTE } from '../shared/ipc';
import type {
  ActiveModelRef, AgentMessage, ArchivedTab, LocalModelMetrics, ProviderId, SiteBoost, SkillDef, SkillInput, ThemeTokens
} from '../shared/ipc';
import type { ModelRef } from './models/types';

export interface FavoritePersist { id: string; name: string; url: string }
export interface FolderPersist { id: string; name: string }
export interface BookmarkPersist { id: string; name: string; url: string; createdAt: number; folder?: string }
/** One open (non-pinned) tab, in sidebar order — restored on launch. */
export interface SessionTabPersist { url: string; title: string; folderId: string | null; favicon?: string | null }
export interface SpacePersist {
  id: string;
  name: string;
  favorites: FavoritePersist[];
  pinned: { url: string; title: string }[];
  folders: FolderPersist[];
  bookmarks: BookmarkPersist[];
  sessionTabs: SessionTabPersist[];
  sessionActiveUrl: string | null;
}
export interface ProviderPersist {
  /** Stable uuid — the keychain file for this provider's key is keyed by it. */
  id: string;
  presetId: ProviderId;
  /** User-editable display name, e.g. "Work OpenAI". */
  name: string;
  baseUrl: string;
  /** Default model id for this provider. */
  model: string;
  api: 'openai' | 'anthropic';
  enabled: boolean;
  createdAt: number;
}
export interface SkillPersist {
  id: string;
  name: string;
  trigger: string;
  prompt: string;
  category: string;
  builtIn: boolean;
}
export interface ChatSessionPersist {
  id: string;
  title: string;
  messages: AgentMessage[];
  at: number;
}

/** One record per downloaded model file: bytes on disk + last download timestamp. */
export interface ModelDownloadRecord { bytes: number; at: number; }

/** Remembered per-site permission decision. */
export type SitePermDecision = 'allow' | 'block';
/** Default policy for a permission type when no per-site decision exists. */
export type PermDefaultPolicy = 'allow' | 'block' | 'ask';
/** Per-site popup policy. 'ask' = blocked-popup toast with "Open anyway" (the default). */
export type PopupPolicy = 'allow' | 'block' | 'ask';

/** Privacy & security state: per-site permissions, popup/autoplay/sound policies. */
export interface PrivacyPersist {
  /** origin -> permission name -> remembered allow/block */
  permissions: Record<string, Record<string, SitePermDecision>>;
  /** permission name -> default policy */
  defaults: Record<string, PermDefaultPolicy>;
  /** origin -> popup policy */
  popups: Record<string, PopupPolicy>;
  /** origin -> autoplay policy ('block' forces user-activation-required) */
  autoplay: Record<string, 'allow' | 'block'>;
  /** origin -> muted */
  muted: Record<string, boolean>;
}

/** One visited page (capped) — powers per-site settings + clear-browsing-data. */
export interface HistoryEntry { url: string; title: string; at: number }

interface Persisted {
  spaces: SpacePersist[];
  activeSpaceId: string;
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
  /** Explicit user-set widths (px), or null for the automatic behavior. */
  sidebarWidth: number | null;
  agentPanelWidth: number | null;
  /** spaceId -> tokens. Seeded from DEFAULT_LIGHT_TOKENS (Dia-inspired calm light) + palette. */
  themes: Record<string, ThemeTokens>;
  voice: {
    enabled: boolean;
    speakReplies: boolean;
    voiceControl: boolean;
    cleanupEnabled: boolean;
    quickCleanMaxWords: number;
    micDeviceId: string;
  };
  searchEngine: string;
  /** BYOK providers (provider manager). Each provider's API key lives in the OS keychain. */
  providers: ProviderPersist[];
  agentHistory: AgentMessage[];
  archived: ArchivedTab[];
  /** Per-site restyling — planned Boosts feature. Persisted now, no UI yet. */
  boosts: SiteBoost[];
  /** Auto-archive idle tabs after this long. Default 12h (Arc parity). */
  archiveAfterMs: number;
  /** Local model state: downloaded files, per-task assignment, Apple FM probe, active model. */
  models: {
    downloaded: Record<string, ModelDownloadRecord>;
    /** 'vision' still has its own per-task override; 'chat' is legacy — the unified activeModel drives chat now. */
    assignment: { chat: ModelRef; vision: ModelRef };
    /**
     * The vision task slot ('none' | 'cloud' | 'apple-fm' | downloaded vision
     * catalog id). 'none' until the user downloads a vision model — vision
     * tasks then raise a clear "download a vision model" notice instead of
     * silently falling back. Single source of truth: task-models.ts.
     */
    taskVision: string;
    appleFmAvailable: boolean | null;
    /** The single model selection used by every LLM call in the app. */
    activeModel: ActiveModelRef;
    /** Latest measured local-model (llama-server) turn; null until the first one completes. */
    localMetrics: LocalModelMetrics | null;
  };
  /** Brain / Jev config. The API key itself lives in the OS keychain via JevCredentialStore. */
  brain: { jevBaseUrl: string };
  /** Saved reusable prompts (slash commands + one-click chips). */
  skills: SkillPersist[];
  /** Ephemeral chats — only the most recent few are kept. */
  chatSessions: ChatSessionPersist[];
  /** Native ad blocker: global switch + per-site allowlist (by hostname). */
  adblock: { enabled: boolean; allowedHosts: string[] };
  /** Privacy & security: per-site permissions, popup/autoplay/sound policies. */
  privacy: PrivacyPersist;
  /** Browsing history (URL + title + time), capped — per-site settings + clear-data. */
  history: HistoryEntry[];
}

const ARCHIVE_AFTER_DEFAULT = 12 * 3600 * 1000;

/** Built-in skills — original prompts, seeded on first run. */
function defaultSkills(): SkillPersist[] {
  const defs: Array<[string, string, string, string]> = [
    ['Summarize', '/summarize',
      'Summarize the current page: 3 key takeaways, the single most important fact or number, and why it matters — in one sentence. Under 120 words.',
      'Reading'],
    ['Write', '/write',
      'Improve the writing I am working with: fix grammar, tighten the sentences, keep my voice. Reply with only the revised text.',
      'Writing'],
    ['Explain code', '/explain',
      'Explain the code visible on this page step by step, as if to a smart beginner. Name what each part does and why it exists.',
      'Coding'],
    ['Brainstorm', '/ideas',
      'Give me 6 fresh angles or ideas related to the topic of this page. One line each, no fluff.',
      'Thinking'],
    ['Social draft', '/social',
      'Draft a short social-media post about this page: a hook first, one key point, then 3 hashtags.',
      'Writing'],
    ['Price compare', '/compare',
      'Compare the products or prices discussed on this page in a compact table: name, price, key difference, verdict.',
      'Shopping'],
  ];
  return defs.map(([name, trigger, prompt, category]) => ({
    id: randomUUID(), name, trigger, prompt, category, builtIn: true,
  }));
}

function defaultSpaces(): SpacePersist[] {
  // One default Bit ships with the app ("Bits" is the user-facing name for spaces).
  const s: SpacePersist = {
    id: randomUUID(),
    name: 'Personal',
    favorites: [{ id: randomUUID(), name: 'GitHub', url: 'https://github.com' }],
    pinned: [],
    folders: [],
    bookmarks: [],
    sessionTabs: [],
    sessionActiveUrl: null
  };
  return [s];
}

function defaults(): Persisted {
  const spaces = defaultSpaces();
  const themes: Record<string, ThemeTokens> = {};
  spaces.forEach((s, i) => {
    themes[s.id] = { ...DEFAULT_LIGHT_TOKENS, spaceColor: SPACE_PALETTE[i % SPACE_PALETTE.length].value };
  });
  return {
    spaces,
    activeSpaceId: spaces[0].id,
    sidebarCollapsed: false,
    agentPanelOpen: false,
    sidebarWidth: null,
    agentPanelWidth: null,
    themes,
    voice: {
      enabled: true,
      speakReplies: false,
      voiceControl: false,
      cleanupEnabled: true,
      quickCleanMaxWords: 12,
      micDeviceId: "",
    },
    searchEngine: 'https://www.google.com/search?q=',
    providers: [{
      id: randomUUID(),
      presetId: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      api: 'openai',
      enabled: true,
      createdAt: Date.now()
    }],
    agentHistory: [],
    archived: [],
    boosts: [],
    archiveAfterMs: ARCHIVE_AFTER_DEFAULT,
    models: {
      downloaded: {},
      assignment: { chat: 'apple-fm', vision: 'none' },
      taskVision: 'none',
      appleFmAvailable: null,
      activeModel: { kind: 'local-applefm' },
      localMetrics: null
    },
    brain: { jevBaseUrl: '' },
    skills: defaultSkills(),
    chatSessions: [],
    adblock: { enabled: true, allowedHosts: [] },
    privacy: {
      permissions: {},
      defaults: {},
      popups: {},
      autoplay: {},
      muted: {},
    },
    history: [],
  };
}

export class Store {
  private file: string;
  private data: Persisted;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'next-token.json');
    this.data = this.load();
  }

  private load(): Persisted {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = { ...defaults(), ...JSON.parse(raw) };
      // Backfill the models shape for installs that predate it.
      if (!parsed.models) parsed.models = defaults().models;
      // Backfill the vision task slot (v0.5.3): the single source of truth
      // moved from assignment.vision to taskVision. A legacy assignment that
      // points at a downloaded vision model is kept; anything else ('cloud',
      // 'apple-fm') becomes 'none' so vision tasks nudge the user to
      // download a vision model instead of silently using another model.
      if (typeof parsed.models.taskVision !== 'string') {
        const legacy = parsed.models.assignment?.vision;
        const legacyKept =
          typeof legacy === 'string' &&
          legacy !== 'cloud' && legacy !== 'apple-fm' && legacy !== 'applefm' &&
          parsed.models.downloaded?.[legacy];
        parsed.models.taskVision = legacyKept ? legacy : 'none';
        parsed.models.assignment.vision = parsed.models.taskVision;
      }
      // Backfill brain config + voice-control flag for installs that predate them.
      if (!parsed.brain) parsed.brain = defaults().brain;
      if (!parsed.voice) parsed.voice = defaults().voice;
      else {
        if (typeof parsed.voice.voiceControl !== 'boolean') parsed.voice.voiceControl = false;
        if (typeof parsed.voice.cleanupEnabled !== 'boolean') parsed.voice.cleanupEnabled = true;
        if (typeof parsed.voice.quickCleanMaxWords !== 'number') parsed.voice.quickCleanMaxWords = 12;
        if (typeof parsed.voice.micDeviceId !== 'string') parsed.voice.micDeviceId = "";
      }
      // Backfill skills + sessions for installs that predate them.
      if (!parsed.skills) parsed.skills = defaultSkills();
      if (!parsed.chatSessions) parsed.chatSessions = [];
      // Backfill ad-blocker config for installs that predate it.
      if (!parsed.adblock) parsed.adblock = defaults().adblock;
      // Backfill privacy & security + browsing history for installs that predate them.
      if (!parsed.privacy) parsed.privacy = defaults().privacy;
      else {
        for (const k of ['permissions', 'defaults', 'popups', 'autoplay', 'muted'] as const) {
          if (typeof parsed.privacy[k] !== 'object' || parsed.privacy[k] === null) {
            parsed.privacy[k] = {};
          }
        }
      }
      if (!Array.isArray(parsed.history)) parsed.history = [];
      // Backfill local-model metrics for installs that predate them.
      if (!('localMetrics' in parsed.models)) parsed.models.localMetrics = null;
      // Backfill the multi-provider manager for installs that predate it.
      if (!Array.isArray(parsed.providers)) {
        const legacy = parsed.provider ?? defaults().providers[0];
        const id = randomUUID();
        const preset = PROVIDER_PRESETS.find((p) => p.id === legacy.presetId);
        parsed.providers = [{
          id,
          presetId: legacy.presetId,
          name: preset?.name ?? 'Custom',
          baseUrl: legacy.baseUrl,
          model: legacy.model,
          api: legacy.api,
          enabled: true,
          createdAt: Date.now()
        }];
        // Migrate the legacy single key file into the new per-provider slot.
        try {
          const legacyFile = path.join(app.getPath('userData'), 'provider-key.bin');
          if (fs.existsSync(legacyFile)) {
            fs.mkdirSync(path.join(app.getPath('userData'), 'provider-keys'), { recursive: true });
            fs.copyFileSync(legacyFile, path.join(app.getPath('userData'), 'provider-keys', `${id}.bin`));
            fs.rmSync(legacyFile);
          }
        } catch { /* best effort — the user can re-enter the key */ }
        delete parsed.provider;
      }
      // Backfill the unified active model from the legacy per-task chat assignment.
      if (!parsed.models.activeModel) {
        const legacyChat: string = parsed.models.assignment?.chat ?? 'apple-fm';
        const cloud = parsed.providers.find((p: ProviderPersist) => p.enabled) ?? parsed.providers[0];
        parsed.models.activeModel =
          legacyChat === 'apple-fm' ? { kind: 'local-applefm' as const } :
          legacyChat === 'cloud' && cloud ? { kind: 'cloud' as const, id: cloud.id } :
          { kind: 'local' as const, id: legacyChat };
      }
      // Re-seed themes for spaces missing them (e.g. new spaces).
      for (const s of parsed.spaces) {
        if (!parsed.themes[s.id]) {
          parsed.themes[s.id] = {
            ...DEFAULT_LIGHT_TOKENS,
            spaceColor: SPACE_PALETTE[parsed.spaces.indexOf(s) % SPACE_PALETTE.length].value
          };
        }
        // Backfill folders/bookmarks/session for installs that predate them.
        if (!Array.isArray(s.folders)) s.folders = [];
        if (!Array.isArray(s.bookmarks)) s.bookmarks = [];
        if (!Array.isArray(s.sessionTabs)) s.sessionTabs = [];
        if (typeof s.sessionActiveUrl === 'undefined') s.sessionActiveUrl = null;
      }
      return parsed;
    } catch {
      return defaults();
    }
  }

  /** Debounced write — call after every mutation. */
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      } catch { /* best effort */ }
    }, 300);
  }

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch { /* best effort */ }
  }

  get d(): Persisted { return this.data; }

  // -- spaces ---------------------------------------------------------------
  addSpace(name: string): SpacePersist {
    const s: SpacePersist = {
      id: randomUUID(), name, favorites: [], pinned: [],
      folders: [], bookmarks: [], sessionTabs: [], sessionActiveUrl: null
    };
    this.data.spaces.push(s);
    this.data.themes[s.id] = {
      ...DEFAULT_LIGHT_TOKENS,
      spaceColor: SPACE_PALETTE[this.data.spaces.length % SPACE_PALETTE.length].value
    };
    this.saveSoon();
    return s;
  }

  /** Remove a Bit and its theme. The caller archives the Bit's tabs first. */
  deleteSpace(id: string): void {
    this.data.spaces = this.data.spaces.filter((s) => s.id !== id);
    delete this.data.themes[id];
    if (this.data.activeSpaceId === id) {
      this.data.activeSpaceId = this.data.spaces[0]?.id ?? '';
    }
    this.saveSoon();
  }

  themeFor(spaceId: string): ThemeTokens {
    return this.data.themes[spaceId] ?? { ...DEFAULT_LIGHT_TOKENS };
  }

  // -- folders (per Bit) -----------------------------------------------------
  addFolder(spaceId: string, name: string): FolderPersist {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    if (!s) throw new Error('Bit not found.');
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) throw new Error('Folder needs a name.');
    const f: FolderPersist = { id: randomUUID(), name: clean };
    s.folders.push(f);
    this.saveSoon();
    return f;
  }

  renameFolder(spaceId: string, folderId: string, name: string): void {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    const f = s?.folders.find((x) => x.id === folderId);
    if (!f) throw new Error('Folder not found.');
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) throw new Error('Folder needs a name.');
    f.name = clean;
    this.saveSoon();
  }

  removeFolder(spaceId: string, folderId: string): void {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    if (!s) return;
    s.folders = s.folders.filter((x) => x.id !== folderId);
    for (const t of s.sessionTabs) {
      if (t.folderId === folderId) t.folderId = null;
    }
    this.saveSoon();
  }

  // -- bookmarks (per Bit) ----------------------------------------------------
  listBookmarks(spaceId: string): BookmarkPersist[] {
    return this.data.spaces.find((x) => x.id === spaceId)?.bookmarks.map((b) => ({ ...b })) ?? [];
  }

  addBookmark(spaceId: string, name: string, url: string, folder?: string): BookmarkPersist[] {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    if (!s) throw new Error('Bit not found.');
    const cleanUrl = String(url ?? '').trim();
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) throw new Error('Only web pages can be bookmarked.');
    if (s.bookmarks.some((b) => b.url === cleanUrl)) return this.listBookmarks(spaceId);
    const cleanName = String(name ?? '').trim().slice(0, 80) || cleanUrl;
    const cleanFolder = String(folder ?? '').trim().slice(0, 160) || undefined;
    s.bookmarks.unshift({ id: randomUUID(), name: cleanName, url: cleanUrl, createdAt: Date.now(), folder: cleanFolder });
    this.saveSoon();
    return this.listBookmarks(spaceId);
  }

  renameBookmark(spaceId: string, id: string, name: string): BookmarkPersist[] {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    const b = s?.bookmarks.find((x) => x.id === id);
    if (!b) throw new Error('Bookmark not found.');
    const clean = String(name ?? '').trim().slice(0, 80);
    if (!clean) throw new Error('Bookmark needs a name.');
    b.name = clean;
    this.saveSoon();
    return this.listBookmarks(spaceId);
  }

  removeBookmark(spaceId: string, id: string): BookmarkPersist[] {
    const s = this.data.spaces.find((x) => x.id === spaceId);
    if (s) {
      s.bookmarks = s.bookmarks.filter((x) => x.id !== id);
      this.saveSoon();
    }
    return this.listBookmarks(spaceId);
  }

  // -- BYOK provider keys (one per provider, OS keychain via safeStorage; never in the JSON) --
  private keyFileFor(providerId: string): string {
    const dir = path.join(app.getPath('userData'), 'provider-keys');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${providerId}.bin`);
  }

  /**
   * Persist one provider's API key to the OS keychain.
   * Returns true when stored. Empty input clears the stored key.
   * Returns false (and stores nothing) when OS encryption is unavailable —
   * there is no plaintext fallback, ever.
   */
  setProviderKey(providerId: string, key: string): boolean {
    const trimmed = (key ?? '').trim();
    try {
      const file = this.keyFileFor(providerId);
      if (trimmed.length === 0) {
        fs.rmSync(file, { force: true });
        return true;
      }
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(file, safeStorage.encryptString(trimmed));
        return true;
      }
    } catch { /* fall through to refusal */ }
    return false;
  }

  /** Decrypt and return a provider's stored key, or null when absent/unreadable. */
  getProviderKey(providerId: string): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const key = safeStorage.decryptString(fs.readFileSync(this.keyFileFor(providerId)));
      return key.length > 0 ? key : null;
    } catch {
      return null;
    }
  }

  providerKeyConfigured(providerId: string): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    try {
      fs.readFileSync(this.keyFileFor(providerId));
      return true;
    } catch { return false; }
  }

  /** Remove a provider's key file (used when the provider is deleted). */
  removeProviderKey(providerId: string): void {
    try { fs.rmSync(this.keyFileFor(providerId), { force: true }); } catch { /* best effort */ }
  }

  // -- browsing history (visited pages, capped at 1000) -----------------------
  /** Record a page visit. Consecutive duplicates collapse; capped at 1000. */
  pushHistoryEntry(url: string, title: string) {
    const clean = String(url ?? '').slice(0, 2048);
    if (!/^https?:\/\//i.test(clean)) return;
    const last = this.data.history[0];
    if (last && last.url === clean) {
      last.title = String(title ?? '').slice(0, 200) || last.title;
      last.at = Date.now();
      this.saveSoon();
      return;
    }
    this.data.history.unshift({
      url: clean,
      title: String(title ?? '').slice(0, 200),
      at: Date.now(),
    });
    if (this.data.history.length > 1000) {
      this.data.history = this.data.history.slice(0, 1000);
    }
    this.saveSoon();
  }

  clearHistory() {
    this.data.history = [];
    this.saveSoon();
  }

  // -- agent history (text only, capped) -------------------------------------
  pushHistory(m: AgentMessage) {
    this.data.agentHistory.push(m);
    if (this.data.agentHistory.length > 100) {
      this.data.agentHistory = this.data.agentHistory.slice(-100);
    }
    this.saveSoon();
  }

  // -- skills (saved reusable prompts) ---------------------------------------
  listSkills(): SkillDef[] {
    return this.data.skills.map((s) => ({ ...s }));
  }

  saveSkill(input: SkillInput): void {
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    let trigger = String(input.trigger ?? '').trim().toLowerCase();
    if (!name) throw new Error('Skill needs a name.');
    if (!prompt) throw new Error('Skill needs a prompt.');
    if (!trigger.startsWith('/')) trigger = `/${trigger}`;
    if (!/^\/[a-z0-9-_]{1,32}$/.test(trigger)) {
      throw new Error('Trigger must look like /summarize (lowercase, no spaces).');
    }
    const clash = this.data.skills.find(
      (s) => s.trigger === trigger && s.id !== input.id,
    );
    if (clash) throw new Error(`Another skill already uses ${trigger}.`);
    const category = String(input.category ?? '').trim() || 'General';
    if (input.id) {
      const existing = this.data.skills.find((s) => s.id === input.id);
      if (!existing) throw new Error('Skill not found.');
      existing.name = name;
      existing.trigger = trigger;
      existing.prompt = prompt;
      existing.category = category;
    } else {
      this.data.skills.push({
        id: randomUUID(), name, trigger, prompt, category, builtIn: false,
      });
    }
    this.saveSoon();
  }

  removeSkill(id: string): void {
    this.data.skills = this.data.skills.filter((s) => s.id !== id);
    this.saveSoon();
  }

  resetSkills(): void {
    this.data.skills = defaultSkills();
    this.saveSoon();
  }

  // -- chat sessions (ephemeral chats) ---------------------------------------
  /** Archive the current conversation and start fresh. No-op when empty. */
  archiveChatSession(): void {
    const hist = this.data.agentHistory;
    if (hist.length === 0) return;
    const firstUser = hist.find((m) => m.role === 'user');
    const title = (firstUser?.text ?? 'Chat').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat';
    this.data.chatSessions.unshift({
      id: randomUUID(), title, messages: [...hist], at: Date.now(),
    });
    this.data.chatSessions = this.data.chatSessions.slice(0, MAX_CHAT_SESSIONS);
    this.data.agentHistory = [];
    this.saveSoon();
  }

  openChatSession(id: string): void {
    const s = this.data.chatSessions.find((x) => x.id === id);
    if (!s) throw new Error('Chat not found.');
    this.data.agentHistory = [...s.messages];
    this.saveSoon();
  }
}
