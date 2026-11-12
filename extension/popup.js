import { getSettings, setSettings, getStatus, headers, DEFAULTS } from "./common.js";

const $ = (s) => document.querySelector(s);
const toBackground = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg });
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

let settings = await getSettings();
let voices = [];

// ---------- connection and voices ----------
// Resonant answers /api/health with { status: "ok", models: {…} }; another program on the same
// port (a common clash on 3000) doesn't.
async function isResonant(origin) {
  try {
    const r = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = r.ok ? await r.json() : null;
    return j?.status === "ok" && typeof j.models === "object";
  } catch { return false; }
}
// Resonant moves to the next free port when 3000 is taken, so look on the usual ones.
async function findResonant() {
  const tries = [3000, 3001, 3002, 3003, 3004, 3005, 8080].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
  const hits = await Promise.all(tries.map(async (o) => ((await isResonant(o)) ? o : null)));
  return hits.find(Boolean) || null;
}

async function connect({ search = true } = {}) {
  const conn = $("[data-conn]");
  const select = $("[data-voice]");
  select.disabled = true;
  try {
    let res;
    try { res = await fetch(`${settings.server}/v2/voices?page_size=500`, { headers: headers(settings) }); }
    catch { throw Object.assign(new Error(`Can't reach Resonant at ${settings.server}. Start it, or change the address under Server.`), { notResonant: true }); }
    if (res.status === 401) throw new Error("This server needs an API key. Add it under Server.");
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) {
      throw Object.assign(new Error(`Something at ${settings.server} answered, but it isn't Resonant. Enter the address you open Resonant at (for example http://localhost:3001) under Server.`), { notResonant: true });
    }
    voices = (await res.json()).voices || [];
    conn.className = "conn ok";
    conn.title = `Connected to ${settings.server}`;
    // Your own voices first, then the rest of the library.
    const mine = voices.filter((v) => v.in_my_voices), rest = voices.filter((v) => !v.in_my_voices);
    const opt = (v) => `<option value="${v.voice_id}">${escape(v.name)}${v.provider === "qwen" ? " · Qwen3" : v.provider === "elevenlabs" ? " · ElevenLabs" : ""}</option>`;
    select.innerHTML = (mine.length ? `<optgroup label="My voices">${mine.map(opt).join("")}</optgroup>` : "") + `<optgroup label="Library">${rest.map(opt).join("")}</optgroup>`;
    if (!voices.some((v) => v.voice_id === settings.voice)) { settings.voice = voices[0]?.voice_id || DEFAULTS.voice; await setSettings({ voice: settings.voice }); }
    select.value = settings.voice;
    select.disabled = false;
    $("[data-read]").disabled = false;
    updateSpeedRow();
    return true;
  } catch (e) {
    // Not Resonant at this address: look for it on this computer and switch if it's found.
    if (e.notResonant && search) {
      const found = await findResonant();
      if (found && found !== settings.server) {
        const old = settings.server;
        settings.server = found;
        await setSettings({ server: found });
        $("[data-server]").value = found;
        if (await connect({ search: false })) {
          showStatus({ state: "info", text: `Resonant wasn't at ${old}, so the extension switched to ${found}.` });
          return true;
        }
      }
    }
    conn.className = "conn bad";
    conn.title = "Not connected";
    select.innerHTML = "<option>Not connected</option>";
    $("[data-read]").disabled = true;
    showStatus({ state: "error", error: e.message });
    $("[data-settings]").open = true;
    return false;
  }
}
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Speed applies to Kokoro and ElevenLabs voices; Qwen3 voices read at their own pace and are slow
// without a GPU, which the hint under the voice says.
function updateSpeedRow() {
  const v = voices.find((x) => x.voice_id === settings.voice);
  $("[data-speed-row]").hidden = v?.provider === "qwen";
  $("[data-voice-hint]").hidden = v?.provider !== "qwen";
}

