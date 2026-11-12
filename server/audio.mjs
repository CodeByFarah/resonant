// Audio encode/decode helpers: WAV, MP3 and raw PCM, plus resampling.
import wavefile from "wavefile";
import { Mp3Encoder } from "@breezystack/lamejs";
import { MPEGDecoder } from "mpg123-decoder";

const { WaveFile } = wavefile;

export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function silence(seconds, rate) {
  return new Float32Array(Math.round(seconds * rate));
}

// Changes the length of speech without changing its pitch (WSOLA): factor 1.2 makes it 20%
// shorter, 0.9 about 11% longer. Each 30 ms frame is taken from near where it belongs in the
// input, at the offset that lines up best with the frame before, so the joins don't click.
export function timeStretch(x, rate, factor) {
  const win = Math.round(rate * 0.03);
  if (!(factor > 0) || Math.abs(factor - 1) < 0.01 || x.length < win * 2) return x;
  const hop = win >> 1;
  const seek = Math.round(rate * 0.012);
  const outLen = Math.round(x.length / factor);
  const out = new Float32Array(outLen + win);
  const norm = new Float32Array(outLen + win);
  const w = new Float32Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  const maxStart = x.length - win;
  let prev = 0;
  for (let o = 0; o < outLen; o += hop) {
    let best = Math.min(maxStart, Math.round(o * factor));
    if (o > 0) {
      // The ideal next frame continues the previous one; find the input offset that matches it best.
      const target = Math.min(maxStart, prev + hop);
      let bestScore = -Infinity;
      const from = Math.max(0, best - seek), to = Math.min(maxStart, best + seek);
      for (let s = from; s <= to; s += 2) {
        let score = 0;
        for (let i = 0; i < hop; i += 2) score += x[s + i] * x[target + i];
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    for (let i = 0; i < win; i++) { out[o + i] += x[best + i] * w[i]; norm[o + i] += w[i]; }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.slice(0, outLen);
}

export function encodeWav(samples, rate) {
  const wav = new WaveFile();
  wav.fromScratch(1, rate, "16", toInt16(samples));
  return Buffer.from(wav.toBuffer());
}

export function encodeMp3(samples, rate, kbps = 128) {
  const enc = new Mp3Encoder(1, rate, kbps);
  const pcm = toInt16(samples);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const buf = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (buf.length) parts.push(Buffer.from(buf));
  }
  const end = enc.flush();
  if (end.length) parts.push(Buffer.from(end));
  return Buffer.concat(parts);
}

// Incremental MP3 encoder for long renders: write() as audio arrives, end() once at the finish.
export function mp3Writer(rate, kbps = 96) {
  const enc = new Mp3Encoder(1, rate, kbps);
  let rest = new Int16Array(0);
  return {
    write(samples) {
      const pcm = new Int16Array(rest.length + samples.length);
      pcm.set(rest);
      pcm.set(toInt16(samples), rest.length);
      const whole = pcm.length - (pcm.length % 1152);
      const parts = [];
      for (let i = 0; i < whole; i += 1152) {
        const buf = enc.encodeBuffer(pcm.subarray(i, i + 1152));
        if (buf.length) parts.push(Buffer.from(buf));
      }
      rest = pcm.slice(whole);
      return Buffer.concat(parts);
    },
    end() {
      const parts = [];
      if (rest.length) parts.push(Buffer.from(enc.encodeBuffer(rest)));
      parts.push(Buffer.from(enc.flush()));
      return Buffer.concat(parts);
    },
  };
}

// 16-bit little-endian PCM (e.g. ElevenLabs pcm_24000) to Float32.
export function pcm16ToFloat(buf) {
  const out = new Float32Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// Parses ElevenLabs-style output formats: mp3_44100_128, pcm_16000, wav_22050.
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
export function parseOutputFormat(fmt = "mp3_44100_128") {
  const [codec, sr, br] = String(fmt).split("_");
  const rate = Number(sr) || 44100;
  if (codec === "mp3") {
    if (!MP3_RATES.includes(rate)) throw httpError(400, `Unsupported mp3 sample rate ${rate}`);
    return { codec, rate, kbps: Number(br) || 128, contentType: "audio/mpeg", ext: "mp3" };
  }
  if (codec === "pcm") return { codec, rate, contentType: "audio/pcm", ext: "pcm" };
  if (codec === "wav") return { codec, rate, contentType: "audio/wav", ext: "wav" };
  throw httpError(400, `Unsupported output_format ${fmt}`);
}

export function encode(samples, sourceRate, format) {
  const s = resample(samples, sourceRate, format.rate);
  if (format.codec === "mp3") return encodeMp3(s, format.rate, format.kbps);
  if (format.codec === "wav") return encodeWav(s, format.rate);
  return Buffer.from(toInt16(s).buffer);
}

// Decodes an uploaded WAV or MP3 file to mono Float32 at the given rate.
export async function decodeToMono(buf, targetRate = 16000) {
  const head = buf.subarray(0, 4).toString("ascii");
  if (head === "RIFF") {
    const wav = new WaveFile(buf);
    wav.toBitDepth("32f");
    let chans = wav.getSamples(false, Float32Array);
    if (!Array.isArray(chans)) chans = [chans];
    return { samples: resample(mixdown(chans), wav.fmt.sampleRate, targetRate), rate: targetRate, duration: chans[0].length / wav.fmt.sampleRate };
  }
  const isMp3 = head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (isMp3) {
    const dec = new MPEGDecoder();
    await dec.ready;
    const { channelData, sampleRate, errors } = dec.decode(new Uint8Array(buf));
    dec.free();
    if (!channelData.length || !channelData[0].length) throw httpError(400, `Could not decode MP3${errors.length ? `: ${errors[0].message}` : ""}`);
    return { samples: resample(mixdown(channelData), sampleRate, targetRate), rate: targetRate, duration: channelData[0].length / sampleRate };
  }
  throw httpError(415, "Unsupported audio format. Upload WAV or MP3 (the web app converts other formats in the browser).");
}

function mixdown(chans) {
  if (chans.length === 1) return chans[0];
  const out = new Float32Array(chans[0].length);
  for (const c of chans) for (let i = 0; i < out.length; i++) out[i] += c[i] / chans.length;
  return out;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
