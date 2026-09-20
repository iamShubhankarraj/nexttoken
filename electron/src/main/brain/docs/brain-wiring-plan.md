# Brain wiring plan — mechanical integration steps

Applies the `src/main/brain/` orchestration layer to the running app.
**Apply only after the UI rebuild on branch `local-models` is committed.**
Do not start until `git status` is clean. Apply in the exact order below;
each step is small and typechecks before moving on.

Conventions used below: `nt.brain.*` IPC channels follow the existing
`nt.<domain>.<action>` naming from `src/shared/ipc.ts`.

---

## Step 0 — preconditions

- `git status` clean on branch `local-models`.
- Read `src/main/brain/orchestrator.ts` (the `OrchestratorDeps` interface —
  every side effect the brain needs is injected there, so wiring is just
  filling in the five adapters).

## Step 1 — `src/main/store.ts`: Jev base URL only (key lives in the keychain module)

The Jev API key is **not** stored in `Store`. It lives in the new
`src/main/brain/credentials.ts` (`JevCredentialStore`), which mirrors the
exact safeStorage pattern of `setApiKey`/`getApiKey` (`jev-key.bin` under
userData, no plaintext fallback). Only the non-secret base URL goes in Store:

1. In the `Persisted` interface, add:
   ```ts
   /** Brain / Jev config. The API key itself lives in the OS keychain via JevCredentialStore. */
   brain: { jevBaseUrl: string };
   ```
2. In `defaults()`, add: `brain: { jevBaseUrl: '' },`
3. In the migration block (near `if (!parsed.models) parsed.models = defaults().models;`), add:
   `if (!parsed.brain) parsed.brain = defaults().brain;`

No key accessors are added to `Store`. The wiring in Step 5 constructs
`JevCredentialStore` directly.

## Step 2 — `src/shared/ipc.ts`: public contract

1. Add types (place near the Models section):
   ```ts
   export interface JevConfigPublic { configured: boolean; baseUrl: string; }
   export interface JevConfigInput { apiKey: string; baseUrl?: string; }
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
   ```
2. In `NextTokenAPI`, add:
   ```ts
   brainGetJev(): Promise<JevConfigPublic>;
   brainSetJev(input: JevConfigInput): Promise<JevConfigPublic>;
   brainTestJev(): Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
   brainHandleUtterance(text: string, source: 'voice' | 'text'): Promise<void>;
   onBrainEvent(cb: (e: BrainEvent) => void): () => void;
   ```
3. In `src/main/brain/orchestrator.ts`, replace the local `BrainEvent`
   union with `import type { BrainEvent } from '../../shared/ipc';`
   (single source of truth; type-only import, erased at compile).

## Step 3 — `src/preload/index.ts`: expose the bridge

Mirror the existing one-line pattern, e.g.:
```ts
// brain
brainGetJev: () => ipcRenderer.invoke('nt.brain.jev.get'),
brainSetJev: (input) => ipcRenderer.invoke('nt.brain.jev.set', input),
brainTestJev: () => ipcRenderer.invoke('nt.brain.jev.test'),
brainHandleUtterance: (text, source) => ipcRenderer.invoke('nt.brain.utterance', text, source),
onBrainEvent: (cb) => {
  const l = (_e: unknown, e: BrainEvent) => cb(e);
  ipcRenderer.on('nt.brain.event', l);
  return () => ipcRenderer.removeListener('nt.brain.event', l);
},
```
Check the existing `onSnapshot` implementation for the exact listener/
unsubscribe idiom and copy it. Add the `BrainEvent` type import.

## Step 4 — `src/main/brain/control.ts` (NEW file, no conflicts)

Intent → browser-action switch. Every case calls the same underlying
functions the existing `ipcMain.handle('nt.tabs.*' / 'nt.nav.*' / ...)`
callbacks use — do not duplicate logic, delegate to `tabs`, `store`,
and the ui-state setters. Signature:

```ts
import type { TabManager } from '../tabs';
import type { Store } from '../store';

export interface ControlEnv {
  tabs: TabManager;
  store: Store;
  setSidebarCollapsed(c: boolean): void;
  setAgentPanelOpen(o: boolean): void;
  setSettingsOpen(o: boolean): void;
  /** For intents handled elsewhere: agent.*, models.*, settings.*, terminal.* */
  delegate: (intent: string, slots: Record<string, unknown>) => Promise<{ summary: string; speak?: string }>;
}

export async function executeControl(
  env: ControlEnv, intent: string, slots: Record<string, unknown>
): Promise<{ summary: string; speak?: string }>;
```

