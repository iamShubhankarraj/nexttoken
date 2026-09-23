/**
 * search.ts — search-engine configuration (main side).
 *
 * store.d.searchEngine keeps working as the effective template string (it is
 * what TabManager.resolveInput consumes); store.d.searchEngineId records
 * which preset — or 'custom' — it came from. Existing profiles migrate on
 * read: a template matching a preset is claimed by that preset, anything
 * else becomes Custom. All renderer traffic goes through guardedHandle.
 */

import { net } from 'electron';
import { guardedHandle } from './ipcGuard';
import {
  CUSTOM_ENGINE_ID,
  SEARCH_ENGINE_PRESETS,
  presetById,
  presetForTemplate,
  suggestUrl,
  type SearchEnginePreset,
} from '../shared/searchEngines';
import type { Store } from './store';
import type { SearchEngineConfig } from '../shared/ipc';

const SUGGEST_TIMEOUT_MS = 2500;
const SUGGEST_MAX = 6;
/** Some engines (Brave) 404 non-browser UAs; a real UA is required there. */
const SUGGEST_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/** Tolerant parser: OpenSearch [q,[s…]], DDG ac [{phrase}], or {suggestions:[…]}. */
function parseSuggestPayload(data: unknown): string[] {
  const str = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const p = (v as Record<string, unknown>).phrase;
      if (typeof p === 'string') return p;
    }
    return '';
  };
  if (Array.isArray(data)) {
    if (data.length >= 2 && Array.isArray(data[1])) return data[1].map(str).filter(Boolean);
    return data.map(str).filter(Boolean);
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['suggestions', 'results']) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).map(str).filter(Boolean);
    }
  }
  return [];
}

/**
 * Fetch web suggestions in MAIN (nt.suggest.query).
 *
 * The renderer cannot fetch these itself: the shell CSP (default-src 'self',
 * no connect-src) blocks every cross-origin fetch, and routing suggest
 * requests through a tab's session would leak page cookies. net.fetch uses
 * Chromium's network stack without a session cookie jar unless one opts in.
 * Brave's suggest API requires a real browser UA, which we send for all
 * engines. Failures resolve [] — local matches still work offline.
 */
async function fetchSuggestions(preset: SearchEnginePreset, query: string): Promise<string[]> {
  const url = suggestUrl(preset, query);
  if (!url) return [];
  try {
    const res = await net.fetch(url, {
      signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      headers: {
        'user-agent': SUGGEST_BROWSER_UA,
        accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return parseSuggestPayload(data)
      .filter((s) => s.trim().length > 0)
      .slice(0, SUGGEST_MAX);
  } catch {
    return []; // offline, timeout, or bad payload
  }
}

/** Effective config: preset (or custom template), with store migration. */
export function getSearchEngineConfig(store: Store): SearchEngineConfig {
  const id = store.d.searchEngineId;
  if (id && id !== CUSTOM_ENGINE_ID) {
    const p = presetById(id);
    if (p) {
      return { id: p.id, name: p.name, template: p.template, keyword: p.keyword };
    }
  }
  const template = store.d.searchEngine || '';
  const preset = presetForTemplate(template);
  if (preset) {
    // Old profile whose template matches a preset — claim it silently.
    return { id: preset.id, name: preset.name, template: preset.template, keyword: preset.keyword };
  }
  return { id: CUSTOM_ENGINE_ID, name: 'Custom', template, keyword: null };
}

export function registerSearchIpc(store: Store): void {
  guardedHandle('nt.settings.search-engine.get', (): SearchEngineConfig =>
    getSearchEngineConfig(store),
  );
  // Omnibox web suggestions, proxied through main (see fetchSuggestions).
  guardedHandle(
    'nt.suggest.query',
    (_e, engineId: unknown, query: unknown): Promise<string[]> => {
      const q = String(query ?? '').trim();
      if (q.length < 2 || q.length > 200) return Promise.resolve([]);
      const preset = presetById(String(engineId ?? ''));
      if (!preset) return Promise.resolve([]);
      return fetchSuggestions(preset, q);
    },
  );
  guardedHandle(
    'nt.settings.search-engine.set',
    (_e, id: string, template: string): SearchEngineConfig => {
      const sid = String(id ?? '');
      const preset = presetById(sid);
      if (preset) {
        store.d.searchEngineId = preset.id;
        store.d.searchEngine = preset.template;
      } else {
        const t = String(template ?? '').trim();
        if (!t) throw new Error('Search template must not be empty.');
        store.d.searchEngineId = CUSTOM_ENGINE_ID;
        store.d.searchEngine = t;
      }
      store.saveSoon();
      return getSearchEngineConfig(store);
    },
  );
}

export { SEARCH_ENGINE_PRESETS };
