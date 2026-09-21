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
import { executeControl, runTerminalControl, type ControlEnv } from './brain/control';
import { MODEL_CATALOG, ModelDownloader, targetPathFor, ensureEspeakNgData, type DownloadEvent } from './models';
import { ensureSidecar, whisperManualSteps } from './models/binaries';
import { registerModelsIpc } from './models/ipc';
import { setVisionRef, describeTaskModels } from './models/task-models';
import { setupUpdater, checkForUpdatesManually } from './updater';
import { detectBrowsers, type DetectedBrowser } from './import/browsers';
import { importBookmarks, importTabs, type ImportDeps, type ImportReport } from './import/index';
import { importChromiumPasswords, passwordImportGuidance } from './import/passwords';
import { saveImportedLogins, getStoredLogins } from './import/logins';
import { normalizeUrlKey } from './import/util';
import { LlamaServer } from './models/runtime';
import { AppleFmClient } from './models/applefm';
import { VoiceEngine, type CleanupPrompt } from './voice';
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
/** Last engine state + renderer TTS playback flag (kept for future use). */
let lastVoiceState: string = "idle";
let pillPlaybackSpeaking = false;
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
  // Disk fallback: the file may have been placed manually (or by an older
  // build) without the registry flag. A whisper ggml model is >50 MB —
  // anything matching whisper*.bin at that size is a real model.
  try {
    const found = fs.readdirSync(modelsDir)
      .filter((f) => /^whisper.*\.bin$/i.test(f))
      .map((f) => path.join(modelsDir, f))
      .filter((p) => { try { return fs.statSync(p).size > 50_000_000; } catch { return false; } })
      .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0];
    if (found) {
      // Self-heal the registry so Settings and future lookups agree.
      const id = path.basename(found, '.bin');
      const entry = MODEL_CATALOG.find((e) => e.id === id);
      if (entry && !store.d.models.downloaded[entry.id]) {
        store.d.models.downloaded[entry.id] = { bytes: fs.statSync(found).size, at: Date.now() };
        store.saveSoon();
      }
      return found;
    }
  } catch { /* models dir unreadable */ }
  return null;
}

/** Recursively find the first dir under `root` containing a `.onnx` file. */
function findOnnxDir(root: string, depth = 0): string | null {
  if (depth > 3) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  if (entries.some((f) => f.endsWith('.onnx'))) return root;
  for (const e of entries) {
    const p = path.join(root, e);
    try {
      if (fs.statSync(p).isDirectory()) {
        const hit = findOnnxDir(p, depth + 1);
        if (hit) return hit;
      }
    } catch { /* skip */ }
  }
  return null;
}

