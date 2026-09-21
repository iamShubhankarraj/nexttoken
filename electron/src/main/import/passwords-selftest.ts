/**
 * Self-test for the Chromium password import + encrypted login vault.
 *
 * Run from the repo root with Node 22+ (type-stripping):
 *   node electron/src/main/import/passwords-selftest.ts
 *
 * What it does:
 *  1. Builds a synthetic "Login Data" SQLite file via /usr/bin/sqlite3 CLI.
 *  2. Encrypts a known password with a known key using the REAL Chromium
 *     scheme: PBKDF2-HMAC-SHA1("saltysalt", 1003 iterations, 16 bytes) then
 *     AES-128-CBC with a "v10" prefix (IV + ciphertext, PKCS7 padded).
 *  3. Reads the row back through the same query the import uses, runs the
 *     module's decrypt path, and asserts the round-trip.
 *  4. Tests the vault save/load merge/dedupe/list/clear IF Electron's
 *     safeStorage is available; otherwise reports SKIP (not FAIL) —
 *     expected on plain Linux/macOS Node runs.
 *
 * Prints PASS / FAIL / SKIP lines. Exit 0 unless a FAIL occurred.
 * No enums or namespaces (Node type-stripping). Nothing secret is printed.
 */

import { execFile } from 'node:child_process';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SQLITE3 = '/usr/bin/sqlite3';
const SEP = '\u001f';

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
const results: { name: string; verdict: Verdict; detail: string }[] = [];

function report(name: string, verdict: Verdict, detail: string): void {
  results.push({ name, verdict, detail });
  console.log(`[${verdict}] ${name}${detail ? ' — ' + detail : ''}`);
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error('helper failed'));
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Dynamic imports keep tsc happy (no .ts extension in source) while letting
// Node's type-stripping resolve the real file at runtime. The sibling module
// under test imports only node: builtins, so plain Node can load it.
type PasswordsModule = typeof import('./passwords');
type LoginsModule = typeof import('./logins');

async function loadPasswordsModule(): Promise<PasswordsModule> {
  return (await import('./passwords' + '.ts')) as PasswordsModule;
}

