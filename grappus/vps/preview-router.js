#!/usr/bin/env node
// Preview router: https://<slug>.<host>/ -> 127.0.0.1:<port> for per-task dev servers.
// Registry: /home/paperclip/preview-registry.json  { "<slug>": { port, cwd, startedAt, lastHit, pid } }
// Caddy on_demand_tls asks GET /_ask?domain=... ; only registered slugs get certificates.
import http from "node:http";
import fs from "node:fs";
import net from "node:net";

const REG = process.env.PREVIEW_REGISTRY || "/home/paperclip/preview-registry.json";
const BASE = process.env.PREVIEW_BASE_HOST || "187-126-114-172.sslip.io";
const PORT = Number(process.env.PREVIEW_ROUTER_PORT || 3999);

function readReg() { try { return JSON.parse(fs.readFileSync(REG, "utf8")); } catch { return {}; } }
function writeReg(r) { fs.writeFileSync(REG, JSON.stringify(r, null, 2)); }
function slugOf(host) {
  const h = (host || "").split(":")[0].toLowerCase();
  if (!h.endsWith("." + BASE)) return null;
  return h.slice(0, -(BASE.length + 1));
}
function page(title, body, code = 200) {
  return [code, `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;max-width:640px;margin:4rem auto;color:#1b2233"><h2>${title}</h2><p>${body}</p></body>`];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/_ask") { // Caddy on-demand TLS gate
    const slug = slugOf(url.searchParams.get("domain")); const ok = slug && readReg()[slug];
    res.writeHead(ok ? 200 : 404); return res.end(ok ? "ok" : "unknown");
  }
  if (url.pathname === "/_registry") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(readReg(), null, 2)); }
  const slug = slugOf(req.headers.host);
  const reg = readReg(); const entry = slug && reg[slug];
  if (!entry) { const [c, b] = page("No preview here", `Nothing registered for <code>${slug || req.headers.host}</code>. Start one in the task worktree with <code>preview-url start</code>.`, 404); res.writeHead(c, { "content-type": "text/html" }); return res.end(b); }
  entry.lastHit = new Date().toISOString(); reg[slug] = entry; writeReg(reg);
  const up = http.request({ host: "127.0.0.1", port: entry.port, method: req.method, path: req.url, headers: { ...req.headers, host: `localhost:${entry.port}`, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "https" } }, (ures) => { res.writeHead(ures.statusCode, ures.headers); ures.pipe(res); });
  up.on("error", () => { const [c, b] = page("Preview not responding", `Registered on port ${entry.port} but nothing is listening. It may still be starting, or it was stopped.`, 502); res.writeHead(c, { "content-type": "text/html" }); res.end(b); });
  req.pipe(up);
});
// websocket upgrade (Next HMR etc.)
server.on("upgrade", (req, socket, head) => {
  const slug = slugOf(req.headers.host); const entry = slug && readReg()[slug];
  if (!entry) return socket.destroy();
  const up = net.connect(entry.port, "127.0.0.1", () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: `localhost:${entry.port}` }).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
});
server.listen(PORT, "127.0.0.1", () => console.log(`preview-router on 127.0.0.1:${PORT} for *.${BASE}`));
