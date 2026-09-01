#!/usr/bin/env node
/**
 * serve.js — dev static server for docs/. No dependencies.
 *
 * Exists for one reason: it sends `Cache-Control: no-store`. A plain
 * `python -m http.server` lets the browser hold onto app.js and you end up
 * debugging yesterday's code. Production caching is GitHub Pages' problem;
 * during development, never cache.
 *
 * Usage: npm start          -> http://localhost:8787
 *        node tools/serve.js 9000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'docs');
const PORT = Number(process.argv[2]) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  // Contain every request inside docs/ — no path traversal out of the root.
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(`404 ${rel}`);
      console.log(`404 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    });
    res.end(buf);
    console.log(`200 ${rel}`);
  });
}).listen(PORT, () => {
  console.log(`docs/ on http://localhost:${PORT}`);
  console.log(`  mock data:  http://localhost:${PORT}/?mock=full   |   ?mock=empty`);
});
