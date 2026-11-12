// End-to-end API test against a running server. Usage: BASE=http://127.0.0.1:3000 node scripts/api-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const KEY = process.env.RESONANT_API_KEY;
const headers = KEY ? { "xi-api-key": KEY } : {};
let failures = 0;

// ONLY=<regex> runs just the matching steps (setup steps such as "tts wav" still run when they match).
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t} ms)`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`); if (process.env.TRACE) console.log(e.stack); }
}
const req = (p, init = {}) => fetch(BASE + p, { ...init, headers: { ...headers, ...init.headers } })
  .catch((e) => { e.message += ` (${init.method || "GET"} ${p})`; throw e; });
const jsonReq = async (p, init) => { const r = await req(p, init); const b = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`); return b; };
const post = (p, body) => req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let ttsId, wav, transcriptId;

await step("health", async () => { const h = await jsonReq("/api/health"); assert.equal(h.status, "ok"); assert.match(h.version, /^\d+\.\d+\.\d+/); });
await step("system check: hardware facts and a verdict per feature", async () => {
  const s = await jsonReq("/api/system");
  assert.ok(s.cpu.threads > 0 && s.memory.total_gb > 0, "cpu and memory");
  assert.ok(Array.isArray(s.gpus));
  assert.doesNotMatch(s.cpu.model, /\((R|TM)\)/);
  const ids = s.features.map((f) => f.id);
  for (const id of ["voices", "transcribe", "qwen", "sfx"]) assert.ok(ids.includes(id), `verdict for ${id}`);
  for (const f of s.features) assert.ok(["good", "slow", "limited", "missing"].includes(f.level) && f.detail.length > 10, f.id);
  const sp = await jsonReq("/api/system/speed", { method: "POST" });
  assert.ok(sp.rtf > 0 && sp.audio_seconds > 3, "speed test result");
  assert.match((await jsonReq("/api/system")).features.find((f) => f.id === "voices").detail, /Measured on this computer/);
});
await step("third-party notices match the credits in Settings", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./write-notices.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
await step("voices list + filters", async () => {
  const all = await jsonReq("/v2/voices?page_size=100");
  assert.ok(all.voices.length >= 28, "expected local Kokoro voices");
  const brit = await jsonReq("/v2/voices?accent=british");
  assert.ok(brit.voices.length > 0 && brit.voices.every((v) => v.labels.accent === "british"));
  const page = await jsonReq("/v2/voices?page_size=5");
  assert.equal(page.voices.length, 5); assert.equal(page.has_more, true);
});
await step("models", async () => { const m = await jsonReq("/v1/models"); assert.ok(m.find((x) => x.model_id === "kokoro_82m")); });
await step("tts mp3", async () => {
  const r = await post("/v1/text-to-speech/af_heart", { text: "The quick brown fox jumps over the lazy dog.", voice_settings: { speed: 1.1 } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  ttsId = r.headers.get("history-item-id");
  assert.ok((await r.arrayBuffer()).byteLength > 5000, "mp3 too small");
});
await step("tts wav_16000 for round trip", async () => {
  const r = await post("/v1/text-to-speech/bm_george?output_format=wav_16000", { text: "Welcome to the studio. Today we are testing speech recognition." });
  assert.equal(r.status, 200);
  wav = Buffer.from(await r.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
});
await step("tts stream: first audio early, history id up front, saved once complete", async () => {
  const t = Date.now();
  const r = await post("/v1/text-to-speech/af_bella/stream", { text: "First sentence streams early. Then a longer second part follows, with enough words to take the voice a little while to read out loud." });
  assert.equal(r.status, 200);
  const id = r.headers.get("history-item-id");
  assert.ok(id, "history-item-id header");
  let bytes = 0, first = 0, reads = 0;
  for await (const c of r.body) { if (!first) first = Date.now() - t; bytes += c.length; reads++; }
  const total = Date.now() - t;
  assert.ok(reads >= 2, "arrives in pieces");
  assert.ok(first < total * 0.75, `first audio at ${first} ms of ${total} ms`);
  const saved = await req(`/v1/history/${id}/audio`);
  assert.equal(saved.status, 200);
  const buf = Buffer.from(await saved.arrayBuffer());
  assert.equal(buf.length, bytes, "history keeps exactly what was streamed");
  assert.equal(buf[0], 0xff, "starts with an MP3 frame");
  await req(`/v1/history/${id}`, { method: "DELETE" });
});
await step("tts stream: a client that stops early leaves nothing in history", async () => {
  const ctrl = new AbortController();
  const r = await req("/v1/text-to-speech/af_bella/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Stop me. " + "This part should never be finished or saved, because the listener has already gone. ".repeat(3) }), signal: ctrl.signal });
  const id = r.headers.get("history-item-id");
  await r.body.getReader().read();
  ctrl.abort();
  await new Promise((s) => setTimeout(s, 15000));
  assert.equal((await req(`/v1/history/${id}`)).status, 404);
});
await step("tts stream: wav is refused", async () => {
  assert.equal((await post("/v1/text-to-speech/af_bella/stream?output_format=wav_24000", { text: "Hi." })).status, 400);
});
await step("tts validation", async () => {
  assert.equal((await post("/v1/text-to-speech/af_heart", {})).status, 422);
  assert.equal((await post("/v1/text-to-speech/nope", { text: "hi" })).status, 404);
  assert.equal((await post("/v1/text-to-speech/af_heart?output_format=ogg_1", { text: "hi" })).status, 400);
});
await step("stt round trip (wav)", async () => {
  const form = new FormData();
  form.set("file", new Blob([wav], { type: "audio/wav" }), "test.wav");
  const t = await jsonReq("/v1/speech-to-text", { method: "POST", body: form });
  assert.match(t.text.toLowerCase(), /welcome to the studio/);
  assert.ok(t.words.some((w) => w.type === "word" && w.end > w.start));
  transcriptId = t.transcription_id;
});
await step("stt mp3 input", async () => {
  const mp3 = Buffer.from(await (await req(`/v1/history/${ttsId}/audio`)).arrayBuffer());
  const form = new FormData();
  form.set("file", new Blob([mp3], { type: "audio/mpeg" }), "fox.mp3");
  const t = await jsonReq("/v1/speech-to-text", { method: "POST", body: form });
  assert.match(t.text.toLowerCase(), /quick brown fox/);
});
await step("transcripts list/get/delete", async () => {
  const l = await jsonReq("/api/transcripts");
  assert.ok(l.transcripts.find((x) => x.transcription_id === transcriptId));
  const g = await jsonReq(`/v1/speech-to-text/transcripts/${transcriptId}`);
  assert.ok(Array.isArray(g.words));
  await jsonReq(`/v1/speech-to-text/transcripts/${transcriptId}`, { method: "DELETE" });
});
await step("voice changer (local re-voice)", async () => {
  const form = new FormData();
  form.set("audio", new Blob([wav], { type: "audio/wav" }), "in.wav");
  form.set("mode", "revoice");
  const r = await req("/v1/speech-to-speech/af_sky", { method: "POST", body: form });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(decodeURIComponent(r.headers.get("x-transcript")).toLowerCase(), /studio/);
});
if ((await jsonReq("/api/settings")).qwen.can_convert) await step("voice changer (local convert): same length, same words", async () => {
  const inSeconds = (wav.length - 44) / 2 / 16000;
  const form = new FormData();
  form.set("audio", new Blob([wav], { type: "audio/wav" }), "in.wav");
  const r = await req("/v1/speech-to-speech/af_heart?output_format=wav_16000", { method: "POST", body: form });
  assert.equal(r.status, 200, await r.clone().text());
  const out = Buffer.from(await r.arrayBuffer());
  const outSeconds = (out.length - 44) / 2 / 16000;
  assert.ok(Math.abs(outSeconds - inSeconds) < 0.1, `timing kept: ${inSeconds.toFixed(2)}s in, ${outSeconds.toFixed(2)}s out`);
  const id = r.headers.get("history-item-id");
  assert.equal((await jsonReq(`/v1/history/${id}`)).model_id, "openvoice_v2");
  const f2 = new FormData();
  f2.set("file", new Blob([out], { type: "audio/wav" }), "converted.wav");
  const t = await jsonReq("/v1/speech-to-text", { method: "POST", body: f2 });
  assert.match(t.text.toLowerCase(), /testing speech recognition/, t.text);
  await req(`/v1/speech-to-text/transcripts/${t.transcription_id}`, { method: "DELETE" });
  await req(`/v1/history/${id}`, { method: "DELETE" });
  const bad = new FormData();
  bad.set("audio", new Blob([wav], { type: "audio/wav" }), "in.wav");
  bad.set("mode", "nope");
  assert.equal((await req("/v1/speech-to-speech/af_heart", { method: "POST", body: bad })).status, 422);
});
await step("sound effect (local, 1s)", async () => {
  const r = await post("/v1/sound-generation", { text: "wooden door creaking", duration_seconds: 1 });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok((await r.arrayBuffer()).byteLength > 2000);
});
await step("history list/filter/paginate/feedback/download", async () => {
  const h = await jsonReq("/v1/history?page_size=2");
  assert.equal(h.history.length, 2); assert.equal(h.has_more, true);
  const next = await jsonReq(`/v1/history?page_size=2&start_after_history_item_id=${h.last_history_item_id}`);
  assert.ok(!next.history.some((x) => h.history.find((y) => y.history_item_id === x.history_item_id)));
  const sfx = await jsonReq("/v1/history?source=SFX");
  assert.ok(sfx.history.length > 0 && sfx.history.every((x) => x.source === "SFX"));
  const s = await jsonReq("/v1/history?search=brown%20fox");
  assert.ok(s.history.find((x) => x.history_item_id === ttsId));
  await jsonReq(`/api/history/${ttsId}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thumbs_up: true }) });
  const z = await post("/v1/history/download", { history_item_ids: h.history.map((x) => x.history_item_id) });
  assert.equal(z.headers.get("content-type"), "application/zip");
  assert.equal(Buffer.from(await z.arrayBuffer()).readUInt32LE(0), 0x04034b50);
});
await step("voice meta + preview", async () => {
  await jsonReq("/api/voices/af_nicole/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ favorite: true, in_my_voices: true }) });
  const mine = await jsonReq("/v2/voices?voice_type=personal");
  assert.ok(mine.voices.find((v) => v.voice_id === "af_nicole"));
  const p = await req("/v1/voices/af_nicole/preview");
  assert.equal(p.status, 200);
});
await step("settings + usage", async () => {
  const s = await jsonReq("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "Tester" }) });
  assert.equal(s.display_name, "Tester");
  const u = await jsonReq("/v1/user/subscription");
  assert.ok(u.character_count > 0);
  const bad = await req("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ character_limit: -5 }) });
  assert.equal(bad.status, 422);
});
await step("delete history item", async () => {
  await jsonReq(`/v1/history/${ttsId}`, { method: "DELETE" });
  assert.equal((await req(`/v1/history/${ttsId}`)).status, 404);
});

const qwen = (await jsonReq("/api/settings")).qwen;
if (!qwen?.available) console.log("skip Qwen3-TTS (not installed)");
else {
  let refWav;
  await step("qwen preset voice + style instructions", async () => {
    const r = await post("/v1/text-to-speech/qwen_ryan?output_format=wav_24000", { text: "Welcome back to the show, everyone. Today we have a wonderful story to share with all of you.", instructions: "Calm, warm narrator", language_code: "en" });
    assert.equal(r.status, 200, await r.clone().text());
    refWav = Buffer.from(await r.arrayBuffer());
    // Also serves as the clone reference below, which needs at least 3 s.
    assert.ok(refWav.length > 24000 * 2 * 3.5, "expected over 3.5 s of audio");
    assert.equal((await post("/v1/text-to-speech/qwen_ryan", { text: "hi", model_id: "kokoro_82m" })).status, 400);
  });
  if (qwen.can_clone && refWav) await step("qwen clone, speak, delete", async () => {
    const form = new FormData();
    form.set("name", "API test clone");
    form.set("provider", "qwen");
    form.append("files", new Blob([refWav], { type: "audio/wav" }), "ref.wav");
    const add = await jsonReq("/v1/voices/add", { method: "POST", body: form });
    assert.match(add.transcript.toLowerCase(), /welcome back/);
    const v = await jsonReq(`/v1/voices/${add.voice_id}`);
    assert.equal(v.category, "cloned");
    assert.ok(!JSON.stringify(v).includes("ref_audio"), "internal paths must not leak");
    const r = await post(`/v1/text-to-speech/${add.voice_id}`, { text: "Testing the cloned voice." });
    assert.equal(r.status, 200, await r.clone().text());
    await jsonReq(`/v1/voices/${add.voice_id}`, { method: "DELETE" });
    assert.equal((await req(`/v1/voices/${add.voice_id}`)).status, 404);
  });
  await step("qwen model size setting", async () => {
    const patch = (qwen_size) => req("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ qwen_size }) });
    assert.equal((await patch("3B")).status, 422);
    // Switching only restarts the worker on next use, so flipping and restoring is cheap.
    for (const opt of qwen.sizes.filter((s) => s.voices)) {
      const s = await (await patch(opt.size)).json();
      assert.equal(s.qwen.size, opt.size);
      assert.ok((await jsonReq("/v1/models")).some((m) => m.name === `Qwen3-TTS ${opt.size}`));
    }
    assert.equal((await (await patch(qwen.size)).json()).qwen.size, qwen.size);
  });
  if (qwen.can_design) await step("qwen voice design, save, speak, delete", async () => {
    assert.equal((await post("/v1/text-to-voice/design", { voice_description: "short" })).status, 422);
    const d = await (await post("/v1/text-to-voice/design", { voice_description: "A bright, cheerful young woman with a quick, upbeat pace.", text: "Hi there, it is lovely to meet you today." })).json();
    const [p] = d.previews;
    assert.ok(p.generated_voice_id && p.audio_base_64.length > 1000 && p.duration_secs > 1);
    const v = await (await post("/v1/text-to-voice", { voice_name: "API test design", voice_description: "cheerful", generated_voice_id: p.generated_voice_id })).json();
    assert.equal(v.category, "generated");
    assert.ok(!JSON.stringify(v).includes("ref_audio"), "internal paths must not leak");
    // A preview can be saved only once.
    assert.equal((await post("/v1/text-to-voice", { voice_name: "x", voice_description: "x", generated_voice_id: p.generated_voice_id })).status, 404);
    const r = await post(`/v1/text-to-speech/${v.voice_id}`, { text: "Testing the designed voice." });
    assert.equal(r.status, 200, await r.clone().text());
    await jsonReq(`/v1/voices/${v.voice_id}`, { method: "DELETE" });
    assert.equal((await req(`/v1/voices/${v.voice_id}`)).status, 404);
  });
}

// ---------- Studio: document import ----------
const crc32 = (await import("node:zlib")).crc32;
const { deflateRawSync } = await import("node:zlib");
// Small zip writer for the EPUB fixture (stored and deflated entries, like real EPUBs).
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name), crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// One-page PDF with a real text layer (Helvetica, one line per Tj).
function pdf(title, lines) {
  const esc = (s) => s.replace(/[()\\]/g, "\\$&");
  const content = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${esc(title)}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const importDoc = async (name, buf, type) => {
  const form = new FormData();
  form.set("file", new Blob([buf], { type }), name);
  return jsonReq("/api/studio/import", { method: "POST", body: form });
};
const para = (s) => `${s} `.repeat(12).trim();

await step("studio import: text with chapter headings", async () => {
  const text = `Front matter.\n\nChapter 1: The Harbor\n\n${para("Gulls circled the quiet harbor.")}\n\nCHAPTER TWO\n\n${para("The storm arrived at night.")}\n\n# Epilogue\n\n${para("Morning came softly.")}`;
  const doc = await importDoc("the_harbor.txt", Buffer.from(text), "text/plain");
  assert.equal(doc.title, "the harbor");
  assert.deepEqual(doc.chapters.map((c) => c.title), ["Chapter 1: The Harbor", "CHAPTER TWO", "Epilogue"]);
  assert.ok(doc.chapters[1].text.startsWith("The storm"));
});
await step("studio import: epub (spine order, skips cover and nav)", async () => {
  const page = (h, body) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${h ? `<h1>${h}</h1>` : ""}${body}</body></html>`;
  const epub = zip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
    ["OEBPS/content.opf", `<?xml version="1.0"?><package><metadata><dc:title>The Lantern &amp; the Sea</dc:title></metadata><manifest>
      <item id="nav" href="nav.xhtml" properties="nav"/><item id="cover" href="cover.xhtml"/><item id="c1" href="text/one.xhtml"/><item id="c2" href="text/two.xhtml"/></manifest>
      <spine><itemref idref="cover"/><itemref idref="nav"/><itemref idref="c2"/><itemref idref="c1"/></spine></package>`, true],
    ["OEBPS/nav.xhtml", page("Contents", `<p>${para("Table of contents entry.")}</p>`)],
    ["OEBPS/cover.xhtml", page("", "<p>Cover</p>")],
    ["OEBPS/text/one.xhtml", page("The Keeper", `<p>${para("He lit the lamp &mdash; again.")}</p><p>Second paragraph.</p>`), true],
    ["OEBPS/text/two.xhtml", page("The Visitor", `<p>${para("A boat came in &amp; stayed.")}</p>`), true],
  ]);
  const doc = await importDoc("book.epub", epub, "application/epub+zip");
  assert.equal(doc.title, "The Lantern & the Sea");
  assert.deepEqual(doc.chapters.map((c) => c.title), ["The Visitor", "The Keeper"]);
  assert.ok(doc.chapters[1].text.includes("He lit the lamp — again.") && doc.chapters[1].text.includes("\n\nSecond paragraph."));
  assert.ok(!doc.chapters[0].text.startsWith("The Visitor"), "heading shouldn't repeat in the text");
});
await step("studio import: pdf text layer", async () => {
  const doc = await importDoc("scan.pdf", pdf("Night Train", ["Chapter 1", "The train left the station just after", "midnight, and the carriage was empty.", "Chapter 2", "By dawn the hills had turned to gold", "and the conductor finally spoke."]), "application/pdf");
  assert.equal(doc.title, "Night Train");
  assert.equal(doc.chapters.length, 2, JSON.stringify(doc.chapters));
  assert.match(doc.chapters[0].text, /train left the station just after midnight/);
});
await step("studio import: rejects unsupported files", async () => {
  const form = new FormData();
  form.set("file", new Blob([Buffer.from("x")]), "notes.docx");
  assert.equal((await req("/api/studio/import", { method: "POST", body: form })).status, 415);
});

// ---------- Studio: project lifecycle with a fast Kokoro voice ----------
await step("studio project: create, generate, outdated, export, delete", async () => {
  const p = await (await post("/api/studio/projects", { title: "API test book", voice_id: "af_heart", text: `Chapter 1\n\nThe first chapter is short.\n\nIt has two paragraphs.\n\nChapter 2\n\nThe second chapter is shorter.` })).json();
  assert.equal(p.chapters.length, 2, JSON.stringify(p));
  const [c1, c2] = p.chapters;
  assert.equal(c1.title, "Chapter 1");
  const r = await post(`/api/studio/chapters/${c1.chapter_id}/generate`, {});
  assert.equal(r.status, 200, await r.clone().text());
  let ch;
  for (let i = 0; i < 120; i++) {
    ch = (await jsonReq(`/api/studio/projects/${p.project_id}?text=0`)).chapters[0];
    if (ch.status === "done" || ch.status === "failed") break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(ch.status, "done", ch.error);
  assert.ok(ch.duration > 2 && ch.duration < 20, `duration ${ch.duration}`);
  const a = await req(`/api/studio/chapters/${c1.chapter_id}/audio`);
  assert.equal(a.headers.get("content-type"), "audio/mpeg");
  const mp3 = Buffer.from(await a.arrayBuffer());
  assert.ok(mp3.length > 10000);
  // Editing the text marks the audio out of date; renaming the project doesn't.
  await jsonReq(`/api/studio/projects/${p.project_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed book" }) });
  assert.equal((await jsonReq(`/api/studio/projects/${p.project_id}`)).chapters[0].outdated, false);
  // A dictionary word that appears in the chapter changes what's read, so the audio is out of date.
  const rule = await (await post("/api/pronunciation", { word: "paragraphs", alias: "para graphs" })).json();
  assert.equal((await jsonReq(`/api/studio/projects/${p.project_id}`)).chapters[0].outdated, true);
  await req(`/api/pronunciation/${rule.rule_id}`, { method: "DELETE" });
  assert.equal((await jsonReq(`/api/studio/projects/${p.project_id}`)).chapters[0].outdated, false);
  const edited = await jsonReq(`/api/studio/chapters/${c1.chapter_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Changed." }) });
  assert.equal(edited.outdated, true);
  // Exports include only chapters with audio.
  const whole = await req(`/api/studio/projects/${p.project_id}/export?format=mp3`);
  assert.equal(whole.status, 200);
  assert.equal(Buffer.from(await whole.arrayBuffer()).length, mp3.length);
  const z = Buffer.from(await (await req(`/api/studio/projects/${p.project_id}/export?format=zip`)).arrayBuffer());
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.ok(z.includes(Buffer.from("01 - Chapter 1.mp3")));
  // Moving, adding, cancelling, deleting.
  await jsonReq(`/api/studio/chapters/${c2.chapter_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ move: -1 }) });
  assert.equal((await jsonReq(`/api/studio/projects/${p.project_id}`)).chapters[0].chapter_id, c2.chapter_id);
  const added = await (await post(`/api/studio/projects/${p.project_id}/chapters`, { after: c2.chapter_id, title: "Inserted", text: "" })).json();
  assert.equal((await jsonReq(`/api/studio/projects/${p.project_id}`)).chapters[1].chapter_id, added.chapter_id);
  assert.equal((await post(`/api/studio/chapters/${added.chapter_id}/generate`, {})).status, 422, "empty chapters can't be generated");
  assert.equal((await jsonReq(`/api/studio/projects`)).projects.some((x) => x.project_id === p.project_id), true);
  await jsonReq(`/api/studio/projects/${p.project_id}`, { method: "DELETE" });
  assert.equal((await req(`/api/studio/projects/${p.project_id}`)).status, 404);
});

// ---------- Voice isolation (local Demucs) ----------
const settingsNow = await jsonReq("/api/settings");
if (settingsNow.qwen.can_isolate && wav) await step("voice isolation (local Demucs) keeps the words", async () => {
  // Speech plus loud hum and noise, as 16 kHz WAV.
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
  const noisy = Buffer.from(wav);
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768 + 0.12 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.05 * (Math.random() * 2 - 1);
    noisy.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2);
  }
  const form = new FormData();
  form.set("audio", new Blob([noisy], { type: "audio/wav" }), "noisy.wav");
  form.set("provider", "local");
  const r = await req("/v1/audio-isolation", { method: "POST", body: form });
  assert.equal(r.status, 200, await r.clone().text());
  const id = r.headers.get("history-item-id");
  const out = Buffer.from(await r.arrayBuffer());
  assert.ok(out.length > 5000);
  assert.equal((await jsonReq(`/v1/history/${id}`)).model_id, "demucs_htdemucs");
  const f2 = new FormData();
  f2.set("file", new Blob([out], { type: "audio/mpeg" }), "isolated.mp3");
  f2.set("language_code", "en");
  const t = await jsonReq("/v1/speech-to-text", { method: "POST", body: f2 });
  assert.match(t.text.toLowerCase(), /speech recognition/, t.text);
  await jsonReq(`/v1/history/${id}`, { method: "DELETE" });
});
// ---------- Accurate transcription and speaker detection ----------
// Two Kokoro voices taking turns (A, B, A), as 16 kHz WAV.
async function conversation() {
  const turns = [["bm_george", "Good morning, and welcome to the weekly product meeting."], ["af_heart", "Thanks. I have two updates on the mobile app this week."], ["bm_george", "Great, go ahead whenever you are ready."]];
  const parts = [];
  for (const [v, text] of turns) parts.push(Buffer.from(await (await post(`/v1/text-to-speech/${v}?output_format=pcm_16000`, { text })).arrayBuffer()), Buffer.alloc(16000 * 2 * 0.7));
  const data = Buffer.concat(parts), head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
async function sttWith(wavBuf, fields) {
  const form = new FormData();
  form.set("file", new Blob([wavBuf], { type: "audio/wav" }), "meeting.wav");
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  const r = await req("/v1/speech-to-text", { method: "POST", body: form });
  const out = await r.json();
  if (r.ok) await req(`/v1/speech-to-text/transcripts/${out.transcription_id}`, { method: "DELETE" });
  return { status: r.status, out };
}
const sNow = await jsonReq("/api/settings");
if (sNow.qwen.can_transcribe || sNow.qwen.can_diarize) {
  const meeting = await conversation();
  if (sNow.qwen.can_transcribe) await step("whisper large-v3-turbo: punctuation, language, speakers", async () => {
    const { status, out } = await sttWith(meeting, { model_id: "whisper_large_v3_turbo", diarize: true });
    assert.equal(status, 200, JSON.stringify(out));
    assert.equal(out.language_code, "en");
    assert.ok(out.language_probability > 0.8);
    assert.match(out.text, /^Good morning,? and welcome to the weekly product meeting\. Thanks/);
    const ws = out.words.filter((w) => w.type === "word");
    assert.deepEqual([...new Set(ws.map((w) => w.speaker_id))], ["speaker_0", "speaker_1"]);
    assert.equal(ws.find((w) => /^Thanks/.test(w.text)).speaker_id, "speaker_1");
    assert.equal(ws.at(-1).speaker_id, "speaker_0", "the first speaker comes back for the last line");
    assert.ok(out.words.some((w) => w.type === "spacing"), "Scribe-shaped words");
  });
  if (sNow.qwen.can_diarize) await step("whisper base + speaker detection, and a fixed speaker count", async () => {
    const auto = await sttWith(meeting, { model_id: "whisper_base", diarize: true });
    assert.equal(auto.status, 200, JSON.stringify(auto.out));
    const ws = auto.out.words.filter((w) => w.type === "word");
    assert.equal(new Set(ws.map((w) => w.speaker_id)).size, 2);
    const one = await sttWith(meeting, { model_id: "whisper_base", diarize: true, num_speakers: 1 });
    assert.equal(new Set(one.out.words.map((w) => w.speaker_id)).size, 1, "num_speakers=1 keeps everyone together");
    const off = await sttWith(meeting, { model_id: "whisper_base" });
    assert.ok(off.out.words.every((w) => w.speaker_id === "speaker_0"), "no labels unless asked");
  });
}
await step("speech to text rejects a bad speaker count and unknown models", async () => {
  assert.equal((await sttWith(wav, { model_id: "whisper_base", diarize: true, num_speakers: 0 })).status, 422);
  assert.equal((await sttWith(wav, { model_id: "whisper_tiny_nope" })).status, 400);
});

// ---------- pronunciation dictionary ----------
const sendJson = (method, p, body) => req(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
await step("pronunciation: add, match rules, edit, validate, import, delete", async () => {
  const mine = [];
  const add = async (b) => { const r = await post("/api/pronunciation", b); const out = await r.json(); if (r.ok) mine.push(out.rule_id); return { status: r.status, out }; };
  try {
    assert.equal((await add({ word: "Qorvex", alias: "core vex" })).status, 200);
    assert.equal((await add({ word: "TLA", alias: "three letter acronym", case_sensitive: true })).status, 200);
    assert.equal((await add({ word: "Qorvex Labs", alias: "the lab" })).status, 200);
    assert.equal((await add({ word: "qorvex", alias: "x" })).status, 409, "duplicate word (any case)");
    assert.equal((await add({ word: "  ", alias: "x" })).status, 422);
    assert.equal((await add({ word: "Foo", alias: "" })).status, 422);
    const apply = async (text) => (await (await post("/api/pronunciation/apply", { text })).json()).text;
    assert.equal(await apply("QORVEX met Qorvex Labs. Qorvexian? tla vs TLA."), "core vex met the lab. Qorvexian? tla vs three letter acronym.");
    const r = await (await sendJson("PATCH", `/api/pronunciation/${mine[0]}`, { alias: "cor vex", enabled: false })).json();
    assert.equal(r.alias, "cor vex"); assert.equal(r.enabled, false);
    assert.equal(await apply("Qorvex"), "Qorvex", "disabled rules are skipped");
    assert.equal((await sendJson("PATCH", "/api/pronunciation/nope", { alias: "x" })).status, 404);
    const imp = await (await post("/api/pronunciation/import", { rules: [{ word: "Qorvex", alias: "core vex" }, { word: "Zentrix", alias: "zen tricks" }, { word: "" }] })).json();
    assert.deepEqual([imp.added, imp.updated, imp.errors.length], [1, 1, 1]);
    const list = (await jsonReq("/api/pronunciation")).rules;
    mine.push(list.find((x) => x.word === "Zentrix").rule_id);
    assert.equal(list.find((x) => x.word === "Qorvex").enabled, true, "import re-enables");
  } finally {
    for (const id of mine) await req(`/api/pronunciation/${id}`, { method: "DELETE" });
  }
  assert.equal((await req(`/api/pronunciation/${mine[0]}`, { method: "DELETE" })).status, 404);
});
await step("pronunciation: the voice says the alias, history keeps the typed text", async () => {
  const { rule_id } = await (await post("/api/pronunciation", { word: "Blorptastic", alias: "pizza" })).json();
  try {
    const r = await post("/v1/text-to-speech/bm_george?output_format=wav_16000", { text: "I really love Blorptastic on Fridays." });
    assert.equal(r.status, 200);
    const said = Buffer.from(await r.arrayBuffer());
    const { out } = await sttWith(said, { model_id: "whisper_base" });
    assert.match(out.text.toLowerCase(), /pizza/, `heard: ${out.text}`);
    const h = await jsonReq(`/v1/history/${r.headers.get("history-item-id")}`);
    assert.equal(h.text, "I really love Blorptastic on Fridays.");
    await req(`/v1/history/${h.history_item_id}`, { method: "DELETE" });
  } finally { await req(`/api/pronunciation/${rule_id}`, { method: "DELETE" }); }
});

// ---------- dialogue ----------
await step("dialogue: two voices in order, one file, script saved in history", async () => {
  const inputs = [
    { voice_id: "bm_george", text: "Good morning, and welcome to the show." },
    { voice_id: "af_bella", text: "Thanks, it is lovely to be here today.", speaker: "Anna" },
    { voice_id: "bm_george", text: "Let us begin with the weather." },
  ];
  const r = await post("/v1/text-to-dialogue?output_format=wav_16000", { inputs, settings: { pause_seconds: 0.5 } });
  assert.equal(r.status, 200, await r.clone().text());
  const buf = Buffer.from(await r.arrayBuffer());
  const { out } = await sttWith(buf, { model_id: "whisper_base", ...(sNow.qwen.can_diarize ? { diarize: true } : {}) });
  assert.match(out.text.toLowerCase(), /good morning.*lovely to be here.*weather/s, `heard: ${out.text}`);
  if (sNow.qwen.can_diarize) {
    const ws = out.words.filter((w) => w.type === "word");
    assert.equal(new Set(ws.map((w) => w.speaker_id)).size, 2, "two different voices");
    const first = ws.find((w) => /morning/i.test(w.text)).speaker_id, second = ws.find((w) => /lovely/i.test(w.text)).speaker_id, third = ws.find((w) => /weather/i.test(w.text)).speaker_id;
    assert.ok(first !== second && first === third, "George, Bella, George");
  }
  const h = await jsonReq(`/v1/history/${r.headers.get("history-item-id")}`);
  assert.equal(h.source, "DIALOGUE");
  assert.equal(h.settings.inputs.length, 3);
  assert.match(h.text, /^George: Good morning.*\nAnna: Thanks/s, "speaker names, else voice names");
  assert.equal(h.settings.inputs[1].speaker, "Anna");
  assert.equal(h.character_count, inputs.reduce((n, x) => n + x.text.length, 0));
  assert.ok((await jsonReq("/v1/history?source=DIALOGUE")).history.some((x) => x.history_item_id === h.history_item_id));
  await req(`/v1/history/${h.history_item_id}`, { method: "DELETE" });
});
await step("dialogue stream: lines in script order, first audio early, saved once complete", async () => {
  const inputs = [
    { text: "Apples are red.", voice_id: "af_heart", speaker: "Ana" },
    { text: "Bananas are yellow, and they grow in big bunches on tall plants in warm places.", voice_id: "am_adam", speaker: "Ben" },
    { text: "Grapes are green.", voice_id: "af_heart", speaker: "Ana" },
  ];
  const t = Date.now();
  const r = await post("/v1/text-to-dialogue/stream?output_format=pcm_24000", { inputs, settings: { pause_seconds: 0.4 } });
  assert.equal(r.status, 200);
  const id = r.headers.get("history-item-id");
  assert.ok(id);
  const chunks = [];
  let first = 0;
  for await (const c of r.body) { if (!first) first = Date.now() - t; chunks.push(Buffer.from(c)); }
  const total = Date.now() - t;
  const pcm = Buffer.concat(chunks);
  assert.ok(first < total * 0.6, `first audio at ${first} ms of ${total} ms`);
  // The words come back in script order.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  const form = new FormData();
  form.set("file", new Blob([Buffer.concat([header, pcm])], { type: "audio/wav" }), "dialogue.wav");
  const said = (await jsonReq("/v1/speech-to-text", { method: "POST", body: form })).text.toLowerCase();
  const at = ["apple", "banana", "grape"].map((w) => said.indexOf(w));
  assert.ok(at.every((x) => x >= 0) && at[0] < at[1] && at[1] < at[2], `order in "${said}"`);
  const h = await jsonReq(`/v1/history/${id}`);
  assert.equal(h.source, "DIALOGUE");
  assert.equal(h.settings.inputs.length, 3);
  assert.match(h.text, /^Ana: Apples/);
  await req(`/v1/history/${id}`, { method: "DELETE" });
});
await step("dialogue stream: stopping early saves nothing; wav is refused", async () => {
  const ctrl = new AbortController();
  const inputs = [{ text: "Stop here.", voice_id: "af_heart" }, { text: "This line should never be finished, because the listener has already gone away.", voice_id: "am_adam" }];
  const r = await req("/v1/text-to-dialogue/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inputs }), signal: ctrl.signal });
  const id = r.headers.get("history-item-id");
  await r.body.getReader().read();
  ctrl.abort();
  await new Promise((s) => setTimeout(s, 12000));
  assert.equal((await req(`/v1/history/${id}`)).status, 404);
  assert.equal((await post("/v1/text-to-dialogue/stream?output_format=wav_24000", { inputs })).status, 400);
});
await step("dialogue validation", async () => {
  assert.equal((await post("/v1/text-to-dialogue", {})).status, 422);
  assert.equal((await post("/v1/text-to-dialogue", { inputs: [{ voice_id: "af_heart", text: " " }] })).status, 422);
  assert.equal((await post("/v1/text-to-dialogue", { inputs: [{ text: "hi" }] })).status, 422);
  assert.equal((await post("/v1/text-to-dialogue", { inputs: [{ voice_id: "nope", text: "hi" }] })).status, 404);
  assert.equal((await post("/v1/text-to-dialogue", { inputs: Array(301).fill({ voice_id: "af_heart", text: "hi" }) })).status, 422);
});

// ---------- inline tags ----------
const wavSeconds = (buf) => (buf.length - 44) / 2 / buf.readUInt32LE(24);
await step("tags: [pause 2s] adds two seconds, tags aren't read or counted", async () => {
  const say = async (text) => { const r = await post("/v1/text-to-speech/af_heart?output_format=wav_24000", { text }); assert.equal(r.status, 200, await r.clone().text()); return { buf: Buffer.from(await r.arrayBuffer()), id: r.headers.get("history-item-id") }; };
  const plain = await say("Hello there. Goodbye now.");
  const paused = await say("Hello there. [pause 2s] [whisper] Goodbye now.");
  // The longest silence in the recording is the pause: two seconds, plus the short edges kept
  // around each spoken piece. (Comparing total lengths would also count the voice's own pause
  // between sentences, which differs from model to model.)
  const longestSilence = (wav) => {
    const at = wav.indexOf("data") + 8, rate = wav.readUInt32LE(24);
    let run = 0, best = 0;
    for (let i = at; i + 1 < wav.length; i += 2) { if (Math.abs(wav.readInt16LE(i)) < 328) best = Math.max(best, ++run); else run = 0; }
    return best / rate;
  };
  const gap = longestSilence(paused.buf);
  assert.ok(gap > 1.95 && gap < 2.5, `pause is ${gap.toFixed(2)} s`);
  assert.ok(longestSilence(plain.buf) < 1, "no long silence without the tag");
  const h = await jsonReq(`/v1/history/${paused.id}`);
  assert.equal(h.character_count, "Hello there.".length + "Goodbye now.".length, "only spoken words count, not tags");
  const { out } = await sttWith(Buffer.from(await (await post("/v1/text-to-speech/af_heart?output_format=wav_16000", { text: "Good [excited] morning [pause 300ms] friends." })).arrayBuffer()), { model_id: "whisper_base" });
  assert.doesNotMatch(out.text.toLowerCase(), /excited|pause/, `tags were read aloud: ${out.text}`);
  for (const x of [plain, paused]) await req(`/v1/history/${x.id}`, { method: "DELETE" });
  assert.equal((await post("/v1/text-to-speech/af_heart", { text: "[pause 1s] [whisper]" })).status, 422, "only tags");
  assert.equal((await post("/v1/text-to-dialogue", { inputs: [{ voice_id: "af_heart", text: "[laughs]" }] })).status, 422);
});

// ---------- dubbing ----------
const dubMeta = await jsonReq("/api/dubbing/meta");
await step("translation: Opus-MT per pair, through English, M2M100 for the rest", async () => {
  const t = await import("../server/engines/translate.mjs");
  assert.equal(t.translatorName("en", "es"), "Opus-MT");
  assert.equal(t.translatorName("de", "it"), "Opus-MT via English");
  assert.equal(t.translatorName("en", "ja"), "M2M100 418M");
  assert.equal(t.translatorName("en", "en"), null);
  assert.equal(await t.translate("Good morning, everyone.", { from: "en", to: "es" }), "Buenos días a todos.");
  assert.equal(t.tidy("antes da sexta- feira", "pt"), "antes da sexta-feira");
  assert.equal(t.tidy("Perche' no? E' cosi'.", "it"), "Perché no? È così.");
});
await step("dubbing: validation", async () => {
  const send = async (fields) => {
    const form = new FormData();
    form.set("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return (await req("/api/dubbing", { method: "POST", body: form })).status;
  };
  assert.equal(await send({ target_lang: "xx", source_lang: "en", voice_id: "af_heart" }), 422);
  assert.equal(await send({ target_lang: "es", source_lang: "en", voice_id: "af_heart" }), 422, "Kokoro voices are English only");
  assert.equal(await send({ target_lang: "en", source_lang: "en", voice_id: "nope" }), 404);
  assert.equal(await send({ target_lang: "en", source_lang: "en", voice_id: "af_heart", num_speakers: "99" }), 422);
  assert.equal((await req("/api/dubbing/dub_nope")).status, 404);
});
if (dubMeta.can_diarize) await step("dubbing: re-voice a two-speaker clip, edit a line, apply, export, delete", async () => {
  const src = await conversation();
  const form = new FormData();
  form.set("file", new Blob([src], { type: "audio/wav" }), "meeting.wav");
  form.set("source_lang", "en"); form.set("target_lang", "en"); form.set("voice_id", "af_heart"); form.set("keep_background", "false");
  const created = await jsonReq("/api/dubbing", { method: "POST", body: form });
  const wait = async () => {
    for (let i = 0; i < 400; i++) {
      const d = await jsonReq(`/api/dubbing/${created.dub_id}`);
      if (!d.busy) return d;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("dub took too long");
  };
  try {
    let d = await wait();
    assert.equal(d.status, "done", d.error);
    assert.equal(d.speakers.length, 2, "two speakers found");
    assert.ok(d.segments.length >= 2 && d.segments.every((s) => s.has_audio && s.translation === s.text));
    assert.equal(d.outdated_count, 0);
    const audio = Buffer.from(await (await req(`/api/dubbing/${d.dub_id}/audio?format=wav`)).arrayBuffer());
    assert.ok(Math.abs(wavSeconds(audio) - d.duration) < 3, `dub ${wavSeconds(audio).toFixed(1)} s vs original ${d.duration.toFixed(1)} s`);
    const srt = await (await req(`/api/dubbing/${d.dub_id}/subtitles?format=srt`)).text();
    assert.match(srt, /^1\n\d\d:\d\d:\d\d,\d{3} --> /);
    assert.match(srt, /Speaker 1: /);
    // Edit one line: only it is out of date, and applying voices it again.
    const seg = d.segments[0];
    const edited = await jsonReq(`/api/dubbing/${d.dub_id}/segments/${seg.seg_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ translation: "This line was [pause 300ms] changed." }) });
    assert.equal(edited.outdated, true);
    assert.equal((await jsonReq(`/api/dubbing/${d.dub_id}`)).outdated_count, 1);
    // A Kokoro voice can't speak another language; renaming a speaker works.
    const bad = await req(`/api/dubbing/${d.dub_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ speakers: [{ speaker_id: "nope", name: "X" }] }) });
    assert.equal(bad.status, 422);
    d = await jsonReq(`/api/dubbing/${d.dub_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed dub", speakers: [{ speaker_id: d.speakers[0].speaker_id, name: "Host" }] }) });
    assert.equal(d.title, "Renamed dub"); assert.equal(d.speakers[0].name, "Host");
    await jsonReq(`/api/dubbing/${d.dub_id}/render`, { method: "POST" });
    d = await wait();
    assert.equal(d.status, "done", d.error);
    assert.equal(d.outdated_count, 0);
    assert.match(await (await req(`/api/dubbing/${d.dub_id}/subtitles?format=vtt`)).text(), /^WEBVTT\n\n[\s\S]*Host: This line was changed\./);
    assert.ok((await jsonReq("/api/dubbing")).dubs.some((x) => x.dub_id === d.dub_id));
  } finally {
    await req(`/api/dubbing/${created.dub_id}`, { method: "DELETE" });
  }
  assert.equal((await req(`/api/dubbing/${created.dub_id}`)).status, 404);
});

await step("browser extension zip and the MP4 library are served", async () => {
  const z = await req("/api/extension.zip");
  assert.equal(z.status, 200);
  const zip = Buffer.from(await z.arrayBuffer());
  for (const name of ["resonant-reader/manifest.json", "resonant-reader/background.js", "resonant-reader/offscreen.js", "resonant-reader/popup.html", "resonant-reader/icons/128.png"]) assert.ok(zip.includes(Buffer.from(name)), name);
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  const mb = await req("/vendor/mediabunny.mjs");
  assert.equal(mb.status, 200);
  assert.match(mb.headers.get("content-type"), /javascript/);
  assert.ok((await mb.text()).includes("Mp4OutputFormat"));
});
await step("gpu worker setting rejects an unreachable address", async () => {
  const r = await req("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ qwen_remote_url: "http://127.0.0.1:9" }) });
  assert.equal(r.status, 422);
  assert.equal((await jsonReq("/api/settings")).qwen.remote, null, "a failed connect must not be saved");
});

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
