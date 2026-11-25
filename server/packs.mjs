// Settings → Models: optional model packs people install from inside Resonant, with no Python or
// terminal of their own. The first pack sets up a private Python engine (with uv, which also
// fetches Python itself); each pack then adds its packages at the versions in
// worker/requirements-lock.txt and downloads its models, with progress. One install runs at a time.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { HOME, VENV, PYTHON, MODELS_DIR, HF_HOME, HF_HUB, BIN_DIR } from "./paths.mjs";
import * as qwen from "./engines/qwen.mjs";
import { httpError } from "./audio.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, "worker", "requirements-lock.txt");
const FETCH = path.join(ROOT, "worker", "fetch_model.py");
const GB = 1024 ** 3;

// uv, pinned, with the checksums published on its GitHub release.
const UV_VERSION = "0.12.23";
const UV_ASSETS = {
  "win32-x64": ["uv-x86_64-pc-windows-msvc.zip", "75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90"],
  "win32-arm64": ["uv-aarch64-pc-windows-msvc.zip", "13294e232ececbe709c06b74e6ced06f2a225ea5591476685362f22be56a50d5"],
  "darwin-x64": ["uv-x86_64-apple-darwin.tar.gz", "960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4"],
  "darwin-arm64": ["uv-aarch64-apple-darwin.tar.gz", "50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544"],
  "linux-x64": ["uv-x86_64-unknown-linux-gnu.tar.gz", "9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"],
  "linux-arm64": ["uv-aarch64-unknown-linux-gnu.tar.gz", "6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f"],
};
// PyTorch builds: the processor build everywhere, or CUDA 12.6 for an NVIDIA card (Windows, Linux).
const TORCH = ["torch==2.14.1", "torchaudio==2.11.0"];
const TORCH_INDEX = { cpu: "https://download.pytorch.org/whl/cpu", cuda: "https://download.pytorch.org/whl/cu126" };
const OPENVOICE = "https://github.com/myshell-ai/OpenVoice/archive/74a1d147b17a8c3092dd5430504bd83ef6c7eb23.zip";

const hfDir = (repo) => path.join(HF_HUB, `models--${repo.replace("/", "--")}`);
const qwenRepo = (size, kind) => `Qwen/Qwen3-TTS-12Hz-${size}-${kind}`;