Cover all `specialist: 'control'` intents from `voice-commands.ts`
(tabs, navigation, spaces, ui.*, page.scroll.*, voice.listen.*).
Slot types: `ordinal`/`target` for tab switch/close (resolve number first,
else match title fragment case-insensitively, else current tab);
`destination` for nav.go (prepend `https://` when no scheme);
`space`/`name` for spaces. Return `{ summary }` always; add `speak`
only when the default "Done." would confuse (e.g. tab.list speaks the list).

## Step 5 — `src/main/index.ts`: construct and connect

1. Imports (top of file):
   ```ts
   import { dialog } from 'electron';
   import { JevClient } from './brain/jev';
   import { JevCredentialStore } from './brain/credentials';
   import { Orchestrator, createRouterChat } from './brain/orchestrator';
   import { executeControl } from './brain/control';
   import { snapshotPage, formatSnapshot } from './agent/perceive';
   ```
2. Module scope (next to `let voiceEngine` / `let routerDeps`):
   ```ts
   let jevCreds: JevCredentialStore;
   let jevClient: JevClient;
   let orchestrator: Orchestrator;
   ```
3. In init, right after `routerDeps = { store, appleFm, llama };`:
   ```ts
   jevCreds = new JevCredentialStore(userData);
   jevClient = new JevClient({
     // Runtime key source: OS keychain, resolved on every call. The raw key
     // is never held in app state and never logged.
     keyProvider: () => jevCreds.loadKey(),
     baseUrl: store.d.brain.jevBaseUrl || undefined
   });
   const chat = createRouterChat(routerDeps);
   orchestrator = new Orchestrator({
     jev: jevClient,
     control: { execute: (intent, slots) => executeControl(controlEnv(), intent, slots) },
     chat,
     speak: {
       speak: async (text: string) => {
         const wav = await voiceEngine.speak(text);
         win?.webContents.send('nt.voice.playback', Array.from(wav));
       }
     },
     confirm: {
       ask: async (text: string) => {
         const r = await dialog.showMessageBox(win!, {
           type: 'question', buttons: ['Cancel', 'Confirm'],
           defaultId: 0, cancelId: 0, message: text
         });
         return r.response === 1;
       }
     },
     getPageState: async () => {
       const wc = tabs.activeWebContents();
       const snap = wc ? await snapshotPage(wc) : null;
       return {
         url: snap?.url ?? '', title: snap?.title ?? '',
         tabSummary: describeTabs(tabs),   // implement: "N tabs: <title> (active), ..."
         pageText: snap ? formatSnapshot(snap) : '(no readable page)'
       };
     },
     startAgentRun: (task: string) =>
       startAgentRun(task, { win: win!, tabs, store, emit: emitAgent, router: routerDeps }, { voice: true }),
     emit: (e) => win?.webContents.send('nt.brain.event', e)
   });
   ```
   Notes:
   - `controlEnv()` builds `{ tabs, store, setSidebarCollapsed, setAgentPanelOpen, setSettingsOpen, delegate }`
     from the same setters the `nt.ui.*` handlers use; `delegate` routes
     `agent.*` → `startAgentRun`-less chat path or existing handlers,
     `models.*` → downloader/assignment fns, `terminal.*` → the existing
     terminal confirmation flow (never execute directly — always the dialog).
   - `win!` / `emitAgent`: match whatever names main/index.ts uses at that
     point (check the `nt.agent.chat` handler).
   - `tabs.activeWebContents()`: verify the exact method name in `tabs.ts`.
