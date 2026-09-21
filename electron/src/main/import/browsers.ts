import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeniedError } from './util';

export type BrowserKind = 'chromium' | 'safari' | 'firefox' | 'arc';

export interface BrowserDef {
  id: string;
  name: string;
  kind: BrowserKind;
  /** Profile-storage root, relative to $HOME. For Chromium-likes this is the "User Data"-level dir. */
  userDataDir: string;
}

export const BROWSER_DEFS: BrowserDef[] = [
  { id: 'chrome', name: 'Google Chrome', kind: 'chromium', userDataDir: 'Library/Application Support/Google/Chrome' },
  { id: 'brave', name: 'Brave', kind: 'chromium', userDataDir: 'Library/Application Support/BraveSoftware/Brave-Browser' },
  { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', userDataDir: 'Library/Application Support/Microsoft Edge' },
  { id: 'arc', name: 'Arc', kind: 'arc', userDataDir: 'Library/Application Support/Arc/User Data' },
  { id: 'safari', name: 'Safari', kind: 'safari', userDataDir: 'Library/Safari' },
  { id: 'firefox', name: 'Firefox', kind: 'firefox', userDataDir: 'Library/Application Support/Firefox' },
];

export interface DetectedBrowser {
  /** Stable id for the coordinator. Suffixed with ":<profile dir>" when a browser has several profiles. */
  id: string;
  name: string;
  kind: BrowserKind;
  /** Absolute path of the profile directory (or the single data dir). */
  profileDir: string;
  profileLabel: string;
  /** Set when macOS denied us file access (TCC) — the UI should show the file-access guide. */
  accessDenied?: boolean;
  /** Arc only: absolute path of the StorableSidebar JSON, when found. */
  sidebarFile?: string;
}

type DirAccess = 'ok' | 'missing' | 'denied';

async function dirAccess(p: string): Promise<DirAccess> {
  try {
    const st = await fs.promises.stat(p);
    return st.isDirectory() ? 'ok' : 'missing';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return 'denied';
    return 'missing';
  }
}

function deniedEntry(def: BrowserDef, profileDir: string): DetectedBrowser {
  return { id: def.id, name: def.name, kind: def.kind, profileDir, profileLabel: def.name, accessDenied: true };
}

/** Best-effort profile display names from the Chromium "Local State" file. */
async function readLocalStateLabels(userDataDir: string): Promise<Record<string, string>> {
  try {
    const text = await fs.promises.readFile(path.join(userDataDir, 'Local State'), 'utf8');
    const info = JSON.parse(text)?.profile?.info_cache;
    const out: Record<string, string> = {};
    if (info && typeof info === 'object') {
      for (const [dir, meta] of Object.entries(info)) {
        const name = (meta as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim()) out[dir] = name.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Arc sidebar lives next to User Data: StorableSidebar.json or StorableSidebar.<id>.json. */
async function findArcSidebar(home: string): Promise<string | undefined> {
  const dir = path.join(home, 'Library/Application Support/Arc');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: string | undefined;
  let bestMtime = -1;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('StorableSidebar') || !entry.name.endsWith('.json')) continue;
    const full = path.join(dir, entry.name);
    try {
      const st = await fs.promises.stat(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return best;
}

async function detectChromiumProfiles(def: BrowserDef, home: string, root: string): Promise<DetectedBrowser[]> {
  const labels = await readLocalStateLabels(root);
  const sidebarFile = def.id === 'arc' ? await findArcSidebar(home) : undefined;
  const out: DetectedBrowser[] = [];
  const candidates = ['Default', ...Array.from({ length: 7 }, (_, i) => `Profile ${i + 1}`)];
  for (const candidate of candidates) {
    const dir = path.join(root, candidate);
    if ((await dirAccess(dir)) !== 'ok') continue;
    out.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      profileDir: dir,
      profileLabel: labels[candidate] ?? (candidate === 'Default' ? 'Default' : candidate),
      ...(sidebarFile ? { sidebarFile } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

type IniSection = Record<string, string>;

function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

async function detectFirefoxProfiles(def: BrowserDef, root: string): Promise<DetectedBrowser[]> {
  let profileDir: string | null = null;
  let profileLabel = 'Default';
  try {
    const sections = parseIni(await fs.promises.readFile(path.join(root, 'profiles.ini'), 'utf8'));
    const match =
      sections.find((s) => s['Default'] === '1') ??
      sections.find((s) => /default-release/i.test(s['Name'] ?? ''));
    if (match?.['Path']) {
      profileDir = match['IsRelative'] === '0' ? match['Path'] : path.join(root, match['Path']);
      if (match['Name']) profileLabel = match['Name'];
    }
  } catch {
    // fall through to directory scan
  }
  if (!profileDir || (await dirAccess(profileDir)) !== 'ok') {
    profileDir = null;
    try {
      const entries = await fs.promises.readdir(path.join(root, 'Profiles'), { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const pick =
        dirs.find((d) => d.endsWith('.default-release')) ?? dirs.find((d) => d.includes('.default')) ?? dirs[0];
      if (pick) {
        profileDir = path.join(root, 'Profiles', pick);
        profileLabel = pick;
      }
    } catch {
      // ignore
    }
  }
  if (!profileDir) return [];
  return [{ id: def.id, name: def.name, kind: def.kind, profileDir, profileLabel }];
}

/**
 * Detect installed browsers by checking their macOS data directories.
 * Never throws: per-browser failures are skipped, TCC denials are flagged.
 */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const home = os.homedir();
  const out: DetectedBrowser[] = [];
  for (const def of BROWSER_DEFS) {
    const root = path.join(home, def.userDataDir);
    let perDef: DetectedBrowser[];
    try {
      const access = await dirAccess(root);
      if (access === 'missing') continue;
      if (access === 'denied') {
        perDef = [deniedEntry(def, root)];
      } else if (def.kind === 'safari') {
        perDef = [{ id: def.id, name: def.name, kind: def.kind, profileDir: root, profileLabel: def.name }];
      } else if (def.kind === 'firefox') {
        perDef = await detectFirefoxProfiles(def, root);
      } else {
        perDef = await detectChromiumProfiles(def, home, root);
      }
    } catch (e) {
      if (isDeniedError(e)) perDef = [deniedEntry(def, root)];
      else continue;
    }
    if (perDef.length > 1) {
      for (const entry of perDef) entry.id = `${def.id}:${path.basename(entry.profileDir)}`;
    }
    out.push(...perDef);
  }
  return out;
}
