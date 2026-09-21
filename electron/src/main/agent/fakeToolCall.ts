/**
 * fakeToolCall — detect and neutralize roleplayed tool calls.
 *
 * Some models answer a tool-bearing turn with TEXT that looks like a tool
 * call instead of using the tool-call channel:
 *
 *   ```tool_code
 *   run_terminal(command='flipkart', working_directory='/home/user')
 *   ```
 *
 * or bare `open_tab(url='https://flipkart.com')` prose. There is no
 * `tool_code` convention anywhere in the product — rendering that text as a
 * completed action is dishonest: it looks like the agent did something while
 * nothing ran. The agent loop feeds detected calls through the REAL
 * approval-gated executor instead, or says plainly that nothing happened.
 *
 * This module is deliberately dependency-free (no electron imports) so the
 * regression test can bundle it with esbuild and run it on plain node.
 */

export interface DetectedFakeCall {
  /** Tool name, matched against the known tool list. */
  name: string;
  /** Parsed arguments (Python-ish kwarg syntax tolerated). */
  args: Record<string, unknown>;
  /** The exact source text the call was parsed from. */
  raw: string;
}

/**
 * Fenced roleplay blocks. The fence language is always `tool_code` in the
 * wild — a plain ``` fence with a `name(...)` line inside does NOT count,
 * so genuine code samples are never hijacked.
 */
const FENCE_RE = /```tool_code[ \t]*\r?\n([\s\S]*?)```/gi;
/** Any fenced code block (used to keep code samples out of bare detection). */
const ANY_FENCE_RE = /```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Parameter aliases the models invent; mapped to the real tool params. */
const ARG_ALIASES: Record<string, string> = {
  working_directory: 'cwd',
  working_dir: 'cwd',
  dir: 'cwd',
};

/**
 * Parse `key=value, ...` kwargs. Tolerates single/double quotes, Python
 * literals (True/False/None), numbers, and bare strings. Returns null when
 * the text is not shaped like a call's argument list.
 */
function parseKwargs(src: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  // Split top-level commas (ignore commas inside quotes).
  const parts: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      cur += c;
      if (c === q && src[i - 1] !== '\\') q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);

  for (const part of parts) {
    const m = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/);
    if (!m) {
      // A bare positional arg — not a shape we execute; bail on the call.
      if (part.trim()) return null;
      continue;
    }
    const key = ARG_ALIASES[m[1]] ?? m[1];
    const raw = m[2].trim();
    args[key] = parseValue(raw);
  }
  return args;
}

function parseValue(raw: string): unknown {
  const sq = raw.match(/^'(.*)'$/s);
  if (sq) return sq[1].replace(/\\'/g, "'");
  const dq = raw.match(/^"(.*)"$/s);
  if (dq) return dq[1].replace(/\\"/g, '"');
  if (raw === 'True') return true;
  if (raw === 'False') return false;
  if (raw === 'None' || raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Find `name(...)` call expressions in `text` whose name is a known tool.
 * Handles one level of nested parens inside the argument list.
 */
function findCalls(text: string, known: Set<string>): DetectedFakeCall[] {
  const out: DetectedFakeCall[] = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!known.has(name)) continue;
    // Extract the balanced paren group starting at m.index + m[0].length - 1.
    let depth = 0;
    let q: string | null = null;
    let end = -1;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < text.length && i < start + 1200; i++) {
      const c = text[i];
      if (q) {
        if (c === q && text[i - 1] !== '\\') q = null;
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const argSrc = text.slice(start + 1, end);
    const args = parseKwargs(argSrc);
    if (!args) continue;
    out.push({ name, args, raw: text.slice(m.index, end + 1) });
    re.lastIndex = end + 1;
  }
  return out;
}

/**
 * Detect roleplayed tool calls in a model turn's text. Returns the calls in
 * source order (fenced blocks first, then bare call syntax). Only names in
 * `knownNames` are ever matched, so prose about unknown functions is safe.
 */
export function detectFakeToolCalls(text: string, knownNames: readonly string[]): DetectedFakeCall[] {
  if (!text) return [];
  const known = new Set(knownNames);
  const out: DetectedFakeCall[] = [];
  const seen = new Set<string>();
  let fm: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((fm = FENCE_RE.exec(text)) !== null) {
    for (const c of findCalls(fm[1], known)) {
      if (!seen.has(c.raw)) {
        seen.add(c.raw);
        out.push(c);
      }
    }
  }
  // Bare call syntax outside ANY fenced code block (e.g. "I'll call
  // open_tab(url='...')"). Code samples inside plain fences are never
  // treated as intended invocations.
  ANY_FENCE_RE.lastIndex = 0;
  const prose = text.replace(ANY_FENCE_RE, '');
  for (const c of findCalls(prose, known)) {
    if (!seen.has(c.raw)) {
      seen.add(c.raw);
      out.push(c);
    }
  }
  return out;
}

/** Remove fenced ```tool_code blocks from text (the narration stays). */
export function stripFakeToolCalls(text: string): string {
  FENCE_RE.lastIndex = 0;
  return text.replace(FENCE_RE, '').trim();
}

/**
 * True when the text still contains a ```tool_code fence that did NOT parse
 * into a real call — the model was roleplaying, but its intent is ambiguous.
 */
export function hasUnparsedToolCodeFence(text: string, knownNames: readonly string[]): boolean {
  if (!text) return false;
  FENCE_RE.lastIndex = 0;
  const fences = [...text.matchAll(FENCE_RE)];
  if (fences.length === 0) return false;
  const known = new Set(knownNames);
  return fences.some((fm) => findCalls(fm[1], known).length === 0);
}
