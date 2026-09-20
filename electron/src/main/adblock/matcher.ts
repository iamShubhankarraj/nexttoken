/**
 * Hand-rolled EasyList-subset matcher for the native ad blocker.
 *
 * Parses the bundled filter text (see filters.ts) into compiled rules and
 * tests request URLs against them. Pure TypeScript, no dependencies.
 *
 * Supported syntax: comments (!, [), @@ exceptions, || domain anchors,
 * | anchors, * wildcards, ^ separator placeholders, and $ options:
 * third-party / ~third-party / first-party, domain= includes/excludes,
 * and resource types (script, image, stylesheet, font, media, object,
 * xmlhttprequest, subdocument, websocket, ping, other, document).
 */

export interface MatchContext {
  /** Top-level page URL — used for third-party and domain= checks. */
  pageUrl?: string;
  /** Electron webRequest resourceType, e.g. 'script', 'image', 'xhr'. */
  resourceType?: string;
}

interface CompiledRule {
  exception: boolean;
  re: RegExp;
  /** Electron resource types this rule applies to; null = all. */
  types: string[] | null;
  /** null = either party, true = third-party only, false = first-party only. */
  thirdParty: boolean | null;
  includeDomains: string[];
  excludeDomains: string[];
}

/** ABP type option -> Electron webRequest resourceType. */
const TYPE_MAP: Record<string, string> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  font: 'font',
  media: 'media',
  object: 'object',
  xmlhttprequest: 'xhr',
  subdocument: 'sub_frame',
  websocket: 'websocket',
  ping: 'ping',
  other: 'other',
  document: 'main_frame',
};

const ALL_TYPES = Object.values(TYPE_MAP);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert an EasyList rule body (options stripped) to a regex source.
 * `||` anchors to a domain (+ subdomains); `|` anchors to string
 * start/end; `*` is a wildcard; `^` matches a URL separator or end.
 */
function bodyToSource(body: string): string {
  let domainAnchored = false;
  let anchoredStart = false;
  let anchoredEnd = false;
  if (body.startsWith('||')) {
    domainAnchored = true;
    body = body.slice(2);
  } else if (body.startsWith('|')) {
    anchoredStart = true;
    body = body.slice(1);
  }
  if (body.endsWith('|')) {
    anchoredEnd = true;
    body = body.slice(0, -1);
  }
  let src = '';
  for (const ch of body) {
    if (ch === '*') src += '.*';
    else if (ch === '^') src += '(?:[^\\w\\-.~%]|$)';
    else src += escapeRe(ch);
  }
  if (domainAnchored) {
    return '^[a-z][a-z0-9+.-]*://(?:[^/:?#]+\\.)?' + src;
  }
  return (anchoredStart ? '^' : '') + src + (anchoredEnd ? '$' : '');
}

export function parseFilters(text: string): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    let exception = false;
    let rest = line;
    if (rest.startsWith('@@')) {
      exception = true;
      rest = rest.slice(2);
    }
    // Options separator: first '$' (the bundled list never has '$' in paths).
    let body = rest;
    let optStr = '';
    const di = rest.indexOf('$');
    if (di !== -1) {
      body = rest.slice(0, di);
      optStr = rest.slice(di + 1);
    }
    if (!body) continue;
    // Regex rules (/.../) are not supported by this matcher — skipped.
    if (body.length > 2 && body.startsWith('/') && body.endsWith('/')) continue;
    let re: RegExp;
    try {
      re = new RegExp(bodyToSource(body), 'i');
    } catch {
      continue; // malformed rule — ignore, never crash the blocker
    }
    const rule: CompiledRule = {
      exception, re, types: null, thirdParty: null,
      includeDomains: [], excludeDomains: [],
    };
    if (optStr) {
      const types: string[] = [];
      const notTypes: string[] = [];
      for (const tok of optStr.split(',')) {
        const t = tok.trim();
        if (!t) continue;
        if (t === 'third-party') rule.thirdParty = true;
        else if (t === '~third-party' || t === 'first-party') rule.thirdParty = false;
        else if (t.startsWith('domain=')) {
          for (const d of t.slice('domain='.length).split('|')) {
            const dd = d.trim().toLowerCase();
            if (!dd) continue;
            if (dd.startsWith('~')) rule.excludeDomains.push(dd.slice(1));
            else rule.includeDomains.push(dd);
          }
        } else if (t.startsWith('~') && TYPE_MAP[t.slice(1)]) {
          notTypes.push(TYPE_MAP[t.slice(1)]);
        } else if (TYPE_MAP[t]) {
          types.push(TYPE_MAP[t]);
        }
        // Unknown options (match-case, donottrack, csp, ...) are ignored.
      }
      if (types.length > 0) rule.types = types;
      else if (notTypes.length > 0) rule.types = ALL_TYPES.filter((x) => !notTypes.includes(x));
    }
    rules.push(rule);
  }
  return rules;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith('.' + pattern);
}

export class FilterMatcher {
  private rules: CompiledRule[];

  constructor(filterText: string) {
    this.rules = parseFilters(filterText);
  }

  get size(): number {
    return this.rules.length;
  }

  /**
   * True when the URL should be blocked. Exception rules always win.
   * Fail-open: non-http(s) URLs and missing hosts are never blocked.
   */
  matches(url: string, ctx: MatchContext = {}): boolean {
    const reqHost = hostOf(url);
    if (!reqHost) return false;
    const pageHost = ctx.pageUrl ? hostOf(ctx.pageUrl) : '';
    // No page context (data:/blank pages, early navigations): treat the
    // request as third-party so $third-party rules still apply.
    const isThirdParty = pageHost
      ? reqHost !== pageHost && !reqHost.endsWith('.' + pageHost)
      : true;

    let blocked = false;
    for (const r of this.rules) {
      if (r.types && ctx.resourceType && !r.types.includes(ctx.resourceType)) continue;
      if (r.thirdParty === true && !isThirdParty) continue;
      if (r.thirdParty === false && isThirdParty) continue;
      if (r.includeDomains.length > 0 || r.excludeDomains.length > 0) {
        if (!pageHost) continue;
        if (r.excludeDomains.some((d) => domainMatches(pageHost, d))) continue;
        if (
          r.includeDomains.length > 0 &&
          !r.includeDomains.some((d) => domainMatches(pageHost, d))
        ) continue;
      }
      if (!r.re.test(url)) continue;
      if (r.exception) return false;
      blocked = true;
    }
    return blocked;
  }
}
