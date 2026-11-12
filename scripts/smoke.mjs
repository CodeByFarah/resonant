// Downloads models on first run and checks each engine end to end.
import { env, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import path from "node:path";
import os from "node:os";

env.cacheDir = path.join(os.homedir(), ".resonant", "models");

let t = Date.now();
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
console.log("kokoro loaded", Date.now() - t, "ms; voices:", Object.keys(tts.voices).length);
t = Date.now();
const audio = await tts.generate("Hello there. This is a quick test of the speech engine.", { voice: "af_heart" });
console.log("tts", audio.audio.length, "samples @", audio.sampling_rate, "in", Date.now() - t, "ms");

t = Date.now();
const asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base_timestamped", { dtype: "q8" });
console.log("whisper loaded", Date.now() - t, "ms");
// Whisper expects 16 kHz mono; naive decimation is fine for a smoke test.
const ratio = audio.sampling_rate / 16000;
const pcm = new Float32Array(Math.floor(audio.audio.length / ratio));
for (let i = 0; i < pcm.length; i++) pcm[i] = audio.audio[Math.floor(i * ratio)];
t = Date.now();
const out = await asr(pcm, { return_timestamps: "word" });
console.log("stt in", Date.now() - t, "ms:", JSON.stringify(out).slice(0, 400));
