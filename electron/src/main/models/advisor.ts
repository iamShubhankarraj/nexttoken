/**
 * Model Advisor: scores the GGUF chat catalog against the detected device
 * and recommends the top models for the in-browser agent use case.
 *
 * Fit math follows llmfit / llmcalculator (see device.ts):
 *  - required = weights (GGUF file size) + KV cache (exact arch math when
 *    the catalog carries layers/kvHeads/headDim, else a conservative
 *    per-parameter estimate) + overhead (max(0.5 GB, 10% of weights))
 *  - utilization u = required / budget with bands:
 *      u ≤ 0.60 → "Fits comfortably", ≤ 0.85 → "Fits",
 *      ≤ 0.98 → "Tight", > 0.98 → "Won't fit"
 *    (the 98% hard cutoff leaves allocator slack so tight fits don't OOM)
 *  - speed is memory-bandwidth-bound: tok/s = (bandwidth / weightsGB) × 0.55
 *
 * Composite score (0–100) = 0.40·fit + 0.25·speed + 0.25·quality + 0.10·ctx
 * plus Next Token bonuses: tool-calling ability and small size, because the
 * browser agent wants agentic models that load fast and leave RAM for tabs.
 */

import type { ModelEntry } from './types';
import type { DeviceInfo } from './device';

export type VerdictBand = 'comfortable' | 'fits' | 'tight' | 'too-big';

export interface AdvisorPick {
  entry: ModelEntry;
  weightsBytes: number;
  kvBytes: number;
  overheadBytes: number;
  requiredBytes: number;
  /** required / device budget */
  utilization: number;
  verdict: VerdictBand;
  verdictLabel: string;
  /** Estimated decode speed; null when the chip bandwidth is unknown. */
  estTokPerSec: number | null;
  /** True when KV math used the conservative estimate instead of arch data. */
  kvEstimated: boolean;
  score: number;
  reasons: string[];
}

export interface AdvisorResult {
  device: DeviceInfo;
  /** Top recommendations, best first (chat-task models only). */
  picks: AdvisorPick[];
  considered: number;
  /** Set when nothing in the catalog fits the device. */
  nothingFits: boolean;
}

const GB = 1024 ** 3;
const ADVISOR_CTX = 8192; // context the fit test assumes

const TOOL_BONUS: Record<string, number> = { excellent: 15, good: 8, partial: 3, none: 0 };
const TOOL_LABEL: Record<string, string> = {
  excellent: 'Excellent tool-calling',
  good: 'Good tool-calling',
  partial: 'Basic tool-calling',
  none: 'No tool-calling',
};

function parseParamsB(params: string): number {
  const m = /([\d.]+)\s*B/i.exec(params);
  if (m) return parseFloat(m[1]);
  const m2 = /([\d.]+)\s*M/i.exec(params);
  if (m2) return parseFloat(m2[1]) / 1000;
  return 1;
}

function quantPenalty(quant: string): number {
  const q = quant.toUpperCase().replace(/_/g, '');
  if (q.includes('Q8')) return 0;
  if (q.includes('Q6')) return 2;
  if (q.includes('Q5')) return 4;
  if (q.includes('Q4')) return 6;
  if (q.includes('Q3')) return 12;
  if (q.includes('Q2')) return 20;
  return 6;
}

/** KV cache bytes at ctx tokens (f16 KV). Exact when arch data exists. */
function kvBytes(entry: ModelEntry, ctx: number): { bytes: number; estimated: boolean } {
  if (entry.layers && entry.kvHeads && entry.headDim) {
    return { bytes: 2 * entry.layers * entry.kvHeads * entry.headDim * ctx * 2, estimated: false };
  }
  // Conservative fallback: ~4.5e-5 bytes per parameter per token (covers
  // typical GQA configs with headroom).
  return { bytes: parseParamsB(entry.params) * 1e9 * 4.5e-5 * ctx, estimated: true };
}

function verdictOf(u: number): { band: VerdictBand; label: string } {
  if (u <= 0.6) return { band: 'comfortable', label: 'Fits comfortably' };
  if (u <= 0.85) return { band: 'fits', label: 'Fits' };
  if (u <= 0.98) return { band: 'tight', label: 'Tight fit' };
  return { band: 'too-big', label: "Won't fit" };
}

