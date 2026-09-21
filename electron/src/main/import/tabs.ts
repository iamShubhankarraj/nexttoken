import fs from 'node:fs';
import path from 'node:path';
import { parseFile as parseBplistFile } from 'bplist-parser';
import type { DetectedBrowser } from './browsers';
import { cleanUrl, deniedError, isDeniedError, normalizeUrlKey } from './util';

export interface ImportedTab {
  title: string;
  url: string;
  pinned: boolean;
}
export interface TabImport {
  tabs: ImportedTab[];
  /** True when the source is a snapshot/approximation rather than live tab state. */
  approximate: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Chromium SNSS session files — best-effort minimal reader
// ---------------------------------------------------------------------------

export interface SnssTab {
  url: string;
  title: string;
  pinned: boolean;
}

/** Bounds-checked reader over a Chromium base::Pickle payload. */
export class PickleReader {
  private pos: number;
  constructor(
    private readonly buf: Buffer,
    start = 0
  ) {
    this.pos = start;
  }

  skip(bytes: number): void {
    this.ensure(bytes);
    this.pos += bytes;
  }

  readInt32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Pickle string: int32 byte-length, raw bytes, padded to 4. */
  readString(): string {
    const len = this.readInt32();
    if (len < 0) throw new RangeError('negative string length');
    this.ensure(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    this.align();
    return s;
  }

  /** Pickle string16: int32 code-unit count, UTF-16LE bytes, padded to 4. */
  readString16(): string {
    const units = this.readInt32();
    if (units < 0) throw new RangeError('negative string16 length');
    this.ensure(units * 2);
    const s = this.buf.toString('utf16le', this.pos, this.pos + units * 2);
    this.pos += units * 2;
    this.align();
    return s;
  }

  private align(): void {
    this.pos = (this.pos + 3) & ~3;
  }

  private ensure(bytes: number): void {
    if (bytes < 0 || this.pos + bytes > this.buf.length) throw new RangeError('pickle out of bounds');
  }
}

const SNSS_MAGIC = 'SNSS';
const CMD_UPDATE_TAB_NAVIGATION = 6;
const CMD_SET_TAB_PINNED = 20;

/**
 * Minimal SNSS parser. Extracts per-tab {url, title, pinned} from
 * kCommandUpdateTabNavigation (type 6) and kCommandSetTabPinned (type 20).
 * Last write wins per tab, approximating the current navigation.
 * Never throws on malformed input — returns whatever was decoded.
 */
export function parseSnss(data: Buffer): SnssTab[] {
  const tabs = new Map<number, SnssTab>();
  try {
    if (data.length < 4 || data.toString('ascii', 0, 4) !== SNSS_MAGIC) return [];
    let pos = 4;
    while (pos + 6 <= data.length) {
      const size = data.readUInt32LE(pos);
      const type = data.readUInt16LE(pos + 4);
      if (size < 4 || size > data.length - pos - 6) break; // corrupt command stream
      const payload = data.subarray(pos + 6, pos + 6 + size);
      pos += 6 + size;
      try {
        if (type === CMD_UPDATE_TAB_NAVIGATION) {
          const r = new PickleReader(payload);
          r.skip(4); // pickle payload-size prefix
          const tabId = r.readInt32();
          r.readInt32(); // navigation index (unused)
          const url = r.readString(); // TabNavigation.virtual_url
          let title = '';
          try {
            r.readString(); // referrer (discarded)
            title = r.readString16(); // TabNavigation.title
          } catch {
            // title is best-effort; url is what matters
          }
          const existing = tabs.get(tabId);
          tabs.set(tabId, { url, title: title || existing?.title || '', pinned: existing?.pinned ?? false });
        } else if (type === CMD_SET_TAB_PINNED) {
          const r = new PickleReader(payload);
          r.skip(4);
          const tabId = r.readInt32();
          const pinned = r.readInt32() !== 0;
          const existing = tabs.get(tabId);
          if (existing) existing.pinned = pinned;
          else tabs.set(tabId, { url: '', title: '', pinned });
        }
      } catch {
        continue; // skip malformed command, keep parsing the stream
      }
    }
  } catch {
    // fall through with whatever we decoded
  }
  return [...tabs.values()].filter((t) => t.url.length > 0);
}

async function newestMatchingFile(dir: string, re: RegExp): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(dir);
    return null;
  }
  let best: string | null = null;
  let bestMtime = -1;
  for (const entry of entries) {
    if (!entry.isFile() || !re.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const st = await fs.promises.stat(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

async function findSessionFile(profileDir: string): Promise<string | null> {
  const sessionsDir = path.join(profileDir, 'Sessions');
  let found = await newestMatchingFile(sessionsDir, /^Session_/);
  if (!found) found = await newestMatchingFile(sessionsDir, /^Tabs_/);
  if (!found) {
    for (const name of ['Current Session', 'Last Session']) {
      const candidate = path.join(profileDir, name);
      try {
        const st = await fs.promises.stat(candidate);
        if (st.isFile()) {
          found = candidate;
          break;
        }
      } catch (e) {
        if (isDeniedError(e)) throw deniedError(candidate);
      }
    }
  }
  return found;
}

function collectTabs(snssTabs: SnssTab[], warnings: string[]): ImportedTab[] {
  const tabs: ImportedTab[] = [];
  const seen = new Set<string>();
  for (const t of snssTabs) {
    const url = cleanUrl(t.url);
    if (!url) continue;
    const key = normalizeUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ title: t.title.trim() || url, url, pinned: t.pinned });
  }
  return tabs;
}

async function readChromiumTabs(browser: DetectedBrowser): Promise<TabImport> {
  const warnings: string[] = [];
  let sessionFile: string | null;
  try {
    sessionFile = await findSessionFile(browser.profileDir);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('FILE_ACCESS_DENIED')) throw e;
    warnings.push('Could not list the profile Sessions directory.');
    return { tabs: [], approximate: false, warnings };
  }
  if (!sessionFile) {
    warnings.push('No Chromium session file found; this profile may never have been launched.');
    return { tabs: [], approximate: false, warnings };
  }
  let data: Buffer;
  try {
    data = await fs.promises.readFile(sessionFile);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(sessionFile);
    warnings.push('The session file could not be read (the browser may be running).');
    return { tabs: [], approximate: false, warnings };
  }
  const parsed = parseSnss(data);
  if (parsed.length === 0) {
    warnings.push('The session file uses an SNSS layout this parser does not understand; no tabs imported.');
  }
  return { tabs: collectTabs(parsed, warnings), approximate: false, warnings };
}

// ---------------------------------------------------------------------------
// Arc — pinned tabs from the StorableSidebar JSON
// ---------------------------------------------------------------------------

/** Pure parser for Arc's StorableSidebar JSON. Every item with data.tab.savedURL becomes a pinned tab. */
export function parseArcSidebarJson(text: string): ImportedTab[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Arc sidebar file is not valid JSON');
  }
  const containers = (data as { sidebar?: { containers?: unknown } })?.sidebar?.containers;
  if (!Array.isArray(containers)) throw new Error('Arc sidebar file has no sidebar.containers array');
  const tabs: ImportedTab[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    const items = (container as { items?: unknown })?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const tab = (item as { data?: { tab?: { savedURL?: unknown; savedTitle?: unknown } } })?.data?.tab;
      const url = cleanUrl(tab?.savedURL);
      if (!url) continue;
      const key = normalizeUrlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const rawTitle = tab?.savedTitle;
      const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : url;
      tabs.push({ title, url, pinned: true });
    }
  }
  return tabs;
}

