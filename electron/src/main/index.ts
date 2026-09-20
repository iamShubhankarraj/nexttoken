import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store';
import { TabManager } from './tabs';
import { startAgentRun, cancelAgentRun } from './agent/loop';
import { testConnection } from './agent/llm';
import { APPLE_FM_REF, CLOUD_REF, type RouterDeps } from './agent/router';
import { snapshotPage, formatSnapshot } from './agent/perceive';
import { JevClient } from './brain/jev';
import { JevCredentialStore } from './brain/credentials';
import { Orchestrator, createRouterChat, type BrainPageState } from './brain/orchestrator';
import { executeControl, type ControlEnv } from './brain/control';
import { MODEL_CATALOG, ModelDownloader, targetPathFor, type DownloadEvent } from './models';
import { ensureSidecar } from './models/binaries';
import { LlamaServer } from './models/runtime';
import { AppleFmClient } from './models/applefm';
import { VoiceEngine } from './voice';
import {
  PROVIDER_PRESETS, DEFAULT_DARK_TOKENS
} from '../shared/ipc';
import type {
  AgentEvent, BrainEvent, BrowserSnapshot, ChatSession, JevConfigInput, JevConfigPublic, ModelAssignment,
  ModelEntryPublic, ModelEvent, ProviderConfigInput, ProviderConfigPublic, SkillDef, SkillInput, SpaceState,
  TabDelta, ThemeTokens, VoiceEngineState
} from '../shared/ipc';

let win: BrowserWindow | null = null;
let settingsOpen = false;
let store: Store;
let tabs: TabManager;

// -- local-model tier ---------------------------------------------------------
let modelsDir = '';
let binDir = '';
let downloader: ModelDownloader;
let llama: LlamaServer;
let appleFm: AppleFmClient;
let voiceEngine: VoiceEngine;
let routerDeps: RouterDeps;
/** In-flight download progress (id -> bytes), mirrored from downloader events. */
const dlProgress = new Map<string, { bytesDownloaded: number; totalBytes: number }>();

// -- brain (Jev System-One orchestration) ---------------------------------------
let jevCreds: JevCredentialStore;
let jevClient: JevClient;
let orchestrator: Orchestrator;

function emitModelEvent(e: ModelEvent) {
  if (e.kind === 'progress') {
    dlProgress.set(e.id, { bytesDownloaded: e.bytesDownloaded, totalBytes: e.totalBytes });
  } else {
    if (e.kind === 'done') {
      const prog = dlProgress.get(e.id);
      const entry = catalogEntry(e.id);
      store.d.models.downloaded[e.id] = {
        bytes: prog?.totalBytes ?? entry?.sizeBytes ?? 0,
        at: Date.now()
      };
      store.saveSoon();
    }
    dlProgress.delete(e.id);
  }
  win?.webContents.send('nt.model-event', e);
}

function catalogEntry(id: string) {
  return MODEL_CATALOG.find((e) => e.id === id);
}

/** Absolute path of a downloaded STT model file, or null. Prefers base, then small. */
function sttModelFile(): string | null {
  const ordered = [...MODEL_CATALOG]
    .filter((e) => e.task === 'stt')
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
  for (const e of ordered) {
    if (!store.d.models.downloaded[e.id]) continue;
    const p = targetPathFor(modelsDir, e);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch { /* not on disk — keep looking */ }
  }
  return null;
}

/** Absolute path of a downloaded TTS model dir, or null. */
function ttsModelDir(): string | null {
  const e = MODEL_CATALOG.find((x) => x.task === 'tts' && store.d.models.downloaded[x.id]);
  if (!e) return null;
  const dir = path.join(modelsDir, e.id);
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith('.onnx'))) return dir;
  } catch { /* missing */ }
  return null;
}

