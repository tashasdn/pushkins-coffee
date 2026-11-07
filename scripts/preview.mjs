import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../public/", import.meta.url);
const mime = { "index.html": "text/html; charset=utf-8", "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8", "config.js": "text/javascript; charset=utf-8", "menu.jpg": "image/jpeg" };
const port = Number(process.env.PORT || 4173);
const base = "/pushkins-coffee/";
createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  const name = pathname.startsWith(base) ? pathname.slice(base.length) || "index.html" : pathname.slice(1) || "index.html";
  if (!Object.hasOwn(mime, name) || !["GET","HEAD"].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL(name, root));
    res.writeHead(200, { "Content-Type": mime[name], "Cache-Control": "no-store", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { res.writeHead(500).end(); }
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}${base}`));
