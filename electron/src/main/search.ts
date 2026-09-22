/**
 * search.ts — search-engine configuration (main side).
 *
 * store.d.searchEngine keeps working as the effective template string (it is
 * what TabManager.resolveInput consumes); store.d.searchEngineId records
 * which preset — or 'custom' — it came from. Existing profiles migrate on
 * read: a template matching a preset is claimed by that preset, anything
 * else becomes Custom. All renderer traffic goes through guardedHandle.
 */

import { guardedHandle } from './ipcGuard';
import {
  CUSTOM_ENGINE_ID,
  SEARCH_ENGINE_PRESETS,
  presetById,
  presetForTemplate,
} from '../shared/searchEngines';
import type { Store } from './store';
import type { SearchEngineConfig } from '../shared/ipc';

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