/** whisper-cli is a manual install (whisper.cpp ships no prebuilt macOS binary). */
function whisperBinaryAvailable(): boolean {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  try {
    fs.accessSync(path.join(binDir, name), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function initModelTier() {
  const userData = app.getPath('userData');
  modelsDir = path.join(userData, 'models');
  binDir = path.join(userData, 'bin');
  downloader = new ModelDownloader({ modelsDir, onEvent: emitModelEvent });
  llama = new LlamaServer({ binDir, modelsDir, ensureSidecar });
  appleFm = new AppleFmClient({
    binaryCandidates: [
      // Packaged app: extraResources/sidecars (see native/applefm/build.sh).
      path.join(process.resourcesPath, 'sidecars', 'applefm-bridge'),
      // Dev: repo resources dir.
      path.join(app.getAppPath(), 'resources', 'sidecars', 'applefm-bridge')
    ]
  });
  voiceEngine = new VoiceEngine({
    binDir,
    modelsDir,
    ensureSidecar,
    events: {
      onState: (s: VoiceEngineState) => win?.webContents.send('nt.voice-engine-state', s)
    },
    getSttModelFile: sttModelFile,
    getTtsModelDir: ttsModelDir
  });
  routerDeps = { store, appleFm, llama };

  // -- brain: Jev System-One orchestration --------------------------------------
  jevCreds = new JevCredentialStore(userData);
  jevClient = new JevClient({
    // Runtime key source: OS keychain, resolved on every call. The raw key is
    // never held in app state and never logged.
    keyProvider: () => jevCreds.loadKey(),
    baseUrl: store.d.brain.jevBaseUrl || undefined
  });
  orchestrator = new Orchestrator({
    jev: jevClient,
    control: { execute: (intent, slots) => executeControl(brainControlEnv(), intent, slots) },
    chat: createRouterChat(routerDeps),
    speak: {
      speak: async (text: string) => {
        const wav = await voiceEngine.speak(text);
        win?.webContents.send('nt.voice.playback', Array.from(wav));
      }
    },
    confirm: {
      ask: async (text: string) => {
        if (!win) return false;
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Cancel', 'Confirm'],
          defaultId: 0,
          cancelId: 0,
          message: text
        });
        return r.response === 1;
      }
    },
    getPageState: async (): Promise<BrainPageState> => {
      const wc = tabs.activeWebContents();
      const snap = wc ? await snapshotPage(wc).catch(() => null) : null;
      const tabList = [...tabs.tabs.values()].filter((t) => t.spaceId === store.d.activeSpaceId);
      const tabSummary = tabList.length === 0
        ? 'no tabs open'
        : tabList.map((t) => `${t.title}${t.id === tabs.activeTabId ? ' (active)' : ''}`).join(', ');
      return {
        url: snap?.url ?? '',
        title: snap?.title ?? '',
        tabSummary,
        pageText: snap ? formatSnapshot(snap) : '(no readable page)'
      };
    },
    startAgentRun: (task: string) =>
      startAgentRun(task, { win: win as BrowserWindow, tabs, store, emit: emitAgent, router: routerDeps }, { voice: true }),
    emit: (e: BrainEvent) => win?.webContents.send('nt.brain.event', e)
  });
}

function publicProvider(): ProviderConfigPublic {
  const p = store.d.provider;
  const preset = PROVIDER_PRESETS.find((x) => x.id === p.presetId);
  return {
    presetId: p.presetId,
    name: preset?.name ?? 'Custom',
    baseUrl: p.baseUrl,
    model: p.model,
    api: p.api,
    keyConfigured: !!store.getApiKey()
  };
}

function snapshot(): BrowserSnapshot {
  const d = store.d;
  const spaces: SpaceState[] = d.spaces.map((s) => {
    const stabs = [...tabs.tabs.values()].filter((t) => t.spaceId === s.id);
    const activeInSpace = tabs.activeTabId && stabs.some((t) => t.id === tabs.activeTabId)
      ? tabs.activeTabId
      : stabs[0]?.id ?? null;
    return {
      id: s.id,
      name: s.name,
      accent: store.themeFor(s.id).spaceColor,
      tabs: stabs.map((t) => tabs.toState(t)),
      activeTabId: activeInSpace,
      favorites: s.favorites
    };
  });
  return {
    spaces,
    activeSpaceId: d.activeSpaceId,
    archived: d.archived,
    sidebarCollapsed: d.sidebarCollapsed,
    agentPanelOpen: d.agentPanelOpen,
    settingsOpen
  };
}

function sendSnapshot() {
  win?.webContents.send('nt.snapshot', snapshot());
}

function emitAgent(e: AgentEvent) {
  win?.webContents.send('nt.agent-event', e);
}

/** Adapter from brain intents to the same state setters the nt.ui.* handlers use. */
function brainControlEnv(): ControlEnv {
  return {
    tabs,
    store,
    setSidebarCollapsed: (c) => { store.d.sidebarCollapsed = c; store.saveSoon(); sendSnapshot(); },
    setAgentPanelOpen: (o) => { store.d.agentPanelOpen = o; store.saveSoon(); sendSnapshot(); },
    setSettingsOpen: (o) => { settingsOpen = o; sendSnapshot(); },
    openCommandBar: () => win?.webContents.send('nt.ui.command-bar'),
    requestListen: (start) => win?.webContents.send('nt.voice.request-listen', start),
    refreshSnapshot: () => sendSnapshot(),
    saveSoon: () => store.saveSoon()
  };
}

function ensureSpaceTab(spaceId: string) {
  const has = [...tabs.tabs.values()].some((t) => t.spaceId === spaceId);
  if (!has) {
    const t = tabs.create(spaceId);
    if (store.d.activeSpaceId === spaceId) tabs.activate(t.id);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Next Token',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0B0B0D',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // tab contents are <webview> guests; main drives them via WebContents
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => { win = null; });
}

function registerIpc() {
  // Pull-based boot: the renderer's first subscription can miss main's
  // initial push, so it requests the snapshot explicitly on mount.
  ipcMain.handle('nt.snapshot.get', (): BrowserSnapshot => snapshot());

  // -- tabs ---------------------------------------------------------------
  ipcMain.handle('nt.tabs.create', (_e, opts?: { spaceId?: string; url?: string }) => {
    const spaceId = opts?.spaceId && store.d.spaces.some((s) => s.id === opts.spaceId)
      ? opts.spaceId
      : store.d.activeSpaceId;
    const t = tabs.create(spaceId, opts?.url);
    tabs.activate(t.id);
    return t.id;
  });
  ipcMain.handle('nt.tabs.close', (_e, tabId: string) => tabs.close(tabId));
  ipcMain.handle('nt.tabs.activate', (_e, tabId: string) => tabs.activate(tabId));
  ipcMain.handle('nt.tabs.pin', (_e, tabId: string, pinned: boolean) => {
    const t = tabs.tabs.get(tabId);
    if (t) { t.pinned = pinned; tabs.persistPinned(); sendSnapshot(); }
  });
  ipcMain.handle('nt.tabs.move', (_e, tabId: string, spaceId: string) => {
    const t = tabs.tabs.get(tabId);
    if (t && store.d.spaces.some((s) => s.id === spaceId)) { t.spaceId = spaceId; sendSnapshot(); }
  });
  ipcMain.handle('nt.tabs.attach', (_e, tabId: string, wcId: number) => {
    tabs.attach(tabId, wcId);
  });
  ipcMain.handle('nt.tabs.archive', (_e, tabId: string) => tabs.archive(tabId, true));
  ipcMain.handle('nt.tabs.restore', (_e, archivedId: string) => tabs.restore(archivedId));

  // -- navigation ----------------------------------------------------------
  ipcMain.handle('nt.nav.go', (_e, raw: string) => tabs.go(raw));
  ipcMain.handle('nt.nav.back', () => tabs.back());
  ipcMain.handle('nt.nav.forward', () => tabs.forward());
  ipcMain.handle('nt.nav.reload', () => tabs.reload());
  ipcMain.handle('nt.nav.stop', () => tabs.stop());

  // -- spaces ---------------------------------------------------------------
  ipcMain.handle('nt.spaces.create', (_e, name: string) => {
    const s = store.addSpace(name || 'New Space');
    ensureSpaceTab(s.id);
    return s.id;
  });
  ipcMain.handle('nt.spaces.switch', (_e, id: string) => {
    if (!store.d.spaces.some((s) => s.id === id)) return;
    store.d.activeSpaceId = id;
    store.saveSoon();
    ensureSpaceTab(id);
    const first = [...tabs.tabs.values()].find((t) => t.spaceId === id);
    if (first) tabs.activate(first.id);
    else sendSnapshot();
  });
  ipcMain.handle('nt.spaces.rename', (_e, id: string, name: string) => {
    const s = store.d.spaces.find((x) => x.id === id);
    if (s && name.trim()) { s.name = name.trim(); store.saveSoon(); sendSnapshot(); }
  });
  ipcMain.handle('nt.spaces.set-accent', (_e, id: string, spaceColor: string) => {
    const t = store.themeFor(id);
    store.d.themes[id] = { ...t, spaceColor };
    store.saveSoon();
    sendSnapshot();
  });
  ipcMain.handle('nt.spaces.add-favorite', (_e, spaceId: string, name: string, url: string) => {
    const s = store.d.spaces.find((x) => x.id === spaceId);
    if (s) {
      import('node:crypto').then(({ randomUUID }) => {
        s.favorites.push({ id: randomUUID(), name, url });
        store.saveSoon();
        sendSnapshot();
      });
    }
  });
  ipcMain.handle('nt.spaces.remove-favorite', (_e, spaceId: string, favId: string) => {
    const s = store.d.spaces.find((x) => x.id === spaceId);
    if (s) {
      s.favorites = s.favorites.filter((f) => f.id !== favId);
      store.saveSoon();
      sendSnapshot();
    }
  });

  // -- ui --------------------------------------------------------------------
  ipcMain.handle('nt.ui.sidebar-collapsed', (_e, c: boolean) => {
    store.d.sidebarCollapsed = c; store.saveSoon(); sendSnapshot();
  });
  ipcMain.handle('nt.ui.agent-panel', (_e, o: boolean) => {
    store.d.agentPanelOpen = o; store.saveSoon(); sendSnapshot();
  });
  ipcMain.handle('nt.ui.settings-open', (_e, o: boolean) => {
    settingsOpen = o; sendSnapshot();
  });

  // -- agent -------------------------------------------------------------------
  ipcMain.handle('nt.agent.chat', (_e, message: string, opts?: { voice?: boolean }) => {
    if (!win) throw new Error('No window');
    return startAgentRun(message, { win, tabs, store, emit: emitAgent, router: routerDeps }, opts);
  });
  ipcMain.handle('nt.agent.cancel', (_e, runId: string) => cancelAgentRun(runId));
  ipcMain.handle('nt.agent.history', () => store.d.agentHistory);
  ipcMain.handle('nt.agent.clear-history', () => {
    store.d.agentHistory = [];
    store.saveSoon();
  });
  ipcMain.handle('nt.agent.new-chat', () => {
    store.archiveChatSession();
  });
  ipcMain.handle('nt.agent.sessions', (): ChatSession[] => store.d.chatSessions);
  ipcMain.handle('nt.agent.open-session', (_e, id: string) => {
    store.openChatSession(id);
  });

  // -- skills ------------------------------------------------------------------
  ipcMain.handle('nt.skills.list', (): SkillDef[] => store.listSkills());
  ipcMain.handle('nt.skills.save', (_e, input: SkillInput): SkillDef[] => {
    store.saveSkill(input);
    return store.listSkills();
  });
  ipcMain.handle('nt.skills.remove', (_e, id: string): SkillDef[] => {
    store.removeSkill(id);
    return store.listSkills();
  });
  ipcMain.handle('nt.skills.reset', (): SkillDef[] => {
    store.resetSkills();
    return store.listSkills();
  });

  // -- settings / BYOK -----------------------------------------------------------
  ipcMain.handle('nt.settings.provider.get', (): ProviderConfigPublic => publicProvider());
  ipcMain.handle('nt.settings.provider.set', (_e, input: ProviderConfigInput): ProviderConfigPublic => {
    const preset = PROVIDER_PRESETS.find((x) => x.id === input.presetId);
    // Save the key FIRST so a keychain failure leaves prior settings untouched.
    if (input.apiKey && !store.setApiKey(input.apiKey)) {
      throw new Error('Could not access the OS keychain — the API key was not saved, and provider settings were left unchanged.');
    }
    store.d.provider = {
      presetId: input.presetId,
      baseUrl: input.baseUrl.trim() || preset?.baseUrl || '',
      model: input.model.trim(),
      api: preset?.api ?? 'openai'
    };
    store.saveSoon();
    return publicProvider();
  });
  ipcMain.handle('nt.settings.provider.test', async () => {
    const p = store.d.provider;
    return testConnection({
      baseUrl: p.baseUrl, api: p.api, apiKey: store.getApiKey() ?? '', model: p.model
    });
  });
  ipcMain.handle('nt.settings.voice.get', () => store.d.voice);
  ipcMain.handle('nt.settings.voice.set', (_e, v: { enabled: boolean; speakReplies: boolean; voiceControl?: boolean }) => {
    store.d.voice = { enabled: !!v.enabled, speakReplies: !!v.speakReplies, voiceControl: !!v.voiceControl };
    store.saveSoon();
  });
  ipcMain.handle('nt.settings.search-engine.get', () => store.d.searchEngine);
  ipcMain.handle('nt.settings.search-engine.set', (_e, url: string) => {
    if (url.trim()) { store.d.searchEngine = url.trim(); store.saveSoon(); }
  });

  // -- themes ----------------------------------------------------------------------
  ipcMain.handle('nt.themes.get', (_e, spaceId: string): ThemeTokens => ({ ...store.themeFor(spaceId) }));
  ipcMain.handle('nt.themes.set', (_e, spaceId: string, tokens: ThemeTokens) => {
    store.d.themes[spaceId] = { ...DEFAULT_DARK_TOKENS, ...tokens };
    store.saveSoon();
    sendSnapshot();
  });
  ipcMain.handle('nt.themes.reset', (_e, spaceId: string) => {
    delete store.d.themes[spaceId];
    store.saveSoon();
    sendSnapshot();
  });

  // -- local models ---------------------------------------------------------------
  ipcMain.handle('nt.models.list', (): ModelEntryPublic[] => {
    const d = store.d.models;
    return MODEL_CATALOG.map((e) => {
      const rec = d.downloaded[e.id];
      const prog = dlProgress.get(e.id);
      return {
        id: e.id,
        name: e.name,
        task: e.task,
        params: e.params,
        quant: e.quant,
        sizeBytes: e.sizeBytes,
        description: e.description,
        license: e.license,
        downloaded: !!rec,
        downloading: prog !== undefined,
        bytesDownloaded: prog?.bytesDownloaded ?? rec?.bytes ?? 0,
        totalBytes: prog?.totalBytes ?? e.sizeBytes
      };
    });
  });
  ipcMain.handle('nt.models.download', (_e, id: string) => {
    const entry = catalogEntry(id);
    if (!entry) throw new Error(`Unknown model "${id}"`);
    if (store.d.models.downloaded[id] || dlProgress.has(id)) return;
    // Fire-and-forget: progress/errors arrive via nt.model-event.
    void downloader.download(entry).then(undefined, () => { /* reported via event */ });
  });
  ipcMain.handle('nt.models.cancel-download', (_e, id: string) => {
    downloader.cancel(id);
  });
  ipcMain.handle('nt.models.remove', async (_e, id: string) => {
    const entry = catalogEntry(id);
    if (!entry) throw new Error(`Unknown model "${id}"`);
    for (const slot of ['chat', 'vision'] as const) {
      if (llama.status(slot).modelId === id) {
        await llama.stop(slot).catch(() => { /* best effort */ });
      }
    }
    await downloader.remove(id);
    delete store.d.models.downloaded[id];
    if (store.d.models.assignment.chat === id) store.d.models.assignment.chat = APPLE_FM_REF;
    if (store.d.models.assignment.vision === id) store.d.models.assignment.vision = CLOUD_REF;
    store.saveSoon();
  });
  ipcMain.handle('nt.models.assignment.get', (): ModelAssignment => {
    const a = store.d.models.assignment;
    // Tolerate the pre-standardisation 'applefm' spelling from early installs.
    return {
      chat: a.chat === 'applefm' ? APPLE_FM_REF : a.chat,
      vision: a.vision === 'applefm' ? APPLE_FM_REF : a.vision
    };
  });
  ipcMain.handle('nt.models.assignment.set', (_e, task: 'chat' | 'vision', ref: string) => {
    if (task !== 'chat' && task !== 'vision') throw new Error(`Unknown task "${task}"`);
    if (ref !== APPLE_FM_REF && ref !== CLOUD_REF) {
      const entry = catalogEntry(ref);
      if (!entry) throw new Error(`Unknown model "${ref}"`);
      if (!store.d.models.downloaded[ref]) {
        throw new Error(`Model "${entry.name}" is not downloaded yet`);
      }
    }
    store.d.models.assignment[task] = ref;
    store.saveSoon();
  });
  ipcMain.handle('nt.models.applefm', async () => {
    const probe = await appleFm.probe();
    store.d.models.appleFmAvailable = probe.available;
    store.saveSoon();
    return probe;
  });
  ipcMain.handle('nt.models.disk-usage', () => downloader.diskUsage());

  // -- voice engine (local STT/TTS sidecars) -----------------------------------------
  ipcMain.handle('nt.voice.stt-available', (): boolean => {
    return sttModelFile() !== null && whisperBinaryAvailable();
  });
  ipcMain.handle('nt.voice.start-listening', () => {
    voiceEngine.startListening();
  });
  ipcMain.handle('nt.voice.audio-chunk', (_e, data: Uint8Array) => {
    voiceEngine.pushAudio(Buffer.from(data));
  });
  ipcMain.handle('nt.voice.stop-listening', async (): Promise<string> => {
    const text = await voiceEngine.stopListening();
    // Voice-control mode: route the transcript into the brain pipeline.
    if (text && store.d.voice.voiceControl) {
      void orchestrator.handleUtterance(text, 'voice');
    }
    return text;
  });
  ipcMain.handle('nt.voice.cancel-listening', () => {
    voiceEngine.cancelListening();
  });
  ipcMain.handle('nt.voice.speak', async (_e, text: string): Promise<Uint8Array> => {
    const wav = await voiceEngine.speak(text);
    return new Uint8Array(wav);
  });

  // -- brain (Jev System-One orchestration) --------------------------------------
  // The Jev API key lives in the OS keychain via JevCredentialStore and never
  // leaves main: nt.brain.jev.get only reports whether one is configured.
  ipcMain.handle('nt.brain.jev.get', (): JevConfigPublic =>
    ({ configured: jevCreds.hasKey, baseUrl: store.d.brain.jevBaseUrl }));
  ipcMain.handle('nt.brain.jev.set', (_e, input: JevConfigInput): JevConfigPublic => {
    if (typeof input.baseUrl === 'string') {
      store.d.brain.jevBaseUrl = input.baseUrl.trim();
      store.saveSoon();
    }
    if (input.apiKey && input.apiKey.trim()) {
      if (!jevCreds.saveKey(input.apiKey)) {
        throw new Error('OS keychain unavailable — the Jev key was not stored.');
      }
    }
    return { configured: jevCreds.hasKey, baseUrl: store.d.brain.jevBaseUrl };
  });
  ipcMain.handle('nt.brain.jev.test', async () => {
    const r = await jevClient.booleanCheck('connectivity test', 'This is a connectivity test, not a real request');
    return r.ok ? { ok: true, latencyMs: 0 } : { ok: false, error: r.message };
  });
  ipcMain.handle('nt.brain.jev.validate', async (_e, apiKey: string, baseUrl?: string) => {
    // ONE lightweight call with a transient client. The key is never persisted
    // here — the renderer only calls nt.brain.jev.set after explicit Save.
    const probe = new JevClient({ apiKey, baseUrl: baseUrl?.trim() || undefined, timeoutMs: 4000 });
    const r = await probe.booleanCheck('validation probe', 'Is this a validation probe?');
    return r.ok ? { ok: true } : { ok: false, error: r.message };
  });
  ipcMain.handle('nt.brain.utterance', (_e, text: string, source: 'voice' | 'text') => {
    void orchestrator.handleUtterance(text, source).catch((e) =>
      win?.webContents.send('nt.brain.event', { kind: 'error', message: String(e) } satisfies BrainEvent));
  });
}

app.whenReady().then(() => {
  store = new Store();
  tabs = new TabManager(
    store,
    () => sendSnapshot(),
    (d: TabDelta) => win?.webContents.send('nt.tab-delta', d)
  );
  initModelTier();
  registerIpc();
  createWindow();

  // Restore pinned tabs; guarantee at least one tab in the active space.
  tabs.restorePinned();
  ensureSpaceTab(store.d.activeSpaceId);
  const first = [...tabs.tabs.values()].find((t) => t.spaceId === store.d.activeSpaceId);
  if (first) tabs.activate(first.id);
  sendSnapshot();

  // Auto-archive sweep every minute.
  setInterval(() => tabs.sweepIdle(), 60_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  tabs.persistPinned();
  store.saveNow();
  void llama?.stopAll().catch(() => { /* best effort */ });
  app.quit();
});

app.on('before-quit', () => {
  tabs.persistPinned();
  store.saveNow();
  void llama?.stopAll().catch(() => { /* best effort */ });
});
