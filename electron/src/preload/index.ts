import { contextBridge, ipcRenderer } from 'electron';
import type { NextTokenAPI } from '../shared/ipc';

const api: NextTokenAPI = {
  // tabs
  tabsCreate: (opts) => ipcRenderer.invoke('nt.tabs.create', opts),
  tabsClose: (tabId) => ipcRenderer.invoke('nt.tabs.close', tabId),
  tabsActivate: (tabId) => ipcRenderer.invoke('nt.tabs.activate', tabId),
  tabsPin: (tabId, pinned) => ipcRenderer.invoke('nt.tabs.pin', tabId, pinned),
  tabsMove: (tabId, spaceId) => ipcRenderer.invoke('nt.tabs.move', tabId, spaceId),
  tabsAttach: (tabId, webContentsId) => ipcRenderer.invoke('nt.tabs.attach', tabId, webContentsId),
  tabsArchive: (tabId) => ipcRenderer.invoke('nt.tabs.archive', tabId),
  tabsRestore: (archivedId) => ipcRenderer.invoke('nt.tabs.restore', archivedId),
  // navigation
  navGo: (raw) => ipcRenderer.invoke('nt.nav.go', raw),
  navBack: () => ipcRenderer.invoke('nt.nav.back'),
  navForward: () => ipcRenderer.invoke('nt.nav.forward'),
  navReload: () => ipcRenderer.invoke('nt.nav.reload'),
  navStop: () => ipcRenderer.invoke('nt.nav.stop'),
  // spaces
  spacesCreate: (name) => ipcRenderer.invoke('nt.spaces.create', name),
  spacesSwitch: (id) => ipcRenderer.invoke('nt.spaces.switch', id),
  spacesRename: (id, name) => ipcRenderer.invoke('nt.spaces.rename', id, name),
  spacesSetAccent: (id, accent) => ipcRenderer.invoke('nt.spaces.set-accent', id, accent),
  spacesAddFavorite: (spaceId, name, url) => ipcRenderer.invoke('nt.spaces.add-favorite', spaceId, name, url),
  spacesRemoveFavorite: (spaceId, favId) => ipcRenderer.invoke('nt.spaces.remove-favorite', spaceId, favId),
  // ui
  uiSetSidebarCollapsed: (c) => ipcRenderer.invoke('nt.ui.sidebar-collapsed', c),
  uiSetAgentPanelOpen: (o) => ipcRenderer.invoke('nt.ui.agent-panel', o),
  uiSetSettingsOpen: (o) => ipcRenderer.invoke('nt.ui.settings-open', o),
  // agent
  agentChat: (message, opts) => ipcRenderer.invoke('nt.agent.chat', message, opts),
  agentCancel: (runId) => ipcRenderer.invoke('nt.agent.cancel', runId),
  agentHistory: () => ipcRenderer.invoke('nt.agent.history'),
  agentClearHistory: () => ipcRenderer.invoke('nt.agent.clear-history'),
  agentNewChat: () => ipcRenderer.invoke('nt.agent.new-chat'),
  agentSessions: () => ipcRenderer.invoke('nt.agent.sessions'),
  agentOpenSession: (id) => ipcRenderer.invoke('nt.agent.open-session', id),
  // skills
  skillsList: () => ipcRenderer.invoke('nt.skills.list'),
  skillsSave: (skill) => ipcRenderer.invoke('nt.skills.save', skill),
  skillsRemove: (id) => ipcRenderer.invoke('nt.skills.remove', id),
  skillsReset: () => ipcRenderer.invoke('nt.skills.reset'),
  // BYOK providers — the provider manager (multiple API gateway providers)
  providersList: () => ipcRenderer.invoke('nt.providers.list'),
  providersSave: (input) => ipcRenderer.invoke('nt.providers.save', input),
  providersRemove: (id) => ipcRenderer.invoke('nt.providers.remove', id),
  providersSetEnabled: (id, enabled) => ipcRenderer.invoke('nt.providers.set-enabled', id, enabled),
  providersValidate: (input) => ipcRenderer.invoke('nt.providers.validate', input),
  // unified model routing — the active model drives every LLM call
  modelsChoices: () => ipcRenderer.invoke('nt.models.choices'),
  modelsGetActive: () => ipcRenderer.invoke('nt.models.active.get'),
  modelsSetActive: (ref) => ipcRenderer.invoke('nt.models.active.set', ref),
  onActiveModel: (cb) => {
    const l = (_e: unknown, ref: Parameters<Parameters<NextTokenAPI['onActiveModel']>[0]>[0]) => cb(ref);
    ipcRenderer.on('nt.model-active-changed', l);
    return () => ipcRenderer.removeListener('nt.model-active-changed', l);
  },
  settingsGetVoice: () => ipcRenderer.invoke('nt.settings.voice.get'),
  settingsSetVoice: (v) => ipcRenderer.invoke('nt.settings.voice.set', v),
  settingsGetSearchEngine: () => ipcRenderer.invoke('nt.settings.search-engine.get'),
  settingsSetSearchEngine: (url) => ipcRenderer.invoke('nt.settings.search-engine.set', url),
  // themes
  themesGet: (spaceId) => ipcRenderer.invoke('nt.themes.get', spaceId),
  themesSet: (spaceId, tokens) => ipcRenderer.invoke('nt.themes.set', spaceId, tokens),
  themesReset: (spaceId) => ipcRenderer.invoke('nt.themes.reset', spaceId),
  // local models
  modelsList: () => ipcRenderer.invoke('nt.models.list'),
  modelsDownload: (id) => ipcRenderer.invoke('nt.models.download', id),
  modelsCancelDownload: (id) => ipcRenderer.invoke('nt.models.cancel-download', id),
  modelsRemove: (id) => ipcRenderer.invoke('nt.models.remove', id),
  modelsGetAssignment: () => ipcRenderer.invoke('nt.models.assignment.get'),
  modelsSetAssignment: (task, ref) => ipcRenderer.invoke('nt.models.assignment.set', task, ref),
  modelsAppleFm: () => ipcRenderer.invoke('nt.models.applefm'),
  modelsDiskUsage: () => ipcRenderer.invoke('nt.models.disk-usage'),
  onModelEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onModelEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.model-event', l);
    return () => ipcRenderer.removeListener('nt.model-event', l);
  },
  // voice engine
  voiceSttAvailable: () => ipcRenderer.invoke('nt.voice.stt-available'),
  voiceStartListening: () => ipcRenderer.invoke('nt.voice.start-listening'),
  voiceAudioChunk: (data) => ipcRenderer.invoke('nt.voice.audio-chunk', data),
  voiceStopListening: () => ipcRenderer.invoke('nt.voice.stop-listening'),
  voiceCancelListening: () => ipcRenderer.invoke('nt.voice.cancel-listening'),
  voiceSpeak: (text) => ipcRenderer.invoke('nt.voice.speak', text),
  onVoiceEngineState: (cb) => {
    const l = (_e: unknown, s: Parameters<Parameters<NextTokenAPI['onVoiceEngineState']>[0]>[0]) => cb(s);
    ipcRenderer.on('nt.voice-engine-state', l);
    return () => ipcRenderer.removeListener('nt.voice-engine-state', l);
  },
  onVoicePlayback: (cb) => {
    const l = (_e: unknown, bytes: number[]) => cb(bytes);
    ipcRenderer.on('nt.voice.playback', l);
    return () => ipcRenderer.removeListener('nt.voice.playback', l);
  },
  onCommandBar: (cb) => {
    const l = () => cb();
    ipcRenderer.on('nt.ui.command-bar', l);
    return () => ipcRenderer.removeListener('nt.ui.command-bar', l);
  },
  onVoiceRequestListen: (cb) => {
    const l = (_e: unknown, start: boolean) => cb(start);
    ipcRenderer.on('nt.voice.request-listen', l);
    return () => ipcRenderer.removeListener('nt.voice.request-listen', l);
  },
  // brain — Jev System-One orchestration
  brainGetJev: () => ipcRenderer.invoke('nt.brain.jev.get'),
  brainSetJev: (input) => ipcRenderer.invoke('nt.brain.jev.set', input),
  brainTestJev: () => ipcRenderer.invoke('nt.brain.jev.test'),
  brainValidateJev: (apiKey, baseUrl) => ipcRenderer.invoke('nt.brain.jev.validate', apiKey, baseUrl),
  brainHandleUtterance: (text, source) => ipcRenderer.invoke('nt.brain.utterance', text, source),
  onBrainEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onBrainEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.brain.event', l);
    return () => ipcRenderer.removeListener('nt.brain.event', l);
  },
  // native ad blocker
  adblockGet: () => ipcRenderer.invoke('nt.adblock.get'),
  adblockSetEnabled: (enabled) => ipcRenderer.invoke('nt.adblock.set-enabled', enabled),
  adblockSetSiteAllowed: (host, allowed) => ipcRenderer.invoke('nt.adblock.set-site-allowed', host, allowed),
  onAdBlockStats: (cb) => {
    const l = (_e: unknown, s: Parameters<Parameters<NextTokenAPI['onAdBlockStats']>[0]>[0]) => cb(s);
    ipcRenderer.on('nt.adblock.stats', l);
    return () => ipcRenderer.removeListener('nt.adblock.stats', l);
  },
  // events
  onSnapshot: (cb) => {
    const l = (_e: unknown, s: Parameters<Parameters<NextTokenAPI['onSnapshot']>[0]>[0]) => cb(s);
    ipcRenderer.on('nt.snapshot', l);
    return () => ipcRenderer.removeListener('nt.snapshot', l);
  },
  // Pull the current snapshot on boot: main's initial push may race the
  // renderer's first subscription, so the renderer requests it explicitly.
  snapshotGet: () => ipcRenderer.invoke('nt.snapshot.get'),
  onTabDelta: (cb) => {
    const l = (_e: unknown, d: Parameters<Parameters<NextTokenAPI['onTabDelta']>[0]>[0]) => cb(d);
    ipcRenderer.on('nt.tab-delta', l);
    return () => ipcRenderer.removeListener('nt.tab-delta', l);
  },
  onAgentEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onAgentEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.agent-event', l);
    return () => ipcRenderer.removeListener('nt.agent-event', l);
  }
};

contextBridge.exposeInMainWorld('nt', api);
