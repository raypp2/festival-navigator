#!/usr/bin/env node
// Search-backed soundcloudSlug backfill — the second pass enrich-artists.mjs
// cannot do.
//
//   node scripts/backfill-soundcloud.mjs [festival-id] [--limit N] [--apply]
//        [--include-review] [--report PATH] [--no-playable-check]
//
// WHY THIS EXISTS. enrich-artists.mjs sources soundcloudSlug from MusicBrainz
// url-rels only, and MusicBrainz simply does not carry the link for most of
// this catalogue: 464 unique artists across the 12 festival files have no slug
// (measured 2026-08-04), of which 289 ARE in MusicBrainz with no SoundCloud
// relation on the record and 168 got no confident MB match at all. Loud Luxury
// is the canonical case — 12 URL relations on its MB record (Spotify, Deezer,
// Apple, Tidal, Beatport, Discogs, Wikipedia...) and no SoundCloud, while
// soundcloud.com/loudluxury is verified with 152 tracks.
//
// Alternative link registries were measured and rejected as sources, both as
// EXACT-ID joins off the mbid we already hold (so neither was handicapped by
// fuzzy name lookup):
//   Wikidata (mbid -> item -> P3040)   0 hits / 20 artists
//   Discogs  (mbid -> artist -> urls)  1 hit  / 12 artists
//   SoundCloud's own user search      10 hits / 10 artists
// Release-centric catalogues model records, not artist profiles; P3040's own
// property page marks its completeness "always incomplete". Worse, curation is
// not automatically correct: Wikidata's item for Mau P (correctly labelled
// "Dutch DJ and record producer") carries P3040=mauricewest — the producer's
// OTHER alias — while search returns /realmaup, verified, 222 tracks.
//
// WHY THE GATE, NOT THE AUTH, IS THE CONTROL. An API key authenticates the
// caller; it does not tell you which artist matched. Search returns the same
// candidates either way. What keeps a wrong slug out is the scoring below —
// name identity plus SoundCloud's own `verified` flag, which is the platform
// attesting to who controls the account, the best provenance signal available
// anywhere. Slug guessing was measured as the alternative and is unusable:
// 19 of 20 naive name-slugs resolved to SOMETHING and only 2 were the right
// artist (BUNT. -> a 1-follower account, HoneyLuv -> "Honey Bunnss").
//
// DRY RUN BY DEFAULT — deliberately the opposite of enrich-artists.mjs. That
// script fills gaps for one festival from an authoritative relation; this one
// proposes hundreds of matches from a fuzzy signal, so nothing is written
// without --apply and the report is the deliverable. Writes obey the same
// never-clobber rule: a slug already present in the festival entry or the
// cache always wins.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapSoundcloudSounds } from '../js/discovery/player-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEST_DIR = join(ROOT, 'data', 'festivals');
const CACHE_PATH = join(ROOT, 'data', 'artists', 'artists.json');

const USER_AGENT = 'festival-navigator-fork/2.0 (https://github.com/raypp2/festival-navigator)';
const SC_MIN_INTERVAL_MS = 200;

// Gate thresholds. AUTO_FOLLOWERS is the line below which an UNVERIFIED
// account has to be looked at by a human; verified accounts skip it entirely
// because SoundCloud has already done the identity check.
const AUTO_FOLLOWERS = 5000;
const AUTO_MIN_TRACKS = 3;
const REVIEW_FOLLOWERS = 250;
// Short names collide with ordinary words ("DOT", "Couch", "Passport"), so an
// unverified short-name match never auto-applies however popular it is.
const SHORT_NAME_CHARS = 6;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests/soundcloud-backfill.test.mjs — no network,
// no fs). Fixtures in that suite are real search payloads, not invented ones.
// ---------------------------------------------------------------------------

// Homoglyphs that NFD will not decompose. Stylised stage names reach for these
// constantly ("Obskϋr" is Greek upsilon-with-dialytika, "Høldën" is a slashed
// o) and every one of them would otherwise read as a different artist.
const HOMOGLYPHS = {
  ø: 'o', đ: 'd', ð: 'd', þ: 'th', ß: 'ss', æ: 'ae', œ: 'oe', ł: 'l',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  υ: 'u', χ: 'x', ω: 'w', μ: 'u',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
};

