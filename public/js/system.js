// "What this computer can run": the first-run dialog and Settings → This computer.
import { html, $, api, modal, toastError } from "./app.js";

const LEVELS = {
  good: { label: "Works well", cls: "green" },
  slow: { label: "Works, slowly", cls: "amber" },
  limited: { label: "Limited", cls: "red" },
  missing: { label: "Not installed", cls: "" },
};

function factsHtml(s) {
  const gpu = s.gpus[0];
  const rows = [
    ["Processor", `${s.cpu.model} (${s.cpu.threads} threads)`],
    ["Memory", `${s.memory.total_gb} GB`],
    ["Graphics card", gpu ? `${gpu.name} (${gpu.memory_gb} GB)${s.torch && !s.torch.cuda ? ", not used yet" : ""}` : "No NVIDIA card found, so models run on the processor"],
    ["Free space", s.disk.free_gb == null ? "Unknown" : `${s.disk.free_gb} GB`],
  ];
  return html`<dl class="sys-facts">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}
function featuresHtml(s) {
  return html`<div class="credits">${s.features.map((f) => {
    const lv = LEVELS[f.level] || LEVELS.limited;
    return html`<div class="credit"><div class="credit-main"><div class="credit-name">${f.name}</div><div class="small subtle">${f.detail}</div></div><span class="badge ${lv.cls}">${lv.label}</span></div>`;
  })}</div>`;
}

// Renders the check into `box`. With `measure`, runs the speed test first if it hasn't run yet.
export async function renderSystem(box, { measure = false } = {}) {
  box.innerHTML = String(html`<p class="small subtle">Checking this computer…</p>`);
  try {
    let s = await api("/api/system");
    const draw = (note = "") => {
      box.innerHTML = String(html`${factsHtml(s)}${note ? html`<p class="small subtle">${note}</p>` : ""}${featuresHtml(s)}`);
    };
    if (measure && !s.speed) {
      const h = await api("/api/health").catch(() => null);
      draw(h?.models?.tts === "ready"
        ? "Timing the built-in voices on this computer…"
        : "Getting the built-in voices ready, then timing them. The first time, this includes downloading the voice model (about 330 MB), which can take a few minutes.");
      try { await api("/api/system/speed", { method: "POST" }); } catch (e) { toastError(e); }
      s = await api("/api/system");
    }
    draw();
    return s;
  } catch (e) {
    box.innerHTML = String(html`<p class="small" style="color:var(--danger)">Couldn't check this computer: ${e.message}</p>`);
    return null;
  }
}

// Shown once, the first time Resonant opens.
export function showSystemCheck() {
  const done = () => api("/api/settings", { method: "PATCH", json: { system_check_seen: true } }).catch(() => {});
  modal({
    title: "What this computer can run",
    wide: true,
    body: html`<p class="muted small" style="margin-top:0">Resonant runs everything on this computer. Here's how each part of the studio will work on it. You can see this again any time in Settings → This computer.</p><div data-sys></div>`,
    foot: html`<a class="btn" href="/app/settings#models" data-link data-close>Choose models</a><button class="btn btn-primary" data-close>Got it</button>`,
    onMount: (m) => renderSystem($("[data-sys]", m), { measure: true }),
    onClose: done,
  });
}
