// Writes THIRD_PARTY_NOTICES.md from public/js/credits.js, the list Settings → About shows.
// Usage: node scripts/write-notices.mjs [--check]   (--check exits 1 if the file is out of date)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const { MODELS, LIBRARIES, LICENSE_URLS } = await import(pathToFileURL(path.join(ROOT, "public", "js", "credits.js")).href);
const lic = (id) => `[${id}](${LICENSE_URLS[id]})`;

const lines = [
  "# Third-party notices",
  "",
  "Resonant uses the models and libraries below. Each keeps its own licence; this file lists them with the credit each one asks for. It is generated from `public/js/credits.js` by `node scripts/write-notices.mjs`; edit that file, not this one.",
  "",
  "Models are downloaded the first time a feature needs them, from the address shown. The npm and Python packages carry their full licence texts in their own folders (`node_modules/<name>/LICENSE`, or the package's `dist-info` folder).",
  "",
  "## Models",
  "",
];
for (const m of MODELS) {
  lines.push(`### ${m.name}`, "", `${m.use}. By ${m.by}. Licence: ${lic(m.license)}. Source: <${m.url}>`, "");
  if (m.attribution) lines.push(`> ${m.attribution}`, "");
  if (m.caution) lines.push(`**Note:** ${m.caution}`, "");
}
lines.push("## Libraries", "");
for (const l of LIBRARIES) {
  lines.push(`- **${l.name}**, by ${l.by}. Licence: ${lic(l.license)}. Source: <${l.url}>${l.note ? `. ${l.note}` : ""}`);
  if (l.also) lines.push(`  - ${l.also.name}: licence ${lic(l.also.license)}. Source code: <${l.also.url}>`);
}
lines.push("");
const text = lines.join("\n");
const file = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
if (process.argv.includes("--check")) {
  const ok = fs.existsSync(file) && fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") === text;
  console.log(ok ? "THIRD_PARTY_NOTICES.md is up to date" : "THIRD_PARTY_NOTICES.md is out of date: run node scripts/write-notices.mjs");
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(file, text);
console.log("wrote", path.relative(ROOT, file));
