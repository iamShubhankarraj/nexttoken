import type { WebContents } from 'electron';

export interface SnapElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  type: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapElement[];
  truncated: boolean;
  /** 'cdp' = debugger-protocol DOMSnapshot; 'injected' = JS fallback. */
  via: 'cdp' | 'injected';
}

/**
 * ref -> CDP backendNodeId for the most recent debugger snapshot.
 * Tools prefer CDP actuation when a mapping exists, and fall back to the
 * injected `data-nt-ref` attributes otherwise.
 */
const refToBackend = new Map<number, number>();

export function backendForRef(ref: number): number | undefined {
  return refToBackend.get(ref);
}

const MAX_ELEMENTS = 220;
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'tab', 'switch',
  'combobox', 'searchbox', 'menuitem', 'option',
]);

/**
 * Perceive the active tab via the Chromium debugger protocol:
 * DOMSnapshot.captureSnapshot gives main a real DOM tree (no screenshots
 * needed for most tasks). Falls back to in-page JS extraction when the
 * debugger can't attach (e.g. chrome:// pages, devtools already open).
 *
 * Page content is UNTRUSTED data — the agent loop labels it as such and
 * never lets it override user instructions.
 */
export async function snapshotPage(wc: WebContents | null): Promise<PageSnapshot | null> {
  if (!wc || wc.isDestroyed()) return null;
  const viaCdp = await snapshotViaCdp(wc).catch(() => null);
  if (viaCdp) return viaCdp;
  return snapshotViaInjected(wc);
}

// ---------------------------------------------------------------------------
// Debugger-protocol path
// ---------------------------------------------------------------------------

async function snapshotViaCdp(wc: WebContents): Promise<PageSnapshot | null> {
  const dbg = wc.debugger;
  if (dbg.isAttached()) return null; // don't fight another debugger client
  dbg.attach();
  try {
    const res = (await dbg.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
    })) as {
      strings?: string[];
      documents?: Array<{
        documentURL?: number;
        title?: number;
        nodes: {
          parentIndex: number[];
          nodeType: number[];
          nodeName: number[];
          nodeValue: number[];
          backendNodeId: number[];
          attributes: number[][];
        };
        layout: { nodeIndex: number[]; bounds: number[] };
      }>;
    };
    const doc = res.documents?.[0];
    if (!doc?.nodes) return null;
    return await parseDomSnapshot(wc, res.strings || [], doc);
  } finally {
    try { dbg.detach(); } catch { /* noop */ }
  }
}

async function parseDomSnapshot(
  wc: WebContents,
  strings: string[],
  doc: {
    documentURL?: number;
    title?: number;
    nodes: {
      parentIndex: number[];
      nodeType: number[];
      nodeName: number[];
      nodeValue: number[];
      backendNodeId: number[];
      attributes: number[][];
    };
    layout: { nodeIndex: number[]; bounds: number[] };
  }
): Promise<PageSnapshot> {
  const dbg = wc.debugger;
  const { nodes, layout } = doc;
  const count = nodes.nodeName.length;
  const S = (i: number | undefined): string => (typeof i === 'number' && strings[i] !== undefined ? strings[i] : '');

  const attrs = (i: number): Record<string, string> => {
    const out: Record<string, string> = {};
    const flat = nodes.attributes[i] || [];
    for (let k = 0; k + 1 < flat.length; k += 2) out[S(flat[k]).toLowerCase()] = S(flat[k + 1]);
    return out;
  };

  const children: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < count; i++) {
    const p = nodes.parentIndex[i];
    if (p >= 0 && p < count) children[p].push(i);
  }

  const rendered = new Set<number>();
  for (let l = 0; l < (layout.nodeIndex?.length ?? 0); l++) {
    const ni = layout.nodeIndex[l];
    const w = layout.bounds[l * 4 + 2] ?? 0;
    const h = layout.bounds[l * 4 + 3] ?? 0;
    if (w > 0 && h > 0) rendered.add(ni);
  }

  const textOf = (i: number): string => {
    let t = '';
    for (const c of children[i]) {
      if (nodes.nodeType[c] === 3) t += S(nodes.nodeValue[c]);
    }
    return t.replace(/\s+/g, ' ').trim().slice(0, 90);
  };

  const elements: SnapElement[] = [];
  refToBackend.clear();
  let total = 0;

  for (let i = 0; i < count && elements.length < MAX_ELEMENTS; i++) {
    if (nodes.nodeType[i] !== 1) continue; // elements only
    const tag = S(nodes.nodeName[i]).toLowerCase();
    const a = attrs(i);
    const role = (a['role'] || '').toLowerCase();
    if (!INTERACTIVE_TAGS.has(tag) && !INTERACTIVE_ROLES.has(role)) continue;
    if (tag === 'input' && (a['type'] || '').toLowerCase() === 'hidden') continue;
    if (tag === 'a' && !a['href']) continue;
    total++;
    if (!rendered.has(i)) continue; // not painted — skip
    const ref = elements.length;
    const name = (a['aria-label'] || a['placeholder'] || a['title'] || a['alt'] || textOf(i) || a['value'] || '').slice(0, 90);
    const backendNodeId = nodes.backendNodeId[i];
    elements.push({ ref, tag, role, name, type: a['type'] || '' });
    if (typeof backendNodeId === 'number') {
      refToBackend.set(ref, backendNodeId);
      // Also tag the live element so the JS fallback path keeps working.
      try {
        const { object } = (await dbg.sendCommand('DOM.resolveNode', { backendNodeId })) as { object?: { objectId?: string } };
        if (object?.objectId) {
          await dbg.sendCommand('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `(function(r){ this.setAttribute('data-nt-ref', r); })`,
            arguments: [{ value: String(ref) }],
          });
        }
      } catch { /* per-element tagging is best-effort */ }
    }
  }

  return {
    url: S(doc.documentURL),
    title: S(doc.title),
    elements,
    truncated: total > MAX_ELEMENTS,
    via: 'cdp',
  };
}

