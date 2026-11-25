// End-to-end test of the MCP server: starts mcp/server.mjs the way an AI app would (over stdio),
// lists its tools and calls the main ones against a running Resonant.
// Usage: node scripts/mcp-test.mjs   (Resonant must be running; RESONANT_URL to point elsewhere)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "resonant-mcp-test-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "mcp", "server.mjs")],
  env: { ...process.env, RESONANT_OUTPUT_DIR: OUT },
  stderr: "pipe",
});
const client = new Client({ name: "resonant-mcp-test", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t} ms)`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};
const callTool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name} returned an error: ${t}`);
  return t;
};
const savedPath = (t) => t.match(/Saved (.+?) \(/)?.[1];

await step("lists its tools, each with a description and input schema", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["clone_voice", "create_dialogue", "design_voice", "list_voices", "resonant_status", "sound_effect", "speak", "transcribe"]);
  for (const t of tools) assert.ok(t.description.length > 30 && t.inputSchema?.type === "object", t.name);
});
await step("resonant_status reports the version and what the computer can run", async () => {
  const t = await callTool("resonant_status");
  assert.match(t, /^Resonant \d+\.\d+\.\d+ at http/);
  assert.match(t, /What this computer can run/);
});
await step("list_voices filters by accent and provider", async () => {
  const t = await callTool("list_voices", { accent: "british", provider: "local" });
  assert.match(t, /bm_george: George/);
  assert.doesNotMatch(t, /af_heart/);
});
let speech;
await step("speak saves an MP3 with the chosen voice", async () => {
  const t = await callTool("speak", { text: "Hello from Claude, through Resonant.", voice_id: "bm_george", filename: "hello" });
  speech = savedPath(t);
  assert.equal(path.basename(speech), "hello.mp3");
  const b = fs.readFileSync(speech);
  assert.ok(b.length > 5000 && (b.subarray(0, 3).toString() === "ID3" || b[0] === 0xff), "an MP3 file");
});
await step("speak never overwrites: a second file gets a new name", async () => {
  const t = await callTool("speak", { text: "Second take.", voice_id: "af_heart", filename: "hello", format: "wav" });
  const p = savedPath(t);
  assert.equal(path.basename(p), "hello.wav");
  const t2 = await callTool("speak", { text: "Third take.", voice_id: "af_heart", filename: "hello", format: "wav" });
  assert.equal(path.basename(savedPath(t2)), "hello-2.wav");
  assert.equal(fs.readFileSync(p).subarray(0, 4).toString(), "RIFF");
});
await step("create_dialogue saves one file for several speakers", async () => {
  const t = await callTool("create_dialogue", { lines: [{ voice_id: "af_heart", text: "Did it work?" }, { voice_id: "bm_george", text: "It worked." }], filename: "dialogue" });
  assert.ok(fs.statSync(savedPath(t)).size > 5000);
});
await step("transcribe reads the speech back, with timestamps", async () => {
  const t = await callTool("transcribe", { file_path: speech, timestamps: true });
  assert.match(t.toLowerCase(), /\[0:00\] .*hello from claude/);
});
await step("errors come back as readable messages, not crashes", async () => {
  const r1 = await client.callTool({ name: "speak", arguments: { text: "Hi", voice_id: "no_such_voice" } });
  assert.ok(r1.isError && /not found/i.test(r1.content[0].text), r1.content[0].text);
  const r2 = await client.callTool({ name: "transcribe", arguments: { file_path: path.join(OUT, "missing.mp3") } });
  assert.ok(r2.isError && /No file at/.test(r2.content[0].text));
  const r3 = await client.callTool({ name: "transcribe", arguments: { file_path: path.join(ROOT, "README.md") } });
  assert.ok(r3.isError && /WAV and MP3/.test(r3.content[0].text));
});

await client.close();
// Remove what the test made: its files, and the History items its speech created.
const B = process.env.RESONANT_URL || "http://127.0.0.1:3000";
let cleaned = 0;
try {
  const h = await (await fetch(`${B}/v1/history?page_size=20`)).json();
  for (const item of h.history || []) {
    if (/Hello from Claude, through Resonant\.|Second take\.|Third take\.|Did it work\?/.test(item.text || "")) {
      await fetch(`${B}/v1/history/${item.history_item_id}`, { method: "DELETE" });
      cleaned++;
    }
  }
} catch {}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`cleaned up ${cleaned} history items and the test folder`);
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
// Set the code and let Node finish on its own: process.exit() while the stdio pipes to the
// server are still closing trips a libuv assertion on Windows.
process.exitCode = failures ? 1 : 0;
