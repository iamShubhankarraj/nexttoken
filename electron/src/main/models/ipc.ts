/**
 * Home for Next Token's local-model IPC handlers that live outside
 * main/index.ts (another agent owns the PiP regions there — do not move the
 * existing `nt.models.*` handlers).
 *
 * HOOK (for the parent): inside registerIpc() in main/index.ts, right after
 * the `// -- local models ---` handler block (after the
 * `nt.models.disk-usage` handler), add:
 *
 *     registerModelsIpc();
 *
 * and import it at the top of index.ts:
 *
 *     import { registerModelsIpc } from './models/ipc';
 *
 * Handlers registered here:
 *   nt.models.hf-token.set   (token: string) -> { ok: true } — save the
 *       Hugging Face token via safeStorage (same pattern as BYOK provider
 *       keys: encrypted at rest, never echoed back). Empty clears it.
 *   nt.models.hf-token.has   () -> boolean — whether a token is saved.
 *       The value itself is never exposed over IPC.
 *   nt.models.hf-token.clear () -> void — delete the saved token.
 *   nt.models.gated-ids      () -> string[] — catalog ids flagged gated.
 *
 * Audit note (2026-09-21): the pre-existing `nt.models.*` channels in
 * index.ts (list / download / cancel-download / remove / assignment.get+set /
 * applefm / disk-usage, plus `nt.model-event`) were verified working
 * end-to-end: ModelsPanel.tsx -> preload (window.nt) -> ipcMain.handle ->
 * ModelDownloader -> disk, with progress/error events pushed back. The
 * defects found (cancel left a stale "downloading" guard; no transient
 * retry; raw HTTP status codes) were fixed in downloader.ts without
 * handler changes.
 */

import { guardedHandle } from '../ipcGuard';
import { MODEL_CATALOG } from './catalog';
import { hasHfToken, hfTokenStorageAvailable, setHfToken } from './hfToken';

export function registerModelsIpc(): void {
  guardedHandle('nt.models.hf-token.set', (_e, token: string): { ok: true } => {
    const value = typeof token === 'string' ? token.trim() : '';
    // Boundary check first: never accept a token we can't encrypt.
    if (value && !hfTokenStorageAvailable()) {
      throw new Error('Could not access the OS keychain — the token was not saved.');
    }
    if (!setHfToken(value)) {
      throw new Error('Could not access the OS keychain — the token was not saved.');
    }
    return { ok: true };
  });

  guardedHandle('nt.models.hf-token.has', (): boolean => hasHfToken());

  guardedHandle('nt.models.hf-token.clear', (): void => {
    setHfToken('');
  });

  guardedHandle('nt.models.gated-ids', (): string[] =>
    MODEL_CATALOG.filter((e) => e.gated).map((e) => e.id)
  );
}
