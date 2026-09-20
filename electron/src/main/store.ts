import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DARK_TOKENS, SPACE_PALETTE } from '../shared/ipc';
import type {
  AgentMessage, ArchivedTab, ProviderId, SiteBoost, ThemeTokens
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

/** One record per downloaded model file: bytes on disk + last download timestamp. */
export interface ModelDownloadRecord { bytes: number; at: number; }

interface Persisted {
  spaces: SpacePersist[];
  activeSpaceId: string;
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
  /** spaceId -> tokens. Seeded from DEFAULT_DARK_TOKENS + palette. */
  themes: Record<string, ThemeTokens>;
  voice: { enabled: boolean; speakReplies: boolean };
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
}

const ARCHIVE_AFTER_DEFAULT = 12 * 3600 * 1000;

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
    voice: { enabled: true, speakReplies: false },
    searchEngine: 'https://www.google.com/search?q=',
    provider: { presetId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', api: 'openai' },
    agentHistory: [],
    archived: [],
    boosts: [],
    archiveAfterMs: ARCHIVE_AFTER_DEFAULT,
    models: {
      downloaded: {},
      assignment: { chat: 'applefm', vision: 'cloud' },
      appleFmAvailable: null
    }
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
}
