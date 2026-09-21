import type { ModelEntry } from './types';

/**
 * Curated on-device model catalog for Apple Silicon unified memory.
 *
 * Most URLs are direct HuggingFace `resolve` URLs. No checksums are listed
 * because HuggingFace does not publish per-file SHA-256 for these repos;
 * add `sha256` whenever an upstream checksum becomes available and the
 * downloader will verify it automatically.
 *
 * URL verification (2026-09-21, anonymous: ranged-GET + HF/GitHub APIs,
 * all returned 206/200 with no token): *   206 SmolLM3-3B-GGUF (unsloth mirror), LFM2-1.2B-GGUF (unsloth),
 *       Qwen3-4B-GGUF, Qwen3-8B-GGUF, gemma-3n-E4B-it-GGUF (unsloth mirror),
 *       Qwen2.5-VL-3B-Instruct-GGUF + mmproj (ggml-org),
 *       Qwen2.5-VL-7B-Instruct-GGUF + mmproj (ggml-org),
 *       SmolVLM2-256M-Video-Instruct-GGUF + mmproj (ggml-org, experimental slot),
 *       whisper ggml-base/small.en (ggerganov/whisper.cpp),
 *       kokoro-en-v0_19.tar.bz2 + espeak-ng-data.tar.bz2 (sherpa-onnx tts-models release)
 * Every entry downloads with ZERO sign-in. The canonical repos for SmolLM3
 * (HuggingFaceTB), Gemma 3n (google) and Qwen2.5-VL (bartowski) are
 * access-gated on HuggingFace (anonymous requests 401), so the catalog uses
 * verified ungated mirrors from trusted publishers (unsloth, ggml-org)
 * instead — same weights, no login needed.
 * The optional HF token in Settings → Models remains as a fallback for any
 * future gated repo; a 401/403 still surfaces a clear "access-gated" message
 * instead of a raw HTTP error.
 */
