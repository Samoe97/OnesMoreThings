// Local server for the One More Things site: serves site/ and powers the in-page editing tools.
//   node scripts/server.mjs        ->  http://localhost:5173
// Edits are saved to data/overrides.json; "rescan" re-runs the API lookups for one pick via
// build-data.mjs --only <id>, which rewrites site/data.js. Binds to localhost only.

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const OVERRIDES = path.join(ROOT, "data", "overrides.json");
const PORT = +process.env.PORT || 5173;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const EDITABLE = new Set(["title", "type", "year", "creator", "summary", "image", "search"]);
const TYPES = new Set(["game", "movie", "tv", "book", "music", "podcast", "article", "video", "hardware", "other"]);

let queue = Promise.resolve(); // one write/rescan at a time
const serial = (fn) => (queue = queue.then(fn, fn));

const readOverrides = async () => (existsSync(OVERRIDES) ? JSON.parse(await readFile(OVERRIDES, "utf8")) : {});
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "cache-control": "no-store", ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { "content-type": "application/json" });
const body = (req) => new Promise((ok, no) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch (e) { no(e); } });
});

function rescan(id) {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "build-data.mjs"), "--only", id], { cwd: ROOT });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("RESULT:"));
      if (code === 0 && line) ok(JSON.parse(line.slice(7)));
      else no(new Error(err.trim() || out.trim() || `rescan exited with ${code}`));
    });
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    // Only answer requests addressed to localhost (blocks DNS-rebinding), and require a custom header on writes (blocks cross-site posts).
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "")) return send(res, 403, "Forbidden");

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/ping") return json(res, 200, { ok: true });
      if (req.method !== "POST" || req.headers["x-omt"] !== "1") return json(res, 403, { error: "forbidden" });
      const b = await body(req);
      if (!b.id || typeof b.id !== "string") return json(res, 400, { error: "missing id" });

      if (url.pathname === "/api/edit") {
        // Merge changed fields into overrides[id]; empty value removes that override.
        await serial(async () => {
          const ov = await readOverrides();
          const cur = ov[b.id] || {};
          for (const [k, v] of Object.entries(b.fields || {})) {
            if (!EDITABLE.has(k)) continue;
            if (v === "" || v === null || v === undefined) delete cur[k];
            else if (k === "type") { if (TYPES.has(v)) cur.type = v; }
            else if (k === "year") { const y = parseInt(v, 10); if (y) cur.year = y; else delete cur.year; }
            else cur[k] = String(v);
          }
          if (Object.keys(cur).length) ov[b.id] = cur; else delete ov[b.id];
          await writeFile(OVERRIDES, JSON.stringify(ov, null, 1));
        });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/rescan") {
        const pick = await serial(() => rescan(b.id));
        return json(res, 200, { pick });
      }
      if (url.pathname === "/api/reset") {
        const pick = await serial(async () => {
          const ov = await readOverrides();
          delete ov[b.id];
          await writeFile(OVERRIDES, JSON.stringify(ov, null, 1));
          return rescan(b.id);
        });
        return json(res, 200, { pick });
      }
      return json(res, 404, { error: "not found" });
    }

    // static files
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(SITE, rel));
    if (!file.startsWith(SITE + path.sep) && file !== SITE) return send(res, 403, "Forbidden");
    if (!existsSync(file)) return send(res, 404, "Not found");
    send(res, 200, await readFile(file), { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`One More Things running at http://localhost:${PORT}  (Ctrl+C to stop)`));
