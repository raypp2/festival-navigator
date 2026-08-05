#!/usr/bin/env node
// Genre backfill from Last.fm, for the artists MusicBrainz cannot reach.
//
//   set -a && . ../.env && set +a
//   node scripts/enrich-lastfm-genres.mjs [<festival-id> ...] [--dry-run] [--limit N]
//                                          [--refresh-unrenderable]
//
// Why this exists, and why it is not one of the other three. MusicBrainz is
// thin on electronic and DJ acts — of the artists still missing genres on
// 2026-08-05, 160 were FOUND there and simply carry no tags, and ~295 more had
// no confident match at all. Spotify no longer returns `genres` on the standard
// access tier and 403s its batch endpoint. Deezer carries no artist-level
// genres whatsoever. Last.fm's tags are user-generated, which is exactly why
// they cover the acts a curated database does not: someone listened and said
// so. Measured on a random 40 of the real gap: 35 returned tags, 34 kept at
// least one after the canon.
//
// artist.getTopTags needs the API KEY only. No OAuth, no session, no callback —
// the shared secret Last.fm issues alongside the key signs authenticated calls
// and is not used here.
//
// What gets stored. Tags come back raw and noisy: "dubstep" sits next to "UK",
// "los angeles", "female vocalists", "good". They are filtered through the
// app's OWN canon (data/genres.json — 40 canonical genres, 105 synonyms, and a
// suppress list that already kills "electronic"/"edm"/"seen live"), and only
// tags that survive are kept, in the same lowercase raw form the MusicBrainz
// path writes. The canon then does its usual job at read time, so a card cannot
// tell which source filled it.
//
// No "already asked" marker, deliberately. Last.fm tags accrue as people listen,
// so an artist with nothing today may have something next month, and re-asking
// is free and fast — unlike a YouTube search at 100 quota units. A whole re-run
// is a couple of minutes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from './enrich-artists.mjs';
import { canonicalize } from '../js/discovery/genres.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEST_DIR = join(ROOT, 'data', 'festivals');
const CACHE_PATH = join(ROOT, 'data', 'artists', 'artists.json');
const CANON_PATH = join(ROOT, 'data', 'genres.json');

