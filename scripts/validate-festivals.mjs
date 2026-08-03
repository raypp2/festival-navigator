#!/usr/bin/env node
// Validate data/festivals/*.json against the festival schema.
// Run:  node scripts/validate-festivals.mjs        (errors exit 1; warnings don't)
// Used by CI and by scripts/import-festival.mjs.
// The core rules live in api/_lib/festival-rules.mjs (single source of
// truth, shared with the /api/festival-add candidate validation). The
// Discovery-epic additions below (optional artist enrichment fields +
// data/genres.json shape) are validated here because festival-rules.mjs is
// not owned by this slice — see claude-plans/2026-07-30-discovery-build-spec.md
// section 3.6.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFestivalDoc } from '../api/_lib/festival-rules.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'festivals');
const GENRES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'genres.json');

// Discovery META-1 (build spec section 3.1): optional per-artist enrichment
// fields. Strings must be non-empty; arrays must be arrays of non-empty
// strings within the documented caps. Violations are errors, not warnings —
// a malformed enrichment field silently breaks the sample player / genre
// filter at read time, so it fails CI the same as a bad `time`.
const EXTRA_STRING_FIELDS = ['soundcloudSlug', 'spotifyId', 'youtubeQuery', 'bandsintownId'];
// youtubeLabels is positional against youtubeVideoIds — labels[i] names ids[i]
// — so it shares the cap. A shorter array is fine (player-core falls back to
// "Set N" per index); a longer one means the two drifted apart.
const EXTRA_ARRAY_FIELD_CAPS = { genres: 8, youtubeVideoIds: 4, youtubeLabels: 4 };

// Validate the optional Discovery enrichment fields on a festival's
// artists[] entries. Pure — takes the array, returns {errors, warnings}.
// (`artists[]` — the top-level billing-order array — is where
// scripts/enrich-artists.mjs writes; per-day `days{}` entries are schedule
// projections and are not enrichment targets.)
export function validateArtistExtras(artists) {
  const errors = [];
  const warnings = [];
  (Array.isArray(artists) ? artists : []).forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    const label = `artists[${i}]${a.name ? ` (${a.name})` : ''}`;
    for (const field of EXTRA_STRING_FIELDS) {
      if (a[field] === undefined) continue;
      if (typeof a[field] !== 'string' || a[field].trim().length === 0) {
        errors.push(`${label}: ${field} must be a non-empty string`);
      }
    }
    for (const [field, cap] of Object.entries(EXTRA_ARRAY_FIELD_CAPS)) {
      const v = a[field];
      if (v === undefined) continue;
      if (!Array.isArray(v)) { errors.push(`${label}: ${field} must be an array`); continue; }
      if (v.length > cap) errors.push(`${label}: ${field} has ${v.length} entries — cap is ${cap}`);
      v.forEach((item, j) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          errors.push(`${label}: ${field}[${j}] must be a non-empty string`);
        }
      });
    }
  });
  return { errors, warnings };
}

// Discovery billing-vs-schedule fix (2026-07-30): festivals MAY declare a
// top-level `artistOrder` telling score.js how to read artists[] position.
// Absent means "billing" (headliners first) — the long-documented contract.
// Schedule-ordered festivals (openers first, headliners last, e.g. Electric
// Forest / Lollapalooza) must say so explicitly, or score.js's billing prior
// and "#n on the bill" ribbons invert. Anything other than the two known
// values is an error, not a warning — a typo here silently re-breaks the
// exact bug this field exists to fix.
export const ARTIST_ORDERS = ['billing', 'schedule'];

export function validateArtistOrder(fest) {
  const errors = [];
  if (fest && fest.artistOrder !== undefined && !ARTIST_ORDERS.includes(fest.artistOrder)) {
    errors.push(`artistOrder must be one of ${ARTIST_ORDERS.join('|')} (got ${JSON.stringify(fest.artistOrder)})`);
  }
  return { errors, warnings: [] };
}