// Name -> comparison key. Diacritics folded, homoglyphs folded, everything
// that is not a letter or digit dropped. This is what makes "BUNT." match
// "bunt" and "‏‏‎ ‎Dr. Dog" (real username, padded with invisible direction
// marks) match "Dr. Dog".
export function foldName(s) {
  const stripped = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  let out = '';
  for (const ch of stripped) out += HOMOGLYPHS[ch] || ch;
  return out.replace(/[^a-z0-9]/g, '');
}

// Vanity decoration an artist adds because the clean handle was taken years
// ago. Stripping these is what lets "sanholobeats" match "San Holo" and
// "riordanuk" match "Riordan" — the single most common shape in the misses.
const AFFIXES = [
  'official', 'officiel', 'ofc', 'themusic', 'music', 'musik', 'sounds', 'sound',
  'beats', 'audio', 'records', 'recordings', 'worldwide', 'live', 'hq', 'tv',
  'real', 'iam', 'its', 'the', 'dj', 'uk', 'usa', 'us', 'nl', 'au',
];

// Only ever called on an already-folded string. Returns the set of forms worth
// comparing, always including the untouched original.
export function nameForms(folded) {
  const forms = new Set();
  if (!folded) return forms;
  forms.add(folded);
  for (const affix of AFFIXES) {
    if (folded.length > affix.length + 2 && folded.endsWith(affix)) forms.add(folded.slice(0, -affix.length));
    if (folded.length > affix.length + 2 && folded.startsWith(affix)) forms.add(folded.slice(affix.length));
  }
  return forms;
}

// A lineup slot that is not one artist: B2B pairings and set-variant billings
// ("Of The Trees (Sunset Set)"). Searching these wastes calls and — worse —
// returns a confident match for the WRONG entity, because "Torren Foot B2B
// Rawolf" will happily match Torren Foot. Reported, never searched.
export function isBillingVariant(name) {
  const s = String(name || '');
  if (/\bb2b\b|\bvs\.?\b|\bb3b\b/i.test(s)) return 'b2b / versus billing';
  if (/\((?:[^)]*\b(?:set|sunset|sunrise|closing|opening|takeover|presents|hosted|all night|live band)\b[^)]*)\)/i.test(s)) {
    return 'set-variant billing';
  }
  return null;
}

// How well one search hit's identity matches the artist we asked for.
// 'exact'   — some form of the name equals some form of the handle/username
// 'partial' — one contains the other (>= 5 chars, so "dot" can't swallow
//             "dotcom"); real but weak, review-only
// 'none'    — unrelated
export function nameMatchKind(artistName, hit) {
  const wanted = nameForms(foldName(artistName));
  const got = new Set([...nameForms(foldName(hit?.username)), ...nameForms(foldName(hit?.permalink))]);
  for (const w of wanted) {
    if (!w) continue;
    if (got.has(w)) return 'exact';
  }
  return partialMatch(wanted, got);
}

// The permalink is the half of the identity that is hard to fake: handles are
// first-come and permanent-ish, while `username` is free text anyone can set
// to anything this afternoon. So a match that rests ONLY on the username is a
// weaker claim, and for an unverified account it is not enough to write
// automatically. Auto-generated handles (`user-133963194`, `jmo-844048447`)
// are the tell — the first dry run put SKILAH and ALYSSA JOLEE straight into
// `auto` on username alone, both unverified, both behind default handles.
export function handleMatchesName(artistName, hit) {
  const wanted = nameForms(foldName(artistName));
  const got = nameForms(foldName(hit?.permalink));
  for (const w of wanted) if (w && got.has(w)) return true;
  return partialMatch(wanted, got) === 'partial';
}

function partialMatch(wanted, got) {
  for (const w of wanted) {
    if (!w || w.length < 5) continue;
    for (const g of got) {
      if (!g || g.length < 5) continue;
      if (g.includes(w) || w.includes(g)) return 'partial';
    }
  }
  return 'none';
}

