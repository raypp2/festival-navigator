// Backfill youtubeLabels for artists that already carry youtubeVideoIds.
//
// Why this is a separate path from the search flow: search.list costs 100
// units, so re-searching the 327 already-enriched artists to recover titles
// we threw away would cost ~32,700 against a 10k/day quota — three days of
// budget to fetch data we already half-have. videos.list costs 1 unit and
// accepts up to 50 ids per call, so the same job is ~20 units total.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanYoutubeTitle } from './enrich-artists.mjs';

const FEST_DIR = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/festivals';
const KEY = process.env.YOUTUBE_API_KEY;
const DRY = process.argv.includes('--dry-run');
if (!KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

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
if (DRY) process.exit(0);

let units = 0;
for (let i = 0; i < allIds.length; i += 50) {
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
