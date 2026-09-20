import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import type { WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { TabManager } from './tabs';
import { AdBlocker } from './adblock';
import { startAgentRun, cancelAgentRun } from './agent/loop';
import { APPLE_FM_REF, CLOUD_REF, type RouterDeps } from './agent/router';
import { ModelRouter } from './models/router';
import { snapshotPage, formatSnapshot } from './agent/perceive';
import { JevClient } from './brain/jev';
import { JevCredentialStore } from './brain/credentials';
import { Orchestrator, createRouterChat, type BrainPageState } from './brain/orchestrator';
import { executeControl, type ControlEnv } from './brain/control';
import { MODEL_CATALOG, ModelDownloader, targetPathFor, type DownloadEvent } from './models';
import { ensureSidecar } from './models/binaries';
import { LlamaServer } from './models/runtime';
import { AppleFmClient } from './models/applefm';
import { VoiceEngine, type CleanupPrompt } from './voice';
import { VoicePillOverlay } from './voice/overlay';
import { wrapWithActing, dictateUndoJs, type LastDictation } from './voice/acting';
import { buildTidyPlan, applyTidy } from './tidy';
import {
  PROVIDER_PRESETS, DEFAULT_DARK_TOKENS
} from '../shared/ipc';
import type {
  ActiveModelRef, AdBlockState, AdBlockStats, AgentEvent, BookmarkState, BrainEvent, BrowserSnapshot, ChatSession, JevConfigInput, JevConfigPublic, ModelAssignment,
  ModelChoice, ModelEntryPublic, ModelEvent, ProviderId, ProviderInput, ProviderPublic, ProviderValidateInput, SkillDef, SkillInput, SpaceState,
  TabDelta, ThemeTokens, TidyActions, TidyPlan, VoiceEngineState, VoiceSettings, VoiceTranscript
} from '../shared/ipc';

let win: BrowserWindow | null = null;
let settingsOpen = false;
let store: Store;
let tabs: TabManager;
let adblocker: AdBlocker;

// -- local-model tier ---------------------------------------------------------
let modelsDir = '';
let binDir = '';
let downloader: ModelDownloader;
let llama: LlamaServer;
let appleFm: AppleFmClient;
let voiceEngine: VoiceEngine;
/** Floating voice pill overlay (created lazily on first voice activity). */
let pill: VoicePillOverlay | null = null;
/** Last in-page voice dictation, for ⌘Z-style undo. */
let lastDictation: LastDictation | null = null;
let routerDeps: RouterDeps;
/** The unified model router — every LLM call in the app goes through this. */
let modelRouter: ModelRouter;
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

/** Lazily create the floating voice pill overlay window. */
function ensurePill(): void {
  if (pill) return;
  pill = new VoicePillOverlay({
    getPreload: () => path.join(__dirname, '../preload/index.js'),
    getUrl: () =>
      process.env.ELECTRON_RENDERER_URL
        ? { url: process.env.ELECTRON_RENDERER_URL, isFile: false }
        : { url: path.join(__dirname, '../renderer/index.html'), isFile: true },
  });
  pill.ensure();
}

/** Flow's dictation cleanup prompts (MIT — see THIRD-PARTY-NOTICES.md). Cached after first load. */
let cleanupPrompts: CleanupPrompt | null | undefined;
function loadCleanupPrompts(): CleanupPrompt | null {
  if (cleanupPrompts !== undefined) return cleanupPrompts;
  cleanupPrompts = null;
  try {
    const dir = app.isPackaged
      ? path.join(process.resourcesPath, 'prompts')
      : path.join(app.getAppPath(), 'resources', 'prompts');
    const system = fs.readFileSync(path.join(dir, 'dictation-system.txt'), 'utf8').trim();
    const fewShot = JSON.parse(
      fs.readFileSync(path.join(dir, 'dictation-few-shot.json'), 'utf8'),
    ) as Array<{ role: string; content: string }>;
    if (system && Array.isArray(fewShot) && fewShot.length > 0) {
      cleanupPrompts = {
        system,
        fewShot: fewShot
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      };
    }
  } catch {
    /* prompts unavailable — the cleanup pass falls back to quick-clean only */
  }
  return cleanupPrompts;
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
      onState: (s: VoiceEngineState) => {
        win?.webContents.send('nt.voice-engine-state', s);
        // The pill owns its visibility policy (it stays up during TTS
        // playback even after the engine returns to idle); main only
        // forwards events and ensures the window exists while active.
        if (s !== 'idle') {
          ensurePill();
          pill?.show();
          pill?.setClickMode(s === 'speaking' ? 'interactive' : 'through');
        }
        pill?.send('nt.voice-engine-state', s);
      },
      onError: (message: string) => {
        win?.webContents.send('nt.voice-error', message);
        ensurePill();
        pill?.show();
        pill?.setClickMode('interactive');
        pill?.send('nt.voice-error', message);
      },
    },
    getSttModelFile: sttModelFile,
    getTtsModelDir: ttsModelDir,
    getCleanupConfig: () => ({
      enabled: store.d.voice.cleanupEnabled,
      quickCleanMaxWords: store.d.voice.quickCleanMaxWords,
      prompts: loadCleanupPrompts(),
    }),
  });
  routerDeps = { store, appleFm, llama };
  modelRouter = new ModelRouter(routerDeps);
  // The cleanup pass uses the active model (with the router's fallback chain).
  voiceEngine.setCleanupComplete(async (messages) => {
    const r = await modelRouter.complete({ messages, task: 'chat' });
    return r.text;
  });

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
    control: {
      execute: (() => {
        const env = brainControlEnv();
        return wrapWithActing(
          env,
          (intent, slots) => executeControl(env, intent, slots),
          (channel, payload) => {
            // The renderer's AgentActingOverlay + Steps list consume these.
            win?.webContents.send(channel, payload);
          },
          (d) => {
            lastDictation = d;
            // Toast data for the viewport overlay ("N words dictated — ⌘Z to undo").
            win?.webContents.send('nt:voice-dictated', { tabId: d.tabId, chars: d.chars });
          },
        );
      })(),
    },
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

