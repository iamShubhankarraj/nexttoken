import { detectBrowsers, type DetectedBrowser } from './browsers';
import { readBookmarks } from './bookmarks';
import { readTabs } from './tabs';
import { capWarnings, normalizeUrlKey } from './util';

export interface ImportDeps {
  spaceId: string;
  addBookmark(spaceId: string, name: string, url: string, folder?: string): void;
  createTab(url: string): string; // returns new tab id
  pinTab(tabId: string): void;
  existingBookmarkUrls(spaceId: string): Set<string>; // normalized
  existingTabUrls(spaceId: string): Set<string>;
}

export interface ImportReport {
  bookmarksAdded: number;
  bookmarksSkippedDupes: number;
  tabsOpened: number;
  tabsPinned: number;
  warnings: string[];
}

function newReport(): ImportReport {
  return { bookmarksAdded: 0, bookmarksSkippedDupes: 0, tabsOpened: 0, tabsPinned: 0, warnings: [] };
}

async function findBrowser(browserId: string): Promise<DetectedBrowser> {
  const browsers = await detectBrowsers();
  const browser = browsers.find((b) => b.id === browserId);
  if (!browser) throw new Error(`Unknown browser id: ${browserId}`);
  if (browser.accessDenied) throw new Error('FILE_ACCESS_DENIED:' + browser.profileDir);
  return browser;
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length < 20) warnings.push(message);
}

/**
 * Import bookmarks from a detected browser into a space.
 * Dupes (against existing bookmarks and within this import) are counted and
 * warned about, never silently dropped. Throws FILE_ACCESS_DENIED on TCC denial.
 */
export async function importBookmarks(browserId: string, deps: ImportDeps): Promise<ImportReport> {
  const report = newReport();
  const browser = await findBrowser(browserId);
  const imp = await readBookmarks(browser); // throws FILE_ACCESS_DENIED itself
  report.warnings.push(...imp.warnings);

  const existing = deps.existingBookmarkUrls(deps.spaceId);
  const seen = new Set<string>();
  for (const folder of imp.folders) {
    for (const item of folder.items) {
      const key = normalizeUrlKey(item.url);
      if (existing.has(key) || seen.has(key)) {
        report.bookmarksSkippedDupes++;
        pushWarning(report.warnings, `Skipped duplicate bookmark: ${item.title}`);
        continue;
      }
      seen.add(key);
      try {
        deps.addBookmark(deps.spaceId, item.title, item.url, folder.path || undefined);
        report.bookmarksAdded++;
      } catch {
        report.bookmarksSkippedDupes++;
        pushWarning(report.warnings, `Could not add bookmark: ${item.title}`);
      }
    }
  }
  report.warnings = capWarnings(report.warnings);
  return report;
}

/**
 * Import open tabs from a detected browser into a space.
 * Pinned source tabs arrive as App Store entries. Dupes are counted and
 * warned about. Throws FILE_ACCESS_DENIED on TCC denial.
 */
export async function importTabs(browserId: string, deps: ImportDeps): Promise<ImportReport> {
  const report = newReport();
  const browser = await findBrowser(browserId);
  const imp = await readTabs(browser); // throws FILE_ACCESS_DENIED itself
  report.warnings.push(...imp.warnings);
  if (imp.approximate) {
    pushWarning(report.warnings, 'Tab list is approximate (restored from a saved snapshot).');
  }

  const existing = deps.existingTabUrls(deps.spaceId);
  const seen = new Set<string>();
  for (const tab of imp.tabs) {
    const key = normalizeUrlKey(tab.url);
    if (existing.has(key) || seen.has(key)) {
      report.bookmarksSkippedDupes++;
      pushWarning(report.warnings, `Skipped duplicate tab: ${tab.title}`);
      continue;
    }
    seen.add(key);
    try {
      const tabId = deps.createTab(tab.url);
      report.tabsOpened++;
      if (tab.pinned) {
        deps.pinTab(tabId);
        report.tabsPinned++;
      }
    } catch {
      report.bookmarksSkippedDupes++;
      pushWarning(report.warnings, `Could not open tab: ${tab.title}`);
    }
  }
  report.warnings = capWarnings(report.warnings);
  return report;
}
