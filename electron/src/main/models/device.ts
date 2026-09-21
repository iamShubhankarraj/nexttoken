/**
 * Device capability detection for the Model Advisor (Settings → Models).
 *
 * macOS (primary target): chip name, unified memory, CPU cores, and a
 * per-chip memory-bandwidth lookup so the advisor can estimate tokens/sec.
 * Other platforms: conservative fallback from os.totalmem() — the advisor
 * still works, with speed marked as a rough estimate.
 *
 * Methodology mirrors llmfit / llmcalculator (see research notes):
 *  - Usable budget keeps the OS and the browser alive:
 *      budget = min(totalRAM − max(4GB, 15% of RAM), gpuCap)
 *    where on Apple Silicon gpuCap = 0.75 × totalRAM
 *    (or totalRAM − 8GB when totalRAM > 36GB) — macOS caps the GPU share.
 *  - Speed estimate is memory-bandwidth-bound:
 *      tok/s = (bandwidthGBps / weightsGB) × 0.55
 */

import os from 'node:os';
import { execFile } from 'node:child_process';

export interface DeviceInfo {
  platform: NodeJS.Platform;
  /** e.g. "Apple M3 Pro", "Intel Core i7-12700H", "Unknown CPU". */
  chipLabel: string;
  cpuCores: number;
  totalRamBytes: number;
  /**
   * Bytes the advisor may spend on model weights + KV cache + overhead.
   * Always leaves headroom for the OS and the browser's tabs.
   */
  budgetBytes: number;
  /** Unified/discrete memory bandwidth in GB/s; null when unknown. */
  bandwidthGBps: number | null;
  /** Human note about detection quality, or null when fully detected. */
  note: string | null;
  /** False when we fell back to conservative defaults. */
  fullyDetected: boolean;
}

/** Approximate unified-memory bandwidth per Apple chip (GB/s, Apple-published). */
const APPLE_BANDWIDTH: Array<[RegExp, number]> = [
  [/M4\s*Max/i, 546],
  [/M4\s*Pro/i, 273],
  [/M4(?!.*(Pro|Max))/i, 120],
  [/M3\s*Max/i, 300],
  [/M3\s*Pro/i, 150],
  [/M3(?!.*(Pro|Max))/i, 100],
  [/M2\s*Ultra/i, 800],
  [/M2\s*Max/i, 400],
  [/M2\s*Pro/i, 200],
  [/M2(?!.*(Pro|Max|Ultra))/i, 100],
  [/M1\s*Ultra/i, 800],
  [/M1\s*Max/i, 400],
  [/M1\s*Pro/i, 200],
  [/M1(?!.*(Pro|Max|Ultra))/i, 68],
];

const GB = 1024 ** 3;

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout ?? ''));
    });
  });
}

async function detectMac(): Promise<DeviceInfo> {
  const totalRam = os.totalmem();
  const cpuCores = os.cpus().length;
  // Chip name: brand string is cheapest ("Apple M3 Pro").
  let chipLabel = (await run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])).trim();
  if (!chipLabel) {
    try {
      const sp = await run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], 15000);
      const parsed = JSON.parse(sp || '{}') as { SPHardwareDataType?: Array<{ chip_type?: string }> };
      chipLabel = parsed?.SPHardwareDataType?.[0]?.chip_type?.trim() ?? '';
    } catch {
      /* fall through */
    }
  }
  if (!chipLabel) chipLabel = 'Apple Silicon (unknown chip)';

  let bandwidthGBps: number | null = null;
  for (const [re, bw] of APPLE_BANDWIDTH) {
    if (re.test(chipLabel)) {
      bandwidthGBps = bw;
      break;
    }
  }

  // macOS caps the GPU's share of unified memory at ~75% of RAM
  // (or RAM − 8 GB above 36 GB). The budget is the tighter of that cap
  // and "leave the OS + browser breathing room".
  const gpuCap = totalRam > 36 * GB ? totalRam - 8 * GB : 0.75 * totalRam;
  const osHeadroom = Math.max(4 * GB, 0.15 * totalRam);
  const budgetBytes = Math.max(1 * GB, Math.min(totalRam - osHeadroom, gpuCap));

  return {
    platform: 'darwin',
    chipLabel,
    cpuCores,
    totalRamBytes: totalRam,
    budgetBytes: Math.floor(budgetBytes),
    bandwidthGBps,
    note: bandwidthGBps === null
      ? `Couldn't match "${chipLabel}" to a known chip — speed estimates are rough.`
      : null,
    fullyDetected: true,
  };
}

function detectFallback(): DeviceInfo {
  const totalRam = os.totalmem();
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    chipLabel: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length,
    totalRamBytes: totalRam,
    // Conservative: no unified-memory knowledge, assume 60% usable.
    budgetBytes: Math.floor(totalRam * 0.6),
    bandwidthGBps: null,
    note: 'Running outside macOS — using conservative memory estimates; speed figures are rough.',
    fullyDetected: false,
  };
}

let cached: DeviceInfo | null = null;

/** Detect device capabilities once per process; result is cached. */
export async function getDeviceInfo(): Promise<DeviceInfo> {
  if (cached) return cached;
  try {
    cached = os.platform() === 'darwin' ? await detectMac() : detectFallback();
  } catch {
    cached = detectFallback();
  }
  return cached;
}

/** Synchronous conservative view (used only when async detection can't run). */
export function getDeviceInfoSync(): DeviceInfo {
  return cached ?? detectFallback();
}
