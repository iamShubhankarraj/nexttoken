/**
 * searchEngines.ts — search engine presets, keyword shortcuts, URL building.
 *
 * Pure module (no Electron, no DOM): safe to import from main, the preload
 * boundary, and the renderer.
 *
 * Templates support a %s placeholder for the query; a template without %s
 * gets the encoded query appended (that is what TabManager.resolveInput
 * does on the main side).
 */

export interface SearchEnginePreset {
  /** Stable id, persisted as store.d.searchEngineId. */
  id: string;
  name: string;
  /** First-token shortcut: typing "ddg query" searches DuckDuckGo. */
  keyword: string;
  /** Query template (%s or bare-append style). */
  template: string;
  /** Suggest-as-you-type endpoint template (%s = query), null if unsupported. */
  suggest: string | null;
  blurb: string;
}

export const SEARCH_ENGINE_PRESETS: SearchEnginePreset[] = [
  {
    id: 'google',
    name: 'Google',
    keyword: 'g',
    template: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
    blurb: 'The default. Fast suggestions, broadest index.',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    keyword: 'brv',
    template: 'https://search.brave.com/search?q=%s',
    suggest: 'https://search.brave.com/api/suggest?q=%s',
    blurb: 'Independent index, no profiling.',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    keyword: 'ddg',
    template: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?q=%s&type=list',
    blurb: 'Privacy-first metasearch.',
  },
  {
    id: 'startpage',
    name: 'Startpage',
    keyword: 'sp',
    template: 'https://www.startpage.com/sp/search?query=%s',
    suggest: 'https://www.startpage.com/suggestions?q=%s',
    blurb: 'Google results without the tracking.',
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    keyword: 'eco',
    template: 'https://www.ecosia.org/search?q=%s',
    suggest: null,
    blurb: 'Searches that plant trees. No suggest API — local matches only.',
  },
];

/** store.d.searchEngineId value for a freeform template. */
export const CUSTOM_ENGINE_ID = 'custom';

export function presetById(id: string): SearchEnginePreset | undefined {
  return SEARCH_ENGINE_PRESETS.find((p) => p.id === id);
}

export function presetByKeyword(keyword: string): SearchEnginePreset | undefined {
  const k = keyword.trim().toLowerCase();
  if (!k) return undefined;
  return SEARCH_ENGINE_PRESETS.find((p) => p.keyword === k);
}

/**
 * Match a stored template string to a preset. Tolerates the two template
 * styles: %s placeholders and trailing-append ("…q=") templates.
 */
export function presetForTemplate(template: string): SearchEnginePreset | undefined {
  const norm = (t: string) => t.replace('%s', '').replace(/=+$/, '=').toLowerCase();
  const n = norm(template);
  if (!n) return undefined;
  return SEARCH_ENGINE_PRESETS.find((p) => norm(p.template) === n);
}

/** Build a search URL from a template: %s substitution, else append. */
export function buildSearchUrl(template: string, query: string): string {
  const q = encodeURIComponent(query);
  return template.includes('%s') ? template.replace('%s', q) : template + q;
}

/**
 * Parse a leading keyword shortcut: "g cats", "ddg what is rust".
 * Returns the preset + query, or null when there is no keyword or no query.
 */
export function parseEngineKeyword(
  input: string,
): { preset: SearchEnginePreset; query: string } | null {
  const m = /^(\S+)\s+(.+?)\s*$/.exec(input.trim());
  if (!m) return null;
  const preset = presetByKeyword(m[1]);
  if (!preset || !m[2]) return null;
  return { preset, query: m[2] };
}

/** Suggest endpoint URL for a preset + query, or null when unsupported. */
export function suggestUrl(preset: SearchEnginePreset, query: string): string | null {
  if (!preset.suggest) return null;
  return preset.suggest.replace('%s', encodeURIComponent(query));
}
