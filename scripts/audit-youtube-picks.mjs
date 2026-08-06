#!/usr/bin/env node
// Audit the YouTube ids we have already cached — liveness and match quality.
//
//   node scripts/audit-youtube-picks.mjs [--dry-run] [--out PATH]
//
// Why this exists as a separate path from enrichment: search.list costs 100
// units and tells you nothing about ids you already hold, while videos.list
// costs 1 unit per 50 ids and returns liveness, embeddability, duration, view
// count and channel. The whole corpus audits for ~40 units against a 10k/day
// quota, so this is affordable to re-run often — and it needs re-running,
// because videos die in CLUMPS: on 2026-08-06 four of the five dead ids shared
// one channel's "Lollapalooza Chicago 2026 (Pro-shot)" uploads, pulled as a
// batch rather than one at a time.
//
// Two classes of finding, and they want different responses:
//   dead / not-embeddable  -> mechanical. Drop the id and its positional label;
//                             an alternate inherits position 0. No re-search.
//   quality flags          -> a HUMAN pass. Name-based search cannot tell that
//                             "the 4411" is a football clip. Nothing here edits
//                             data; the report is the queue, and the decisions
//                             land in data/festivals/*.json.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from './enrich-artists.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEST_DIR = join(ROOT, 'data', 'festivals');
const CACHE_PATH = join(ROOT, 'data', 'artists', 'artists.json');

const KEY = process.env.YOUTUBE_API_KEY;
const DRY = process.argv.includes('--dry-run');
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > -1 ? process.argv[outFlag + 1] : join(ROOT, 'youtube-audit-report.json');

// Thresholds. Deliberately loose — this queue is read by a human, so a false
// positive costs a glance while a false negative ships a football clip as an
// artist's set.
const SHORT_SECONDS = 90;
const LOW_VIEWS = 1000;

if (!KEY && !DRY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

// --- collect every id, and remember who owns it and at what position --------
const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
const files = readdirSync(FEST_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');

/** artistKey -> { name, ids, labels, query, where:Set<festivalId|'cache'> } */
const artists = new Map();
function note(name, ids, labels, query, where) {
  if (!Array.isArray(ids) || !ids.length) return;
  const key = normalizeName(name);
  if (!artists.has(key)) artists.set(key, { key, name, ids, labels: labels || [], query: query || '', where: new Set() });
  artists.get(key).where.add(where);
}
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(FEST_DIR, f), 'utf8'));
  for (const a of doc?.artists || []) note(a?.name, a?.youtubeVideoIds, a?.youtubeLabels, a?.youtubeQuery, f.replace(/\.json$/, ''));
}
for (const [key, v] of Object.entries(cache)) {
  if (v && typeof v === 'object') note(key, v.youtubeVideoIds, v.youtubeLabels, v.youtubeQuery, 'cache');
}

const allIds = [...new Set([...artists.values()].flatMap((a) => a.ids))];
const calls = Math.ceil(allIds.length / 50);
console.log(`${artists.size} artists carry ids; ${allIds.length} distinct ids; ${calls} videos.list calls (~${calls} units)`);
if (DRY) process.exit(0);

// --- fetch -------------------------------------------------------------------
const meta = new Map();
let units = 0;
for (let i = 0; i < allIds.length; i += 50) {
  const params = new URLSearchParams({
    key: KEY, id: allIds.slice(i, i + 50).join(','), maxResults: '50',
    part: 'snippet,status,contentDetails,statistics',
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  units += 1;
  if (!res.ok) {
    const body = await res.text();
    console.error(`\nbatch ${i / 50 + 1} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    // A 403 is the day's quota being over; anything else may be transient. In
    // both cases an incomplete fetch must NOT be read as "these ids are dead" —
    // that is the same mistake as stamping youtubeSearchedAt on a refused
    // search, and it would delete live ids. Bail instead of reporting.
    console.error('incomplete fetch — refusing to report (missing ids would read as dead)');
    process.exit(1);
  }
  for (const it of (await res.json()).items || []) meta.set(it.id, it);
  process.stdout.write(`\rfetched ${Math.min(i + 50, allIds.length)}/${allIds.length}`);
}
console.log(`\n${units} units spent`);

// --- judge -------------------------------------------------------------------
// ISO 8601 durations, the subset YouTube emits.
function seconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function describe(id) {
  const it = meta.get(id);
  if (!it) return { id, dead: true };
  return {
    id,
    title: it.snippet?.title || '',
    channel: it.snippet?.channelTitle || '',
    seconds: seconds(it.contentDetails?.duration),
    views: +(it.statistics?.viewCount || 0),
    embeddable: it.status?.embeddable !== false,
    publishedAt: it.snippet?.publishedAt || '',
  };
}

const dead = [], notEmbeddable = [], queue = [];
for (const a of artists.values()) {
  const clips = a.ids.map(describe);
  clips.forEach((c) => { if (c.dead) dead.push({ artist: a.name, id: c.id }); else if (!c.embeddable) notEmbeddable.push({ artist: a.name, id: c.id }); });

  const pick = clips[0];
  const flags = [];
  if (pick.dead) flags.push('DEAD');
  else {
    if (!pick.embeddable) flags.push('NOT_EMBEDDABLE');
    if (pick.seconds > 0 && pick.seconds < SHORT_SECONDS) flags.push(`SHORT_${pick.seconds}s`);
    if (pick.views < LOW_VIEWS) flags.push(`LOW_VIEWS_${pick.views}`);
    // The artist's name appearing in neither the title nor the channel is the
    // single strongest signal that name search matched something else entirely.
    // Short names produce noise, so only judge names long enough to mean it.
    const n = squash(a.name);
    if (n.length >= 4 && !squash(`${pick.title} ${pick.channel}`).includes(n)) flags.push('NAME_ABSENT');
  }
  if (!flags.length) continue;
  queue.push({
    artist: a.name,
    key: a.key,
    festivals: [...a.where].filter((w) => w !== 'cache'),
    query: a.query,
    // Confidence, not certainty: two independent flags is where the sample
    // stopped containing plausible-but-fine picks and started being all junk.
    severity: flags.length >= 2 || flags.includes('DEAD') ? 'high' : 'low',
    flags,
    pick,
    alternates: clips.slice(1),
    labels: a.labels,
  });
}
queue.sort((x, y) => (x.severity === y.severity ? y.flags.length - x.flags.length : x.severity === 'high' ? -1 : 1));

const report = {
  generatedFor: 'youtube auto-pick review',
  unitsSpent: units,
  idsChecked: allIds.length,
  artistsChecked: artists.size,
  dead,
  notEmbeddable,
  counts: {
    high: queue.filter((q) => q.severity === 'high').length,
    low: queue.filter((q) => q.severity === 'low').length,
  },
  queue,
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`dead ${dead.length} | not-embeddable ${notEmbeddable.length} | ` +
  `flagged ${queue.length} (${report.counts.high} high, ${report.counts.low} low)`);
console.log(`report -> ${OUT}`);
