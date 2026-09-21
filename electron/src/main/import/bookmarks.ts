import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFile as parseBplistFile } from 'bplist-parser';
import type { DetectedBrowser } from './browsers';
import { cleanUrl, deniedError, isDeniedError, normalizeUrlKey } from './util';

export interface BookmarkItem {
  title: string;
  url: string;
}
export interface BookmarkFolder {
  path: string;
  items: BookmarkItem[];
}
export interface BookmarkImport {
  folders: BookmarkFolder[];
  warnings: string[];
}

/** Accumulates bookmarks across files/roots, deduping by normalized URL. */
class BookmarkCollector {
  private folders = new Map<string, BookmarkItem[]>();
  private seen = new Set<string>();
  private skippedDupes = 0;
  warnings: string[] = [];

  add(folderPath: string, title: string, url: string): void {
    const cleaned = cleanUrl(url);
    if (!cleaned) return;
    const key = normalizeUrlKey(cleaned);
    if (this.seen.has(key)) {
      this.skippedDupes++;
      return;
    }
    this.seen.add(key);
    let items = this.folders.get(folderPath);
    if (!items) {
      items = [];
      this.folders.set(folderPath, items);
    }
    items.push({ title: title.trim() || cleaned, url: cleaned });
  }

  toImport(): BookmarkImport {
    const folders: BookmarkFolder[] = [...this.folders.entries()].map(([folderPath, items]) => ({
      path: folderPath,
      items,
    }));
    const warnings = [...this.warnings];
    if (this.skippedDupes > 0) {
      warnings.push(`Skipped ${this.skippedDupes} duplicate bookmark(s) found within this browser's own data.`);
    }
    return { folders, warnings };
  }
}

// ---------------------------------------------------------------------------
// Chromium (Chrome / Brave / Edge / Arc)
// ---------------------------------------------------------------------------

const CHROMIUM_ROOT_NAMES: Record<string, string> = {
  bookmark_bar: 'Bookmarks bar',
  other: 'Other bookmarks',
  synced: 'Mobile bookmarks',
};

function walkChromiumChildren(children: unknown[], folderPath: string, collector: BookmarkCollector): void {
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    if (node['type'] === 'url') {
      collector.add(folderPath, String(node['name'] ?? ''), String(node['url'] ?? ''));
    } else if (node['type'] === 'folder' && Array.isArray(node['children'])) {
      const name = String(node['name'] ?? '').trim() || 'Untitled';
      walkChromiumChildren(
        node['children'] as unknown[],
        folderPath ? `${folderPath}/${name}` : name,
        collector
      );
    }
  }
}

/** Pure parser: turns a Chromium Bookmarks JSON document into collected folders. Exported for tests. */
export function parseChromiumBookmarksJson(text: string, collector: BookmarkCollector): void {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    collector.warnings.push('A Chromium Bookmarks file could not be parsed as JSON.');
    return;
  }
  const roots = (data as { roots?: unknown })?.roots;
  if (!roots || typeof roots !== 'object') {
    collector.warnings.push('A Chromium Bookmarks file has no "roots" section.');
    return;
  }
  for (const [rootKey, label] of Object.entries(CHROMIUM_ROOT_NAMES)) {
    const root = (roots as Record<string, unknown>)[rootKey] as { children?: unknown } | undefined;
    if (root && Array.isArray(root.children)) {
      walkChromiumChildren(root.children as unknown[], label, collector);
    }
  }
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(filePath);
    return null;
  }
}

async function readChromiumBookmarks(browser: DetectedBrowser): Promise<BookmarkImport> {
  const collector = new BookmarkCollector();
  const main = await readFileOrNull(path.join(browser.profileDir, 'Bookmarks'));
  if (!main) {
    collector.warnings.push('No Chromium Bookmarks file found for this profile.');
    return collector.toImport();
  }
  parseChromiumBookmarksJson(main.toString('utf8'), collector);
  const account = await readFileOrNull(path.join(browser.profileDir, 'AccountBookmarks'));
  if (account) parseChromiumBookmarksJson(account.toString('utf8'), collector);
  return collector.toImport();
}

// ---------------------------------------------------------------------------
// Safari (Bookmarks.plist)
// ---------------------------------------------------------------------------

function safariNodeTitle(node: Record<string, unknown>): string {
  const dict = node['URIDictionary'] as Record<string, unknown> | undefined;
  const title = dict?.['Title'] ?? node['Title'] ?? node['title'];
  return typeof title === 'string' ? title.trim() : '';
}

function walkSafariNode(node: unknown, folderPath: string, collector: BookmarkCollector): void {
  if (!node || typeof node !== 'object') return;
  const entry = node as Record<string, unknown>;
  const type = entry['WebBookmarkType'];
  if (type === 'WebBookmarkTypeLeaf') {
    collector.add(folderPath, safariNodeTitle(entry), String(entry['URLString'] ?? ''));
    return;
  }
  if (type === 'WebBookmarkTypeList' && Array.isArray(entry['Children'])) {
    const title = safariNodeTitle(entry);
    if (title === 'Reading List') return; // skip the whole Reading List subtree
    const next = title ? (folderPath ? `${folderPath}/${title}` : title) : folderPath;
    for (const child of entry['Children'] as unknown[]) walkSafariNode(child, next, collector);
  }
}

