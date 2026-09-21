/**
 * task-models.ts — the single source of truth for per-task model assignment.
 *
 * Four slots, each with exactly one job:
 *   transcription → Whisper (local STT, fixed local-first — never cloud)
 *   agent         → the user's active model (Apple FM → GGUF → cloud BYOK,
 *                   user-configurable via the Agent tab switcher)
 *   speech        → Kokoro (local TTS, fixed local-first — never cloud)
 *   vision        → a downloaded vision-language model from the catalog
 *                   ('none' until the user downloads one; 'cloud' is an
 *                   explicit opt-in per slot, never the default)
 *
 * Assignments persist in store.d.models.taskModels. The vision ref is one of:
 *   'none'            — no vision model; vision tasks raise VisionRequiredError
 *   'cloud'           — the first usable BYOK cloud provider
 *   '<catalog id>'    — a downloaded vision entry (validated on set)
 * The legacy 'applefm'/'apple-fm' spelling is tolerated on read.
 *
 * VisionRequiredError is the typed "vision slot is empty" signal. It crosses
 * IPC as an Error whose message starts with VISION_REQUIRED_PREFIX, so the
 * renderer can recognise it with isVisionRequiredError() without importing
 * this module.
 */

import type { Store } from '../store';
import type { TaskModelSlotInfo, TaskSlot } from '../../shared/ipc';
import { MODEL_CATALOG, type ModelEntry } from './index';

export type { TaskSlot };

export const VISION_NONE = 'none';
export const VISION_CLOUD = 'cloud';

/** IPC-safe marker: every VisionRequiredError message starts with this. */
export const VISION_REQUIRED_PREFIX = 'VISION_MODEL_REQUIRED';

export class VisionRequiredError extends Error {
  constructor() {
    super(
      `${VISION_REQUIRED_PREFIX}: no vision model is downloaded. ` +
        'Download a vision model in Settings → Models → Vision (the 256M experimental ' +
        'build is only ~235 MB), then ask again.'
    );
    this.name = 'VisionRequiredError';
  }
}

/** True for a VisionRequiredError, including one that crossed IPC as a plain Error. */
export function isVisionRequiredError(e: unknown): boolean {
  if (e instanceof VisionRequiredError) return true;
  if (e instanceof Error) {
    return e.name === 'VisionRequiredError' || e.message.startsWith(VISION_REQUIRED_PREFIX);
  }
  return typeof e === 'string' && e.startsWith(VISION_REQUIRED_PREFIX);
}

/** The persisted vision assignment, normalised to the canonical spelling. */
export function getVisionRef(store: Store): string {
  const raw = store.d.models.taskVision ?? VISION_NONE;
  if (raw === 'applefm') return 'apple-fm';
  return raw;
}

/**
 * Assign the vision slot. Throws when the ref is unknown or the model is
 * not downloaded. 'none' and 'cloud' are always valid.
 */
export function setVisionRef(store: Store, ref: string): void {
  const clean = String(ref ?? '').trim();
  if (clean === VISION_NONE || clean === VISION_CLOUD) {
    store.d.models.taskVision = clean;
  } else if (clean === 'apple-fm' || clean === 'applefm') {
    // Apple Foundation Models has no image input — keep the spelling for
    // text-only vision turns, but visionDescribe() will still refuse.
    store.d.models.taskVision = 'apple-fm';
  } else {
    const entry = MODEL_CATALOG.find((e) => e.id === clean && e.task === 'vision');
    if (!entry) throw new Error(`Unknown vision model "${clean}".`);
    if (!store.d.models.downloaded[clean]) {
      throw new Error(`"${entry.name}" is not downloaded yet — download it first.`);
    }
    store.d.models.taskVision = clean;
  }
  // Keep the legacy assignment field in sync for older UI builds.
  store.d.models.assignment.vision = store.d.models.taskVision;
  store.saveSoon();
}

export type VisionResolution =
  | { kind: 'none' }
  | { kind: 'cloud' }
  | { kind: 'applefm' }
  | { kind: 'local'; entry: ModelEntry };

/** Resolve the vision slot to something the router can execute. */
export function resolveVisionModel(store: Store): VisionResolution {
  const ref = getVisionRef(store);
  if (ref === VISION_NONE) return { kind: 'none' };
  if (ref === VISION_CLOUD) return { kind: 'cloud' };
  if (ref === 'apple-fm') return { kind: 'applefm' };
  const entry = MODEL_CATALOG.find((e) => e.id === ref && e.task === 'vision');
  if (entry && store.d.models.downloaded[ref]) return { kind: 'local', entry };
  // The model was removed after assignment — treat the slot as empty rather
  // than failing over silently to a different model.
  return { kind: 'none' };
}

