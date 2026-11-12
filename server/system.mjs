// What this computer can run: hardware facts, plus a plain-language verdict for each feature.
// Shown on first run and in Settings → This computer.
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";

const GB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;
const run = (cmd, args, timeout) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  } catch { resolve(null); }
});

// NVIDIA cards, through nvidia-smi (installed with the driver). Other GPUs aren't used by the
// Python worker, so they aren't listed.
async function nvidiaGpus() {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], 5000);
  if (!out) return [];
  return out.trim().split(/\r?\n/).map((line) => {
    const [name, mb] = line.split(",").map((s) => s.trim());
    return { name, memory_gb: round1(Number(mb) / 1024) };
  }).filter((g) => g.name && g.memory_gb > 0);
}

// Whether the Python worker's PyTorch can use the graphics card. Starting Python takes a few
// seconds, so this runs once per server start.
async function torchInfo(python) {
  if (!python || !fs.existsSync(python)) return null;
  const out = await run(python, ["-c", "import torch; print(torch.__version__); print(torch.cuda.is_available())"], 60_000);
  if (!out) return null;
  const [version, cuda] = out.trim().split(/\r?\n/);
  return { version, cuda: cuda === "True" };
}

function diskFreeGb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return round1((s.bavail * s.bsize) / GB);
  } catch { return null; }
}

let slow = null; // the GPU and PyTorch checks, run once
export async function hardware({ python, dataDir }) {
  slow ??= Promise.all([nvidiaGpus(), torchInfo(python)]);
  const [gpus, torch] = await slow;
  const cpus = os.cpus();
  return {
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    cpu: { model: (cpus[0]?.model || "Unknown processor").replace(/\((R|TM|tm|r)\)/g, "").replace(/\s+/g, " ").trim(), threads: cpus.length },
    memory: { total_gb: round1(os.totalmem() / GB), free_gb: round1(os.freemem() / GB) },
    gpus,
    torch,
    disk: { free_gb: diskFreeGb(dataDir) },
  };
}

// One verdict per feature. level: "good" (works well), "slow" (works, but takes a while),
// "limited" (may not work well on this machine) or "missing" (not installed).
export function verdicts(hw, q, speed) {
  const ram = hw.memory.total_gb;
  const gpu = hw.gpus[0];
  const list = [];

  const rtf = speed?.rtf;
  list.push({
    id: "voices", name: "Built-in voices and reading web pages",
    level: ram >= 4 ? "good" : "limited",
    detail: ram >= 4
      ? `Start speaking in about a second.${rtf ? ` Measured on this computer: speech is made ${rtf >= 1.5 ? `${round1(rtf)}× faster than it plays` : rtf >= 1 ? "a little faster than it plays" : "slower than it plays, so playback may pause"}.` : ""}`
      : "This computer has little memory; the voices may be slow to load.",
  });

  list.push({ id: "transcribe", name: "Speech to text", level: "good", detail: "Transcribes faster than real time." });

  // Qwen3: expressive voices, cloning, voice design, other languages, dubbing voices.
  const qwenName = "Expressive voices, cloning, voice design and dubbing";
  if (q.remote?.connected) {
    list.push({ id: "qwen", name: qwenName, level: "good", detail: `Runs on your GPU worker${q.remote.gpu ? ` (${q.remote.gpu})` : ""}.` });
  } else if (!q.available && !q.canDesign) {
    list.push({ id: "qwen", name: qwenName, level: "missing",
      detail: `Not installed. They need the optional Python setup described in the README (about 5 to 10 GB).${ram < 16 ? " This computer has less than 16 GB of memory, so expect them to be slow or to run out of memory." : ""}` });
  } else if (hw.torch?.cuda) {
    list.push({ id: "qwen", name: qwenName, level: "good", detail: `Runs on your graphics card${gpu ? ` (${gpu.name})` : ""}.` });
  } else {
    const level = ram >= 16 ? "slow" : "limited";
    const base = ram >= 16
      ? "Works on the processor, but takes about a minute per sentence. Good for clips you save, too slow for live reading."
      : ram >= 8
        ? `Works on the processor but slowly, and memory is tight. Use the 0.6B model size${q.size === "1.7B" ? " (it's set to 1.7B now, which needs about 7 GB free)" : ""}.`
        : "This computer probably has too little memory for these models (they need about 8 GB free).";
    const tip = gpu
      ? ` Your ${gpu.name} isn't being used yet: installing the CUDA build of PyTorch would make these 20 to 50 times faster (README → GPU worker).`
      : "";
    list.push({ id: "qwen", name: qwenName, level, detail: base + tip });
  }

  list.push({
    id: "sfx", name: "Sound effects",
    level: ram >= 8 ? "slow" : "limited",
    detail: ram >= 8 ? "Works on the processor, a few seconds of work per second of sound." : "Needs about 2 GB of free memory; may fail on this computer.",
  });

  const free = hw.disk.free_gb;
  if (free != null && free < 15) {
    list.push({ id: "disk", name: "Storage", level: "limited",
      detail: `Only ${free} GB free where Resonant keeps its data. The models need up to 15 GB, and your audio adds more over time.` });
  }
  return list;
}
