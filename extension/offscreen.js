// The audio player. It streams MP3 from Resonant's /stream endpoint into an <audio> element
// through MediaSource, so reading starts after the first sentence instead of the whole page.
// Offscreen documents only have chrome.runtime, so status goes to the background worker.
import { headers } from "./common.js";

const audio = new Audio();
let job = null;
const report = (status) => chrome.runtime.sendMessage({ target: "background", type: "status", status: { ...status, title: job?.title } }).catch(() => {});

// Playback position goes with every report, so the popup can show that sound is really playing.
const position = () => ({ at: audio.currentTime, of: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0, streaming: job?.stream !== "done" });
let lastTick = 0;
audio.onplaying = () => job && report({ state: "playing", ...position() });
audio.ontimeupdate = () => {
  if (!job || audio.paused || Date.now() - lastTick < 900) return;
  lastTick = Date.now();
  report({ state: "playing", ...position() });
};
audio.onwaiting = () => job && job.stream !== "done" && report({ state: "loading", ...position() });
audio.onended = () => { if (job) { job = null; report({ state: "idle" }); } };

function stop() {
  job?.ctrl.abort();
  job = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

async function play({ text, settings, title }) {
  stop();
  const ctrl = new AbortController();
  const me = (job = { ctrl, title, stream: "open" });
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  await new Promise((ok) => ms.addEventListener("sourceopen", ok, { once: true }));
  const sb = ms.addSourceBuffer("audio/mpeg");
  const append = (buf) => new Promise((ok, bad) => {
    sb.addEventListener("updateend", ok, { once: true });
    sb.addEventListener("error", bad, { once: true });
    sb.appendBuffer(buf);
  });
  try {
    let res;
    try {
      res = await fetch(`${settings.server}/v1/text-to-speech/${encodeURIComponent(settings.voice)}/stream?output_format=mp3_44100_128`, {
        method: "POST", signal: ctrl.signal,
        headers: headers(settings, { "content-type": "application/json" }),
        body: JSON.stringify({ text, voice_settings: { speed: Number(settings.speed) || 1 } }),
      });
    } catch (e) {
      if (e.name === "AbortError") return;
      throw new Error(`Can't reach Resonant at ${settings.server}. Is it running?`);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { msg = (await res.json()).detail?.message || msg; } catch {}
      if (res.status === 401) msg = "Resonant needs an API key. Add it in the extension's settings.";
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    let started = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || job !== me) break;
      await append(value);
      if (!started) { started = true; audio.play().catch(() => {}); }
    }
    if (job !== me) return;
    me.stream = "done";
    if (ms.readyState === "open") ms.endOfStream();
    if (!started) { job = null; report({ state: "idle" }); }
  } catch (e) {
    if (e.name === "AbortError" || job !== me) return;
    job = null;
    report({ state: "error", error: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "play") play(msg);
  else if (msg.type === "stop") stop();
  else if (msg.type === "pause") { audio.pause(); report({ state: "paused", ...position() }); }
  else if (msg.type === "resume") audio.play().catch(() => {});
});
