/**
 * Secure credential storage for the Jev API key.
 *
 * Mirrors the exact pattern the app uses for BYOK provider keys
 * (src/main/store.ts: setApiKey/getApiKey/keyInKeychain):
 *   - the key is encrypted with Electron safeStorage (OS keychain:
 *     Keychain on macOS, DPAPI/libsecret elsewhere) and written to a
 *     dedicated file under the app's userData directory;
 *   - if OS encryption is unavailable we REFUSE to store the key —
 *     there is no plaintext fallback, ever;
 *   - the key never appears in logs, errors, or persisted JSON.
 *
 * Kept as a separate module (rather than extending Store) so the brain
 * layer owns its credential lifecycle and no existing file is modified.
 * The wiring step constructs one instance with app.getPath('userData')
 * and hands it to JevClient via the keyProvider callback.
 */

import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export class JevCredentialStore {
  private readonly keyFile: string;

  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    this.keyFile = path.join(userDataDir, 'jev-key.bin');
  }

  /**
   * Persist a Jev API key to the OS keychain.
   * Returns true when stored. Empty input clears the stored key.
   * Returns false (and stores nothing) when OS encryption is unavailable.
   */
  saveKey(key: string): boolean {
    const trimmed = (key ?? '').trim();
    try {
      if (trimmed.length === 0) {
        fs.rmSync(this.keyFile, { force: true });
        return true;
      }
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(this.keyFile, safeStorage.encryptString(trimmed));
        return true;
      }
    } catch {
      /* fall through to refusal */
    }
    return false;
  }

  /** Decrypt and return the stored key, or null when absent/unreadable. */
  loadKey(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const buf = fs.readFileSync(this.keyFile);
      const key = safeStorage.decryptString(buf);
      return key.length > 0 ? key : null;
    } catch {
      return null;
    }
  }

  /** True when a key is present in the keychain (value never exposed). */
  get hasKey(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    try {
      fs.readFileSync(this.keyFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the stored key from the keychain. */
  clearKey(): void {
    try {
      fs.rmSync(this.keyFile, { force: true });
    } catch {
      /* already absent */
    }
  }
}

/**
 * Key-provider callback shape consumed by JevClient.
 * Called on every decide() so key rotation/saving takes effect immediately
 * without reconstructing the client.
 */
export type JevKeyProvider = () => string | null;