function fmtBytes(b: number): string {
  return b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 / 1024)} MB`;
}

function scoreOne(entry: ModelEntry, device: DeviceInfo): AdvisorPick {
  const weightsBytes = entry.sizeBytes;
  const kv = kvBytes(entry, ADVISOR_CTX);
  const overheadBytes = Math.max(0.5 * GB, 0.1 * weightsBytes);
  const requiredBytes = weightsBytes + kv.bytes + overheadBytes;
  const utilization = requiredBytes / Math.max(1, device.budgetBytes);
  const { band, label } = verdictOf(utilization);

  // -- component scores (0–100) -------------------------------------------
  let fitScore: number;
  if (band === 'comfortable') fitScore = utilization >= 0.4 ? 100 : 90;
  else if (band === 'fits') fitScore = 80;
  else if (band === 'tight') fitScore = 45;
  else fitScore = 0;

  const estTokPerSec =
    device.bandwidthGBps !== null && weightsBytes > 0
      ? (device.bandwidthGBps / (weightsBytes / GB)) * 0.55
      : null;
  const speedScore = estTokPerSec === null ? 40 : Math.min(100, (estTokPerSec / 50) * 100);

  const paramsB = Math.max(0.1, parseParamsB(entry.params));
  const qualityScore = Math.max(0, Math.min(100, (Math.log10(paramsB) / Math.log10(32)) * 100 - quantPenalty(entry.quant)));
  const ctxScore = Math.min(100, ((entry.contextTokens ?? 8192) / 32768) * 100);

  let score =
    0.4 * fitScore + 0.25 * speedScore + 0.25 * qualityScore + 0.1 * ctxScore;
  score += TOOL_BONUS[entry.toolCalling ?? 'none'] ?? 0;
  // Browser-agent bonus: small models load fast and leave RAM for tabs.
  if (requiredBytes < 3 * GB) score += 5;
  score = Math.min(100, Math.max(0, score));

  // -- plain-language reasons ----------------------------------------------
  const reasons: string[] = [];
  const budgetLabel = fmtBytes(device.budgetBytes);
  if (band === 'comfortable') {
    reasons.push(`Needs ${fmtBytes(requiredBytes)} of your ${budgetLabel} budget — fits comfortably.`);
  } else if (band === 'fits') {
    reasons.push(`Needs ${fmtBytes(requiredBytes)} of your ${budgetLabel} budget — fits with room to spare.`);
  } else if (band === 'tight') {
    reasons.push(`Needs ${fmtBytes(requiredBytes)} of your ${budgetLabel} budget — tight; expect slowdowns with many tabs open.`);
  } else {
    reasons.push(`Needs ${fmtBytes(requiredBytes)} but your budget is ${budgetLabel} — won't fit.`);
  }
  if (entry.toolCalling === 'excellent') {
    reasons.push(
      requiredBytes < 3 * GB
        ? 'Strongest tool-calling under 3 GB — the best pick for the in-browser agent.'
        : 'Excellent tool-calling — built for agentic work.'
    );
  } else if (entry.toolCalling === 'good') {
    reasons.push('Good tool-calling support for agent tasks.');
  }
  if (estTokPerSec !== null && estTokPerSec >= 20) {
    reasons.push(`Fast on your chip: ~${Math.round(estTokPerSec)} tok/s estimated.`);
  }
  if (entry.sizeBytes < 2 * GB) {
    reasons.push(`Tiny ${fmtBytes(entry.sizeBytes)} download — loads fast, leaves memory for tabs.`);
  }

  return {
    entry,
    weightsBytes,
    kvBytes: kv.bytes,
    overheadBytes,
    requiredBytes,
    utilization,
    verdict: band,
    verdictLabel: label,
    estTokPerSec,
    kvEstimated: kv.estimated,
    score: Math.round(score * 10) / 10,
    reasons,
  };
}

/**
 * Recommend chat models for the device. Returns the top 3 by score among
 * models that aren't hopelessly oversized (tight fits are included but
 * ranked below comfortable ones and clearly labeled).
 */
export function recommendForDevice(catalog: ModelEntry[], device: DeviceInfo): AdvisorResult {
  const candidates = catalog.filter((e) => e.task === 'chat');
  const scored = candidates.map((e) => scoreOne(e, device));
  // Comfortable/fits first, then tight; never recommend "won't fit".
  const viable = scored
    .filter((p) => p.verdict !== 'too-big')
    .sort((a, b) => b.score - a.score);
  return {
    device,
    picks: viable.slice(0, 3),
    considered: candidates.length,
    nothingFits: viable.length === 0,
  };
}

/** Fit verdict for a single catalog entry (used for per-row badges). */
export function fitForEntry(entry: ModelEntry, device: DeviceInfo): { band: VerdictBand; label: string; utilization: number } {
  const kv = kvBytes(entry, ADVISOR_CTX);
  const required = entry.sizeBytes + kv.bytes + Math.max(0.5 * GB, 0.1 * entry.sizeBytes);
  const u = required / Math.max(1, device.budgetBytes);
  const { band, label } = verdictOf(u);
  return { band, label, utilization: u };
}

export { TOOL_LABEL };
