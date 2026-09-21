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
 * all returned 206/200 with no token):
 *   206 SmolLM3-3B-GGUF (unsloth mirror), LFM2-1.2B-GGUF (unsloth),
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