/** Absolute path of a downloaded TTS model dir, or null. */
function ttsModelDir(): string | null {
  // The kokoro release tarball extracts one level too deep
  // (<id>/kokoro-en-v0_19/model.onnx), so search recursively.
  const registered = MODEL_CATALOG.find((x) => x.task === 'tts' && store.d.models.downloaded[x.id]);
  if (registered) {
    const hit = findOnnxDir(path.join(modelsDir, registered.id));
    if (hit) return hit;
  }
  // Disk fallback: any dir under models/ holding an .onnx + voices.bin looks
  // like a manually placed Kokoro model — self-heal the registry.
  try {
    for (const e of fs.readdirSync(modelsDir)) {
      const dir = path.join(modelsDir, e);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch { continue; }
      const hit = findOnnxDir(dir);
      if (hit) {
        const entry = MODEL_CATALOG.find((x) => x.task === 'tts' && x.id === e);
        if (entry && !store.d.models.downloaded[entry.id]) {
          store.d.models.downloaded[entry.id] = { bytes: entry.sizeBytes, at: Date.now() };
          store.saveSoon();
        }
        return hit;
      }
    }
  } catch { /* models dir unreadable */ }
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

/**
 * Self-heal Kokoro TTS: make sure espeak-ng-data exists inside the TTS
 * model dir (manually placed models often lack it, which used to kill TTS
 * and trigger the old system-voice fallback). Throws when there is no TTS
 * model or the repair itself fails. A no-op when the data is already there.
 */
async function repairTtsEngine(): Promise<void> {
  const dir = ttsModelDir();
  if (!dir) {
    throw new Error('Voice: no text-to-speech model is downloaded. Download a Kokoro TTS model in Settings → Models first.');
  }
  await ensureEspeakNgData(dir);
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
        lastVoiceState = s;
        // Voice status now lives in the toolbar chip + agent panel — the
        // floating pill window is gone. Main only forwards the state.
      },
      onError: (message: string) => {
        win?.webContents.send('nt.voice-error', message);
      },
    },
    getSttModelFile: sttModelFile,
    getTtsModelDir: ttsModelDir,
    // The speak path awaits the self-heal itself (instead of the old
    // fire-and-forget at voice start), so the first utterance can never race
    // the repair and fail on a missing espeak-ng-data.
    repairTts: repairTtsEngine,
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
          // terminal.run is gated: the exact command + cwd go through
          // runTerminalControl's native confirmation dialog — never
          // executeControl's raw switch.
          (intent, slots) => intent === 'terminal.run'
            ? runTerminalControl(win, slots)
            : executeControl(env, intent, slots),
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
    startAgentRun: async (task: string) => {
      const runId = await startAgentRun(
        task,
        {
          win: win as BrowserWindow,
          tabs,
          store,
          emit: emitAgent,
          router: routerDeps,
          // Voice turn state: thinking while the model reasons, acting while
          // browser tools run, back to idle when the run settles.
          onVoiceState: (s) => voiceEngine.setRunState(s),
          onVisionMissing: nudgeVisionModels
        },
        { voice: true }
      );
      voiceRunIds.add(runId);
      return runId;
    },
    emit: (e: BrainEvent) => {
      win?.webContents.send('nt.brain.event', e);
      if (e.kind === 'vision-missing') {
        // Nudge the model manager: open Settings → Models with the Vision
        // slot highlighted so the user can download a vision model.
        win?.webContents.send('nt.ui.open-models', { task: 'vision' });
      }
    }
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
  // Voice-driven runs are tracked so barge-in can cancel them mid-flight.
  if (e.kind === 'done') voiceRunIds.delete(e.runId);
}

/** Run ids of voice-driven agent runs still in flight (barge-in targets). */
const voiceRunIds = new Set<string>();

/**
 * "Save Image As…" for the guest context menu: prompt for a destination,
 * then download the image through the guest's own session so cookies/auth
 * travel with the request.
 */
async function saveImageAs(wc: WebContents, srcURL: string): Promise<void> {
  if (!win || win.isDestroyed() || wc.isDestroyed()) return;
  let fileName = 'image';
  try {
    const u = new URL(srcURL);
    const base = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (base) fileName = decodeURIComponent(base).split('?')[0] || 'image';
  } catch {
    /* keep the default */
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(fileName)) fileName += '.png';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Image As',
    defaultPath: fileName,
  });
  if (canceled || !filePath) return;
  const ses = wc.session;
  const onDownload = (_e: Electron.Event, item: Electron.DownloadItem) => {
    try {
      item.setSavePath(filePath);
    } catch {
      /* fall back to the default download location */
    }
  };
  ses.once('will-download', onDownload);
  try {
    wc.downloadURL(srcURL);
  } catch {
    ses.removeListener('will-download', onDownload);
  }
}

/**
 * Nudge the model manager: open Settings → Models with the Vision slot
 * highlighted, so the user can download a vision model.
 */
function nudgeVisionModels(): void {
  win?.webContents.send('nt.ui.open-models', { task: 'vision' });
}

/**
 * One voice turn, end to end: the brain owns the transcript, the voice
 * engine mirrors the turn state for the toolbar chip. Fire-and-forget —
 * callers never await this, so the renderer stays responsive while the
 * turn runs. Errors are spoken by the orchestrator itself; anything that
 * escapes becomes a brain error event.
 */
async function runVoiceTurn(text: string, source: 'voice' | 'text'): Promise<void> {
  voiceEngine.setRunState('thinking');
  try {
    await orchestrator.handleUtterance(text, source);
  } finally {
    // Voice agent runs keep driving the state themselves via onVoiceState —
    // only settle here when no voice run is still in flight. Never clears
    // 'speaking' (a reply being spoken) or an active listen.
    if (voiceRunIds.size === 0) voiceEngine.setRunState(null);
  }
}