async function readArcTabs(browser: DetectedBrowser): Promise<TabImport> {
  const warnings: string[] = [];
  if (!browser.sidebarFile) {
    warnings.push('No Arc sidebar file (StorableSidebar*.json) found; no pinned tabs imported.');
    return { tabs: [], approximate: false, warnings };
  }
  let text: string;
  try {
    text = await fs.promises.readFile(browser.sidebarFile, 'utf8');
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(browser.sidebarFile);
    warnings.push('The Arc sidebar file could not be read.');
    return { tabs: [], approximate: false, warnings };
  }
  try {
    return { tabs: parseArcSidebarJson(text), approximate: false, warnings };
  } catch {
    warnings.push('The Arc sidebar file could not be parsed.');
    return { tabs: [], approximate: false, warnings };
  }
}

// ---------------------------------------------------------------------------
// Firefox — sessionstore.jsonlz4 (mozLz4 header + raw LZ4 block)
// ---------------------------------------------------------------------------

/**
 * Minimal LZ4 *block* decompressor (no frame header — exactly what
 * sessionstore.jsonlz4 carries after its 8-byte magic).
 */
export function decompressLz4Block(input: Buffer): Buffer {
  let out = Buffer.alloc(Math.max(input.length * 4, 64));
  let ip = 0;
  let op = 0;
  const ensure = (need: number): void => {
    if (op + need > out.length) {
      const grown = Buffer.alloc(Math.max(out.length * 2, op + need));
      out.copy(grown, 0, 0, op);
      out = grown;
    }
  };
  while (ip < input.length) {
    const token = input[ip++];
    let literalLen = token >>> 4;
    if (literalLen === 15) {
      let b: number;
      do {
        if (ip >= input.length) throw new Error('lz4: truncated literal length');
        b = input[ip++];
        literalLen += b;
      } while (b === 255);
    }
    ensure(literalLen);
    if (ip + literalLen > input.length) throw new Error('lz4: truncated literals');
    input.copy(out, op, ip, ip + literalLen);
    ip += literalLen;
    op += literalLen;
    if (ip >= input.length) break; // last sequence has literals only
    if (ip + 2 > input.length) throw new Error('lz4: truncated offset');
    const offset = input.readUInt16LE(ip);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('lz4: invalid match offset');
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b: number;
      do {
        if (ip >= input.length) throw new Error('lz4: truncated match length');
        b = input[ip++];
        matchLen += b;
      } while (b === 255);
    }
    ensure(matchLen);
    let mp = op - offset;
    for (let i = 0; i < matchLen; i++) out[op++] = out[mp++];
  }
  return out.subarray(0, op);
}

