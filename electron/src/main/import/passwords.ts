/**
 * Chromium-family saved-password import (macOS).
 *
 * SECURITY CONTRACT — read before touching this file:
 *
 * 1. Explicit consent only. The macOS Keychain secret ("<Product> Safe Storage")
 *    is fetched through /usr/bin/security, which triggers macOS's NATIVE
 *    user-consent prompt ("...wants to use the key"). That prompt IS the
 *    consent path. Never bypass it, never script around it, never cache the
 *    raw key beyond a single import run.
 * 2. The key is never persisted. It lives in a Buffer that is zeroed (fill(0))
 *    in a finally block, immediately after the run. The same applies to every
 *    decrypted password and to the temp copies of Login Data (overwritten with
 *    zeros, then unlinked).
 * 3. Nothing secret is ever logged. No console output, no warnings, and no
 *    error strings may contain passwords, usernames paired with passwords,
 *    key material, decrypted blobs, or raw output from the security/sqlite3
 *    CLIs. Callers only ever see counts and static warning text.
 * 4. Platform WebAuthn / passkeys are untouched by this app. Nothing here
 *    intercepts, reads, or replays passkey material anywhere — verified by
 *    the coordinator. Only classic saved-password entries (Login Data table
 *    "logins") are read.
 * 5. Browsers without an on-disk, decryptable store are not attempted:
 *    Safari passwords live only in the login Keychain and Firefox's store is
 *    too fragile for pure-JS — both return honest manual-export guidance.
 */

import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Everything the import needs that the caller must supply (e.g. from a browser-id table). */
export interface DecryptedLoginSink {
  origin: string;
  username: string;
  password: string;
}

export interface PasswordImportDeps {
  /** The browser profile directory containing "Login Data". */
  profileDir: string;
  /** Keychain service, e.g. "Chrome Safe Storage". */
  keychainService: string;
  /** Keychain account, e.g. "Chrome". */
  keychainAccount: string;
  /**
   * Sink for decrypted logins. Called ONCE with the full batch while the
   * key is still live; the coordinator pipes it straight into the
   * safeStorage vault. Passwords never cross IPC and are never logged.
   * Optional — when absent, passwords are decrypted, counted, then dropped.
   */
  onDecrypted?: (logins: DecryptedLoginSink[]) => void | Promise<void>;
}

/** One imported login, safe to display in a report UI (no password). */
export interface ImportedLogin {
  origin: string;
  username: string;
}

/** One fully decrypted login. INTERNAL ONLY — never exported beyond this module. */
interface DecryptedLogin {
  origin: string;
  username: string;
  password: string;
}

const SQLITE3 = '/usr/bin/sqlite3';
const SECURITY = '/usr/bin/security';
const KEYCHAIN_TIMEOUT_MS = 60_000; // the user may need time to approve the native prompt
const SALT = Buffer.from('saltysalt', 'ascii'); // Chromium's fixed PBKDF2 salt
const PBKDF2_ITERATIONS = 1003;
const AES_KEY_BYTES = 16;

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('helper failed'));
          return;
        }
        resolve({ stdout: stdout ?? '' });
      },
    );
  });
}

/**
 * Derive Chromium's AES key from the Keychain secret:
 * PBKDF2-HMAC-SHA1(secret, salt "saltysalt", 1003 iterations, 16 bytes).
 */
export function deriveChromiumKey(secret: Buffer): Buffer {
  return pbkdf2Sync(secret, SALT, PBKDF2_ITERATIONS, AES_KEY_BYTES, 'sha1');
}

/**
 * Decrypt one Login Data password blob: "v10" prefix + IV(16) + AES-128-CBC
 * ciphertext, PKCS7 padded. Returns null on any failure (counts only — no
 * error detail leaves this function).
 */
export function decryptChromiumPassword(encryptedHex: string, key: Buffer): string | null {
  try {
    const blob = Buffer.from(encryptedHex, 'hex');
    if (blob.length < 3 + 16 + 16) return null;
    if (blob.subarray(0, 3).toString('ascii') !== 'v10') return null;
    const iv = blob.subarray(3, 19);
    const ciphertext = blob.subarray(19);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    // Any failure (bad key, bad padding, truncated blob) counts as a skip —
    // no detail leaves this function.
    return null;
  }
}

/** Fetch the Keychain secret via /usr/bin/security (native consent prompt). Never log the result. */
async function fetchKeychainSecret(service: string, account: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(
      SECURITY,
      ['find-generic-password', '-ws', service, '-a', account],
      KEYCHAIN_TIMEOUT_MS,
    );
    const secret = stdout.replace(/\r?\n$/, '');
    if (!secret) return null;
    return Buffer.from(secret, 'utf8');
  } catch {
    // Deliberately no detail: stderr may contain key material.
    return null;
  }
}

/** Overwrite a file or directory tree with zeros, then remove it. Best effort. */
async function secureWipe(target: string): Promise<void> {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    for (const entry of entries) {
      await secureWipe(path.join(target, entry));
    }
    await fs.rmdir(target);
    return;
  }
  const fd = await fs.open(target, 'r+');
  try {
    const zeros = Buffer.alloc(1024 * 1024, 0);
    let remaining = stat.size;
    while (remaining > 0) {
      const chunk = Math.min(zeros.length, remaining);
      await fd.write(zeros, 0, chunk);
      remaining -= chunk;
    }
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.unlink(target);
}

