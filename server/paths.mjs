// Where Resonant keeps what it downloads, in one place. RESONANT_HOME moves all of it (the Python
// engine, models, tools); the older per-item variables still win when set.
import os from "node:os";
import path from "node:path";

export const HOME = path.resolve(process.env.RESONANT_HOME || path.join(os.homedir(), ".resonant"));
export const VENV = path.join(HOME, "venv");
export const PYTHON = process.env.RESONANT_PYTHON
  || path.join(VENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
// Models Resonant downloads into plain folders (Kokoro, Whisper, translation, and the optional
// Turbo, ECAPA and OpenVoice models).
export const MODELS_DIR = path.resolve(process.env.RESONANT_MODELS_DIR || path.join(HOME, "models"));
// Qwen3-TTS models live in the Hugging Face cache, where the Python worker looks for them.
export const HF_HOME = path.resolve(process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface"));
export const HF_HUB = path.join(HF_HOME, "hub");
// Tools Resonant fetches for itself, such as uv.
export const BIN_DIR = path.join(HOME, "bin");
