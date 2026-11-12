// Optional cloud provider: forwards to the public ElevenLabs API with the user's own key.
import { getSetting } from "../db.mjs";
import { httpError } from "../audio.mjs";

const BASE = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";

export const apiKey = () => getSetting("elevenlabs_api_key") || process.env.ELEVENLABS_API_KEY || null;
export const enabled = () => Boolean(apiKey());

async function call(pathname, { method = "GET", json, form, query, raw = false, key = apiKey() } = {}) {
  if (!key) throw httpError(400, "No ElevenLabs API key configured. Add one in Settings → Providers.");
  const url = new URL(pathname, BASE);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  const headers = { "xi-api-key": key };
  let body;
  if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.detail?.message || j.detail?.status || (typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j)); } catch {}
    throw httpError(res.status === 401 ? 400 : res.status, `ElevenLabs: ${msg}`);
  }
  if (raw) return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "audio/mpeg" };
  return res.json();
}

export async function verifyKey(key) {
  return call("/v1/user", { key });
}

export async function listVoices() {
  const out = [];
  let token;
  do {
    const page = await call("/v2/voices", { query: { page_size: 100, next_page_token: token } });
    out.push(...page.voices);
    token = page.has_more ? page.next_page_token : null;
  } while (token);
  return out.map((v) => ({ ...v, provider: "elevenlabs" }));
}

export async function listModels() {
  const models = await call("/v1/models");
  return models.map((m) => ({ ...m, provider: "elevenlabs" }));
}

export const subscription = () => call("/v1/user/subscription");

export function tts(voice_id, body, output_format) {
  return call(`/v1/text-to-speech/${encodeURIComponent(voice_id)}`, { method: "POST", json: body, query: { output_format }, raw: true });
}

export function sts(voice_id, file, fileName, fields, output_format) {
  const form = new FormData();
  form.set("audio", new Blob([file]), fileName || "audio");
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return call(`/v1/speech-to-speech/${encodeURIComponent(voice_id)}`, { method: "POST", form, query: { output_format }, raw: true });
}

export function stt(file, fileName, fields) {
  const form = new FormData();
  form.set("file", new Blob([file]), fileName || "audio");
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") form.set(k, String(v));
  return call("/v1/speech-to-text", { method: "POST", form });
}

export function sfx(body, output_format) {
  return call("/v1/sound-generation", { method: "POST", json: body, query: { output_format }, raw: true });
}

export function isolate(file, fileName) {
  const form = new FormData();
  form.set("audio", new Blob([file]), fileName || "audio");
  return call("/v1/audio-isolation", { method: "POST", form, raw: true });
}

export function addVoice(name, description, files, labels) {
  const form = new FormData();
  form.set("name", name);
  if (description) form.set("description", description);
  if (labels) form.set("labels", JSON.stringify(labels));
  for (const f of files) form.append("files", new Blob([f.buffer], { type: f.type }), f.name);
  return call("/v1/voices/add", { method: "POST", form });
}

export const deleteVoice = (id) => call(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
