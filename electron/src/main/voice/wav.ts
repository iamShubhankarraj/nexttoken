/**
 * Minimal WAV utilities for the on-device voice pipeline.
 *
 * The STT side writes 16 kHz mono int16 PCM for whisper.cpp; the TTS side
 * decodes whatever sherpa-onnx wrote (Kokoro emits 24 kHz mono), resamples
 * it to 16 kHz, and concatenates chunk WAVs. No dependencies.
 */

/** Decoded WAV: mono int16 samples plus the source format. */
export interface DecodedWav {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

/**
 * Encode 16-bit PCM mono samples as a standard 44-byte RIFF WAV.
 * Throws on a non-positive or non-finite sample rate.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWav: invalid sample rate ${sampleRate}`);
  }
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4); // chunk size
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buf.writeUInt16LE(1, 20); // audio format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono int16)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return buf;
}

/**
 * Decode a WAV buffer to int16 PCM. Parses the RIFF header properly by
 * walking chunks (handles extra chunks like 'LIST'/'fact' before 'data').
 * Multi-channel input is downmixed to mono. Only PCM int16 is supported;
 * anything else throws a descriptive error.
 */
export function decodePcm16(wav: Buffer): DecodedWav {
  if (wav.length < 44) {
    throw new Error(`decodePcm16: buffer too short (${wav.length} bytes)`);
  }
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("decodePcm16: not a RIFF/WAVE file");
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataLen = 0;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      audioFormat = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, wav.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (audioFormat !== 1) {
    throw new Error(`decodePcm16: unsupported WAV audio format ${audioFormat} (only PCM=1 supported)`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`decodePcm16: unsupported bit depth ${bitsPerSample} (only 16-bit supported)`);
  }
  if (sampleRate <= 0 || channels <= 0) {
    throw new Error("decodePcm16: WAV 'fmt ' chunk missing or invalid");
  }
  if (dataStart < 0) {
    throw new Error("decodePcm16: WAV has no 'data' chunk");
  }

  const frames = Math.floor(dataLen / 2 / channels);
  const pcm = new Int16Array(frames);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) {
      pcm[i] = wav.readInt16LE(dataStart + i * 2);
    }
  } else {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += wav.readInt16LE(dataStart + (i * channels + c) * 2);
      }
      pcm[i] = Math.round(sum / channels);
    }
  }
  return { pcm, sampleRate, channels };
}

/**
 * Concatenate WAV buffers into a single WAV. All inputs must share the same
 * sample rate; a mismatch throws (never silently resample here — the caller
 * decides the target rate explicitly).
 */
export function concatWav(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) {
    throw new Error("concatWav: no buffers to concatenate");
  }
  if (buffers.length === 1) {
    return buffers[0];
  }
  const decoded = buffers.map(decodePcm16);
  const sampleRate = decoded[0].sampleRate;
  for (const d of decoded) {
    if (d.sampleRate !== sampleRate) {
      throw new Error(
        `concatWav: sample rate mismatch (${d.sampleRate} Hz vs ${sampleRate} Hz)`,
      );
    }
  }
  const total = decoded.reduce((n, d) => n + d.pcm.length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const d of decoded) {
    pcm.set(d.pcm, at);
    at += d.pcm.length;
  }
  return encodeWav(pcm, sampleRate);
}

/**
 * Resample int16 PCM between sample rates with linear interpolation.
 * Used to bring sherpa-onnx's 24 kHz Kokoro output down to 16 kHz.
 */
export function resamplePcm16(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`resamplePcm16: invalid rates ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate) {
    return pcm.slice();
  }
  if (pcm.length === 0) {
    return new Int16Array(0);
  }
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm[idx];
    const b = idx + 1 < pcm.length ? pcm[idx + 1] : a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