// Each pack: what it adds, the Python packages it needs, the models it downloads, how to tell it's
// installed, and a rough size for the packages (model sizes come from Hugging Face).
export const PACKS = [
  {
    id: "expressive", name: "Expressive voices and cloning",
    description: "9 Qwen3 voices in 10 languages that take directions like \"whisper\" or \"sound excited\", voice cloning from a short recording, the 68-voice library, and voices for dubbing.",
    licence: "Apache-2.0", ramGb: 8, packagesGb: 0.3,
    packages: ["qwen-tts"],
    models: [{ repo: qwenRepo("0.6B", "CustomVoice") }, { repo: qwenRepo("0.6B", "Base") }],
    installed: () => qwen.pyPackage("qwen_tts") && qwen.repoInstalled("Qwen3-TTS-12Hz-0.6B-CustomVoice") && qwen.repoInstalled("Qwen3-TTS-12Hz-0.6B-Base"),
  },
  {
    id: "expressive-hq", name: "Higher-quality expressive voices",
    description: "The larger 1.7B Qwen3 models: a little more natural, about twice as slow, and needs about 7 GB of free memory. Choose the size in Settings → Providers.",
    licence: "Apache-2.0", ramGb: 16, packagesGb: 0.3, requires: "expressive",
    packages: ["qwen-tts"],
    models: [{ repo: qwenRepo("1.7B", "CustomVoice") }, { repo: qwenRepo("1.7B", "Base") }],
    installed: () => qwen.pyPackage("qwen_tts") && qwen.repoInstalled("Qwen3-TTS-12Hz-1.7B-CustomVoice") && qwen.repoInstalled("Qwen3-TTS-12Hz-1.7B-Base"),
  },
  {
    id: "design", name: "Voice design",
    description: "Create new voices from a written description: age, accent, tone and pace.",
    licence: "Apache-2.0", ramGb: 16, packagesGb: 0.3,
    packages: ["qwen-tts"],
    models: [{ repo: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" }],
    installed: () => qwen.pyPackage("qwen_tts") && qwen.repoInstalled("Qwen3-TTS-12Hz-1.7B-VoiceDesign"),
  },
  {
    id: "transcribe", name: "Accurate transcription and speaker labels",
    description: "Whisper Large v3 Turbo for punctuation, 99 languages and the detected language, plus speaker detection that labels who said what.",
    licence: "MIT, Apache-2.0", ramGb: 8, packagesGb: 0.15,
    packages: ["faster-whisper", "speechbrain"],
    models: [
      { repo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo", dir: "whisper-large-v3-turbo" },
      { repo: "speechbrain/spkrec-ecapa-voxceleb", dir: "ecapa-voxceleb" },
    ],
    installed: () => qwen.pyPackage("faster_whisper") && qwen.pyPackage("speechbrain")
      && fs.existsSync(path.join(MODELS_DIR, "whisper-large-v3-turbo", "model.bin")) && fs.existsSync(path.join(MODELS_DIR, "ecapa-voxceleb", "embedding_model.ckpt")),
  },
  {
    id: "isolate", name: "Voice isolation",
    description: "Removes music, hum and background noise from recordings and keeps the voice (Demucs).",
    licence: "MIT", ramGb: 8, packagesGb: 0.05,
    packages: ["demucs"],
    // Demucs 4.1 loads htdemucs from this Hugging Face repository.
    models: [{ repo: "adefossez/HTDemucs" }],
    installed: () => qwen.pyPackage("demucs") && hfInstalled("adefossez/HTDemucs"),
  },
  {
    id: "changer", name: "Voice changer",
    description: "Re-voices a recording in another voice while keeping its timing and emotion (OpenVoice V2).",
    licence: "MIT", ramGb: 8, packagesGb: 0.2,
    packages: ["librosa", "pypinyin", "unidecode", "cn2an", "eng_to_ipa", "inflect", "jieba"],
    noDeps: [OPENVOICE],
    models: [{ repo: "myshell-ai/OpenVoiceV2", dir: "openvoice-v2", allow: ["converter/*"] }],
    installed: () => qwen.pyPackage("openvoice") && fs.existsSync(path.join(MODELS_DIR, "openvoice-v2", "converter", "checkpoint.pth")),
  },
];
const byId = Object.fromEntries(PACKS.map((p) => [p.id, p]));

// A Hugging Face cache download is complete when a snapshot has files and nothing is half-written.
function hfInstalled(repo) {
  const dir = hfDir(repo);
  try {
    if (fs.readdirSync(path.join(dir, "blobs")).some((f) => f.endsWith(".incomplete"))) return false;
    return fs.readdirSync(path.join(dir, "snapshots")).some((rev) => fs.readdirSync(path.join(dir, "snapshots", rev)).length > 0);
  } catch { return false; }
}

// ---------- sizes ----------
// Exact model sizes from Hugging Face, remembered for the session.
const sizeCache = new Map();
async function modelBytes(m) {
  const key = m.repo + (m.allow || []).join(",");
  if (sizeCache.has(key)) return sizeCache.get(key);
  const r = await fetch(`https://huggingface.co/api/models/${m.repo}/tree/main?recursive=true`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Hugging Face answered ${r.status} for ${m.repo}`);
  const files = (await r.json()).filter((f) => f.type === "file");
  const match = (p) => !m.allow || m.allow.some((a) => (a.endsWith("*") ? p.startsWith(a.slice(0, -1)) : p === a));
  const bytes = files.filter((f) => match(f.path)).reduce((s, f) => s + (f.lfs?.size ?? f.size ?? 0), 0);
  sizeCache.set(key, bytes);
  return bytes;
}
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}
const modelTarget = (m) => (m.dir ? path.join(MODELS_DIR, m.dir) : hfDir(m.repo));
const engineReady = () => fs.existsSync(PYTHON) && qwen.pyPackage("torch");
// "cuda" or "cpu" for the installed PyTorch, from its dist-info folder name; null if none.
function torchBuild() {
  const sites = process.platform === "win32"
    ? [path.join(VENV, "Lib", "site-packages")]
    : (() => { try { return fs.readdirSync(path.join(VENV, "lib")).map((d) => path.join(VENV, "lib", d, "site-packages")); } catch { return []; } })();
  for (const d of sites) {
    try {
      const info = fs.readdirSync(d).find((f) => /^torch-[\d.]+(\+\w+)?\.dist-info$/.test(f));
      if (info) return /\+cu\d+/.test(info) ? "cuda" : "cpu";
    } catch {}
  }
  return null;
}

// ---------- the current job ----------
let job = null; // { pack, state: running|done|error|cancelled, step, detail, done, total, startedAt, error }
let child = null;
let cancelled = false;

export async function status({ gpu }) {
  const packs = await Promise.all(PACKS.map(async (p) => {
    let modelsGb = null;
    try { modelsGb = (await Promise.all((p.models || []).map(modelBytes))).reduce((a, b) => a + b, 0) / GB; } catch {}
    return {
      id: p.id, name: p.name, description: p.description, licence: p.licence, requires: p.requires || null,
      ram_gb: p.ramGb, installed: p.installed(), removable: Boolean(p.models?.length),
      size_gb: modelsGb == null ? null : Math.round((modelsGb + p.packagesGb) * 10) / 10,
    };
  }));
  const engine = { installed: engineReady(), build: torchBuild(), size_gb: gpu ? 2.8 : 0.4, gpu_available: Boolean(gpu) };
  return { packs, engine, job, remote: Boolean(qwen.remote()), home: HOME };
}

// Runs a command, keeping its latest output line as the job's detail. Resolves on exit code 0.
function run(cmd, args, { env = {}, label } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error("Cancelled"));
    if (label) Object.assign(job, { step: label, detail: "", done: null, total: null });
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    child = p;
    let tail = "";
    const take = (d) => {
      tail = (tail + d).slice(-4000);
      const last = String(d).trim().split(/\r?\n/).filter(Boolean).pop();
      if (last && job) job.detail = last.replace(/\s+/g, " ").slice(0, 160);
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => { child = null; reject(Object.assign(new Error(`Couldn't start ${path.basename(cmd)}: ${e.message}`), { code: e.code })); });
    p.on("exit", (code) => {
      child = null;
      if (cancelled) return reject(new Error("Cancelled"));
      if (code === 0) resolve(tail);
      else reject(new Error(lastError(tail) || `${path.basename(cmd)} exited with code ${code}`));
    });
  });
}
function lastError(t) {
  // Windows Smart App Control checks each new program online the first time it runs, and can
  // block it before the answer arrives; the same file is usually allowed on the next try.
  if (/os error 4551|Application Control policy/i.test(t)) return "Windows blocked a newly downloaded file (Smart App Control) while it was being checked. Click Download again: it carries on where it stopped and usually works the second time.";
  if (/os error 112|no space left/i.test(t)) return "The disk ran out of space. Free some space and click Download again.";
  return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|failed|denied|not found|blocked/i.test(l)).pop()?.slice(0, 300);
}

// ---------- uv ----------
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
// Pulls one file out of a .zip (Windows uv) or .tar.gz (Mac, Linux uv) held in memory.
function extract(buf, name, isZip) {
  if (isZip) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("The uv download isn't a zip file");
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
      const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const entry = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
      if (path.basename(entry) === name) {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        return method === 8 ? zlib.inflateRawSync(data) : data;
      }
      p += 46 + nlen + elen + clen;
    }
  } else {
    const tar = zlib.gunzipSync(buf);
    for (let o = 0; o + 512 <= tar.length;) {
      const entry = tar.subarray(o, o + 100).toString("utf8").replace(/\0.*$/s, "");
      if (!entry) break;
      const size = parseInt(tar.subarray(o + 124, o + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      if (path.basename(entry) === name) return tar.subarray(o + 512, o + 512 + size);
      o += 512 + Math.ceil(size / 512) * 512;
    }
  }
  throw new Error(`${name} wasn't in the uv download`);
}
const works = (cmd) => new Promise((resolve) => {
  const p = spawn(cmd, ["--version"], { windowsHide: true });
  p.on("error", () => resolve(false));
  p.on("exit", (code) => resolve(code === 0));
});
async function ensureUv() {
  const exe = path.join(BIN_DIR, process.platform === "win32" ? "uv.exe" : "uv");
  if (fs.existsSync(exe) && await works(exe)) return exe;
  const asset = UV_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`There's no uv build for ${process.platform} ${process.arch}.`);
  Object.assign(job, { step: "Getting the installer tool (uv)", detail: `uv ${UV_VERSION}` });
  const buf = await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset[0]}`);
  // Refuse anything but the exact file uv published.
  if (crypto.createHash("sha256").update(buf).digest("hex") !== asset[1]) throw new Error("The uv download didn't match its published checksum, so it wasn't used. Try again later.");
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(exe, extract(buf, path.basename(exe), asset[0].endsWith(".zip")), { mode: 0o755 });
  if (await works(exe)) return exe;
  // Some PCs block new programs (Windows Smart App Control). A uv the user installed may be allowed.
  if (await works("uv")) return "uv";
  throw new Error("This computer blocked the installer tool (uv). On Windows, Smart App Control blocks programs it doesn't know yet; installing uv yourself (https://docs.astral.sh/uv/) and trying again may work.");
}

// ---------- installing ----------
const UV_ENV = { UV_PYTHON_INSTALL_DIR: path.join(HOME, "python"), UV_NO_PROGRESS: "1" };
async function ensureEngine(uv, gpu) {
  const want = gpu && process.platform !== "darwin" ? "cuda" : "cpu";
  if (!fs.existsSync(PYTHON)) {
    await run(uv, ["venv", VENV, "--python", "3.12"], { env: UV_ENV, label: "Setting up Python 3.12" });
  }
  const have = torchBuild();
  if (have !== want) {
    const index = process.platform === "darwin" ? [] : ["--index-url", TORCH_INDEX[want]];
    const reinstall = have ? ["--reinstall-package", "torch", "--reinstall-package", "torchaudio"] : [];
    await run(uv, ["pip", "install", "--python", PYTHON, ...TORCH, ...index, ...reinstall], {
      env: UV_ENV, label: want === "cuda" ? "Installing PyTorch for your graphics card (about 2.5 GB)" : "Installing PyTorch (about 250 MB)",
    });
  }
  await run(uv, ["pip", "install", "--python", PYTHON, "-c", LOCK, "numpy", "soundfile", "huggingface_hub"], { env: UV_ENV, label: "Installing the engine's basics" });
}

async function fetchModel(m) {
  const target = modelTarget(m);
  let total = null;
  try { total = await modelBytes(m); } catch {}
  const before = dirBytes(target);
  Object.assign(job, { step: `Downloading ${m.repo.split("/")[1]}`, detail: "", done: total ? Math.min(before, total) : null, total });
  const timer = setInterval(() => { if (job?.total) job.done = Math.min(dirBytes(target), job.total); }, 1000);
  try {
    const spec = { repo: m.repo, ...(m.dir ? { local_dir: target } : {}), ...(m.allow ? { allow: m.allow } : {}) };
    await run(PYTHON, [FETCH, JSON.stringify(spec)], { env: { HF_HOME, PYTHONIOENCODING: "utf-8" } });
  } finally { clearInterval(timer); }
  if (job?.total) job.done = job.total;
}

async function runInstall(pack, gpu) {
  const uv = await ensureUv();
  await ensureEngine(uv, gpu);
  if (pack.noDeps) await run(uv, ["pip", "install", "--python", PYTHON, "--no-deps", ...pack.noDeps], { env: UV_ENV, label: `Installing ${pack.name.toLowerCase()} (code)` });
  if (pack.packages?.length) await run(uv, ["pip", "install", "--python", PYTHON, "-c", LOCK, ...pack.packages], { env: UV_ENV, label: `Installing ${pack.name.toLowerCase()} (packages)` });
  for (const m of pack.models || []) await fetchModel(m);
  if (!pack.installed()) throw new Error("The install finished, but Resonant can't find everything it needs yet. Try again; downloads resume where they stopped.");
  // The running worker started without these; the next request starts a fresh one.
  qwen.stop();
  // If the chosen Qwen size isn't installed but this pack's is, switch to it.
  if (pack.id === "expressive" && !qwen.repoInstalled(`Qwen3-TTS-12Hz-${qwen.size()}-CustomVoice`)) qwen.setSize("0.6B");
}

export function install(id, { gpu = false } = {}) {
  const pack = byId[id];
  if (!pack) throw httpError(404, `No pack '${id}'`);
  if (qwen.remote()) throw httpError(409, "Resonant is using a GPU worker on another machine. Install models there, or switch back to This computer in Settings → Providers.");
  if (job?.state === "running") throw httpError(409, `"${byId[job.pack].name}" is installing. Wait for it to finish, or cancel it.`);
  if (pack.requires && !byId[pack.requires].installed()) throw httpError(409, `Install "${byId[pack.requires].name}" first.`);
  const freeGb = (() => { try { const s = fs.statfsSync(fs.existsSync(HOME) ? HOME : path.dirname(HOME)); return (s.bavail * s.bsize) / GB; } catch { return Infinity; } })();
  const needGb = (pack.models?.length ? 1 : 0) + (engineReady() ? 0 : gpu ? 6 : 2) + 2;
  if (freeGb < needGb) throw httpError(507, `Not enough free space: about ${Math.ceil(needGb)} GB is needed and ${Math.floor(freeGb)} GB is free.`);
  cancelled = false;
  job = { pack: id, state: "running", step: "Starting", detail: "", done: null, total: null, startedAt: Date.now(), error: null };
  fs.mkdirSync(HOME, { recursive: true });
  runInstall(pack, gpu).then(
    () => { Object.assign(job, { state: "done", step: "Installed", detail: "", finishedAt: Date.now() }); },
    (e) => {
      Object.assign(job, { state: cancelled ? "cancelled" : "error", error: cancelled ? null : e.message, step: cancelled ? "Cancelled" : "Failed", finishedAt: Date.now() });
      if (!cancelled) console.error(`[packs] ${id}: ${e.message}`);
    },
  );
  return job;
}

export function cancel() {
  if (job?.state !== "running") throw httpError(409, "Nothing is installing.");
  cancelled = true;
  child?.kill();
  return job;
}

// Removes a pack's models. Python packages stay: they're small and shared between packs.
export function remove(id) {
  const pack = byId[id];
  if (!pack) throw httpError(404, `No pack '${id}'`);
  if (!pack.models?.length) throw httpError(400, `"${pack.name}" has no models of its own to remove.`);
  if (job?.state === "running") throw httpError(409, "Wait for the current install to finish first.");
  const dependent = PACKS.find((p) => p.requires === id && p.installed());
  if (dependent) throw httpError(409, `Remove "${dependent.name}" first; it needs this pack.`);
  qwen.stop();
  for (const m of pack.models) fs.rmSync(modelTarget(m), { recursive: true, force: true });
  return { removed: id };
}