// Validate data/genres.json itself (build spec section 3.3): canon must be
// non-empty with unique entries; every synonyms value must resolve to a
// canon entry; no suppress entry may shadow a canon entry (case-insensitive)
// or a synonyms key (raw tags are lowercase by convention, but compare
// case-insensitively defensively).
export function validateGenresDoc(genres) {
  const errors = [];
  const warnings = [];
  if (!genres || typeof genres !== 'object' || Array.isArray(genres)) {
    return { errors: ['genres.json must be an object'], warnings };
  }

  const canon = Array.isArray(genres.canon) ? genres.canon : null;
  if (!canon || canon.length === 0) {
    errors.push('canon must be a non-empty array');
  } else {
    canon.forEach((c, i) => {
      if (typeof c !== 'string' || c.trim().length === 0) errors.push(`canon[${i}] must be a non-empty string`);
    });
    const seen = new Set();
    for (const c of canon) {
      if (seen.has(c)) errors.push(`canon has a duplicate entry: ${JSON.stringify(c)}`);
      seen.add(c);
    }
  }
  const canonSet = new Set(canon || []);
  const canonLowerSet = new Set([...canonSet].map((c) => String(c).toLowerCase()));

  const synonyms = genres.synonyms;
  if (synonyms !== undefined) {
    if (typeof synonyms !== 'object' || synonyms === null || Array.isArray(synonyms)) {
      errors.push('synonyms must be an object');
    } else {
      for (const [raw, canonical] of Object.entries(synonyms)) {
        if (typeof canonical !== 'string' || !canonSet.has(canonical)) {
          errors.push(`synonyms[${JSON.stringify(raw)}] maps to ${JSON.stringify(canonical)}, which is not a canon entry`);
        }
      }
    }
  }
  const synonymKeysLower = new Set(Object.keys(synonyms || {}).map((k) => k.toLowerCase()));

  const suppress = genres.suppress;
  if (suppress !== undefined) {
    if (!Array.isArray(suppress)) {
      errors.push('suppress must be an array');
    } else {
      suppress.forEach((s, i) => {
        if (typeof s !== 'string' || s.trim().length === 0) { errors.push(`suppress[${i}] must be a non-empty string`); return; }
        const lower = s.toLowerCase();
        if (canonLowerSet.has(lower)) errors.push(`suppress entry ${JSON.stringify(s)} collides with a canon entry`);
        if (synonymKeysLower.has(lower)) errors.push(`suppress entry ${JSON.stringify(s)} collides with a synonyms key`);
      });
    }
  }

  return { errors, warnings };
}

function main() {
  const errors = [];
  const warnings = [];

  if (!existsSync(DIR)) {
    console.log('No data/festivals/ directory yet — nothing to validate.');
    process.exit(0);
  }

  const files = readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'index.json');
  const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
  const indexIds = new Set(index.map((e) => e.id));

  for (const file of files) {
    let fest;
    try { fest = JSON.parse(readFileSync(join(DIR, file), 'utf8')); }
    catch (e) { errors.push(`${file}: invalid JSON: ${e.message}`); continue; }
    const r = validateFestivalDoc(fest, { filename: file });
    errors.push(...r.errors.map((m) => `${file}: ${m}`));
    warnings.push(...r.warnings.map((m) => `${file}: ${m}`));
    const extras = validateArtistExtras(fest && fest.artists);
    errors.push(...extras.errors.map((m) => `${file}: ${m}`));
    warnings.push(...extras.warnings.map((m) => `${file}: ${m}`));
    const orderCheck = validateArtistOrder(fest);
    errors.push(...orderCheck.errors.map((m) => `${file}: ${m}`));
    if (!indexIds.has(fest.id)) errors.push(`${file}: festival not listed in index.json`);
  }
  for (const entry of index) {
    if (!files.includes(`${entry.id}.json`)) errors.push(`index.json: lists ${entry.id} but ${entry.id}.json missing`);
    for (const k of ['id', 'name', 'status']) if (!entry[k]) errors.push(`index.json: ${entry.id || '?'}: missing ${k}`);
    // startsOn drives the landing's date sort and its "Sep '26" labels —
    // free-text `dates` can't be sorted, so the ISO key is required, and it
    // must be a REAL calendar date (2026-99-99 sorts lexically and months
    // beyond Dec render as no month at all — shape alone isn't enough).
    const so = entry.startsOn || '';
    const parsed = new Date(`${so}T00:00:00Z`);
    const roundTrips = /^\d{4}-\d{2}-\d{2}$/.test(so)
      && !Number.isNaN(parsed.getTime()) // guard BEFORE toISOString — an invalid date THROWS there
      && parsed.toISOString().slice(0, 10) === so;
    if (!roundTrips) {
      errors.push(`index.json: ${entry.id || '?'}: startsOn must be a real YYYY-MM-DD date`);
    }
  }

  if (!existsSync(GENRES_PATH)) {
    errors.push('data/genres.json: missing');
  } else {
    let genres;
    try { genres = JSON.parse(readFileSync(GENRES_PATH, 'utf8')); }
    catch (e) { errors.push(`data/genres.json: invalid JSON: ${e.message}`); genres = null; }
    if (genres) {
      const r = validateGenresDoc(genres);
      errors.push(...r.errors.map((m) => `data/genres.json: ${m}`));
      warnings.push(...r.warnings.map((m) => `data/genres.json: ${m}`));
    }
  }

  warnings.forEach((w) => console.log(`⚠️  ${w}`));
  errors.forEach((e) => console.log(`❌ ${e}`));
  console.log(`\n${files.length} festival file(s): ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
