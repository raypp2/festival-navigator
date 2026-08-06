// Static server + trace sink, for driving design/ios-playback-probe.html (or
// any page in this repo) inside the iOS Simulator.
//
// Why this exists: a page running on a phone or a simulator cannot be asked to
// read its own screen back, and a screenshot of a log pane is the weakest kind
// of evidence — it cannot tell a working page from a frozen one. The probe's
// ?log=1 beacon POSTs its whole trace here on a timer, so the driver reads a
// FILE instead of squinting at pixels. Safari's Web Inspector would be
// stronger, but ios_webkit_debug_proxy talks to usbmuxd and does not see
// simulators at all (confirmed 2026-08-06: /json returns []).
//
//   node scripts/probe-log-server.mjs
//   xcrun simctl openurl booted "http://localhost:8899/design/ios-playback-probe.html?log=1&compact=1&src=sp"
//   cat .probe-traces/<newest>.log
//
// The simulator shares the Mac's network stack, so localhost needs no remapping.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.probe-traces');
const PORT = Number(process.env.PORT || 8899);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

await mkdir(OUT, { recursive: true });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/probe-log') {
    // One file per PAGE INSTANCE. Every tab left open keeps beaconing its own
    // finished trace, so a single shared file means the newest run and the
    // oldest take turns overwriting each other — that cost a step's result
    // before the id was added. The probe also stops beaconing while hidden, so
    // in practice only the foreground tab writes.
    const id = (url.searchParams.get('id') || 'anon').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'anon';
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await writeFile(join(OUT, `${id}.log`), Buffer.concat(chunks));
    res.writeHead(204).end();
    return;
  }

  // Static, rooted at the repo. normalize + prefix check keeps ../ inside.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // Never cache: a stale probe is the failure mode this project keeps
      // re-learning the hard way.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
  console.log(`traces -> ${OUT}/<trace-id>.log`);
});