/**
 * Judge one candidate. Returns { verdict, kind, reasons } where verdict is
 * 'auto' (safe to write), 'review' (a human decides) or 'reject'.
 *
 * The asymmetry is intentional: a false ACCEPT ships a stranger's tracks on an
 * artist page, a false REJECT leaves a gap that was already there. When the
 * signals disagree, fall to review.
 */
export function scoreCandidate(artistName, hit) {
  const reasons = [];
  const kind = nameMatchKind(artistName, hit);
  const followers = Number(hit?.followers_count) || 0;
  const tracks = Number(hit?.track_count) || 0;
  const verified = hit?.verified === true;
  const folded = foldName(artistName);

  if (kind === 'none') return { verdict: 'reject', kind, reasons: ['name does not match'] };
  if (tracks === 0) return { verdict: 'reject', kind, reasons: ['profile has no tracks — the tab would be empty'] };

  if (verified) reasons.push('verified by SoundCloud');
  reasons.push(`${followers.toLocaleString()} followers`, `${tracks} tracks`);

  const shortName = folded.length < SHORT_NAME_CHARS;
  const popular = followers >= AUTO_FOLLOWERS;
  const enoughTracks = tracks >= AUTO_MIN_TRACKS;
  const handleMatches = handleMatchesName(artistName, hit);

  if (kind === 'exact' && enoughTracks && (verified || (popular && !shortName && handleMatches))) {
    return { verdict: 'auto', kind, reasons };
  }
  if (kind === 'exact' && !verified && !handleMatches) {
    reasons.push(`handle \`${hit?.permalink}\` does not carry the name — username alone, unverified`);
    return { verdict: 'review', kind, reasons };
  }
  if (kind === 'exact' && shortName && !verified) {
    reasons.push('short/common name and unverified — needs eyes');
    return { verdict: 'review', kind, reasons };
  }
  if (followers >= REVIEW_FOLLOWERS) {
    if (!enoughTracks) reasons.push(`only ${tracks} track(s)`);
    if (kind === 'partial') reasons.push('name matches only partially');
    if (!verified && !popular) reasons.push('unverified and below the auto follower bar');
    return { verdict: 'review', kind, reasons };
  }
  return { verdict: 'reject', kind, reasons: [...reasons, `under ${REVIEW_FOLLOWERS} followers`] };
}

// Best candidate plus the runner-up, because a report that shows only the
// winner gives a reviewer no way to see a close call.
export function pickBest(artistName, hits) {
  const scored = (Array.isArray(hits) ? hits : []).map((hit) => ({ hit, ...scoreCandidate(artistName, hit) }));
  const rank = { auto: 0, review: 1, reject: 2 };
  scored.sort((a, b) => (rank[a.verdict] - rank[b.verdict])
    || ((Number(b.hit?.followers_count) || 0) - (Number(a.hit?.followers_count) || 0)));
  return { best: scored[0] || null, runnerUp: scored[1] || null, all: scored };
}

// ---------------------------------------------------------------------------
// CLI (network + fs) — importing this module never touches either.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

let lastScRequestAt = 0;
async function scFetch(url) {
  const wait = SC_MIN_INTERVAL_MS - (Date.now() - lastScRequestAt);
  if (wait > 0) await sleep(wait);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  lastScRequestAt = Date.now();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/client_id=[^&]+/, 'client_id=***')}`);
  return res.json();
}

// SOUNDCLOUD_CLIENT_ID (an official self-serve key, gated behind Artist Pro
// since May 2026) is preferred and is the only option that is inside the API
// terms and has a documented rate limit. Without it we fall back to the id the
// public widget ships in its own bundle — which is what made this measurable
// in the first place, but it is undocumented and rotates without notice, so a
// pipeline that depends on it WILL break silently one day. Fine for a backfill
// you watch run; not something to schedule.
async function clientIdWorks(candidate) {
  try {
    const url = 'https://api-widget.soundcloud.com/resolve?url='
      + encodeURIComponent('https://soundcloud.com/alesso') + `&format=json&client_id=${candidate}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    return res.ok;
  } catch {
    return false;
  }
}

