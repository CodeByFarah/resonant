// Turns an uploaded book or document into chapters for Studio: .txt, .md, .epub, .pdf.
// Returns { title, chapters: [{ title, text }] }.
import zlib from "node:zlib";
import path from "node:path";
import { httpError } from "./audio.mjs";

const MAX_CHARS = 2_000_000; // about 40 hours of narration
const SPLIT_AT = 6000; // with no headings, long text is cut into parts of about this size

export async function parseDocument(name, buf) {
  const ext = path.extname(name || "").toLowerCase();
  const base = path.basename(name || "Untitled", ext).replace(/[_-]+/g, " ").trim() || "Untitled";
  let out;
  if (ext === ".epub") out = parseEpub(buf, base);
  else if (ext === ".pdf") out = await parsePdf(buf, base);
  else if ([".txt", ".md", ".markdown", ".text", ""].includes(ext)) {
    let text = buf.toString("utf8").replace(/^﻿/, "");
    if (ext === ".md" || ext === ".markdown") text = stripMarkdown(text);
    out = { title: base, chapters: splitChapters(text, base) };
  } else throw httpError(415, "Upload a .txt, .md, .epub or .pdf file.");
  out.chapters = out.chapters.map((c) => ({ title: c.title.slice(0, 200), text: tidy(c.text) })).filter((c) => c.text);
  if (!out.chapters.length) throw httpError(422, "No readable text was found in that file. (Scanned PDFs have no text layer.)");
  const total = out.chapters.reduce((n, c) => n + c.text.length, 0);
  if (total > MAX_CHARS) throw httpError(413, `That document has ${total.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
  return out;
}

// ---------- plain text ----------
const tidy = (s) => String(s).replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const HEADING = /^(#{1,3}\s+\S.*|(chapter|part|book|section)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b.*|prologue|epilogue|introduction|preface|foreword|afterword|interlude)$/i;

export function splitChapters(text, fallbackTitle = "Chapter") {
  const lines = tidy(text).split("\n");
  const chapters = [];
  let cur = { title: "", lines: [] };
  for (const line of lines) {
    const l = line.trim();
    if (l.length < 100 && HEADING.test(l)) {
      if (cur.lines.join("").trim() || cur.title) chapters.push(cur);
      cur = { title: l.replace(/^#+\s*/, "").replace(/[*_]+/g, ""), lines: [] };
    } else cur.lines.push(line);
  }
  chapters.push(cur);
  let out = chapters.map((c) => ({ title: c.title, text: c.lines.join("\n") })).filter((c) => c.text.trim() || c.title);
  // Front matter shorter than a paragraph before the first heading isn't worth its own chapter.
  if (out.length > 1 && !out[0].title && out[0].text.trim().length < 200) out = out.slice(1);
  if (out.length >= 2) return out.map((c, i) => ({ title: c.title || (i === 0 ? "Opening" : `Part ${i + 1}`), text: c.text }));
  // No headings: keep it whole if it's short, otherwise cut at paragraph breaks.
  const all = out.map((c) => c.text).join("\n\n");
  if (all.length <= SPLIT_AT * 1.5) return [{ title: out[0]?.title || fallbackTitle, text: all }];
  const parts = [];
  let buf = "";
  for (const para of all.split(/\n\s*\n/)) {
    if (buf && buf.length + para.length > SPLIT_AT) { parts.push(buf); buf = ""; }
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf) parts.push(buf);
  return parts.map((t, i) => ({ title: `Part ${i + 1}`, text: t }));
}

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "");
}

// ---------- EPUB (a zip of XHTML files, ordered by the OPF spine) ----------
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
function unzip(buf) {
  try { return readZip(buf); }
  catch (e) { if (e.status) throw e; throw httpError(422, "That EPUB file is damaged and can't be read."); }
}
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw httpError(422, "That EPUB file is damaged (not a zip archive).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    files.set(name, () => {
      try {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        // The cap stops a tiny archive that unpacks to gigabytes (a zip bomb) from exhausting memory.
        return method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }) : data;
      } catch (e) {
        if (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|Cannot create a Buffer larger/i.test(e.message)) throw httpError(413, `"${name}" inside that EPUB unpacks to more than ${MAX_ENTRY_BYTES / 1024 / 1024} MB.`);
        throw httpError(422, "That EPUB file is damaged and can't be read.");
      }
    });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
const htmlText = (h) => decode(h
  .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, "\n\n")
  .replace(/<[^>]+>/g, ""));
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

function parseEpub(buf, base) {
  const files = unzip(buf);
  const read = (name) => files.get(name)?.().toString("utf8");
  const container = read("META-INF/container.xml");
  const opfPath = container && attr(container.match(/<rootfile\s[^>]*>/i)?.[0] || "", "full-path");
  const opf = opfPath && read(opfPath);
  if (!opf) throw httpError(422, "That EPUB has no package file, so its chapters can't be found.");
  const dir = path.posix.dirname(opfPath);
  const title = decode(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() || "") || base;
  const manifest = new Map();
  for (const tag of opf.match(/<item\s[^>]*>/gi) || []) manifest.set(attr(tag, "id"), { href: attr(tag, "href"), props: attr(tag, "properties") || "" });
  const chapters = [];
  for (const ref of opf.match(/<itemref\s[^>]*>/gi) || []) {
    const item = manifest.get(attr(ref, "idref"));
    if (!item?.href || item.props.includes("nav")) continue;
    const file = path.posix.normalize(dir === "." ? decodeURIComponent(item.href) : `${dir}/${decodeURIComponent(item.href)}`);
    const xhtml = read(file);
    if (!xhtml) continue;
    const body = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? xhtml;
    let text = tidy(htmlText(body));
    if (text.length < 200) continue; // cover, title page, copyright notice
    const heading = tidy(htmlText(body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || "")).replace(/\n+/g, " ");
    if (heading && text.startsWith(heading)) text = text.slice(heading.length).trim();
    chapters.push({ title: heading || `Section ${chapters.length + 1}`, text });
  }
  return { title, chapters };
}

// ---------- PDF (text layer via pdf.js) ----------
async function parsePdf(buf, base) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (e) { throw httpError(422, `Couldn't read that PDF: ${e.message}`); }
  const meta = await doc.getMetadata().catch(() => null);
  const lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let line = "";
    for (const it of content.items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ""; }
    }
    if (line) lines.push(line);
    lines.push(""); // page break
    page.cleanup();
  }
  await doc.destroy();
  // Rebuild paragraphs: join wrapped lines, mend hyphenation, drop bare page numbers.
  const kept = lines.map((l) => l.trim()).filter((l) => !/^\d{1,4}$/.test(l));
  const lengths = kept.filter(Boolean).map((l) => l.length).sort((a, b) => b - a);
  const width = Math.max(40, lengths[Math.floor(lengths.length * 0.1)] || 0); // typical full line
  let text = "";
  for (const l of kept) {
    if (!l) { if (/[.!?"”’)]$/.test(text)) text += "\n\n"; continue; }
    if (l.length < 100 && HEADING.test(l)) { text += `\n\n${l}\n\n`; continue; }
    if (text.endsWith("-") && /^[a-z]/.test(l)) text = text.slice(0, -1) + l;
    else text += (text && !text.endsWith("\n") ? " " : "") + l;
    // A short line that ends a sentence usually ends a paragraph.
    if (/[.!?"”’:]$/.test(l) && l.length < width * 0.8) text += "\n\n";
  }
  return { title: meta?.info?.Title?.trim() || base, chapters: splitChapters(text, base) };
}