/** Pure walker over an already-parsed Safari Bookmarks.plist root. Exported for tests. */
export function walkSafariBookmarks(root: unknown): BookmarkImport {
  const collector = new BookmarkCollector();
  const children = (root as { Children?: unknown })?.Children;
  if (!Array.isArray(children)) {
    collector.warnings.push('Safari Bookmarks.plist has an unexpected structure.');
    return collector.toImport();
  }
  for (const child of children) walkSafariNode(child, '', collector);
  return collector.toImport();
}

async function readSafariBookmarks(browser: DetectedBrowser): Promise<BookmarkImport> {
  const plistPath = path.join(browser.profileDir, 'Bookmarks.plist');
  let root: unknown;
  try {
    [root] = await parseBplistFile(plistPath);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(plistPath);
    const collector = new BookmarkCollector();
    collector.warnings.push('Safari Bookmarks.plist could not be parsed.');
    return collector.toImport();
  }
  return walkSafariBookmarks(root);
}

// ---------------------------------------------------------------------------
// Firefox (places.sqlite via /usr/bin/sqlite3 — never opened in place)
// ---------------------------------------------------------------------------

const FIREFOX_BOOKMARK_SQL =
  'SELECT b.title, p.url, b.parent FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE p.url IS NOT NULL';
const FIREFOX_FOLDERS_SQL = 'SELECT id, title, parent FROM moz_bookmarks WHERE type = 2';
const SQLITE3 = '/usr/bin/sqlite3';

// moz_bookmarks well-known parent ids
const FIREFOX_ROOT_NAMES: Record<number, string> = {
  1: 'Bookmarks Menu',
  2: 'Bookmarks Toolbar',
  3: 'Other Bookmarks',
};
const FIREFOX_TAGS_ID = 4;

function querySqliteJson(dbPath: string, sql: string): unknown[] {
  const out = execFileSync(SQLITE3, ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  const parsed: unknown = JSON.parse(out || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

async function readFirefoxBookmarks(browser: DetectedBrowser): Promise<BookmarkImport> {
  const collector = new BookmarkCollector();
  const src = path.join(browser.profileDir, 'places.sqlite');
  try {
    await fs.promises.stat(src);
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(src);
    collector.warnings.push('Firefox places.sqlite was not found for this profile.');
    return collector.toImport();
  }
  if (!fs.existsSync(SQLITE3)) {
    collector.warnings.push('The sqlite3 CLI is not available; Firefox bookmarks were skipped.');
    return collector.toImport();
  }

  // Copy the DB (plus WAL/SHM sidecars when present) to a temp dir; never open in place.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nt-ff-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await fs.promises.copyFile(src + suffix, path.join(tmpDir, 'places.sqlite' + suffix));
      } catch (e) {
        if (suffix === '') throw e; // -wal/-shm are optional
      }
    }
    const tmpDb = path.join(tmpDir, 'places.sqlite');
    let rows: unknown[];
    let folderRows: unknown[];
    try {
      rows = querySqliteJson(tmpDb, FIREFOX_BOOKMARK_SQL);
      folderRows = querySqliteJson(tmpDb, FIREFOX_FOLDERS_SQL);
    } catch {
      collector.warnings.push('Firefox places.sqlite could not be queried.');
      return collector.toImport();
    }

    const folders = new Map<number, { title: string; parent: number }>();
    for (const f of folderRows) {
      const row = f as Record<string, unknown>;
      const id = Number(row['id']);
      if (Number.isFinite(id)) folders.set(id, { title: String(row['title'] ?? 'Untitled'), parent: Number(row['parent']) });
    }
    const pathCache = new Map<number, string | null>();
    const folderPath = (id: number): string | null => {
      if (pathCache.has(id)) return pathCache.get(id) as string | null;
      const parts: string[] = [];
      const seenIds = new Set<number>();
      let cur = id;
      for (;;) {
        if (cur === FIREFOX_TAGS_ID) {
          pathCache.set(id, null);
          return null;
        }
        const rootName = FIREFOX_ROOT_NAMES[cur];
        if (rootName) {
          parts.unshift(rootName);
          break;
        }
        const folder = folders.get(cur);
        if (!folder || seenIds.has(cur)) break;
        seenIds.add(cur);
        parts.unshift(folder.title || 'Untitled');
        cur = folder.parent;
      }
      const folderPathStr = parts.join('/');
      pathCache.set(id, folderPathStr);
      return folderPathStr;
    };

    let skippedTags = 0;
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const parent = Number(row['parent']);
      if (parent === FIREFOX_TAGS_ID) {
        skippedTags++;
        continue;
      }
      const fp = folderPath(parent);
      if (fp == null) {
        skippedTags++;
        continue;
      }
      collector.add(fp, String(row['title'] ?? ''), String(row['url'] ?? ''));
    }
    if (skippedTags > 0) {
      collector.warnings.push(`Skipped ${skippedTags} tag ${skippedTags === 1 ? 'entry' : 'entries'} (tags are not real bookmarks).`);
    }
  } catch (e) {
    if (isDeniedError(e)) throw deniedError(src);
    collector.warnings.push('Firefox places.sqlite could not be read.');
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return collector.toImport();
}

// ---------------------------------------------------------------------------

/**
 * Read bookmarks for a detected browser. Never throws except on macOS
 * file-access denial (Error with message "FILE_ACCESS_DENIED:<path>");
 * everything else becomes warnings.
 */
export async function readBookmarks(browser: DetectedBrowser): Promise<BookmarkImport> {
  switch (browser.kind) {
    case 'chromium':
    case 'arc':
      return readChromiumBookmarks(browser);
    case 'safari':
      return readSafariBookmarks(browser);
    case 'firefox':
      return readFirefoxBookmarks(browser);
  }
}
