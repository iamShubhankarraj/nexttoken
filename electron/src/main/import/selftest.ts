/**
 * Self-test for the browser-import parsers. Runs the pure parsers against
 * synthetic fixtures and prints PASS/FAIL counts. No real browser data is
 * touched and no URLs/titles are printed (counts only).
 *
 * Run: compile with tsc to CommonJS, then node the output:
 *   npx tsc src/main/import/selftest.ts --outDir /tmp/nt-import-test \
 *     --module commonjs --target ES2022 --moduleResolution node \
 *     --esModuleInterop --skipLibCheck
 *   node /tmp/nt-import-test/selftest.js
 */
import { cleanUrl, normalizeUrlKey } from './util';
import type { BookmarkImport } from './bookmarks';
import { parseChromiumBookmarksJson, walkSafariBookmarks } from './bookmarks';
import { decompressLz4Block, parseArcSidebarJson, parseSessionstoreJsonlz4, parseSnss } from './tabs';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    process.stderr.write(`FAIL: ${name}\n`);
  }
}

// ---------------------------------------------------------------- util ---

check(
  'normalize: lowercase host, strip utm, strip trailing slash',
  normalizeUrlKey('https://Example.COM/path/?utm_source=x&b=2') === 'https://example.com/path?b=2'
);
check('normalize: root keeps single slash', normalizeUrlKey('https://example.com/') === 'https://example.com/');
check('normalize: http default port dropped', normalizeUrlKey('http://example.com:80/a/') === 'http://example.com/a');
check('cleanUrl: blank -> null', cleanUrl('   ') === null);
check('cleanUrl: javascript: -> null', cleanUrl('javascript:alert(1)') === null);
check('cleanUrl: trims', cleanUrl('  https://a.com  ') === 'https://a.com');

// ------------------------------------------------------- chromium bookmarks ---

const FAKE_BOOKMARKS = JSON.stringify({
  roots: {
    bookmark_bar: {
      children: [
        { id: '1', name: 'Docs', type: 'url', url: 'https://example.com/docs' },
        {
          id: '2',
          name: 'Work',
          type: 'folder',
          children: [
            { id: '3', name: 'CI', type: 'url', url: 'https://ci.example.com/?utm_campaign=x' },
            { id: '4', name: 'CI dupe', type: 'url', url: 'https://ci.example.com/' },
            { id: '5', name: 'evil', type: 'url', url: 'javascript:alert(1)' },
          ],
        },
      ],
    },
    other: { children: [{ id: '6', name: 'Blog', type: 'url', url: 'https://blog.example.com' }] },
    synced: { children: [] },
  },
});

// The public parser takes a BookmarkCollector instance, which is not exported;
// exercise it through a structural stand-in instead:
function parseChromiumViaPublic(text: string): BookmarkImport {
  // Minimal structural double of the internal collector (same add() contract).
  const folders = new Map<string, { title: string; url: string }[]>();
  const seen = new Set<string>();
  const warnings: string[] = [];
  const double = {
    add(folderPath: string, title: string, url: string): void {
      const cleaned = cleanUrl(url);
      if (!cleaned) return;
      const key = normalizeUrlKey(cleaned);
      if (seen.has(key)) return;
      seen.add(key);
      const arr = folders.get(folderPath) ?? [];
      arr.push({ title: title.trim() || cleaned, url: cleaned });
      folders.set(folderPath, arr);
    },
    warnings,
    toImport(): BookmarkImport {
      return { folders: [...folders.entries()].map(([p, items]) => ({ path: p, items })), warnings };
    },
  };
  parseChromiumBookmarksJson(text, double as never);
  return double.toImport();
}

{
  const imp = parseChromiumViaPublic(FAKE_BOOKMARKS);
  const total = imp.folders.reduce((n, f) => n + f.items.length, 0);
  check('chromium bookmarks: drops js: and internal dupes (3 items)', total === 3);
  check(
    'chromium bookmarks: folder path "Bookmarks bar/Work"',
    imp.folders.some((f) => f.path === 'Bookmarks bar/Work' && f.items.length === 1)
  );
  check(
    'chromium bookmarks: "Other bookmarks" root walked',
    imp.folders.some((f) => f.path === 'Other bookmarks' && f.items.length === 1)
  );
  check('chromium bookmarks: bad JSON -> warning', parseChromiumViaPublic('nope').warnings.length === 1);
}

// ------------------------------------------------------------- safari plist ---

