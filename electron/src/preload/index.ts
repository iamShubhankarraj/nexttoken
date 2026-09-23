import { contextBridge, ipcRenderer } from 'electron';
import type { NextTokenAPI } from '../shared/ipc';

const api: NextTokenAPI = {
  // tabs
  tabsCreate: (opts) => ipcRenderer.invoke('nt.tabs.create', opts),
  tabsClose: (tabId) => ipcRenderer.invoke('nt.tabs.close', tabId),
  tabsActivate: (tabId) => ipcRenderer.invoke('nt.tabs.activate', tabId),
  /** Picture in Picture for the active tab's video. */
  tabsPip: (tabId?: string) => ipcRenderer.invoke('nt.tabs.pip', tabId),
  /** Curved viewfinder: seek / play-pause the background media tab's video. */
  mediaSeek: (ratio, tabId?) => ipcRenderer.invoke('nt.media.seek', ratio, tabId),
  mediaToggle: (tabId?) => ipcRenderer.invoke('nt.media.toggle', tabId),
  /** Guest zoom for the active tab. */
  tabsZoom: (mode) => ipcRenderer.invoke('nt.tabs.zoom', mode),
  /** Find in page for the active tab. */
  findStart: (query) => ipcRenderer.invoke('nt.tabs.find', query),
  findNext: (forward) => ipcRenderer.invoke('nt.tabs.find-next', forward),
  findStop: () => ipcRenderer.invoke('nt.tabs.find-stop'),
  /** Reveal a finished download in Finder. */
  downloadsReveal: (path) => ipcRenderer.invoke('nt.downloads.reveal', path),
  /** Downloads manager (v0.6.3). */
  downloadsList: () => ipcRenderer.invoke('nt.downloads.list'),
  downloadsPause: (id) => ipcRenderer.invoke('nt.downloads.pause', id),
  downloadsResume: (id) => ipcRenderer.invoke('nt.downloads.resume', id),
  downloadsCancel: (id) => ipcRenderer.invoke('nt.downloads.cancel', id),
  downloadsRetry: (id) => ipcRenderer.invoke('nt.downloads.retry', id),
  downloadsClearFinished: () => ipcRenderer.invoke('nt.downloads.clear-finished'),
  downloadsOpen: (path) => ipcRenderer.invoke('nt.downloads.open', path),
  downloadsGetDir: () => ipcRenderer.invoke('nt.downloads.get-dir'),
  downloadsPickDir: () => ipcRenderer.invoke('nt.downloads.pick-dir'),
  downloadsSetDir: (dir) => ipcRenderer.invoke('nt.downloads.set-dir', dir),
  downloadsAutoOpenGet: () => ipcRenderer.invoke('nt.downloads.auto-open-get'),
  downloadsAutoOpenSet: (exts) => ipcRenderer.invoke('nt.downloads.auto-open-set', exts),
  /** Reader mode: enter the clean article view (default: active tab). */
  readerEnter: (tabId?) => ipcRenderer.invoke('nt.reader.enter', tabId),
  /** Reader mode: leave the article view. */
  readerExit: (tabId?) => ipcRenderer.invoke('nt.reader.exit', tabId),
  /** Reader availability/active state for a tab. */
  readerStatus: (tabId?) => ipcRenderer.invoke('nt.reader.status', tabId),
  /** Per-site auto-reader toggle (persisted like mute/autoplay). */
  readerSetAuto: (origin, enabled) =>
    ipcRenderer.invoke('nt.reader.set-auto', origin, enabled),
  /** Is auto-reader on for this origin? */
  readerAutoState: (origin) => ipcRenderer.invoke('nt.reader.auto-state', origin),
  /** System print dialog for the tab's page. */
  printDialog: (tabId?) => ipcRenderer.invoke('nt.print.dialog', tabId),
  /** Render the page to PDF, routed through the downloads pill. */
  printPdf: (tabId?) => ipcRenderer.invoke('nt.print.pdf', tabId),
  /** Screenshot: clipboard and/or PNG file via the downloads pill. */
  captureScreenshot: (opts?) => ipcRenderer.invoke('nt.capture.screenshot', opts),
  /** Open a blocked popup anyway. */
  popupOpenBlocked: (url) => ipcRenderer.invoke('nt.popup.open', url),
  onDownloadsEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onDownloadsEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.downloads.event', l);
    return () => ipcRenderer.removeListener('nt.downloads.event', l);
  },
  onFindResult: (cb) => {
    const l = (_e: unknown, r: Parameters<Parameters<NextTokenAPI['onFindResult']>[0]>[0]) => cb(r);
    ipcRenderer.on('nt.find.result', l);
    return () => ipcRenderer.removeListener('nt.find.result', l);
  },
  onPopupBlocked: (cb) => {
    const l = (_e: unknown, info: Parameters<Parameters<NextTokenAPI['onPopupBlocked']>[0]>[0]) => cb(info);
    ipcRenderer.on('nt.popup.blocked', l);
    return () => ipcRenderer.removeListener('nt.popup.blocked', l);
  },
  /** v0.6.4: main asks the renderer to open a popup side-by-side. */
  onPopupSplit: (cb) => {
    const l = (_e: unknown, ids: Parameters<Parameters<NextTokenAPI['onPopupSplit']>[0]>[0]) => cb(ids);
    ipcRenderer.on('nt.popup.split', l);
    return () => ipcRenderer.removeListener('nt.popup.split', l);
  },
  onMediaState: (cb) => {
    const l = (_e: unknown, s: Parameters<Parameters<NextTokenAPI['onMediaState']>[0]>[0]) => cb(s);
    ipcRenderer.on('nt.media.state', l);
    return () => ipcRenderer.removeListener('nt.media.state', l);
  },
  onMediaThumb: (cb) => {
    const l = (_e: unknown, t: Parameters<Parameters<NextTokenAPI['onMediaThumb']>[0]>[0]) => cb(t);
    ipcRenderer.on('nt.media.thumb', l);
    return () => ipcRenderer.removeListener('nt.media.thumb', l);
  },
  // -- Privacy & security → Advanced -------------------------------------
  privacySnapshot: () => ipcRenderer.invoke('nt.privacy.snapshot'),
  privacySetPermission: (origin, perm, decision) =>
    ipcRenderer.invoke('nt.privacy.set-permission', origin, perm, decision),
  privacySetDefault: (perm, policy) => ipcRenderer.invoke('nt.privacy.set-default', perm, policy),
  privacySetPopup: (origin, policy) => ipcRenderer.invoke('nt.privacy.set-popup', origin, policy),
  /** v0.6.4: where popups open — 'tab' or side-by-side 'split'. */
  privacySetPopupTarget: (target) => ipcRenderer.invoke('nt.privacy.set-popup-target', target),
  privacySetAutoplay: (origin, allow) => ipcRenderer.invoke('nt.privacy.set-autoplay', origin, allow),
  privacySetMuted: (origin, muted) => ipcRenderer.invoke('nt.privacy.set-muted', origin, muted),
  siteinfoGet: () => ipcRenderer.invoke('nt.siteinfo.get'),
  privacySites: () => ipcRenderer.invoke('nt.privacy.sites'),
  privacySiteCookies: (site) => ipcRenderer.invoke('nt.privacy.site-cookies', site),
  privacyDeleteSite: (site) => ipcRenderer.invoke('nt.privacy.delete-site', site),
  privacyClearData: (opts) => ipcRenderer.invoke('nt.privacy.clear-data', opts),
  privacyHistory: () => ipcRenderer.invoke('nt.privacy.history'),
  /** HTTPS-Strict upgrade toggle (v0.6.3). */
  privacySetHttpsUpgrade: (enabled) => ipcRenderer.invoke('nt.privacy.set-https-upgrade', enabled),
  /** Per-origin zoom memory (v0.6.3). */
  zoomList: () => ipcRenderer.invoke('nt.zoom.list'),
  zoomReset: (origin) => ipcRenderer.invoke('nt.zoom.reset', origin),
  /** History manager (v0.6.3). */
  historyList: (limit) => ipcRenderer.invoke('nt.history.list', limit),
  historySearch: (query, limit) => ipcRenderer.invoke('nt.history.search', query, limit),
  historyDelete: (at, url) => ipcRenderer.invoke('nt.history.delete', at, url),
  historyClearRange: (range) => ipcRenderer.invoke('nt.history.clear-range', range),
  tabsPin: (tabId, pinned) => ipcRenderer.invoke('nt.tabs.pin', tabId, pinned),
  pinnedAppsAdd: (url, title) => ipcRenderer.invoke('nt.pinned.add', url, title),
  pinnedAppsRemove: (id) => ipcRenderer.invoke('nt.pinned.remove', id),
  pinnedAppsReorder: (id, beforeId) => ipcRenderer.invoke('nt.pinned.reorder', id, beforeId),
  tabsMove: (tabId, spaceId) => ipcRenderer.invoke('nt.tabs.move', tabId, spaceId),
  tabsReorder: (tabId, beforeTabId, folderId) => ipcRenderer.invoke('nt.tabs.reorder', tabId, beforeTabId, folderId),
  tabsSetFolder: (tabId, folderId) => ipcRenderer.invoke('nt.tabs.set-folder', tabId, folderId),
  tabsAttach: (tabId, webContentsId) => ipcRenderer.invoke('nt.tabs.attach', tabId, webContentsId),
  tabsArchive: (tabId) => ipcRenderer.invoke('nt.tabs.archive', tabId),
  tabsRestore: (archivedId) => ipcRenderer.invoke('nt.tabs.restore', archivedId),
  /** Tab-level mute toggle (sidebar speaker icon / tab context menu). */
  tabsSetMuted: (tabId, muted) => ipcRenderer.invoke('nt.tabs.mute', tabId, muted),
  /** Duplicate a tab right after the original, in the same Bit. */
  tabsDuplicate: (tabId) => ipcRenderer.invoke('nt.tabs.duplicate', tabId),
  /** Reload a specific tab. */
  tabsReloadTab: (tabId) => ipcRenderer.invoke('nt.tabs.reload-tab', tabId),
  /** Close every other unpinned tab in the tab's Bit. */
  tabsCloseOthers: (tabId) => ipcRenderer.invoke('nt.tabs.close-others', tabId),
  /** Close unpinned tabs to the right in sidebar order. */
  tabsCloseRight: (tabId) => ipcRenderer.invoke('nt.tabs.close-right', tabId),
  /** Reopen the most recently user-closed tab (⌘⇧T). */
  tabsReopenClosed: () => ipcRenderer.invoke('nt.tabs.reopen-closed'),
  /** Shell shortcut forwarded from a focused guest webview. */
  onGuestShortcut: (cb) => {
    const l = (_e: unknown, info: Parameters<Parameters<NextTokenAPI['onGuestShortcut']>[0]>[0]) => cb(info);
    ipcRenderer.on('nt.guest.shortcut', l);
    return () => ipcRenderer.removeListener('nt.guest.shortcut', l);
  },
  // navigation
  navGo: (raw) => ipcRenderer.invoke('nt.nav.go', raw),
  navBack: () => ipcRenderer.invoke('nt.nav.back'),
  navForward: () => ipcRenderer.invoke('nt.nav.forward'),
  navReload: () => ipcRenderer.invoke('nt.nav.reload'),
  navStop: () => ipcRenderer.invoke('nt.nav.stop'),
  // spaces (user-facing name: Bits)
  spacesCreate: (name) => ipcRenderer.invoke('nt.spaces.create', name),
  spacesSwitch: (id) => ipcRenderer.invoke('nt.spaces.switch', id),
  spacesRename: (id, name) => ipcRenderer.invoke('nt.spaces.rename', id, name),
  spacesDelete: (id) => ipcRenderer.invoke('nt.spaces.delete', id),
  spacesSetAccent: (id, accent) => ipcRenderer.invoke('nt.spaces.set-accent', id, accent),
  spacesAddFavorite: (spaceId, name, url) => ipcRenderer.invoke('nt.spaces.add-favorite', spaceId, name, url),
  spacesRemoveFavorite: (spaceId, favId) => ipcRenderer.invoke('nt.spaces.remove-favorite', spaceId, favId),
  // folders (per Bit)
  foldersCreate: (spaceId, name) => ipcRenderer.invoke('nt.folders.create', spaceId, name),
  foldersRename: (spaceId, folderId, name) => ipcRenderer.invoke('nt.folders.rename', spaceId, folderId, name),
  foldersRemove: (spaceId, folderId) => ipcRenderer.invoke('nt.folders.remove', spaceId, folderId),
  // bookmarks (per Bit)
  bookmarksAdd: (spaceId, name, url, folder) => ipcRenderer.invoke('nt.bookmarks.add', spaceId, name, url, folder),
  bookmarksRename: (spaceId, id, name) => ipcRenderer.invoke('nt.bookmarks.rename', spaceId, id, name),
  bookmarksRemove: (spaceId, id) => ipcRenderer.invoke('nt.bookmarks.remove', spaceId, id),
  /** Move a bookmark to another Bit (v0.6.3). */
  bookmarksMove: (fromSpaceId, id, toSpaceId) => ipcRenderer.invoke('nt.bookmarks.move', fromSpaceId, id, toSpaceId),
  /** Bookmarks bar visibility + scope (v0.6.3). */
  bookmarksBarGet: () => ipcRenderer.invoke('nt.bookmarks.bar-get'),
  bookmarksBarSet: (v) => ipcRenderer.invoke('nt.bookmarks.bar-set', v),
  /** On-launch behavior + default browser (v0.6.3). */
  startupGet: () => ipcRenderer.invoke('nt.startup.get'),
  startupSet: (v) => ipcRenderer.invoke('nt.startup.set', v),
  startupIsDefaultBrowser: () => ipcRenderer.invoke('nt.startup.is-default'),
  startupMakeDefaultBrowser: () => ipcRenderer.invoke('nt.startup.make-default'),
  startupNudge: () => ipcRenderer.invoke('nt.startup.nudge'),
  // import from other browsers (explicit user action only)
  importDetect: () => ipcRenderer.invoke('nt.import.detect'),
  importRun: (browserId, kinds) => ipcRenderer.invoke('nt.import.run', browserId, kinds),
  importPasswordGuidance: (browserId) => ipcRenderer.invoke('nt.import.password-guidance', browserId),
  importLoginsCount: () => ipcRenderer.invoke('nt.import.logins-count'),
  // password manager (save prompt, origin-bound autofill, vault UI)
  passwordsList: () => ipcRenderer.invoke('nt.passwords.list'),
  passwordsLookup: (tabId, origin) => ipcRenderer.invoke('nt.passwords.lookup', tabId, origin),
  passwordsAutofill: (tabId, username) => ipcRenderer.invoke('nt.passwords.autofill', tabId, username),
  passwordsLoginDetected: (tabId, origin, username) =>
    ipcRenderer.invoke('nt.passwords.login-detected', tabId, origin, username),
  passwordsSaveDecision: (token, decision) => ipcRenderer.invoke('nt.passwords.save-decision', token, decision),
  passwordsReveal: (origin, username) => ipcRenderer.invoke('nt.passwords.reveal', origin, username),
  passwordsCopy: (origin, username) => ipcRenderer.invoke('nt.passwords.copy', origin, username),
  passwordsDelete: (origin, username) => ipcRenderer.invoke('nt.passwords.delete', origin, username),
  passwordsBlocked: () => ipcRenderer.invoke('nt.passwords.blocked'),
  passwordsUnblock: (origin) => ipcRenderer.invoke('nt.passwords.unblock', origin),
  onPasswordsSavePrompt: (cb) => {
    const l = (_e: unknown, p: Parameters<Parameters<NextTokenAPI['onPasswordsSavePrompt']>[0]>[0]) => cb(p);
    ipcRenderer.on('nt.passwords.save-prompt', l);
    return () => ipcRenderer.removeListener('nt.passwords.save-prompt', l);
  },
  // AI tidy — local models only
  tidyPlan: (spaceId) => ipcRenderer.invoke('nt.tidy.plan', spaceId),
  tidyApply: (spaceId, actions) => ipcRenderer.invoke('nt.tidy.apply', spaceId, actions),
  // ui
  uiSetSidebarCollapsed: (c) => ipcRenderer.invoke('nt.ui.sidebar-collapsed', c),
  uiSetAgentPanelOpen: (o) => ipcRenderer.invoke('nt.ui.agent-panel', o),
  uiSetSettingsOpen: (o) => ipcRenderer.invoke('nt.ui.settings-open', o),
  uiSetSidebarWidth: (w) => ipcRenderer.invoke('nt.ui.sidebar-width', w),
  uiSetAgentPanelWidth: (w) => ipcRenderer.invoke('nt.ui.agent-panel-width', w),
  uiSetAppStoreHeight: (h) => ipcRenderer.invoke('nt.ui.app-store-height', h),
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
  settingsSetSearchEngine: (id, template) => ipcRenderer.invoke('nt.settings.search-engine.set', id, template),
  // themes
  themesGet: (spaceId) => ipcRenderer.invoke('nt.themes.get', spaceId),
  themesSet: (spaceId, tokens) => ipcRenderer.invoke('nt.themes.set', spaceId, tokens),
  themesReset: (spaceId) => ipcRenderer.invoke('nt.themes.reset', spaceId),
  // local models
  modelsList: () => ipcRenderer.invoke('nt.models.list'),
  modelsDownload: (id) => ipcRenderer.invoke('nt.models.download', id),
  modelsCancelDownload: (id) => ipcRenderer.invoke('nt.models.cancel-download', id),
  modelsRemove: (id) => ipcRenderer.invoke('nt.models.remove', id),
  modelsServerStatus: () => ipcRenderer.invoke('nt.models.server-status'),
  modelsStopServer: (slot: 'chat' | 'vision') => ipcRenderer.invoke('nt.models.stop-server', slot),
  modelsGetAssignment: () => ipcRenderer.invoke('nt.models.assignment.get'),
  modelsSetAssignment: (task, ref) => ipcRenderer.invoke('nt.models.assignment.set', task, ref),
  modelsTaskModels: () => ipcRenderer.invoke('nt.models.task-models'),
  modelsSetVision: (ref) => ipcRenderer.invoke('nt.models.set-vision', ref),
  modelsAppleFm: () => ipcRenderer.invoke('nt.models.applefm'),
  modelsAppleFmDiagnose: () => ipcRenderer.invoke('nt.models.applefm-diagnose'),
  modelsDeviceInfo: () => ipcRenderer.invoke('nt.models.device-info'),
  modelsAdvisor: () => ipcRenderer.invoke('nt.models.advisor'),
  modelsDiskUsage: () => ipcRenderer.invoke('nt.models.disk-usage'),
  modelsLocalMetrics: () => ipcRenderer.invoke('nt.models.local-metrics'),
  onModelEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onModelEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.model-event', l);
    return () => ipcRenderer.removeListener('nt.model-event', l);
  },
  modelsHfTokenSet: (token) => ipcRenderer.invoke('nt.models.hf-token.set', token),
  modelsHfTokenHas: () => ipcRenderer.invoke('nt.models.hf-token.has'),
  modelsHfTokenClear: () => ipcRenderer.invoke('nt.models.hf-token.clear'),
  modelsGatedIds: () => ipcRenderer.invoke('nt.models.gated-ids'),
  // in-app updater (custom feed checker)
  updatesStatus: () => ipcRenderer.invoke('nt.updates.status'),
  updatesCheck: () => ipcRenderer.invoke('nt.updates.check'),
  updatesDownload: () => ipcRenderer.invoke('nt.updates.download'),
  updatesInstall: () => ipcRenderer.invoke('nt.updates.install'),
  updatesSetFeedUrl: (url) => ipcRenderer.invoke('nt.updates.set-feed-url', url),
  updatesSetAutoCheck: (on) => ipcRenderer.invoke('nt.updates.set-auto-check', on),
  onUpdateEvent: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onUpdateEvent']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt.update-event', l);
    return () => ipcRenderer.removeListener('nt.update-event', l);
  },
  // voice engine
  voiceSttAvailable: () => ipcRenderer.invoke('nt.voice.stt-available'),
  voiceSttStatus: () => ipcRenderer.invoke('nt.voice.stt-status'),
  voiceStartListening: () => ipcRenderer.invoke('nt.voice.start-listening'),
  voiceEnsureMic: () => ipcRenderer.invoke('nt.voice.ensure-mic'),
  voiceAudioChunk: (data) => ipcRenderer.invoke('nt.voice.audio-chunk', data),
  voiceStopListening: () => ipcRenderer.invoke('nt.voice.stop-listening'),
  voiceCancelListening: () => ipcRenderer.invoke('nt.voice.cancel-listening'),
  voiceSpeak: (text) => ipcRenderer.invoke('nt.voice.speak', text),
  voiceStopSpeaking: () => ipcRenderer.invoke('nt.voice.stop-speaking'),
  voiceAmplitude: (level) => ipcRenderer.send('nt.voice.amplitude', level),
  voicePlaybackStarted: () => ipcRenderer.send('nt.voice.playback-started'),
  voicePlaybackEnded: () => ipcRenderer.send('nt.voice.playback-ended'),
  voiceDictateUndo: () => ipcRenderer.invoke('nt.voice.dictate-undo'),
  voiceTakeover: () => ipcRenderer.invoke('nt.voice.takeover'),
  /** Self-heal Kokoro TTS (fetch espeak-ng-data when a manual model lacks it). */
  voiceRepairTts: () => ipcRenderer.invoke('nt.voice.repair-tts'),
  onVoiceEngineState: (cb) => {
    const l = (_e: unknown, s: Parameters<Parameters<NextTokenAPI['onVoiceEngineState']>[0]>[0]) => cb(s);
    ipcRenderer.on('nt.voice-engine-state', l);
    return () => ipcRenderer.removeListener('nt.voice-engine-state', l);
  },
  onVoiceError: (cb) => {
    const l = (_e: unknown, m: string) => cb(m);
    ipcRenderer.on('nt.voice-error', l);
    return () => ipcRenderer.removeListener('nt.voice-error', l);
  },
  onPipError: (cb) => {
    const l = (_e: unknown, m: string) => cb(m);
    ipcRenderer.on('nt.pip-error', l);
    return () => ipcRenderer.removeListener('nt.pip-error', l);
  },
  onVoiceAmplitude: (cb) => {
    const l = (_e: unknown, level: number) => cb(level);
    ipcRenderer.on('nt:voice-amplitude', l);
    return () => ipcRenderer.removeListener('nt:voice-amplitude', l);
  },
  onVoicePlaybackState: (cb) => {
    const l = (_e: unknown, speaking: boolean) => cb(speaking);
    ipcRenderer.on('nt:voice-playback-state', l);
    return () => ipcRenderer.removeListener('nt:voice-playback-state', l);
  },
  onAgentActing: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onAgentActing']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt:agent-acting', l);
    return () => ipcRenderer.removeListener('nt:agent-acting', l);
  },
  onAgentActingDone: (cb) => {
    const l = (_e: unknown, e: Parameters<Parameters<NextTokenAPI['onAgentActingDone']>[0]>[0]) => cb(e);
    ipcRenderer.on('nt:agent-acting-done', l);
    return () => ipcRenderer.removeListener('nt:agent-acting-done', l);
  },
  onVoiceBargeIn: (cb) => {
    const l = () => cb();
    ipcRenderer.on('nt:voice-barge-in', l);
    return () => ipcRenderer.removeListener('nt:voice-barge-in', l);
  },
  onVoiceTakeover: (cb) => {
    const l = () => cb();
    ipcRenderer.on('nt:voice-takeover', l);
    return () => ipcRenderer.removeListener('nt:voice-takeover', l);
  },
  onVoiceDictated: (cb) => {
    const l = (_e: unknown, d: { tabId: string; chars: number }) => cb(d);
    ipcRenderer.on('nt:voice-dictated', l);
    return () => ipcRenderer.removeListener('nt:voice-dictated', l);
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
  onOpenModels: (cb) => {
    const l = (_e: unknown, focus: { task?: string }) => cb(focus);
    ipcRenderer.on('nt.ui.open-models', l);
    return () => ipcRenderer.removeListener('nt.ui.open-models', l);
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
  adblockRefresh: () => ipcRenderer.invoke('nt.adblock.refresh'),
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
