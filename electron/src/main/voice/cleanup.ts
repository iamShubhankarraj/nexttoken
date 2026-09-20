/**
 * Transcript cleanup for voice dictation — pure, dependency-free functions.
 *
 * Ported from Flow (https://github.com/jgvilchezc/flow, MIT, Copyright (c)
 * 2026 Jose Gabriel Vilchez — see electron/THIRD-PARTY-NOTICES.md):
 *   - `tryQuickClean`  ← src-tauri/src/quickclean.rs
 *   - `stripReasoning` ← src-tauri/src/format.rs :: strip_reasoning
 *   - `keepsSpeakerWords` ← src-tauri/src/format.rs :: keeps_speaker_words
 *
 * Design (unchanged from Flow): a short, plain utterance ("send the report
 * tomorrow") only needs a filler strip, a capital letter, and a final period.
 * `tryQuickClean` is deliberately cautious — it returns null (defer to the
 * LLM cleanup pass) whenever the input might need real restructuring:
 * anything long, enumerated, or carrying spoken punctuation/formatting
 * commands. When it returns a string, it only removes unambiguous fillers
 * and fixes capitalization + terminal period; it never reorders words.
 */

/** Single-word fillers safe to drop anywhere — unambiguous hesitations. */
const ANYWHERE_FILLERS = new Set(["um", "uh", "uhm"]);

/**
 * Single-word fillers dropped only when they *lead* the sentence — as real
 * words ("so big", "make it like this") they carry meaning mid-sentence.
 * "este" is the Spanish demonstrative "this" (content word: "quiero este
 * informe"); "eh" is virtually always a leading hesitation. Both only strip
 * when leading.
 */
const LEADING_FILLERS = new Set(["like", "so", "bueno", "pues", "este", "eh"]);

/** Two-word fillers dropped anywhere. */
const MULTIWORD_FILLERS: Array<readonly [string, string]> = [
  ["you", "know"],
  ["o", "sea"],
];

/**
 * Spoken enumeration / list / punctuation markers. Their presence means the
 * utterance needs LLM-level restructuring, so quick-clean bails out.
 */
const MARKER_WORDS = new Set([
  "first", "second", "primero", "segundo", // explicit list requests
  "list", "lista", // spoken punctuation commands
  "comma", "coma", "period", "punto",
]);

/** Multi-word markers (newline commands). */
const MARKER_PHRASES = ["new line", "nueva línea", "nueva linea"];

/** Lowercase a token with outer punctuation trimmed (interior kept). */
function norm(token: string): string {
  return token.replace(/^[^a-z0-9áéíóúñü]+|[^a-z0-9áéíóúñü]+$/gi, "").toLowerCase();
}

/** True for a digit-run followed by `.` or `)` — a spoken list index like `1.` */
function isDigitEnumeration(token: string): boolean {
  return /^\d+[.)]$/.test(token);
}

function hasMarkers(tokens: string[]): boolean {
  const joined = tokens.map(norm).join(" ");
  if (MARKER_PHRASES.some((p) => joined.includes(p))) return true;
  return tokens.some((t) => isDigitEnumeration(t) || MARKER_WORDS.has(norm(t)));
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  const [first, ...rest] = [...s];
  return first.toLocaleUpperCase() + rest.join("");
}

function hasTerminalPunctuation(s: string): boolean {
  return /[.?!…]$/.test(s);
}

/**
 * Attempt a fast rule-based cleanup of `text`.
 * Returns null (defer to the LLM formatter) when disabled, the text is
 * empty, the word count reaches `maxWords`, or the text carries any
 * list/command marker.
 */
export function tryQuickClean(text: string, maxWords: number, enabled: boolean): string | null {
  if (!enabled) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  // Eligibility gate on the *original* word count: >= maxWords → LLM.
  if (tokens.length >= maxWords) return null;
  if (hasMarkers(tokens)) return null;

  const cleaned = clean(tokens);
  if (!cleaned) return null; // input was nothing but fillers — let the LLM decide
  return cleaned;
}

function clean(tokens: string[]): string {
  // 1. Drop two-word fillers anywhere.
  const withoutMulti: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (i + 1 < tokens.length) {
      const a = norm(tokens[i]);
      const b = norm(tokens[i + 1]);
      if (MULTIWORD_FILLERS.some(([x, y]) => a === x && b === y)) {
        i += 2;
        continue;
      }
    }
    withoutMulti.push(tokens[i]);
    i += 1;
  }

  // 2. Strip leading fillers (leading-only + anywhere) from the front.
  let start = 0;
  while (start < withoutMulti.length) {
    const n = norm(withoutMulti[start]);
    if (ANYWHERE_FILLERS.has(n) || LEADING_FILLERS.has(n)) start += 1;
    else break;
  }

  // 3. Drop interior anywhere-fillers from what remains.
  const kept = withoutMulti.slice(start).filter((t) => !ANYWHERE_FILLERS.has(norm(t)));
  if (kept.length === 0) return "";

  const joined = kept.join(" ");
  const capitalized = capitalizeFirst(joined);
  return hasTerminalPunctuation(capitalized) ? capitalized : `${capitalized}.`;
}

/**
 * Strip a `<think>…</think>` reasoning block from LLM output (small local
 * models sometimes emit one despite the system prompt).
 */
export function stripReasoning(text: string): string {
  const start = text.indexOf("<think>");
  const end = text.indexOf("</think>");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(0, start) + text.slice(end + "</think>".length);
  }
  return text;
}

/**
 * Vocabulary guard: cleaned dictation keeps most of the speaker's words.
 * When a small model slips into assistant mode ("Okay, I understand…") or
 * invents content, its output shares almost no vocabulary with the
 * transcript — those outputs are rejected in favor of the raw text.
 */
export function keepsSpeakerWords(transcript: string, formatted: string): boolean {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9áéíóúñü]+/i)
        .filter((w) => w.length > 0),
    );
  const spoken = words(transcript);
  const output = words(formatted);
  if (output.size === 0) return false;
  let kept = 0;
  for (const w of output) if (spoken.has(w)) kept += 1;
  return kept * 2 >= output.size; // at least half the output vocabulary was spoken
}

/**
 * Decide whether a non-empty formatter output is trusted or discarded in
 * favor of the raw transcript.
 */
export function acceptFormatterOutput(transcript: string, formatted: string): boolean {
  const t = formatted.trim();
  if (!t) return false;
  return keepsSpeakerWords(transcript, t);
}

/** Count fillers removed between raw and cleaned text (for the UI toast). */
export function countFillersRemoved(raw: string, cleaned: string): number {
  const rawWords = raw.trim().split(/\s+/).length;
  const cleanWords = cleaned.trim().split(/\s+/).length;
  return Math.max(0, rawWords - cleanWords);
}