// ---------------------------------------------------------------------------
// Injected-JS fallback path (debugger unavailable)
// ---------------------------------------------------------------------------

async function snapshotViaInjected(wc: WebContents): Promise<PageSnapshot | null> {
  try {
    const raw = await wc.executeJavaScript(`(() => {
      try {
        document.querySelectorAll('[data-nt-ref]').forEach(e => e.removeAttribute('data-nt-ref'));
        const out = [];
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight + 200; };
        const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
        const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"], summary';
        let i = 0;
        for (const el of document.querySelectorAll(sel)) {
          if (i >= 220) break;
          if (!vis(el)) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === 'input' && el.type === 'hidden') continue;
          el.setAttribute('data-nt-ref', String(i));
          out.push({ ref: i, tag, role: el.getAttribute('role') || '', name: label(el), type: el.getAttribute('type') || '' });
          i++;
        }
        return { url: location.href, title: document.title, elements: out, total: document.querySelectorAll(sel).length };
      } catch (e) { return { error: String(e) }; }
    })()`);
    if (!raw || raw.error) return null;
    refToBackend.clear();
    return {
      url: String(raw.url ?? ''),
      title: String(raw.title ?? ''),
      elements: (raw.elements ?? []) as SnapElement[],
      truncated: Number(raw.total ?? 0) > MAX_ELEMENTS,
      via: 'injected',
    };
  } catch {
    return null; // e.g. chrome:// pages where script injection is blocked
  }
}

/** Compact text form for the model. */
export function formatSnapshot(s: PageSnapshot): string {
  const lines = [`URL: ${s.url}`, `Title: ${s.title}`, 'Interactive elements (use click/fill with the [ref]):'];
  for (const el of s.elements) {
    const kind = el.role || el.tag;
    const extra = el.type ? ` type=${el.type}` : '';
    lines.push(`[${el.ref}] ${kind}${extra} — "${el.name}"`);
  }
  if (s.truncated) lines.push(`…(list truncated to first ${MAX_ELEMENTS} elements)`);
  if (s.elements.length === 0) lines.push('(no interactive elements found)');
  return lines.join('\n');
}

/** Full visible text, for extract_text / summarize. */
export async function extractPageText(wc: WebContents | null, selector?: string, maxChars = 8000): Promise<string> {
  if (!wc || wc.isDestroyed()) return '';
  try {
    const text = await wc.executeJavaScript(`(() => {
      try {
        const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
        return (el ? el.innerText : '').replace(/\\s+/g, ' ').trim();
      } catch (e) { return ''; }
    })()`);
    const s = String(text ?? '');
    return s.length > maxChars ? s.slice(0, maxChars) + '…[truncated]' : s;
  } catch {
    return '';
  }
}
