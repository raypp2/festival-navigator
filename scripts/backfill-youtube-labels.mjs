// Backfill youtubeLabels for artists that already carry youtubeVideoIds.
//
// Why this is a separate path from the search flow: search.list costs 100
// units, so re-searching the 327 already-enriched artists to recover titles
// we threw away would cost ~32,700 against a 10k/day quota — three days of
// budget to fetch data we already half-have. videos.list costs 1 unit and
// accepts up to 50 ids per call, so the same job is ~20 units total.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanYoutubeTitle, normalizeName } from './enrich-artists.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FEST_DIR = join(ROOT, 'data', 'festivals');
const CACHE_PATH = join(ROOT, 'data', 'artists', 'artists.json');

const FEST_DIR = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/festivals';
const KEY = process.env.YOUTUBE_API_KEY;
const DRY = process.argv.includes('--dry-run');
if (!KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

// The cache is only reconciled when we are reading this repo's own festival
// dir — pointing the script at a scratch copy must never write the real cache.
const SYNC_CACHE = resolve(FEST_DIR) === resolve(DEFAULT_FEST_DIR);

const files = readdirSync(FEST_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
const needed = new Map(); // videoId -> title (filled below)
const plan = [];

for (const f of files) {
  const path = join(FEST_DIR, f);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!doc || !Array.isArray(doc.artists)) continue;
  for (const a of doc.artists) {
    if (!a || typeof a !== 'object') continue;
    const ids = Array.isArray(a.youtubeVideoIds) ? a.youtubeVideoIds : [];
    if (!ids.length) continue;
    if (Array.isArray(a.youtubeLabels) && a.youtubeLabels.length >= ids.length) continue;
    plan.push({ path, artist: a, ids });
    for (const id of ids) needed.set(id, null);
  }
}
const allIds = [...needed.keys()];
console.log(`${plan.length} artists need labels; ${allIds.length} distinct video ids; ` +
  `${Math.ceil(allIds.length / 50)} videos.list calls (~${Math.ceil(allIds.length / 50)} units)`);
// --dry-run skips the network and the writes, but NOT the cache reconcile
// report below — that pass costs no quota and its plan is the thing worth
// previewing.
let units = 0;
for (let i = 0; !DRY && i < allIds.length; i += 50) {
  const batch = allIds.slice(i, i + 50);
  const params = new URLSearchParams({ key: KEY, part: 'snippet', id: batch.join(','), maxResults: '50' });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  units += 1;
  if (!res.ok) {
    const body = await res.text();
    console.error(`batch ${i / 50 + 1} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    if (res.status === 403) break;
    continue;
  }
  const body = await res.json();
  for (const item of body.items || []) {
    if (item?.id && item?.snippet?.title) needed.set(item.id, item.snippet.title);
  }
  process.stdout.write(`\rfetched ${Math.min(i + 50, allIds.length)}/${allIds.length}`);
}
console.log(`\n${units} units spent`);

const byPath = new Map();
let wrote = 0;
for (const { path, artist, ids } of plan) {
  const query = artist.youtubeQuery || `${artist.name} live set`;
  const labels = ids.map((id) => {
    const t = needed.get(id);
    return t ? cleanYoutubeTitle(t, query) : '';
  });
  if (!labels.some(Boolean)) continue;
  artist.youtubeLabels = labels;
  wrote += 1;
  if (!byPath.has(path)) byPath.set(path, null);
}
for (const path of byPath.keys()) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const docs = new Map(plan.filter((p) => p.path === path).map((p) => [p.artist.name, p.artist]));
  for (const a of doc.artists) {
    const patched = docs.get(a?.name);
    if (patched && patched.youtubeLabels) a.youtubeLabels = patched.youtubeLabels;
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}
console.log(`labelled ${wrote} artists across ${byPath.size} festival files`);

// Labels used to land in the festival files ONLY, so the shared cache drifted
// behind by every artist this script ever touched (105 entries by 2026-08-06) —
// and the cache is what a NEW festival import reads, so those imports inherited
// ids with no titles and player-core fell back to "Set N". Reconcile every
// festival row back into the cache, not just the ones fetched above: the drift
// is historical, so a pass limited to this run's plan would never close it.
// Costs no quota — it is a copy between two files we already have open.
if (!SYNC_CACHE) {
  console.log('cache sync skipped — festival dir is not this repo\'s data/festivals');
} else {
  const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  let synced = 0;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(FEST_DIR, f), 'utf8'));
    for (const a of doc?.artists || []) {
      const ids = Array.isArray(a?.youtubeVideoIds) ? a.youtubeVideoIds : [];
      const labels = Array.isArray(a?.youtubeLabels) ? a.youtubeLabels : [];
      if (!ids.length || labels.length < ids.length) continue;
      const entry = cache[normalizeName(a.name)];
      if (!entry || (entry.youtubeLabels || []).length >= (entry.youtubeVideoIds || []).length) continue;
      // Labels are positional (player-core reads youtubeLabels[i] for
      // youtubeVideoIds[i]) — copying across a different id order would
      // mislabel every clip, so only an exact match may be carried.
      if (JSON.stringify(entry.youtubeVideoIds) !== JSON.stringify(ids)) continue;
      entry.youtubeLabels = labels.slice();
      synced += 1;
    }
  }
  if (synced && !DRY) writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(`${DRY ? '[dry-run] ' : ''}synced labels into ${synced} cache entries`);
}