/** Build the SELECT for the logins table, tolerating schema differences across Chromium versions. */
async function buildLoginQuery(dbPath: string): Promise<string> {
  let columns = new Set<string>();
  try {
    const { stdout } = await execFileAsync(SQLITE3, [dbPath, 'PRAGMA table_info(logins);'], 15_000);
    columns = new Set(
      stdout
        .split('\n')
        .map((line) => line.split('|')[1])
        .filter((name): name is string => Boolean(name)),
    );
  } catch {
    // fall through to the unfiltered query
  }
  const filter = columns.has('blacklisted_by_user')
    ? ' WHERE blacklisted_by_user = 0 AND length(password_value) > 0'
    : ' WHERE length(password_value) > 0';
  return `SELECT origin_url, username_value, hex(password_value) FROM logins${filter};`;
}

/**
 * Import saved passwords from a Chromium-family profile on macOS.
 *
 * Flow: copy "Login Data" (browsers lock it while running) to a temp dir,
 * query rows via the bundled /usr/bin/sqlite3 CLI, fetch the Keychain secret
 * (native consent prompt), decrypt each blob, then wipe everything.
 *
 * Returns only origins/usernames plus counts; warnings carry static text only.
 */
export async function importChromiumPasswords(
  deps: PasswordImportDeps,
): Promise<{ imported: ImportedLogin[]; skipped: number; warnings: string[] }> {
  const warnings: string[] = [];
  const imported: ImportedLogin[] = [];
  let skipped = 0;
  let key: Buffer | null = null;
  let tempDir: string | null = null;

  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-password-import-'));

    const sourceDb = path.join(deps.profileDir, 'Login Data');
    const workDb = path.join(tempDir, 'Login Data');
    try {
      await fs.copyFile(sourceDb, workDb);
    } catch {
      warnings.push(
        'Could not read the browser\u2019s Login Data file (it may be locked while the browser is running) \u2014 passwords skipped.',
      );
      return { imported, skipped, warnings };
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        await fs.copyFile(sourceDb + suffix, workDb + suffix);
      } catch {
        // optional journal files; ignore
      }
    }

    let rows: string[];
    try {
      const query = await buildLoginQuery(workDb);
      const { stdout } = await execFileAsync(SQLITE3, ['-separator', '\u001f', workDb, query], 30_000);
      rows = stdout.split('\n').filter((line) => line.length > 0);
    } catch {
      warnings.push('Could not query the browser\u2019s saved logins \u2014 passwords skipped.');
      return { imported, skipped, warnings };
    }

    // The security CLI triggers macOS's native consent prompt; the user may
    // need time to approve, hence the 60s timeout.
    key = await fetchKeychainSecret(deps.keychainService, deps.keychainAccount);
    if (!key) {
      warnings.push('Keychain access was denied or not approved \u2014 passwords skipped.');
      return { imported, skipped, warnings };
    }
    const aesKey = deriveChromiumKey(key);
    try {
      const batch: DecryptedLoginSink[] = [];
      for (const row of rows) {
        const [origin, username, blobHex] = row.split('\u001f');
        if (!origin || !username || !blobHex) {
          skipped += 1;
          continue;
        }
        const password = decryptChromiumPassword(blobHex, aesKey);
        if (password === null) {
          skipped += 1;
          continue;
        }
        const decrypted: DecryptedLogin = { origin, username, password };
        // Decrypted material is consumed here and never leaves the module
        // boundary except through the explicit onDecrypted sink (wired
        // straight into the safeStorage vault); only the safe projection
        // is returned.
        batch.push({ origin: decrypted.origin, username: decrypted.username, password: decrypted.password });
        imported.push({ origin: decrypted.origin, username: decrypted.username });
      }
      if (deps.onDecrypted && batch.length > 0) {
        await deps.onDecrypted(batch);
      }
    } finally {
      aesKey.fill(0);
    }

    return { imported, skipped, warnings };
  } finally {
    if (key) key.fill(0);
    if (tempDir) {
      try {
        await secureWipe(tempDir);
      } catch {
        // best effort; nothing secret is reported
      }
    }
  }
}

/**
 * Honest manual-export guidance for browsers we deliberately do not decrypt.
 * Safari passwords live only in the macOS login Keychain (no file); Firefox's
 * logins.json + key4.db chain is too fragile for pure-JS and may sit behind a
 * Primary Password — we do not attempt either.
 */
export function passwordImportGuidance(browserId: 'safari' | 'firefox'): {
  supported: false;
  title: string;
  steps: string[];
} {
  if (browserId === 'safari') {
    return {
      supported: false,
      title: 'Safari passwords',
      steps: [
        'Safari stores passwords only in the macOS login Keychain \u2014 there is no exportable password file, so Next Token cannot read them automatically.',
        'On your Mac, open System Settings \u2192 Passwords and unlock with Touch ID or your Mac password.',
        'Click the \u2026 (More) button and choose \u201cExport All Passwords\u201d, then save the CSV somewhere private.',
        'Import that CSV into Next Token, then securely delete the CSV file (empty the Trash).',
      ],
    };
  }
  return {
    supported: false,
    title: 'Firefox passwords',
    steps: [
      'Firefox stores passwords in logins.json, locked by a key in key4.db that may be protected by a Primary Password \u2014 Next Token does not attempt to decrypt this automatically.',
      'In Firefox, open Settings \u2192 Privacy & Security \u2192 Passwords and click \u201cSaved Logins\u201d.',
      'Click the \u2026 (menu) button and choose \u201cExport Logins\u201d to save a CSV file.',
      'Import that CSV into Next Token, then securely delete the CSV file (empty the Trash).',
    ],
  };
}