{
  const root = {
    Children: [
      { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://a.example/', URIDictionary: { Title: 'A' } },
      {
        WebBookmarkType: 'WebBookmarkTypeList',
        Title: 'Favs',
        Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://b.example/', title: 'B fallback' }],
      },
      {
        WebBookmarkType: 'WebBookmarkTypeList',
        Title: 'Reading List',
        Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://r.example/', URIDictionary: { Title: 'R' } }],
      },
    ],
  };
  const imp = walkSafariBookmarks(root);
  const total = imp.folders.reduce((n, f) => n + f.items.length, 0);
  check('safari plist: Reading List subtree skipped (2 items)', total === 2);
  check('safari plist: folder path "Favs"', imp.folders.some((f) => f.path === 'Favs'));
  check(
    'safari plist: title fallback chain',
    imp.folders.some((f) => f.items.some((i) => i.title === 'B fallback'))
  );
}

// ----------------------------------------------------------------- arc tabs ---

{
  const sidebar = JSON.stringify({
    sidebar: {
      containers: [
        {
          items: [
            { id: 'i1', data: { tab: { savedTitle: 'Pinned One', savedURL: 'https://one.example/' } } },
            { id: 'i2', data: {} },
            { id: 'i3', data: { tab: { savedTitle: 'Pinned One', savedURL: 'https://one.example/' } } },
          ],
        },
      ],
    },
  });
  const tabs = parseArcSidebarJson(sidebar);
  check('arc sidebar: only items with savedURL, deduped (1 tab)', tabs.length === 1);
  check('arc sidebar: pinned=true', tabs[0]?.pinned === true);
  check('arc sidebar: title from savedTitle', tabs[0]?.title === 'Pinned One');
  let threw = false;
  try {
    parseArcSidebarJson('{"nope":true}');
  } catch {
    threw = true;
  }
  check('arc sidebar: missing containers -> throws', threw);
}

// ------------------------------------------------------------------ lz4/snss ---

function lz4CompressLiterals(data: Buffer): Buffer {
  // Minimal compressor: one literals-only sequence (no matches).
  const parts: Buffer[] = [];
  let len = data.length;
  let token = 0xf0;
  parts.push(Buffer.from([token]));
  len -= 15;
  while (len >= 255) {
    parts.push(Buffer.from([255]));
    len -= 255;
  }
  parts.push(Buffer.from([len < 0 ? 0 : len]));
  parts.push(data);
  return Buffer.concat(parts);
}

{
  const original = Buffer.from('hello lz4 world, this is a slightly longer literal run for testing');
  const round = decompressLz4Block(lz4CompressLiterals(original));
  check('lz4: literals-only roundtrip', round.equals(original));
}

{
  // Hand-crafted: literals "abcdef", then match offset 6, match length 6.
  const crafted = Buffer.from([0x62, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x06, 0x00]);
  check('lz4: match copy', decompressLz4Block(crafted).toString('utf8') === 'abcdefabcdef');
}

{
  const store = {
    windows: [
      {
        tabs: [
          {
            pinned: true,
            entries: [
              { url: 'https://a.example/1', title: 'A1' },
              { url: 'https://a.example/2', title: 'A2' },
            ],
          },
          { entries: [{ url: 'https://b.example/', title: 'B' }] },
          { entries: [] },
        ],
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(store), 'utf8');
  const file = Buffer.concat([Buffer.from('mozLz40\0', 'latin1'), lz4CompressLiterals(json)]);
  const tabs = parseSessionstoreJsonlz4(file);
  check('sessionstore: 2 tabs (empty entries skipped)', tabs.length === 2);
  check('sessionstore: last entry wins', tabs[0]?.url === 'https://a.example/2' && tabs[0]?.title === 'A2');
  check('sessionstore: pinned preserved', tabs[0]?.pinned === true && tabs[1]?.pinned === false);
  let threw = false;
  try {
    parseSessionstoreJsonlz4(Buffer.from('garbage'));
  } catch {
    threw = true;
  }
  check('sessionstore: bad magic -> throws', threw);
}

// ------------------------------------------------------------ snss builder ---

function pickleString(s: Buffer | string): Buffer {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = Buffer.alloc(4);
  len.writeInt32LE(b.length, 0);
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([len, b, Buffer.alloc(pad)]);
}

function pickleString16(s: string): Buffer {
  const b = Buffer.from(s, 'utf16le');
  const units = Buffer.alloc(4);
  units.writeInt32LE(s.length, 0);
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([units, b, Buffer.alloc(pad)]);
}

function pickleInt(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
}

function snssCommand(type: number, pickleBody: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeInt32LE(pickleBody.length, 0); // pickle payload-size prefix
  const pickle = Buffer.concat([header, pickleBody]);
  const cmd = Buffer.alloc(6);
  cmd.writeUInt32LE(pickle.length, 0);
  cmd.writeUInt16LE(type, 4);
  return Buffer.concat([cmd, pickle]);
}

{
  const tabNav = (tabId: number, url: string, title: string): Buffer =>
    Buffer.concat([
      pickleInt(tabId),
      pickleInt(0), // navigation index
      pickleString(url), // virtual_url
      pickleString(''), // referrer
      pickleString16(title), // title
    ]);
  const file = Buffer.concat([
    Buffer.from('SNSS', 'ascii'),
    snssCommand(6, tabNav(7, 'https://example.com/ab', 'Example AB')), // 21-byte url: tests padding
    snssCommand(20, Buffer.concat([pickleInt(7), pickleInt(1)])), // pinned
    snssCommand(6, tabNav(8, 'https://other.example/', 'Other')),
    snssCommand(6, tabNav(7, 'https://example.com/ab/v2', 'Example AB v2')), // last write wins
    snssCommand(99, Buffer.from([1, 2, 3, 4])), // unknown command: skipped
  ]);
  const tabs = parseSnss(file);
  check('snss: 2 tabs decoded', tabs.length === 2);
  const t7 = tabs.find((t) => t.url === 'https://example.com/ab/v2');
  check('snss: last UpdateTabNavigation wins', t7?.title === 'Example AB v2');
  check('snss: pinned flag from type-20 command', t7?.pinned === true);
  const t8 = tabs.find((t) => t.url === 'https://other.example/');
  check('snss: unpinned tab defaults pinned=false', t8?.pinned === false);
  check('snss: garbage -> []', parseSnss(Buffer.from('definitely not snss')).length === 0);
  check('snss: truncated stream -> no throw', parseSnss(Buffer.from('SNSS\x06\x00', 'latin1')).length === 0);
}

// ------------------------------------------------------------------ summary ---

process.stdout.write(`selftest: PASS ${passed}, FAIL ${failed}\n`);
if (failed > 0) process.exitCode = 1;
