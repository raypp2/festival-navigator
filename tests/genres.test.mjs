import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, genreSubLine } from '../js/discovery/genres.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

// Small inline fixture for logic cases — independent of the real curated
// data/genres.json so these tests keep meaning even if the canon changes.
const FIXTURE = {
  canon: ['Riddim', 'Dubstep', 'Drum & Bass', 'House'],
  synonyms: { 'dnb': 'Drum & Bass', 'tech-house': 'House' },
  suppress: ['electronic', 'edm'],
};

test('canonicalize: suppressed tags are dropped', () => {
  const out = canonicalize(['electronic', 'edm'], FIXTURE);
  assert.deepEqual(out, { primary: null, secondary: [] });
});

test('canonicalize: synonym mapping resolves to the canon entry', () => {
  const out = canonicalize(['dnb'], FIXTURE);
  assert.equal(out.primary, 'Drum & Bass');
  assert.deepEqual(out.secondary, []);
});

test('canonicalize: specificity ordering — Riddim beats Dubstep when both present', () => {
  const out = canonicalize(['dubstep', 'riddim'], FIXTURE);
  assert.equal(out.primary, 'Riddim');
  assert.deepEqual(out.secondary, ['Dubstep']);
});

test('canonicalize: case and whitespace insensitivity', () => {
  const out = canonicalize(['  RIDDIM  ', 'Dubstep'], FIXTURE);
  assert.equal(out.primary, 'Riddim');
  assert.deepEqual(out.secondary, ['Dubstep']);
});

test('canonicalize: secondary is deduped, in canon order, primary excluded', () => {
  const out = canonicalize(['house', 'tech-house', 'dubstep', 'house'], FIXTURE);
  assert.equal(out.primary, 'Dubstep');
  assert.deepEqual(out.secondary, ['House']);
});

test('canonicalize: junk input is safe — non-array input', () => {
  assert.deepEqual(canonicalize(null, FIXTURE), { primary: null, secondary: [] });
  assert.deepEqual(canonicalize(undefined, FIXTURE), { primary: null, secondary: [] });
  assert.deepEqual(canonicalize('riddim', FIXTURE), { primary: null, secondary: [] });
  assert.deepEqual(canonicalize(42, FIXTURE), { primary: null, secondary: [] });
  assert.deepEqual(canonicalize({}, FIXTURE), { primary: null, secondary: [] });
});

test('canonicalize: junk input is safe — non-string members inside the array are skipped', () => {
  const out = canonicalize([42, null, undefined, {}, ['nested'], 'riddim'], FIXTURE);
  assert.equal(out.primary, 'Riddim');
});

test('canonicalize: empty array input -> nulls', () => {
  assert.deepEqual(canonicalize([], FIXTURE), { primary: null, secondary: [] });
});

test('canonicalize: never throws on a missing/malformed canonData', () => {
  assert.doesNotThrow(() => canonicalize(['riddim'], null));
  assert.doesNotThrow(() => canonicalize(['riddim'], undefined));
  assert.doesNotThrow(() => canonicalize(['riddim'], {}));
  assert.deepEqual(canonicalize(['riddim'], {}), { primary: null, secondary: [] });
});

test('genreSubLine: primary + first secondary joined with " · "', () => {
  assert.equal(genreSubLine(['dubstep', 'riddim'], FIXTURE), 'Riddim · Dubstep');
});

test('genreSubLine: primary only when there is no secondary', () => {
  assert.equal(genreSubLine(['dnb'], FIXTURE), 'Drum & Bass');
});

test('genreSubLine: null when there is no primary (caller renders the empty-state copy)', () => {
  assert.equal(genreSubLine(['electronic'], FIXTURE), null);
  assert.equal(genreSubLine([], FIXTURE), null);
  assert.equal(genreSubLine(null, FIXTURE), null);
});

// --- Contract tests against the real, curated data/genres.json -------------
// Read directly off disk (not via fetch — these tests run under node:test,
// no HTTP server). Guards the shape the loader promises callers, plus a few
// mappings the rest of Discovery depends on staying put.

const realCanonData = JSON.parse(read('data/genres.json'));

test('data/genres.json: shape is valid per the canonicalize() contract', () => {
  assert.ok(Array.isArray(realCanonData.canon) && realCanonData.canon.length > 0, 'canon is a non-empty array');
  for (const entry of realCanonData.canon) {
    assert.equal(typeof entry, 'string', `canon entry ${JSON.stringify(entry)} must be a string`);
  }
  // canon entries are unique (case-insensitively) — duplicates would make
  // "earliest in canon" ambiguous.
  const lowered = realCanonData.canon.map((c) => c.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length, 'canon entries must be unique case-insensitively');

  assert.equal(typeof realCanonData.synonyms, 'object');
  assert.ok(!Array.isArray(realCanonData.synonyms));
  const canonSet = new Set(lowered);
  for (const [raw, target] of Object.entries(realCanonData.synonyms)) {
    assert.equal(raw, raw.toLowerCase(), `synonym key ${JSON.stringify(raw)} must be lowercase`);
    assert.equal(typeof target, 'string', `synonym target for ${JSON.stringify(raw)} must be a string`);
    assert.ok(canonSet.has(target.toLowerCase()), `synonym ${JSON.stringify(raw)} -> ${JSON.stringify(target)} must point at a canon entry`);
  }

  assert.ok(Array.isArray(realCanonData.suppress));
  for (const entry of realCanonData.suppress) {
    assert.equal(typeof entry, 'string');
    assert.equal(entry, entry.toLowerCase(), `suppress entry ${JSON.stringify(entry)} must be lowercase`);
  }

  // suppress and synonyms must not overlap — an ambiguous tag would silently
  // depend on object key order / suppress-check-first behavior.
  const suppressSet = new Set(realCanonData.suppress);
  for (const raw of Object.keys(realCanonData.synonyms)) {
    assert.ok(!suppressSet.has(raw), `${JSON.stringify(raw)} is both suppressed and a synonym`);
  }
});

test('data/genres.json: real mapping — "dnb" -> "Drum & Bass"', () => {
  const out = canonicalize(['dnb'], realCanonData);
  assert.equal(out.primary, 'Drum & Bass');
});

test('data/genres.json: real mapping — "electronic" is suppressed', () => {
  const out = canonicalize(['electronic'], realCanonData);
  assert.deepEqual(out, { primary: null, secondary: [] });
});

test('data/genres.json: real mapping — "hip hop" -> "Hip-Hop"', () => {
  const out = canonicalize(['hip hop'], realCanonData);
  assert.equal(out.primary, 'Hip-Hop');
});
