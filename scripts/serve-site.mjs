// Serves the landing page in site/ for local preview: node scripts/serve-site.mjs [port]
// The page is static; any host (Netlify, GitHub Pages, Cloudflare Pages) can serve the folder as is.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "site");
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".png": "image/png", ".json": "application/json" };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(ROOT, url.endsWith("/") ? url + "index.html" : url);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    // Audio needs range support so the browser can seek when a word is clicked.
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Landing page on http://127.0.0.1:${PORT}`));
