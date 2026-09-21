/**
 * Encrypted vault for imported browser credentials.
 *
 * The vault file (<userDataDir>/logins.bin) is a JSON array encrypted with
 * Electron safeStorage (OS keychain-backed), so passwords never touch disk
 * unencrypted. The file is created with mode 0o600. Passwords are never
 * logged, never printed, and never returned by the list path below —
 * getStoredLogins strips them so the UI can show "what's stored" without
 * exposing secrets. Passwords stay retrievable only via a future autofill
 * path (to be added by the coordinator), which must keep them in memory and
 * never write them anywhere unencrypted.
 *
 * Note: plaintext passwords are JS strings here (immutable, left for GC).
 * That is accepted because they are never persisted or logged; only
 * Buffer-held key material is explicitly zeroed, which happens in
 * passwords.ts.
 */

import { safeStorage } from 'electron';
import { promises as fsp, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const VAULT_FILE = 'logins.bin';
const VAULT_MODE = 0o600;

interface StoredLogin {
  origin: string;
  username: string;
  password: string;
}

export interface LoginInput {
  origin: string;
  username: string;
  password: string;
}

function vaultPath(userDataDir: string): string {
  return path.join(userDataDir, VAULT_FILE);
}

function sanitize(parsed: unknown): StoredLogin[] {
  if (!Array.isArray(parsed)) return [];
  const out: StoredLogin[] = [];
  for (const item of parsed) {
    if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as StoredLogin).origin === 'string' &&
      typeof (item as StoredLogin).username === 'string' &&
      typeof (item as StoredLogin).password === 'string'
    ) {
      out.push({
        origin: (item as StoredLogin).origin,
        username: (item as StoredLogin).username,
        password: (item as StoredLogin).password,
      });
    }
  }
  return out;
}

function readVaultSync(userDataDir: string): StoredLogin[] {
  try {
    const encrypted = readFileSync(vaultPath(userDataDir));
    const json = safeStorage.decryptString(encrypted);
    return sanitize(JSON.parse(json));
  } catch {
    // Missing/corrupt vault reads as empty — never surface crypto details.
    return [];
  }
}

/**
 * Merge logins into the encrypted vault (dedupe by origin+username).
 * Returns the total number of logins stored after the merge.
 * Throws if the OS keychain is unavailable — we refuse to store
 * passwords without real encryption.
 */
export async function saveImportedLogins(logins: LoginInput[], userDataDir: string): Promise<number> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain unavailable — cannot store passwords securely.');
  }
  const stored = readVaultSync(userDataDir);
  const seen = new Set(stored.map((entry) => entry.origin + '\u0000' + entry.username));
  for (const login of logins) {
    const key = login.origin + '\u0000' + login.username;
    if (seen.has(key)) continue;
    seen.add(key);
    stored.push({ origin: login.origin, username: login.username, password: login.password });
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(stored));
  await fsp.writeFile(vaultPath(userDataDir), encrypted, { mode: VAULT_MODE });
  // writeFile's mode only applies at creation; enforce on existing files too.
  await fsp.chmod(vaultPath(userDataDir), VAULT_MODE);
  return stored.length;
}

/**
 * Return what's stored WITHOUT passwords (safe for a "what's stored" list).
 */
export function getStoredLogins(userDataDir: string): { origin: string; username: string }[] {
  return readVaultSync(userDataDir).map((entry) => ({
    origin: entry.origin,
    username: entry.username,
  }));
}

/** Remove the vault entirely. Best effort; never throws on a missing file. */
export function clearStoredLogins(userDataDir: string): void {
  try {
    unlinkSync(vaultPath(userDataDir));
  } catch {
    // already gone
  }
}