export const MODEL_CATALOG: ModelEntry[] = [
  // -- chat (tiny) ------------------------------------------------------------
  // SmolLM3's canonical repo (HuggingFaceTB) is access-gated (401 anonymous);
  // this is unsloth's ungated mirror of the same weights — verified 206.
  {
    id: 'smollm3-3b-q4km',
    name: 'SmolLM3 3B',
    task: 'chat',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 1_950_000_000,
    url: 'https://huggingface.co/unsloth/SmolLM3-3B-GGUF/resolve/main/SmolLM3-3B-Q4_K_M.gguf',
    description: 'Fast multilingual 3B for everyday chat and quick agent turns.',
    license: 'Apache-2.0',
    // Template-level tool calls (<tool_call> XML-ish); the agent harness
    // parses them rather than expecting OpenAI-style tool_calls.
    toolCalling: 'partial',
    contextTokens: 65536,
  },
  {
    id: 'lfm2-1.2b-q4km',
    name: 'LFM2 1.2B',
    task: 'chat',
    params: '1.2B',
    quant: 'Q4_K_M',
    sizeBytes: 780_000_000,
    url: 'https://huggingface.co/unsloth/LFM2-1.2B-GGUF/resolve/main/LFM2-1.2B-Q4_K_M.gguf',
    description: 'Tiny hybrid conv-attention model; the fastest local chat option.',
    license: 'LFM Open License',
  },
  // -- chat (balanced) -------------------------------------------------------
  {
    id: 'qwen3-4b-q4km',
    name: 'Qwen3 4B',
    task: 'chat',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_600_000_000,
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    description: 'Strong reasoning 4B; the best all-rounder for on-device agent work.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 262144,
    layers: 36,
    kvHeads: 8,
    headDim: 128,
  },
  // google's canonical repo is access-gated (401 anonymous); unsloth's
  // mirror of the same weights is ungated — verified 206.
  {
    id: 'gemma-3n-e4b-q4km',
    name: 'Gemma 3n E4B',
    task: 'chat',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_500_000_000,
    url: 'https://huggingface.co/unsloth/gemma-3n-E4B-it-GGUF/resolve/main/gemma-3n-E4B-it-Q4_K_M.gguf',
    description: "Google's efficient 4B model; snappy on Apple Silicon unified memory.",
    license: 'Gemma Terms of Use',
    // No native tool calling — chat only, not an agent brain.
    toolCalling: 'none',
    contextTokens: 32768,
  },
  // -- chat (strong) ----------------------------------------------------------
  {
    id: 'qwen3-8b-q4km',
    name: 'Qwen3 8B',
    task: 'chat',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 5_030_000_000,
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    description: 'The most capable on-device chat model; best for hard agent work.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 262144,
    layers: 36,
    kvHeads: 8,
    headDim: 128,
  },

  // -- chat (agentic, Sept 2026) ---------------------------------------------
  // Small models picked for agentic / tool-calling work. All repos below
  // were verified ungated (2026-09-22): the direct resolve URLs download
  // with zero sign-in. "Bonsai 2B" (user request) is PrismML's
  // Ternary-Bonsai-8B (~2 GB) — real and strong, but its GGUFs need
  // PrismML's llama.cpp fork, so it stays OUT of the catalog until the
  // bundled llama-server is proven to load it.
  {
    id: 'qwen3-4b-instruct-2507-q4km',
    name: 'Qwen3 4B Instruct (2507)',
    task: 'chat',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_497_281_120,
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    description: 'Best BFCL-per-GB in its class; think/no-think modes. The default agent brain.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 262144,
    layers: 36,
    kvHeads: 8,
    headDim: 128,
  },
  {
    id: 'qwen3.5-4b-q4km',
    name: 'Qwen3.5 4B',
    task: 'chat',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_707_513_696,
    url: 'https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    description: "Sept-2026's top small tool-caller; huge context for long pages. Needs a recent llama-server (hybrid architecture).",
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 262144,
  },
  {
    id: 'lfm2.5-2.6b-q4km',
    name: 'LFM2.5 2.6B',
    task: 'chat',
    params: '2.6B',
    quant: 'Q4_K_M',
    sizeBytes: 1_670_000_000,
    url: 'https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/main/LFM2.5-2.6B-Q4_K_M.gguf',
    description: 'Built for on-device agents; tiny 1.7 GB footprint, very fast. Not for agentic coding.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 131072,
  },
  {
    id: 'ministral-3-3b-q4km',
    name: 'Ministral 3 3B',
    task: 'chat',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_147_023_008,
    url: 'https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF/resolve/main/Ministral-3-3B-Instruct-2512-Q4_K_M.gguf',
    description: 'Official Mistral GGUF with native function calling; the safe commercial bet.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 131072,
  },
  {
    id: 'hermes-3-llama-3.2-3b-q4km',
    name: 'Hermes 3 (Llama 3.2) 3B',
    task: 'chat',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_168_000_000,
    url: 'https://huggingface.co/bartowski/Hermes-3-Llama-3.2-3B-GGUF/resolve/main/Hermes-3-Llama-3.2-3B-Q4_K_M.gguf',
    description: 'Purpose-built for function calling with parallel calls; the most predictable tool behavior.',
    license: 'Apache-2.0 (quant); Llama Community License (base)',
    toolCalling: 'excellent',
    contextTokens: 131072,
    layers: 28,
    kvHeads: 8,
    headDim: 128,
  },
  {
    id: 'qwen2.5-coder-3b-q4km',
    name: 'Qwen2.5 Coder 3B',
    task: 'chat',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_300_000_000,
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    description: 'Terminal-command tier: the strongest small coder for shell work.',
    license: 'Apache-2.0',
    toolCalling: 'excellent',
    contextTokens: 32768,
    layers: 36,
    kvHeads: 2,
    headDim: 128,
  },
  {
    id: 'qwen3-1.7b-q4km',
    name: 'Qwen3 1.7B',
    task: 'chat',
    params: '1.7B',
    quant: 'Q4_K_M',
    sizeBytes: 1_200_000_000,
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    description: 'Fast tier for latency-sensitive turns; ~1.2 GB, near-instant load.',
    license: 'Apache-2.0',
    toolCalling: 'good',
    contextTokens: 262144,
    layers: 28,
    kvHeads: 8,
    headDim: 128,
  },

  // -- vision ---------------------------------------------------------------
  // bartowski's VL repo went access-gated (401 anonymous); ggml-org's build
  // is the same weights, verified ungated, and ships the mmproj too.
  {
    id: 'smolvlm2-256m-q4km',
    name: 'SmolVLM2 256M (experimental)',
    task: 'vision',
    params: '256M',
    quant: 'Q4_K_M',
    sizeBytes: 235_000_000,
    url: 'https://huggingface.co/ggml-org/SmolVLM2-256M-Video-Instruct-GGUF/resolve/main/SmolVLM2-256M-Video-Instruct-Q4_K_M.gguf',
    description: 'Experimental tiny vision model (~235 MB total) — good enough to try on-device screen descriptions.',
    license: 'Apache-2.0',
    mmprojUrl:
      'https://huggingface.co/ggml-org/SmolVLM2-256M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-256M-Video-Instruct-Q8_0.gguf',
  },
  {
    id: 'qwen25vl-3b-q4km',
    name: 'Qwen2.5-VL 3B',
    task: 'vision',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_200_000_000,
    url: 'https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    description: 'Compact vision-language model for screenshots, photos, and UI grounding.',
    license: 'Apache-2.0',
    mmprojUrl:
      'https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
  },
  {
    id: 'qwen25vl-7b-q4km',
    name: 'Qwen2.5-VL 7B',
    task: 'vision',
    params: '7B',
    quant: 'Q4_K_M',
    sizeBytes: 4_690_000_000,
    url: 'https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf',
    description: 'Stronger vision-language model for detailed screenshots and documents.',
    license: 'Apache-2.0',
    mmprojUrl:
      'https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf',
  },

  // -- speech-to-text -------------------------------------------------------
  {
    id: 'whisper-base-en',
    name: 'Whisper base.en',
    task: 'stt',
    params: '74M',
    quant: '',
    sizeBytes: 142_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    description: 'Fast English speech-to-text for voice commands and dictation.',
    license: 'MIT',
  },
  {
    id: 'whisper-small-en',
    name: 'Whisper small.en',
    task: 'stt',
    params: '244M',
    quant: '',
    sizeBytes: 466_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    description: 'More accurate English STT for when base.en mishears.',
    license: 'MIT',
  },

  // -- text-to-speech -------------------------------------------------------
  // Kokoro ships as release tarballs (model.onnx + voices.bin + tokens.txt
  // inside), NOT as single files — hexgrad/Kokoro-82M only publishes a
  // PyTorch .pth, whose old onnx URL 404s. The downloader extracts these
  // archives into the entry dir; see TTS_ARCHIVES in downloader.ts.
  {
    id: 'kokoro-82m',
    name: 'Kokoro 82M',
    task: 'tts',
    params: '82M',
    quant: '',
    sizeBytes: 327_000_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    description: 'Natural neural TTS for speaking agent replies (sherpa-onnx).',
    license: 'Apache-2.0',
  },
];
