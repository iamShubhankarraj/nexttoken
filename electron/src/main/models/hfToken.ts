/**
 * Optional Hugging Face access token for downloading access-gated models.
 *
 * Same storage pattern as the BYOK provider keys in main/store.ts:
 * encrypted with Electron safeStorage (OS keychain) into a .bin file under
 * userData; no plaintext fallback, ever.
 *
 * Boundary discipline: the token is only ever decrypted in the main process
 * (the model downloader reads it per request). Renderers only learn whether
 * a token is saved — never the value. Nothing here is logged.
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function tokenFile(): string {
  const dir = path.join(app.getPath('userData'), 'model-auth');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'hf-token.bin');
}

/** Is OS-level encryption available for storing the token? */
export function hfTokenStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Persist the token (empty string clears it). Returns false — storing
 * nothing — when OS encryption is unavailable. Throws on absurd input.
 */
export function setHfToken(token: string): boolean {
  const trimmed = (token ?? '').trim();
  if (trimmed.length > 500) {
    throw new Error('That token looks invalid (too long).');
  }
  try {
    const file = tokenFile();
    if (trimmed.length === 0) {
      fs.rmSync(file, { force: true });
      return true;
    }
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(file, safeStorage.encryptString(trimmed));
      return true;
    }
  } catch {
    /* fall through to refusal */
  }
  return false;
}

/**
 * Decrypt and return the token, or null when absent/unreadable.
 * Main-process only — never send this over IPC.
 */
export function getHfToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(fs.readFileSync(tokenFile()));
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Whether a token is stored (file-presence check — never decrypts). */
export function hasHfToken(): boolean {
  if (!hfTokenStorageAvailable()) return false;
  try {
    fs.accessSync(tokenFile(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