/** Pure parser for sessionstore.jsonlz4 bytes. Exported for tests. */
export function parseSessionstoreJsonlz4(data: Buffer): ImportedTab[] {
  if (data.length < 9) throw new Error('sessionstore file too small');
  if (data.subarray(0, 8).toString('latin1') !== 'mozLz40\0') throw new Error('not a mozLz4 file');
  const store = JSON.parse(decompressLz4Block(data.subarray(8)).toString('utf8')) as {
    windows?: { tabs?: { pinned?: unknown; entries?: { url?: unknown; title?: unknown }[] }[] }[];
  };
  const tabs: ImportedTab[] = [];
  const seen = new Set<string>();
  const windows = Array.isArray(store?.windows) ? store.windows : [];
  for (const w of windows) {
    const wtabs = Array.isArray(w?.tabs) ? w.tabs : [];
    for (const t of wtabs) {
      const entries = Array.isArray(t?.entries) ? t.entries : [];
      const entry = entries[entries.length - 1]; // current navigation
      const url = cleanUrl(entry?.url);
      if (!url) continue;
      const key = normalizeUrlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const rawTitle = entry?.title;
      tabs.push({
        title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : url,
        url,
        pinned: t?.pinned === true,
      });
    }
  }
  return tabs;
}

async function readFirefoxTabs(browser: DetectedBrowser): Promise<TabImport> {
  const warnings: string[] = [];
  const file = path.join(browser.profileDir, 'sessionstore.jsonlz4');
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(file);
    warnings.push('No Firefox sessionstore.jsonlz4 found for this profile.');
    return { tabs: [], approximate: false, warnings };
  }
  try {
    return { tabs: parseSessionstoreJsonlz4(data), approximate: false, warnings };
  } catch {
    warnings.push('The Firefox sessionstore file could not be decoded.');
    return { tabs: [], approximate: false, warnings };
  }
}

// ---------------------------------------------------------------------------
// Safari — LastSession.plist (last-quit snapshot; always approximate)
// ---------------------------------------------------------------------------

const SAFARI_URL_KEYS = ['URLString', 'URL', 'TabURL', 'url'];

function scanSafariSessionTabs(node: unknown, out: ImportedTab[], seen: Set<string>, depth: number): void {
  if (node == null || depth > 14) return;
  if (Array.isArray(node)) {
    for (const v of node) scanSafariSessionTabs(v, out, seen, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const dict = node as Record<string, unknown>;
  let matched = false;
  for (const key of SAFARI_URL_KEYS) {
    const url = cleanUrl(dict[key]);
    if (url && /^https?:\/\//i.test(url)) {
      const nkey = normalizeUrlKey(url);
      if (!seen.has(nkey)) {
        seen.add(nkey);
        const titleDict = dict['URIDictionary'] as Record<string, unknown> | undefined;
        const rawTitle = titleDict?.['Title'] ?? dict['Title'] ?? dict['title'];
        out.push({
          title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : url,
          url,
          pinned: false,
        });
      }
      matched = true;
      break;
    }
  }
  if (!matched) {
    for (const v of Object.values(dict)) scanSafariSessionTabs(v, out, seen, depth + 1);
  }
}

async function readSafariTabs(browser: DetectedBrowser): Promise<TabImport> {
  const warnings: string[] = [];
  const plistPath = path.join(browser.profileDir, 'LastSession.plist');
  let root: unknown;
  try {
    [root] = await parseBplistFile(plistPath);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(plistPath);
    warnings.push('Safari LastSession.plist could not be read or parsed.');
    return { tabs: [], approximate: true, warnings };
  }
  const tabs: ImportedTab[] = [];
  try {
    scanSafariSessionTabs(root, tabs, new Set<string>(), 0);
  } catch {
    // best-effort scan; keep whatever was collected
  }
  if (tabs.length === 0) {
    warnings.push('No tabs could be extracted from the Safari last-session snapshot.');
  } else {
    warnings.push('Safari tabs come from the last-quit snapshot and may not match currently open tabs.');
  }
  return { tabs, approximate: true, warnings };
}

// ---------------------------------------------------------------------------

/**
 * Read open tabs for a detected browser. Never throws except on macOS
 * file-access denial (Error with message "FILE_ACCESS_DENIED:<path>");
 * everything else becomes warnings (possibly with zero tabs).
 */
export async function readTabs(browser: DetectedBrowser): Promise<TabImport> {
  switch (browser.kind) {
    case 'chromium':
      return readChromiumTabs(browser);
    case 'arc':
      return readArcTabs(browser);
    case 'firefox':
      return readFirefoxTabs(browser);
    case 'safari':
      return readSafariTabs(browser);
  }
}
