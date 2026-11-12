// Builds build/icon.ico (16 to 256 px, PNG-compressed entries) from Resonant's logo, for the
// Windows installer. Usage: node make-icon.mjs   (uses sharp from the main project's node_modules)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = import.meta.dirname;
const sharp = createRequire(path.join(here, "..", "package.json"))("sharp");
const svg = fs.readFileSync(path.join(here, "..", "public", "favicon.svg"));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: Math.max(72, s * 9) }).resize(s, s).png().toBuffer()));

// ICO layout: 6-byte header, a 16-byte directory entry per image, then the PNG data.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); // 0 means 256
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
const out = path.join(here, "build", "icon.ico");
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
console.log("wrote", path.relative(here, out), `(${sizes.join(", ")} px)`);
