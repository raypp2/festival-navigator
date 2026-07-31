#!/usr/bin/env node
// Import-time artist enrichment (build spec section 3.6, META-*):
// MusicBrainz (keyless) supplies genre tags + soundcloud/spotify link-outs;
// YouTube search.list (only when YOUTUBE_API_KEY is set) supplies cached
// video ids. Nothing here runs live per user — this is a build/import step.
//
//   node scripts/enrich-artists.mjs <festival-id> [--limit N] [--dry-run] [--only "Artist Name"]
//
// Writes both data/festivals/<festival-id>.json (artists[] — the top-level
// billing-order array; per-day schedule projections are not enrichment
// targets) and the shared cache data/artists/artists.json. The merge rule
// (mergeEnrichment, exported below) never clobbers a non-empty value already
// present in either home — enrichment fills gaps only, so curator hand-edits
// always win.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEST_DIR = join(ROOT, 'data', 'festivals');
const CACHE_PATH = join(ROOT, 'data', 'artists', 'artists.json');

const USER_AGENT = 'festival-navigator-fork/2.0 (https://github.com/raypp2/festival-navigator)';
const MB_MIN_INTERVAL_MS = 1100; // MusicBrainz bans clients that exceed ~1 req/sec.
const MB_SCORE_THRESHOLD = 90;

const ENRICH_FIELDS = ['genres', 'soundcloudSlug', 'spotifyId', 'youtubeQuery', 'youtubeVideoIds', 'bandsintownId'];
const CAPS = { genres: 8, youtubeVideoIds: 4 };

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests/enrich.test.mjs — no network, no fs).
// ---------------------------------------------------------------------------

