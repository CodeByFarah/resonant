// Checks that the local text-to-audio model loads and produces audio.
import { env, AutoTokenizer, MusicgenForConditionalGeneration } from "@huggingface/transformers";
import path from "node:path";
import os from "node:os";

env.cacheDir = path.join(os.homedir(), ".resonant", "models");

let t = Date.now();
const id = "Xenova/musicgen-small";
const tokenizer = await AutoTokenizer.from_pretrained(id);
const model = await MusicgenForConditionalGeneration.from_pretrained(id, {
  dtype: { text_encoder: "q8", decoder_model_merged: "q8", encodec_decode: "fp32" },
});
console.log("musicgen loaded", Date.now() - t, "ms; sr", model.config.audio_encoder.sampling_rate);
t = Date.now();
const inputs = tokenizer("heavy rain on a tin roof with distant thunder");
// ~50 tokens per second of audio
const audio = await model.generate({ ...inputs, max_new_tokens: 150, do_sample: true, guidance_scale: 3 });
console.log("generated", audio.data.length, "samples in", Date.now() - t, "ms");
