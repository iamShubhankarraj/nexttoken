export type ModelTask = 'chat' | 'vision' | 'stt' | 'tts';

export interface ModelEntry {
  id: string;          // e.g. 'smollm3-3b-q4km'
  name: string;        // 'SmolLM3 3B'
  task: ModelTask;
  params: string;      // '3B'
  quant: string;       // 'Q4_K_M'
  sizeBytes: number;   // approximate download size
  url: string;         // DIRECT download URL (HuggingFace resolve URL)
  sha256?: string;     // include when you can find a published checksum
  description: string; // one line, what it's good for
  license: string;     // e.g. 'Apache-2.0'
  mmprojUrl?: string;  // vision models only: direct URL of the mmproj file
  mmprojSha256?: string;
  /**
   * Model Advisor metadata (all optional; the advisor degrades gracefully).
   * contextTokens: native context length. toolCalling grades the chat
   * template + benchmarked agentic ability: 'excellent' (native tool calls,
   * strong BFCL-class scores), 'good', 'partial' (template hacks), 'none'.
   * layers/kvHeads/headDim enable exact KV-cache math; without them the
   * advisor uses a conservative per-parameter estimate and says so.
   */
  contextTokens?: number;
  toolCalling?: 'excellent' | 'good' | 'partial' | 'none';
  layers?: number;
  kvHeads?: number;
  headDim?: number;
  /**
   * True when the host repo is access-gated on Hugging Face (login + license
   * acceptance required). Gated entries stay visible but are badged in the
   * UI, and download with the user's saved HF token when one exists.
   */
  gated?: boolean;
}

export type ModelRef = string; // 'applefm' | 'cloud' | a ModelEntry id

export interface DownloadProgress { id: string; bytesDownloaded: number; totalBytes: number; }

export type DownloadEvent =
  | { kind: 'progress'; id: string; bytesDownloaded: number; totalBytes: number }
  | { kind: 'done'; id: string }
  | { kind: 'error'; id: string; error: string };