/** First downloaded entry for a catalog task ('stt' / 'tts'), if any. */
export function firstDownloadedEntry(store: Store, task: 'stt' | 'tts' | 'vision'): ModelEntry | null {
  for (const e of MODEL_CATALOG) {
    if (e.task === task && store.d.models.downloaded[e.id]) return e;
  }
  return null;
}

/** Every task slot and what currently serves it — for Settings → Models. */
export function describeTaskModels(
  store: Store,
  appleFmAvailable: boolean
): TaskModelSlotInfo[] {
  const stt = firstDownloadedEntry(store, 'stt');
  const tts = firstDownloadedEntry(store, 'tts');
  const vision = resolveVisionModel(store);
  const active = store.d.models.activeModel;
  const activeLabel =
    active.kind === 'local-applefm'
      ? 'Apple Foundation Models'
      : active.kind === 'local'
        ? (MODEL_CATALOG.find((e) => e.id === active.id)?.name ?? active.id ?? 'Local model')
        : (store.d.providers.find((p) => p.id === active.id)?.name ?? 'Cloud provider');

  let visionLabel: string;
  let visionDetail: string;
  let visionAvailable: boolean;
  let visionHint: string | undefined;
  switch (vision.kind) {
    case 'local':
      visionLabel = vision.entry.name;
      visionDetail = `On-device · ${vision.entry.params} ${vision.entry.quant}`.trim();
      visionAvailable = true;
      break;
    case 'cloud':
      visionLabel = 'Cloud (BYOK)';
      visionDetail = 'First usable cloud provider';
      visionAvailable = store.d.providers.some((p) => p.enabled && p.baseUrl && p.model);
      visionHint = visionAvailable ? undefined : 'No usable cloud provider — configure one in Settings → AI Provider.';
      break;
    case 'applefm':
      visionLabel = 'Apple Foundation Models';
      visionDetail = 'On-device · macOS (text only — no image input)';
      visionAvailable = appleFmAvailable;
      visionHint = appleFmAvailable ? undefined : 'Apple Foundation Models is not available on this Mac.';
      break;
    default:
      visionLabel = 'No vision model';
      visionDetail = 'Vision tasks will ask you to download one';
      visionAvailable = false;
      visionHint = 'Download a vision model below (the experimental 256M build is ~235 MB).';
      break;
  }

  return [
    {
      slot: 'transcription',
      title: 'Speech to text',
      description: 'Transcribes your voice into text. Always on-device, never sent to the cloud.',
      label: stt ? `Whisper ${stt.name.replace(/^Whisper\s*/i, '')}`.trim() : 'Whisper (not downloaded)',
      detail: stt ? `On-device · ${stt.params}` : 'Download a Whisper model below',
      available: !!stt,
      ref: stt?.id ?? 'none',
      missingHint: stt ? undefined : 'Voice input needs a Whisper model — download one below.',
    },
    {
      slot: 'agent',
      title: 'Agent',
      description: 'Thinks, plans, and drives the browser. Change it in the Agent tab model switcher.',
      label: activeLabel,
      detail:
        active.kind === 'local-applefm'
          ? 'On-device · macOS'
          : active.kind === 'local'
            ? 'On-device'
            : 'Cloud · BYOK',
      available: true,
      ref:
        active.kind === 'local-applefm'
          ? 'apple-fm'
          : active.kind === 'local'
            ? (active.id ?? 'none')
            : `cloud:${active.id ?? ''}`,
    },
    {
      slot: 'speech',
      title: 'Text to speech',
      description: 'Speaks agent replies aloud. Always on-device Kokoro — there is no system-voice fallback.',
      label: tts ? tts.name : 'Kokoro (not downloaded)',
      detail: tts ? `On-device · ${tts.params}` : 'Download the Kokoro TTS model below',
      available: !!tts,
      ref: tts?.id ?? 'none',
      missingHint: tts ? undefined : 'Spoken replies need the Kokoro TTS model — download it below.',
    },
    {
      slot: 'vision',
      title: 'Vision',
      description: 'Sees your screen for "what is on my screen" and visual grounding.',
      label: visionLabel,
      detail: visionDetail,
      available: visionAvailable,
      ref:
        vision.kind === 'local'
          ? vision.entry.id
          : vision.kind === 'cloud'
            ? 'cloud'
            : vision.kind === 'applefm'
              ? 'apple-fm'
              : 'none',
      missingHint: visionHint,
    },
  ];
}