4. IPC handlers (after the `nt.voice.*` block):
   ```ts
   ipcMain.handle('nt.brain.jev.get', (): JevConfigPublic =>
     ({ configured: jevCreds.hasKey, baseUrl: store.d.brain.jevBaseUrl }));
   ipcMain.handle('nt.brain.jev.set', (_e, input: JevConfigInput): JevConfigPublic => {
     // Save first, then point the client at the new key. The transient
     // `apiKey` path is only for the Validate button (Step 7) — it is never
     // persisted here.
     if (typeof input.baseUrl === 'string') {
       store.d.brain.jevBaseUrl = input.baseUrl.trim();
       store.save(); // check the actual persist method name in store.ts
     }
     if (input.apiKey) {
       const ok = jevCreds.saveKey(input.apiKey);
       if (!ok) throw new Error('OS keychain unavailable — Jev key was not stored.');
     }
     jevClient.setKeyProvider(() => jevCreds.loadKey());
     return { configured: jevCreds.hasKey, baseUrl: store.d.brain.jevBaseUrl };
   });
   ipcMain.handle('nt.brain.jev.test', async () => {
     const r = await jevClient.booleanCheck('connectivity test', 'This is a connectivity test, not a real request');
     return r.ok ? { ok: true, latencyMs: 0 } : { ok: false, error: r.message };
   });
   ipcMain.handle('nt.brain.jev.validate', async (_e, apiKey: string, baseUrl?: string) => {
     // ONE lightweight call with a transient client. The key is never
     // persisted here — the renderer only calls nt.brain.jev.set after the
     // user confirms. The transient client is discarded after this call.
     const probe = new JevClient({ apiKey, baseUrl: baseUrl?.trim() || undefined, timeoutMs: 4000 });
     const r = await probe.booleanCheck('validation probe', 'Is this a validation probe?');
     return r.ok ? { ok: true } : { ok: false, error: r.message };
   });
   ipcMain.handle('nt.brain.utterance', (_e, text: string, source: 'voice' | 'text') => {
     void orchestrator.handleUtterance(text, source).catch((e) =>
       win?.webContents.send('nt.brain.event', { kind: 'error', message: String(e) }));
   });
   ```
   Add `brainValidateJev(apiKey: string, baseUrl?: string): Promise<{ ok: boolean; error?: string }>;`
   to `NextTokenAPI` in `src/shared/ipc.ts` and the matching preload line
   (`brainValidateJev: (apiKey, baseUrl) => ipcRenderer.invoke('nt.brain.jev.validate', apiKey, baseUrl)`).
   Note: the Validate button sends the typed key over IPC to main, which uses
   it transiently and drops it — the key is only written to the keychain on
   explicit Save.

## Step 6 — voice hook: route transcripts into the brain

In the `nt.voice.stop-listening` handler, after the transcript returns:
```ts
ipcMain.handle('nt.voice.stop-listening', async (): Promise<string> => {
  const text = await voiceEngine.stopListening();
  if (text && store.d.voice.voiceControl) {
    void orchestrator.handleUtterance(text, 'voice');
  }
  return text;
});
```
This needs a new `voiceControl: boolean` flag: add to the `voice` object in
`Persisted` (default `false`), and extend the `nt.settings.voice.get/set`
handlers to include it. `src/main/voice/index.ts` itself needs NO changes.

## Step 7 — renderer: Settings UI + audio playback (coordinate with UI agent)

1. **Settings → new "Brain" section** (`src/renderer/components/Settings.tsx`):
   password field for the Jev API key (placeholder "sk-…", never echoed back —
   `brainGetJev` only returns `configured`), base URL field (default
   `https://api.typesafe.ai`), Test button → `brainTestJev()` showing
   ok/latency or the error, and a "Voice control mode" toggle wired to the
   extended voice settings. Short explainer: "Jev makes fast routing
   decisions (~100ms). Without a key, the brain runs fully offline."
2. **Audio playback**: listen for `nt.voice.playback` (Uint8Array → 16kHz mono
   WAV) and play via AudioContext. Put it next to the existing voice hook
   (`useVoice.ts` or App-level effect).
3. **Brain event feed** (optional v1): render `onBrainEvent` in the agent
   panel as a compact "heard → classified (92%) → acted" trace. The events
   are already structured for this.

## Step 8 — verify

1. `npm run typecheck` (node + web configs).
2. `electron-vite build` then `node scripts/smoke.mjs` (if still applicable).
3. Manual on a Mac: set Jev key → Test → say "new tab" (should act in
   <1s) → "run ls" (must show the confirm dialog with the exact command) →
   remove the key → "switch to tab 2" (local fallback still works).
4. Commit.

## Deliberately NOT in this plan

- Screenshot-pixel grounding (vision reads the DOM snapshot for now;
  `BrainPageState` has room for a future `screenshotPng`).
- A Jev-backed tool selector inside the agent loop (loop.ts untouched).
- Server-side Jev proxying — the key lives in the user's keychain and the
  call goes straight from the app to `api.typesafe.ai`.