/** Push the active model to the renderer (Agent tab switcher stays in sync). */
function emitActiveModel() {
  win?.webContents.send('nt.model-active-changed', { ...store.d.models.activeModel });
}

function needsKeyFor(presetId: ProviderId): boolean {
  return PROVIDER_PRESETS.find((x) => x.id === presetId)?.needsKey ?? true;
}

/** What the renderer may see — keys never leave main. */
function publicProviders(): ProviderPublic[] {
  return store.d.providers.map((p) => ({
    id: p.id,
    presetId: p.presetId,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    api: p.api,
    enabled: p.enabled,
    keyConfigured: store.providerKeyConfigured(p.id),
    needsKey: needsKeyFor(p.presetId)
  }));
}

function snapshot(): BrowserSnapshot {
  const d = store.d;
  const spaces: SpaceState[] = d.spaces.map((s) => {
    const stabs = tabs.orderedTabs(s.id);
    // Per-Bit last-active tab (falls back to the first tab).
    const activeInSpace = tabs.lastActiveTabId(s.id);
    return {
      id: s.id,
      name: s.name,
      accent: store.themeFor(s.id).spaceColor,
      tabs: stabs.map((t) => tabs.toState(t)),
      activeTabId: activeInSpace,
      favorites: s.favorites,
      folders: s.folders.map((f) => ({ id: f.id, name: f.name })),
      bookmarks: s.bookmarks.map((b) => ({
        id: b.id,
        name: b.name,
        url: b.url,
        // Refresh from the favicon cache so bookmarks pick up icons seen since they were saved.
        favicon: tabs.faviconFor(b.url),
        createdAt: b.createdAt
      }))
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

// -- native ad blocker --------------------------------------------------------
// Public ad-block config for the renderer (no internals leak).
function publicAdBlock(): AdBlockState {
  return {
    enabled: store.d.adblock.enabled !== false,
    allowedHosts: [...store.d.adblock.allowedHosts]
  };
}

// -- floating picture-in-picture ---------------------------------------------
// Toggle Chromium's native PiP for the video at srcUrl in the guest page.
// Chromium's native PiP window is a system overlay and stays on top of
// other windows by design. A context-menu click counts as a user gesture,
// so requestPictureInPicture() is allowed here.
function pipToggle(wc: WebContents, srcUrl: string): void {
  const code = `(async () => {
    var src = ${JSON.stringify(srcUrl)};
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    var v = null;
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].currentSrc === src || vids[i].src === src) { v = vids[i]; break; }
    }
    if (!v) v = vids[0] || null;
    if (!v) return 'no-video';
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return 'exited';
      }
      if (v.disablePictureInPicture || !document.pictureInPictureEnabled) return 'unavailable';
      await v.requestPictureInPicture();
      return 'entered';
    } catch (e) {
      return 'error:' + String((e && e.message) || e);
    }
  })()`;
  void wc.executeJavaScript(code, true).catch(() => {});
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
  ipcMain.handle('nt.tabs.close', (_e, tabId: string) => {
    adblocker.noteDetach(tabId);
    tabs.close(tabId);
  });
  ipcMain.handle('nt.tabs.activate', (_e, tabId: string) => tabs.activate(tabId));
  ipcMain.handle('nt.tabs.pin', (_e, tabId: string, pinned: boolean) => {
    const t = tabs.tabs.get(tabId);
    if (t) { t.pinned = pinned; tabs.persistPinned(); sendSnapshot(); }
  });
  ipcMain.handle('nt.tabs.reorder', (_e, tabId: string, beforeTabId: string | null, folderId: string | null) => {
    tabs.reorder(tabId, beforeTabId, folderId);
  });
  ipcMain.handle('nt.tabs.set-folder', (_e, tabId: string, folderId: string | null) => {
    tabs.setFolder(tabId, folderId);
    sendSnapshot();
  });
  ipcMain.handle('nt.tabs.move', (_e, tabId: string, spaceId: string) => {
    tabs.moveToSpace(tabId, spaceId);
    sendSnapshot();
  });
  ipcMain.handle('nt.tabs.attach', (_e, tabId: string, wcId: number) => {
    const tab = tabs.attach(tabId, wcId);
    if (tab) adblocker.noteAttach(tabId, wcId, tab.url);
  });
  ipcMain.handle('nt.tabs.archive', (_e, tabId: string) => {
    adblocker.noteDetach(tabId);
    tabs.archive(tabId, true);
  });
  ipcMain.handle('nt.tabs.restore', (_e, archivedId: string) => tabs.restore(archivedId));

  // -- navigation ----------------------------------------------------------
  ipcMain.handle('nt.nav.go', (_e, raw: string) => tabs.go(raw));
  ipcMain.handle('nt.nav.back', () => tabs.back());
  ipcMain.handle('nt.nav.forward', () => tabs.forward());
  ipcMain.handle('nt.nav.reload', () => tabs.reload());
  ipcMain.handle('nt.nav.stop', () => tabs.stop());

  // -- spaces (user-facing name: Bits) ------------------------------------------
  ipcMain.handle('nt.spaces.create', (_e, name: string) => {
    const s = store.addSpace(name || 'New Bit');
    ensureSpaceTab(s.id);
    return s.id;
  });
  ipcMain.handle('nt.spaces.switch', (_e, id: string) => {
    if (!store.d.spaces.some((s) => s.id === id)) return;
    store.d.activeSpaceId = id;
    store.saveSoon();
    ensureSpaceTab(id);
    // Restore the tab that was active last time this Bit was open.
    const lastId = tabs.lastActiveTabId(id);
    if (lastId) tabs.activate(lastId);
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
  ipcMain.handle('nt.spaces.delete', (_e, id: string) => {
    if (!store.d.spaces.some((s) => s.id === id)) return;
    if (store.d.spaces.length <= 1) throw new Error('You need at least one Bit.');
    // Every tab goes to the Archive first — deleting a Bit never loses tabs.
    tabs.archiveSpaceTabs(id);
    store.deleteSpace(id);
    ensureSpaceTab(store.d.activeSpaceId);
    const first = [...tabs.tabs.values()].find((t) => t.spaceId === store.d.activeSpaceId);
    if (first) tabs.activate(first.id);
    else sendSnapshot();
  });

  // -- folders (per Bit) -------------------------------------------------------
  ipcMain.handle('nt.folders.create', (_e, spaceId: string, name: string) => {
    const f = store.addFolder(spaceId, name);
    sendSnapshot();
    return { id: f.id, name: f.name };
  });
  ipcMain.handle('nt.folders.rename', (_e, spaceId: string, folderId: string, name: string) => {
    store.renameFolder(spaceId, folderId, name);
    sendSnapshot();
  });
  ipcMain.handle('nt.folders.remove', (_e, spaceId: string, folderId: string) => {
    store.removeFolder(spaceId, folderId);
    tabs.clearFolder(spaceId, folderId);
    sendSnapshot();
  });

  // -- bookmarks (per Bit) ------------------------------------------------------
  ipcMain.handle('nt.bookmarks.add', (_e, spaceId: string, name: string, url: string): BookmarkState[] => {
    const list = store.addBookmark(spaceId, name, url);
    sendSnapshot();
    return list;
  });
  ipcMain.handle('nt.bookmarks.rename', (_e, spaceId: string, id: string, name: string): BookmarkState[] => {
    const list = store.renameBookmark(spaceId, id, name);
    sendSnapshot();
    return list;
  });
  ipcMain.handle('nt.bookmarks.remove', (_e, spaceId: string, id: string): BookmarkState[] => {
    const list = store.removeBookmark(spaceId, id);
    sendSnapshot();
    return list;
  });

  // -- AI tidy (local models only — tab URLs never leave the device) -------------
  ipcMain.handle('nt.tidy.plan', async (_e, spaceId: string): Promise<TidyPlan> => {
    return buildTidyPlan(store, tabs, modelRouter, spaceId);
  });
  ipcMain.handle('nt.tidy.apply', (_e, spaceId: string, actions: TidyActions) => {
    applyTidy(store, tabs, spaceId, actions);
    sendSnapshot();
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

  // -- BYOK providers (provider manager: multiple API gateway providers) -----------
  ipcMain.handle('nt.providers.list', (): ProviderPublic[] => publicProviders());
  ipcMain.handle('nt.providers.save', (_e, input: ProviderInput): ProviderPublic[] => {
    const preset = PROVIDER_PRESETS.find((x) => x.id === input.presetId);
    if (!preset) throw new Error(`Unknown provider preset "${input.presetId}"`);
    const id = input.id ?? randomUUID();
    const existing = store.d.providers.find((p) => p.id === id);
    if (!existing && input.id) throw new Error('Provider not found.');
    // Save the key FIRST so a keychain failure leaves prior settings untouched.
    const apiKey = (input.apiKey ?? '').trim();
    if (apiKey && !store.setProviderKey(id, apiKey)) {
      throw new Error('Could not access the OS keychain — the API key was not saved, and provider settings were left unchanged.');
    }
    const rec = {
      id,
      presetId: input.presetId,
      name: input.name.trim() || preset.name,
      baseUrl: input.baseUrl.trim() || preset.baseUrl,
      model: input.model.trim(),
      api: input.api ?? preset.api,
      enabled: existing ? !!input.enabled : (input.enabled ?? true),
      createdAt: existing?.createdAt ?? Date.now()
    };
    if (existing) Object.assign(existing, rec);
    else store.d.providers.push(rec);
    store.saveSoon();
    return publicProviders();
  });
  ipcMain.handle('nt.providers.remove', (_e, id: string): ProviderPublic[] => {
    const i = store.d.providers.findIndex((p) => p.id === id);
    if (i === -1) throw new Error('Provider not found.');
    store.d.providers.splice(i, 1);
    store.removeProviderKey(id);
    // If the deleted provider was the active model, fall to the next enabled provider.
    const active = store.d.models.activeModel;
    if (active?.kind === 'cloud' && active.id === id) {
      const next = store.d.providers.find((p) => p.enabled);
      store.d.models.activeModel = next ? { kind: 'cloud', id: next.id } : { kind: 'local-applefm' };
      emitActiveModel();
    }
    store.saveSoon();
    return publicProviders();
  });
  ipcMain.handle('nt.providers.set-enabled', (_e, id: string, enabled: boolean): ProviderPublic[] => {
    const p = store.d.providers.find((x) => x.id === id);
    if (!p) throw new Error('Provider not found.');
    p.enabled = !!enabled;
    store.saveSoon();
    return publicProviders();
  });
  ipcMain.handle('nt.providers.validate', async (_e, input: ProviderValidateInput) => {
    return modelRouter.validateProvider(input);
  });

  // -- unified model routing --------------------------------------------------
  ipcMain.handle('nt.models.choices', (): Promise<ModelChoice[]> => modelRouter.listChoices());
  ipcMain.handle('nt.models.active.get', (): ActiveModelRef => modelRouter.getActive());
  ipcMain.handle('nt.models.active.set', (_e, ref: ActiveModelRef): ActiveModelRef => {
    const saved = modelRouter.setActive(ref);
    emitActiveModel();
    return saved;
  });
  ipcMain.handle('nt.settings.voice.get', () => store.d.voice);
  ipcMain.handle('nt.settings.voice.set', (_e, v: Partial<VoiceSettings>) => {
    store.d.voice = {
      enabled: v.enabled ?? store.d.voice.enabled,
      speakReplies: v.speakReplies ?? store.d.voice.speakReplies,
      voiceControl: v.voiceControl ?? store.d.voice.voiceControl,
      cleanupEnabled: v.cleanupEnabled ?? store.d.voice.cleanupEnabled,
      quickCleanMaxWords:
        typeof v.quickCleanMaxWords === 'number' && v.quickCleanMaxWords > 0
          ? Math.floor(v.quickCleanMaxWords)
          : store.d.voice.quickCleanMaxWords,
      micDeviceId: typeof v.micDeviceId === 'string' ? v.micDeviceId : store.d.voice.micDeviceId,
    };
    store.saveSoon();
  });
  ipcMain.handle('nt.settings.search-engine.get', () => store.d.searchEngine);
  // -- native ad blocker --------------------------------------------------
  ipcMain.handle('nt.adblock.get', (): AdBlockState => publicAdBlock());
  ipcMain.handle('nt.adblock.set-enabled', (_e, enabled: boolean): AdBlockState => {
    store.d.adblock.enabled = !!enabled;
    store.saveSoon();
    return publicAdBlock();
  });
  ipcMain.handle('nt.adblock.set-site-allowed', (_e, host: string, allowed: boolean): AdBlockState => {
    const h = String(host ?? '').trim().toLowerCase();
    if (h) {
      const list = store.d.adblock.allowedHosts;
      const i = list.indexOf(h);
      if (allowed && i === -1) list.push(h);
      if (!allowed && i !== -1) list.splice(i, 1);
      store.saveSoon();
    }
    return publicAdBlock();
  });
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
    const active = store.d.models.activeModel;
    if (active?.kind === 'local' && active.id === id) {
      store.d.models.activeModel = { kind: 'local-applefm' };
      emitActiveModel();
    }
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
  ipcMain.handle('nt.voice.stop-listening', async (): Promise<VoiceTranscript> => {
    const result = await voiceEngine.stopListening();
    // Voice-control mode: route the transcript into the brain pipeline,
    // with the "thinking" state driving the pill + panel while it works.
    if (result.text && store.d.voice.voiceControl) {
      voiceEngine.setThinking(true);
      try {
        await orchestrator.handleUtterance(result.text, 'voice');
      } finally {
        voiceEngine.setThinking(false);
      }
    }
    return result;
  });
  ipcMain.handle('nt.voice.cancel-listening', () => {
    voiceEngine.cancelListening();
  });
  ipcMain.handle('nt.voice.speak', async (_e, text: string): Promise<Uint8Array> => {
    const wav = await voiceEngine.speak(text);
    return new Uint8Array(wav);
  });
  // Barge-in: stop TTS at once so a new listen can start immediately.
  ipcMain.handle('nt.voice.stop-speaking', () => {
    voiceEngine.stopSpeaking();
    // The renderer stops its own audio element; if it was mid-playback it
    // also flips back to listening via the barge-in event below.
    win?.webContents.send('nt:voice-barge-in');
  });
  // Mic amplitude (renderer → main → pill), fire-and-forget at ~15 Hz.
  ipcMain.on('nt.voice.amplitude', (_e, level: number) => {
    if (typeof level === 'number' && Number.isFinite(level)) {
      pill?.send('nt:voice-amplitude', Math.max(0, Math.min(1, level)));
    }
  });
  // Renderer TTS playback state (drives the pill's speaking UI).
  ipcMain.on('nt.voice.playback-started', () => {
    ensurePill();
    pill?.show();
    pill?.setClickMode('interactive');
    pill?.send('nt:voice-playback-state', true);
    win?.webContents.send('nt:voice-playback-state', true);
  });
  ipcMain.on('nt.voice.playback-ended', () => {
    pill?.send('nt:voice-playback-state', false);
    win?.webContents.send('nt:voice-playback-state', false);
  });
  // Undo the last in-page voice dictation (the renderer's "⌘Z to undo" toast).
  ipcMain.handle('nt.voice.dictate-undo', async (): Promise<boolean> => {
    const d = lastDictation;
    if (!d || Date.now() - d.at > 5 * 60 * 1000) return false;
    const tab = tabs.tabs.get(d.tabId);
    if (!tab) return false;
    const wc = tabs.activeWebContents();
    if (!wc) return false;
    try {
      const ok = await wc.executeJavaScript(dictateUndoJs(d.chars));
      if (ok) lastDictation = null;
      return ok === true;
    } catch {
      return false;
    }
  });
  // "Take over" — the user halts the voice-driven agent mid-action.
  ipcMain.handle('nt.voice.takeover', async () => {
    win?.webContents.send('nt:voice-takeover');
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
  // Native ad blocker: filter guest traffic at the network layer. Stats are
  // pushed to the renderer for the toolbar shield badge.
  adblocker = new AdBlocker(store, (s: AdBlockStats) => {
    win?.webContents.send('nt.adblock.stats', s);
  });
  adblocker.attach();
  tabs = new TabManager(
    store,
    () => sendSnapshot(),
    (d: TabDelta) => {
      // Keep the ad blocker's page context + per-page counter in sync.
      if (d.type === 'url') adblocker.noteNavigation(d.tabId, String(d.value));
      // A navigation changes the restorable session — persist it (debounced).
      if (d.type === 'url') tabs.persistSessionSoon();
      win?.webContents.send('nt.tab-delta', d);
    },
    {
      // Right-click on a video: offer floating picture-in-picture.
      onContextMenu: (wc: WebContents, params) => {
        if (params.mediaType !== 'video' || !params.srcURL) return;
        const srcURL = params.srcURL;
        const menu = Menu.buildFromTemplate([
          {
            label: 'Picture in picture',
            click: () => pipToggle(wc, srcURL)
          },
          { type: 'separator' },
          {
            label: 'Copy video address',
            click: () => clipboard.writeText(srcURL)
          },
          {
            label: 'Open video in new tab',
            click: () => {
              const t = tabs.create(store.d.activeSpaceId, srcURL);
              tabs.activate(t.id);
            }
          }
        ]);
        menu.popup({ window: win ?? undefined });
      }
    }
  );
  initModelTier();
  registerIpc();
  createWindow();

  // Restore pinned tabs + last session's open tabs; guarantee at least one tab in the active space.
  tabs.restorePinned();
  tabs.restoreSessions();
  ensureSpaceTab(store.d.activeSpaceId);
  const firstId = tabs.lastActiveTabId(store.d.activeSpaceId);
  if (firstId) tabs.activate(firstId);
  sendSnapshot();

  // Auto-archive sweep every minute.
  setInterval(() => tabs.sweepIdle(), 60_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  tabs.persistPinned();
  tabs.persistSession();
  tabs.saveFaviconCacheNow();
  store.saveNow();
  void llama?.stopAll().catch(() => { /* best effort */ });
  app.quit();
});

app.on('before-quit', () => {
  // before-quit fires before windows close — the reliable place to capture
  // the session (window-all-closed may not run on every quit path).
  tabs.persistPinned();
  tabs.persistSession();
  tabs.saveFaviconCacheNow();
  store.saveNow();
  void llama?.stopAll().catch(() => { /* best effort */ });
});