async function discoverClientId() {
  const fromEnv = process.env.SOUNDCLOUD_CLIENT_ID;
  if (fromEnv) {
    if (!await clientIdWorks(fromEnv)) throw new Error('SOUNDCLOUD_CLIENT_ID is set but was rejected by the API');
    return { clientId: fromEnv, source: 'SOUNDCLOUD_CLIENT_ID' };
  }
  const page = await (await fetch('https://w.soundcloud.com/player/', { headers: { 'User-Agent': USER_AGENT } })).text();
  const scripts = [...page.matchAll(/src="(https:\/\/widget\.sndcdn\.com\/[^"]+\.js)"/g)].map((m) => m[1]);
  // The bundles carry SEVERAL 32-char constants and only some are client ids —
  // the first match is a lowercase-hex tracking id that 401s on every call.
  // So don't pattern-guess which one it is: try each against a known-good
  // resolve and keep the one the API actually accepts.
  const tried = new Set();
  for (const src of scripts.reverse()) {
    // eslint-disable-next-line no-await-in-loop
    const js = await (await fetch(src, { headers: { 'User-Agent': USER_AGENT } })).text();
    const candidates = [
      ...[...js.matchAll(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/g)].map((m) => m[1]),
      ...[...js.matchAll(/["']([A-Za-z0-9]{32})["']/g)].map((m) => m[1]),
    ];
    for (const c of candidates) {
      if (tried.has(c)) continue;
      tried.add(c);
      // eslint-disable-next-line no-await-in-loop
      if (await clientIdWorks(c)) return { clientId: c, source: 'widget bundle (undocumented, may rotate)' };
    }
  }
  throw new Error(`could not obtain a working SoundCloud client id (tried ${tried.size}) — set SOUNDCLOUD_CLIENT_ID`);
}

async function searchUsers(name, clientId) {
  const url = `https://api-widget.soundcloud.com/search/users?q=${encodeURIComponent(name)}&client_id=${clientId}&limit=5`;
  const body = await scFetch(url);
  return body?.collection || [];
}

// Does this profile actually yield playable rows? Reuses the SHIPPED mapping
// from js/discovery/player-core.js rather than a copy, so a slug that would
// render a struck-out tab is visible in the report before it is written. This
// is not a gate — an artist can post something playable tomorrow — it is the
// difference between "we linked a profile" and "we linked a profile that
// works".
async function playableRows(userId, clientId) {
  try {
    const body = await scFetch(`https://api-widget.soundcloud.com/users/${userId}/tracks?client_id=${clientId}&limit=20&offset=0&linked_partitioning=1`);
    const mapped = mapSoundcloudSounds(body?.collection || []);
    return { rows: mapped.items.length, allUnplayable: mapped.allUnplayable };
  } catch {
    return { rows: null, allUnplayable: false };
  }
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/\s+/g, ' ');
}

// One row per artist NAME, carrying every festival that bills them — the same
// artist appears on up to four lineups and must be searched once, not four
// times.
function collectTargets(festivalIds) {
  const byName = new Map();
  // A slug already in the shared cache counts as present even when this
  // festival's entry is missing it: the never-clobber rule would refuse the
  // write anyway, and proposing a DIFFERENT slug for an artist we have already
  // researched is worse than proposing nothing. (Zero artists are in this
  // state as of 2026-08-04 — this is a guard, not a fix.)
  const cache = loadJson(CACHE_PATH, {});
  for (const fid of festivalIds) {
    const path = join(FEST_DIR, `${fid}.json`);
    const fest = loadJson(path, null);
    if (!fest || !Array.isArray(fest.artists)) continue;
    for (const a of fest.artists) {
      if (!a || !a.name) continue;
      if (typeof a.soundcloudSlug === 'string' && a.soundcloudSlug.trim()) continue;
      const key = normalizeKey(a.name);
      const cachedSlug = cache[key]?.soundcloudSlug;
      if (typeof cachedSlug === 'string' && cachedSlug.trim()) continue;
      if (!byName.has(key)) byName.set(key, { name: a.name, key, festivals: [] });
      byName.get(key).festivals.push(fid);
    }
  }
  return [...byName.values()];
}

function esc(s) { return String(s ?? '').replace(/\|/g, '\\|'); }

function reportTable(rows, showWhy = false) {
  if (!rows.length) return '_none_\n';
  const head = `| Artist | Lineups | Proposed slug | Verified | Followers | Tracks | Playable rows | Runner-up |${showWhy ? ' Why it needs eyes |' : ''}\n`
    + `| --- | --- | --- | --- | ---: | ---: | ---: | --- |${showWhy ? ' --- |' : ''}\n`;
  return head + rows.map((r) => {
    const h = r.best.hit;
    const ru = r.runnerUp && r.runnerUp.hit
      ? `${esc(r.runnerUp.hit.username)} (/${esc(r.runnerUp.hit.permalink)}, ${(Number(r.runnerUp.hit.followers_count) || 0).toLocaleString()})`
      : '—';
    const play = r.playable?.rows === null || r.playable?.rows === undefined
      ? '?'
      : (r.playable.rows === 0 ? '**0 — tab would die**' : String(r.playable.rows));
    const why = showWhy ? ` ${esc(r.best.reasons.join('; '))} |` : '';
    return `| ${esc(r.name)} | ${r.festivals.join(', ')} | \`${esc(h.permalink)}\` | ${h.verified ? 'yes' : 'no'} `
      + `| ${(Number(h.followers_count) || 0).toLocaleString()} | ${Number(h.track_count) || 0} | ${play} | ${ru} |${why}`;
  }).join('\n') + '\n';
}

function buildReport({ results, skipped, notFound, festivalIds, clientSource, applied, stamp }) {
  const auto = results.filter((r) => r.best?.verdict === 'auto');
  const review = results.filter((r) => r.best?.verdict === 'review');
  const rejected = results.filter((r) => r.best?.verdict === 'reject');
  const dead = auto.concat(review).filter((r) => r.playable?.rows === 0);

  return `# SoundCloud slug backfill — ${applied ? 'APPLIED' : 'dry run'}

Generated ${stamp} · lineups: ${festivalIds.join(', ')} · client id source: ${clientSource}

${applied ? '**These changes were written.**' : '**Nothing was written.** Re-run with `--apply` to write the auto rows, or `--apply --include-review` for both.'}

| bucket | count | meaning |
| --- | ---: | --- |
| auto | ${auto.length} | exact name match, enough tracks, verified or well-followed |
| review | ${review.length} | plausible — a human decides |
| reject | ${rejected.length} | best candidate failed the gate |
| not searched | ${skipped.length} | B2B / set-variant billing, not one artist |
| no results | ${notFound.length} | search returned nothing |

${dead.length ? `> ⚠️ ${dead.length} accepted profile(s) currently yield **zero playable rows** — the slug is right but the SoundCloud tab would strike itself out (every posted track is ad-supported, which the widget skips for anonymous listeners). Linking them is still correct; they just will not play today.\n` : ''}
## auto — safe to write

${reportTable(auto)}
## review — decide these by hand

${reportTable(review, true)}
## reject — best candidate failed the gate

${rejected.length ? rejected.map((r) => `- **${r.name}** (${r.festivals.join(', ')}) — best was ${r.best.hit ? `\`${r.best.hit.permalink}\` "${r.best.hit.username}"` : 'nothing'}: ${r.best.reasons.join('; ')}`).join('\n') + '\n' : '_none_\n'}
## not searched — billing variants, not artists

${skipped.length ? skipped.map((s) => `- **${s.name}** (${s.festivals.join(', ')}) — ${s.reason}`).join('\n') + '\n' : '_none_\n'}
## no search results

${notFound.length ? notFound.map((s) => `- ${s.name} (${s.festivals.join(', ')})`).join('\n') + '\n' : '_none_\n'}`;
}

function applySlugs(rows) {
  const cache = loadJson(CACHE_PATH, {});
  const byFest = new Map();
  for (const r of rows) {
    for (const fid of r.festivals) {
      if (!byFest.has(fid)) byFest.set(fid, loadJson(join(FEST_DIR, `${fid}.json`), null));
    }
  }
  let written = 0;
  for (const r of rows) {
    const slug = r.best.hit.permalink;
    for (const fid of r.festivals) {
      const fest = byFest.get(fid);
      if (!fest || !Array.isArray(fest.artists)) continue;
      for (const a of fest.artists) {
        // Never clobber: a slug that arrived by hand or from MusicBrainz while
        // this run was in flight always wins.
        if (!a || normalizeKey(a.name) !== r.key) continue;
        if (typeof a.soundcloudSlug === 'string' && a.soundcloudSlug.trim()) continue;
        a.soundcloudSlug = slug;
        written += 1;
      }
    }
    const cached = cache[r.key];
    if (cached && typeof cached === 'object' && !(typeof cached.soundcloudSlug === 'string' && cached.soundcloudSlug.trim())) {
      cached.soundcloudSlug = slug;
    }
  }
  for (const [fid, fest] of byFest) {
    if (fest) writeFileSync(join(FEST_DIR, `${fid}.json`), `${JSON.stringify(fest, null, 2)}\n`);
  }
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const festivalArg = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx !== -1 ? args[reportIdx + 1] : join(ROOT, 'soundcloud-backfill-report.md');
  const apply = args.includes('--apply');
  const includeReview = args.includes('--include-review');
  const checkPlayable = !args.includes('--no-playable-check');

  const festivalIds = festivalArg
    ? [festivalArg]
    : readdirSync(FEST_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.replace(/\.json$/, ''));

  for (const fid of festivalIds) {
    if (!existsSync(join(FEST_DIR, `${fid}.json`))) {
      console.error(`${fid}.json does not exist.`);
      process.exit(1);
    }
  }

  const all = collectTargets(festivalIds);
  const skipped = [];
  const searchable = [];
  for (const t of all) {
    const reason = isBillingVariant(t.name);
    if (reason) skipped.push({ ...t, reason });
    else searchable.push(t);
  }
  const targets = searchable.slice(0, limit);

  const { clientId, source } = await discoverClientId();
  console.log(`client id source: ${source}`);
  console.log(`${festivalIds.length} lineup(s): ${all.length} artist(s) without a slug — ${skipped.length} billing variant(s) skipped, searching ${targets.length}.`);

  const results = [];
  const notFound = [];
  let done = 0;
  for (const t of targets) {
    let hits = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      hits = await searchUsers(t.name, clientId);
    } catch (e) {
      console.log(`  ${t.name}: search failed — ${e.message}`);
      continue;
    }
    if (!hits.length) { notFound.push(t); continue; }
    const { best, runnerUp } = pickBest(t.name, hits);
    let playable;
    if (checkPlayable && best && best.verdict !== 'reject') {
      // eslint-disable-next-line no-await-in-loop
      playable = await playableRows(best.hit.id, clientId);
    }
    results.push({ ...t, best, runnerUp, playable });
    done += 1;
    if (done % 25 === 0) console.log(`  …${done}/${targets.length}`);
  }

  const auto = results.filter((r) => r.best?.verdict === 'auto');
  const review = results.filter((r) => r.best?.verdict === 'review');
  const toWrite = includeReview ? auto.concat(review) : auto;

  let written = 0;
  if (apply && toWrite.length) written = applySlugs(toWrite);

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  writeFileSync(reportPath, buildReport({
    results, skipped, notFound, festivalIds, clientSource: source, applied: apply, stamp,
  }));

  console.log(`\nauto ${auto.length} · review ${review.length} · reject ${results.length - auto.length - review.length} · not searched ${skipped.length} · no results ${notFound.length}`);
  console.log(`report: ${reportPath}`);
  if (apply) console.log(`applied ${toWrite.length} slug(s) across ${written} festival entr(ies)${includeReview ? ' (auto + review)' : ' (auto only)'}.`);
  else console.log('dry run — nothing written. Review the report, then re-run with --apply.');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
