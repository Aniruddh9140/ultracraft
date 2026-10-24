#!/usr/bin/env node
/**
 * Ultracraft - development server.
 *
 * A dependency-free static file server with correct MIME types, range-free
 * streaming, directory indexes and no-cache headers, so `npm start` gives you
 * a playable game with nothing installed.
 *
 *   node tools/serve.js [port]
 *   PORT=3000 node tools/serve.js
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.PORT || process.argv[2] || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function contentType(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, clean);
  if (!full.startsWith(root)) return null;
  return full;
}

async function stat(p) {
  try { return await fsp.stat(p); } catch (e) { return null; }
}

async function directoryListing(dir, urlPath) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const rows = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const href = path.posix.join(urlPath, e.name) + (e.isDirectory() ? '/' : '');
      return `<li><a href="${href}">${e.name}${e.isDirectory() ? '/' : ''}</a></li>`;
    })
    .join('');
  return `<!DOCTYPE html><meta charset="utf-8"><title>Index of ${urlPath}</title><h1>Index of ${urlPath}</h1><ul>${rows}</ul>`;
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = req.url || '/';
    if (urlPath === '/') urlPath = '/index.html';
    let full = safeJoin(ROOT, urlPath);
    if (!full) { res.writeHead(403).end('Forbidden'); return; }
    let st = await stat(full);
    if (st && st.isDirectory()) {
      const index = path.join(full, 'index.html');
      const ist = await stat(index);
      if (ist) { full = index; st = ist; }
      else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await directoryListing(full, urlPath.endsWith('/') ? urlPath : urlPath + '/'));
        return;
      }
    }
    if (!st) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(full),
      'Content-Length': st.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  Ultracraft is running at  http://${shown}:${PORT}/\n  serving ${ROOT}\n  press Ctrl+C to stop\n`);
});