// -- native ad blocker --------------------------------------------------------
// Public ad-block config for the renderer (no internals leak).
function publicAdBlock(): AdBlockState {
  return {
    enabled: store.d.adblock.enabled !== false,
    allowedHosts: [...store.d.adblock.allowedHosts]
  };
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
    // Explicit window chrome: the window must always be minimizable and must
    // never be created fullscreen/kiosk (a stuck fullscreen window with no
    // minimize button was reported on macOS).
    minimizable: true,
    maximizable: true,
    closable: true,
    fullscreenable: true,
    fullscreen: false,
    kiosk: false,
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

/**
 * Put the active tab's best video into Picture-in-Picture. Picks the
 * currently-playing video first, then the largest visible one. Runs inside
 * the page, so site players (YouTube, etc.) keep working.
 */
async function enterPictureInPicture(): Promise<{ ok: boolean; error?: string }> {
  const wc = tabs.activeWebContents();
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'No active tab.' };
  try {
    const ok = await wc.executeJavaScript(`(() => {
      const vids = [...document.querySelectorAll('video')].filter(v => v.readyState >= 2 && !v.disablePictureInPicture);
      if (!vids.length) return 'none';
      if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return 'toggled-off'; }
      const playing = vids.find(v => !v.paused && !v.ended);
      const scored = (playing ? [playing] : vids).concat(vids.filter(v => v !== playing));
      const best = scored.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
      return best.requestPictureInPicture().then(() => 'ok').catch(e => 'err:' + (e && e.message ? e.message : e));
    })()`);
    if (ok === 'ok') return { ok: true };
    if (ok === 'toggled-off') return { ok: true };
    if (ok === 'none') return { ok: false, error: 'No playable video found on this page.' };
    return { ok: false, error: typeof ok === 'string' && ok.startsWith('err:') ? ok.slice(4) : 'Picture in Picture failed.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Create + (optionally) activate a tab. Rapid same-URL creates are
 * deduped: a single click can reach main through both the
 * setWindowOpenHandler path and the renderer's legacy `new-window`
 * listener, and the link must not open twice.
 */
const recentCreates = new Map<string, number>();
function createTabActivated(
  spaceId: string,
  url: string | undefined,
  activate = true
): string {
  const key = `${spaceId}|${url ?? ''}`;
  const now = Date.now();
  const last = recentCreates.get(key);
  if (last && now - last < 2500) {
    const existing = tabs.orderedTabs(spaceId).find((t) => t.url === url);
    if (existing) {
      if (activate) tabs.activate(existing.id);
      return existing.id;
    }
  }
  recentCreates.set(key, now);
  if (recentCreates.size > 64) {
    const oldest = [...recentCreates.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recentCreates.delete(oldest[0]);
  }
  const t = tabs.create(spaceId, url);
  if (activate) tabs.activate(t.id);
  return t.id;
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
    return createTabActivated(spaceId, opts?.url);
  });
  ipcMain.handle('nt.tabs.close', (_e, tabId: string) => {
    adblocker.noteDetach(tabId);
    tabs.close(tabId);
  });
  ipcMain.handle('nt.tabs.activate', (_e, tabId: string) => tabs.activate(tabId));
  // Picture in Picture for the active tab: the most-likely video element
  // (playing > largest > first) is put into PiP. Chromium handles the
  // floating window; nothing extra to manage in main.
  ipcMain.handle('nt.tabs.pip', async (): Promise<{ ok: boolean; error?: string }> => {
    return enterPictureInPicture();
  });
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

  // -- import from other browsers (explicit user action only) --------------------
  // Keychain items for Chromium-family "Safe Storage" secrets (macOS).
  const KEYCHAIN_ITEMS: Record<string, { service: string; account: string }> = {
    chrome: { service: 'Chrome Safe Storage', account: 'Chrome' },
    brave: { service: 'Brave Safe Storage', account: 'Brave' },
    edge: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    chromium: { service: 'Chromium Safe Storage', account: 'Chromium' },
    arc: { service: 'Arc Safe Storage', account: 'Arc' },
  };

  ipcMain.handle('nt.import.detect', async () => {
    try {
      const found = await detectBrowsers();
      return found.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        profileDir: b.profileDir,
        profileLabel: b.profileLabel,
        accessDenied: !!b.accessDenied,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    'nt.import.run',
    async (_e, browserId: string, kinds: Array<'bookmarks' | 'tabs' | 'passwords'>) => {
      const result: {
        ok: boolean;
        report?: ImportReport;
        accessDeniedPath?: string;
        passwordGuidance?: { title: string; steps: string[] };
        error?: string;
      } = { ok: false };
      try {
        const found = await detectBrowsers();
        const browser = found.find((b) => b.id === browserId);
        if (!browser) {
          result.error = 'That browser is no longer available.';
          return result;
        }
        const baseId = browserId.split(':')[0];
        const spaceId = store.d.activeSpaceId;
        const deps: ImportDeps = {
          spaceId,
          addBookmark: (sid, name, url, folder) => {
            store.addBookmark(sid, name, url, folder);
          },
          createTab: (url) => {
            const t = tabs.create(spaceId, url);
            return t.id;
          },
          pinTab: (tabId) => {
            const t = tabs.tabs.get(tabId);
            if (t) {
              t.pinned = true;
              tabs.persistPinned();
            }
          },
          existingBookmarkUrls: (sid) =>
            new Set(store.listBookmarks(sid).map((b) => normalizeUrlKey(b.url))),
          existingTabUrls: (sid) =>
            new Set(
              [...tabs.tabs.values()]
                .filter((t) => t.spaceId === sid)
                .map((t) => normalizeUrlKey(t.url)),
            ),
        };
        const combined: ImportReport = {
          bookmarksAdded: 0,
          bookmarksSkippedDupes: 0,
          tabsOpened: 0,
          tabsPinned: 0,
          warnings: [],
        };
        const merge = (r: ImportReport) => {
          combined.bookmarksAdded += r.bookmarksAdded;
          combined.bookmarksSkippedDupes += r.bookmarksSkippedDupes;
          combined.tabsOpened += r.tabsOpened;
          combined.tabsPinned += r.tabsPinned;
          for (const w of r.warnings) {
            if (combined.warnings.length < 20) combined.warnings.push(w);
          }
        };
        if (kinds.includes('bookmarks')) merge(await importBookmarks(browserId, deps));
        if (kinds.includes('tabs')) merge(await importTabs(browserId, deps));
        if (kinds.includes('passwords')) {
          if (baseId === 'safari' || baseId === 'firefox') {
            result.passwordGuidance = passwordImportGuidance(baseId);
          } else {
            const kc = KEYCHAIN_ITEMS[baseId];
            if (!kc) {
              combined.warnings.push('Password import is not supported for this browser.');
            } else {
              // The security CLI shows macOS's native consent prompt — the
              // explicit user approval this import requires. Decrypted
              // passwords flow ONLY into the safeStorage vault via
              // onDecrypted; they never cross IPC and are never logged.
              const pw = await importChromiumPasswords({
                profileDir: browser.profileDir,
                keychainService: kc.service,
                keychainAccount: kc.account,
                onDecrypted: async (logins) => {
                  await saveImportedLogins(
                    logins.map((l) => ({ origin: l.origin, username: l.username, password: l.password })),
                    app.getPath('userData'),
                  );
                },
              });
              combined.warnings.push(...pw.warnings.slice(0, 20 - combined.warnings.length));
              if (pw.imported.length > 0 || pw.skipped > 0) {
                combined.warnings.unshift(
                  `Passwords: ${pw.imported.length} imported into the encrypted vault, ${pw.skipped} skipped.`,
                );
              }
            }
          }
        }
        sendSnapshot();
        result.ok = true;
        result.report = combined;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // TCC / file-access denial → renderer shows the macOS access guide.
        if (msg.startsWith('FILE_ACCESS_DENIED:')) {
          result.accessDeniedPath = msg.slice('FILE_ACCESS_DENIED:'.length);
          return result;
        }
        // Never leak internals or paths beyond the access-denied case.
        result.error = 'Import failed. Nothing was changed.';
        return result;
      }
    },
  );

  ipcMain.handle('nt.import.password-guidance', async (_e, browserId: 'safari' | 'firefox') => {
    return passwordImportGuidance(browserId);
  });

  ipcMain.handle('nt.import.logins-count', () => {
    try {
      return getStoredLogins(app.getPath('userData')).length;
    } catch {
      return 0;
    }
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
    const p = startAgentRun(
      message,
      {
        win,
        tabs,
        store,
        emit: emitAgent,
        router: routerDeps,
        // Voice turns drive the toolbar chip (thinking → acting → idle) and
        // nudge the model manager when a vision task finds the slot empty.
        onVoiceState: opts?.voice ? (s) => voiceEngine.setRunState(s) : undefined,
        onVisionMissing: nudgeVisionModels
      },
      opts
    );
    if (opts?.voice) {
      // Track for barge-in cancellation; the 'done' event clears the entry.
      void p.then((runId) => voiceRunIds.add(runId)).catch(() => {});
    }
    return p;
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
    adblocker.refreshConfig();
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
      adblocker.refreshConfig();
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
    if (store.d.models.assignment.vision === id || store.d.models.taskVision === id) {
      // The vision slot never falls back to cloud silently — empty means
      // "download a vision model", raised as a clear notice.
      setVisionRef(store, 'none');
    }
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
    if (ref !== APPLE_FM_REF && ref !== CLOUD_REF && ref !== 'none') {
      const entry = catalogEntry(ref);
      if (!entry) throw new Error(`Unknown model "${ref}"`);
      if (!store.d.models.downloaded[ref]) {
        throw new Error(`Model "${entry.name}" is not downloaded yet`);
      }
    }
    store.d.models.assignment[task] = ref;
    if (task === 'vision') {
      // The vision task slot is the single source of truth (task-models.ts);
      // route the legacy setter through it. 'cloud' is allowed as an explicit
      // opt-in, but it never silently becomes the default.
      setVisionRef(store, ref === CLOUD_REF ? 'cloud' : ref);
    }
    store.saveSoon();
  });
  // Task-model registry: the four task slots and what serves each.
  ipcMain.handle('nt.models.task-models', () => {
    return describeTaskModels(store, store.d.models.appleFmAvailable === true);
  });
  ipcMain.handle('nt.models.set-vision', (_e, ref: string) => {
    setVisionRef(store, ref);
  });
  ipcMain.handle('nt.models.applefm', async () => {
    const probe = await appleFm.probe();
    store.d.models.appleFmAvailable = probe.available;
    store.saveSoon();
    return probe;
  });
  ipcMain.handle('nt.models.disk-usage', () => downloader.diskUsage());
  // Optional HF token for gated repos (safeStorage; registered from models/ipc).
  registerModelsIpc();

  // -- voice engine (local STT/TTS sidecars) -----------------------------------------
  ipcMain.handle('nt.voice.stt-available', (): boolean => {
    return sttModelFile() !== null && whisperBinaryAvailable();
  });
  // Granular STT readiness for the voice guided-setup card: the renderer
  // needs to tell "no model yet" (one-tap download) apart from "model ready
  // but whisper-cli missing" (manual install steps).
  ipcMain.handle('nt.voice.stt-status', () => ({
    model: sttModelFile() !== null,
    binary: whisperBinaryAvailable(),
    binarySteps: whisperManualSteps(binDir),
  }));
  ipcMain.handle('nt.voice.start-listening', () => {
    voiceEngine.startListening();
  });
  // Own the macOS microphone permission prompt from the main process so it
  // is attributed to Next Token. (A renderer getUserMedia prompt can be
  // misattributed to the launching terminal for an unsigned app started
  // from the command line.)
  ipcMain.handle('nt.voice.ensure-mic', async (): Promise<{ granted: boolean }> => {
    if (process.platform !== 'darwin') return { granted: true };
    try {
      const { systemPreferences } = await import('electron');
      if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') {
        return { granted: true };
      }
      return { granted: await systemPreferences.askForMediaAccess('microphone') };
    } catch {
      // If the check itself fails, let the renderer's getUserMedia decide.
      return { granted: true };
    }
  });
  ipcMain.handle('nt.voice.audio-chunk', (_e, data: Uint8Array) => {
    voiceEngine.pushAudio(Buffer.from(data));
  });
  ipcMain.handle('nt.voice.stop-listening', async (): Promise<VoiceTranscript> => {
    // Single dispatch: the transcript is returned to the renderer, which owns
    // routing (fixed commands → runVoiceCommand, voice-control → brain).
    // Main never dispatches here — that used to run every utterance twice.
    return voiceEngine.stopListening();
  });
  ipcMain.handle('nt.voice.cancel-listening', () => {
    voiceEngine.cancelListening();
  });
  ipcMain.handle('nt.voice.speak', async (_e, text: string): Promise<Uint8Array> => {
    const wav = await voiceEngine.speak(text);
    return new Uint8Array(wav);
  });
  // Barge-in: abort in-flight TTS (child killed, queue invalidated), cancel
  // any voice-driven agent run, and return to idle so a new listen can
  // start immediately. No zombie audio or stale replies survive this.
  ipcMain.handle('nt.voice.stop-speaking', () => {
    for (const runId of voiceRunIds) cancelAgentRun(runId);
    voiceRunIds.clear();
    voiceEngine.stopSpeaking();
    // The renderer stops its own audio element; if it was mid-playback it
    // also flips back to listening via the barge-in event below.
    win?.webContents.send('nt:voice-barge-in');
  });
  // Mic amplitude (renderer → main), fire-and-forget at ~15 Hz. The toolbar
  // voice chip consumes it via the main window's nt:voice-amplitude event.
  ipcMain.on('nt.voice.amplitude', (_e, level: number) => {
    if (typeof level === 'number' && Number.isFinite(level)) {
      win?.webContents.send('nt:voice-amplitude', Math.max(0, Math.min(1, level)));
    }
  });
  // Renderer TTS playback state (drives the toolbar voice chip).
  ipcMain.on('nt.voice.playback-started', () => {
    pillPlaybackSpeaking = true;
    win?.webContents.send('nt:voice-playback-state', true);
  });
  ipcMain.on('nt.voice.playback-ended', () => {
    pillPlaybackSpeaking = false;
    win?.webContents.send('nt:voice-playback-state', false);
  });
  // Self-heal Kokoro TTS: make sure espeak-ng-data exists inside the TTS
  // model dir (manually placed models often lack it, which used to kill
  // TTS and trigger the old system-voice fallback). Best-effort.
  ipcMain.handle('nt.voice.repair-tts', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await repairTtsEngine();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Undo the last in-page voice dictation (the renderer's "⌘Z to undo" toast).
  ipcMain.handle('nt.voice.dictate-undo', async (): Promise<boolean> => {
    const d = lastDictation;
    if (!d || Date.now() - d.at > 5 * 60 * 1000) return false;
    const tab = tabs.tabs.get(d.tabId);
    if (!tab) return false;
    // Undo in the tab that received the dictation, not whatever is active now.
    const wc = (tab.wc && !tab.wc.isDestroyed()) ? tab.wc : tabs.activeWebContents();
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
    // Fire-and-forget: runVoiceTurn owns the turn's voice state and the
    // orchestrator speaks its own errors — the renderer never blocks here.
    void runVoiceTurn(text, source).catch((e) =>
      win?.webContents.send('nt.brain.event', { kind: 'error', message: String(e) } satisfies BrainEvent));
  });
}

// Single instance: launching the app a second time (Finder double-click,
// Spotlight, or a stray Terminal invocation while an instance already runs)
// must NOT spawn a duplicate app process with its own window — it focuses
// the existing window instead. (A duplicate instance was reported as
// "voice mode opens a new window of the app".)
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });
}

app.whenReady().then(() => {
  // The app must always appear in the macOS dock as the active app, with a
  // working Quit. No code path hides the dock icon, but an instance started
  // outside LaunchServices (e.g. from a Terminal during debugging) can leave
  // the dock in a confused state — this call is a no-op when already shown.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.show();
    } catch {
      /* dock already visible */
    }
  }
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
      // target=_blank / window.open / cmd+click from a guest page:
      // open a real tab in the source tab's Bit (foreground unless the
      // page asked for a background tab). Nothing is ever silently dropped.
      onPopup: (sourceTab, url, disposition) => {
        createTabActivated(sourceTab.spaceId, url, disposition !== 'background-tab');
      },
      // Full right-click context menu for guest content. Electron gives
      // webviews no menu by default, so we build the standard one here:
      // navigation, link actions, image actions, video actions, editing,
      // and Inspect Element. Edit commands go to the GUEST webContents
      // (wc.copy() etc.) — menu-item roles would hit the main window.
      onContextMenu: (wc: WebContents, params) => {
        if (!win || win.isDestroyed()) return;
        const items: Electron.MenuItemConstructorOptions[] = [];

        // -- navigation -------------------------------------------------
        items.push(
          { label: 'Back', enabled: wc.canGoBack(), click: () => { try { wc.goBack(); } catch { /* noop */ } } },
          { label: 'Forward', enabled: wc.canGoForward(), click: () => { try { wc.goForward(); } catch { /* noop */ } } },
          { label: 'Reload', click: () => { try { wc.reload(); } catch { /* noop */ } } },
        );

        // -- link -------------------------------------------------------
        if (params.linkURL) {
          const linkURL = params.linkURL;
          items.push(
            { type: 'separator' },
            {
              label: 'Open Link in New Tab',
              click: () => createTabActivated(store.d.activeSpaceId, linkURL, true)
            },
            { label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) }
          );
        }

        // -- image ------------------------------------------------------
        const isImage = params.mediaType === 'image' || params.hasImageContents;
        if (isImage && params.srcURL) {
          const srcURL = params.srcURL;
          items.push(
            { type: 'separator' },
            {
              label: 'Copy Image',
              // Copies the image under the cursor to the clipboard.
              click: () => { try { wc.copyImageAt(params.x, params.y); } catch { /* noop */ } }
            },
            {
              label: 'Save Image As…',
              click: () => void saveImageAs(wc, srcURL)
            }
          );
        }

        // -- video ------------------------------------------------------
        if (params.mediaType === 'video' && params.srcURL) {
          const srcURL = params.srcURL;
          items.push(
            { type: 'separator' },
            {
              label: 'Picture in Picture',
              click: () => void enterPictureInPicture(),
            },
            { label: 'Copy Video Address', click: () => clipboard.writeText(srcURL) },
            {
              label: 'Open Video in New Tab',
              click: () => createTabActivated(store.d.activeSpaceId, srcURL, true)
            }
          );
        }

        // -- editing ----------------------------------------------------
        const flags = params.editFlags ?? {};
        const canEdit = params.isEditable;
        const hasSelection = !!params.selectionText;
        if (canEdit || hasSelection) {
          items.push({ type: 'separator' });
          if (canEdit && flags.canCut) {
            items.push({ label: 'Cut', click: () => { try { wc.cut(); } catch { /* noop */ } } });
          }
          if (flags.canCopy || hasSelection) {
            items.push({ label: 'Copy', click: () => { try { wc.copy(); } catch { /* noop */ } } });
          }
          if (canEdit && flags.canPaste) {
            items.push({ label: 'Paste', click: () => { try { wc.paste(); } catch { /* noop */ } } });
          }
          items.push({ label: 'Select All', click: () => { try { wc.selectAll(); } catch { /* noop */ } } });
        }

        // -- devtools ---------------------------------------------------
        items.push(
          { type: 'separator' },
          {
            label: 'Inspect Element',
            click: () => { try { wc.inspectElement(params.x, params.y); } catch { /* noop */ } }
          }
        );

        Menu.buildFromTemplate(items).popup({ window: win });
      }
    }
  );
  initModelTier();
  registerIpc();
  setupUpdater();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Check for updates…',
            click: () => void checkForUpdatesManually(),
          },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: () => {
              settingsOpen = true;
              sendSnapshot();
            },
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
      },
    ]),
  );
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