async function main(): Promise<void> {
  if (!(await fileExists(SQLITE3))) {
    report('synthetic Login Data', 'SKIP', 'sqlite3 CLI not found at /usr/bin/sqlite3');
    finish();
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nt-selftest-'));
  try {
    const dbPath = path.join(tmpDir, 'Login Data');
    await execFileAsync(
      SQLITE3,
      [
        dbPath,
        'CREATE TABLE logins(origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER DEFAULT 0);',
      ],
      15_000,
    );

    // --- Build a real Chromium-scheme blob for a known password ---
    const secret = Buffer.from('nt-selftest-keychain-secret', 'utf8');
    const key = pbkdf2Sync(secret, Buffer.from('saltysalt', 'ascii'), 1003, 16, 'sha1');
    const iv = randomBytes(16);
    const plain = Buffer.from('s3lf-t3st-p@ss', 'utf8');
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const blob = Buffer.concat([Buffer.from('v10', 'ascii'), iv, cipher.update(plain), cipher.final()]);
    const blobHex = blob.toString('hex');

    await execFileAsync(
      SQLITE3,
      [
        dbPath,
        `INSERT INTO logins VALUES('https://example.com','alice',X'${blobHex}',0);` +
          `INSERT INTO logins VALUES('https://blacklisted.example','bob',X'${blobHex}',1);` +
          `INSERT INTO logins VALUES('https://nouser.example','',X'${blobHex}',0);` +
          `INSERT INTO logins VALUES('https://emptyblob.example','carol',X'',0);`,
      ],
      15_000,
    );

    // --- Read back with the same query shape the import uses ---
    const query =
      'SELECT origin_url, username_value, hex(password_value) FROM logins' +
      ' WHERE blacklisted_by_user = 0 AND length(password_value) > 0;';
    const out = await execFileAsync(SQLITE3, ['-separator', SEP, dbPath, query], 15_000);
    const rows = out.split('\n').filter((line) => line.length > 0);
    // The query filters blacklisted + empty blobs; the import skips empty
    // usernames in JS (mirrored here). Expect the valid row + the empty-user row.
    const usable = rows.filter((line) => {
      const parts = line.split(SEP);
      return parts[0] && parts[1] && parts[2];
    });
    if (rows.length !== 2 || usable.length !== 1) {
      report('login query filtering', 'FAIL', `expected 2 rows / 1 usable, got ${rows.length} / ${usable.length}`);
    } else {
      const [origin, username, hex] = usable[0].split(SEP);
      if (origin !== 'https://example.com' || username !== 'alice' || hex !== blobHex.toUpperCase()) {
        report('login query filtering', 'FAIL', 'row contents did not match the inserted login');
      } else {
        report('login query filtering', 'PASS', 'blacklisted/empty-blob rows excluded, empty-user row skipped, blob hex intact');
      }
    }

    // --- Run the module's real decrypt path ---
    const mod = await loadPasswordsModule();

    // The module's own key-derivation must match the test's derivation.
    const moduleKey = mod.deriveChromiumKey(secret);
    const derivationMatches = moduleKey.equals(key);
    secret.fill(0);
    key.fill(0);
    report(
      'PBKDF2(saltysalt,1003) derivation',
      derivationMatches ? 'PASS' : 'FAIL',
      derivationMatches ? 'module key matches reference' : 'module key differs from reference',
    );

    const recovered = mod.decryptChromiumPassword(blobHex, moduleKey);
    moduleKey.fill(0);
    report(
      'decrypt round-trip',
      recovered === 's3lf-t3st-p@ss' ? 'PASS' : 'FAIL',
      recovered === 's3lf-t3st-p@ss' ? 'known password recovered exactly' : 'recovered value did not match',
    );

    const badShort = mod.decryptChromiumPassword('deadbeef', Buffer.alloc(16, 7));
    const badPrefix = mod.decryptChromiumPassword(Buffer.concat([Buffer.from('v11', 'ascii'), randomBytes(32)]).toString('hex'), Buffer.alloc(16, 7));
    report(
      'decrypt rejects malformed blobs',
      badShort === null && badPrefix === null ? 'PASS' : 'FAIL',
      'short blob and wrong prefix both returned null',
    );

    // --- Guidance contract ---
    const safari = mod.passwordImportGuidance('safari');
    const firefox = mod.passwordImportGuidance('firefox');
    const guidanceOk =
      safari.supported === false &&
      firefox.supported === false &&
      safari.steps.length >= 3 &&
      firefox.steps.length >= 3 &&
      safari.title.length > 0 &&
      firefox.title.length > 0;
    report('manual-export guidance', guidanceOk ? 'PASS' : 'FAIL', 'safari + firefox unsupported with steps');

    // --- Vault round-trip (Electron only) ---
    await testVault(tmpDir);
  } catch {
    report('self-test run', 'FAIL', 'unexpected error during self-test');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  finish();
}

async function testVault(tmpDir: string): Promise<void> {
  if (!('electron' in process.versions)) {
    report('vault save/load', 'SKIP', 'not running under Electron — safeStorage unavailable');
    return;
  }
  const logins = (await import('./logins' + '.ts')) as LoginsModule;
  const userDataDir = path.join(tmpDir, 'user-data');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(userDataDir, { recursive: true });

  let count = await logins.saveImportedLogins(
    [{ origin: 'https://example.com', username: 'alice', password: 'pw-one' }],
    userDataDir,
  );
  const countOk = count === 1;

  // Merge: duplicate must not double-store; new login adds.
  count = await logins.saveImportedLogins(
    [
      { origin: 'https://example.com', username: 'alice', password: 'pw-one-changed' },
      { origin: 'https://example.org', username: 'bob', password: 'pw-two' },
    ],
    userDataDir,
  );
  const mergeOk = count === 2;

  const listed = logins.getStoredLogins(userDataDir);
  const listOk =
    listed.length === 2 &&
    listed.every((entry) => !('password' in entry)) &&
    listed.some((entry) => entry.origin === 'https://example.com' && entry.username === 'alice');

  const mode = (await stat(path.join(userDataDir, 'logins.bin'))).mode & 0o777;
  const modeOk = mode === 0o600;

  logins.clearStoredLogins(userDataDir);
  const clearedOk = logins.getStoredLogins(userDataDir).length === 0;

  const allOk = countOk && mergeOk && listOk && modeOk && clearedOk;
  report(
    'vault save/load',
    allOk ? 'PASS' : 'FAIL',
    `save=${countOk} merge/dedupe=${mergeOk} list-without-passwords=${listOk} mode600=${modeOk} clear=${clearedOk}`,
  );
}

function finish(): void {
  const fails = results.filter((r) => r.verdict === 'FAIL').length;
  const passes = results.filter((r) => r.verdict === 'PASS').length;
  const skips = results.filter((r) => r.verdict === 'SKIP').length;
  console.log(`\nself-test: ${passes} PASS, ${skips} SKIP, ${fails} FAIL`);
  process.exit(fails > 0 ? 1 : 0);
}

void main();
