import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { Store } from './store';
import { TabManager } from './tabs';
import { startAgentRun, cancelAgentRun } from './agent/loop';
import { testConnection } from './agent/llm';
import {
  PROVIDER_PRESETS, DEFAULT_DARK_TOKENS
} from '../shared/ipc';
import type {
  AgentEvent, BrowserSnapshot, ProviderConfigInput, ProviderConfigPublic,
  SpaceState, TabDelta, ThemeTokens
} from '../shared/ipc';

let win: BrowserWindow | null = null;
let settingsOpen = false;
let store: Store;
let tabs: TabManager;

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
  ipcMain.handle('nt.agent.chat', (_e, message: string) => {
    if (!win) throw new Error('No window');
    return startAgentRun(message, { win, tabs, store, emit: emitAgent });
  });
  ipcMain.handle('nt.agent.cancel', (_e, runId: string) => cancelAgentRun(runId));
  ipcMain.handle('nt.agent.history', () => store.d.agentHistory);
  ipcMain.handle('nt.agent.clear-history', () => {
    store.d.agentHistory = [];
    store.saveSoon();
  });

  // -- settings / BYOK -----------------------------------------------------------
  ipcMain.handle('nt.settings.provider.get', (): ProviderConfigPublic => publicProvider());
  ipcMain.handle('nt.settings.provider.set', (_e, input: ProviderConfigInput): ProviderConfigPublic => {
    const preset = PROVIDER_PRESETS.find((x) => x.id === input.presetId);
    store.d.provider = {
      presetId: input.presetId,
      baseUrl: input.baseUrl.trim() || preset?.baseUrl || '',
      model: input.model.trim(),
      api: preset?.api ?? 'openai'
    };
    if (input.apiKey && !store.setApiKey(input.apiKey)) {
      throw new Error('Could not access the OS keychain — the API key was not saved. Provider settings were saved without a key.');
    }
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
  ipcMain.handle('nt.settings.voice.set', (_e, v: { enabled: boolean; speakReplies: boolean }) => {
    store.d.voice = v; store.saveSoon();
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
}

app.whenReady().then(() => {
  store = new Store();
  tabs = new TabManager(
    store,
    () => sendSnapshot(),
    (d: TabDelta) => win?.webContents.send('nt.tab-delta', d)
  );
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
  app.quit();
});

app.on('before-quit', () => {
  tabs.persistPinned();
  store.saveNow();
});
