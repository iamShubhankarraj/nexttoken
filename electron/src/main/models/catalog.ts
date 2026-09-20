import type { ModelEntry } from './types';

/**
 * Curated on-device model catalog for Apple Silicon unified memory.
 *
 * Every URL below is a direct HuggingFace `resolve` URL. No checksums are
 * listed because HuggingFace does not publish per-file SHA-256 for these
 * repos; add `sha256` whenever an upstream checksum becomes available and
 * the downloader will verify it automatically.
 *
 * NOTE (2026-09-21): live URL verification was impossible at authoring time
 * (network tooling outage), so each entry is flagged with a confidence note
 * in the report. Re-verify before shipping.
 */
export const MODEL_CATALOG: ModelEntry[] = [
  // -- chat -----------------------------------------------------------------
  {
    id: 'smollm3-3b-q4km',
    name: 'SmolLM3 3B',
    task: 'chat',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 1_950_000_000,
    url: 'https://huggingface.co/HuggingFaceTB/SmolLM3-3B-GGUF/resolve/main/SmolLM3-3B-Q4_K_M.gguf',
    description: 'Fast multilingual 3B for everyday chat and quick agent turns.',
    license: 'Apache-2.0',
  },
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
  {
    id: 'gemma-3n-e4b-q4km',
    name: 'Gemma 3n E4B',
    task: 'chat',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_500_000_000,
    url: 'https://huggingface.co/google/gemma-3n-E4B-it-GGUF/resolve/main/gemma-3n-E4B-it-Q4_K_M.gguf',
    description: "Google's efficient 4B model; snappy on Apple Silicon unified memory.",
    license: 'Gemma Terms of Use',
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

  // -- vision ---------------------------------------------------------------
  {
    id: 'qwen25vl-3b-q4km',
    name: 'Qwen2.5-VL 3B',
    task: 'vision',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_200_000_000,
    url: 'https://huggingface.co/bartowski/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    description: 'Compact vision-language model for screenshots, photos, and UI grounding.',
    license: 'Apache-2.0',
    mmprojUrl:
      'https://huggingface.co/bartowski/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
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
  {
    id: 'kokoro-82m',
    name: 'Kokoro 82M',
    task: 'tts',
    params: '82M',
    quant: '',
    sizeBytes: 310_000_000,
    url: 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0.onnx',
    description: 'Natural neural TTS for speaking agent replies (sherpa-onnx).',
    license: 'Apache-2.0',
  },
];