function isNonEmpty(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

// The merge rule (build spec section 3.6 / 3): for each enrichable field,
// prefer `entry`'s own non-empty value, then `cached`'s, then `fetched`'s —
// never clobber a non-empty value that already exists upstream of `fetched`.
// Reused for both homes: mergeEnrichment(entry, cached, fetched) resolves the
// festival entry; mergeEnrichment(cached, entry, fetched) resolves the cache
// (the cache's own history wins over a single festival's hand-edit, which in
// turn wins over a fresh fetch). Caps are re-applied defensively even though
// callers should already respect them.
export function mergeEnrichment(entry = {}, cached = {}, fetched = {}) {
  const out = {};
  for (const field of ENRICH_FIELDS) {
    let value;
    if (isNonEmpty(entry[field])) value = entry[field];
    else if (isNonEmpty(cached[field])) value = cached[field];
    else if (isNonEmpty(fetched[field])) value = fetched[field];
    else continue;
    if (CAPS[field] && Array.isArray(value)) value = value.slice(0, CAPS[field]);
    out[field] = value;
  }
  return out;
}

export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Accept the top MusicBrainz hit only when its score clears the threshold
// AND its name matches the query case/diacritic-insensitively — MB's score
// can be inflated by alias/disambiguation matches, so the extra sanity check
// guards against a false positive on a B2B or set-variant billing name.
export function pickMbHit(hits, queryName) {
  if (!Array.isArray(hits) || !hits.length) return null;
  const top = hits[0];
  if (typeof top.score !== 'number' || top.score < MB_SCORE_THRESHOLD) return null;
  if (normalizeName(top.name) !== normalizeName(queryName)) return null;
  return top;
}

// MB genres[] (fall back to tags[] when empty), sorted by count desc,
// lowercase names, deduped, capped at 8. Raw — canonicalization happens
// client-side against data/genres.json, per build spec section 4.
export function extractGenres(mbArtist) {
  const src = (Array.isArray(mbArtist?.genres) && mbArtist.genres.length) ? mbArtist.genres : (mbArtist?.tags || []);
  const sorted = [...src].sort((a, b) => (b.count || 0) - (a.count || 0));
  const out = [];
  const seen = new Set();
  for (const t of sorted) {
    const name = String(t?.name || '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= CAPS.genres) break;
  }
  return out;
}

export function extractSoundcloudSlug(relations) {
  for (const rel of relations || []) {
    const url = rel?.url?.resource || '';
    const m = /soundcloud\.com\/([^/?#]+)/i.exec(url);
    if (m && !['tracks', 'sets', 'you'].includes(m[1].toLowerCase())) return m[1];
  }
  return null;
}

export function extractSpotifyId(relations) {
  for (const rel of relations || []) {
    const url = rel?.url?.resource || '';
    const m = /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/i.exec(url);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI (network + fs) — everything below is guarded so importing this module
// (tests) never touches the network or the filesystem.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

let lastMbRequestAt = 0;
async function mbFetch(url) {
  const wait = MB_MIN_INTERVAL_MS - (Date.now() - lastMbRequestAt);
  if (wait > 0) await sleep(wait);
  lastMbRequestAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  lastMbRequestAt = Date.now();
  return res;
}

async function mbSearchArtist(name) {
  const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json`;
  const res = await mbFetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  return pickMbHit(body?.artists, name);
}

async function mbLookupArtist(mbid) {
  const url = `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=url-rels+genres+tags&fmt=json`;
  const res = await mbFetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function verifySoundcloudSlug(slug) {
  try {
    const url = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(`https://soundcloud.com/${slug}`)}`;
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function youtubeSearchTop3(query, apiKey) {
  const params = new URLSearchParams({
    key: apiKey, q: query, part: 'id', type: 'video', videoEmbeddable: 'true', maxResults: '5',
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body.items || []).map((it) => it?.id?.videoId).filter(Boolean).slice(0, 3);
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function needsAnyField(entry) {
  return ENRICH_FIELDS.some((f) => f !== 'bandsintownId' && !isNonEmpty(entry[f]));
}

async function enrichOne(entry, cache, { youtubeKey, dryRun, log }) {
  const key = normalizeName(entry.name);
  const cached = cache[key] || {};
  let fetched = {};

  // What's still missing after entry + cache alone?
  const preMerged = mergeEnrichment(entry, cached, {});
  const missingMbFields = !isNonEmpty(preMerged.genres) || !isNonEmpty(preMerged.soundcloudSlug) || !isNonEmpty(preMerged.spotifyId);

  let mbid = cached.mbid;
  if (missingMbFields && !mbid) {
    const hit = await mbSearchArtist(entry.name);
    if (hit) {
      mbid = hit.id;
      const full = await mbLookupArtist(mbid);
      if (full) {
        fetched.mbid = mbid;
        const genres = extractGenres(full);
        if (genres.length) fetched.genres = genres;
        const scSlug = extractSoundcloudSlug(full.relations);
        if (scSlug) {
          const verified = dryRun ? true : await verifySoundcloudSlug(scSlug);
          if (verified) fetched.soundcloudSlug = scSlug;
          else log(`  (soundcloud slug "${scSlug}" for ${entry.name} did not verify via oEmbed — dropped)`);
        }
        const spId = extractSpotifyId(full.relations);
        if (spId) fetched.spotifyId = spId;
      }
    } else {
      log(`  no confident MusicBrainz match for "${entry.name}" — leaving genres/links unset`);
    }
  }

  if (!isNonEmpty(preMerged.youtubeQuery)) fetched.youtubeQuery = `${entry.name} live set`;

  if (youtubeKey && !isNonEmpty(preMerged.youtubeVideoIds)) {
    const query = preMerged.youtubeQuery || fetched.youtubeQuery;
    const ids = await youtubeSearchTop3(query, youtubeKey);
    if (ids.length) fetched.youtubeVideoIds = ids;
  }

  const entryFields = mergeEnrichment(entry, cached, fetched);
  const cacheFields = mergeEnrichment(cached, entry, fetched);
  const cacheChanged = Object.keys(fetched).length > 0
    || ENRICH_FIELDS.some((f) => cacheFields[f] !== undefined && cached[f] === undefined);

  return {
    key, entryFields, cacheFields, cacheChanged, mbid: fetched.mbid || cached.mbid,
  };
}

function diffFields(before, after) {
  const changed = {};
  for (const f of ENRICH_FIELDS) {
    const b = JSON.stringify(before[f]);
    const a = JSON.stringify(after[f]);
    if (a !== undefined && a !== b) changed[f] = after[f];
  }
  return changed;
}

async function main() {
  const args = process.argv.slice(2);
  const festivalId = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  if (!festivalId) {
    console.error('Usage: node scripts/enrich-artists.mjs <festival-id> [--limit N] [--dry-run] [--only "Artist Name"]');
    process.exit(1);
  }

  const festPath = join(FEST_DIR, `${festivalId}.json`);
  if (!existsSync(festPath)) {
    console.error(`${festPath} does not exist.`);
    process.exit(1);
  }
  const fest = JSON.parse(readFileSync(festPath, 'utf8'));
  if (!Array.isArray(fest.artists)) {
    console.error(`${festivalId}: artists[] missing or not an array — nothing to enrich.`);
    process.exit(1);
  }

  const cache = loadJson(CACHE_PATH, { _comment: '' });
  const youtubeKey = process.env.YOUTUBE_API_KEY || null;
  if (!youtubeKey) console.log('YOUTUBE_API_KEY not set — youtubeVideoIds will be skipped (expected mode today).');

  let candidates = fest.artists.filter((a) => a && a.name && needsAnyField(a));
  if (only) candidates = candidates.filter((a) => normalizeName(a.name) === normalizeName(only));
  candidates = candidates.slice(0, limit);

  console.log(`${festivalId}: ${fest.artists.length} artists, ${candidates.length} candidate(s) for enrichment (limit ${Number.isFinite(limit) ? limit : '∞'}).`);

  let touched = 0;
  for (const entry of candidates) {
    const before = { ...entry };
    // eslint-disable-next-line no-await-in-loop
    const result = await enrichOne(entry, cache, { youtubeKey, dryRun, log: console.log });
    const changed = diffFields(before, result.entryFields);
    if (Object.keys(changed).length) {
      touched += 1;
      console.log(`${dryRun ? '[dry-run] ' : ''}${entry.name}: ${JSON.stringify(changed)}`);
      if (!dryRun) Object.assign(entry, result.entryFields);
    } else {
      console.log(`${entry.name}: no new fields`);
    }
    if (!dryRun && result.cacheChanged) {
      cache[result.key] = {
        ...result.cacheFields,
        ...(result.mbid ? { mbid: result.mbid } : {}),
        enrichedAt: new Date().toISOString(),
      };
    }
  }

  if (dryRun) {
    console.log(`\n[dry-run] would update ${touched} artist(s) in ${festivalId}.json — nothing written.`);
    return;
  }

  writeFileSync(festPath, `${JSON.stringify(fest, null, 2)}\n`);
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(`\nUpdated ${touched} artist(s). Wrote ${festPath} and ${CACHE_PATH}.`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
