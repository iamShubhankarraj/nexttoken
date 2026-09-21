/** Shared helpers for the browser-import feature (bookmarks + tabs). */

export function isDeniedError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

export function deniedError(filePath: string): Error {
  return new Error('FILE_ACCESS_DENIED:' + filePath);
}

/**
 * Clean a raw URL for import. Returns null when the value should not be
 * imported (empty, non-string, javascript:/data: URLs).
 */
export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const scheme = trimmed.split(':')[0]?.toLowerCase() ?? '';
  if (scheme === 'javascript' || scheme === 'data') return null;
  return trimmed;
}

/**
 * Canonical key used for dedupe: lowercase host, no default port, trailing
 * slashes stripped (root "/" kept), utm_* query params removed, params sorted.
 */
export function normalizeUrlKey(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    const p = u.pathname;
    u.pathname = p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
    return u.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Cap a warnings list at `max` entries, appending an overflow note. */
export function capWarnings(warnings: string[], max = 20): string[] {
  if (warnings.length <= max) return warnings;
  return [...warnings.slice(0, max), `...and ${warnings.length - max} more`];
}
