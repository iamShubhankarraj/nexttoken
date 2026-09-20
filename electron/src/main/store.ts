import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DARK_TOKENS, MAX_CHAT_SESSIONS, SPACE_PALETTE } from '../shared/ipc';
import type {
  AgentMessage, ArchivedTab, ProviderId, SiteBoost, SkillDef, SkillInput, ThemeTokens
} from '../shared/ipc';
import type { ModelRef } from './models/types';

export interface FavoritePersist { id: string; name: string; url: string }
export interface SpacePersist {
  id: string;
  name: string;
  favorites: FavoritePersist[];
  pinned: { url: string; title: string }[];
}
export interface ProviderPersist {
  presetId: ProviderId;
  baseUrl: string;
  model: string;
  api: 'openai' | 'anthropic';
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

interface Persisted {
  spaces: SpacePersist[];
  activeSpaceId: string;
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
  /** spaceId -> tokens. Seeded from DEFAULT_DARK_TOKENS + palette. */
  themes: Record<string, ThemeTokens>;
  voice: { enabled: boolean; speakReplies: boolean; voiceControl: boolean };
  searchEngine: string;
  provider: ProviderPersist;
  agentHistory: AgentMessage[];
  archived: ArchivedTab[];
  /** Per-site restyling — planned Boosts feature. Persisted now, no UI yet. */
  boosts: SiteBoost[];
  /** Auto-archive idle tabs after this long. Default 12h (Arc parity). */
  archiveAfterMs: number;
  /** Local model state: downloaded files, per-task assignment, Apple FM probe. */
  models: {
    downloaded: Record<string, ModelDownloadRecord>;
    assignment: { chat: ModelRef; vision: ModelRef };
    appleFmAvailable: boolean | null;
  };
  /** Brain / Jev config. The API key itself lives in the OS keychain via JevCredentialStore. */
  brain: { jevBaseUrl: string };
  /** Saved reusable prompts (slash commands + one-click chips). */
  skills: SkillPersist[];
  /** Ephemeral chats — only the most recent few are kept. */
  chatSessions: ChatSessionPersist[];
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
  const defs = [
    { name: 'Research', favorites: [{ name: 'GitHub', url: 'https://github.com' }] },
    { name: 'Build', favorites: [{ name: 'MDN', url: 'https://developer.mozilla.org' }] },
    { name: 'Chill', favorites: [{ name: 'YouTube', url: 'https://www.youtube.com' }] }
  ];
  return defs.map((d, i) => ({
    id: randomUUID(),
    name: d.name,
    favorites: d.favorites.map((f) => ({ id: randomUUID(), ...f })),
    pinned: []
  }));
}

function defaults(): Persisted {
  const spaces = defaultSpaces();
  const themes: Record<string, ThemeTokens> = {};
  spaces.forEach((s, i) => {
    themes[s.id] = { ...DEFAULT_DARK_TOKENS, spaceColor: SPACE_PALETTE[i % SPACE_PALETTE.length].value };
  });
  return {
    spaces,
    activeSpaceId: spaces[0].id,
    sidebarCollapsed: false,
    agentPanelOpen: false,
    themes,
    voice: { enabled: true, speakReplies: false, voiceControl: false },
    searchEngine: 'https://www.google.com/search?q=',
    provider: { presetId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', api: 'openai' },
    agentHistory: [],
    archived: [],
    boosts: [],
    archiveAfterMs: ARCHIVE_AFTER_DEFAULT,
    models: {
      downloaded: {},
      assignment: { chat: 'apple-fm', vision: 'cloud' },
      appleFmAvailable: null
    },
    brain: { jevBaseUrl: '' },
    skills: defaultSkills(),
    chatSessions: []
  };
}

export class Store {
  private file: string;
  private keyFile: string;
  private data: Persisted;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'next-token.json');
    this.keyFile = path.join(dir, 'provider-key.bin');
    this.data = this.load();
  }

  private load(): Persisted {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = { ...defaults(), ...JSON.parse(raw) };
      // Backfill the models shape for installs that predate it.
      if (!parsed.models) parsed.models = defaults().models;
      // Backfill brain config + voice-control flag for installs that predate them.
      if (!parsed.brain) parsed.brain = defaults().brain;
      if (!parsed.voice) parsed.voice = defaults().voice;
      else if (typeof parsed.voice.voiceControl !== 'boolean') parsed.voice.voiceControl = false;
      // Backfill skills + sessions for installs that predate them.
      if (!parsed.skills) parsed.skills = defaultSkills();
      if (!parsed.chatSessions) parsed.chatSessions = [];
      // Re-seed themes for spaces missing them (e.g. new spaces).
      for (const s of parsed.spaces) {
        if (!parsed.themes[s.id]) {
          parsed.themes[s.id] = {
            ...DEFAULT_DARK_TOKENS,
            spaceColor: SPACE_PALETTE[parsed.spaces.indexOf(s) % SPACE_PALETTE.length].value
          };
        }
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
    const s: SpacePersist = { id: randomUUID(), name, favorites: [], pinned: [] };
    this.data.spaces.push(s);
    this.data.themes[s.id] = {
      ...DEFAULT_DARK_TOKENS,
      spaceColor: SPACE_PALETTE[this.data.spaces.length % SPACE_PALETTE.length].value
    };
    this.saveSoon();
    return s;
  }

  themeFor(spaceId: string): ThemeTokens {
    return this.data.themes[spaceId] ?? { ...DEFAULT_DARK_TOKENS };
  }

  // -- API key (OS keychain via safeStorage; never in the JSON) -------------
  // Returns true when the key was encrypted into the OS keychain.
  // If OS encryption is unavailable we REFUSE to store the key at all —
  // there is no plaintext fallback. (On macOS safeStorage always works.)
  setApiKey(key: string): boolean {
    if (!key) return true; // nothing to store
    try {
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(this.keyFile, safeStorage.encryptString(key));
        return true;
      }
    } catch { /* fall through to refusal */ }
    return false;
  }

  getApiKey(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const buf = fs.readFileSync(this.keyFile);
      return safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }

  get keyInKeychain(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    try {
      fs.readFileSync(this.keyFile);
      return true;
    } catch { return false; }
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