// An artist can HAVE genres and still show none. Older MusicBrainz rows fell
// back to the `tags` list when the artist had no genre entries, and picked up
// things that are not genres at all — "producer", "singer", "uk", "missing
// releases", "#femmehouse", "brony" — plus real genres the canon does not carry
// ("red dirt", "electroclash") and ones it deliberately suppresses as too
// generic ("electronic", "dance"). All of them filter to nothing at render, so
// the row reads as filled and the card shows no chips. 33 rows were in that
// state on 2026-08-05, invisible to any count that only asks whether `genres`
// is empty.
//
// --refresh-unrenderable treats those as missing and re-asks. It is not the
// default, because it overwrites data that a curator may have put there on
// purpose. Nothing is lost when it runs: a replacement is only written if
// last.fm returns something that actually survives the canon, so an artist
// whose existing tags are real-but-unknown (Dixon's Violin, "avant-garde /
// experimental / instrumental") keeps them.
const GENRE_CAP = 8;    // matches CAPS.genres in enrich-artists.mjs
const PACE_MS = 260;    // Last.fm publishes no hard limit but does throttle
const RETRIES = 3;

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// Returns { ok, tags[] }. ok:false means we never got an answer — which must
// never be confused with "this artist has no tags", the same distinction the
// YouTube path draws between a refused search and an empty one.
async function topTags(name, key) {
  const url = 'https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags'
    + `&artist=${encodeURIComponent(name)}&api_key=${key}&autocorrect=1&format=json`;
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url);
    } catch (e) {
      if (attempt >= RETRIES) return { ok: false, reason: `network: ${e.message}` };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 1000 * (attempt + 1)); });
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= RETRIES) return { ok: false, reason: `HTTP ${res.status}` };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 1500 * (attempt + 1)); });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, reason: 'unparseable body' };
    // error 6 is "no such artist" — a real answer, and the answer is none.
    if (body.error && body.error !== 6) return { ok: false, reason: `lastfm error ${body.error}: ${body.message}` };
    const tags = ((body.toptags || {}).tag || [])
      .map((t) => String(t?.name || '').trim().toLowerCase())
      .filter(Boolean);
    return { ok: true, tags };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;
  const named = args.filter((a, i) => !a.startsWith('--') && i !== limIdx + 1);

  const key = process.env.LASTFM_API_KEY;
  if (!key) { console.error('LASTFM_API_KEY is not set — see the header of this file'); process.exit(1); }

  const refreshUnrenderable = args.includes('--refresh-unrenderable');
  const canon = loadJson(CANON_PATH, null);
  if (!canon) { console.error(`no genre canon at ${CANON_PATH}`); process.exit(1); }
  const cache = loadJson(CACHE_PATH, {});

  const ids = named.length ? named : loadJson(join(FEST_DIR, 'index.json'), []).map((f) => f.id);
  const fests = [];
  const todo = new Map(); // artist name -> [entry, ...] across festivals
  for (const id of ids) {
    const path = join(FEST_DIR, `${id}.json`);
    const fest = loadJson(path, null);
    if (!fest || !Array.isArray(fest.artists)) { console.log(`skip: ${id}`); continue; }
    fests.push({ path, fest });
    for (const entry of fest.artists) {
      if (!entry?.name) continue;
      const has = Array.isArray(entry.genres) && entry.genres.length;
      if (has && !refreshUnrenderable) continue; // never clobber
      if (has) {
        // Renders something? Then it is real data and stays.
        const c = canonicalize(entry.genres, canon);
        if ([c.primary, ...(c.secondary || [])].filter(Boolean).length) continue;
      }
      if (!todo.has(entry.name)) todo.set(entry.name, []);
      todo.get(entry.name).push(entry);
    }
  }

  const names = [...todo.keys()].slice(0, limit);
  console.log(`${fests.length} festival file(s); ${names.length} artist(s) missing genres.`);

  let filled = 0; let empty = 0; let failed = 0; let rows = 0;
  for (const [i, name] of names.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const r = await topTags(name, key);
    if (!r.ok) { failed += 1; console.log(`  ${name}: NOT ASKED — ${r.reason}`); }
    else {
      const { primary, secondary } = canonicalize(r.tags, canon);
      const keepSet = new Set([primary, ...(secondary || [])].filter(Boolean).map((g) => g.toLowerCase()));
      // Store the raw tags that survived, in the shape the MusicBrainz path
      // writes — the canon re-derives the display names at read time.
      // Dedupe by CANONICAL name, not by the raw string: last.fm carries
      // "hip hop" and "hip-hop" as separate tags and both survive the canon,
      // which would store one genre twice.
      const seenCanon = new Set();
      const kept = [];
      for (const t of r.tags) {
        const c = canonicalize([t], canon);
        const one = c.primary || (c.secondary || [])[0];
        if (!one || !keepSet.has(one.toLowerCase())) continue;
        if (seenCanon.has(one.toLowerCase())) continue;
        seenCanon.add(one.toLowerCase());
        kept.push(t);
        if (kept.length >= GENRE_CAP) break;
      }
      if (!kept.length) { empty += 1; }
      else {
        filled += 1;
        for (const entry of todo.get(name)) { if (!dryRun) entry.genres = kept; rows += 1; }
        const k = normalizeName(name);
        if (!dryRun) cache[k] = { ...(cache[k] || {}), genres: kept };
        if (filled <= 10) console.log(`  ${name}: ${kept.join(', ')}`);
      }
    }
    if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${names.length}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => { setTimeout(res, PACE_MS); });
  }

  console.log(`\n${dryRun ? '[dry-run] would fill' : 'filled'} ${filled} artist(s) → ${rows} row(s) across festivals.`);
  console.log(`${empty} artist(s) answered with nothing usable; ${failed} were never asked (retry those on a later run).`);
  if (dryRun) { console.log('[dry-run] nothing written.'); return; }
  for (const { path, fest } of fests) writeFileSync(path, `${JSON.stringify(fest, null, 2)}\n`);
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(`wrote ${fests.length} festival file(s) and the shared artist cache.`);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