// ---------- status ----------
function showStatus(s) {
  const box = $("[data-status]");
  const active = s.state === "playing" || s.state === "paused" || s.state === "loading";
  $("[data-controls]").hidden = !active;
  $("[data-read]").hidden = active;
  $("[data-pause]").textContent = s.state === "paused" ? "Resume" : "Pause";
  $("[data-pause]").disabled = s.state === "loading";
  if (s.state === "idle" || !s.state) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `status${s.state === "error" ? " error" : ""}`;
  const what = s.title ? `<b>${escape(s.title.slice(0, 80))}</b><br>` : "";
  const waited = s.since ? Math.max(0, Math.round((Date.now() - s.since) / 1000)) : 0;
  const slow = voices.find((v) => v.voice_id === s.voice)?.provider === "qwen";
  // The position shows whether sound is really playing: if it counts up and you hear nothing,
  // check the volume of the browser or the computer.
  const pos = s.of ? ` · ${clock(s.at)} / ${clock(s.of)}${s.streaming ? "…" : ""}` : "";
  box.innerHTML = s.state === "info" ? escape(s.text)
    : s.state === "error" ? escape(s.error || "Something went wrong.")
    : s.state === "loading" && s.at ? `${what}Waiting for the next sentence…${pos}`
    : s.state === "loading" ? `${what}Preparing the first sentence… ${waited} s${slow && waited >= 5 ? '<br><span class="muted">Qwen3 voices can take a minute or more per sentence without a GPU.</span>' : ""}`
    : s.state === "paused" ? `${what}Paused${pos}`
    : `${what}Reading${s.truncated ? " the first 20,000 characters" : ""}${pos}`;
}
const clock = (t) => `${Math.floor((t || 0) / 60)}:${String(Math.floor((t || 0) % 60)).padStart(2, "0")}`;
let lastStatus = { state: "idle" };
chrome.storage.session.onChanged.addListener((c) => { if (c.status) showStatus((lastStatus = c.status.newValue || { state: "idle" })); });
// Keeps the "Preparing… 12 s" counter moving.
setInterval(() => { if (lastStatus.state === "loading" && !lastStatus.at) showStatus(lastStatus); }, 1000);

// ---------- controls ----------
$("[data-read]").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) toBackground({ type: "read", tabId: tab.id });
};
$("[data-stop]").onclick = () => toBackground({ type: "stop" });
$("[data-pause]").onclick = async () => toBackground({ type: (await getStatus()).state === "paused" ? "resume" : "pause" });
$("[data-voice]").onchange = (e) => { settings.voice = e.target.value; setSettings({ voice: settings.voice }); updateSpeedRow(); };
const speed = $("[data-speed]");
const showSpeed = () => { $("[data-speed-val]").textContent = `${Number(speed.value).toFixed(2)}×`; };
speed.value = settings.speed;
showSpeed();
speed.oninput = showSpeed;
speed.onchange = () => { settings.speed = Number(speed.value); setSettings({ speed: settings.speed }); };

$("[data-server]").value = settings.server;
$("[data-key]").value = settings.key;
$("[data-save]").onclick = async () => {
  let server = $("[data-server]").value.trim().replace(/\/+$/, "") || DEFAULTS.server;
  if (!/^https?:\/\//.test(server)) server = `http://${server}`;
  let origin;
  try { origin = new URL(server).origin; } catch { return showStatus({ state: "error", error: "That address doesn't look right. Example: http://localhost:3000" }); }
  // Servers other than this computer need the user's permission to be contacted.
  if (!LOCAL.test(origin) && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    return showStatus({ state: "error", error: "The extension needs permission to contact that server." });
  }
  settings = { ...settings, server: origin, key: $("[data-key]").value.trim() };
  await setSettings({ server: settings.server, key: settings.key });
  $("[data-server]").value = settings.server;
  showStatus({ state: "idle" });
  if (await connect()) $("[data-settings]").open = false;
};

showStatus((lastStatus = await getStatus()));
// Once the voices are known, redraw an ongoing reading (it may need the Qwen3 note); a "switched
// to port …" message from connect() stays.
connect().then(() => { if (lastStatus.state !== "idle") showStatus(lastStatus); });
