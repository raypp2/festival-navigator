// Discovery M1 (data foundation) tests — pure-function only, no network.
// Covers scripts/enrich-artists.mjs's mergeEnrichment (the merge rule that
// makes enrichment safe to re-run without clobbering curator hand-edits) and
// scripts/validate-festivals.mjs's new-field + genres.json validators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEnrichment, normalizeName, pickMbHit, extractGenres, extractSoundcloudSlug, extractSpotifyId } from '../scripts/enrich-artists.mjs';
import { validateArtistExtras, validateGenresDoc, validateArtistOrder, ARTIST_ORDERS } from '../scripts/validate-festivals.mjs';

// ---------------------------------------------------------------------------
// mergeEnrichment
// ---------------------------------------------------------------------------

test('mergeEnrichment fills fields missing from the entry using cache, then fetched', () => {
  const entry = { name: 'GRiZ' };
  const cached = { spotifyId: 'abc123' };
  const fetched = { genres: ['future bass', 'funk'], spotifyId: 'should-not-win', soundcloudSlug: 'griz' };
  const out = mergeEnrichment(entry, cached, fetched);
  assert.deepEqual(out.genres, ['future bass', 'funk']); // from fetched (entry+cache had none)
  assert.equal(out.spotifyId, 'abc123'); // cache wins over fetched
  assert.equal(out.soundcloudSlug, 'griz'); // from fetched (entry+cache had none)
});

test('mergeEnrichment never clobbers a non-empty value already on the entry', () => {
  const entry = { name: 'GRiZ', genres: ['funk'], spotifyId: 'curator-picked' };
  const cached = { genres: ['future bass', 'bass house'], spotifyId: 'cache-value' };
  const fetched = { genres: ['dubstep'], spotifyId: 'fetched-value' };
  const out = mergeEnrichment(entry, cached, fetched);
  assert.deepEqual(out.genres, ['funk']); // entry's hand-edit wins outright
  assert.equal(out.spotifyId, 'curator-picked');
});

test('mergeEnrichment treats empty arrays/strings on the entry as missing, not authoritative', () => {
  const entry = { name: 'GRiZ', genres: [], soundcloudSlug: '   ' };
  const cached = {};
  const fetched = { genres: ['future bass'], soundcloudSlug: 'griz' };
  const out = mergeEnrichment(entry, cached, fetched);
  assert.deepEqual(out.genres, ['future bass']);
  assert.equal(out.soundcloudSlug, 'griz');
});

test('mergeEnrichment caps genres at 8 and youtubeVideoIds at 4 even if a source exceeds it', () => {
  const entry = {};
  const cached = {};
  const fetched = {
    genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    youtubeVideoIds: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'],
  };
  const out = mergeEnrichment(entry, cached, fetched);
  assert.equal(out.genres.length, 8);
  assert.deepEqual(out.genres, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(out.youtubeVideoIds.length, 4);
  assert.deepEqual(out.youtubeVideoIds, ['v1', 'v2', 'v3', 'v4']);
});

test('mergeEnrichment omits fields with no value anywhere (never writes undefined/null keys)', () => {
  const out = mergeEnrichment({ name: 'GRiZ' }, {}, {});
  assert.deepEqual(out, {});
});

test('mergeEnrichment applied to the cache home prefers the cache, then the entry, then fetched', () => {
  const cached = { soundcloudSlug: 'cache-slug' };
  const entry = { soundcloudSlug: 'entry-slug', spotifyId: 'entry-spotify' };
  const fetched = { soundcloudSlug: 'fetched-slug', spotifyId: 'fetched-spotify', genres: ['house'] };
  const out = mergeEnrichment(cached, entry, fetched);
  assert.equal(out.soundcloudSlug, 'cache-slug'); // cache's own value wins
  assert.equal(out.spotifyId, 'entry-spotify'); // entry fills what cache lacked
  assert.deepEqual(out.genres, ['house']); // fetched fills what neither had
});

// ---------------------------------------------------------------------------
// normalizeName / pickMbHit — the MB-match sanity check
// ---------------------------------------------------------------------------

test('normalizeName is case- and diacritic-insensitive', () => {
  assert.equal(normalizeName('GRiZ'), normalizeName('griz'));
  assert.equal(normalizeName('Björk'), normalizeName('bjork'));
  assert.equal(normalizeName('  Excision  '), 'excision');
});

test('pickMbHit rejects hits below the score threshold', () => {
  assert.equal(pickMbHit([{ id: '1', name: 'GRiZ', score: 89 }], 'GRiZ'), null);
});

test('pickMbHit rejects a high-scoring hit whose name does not sanity-match (B2B/set-variant guard)', () => {
  const hits = [{ id: '1', name: 'GRiZ & Wreckno', score: 95 }];
  assert.equal(pickMbHit(hits, 'GRiZ'), null);
});

test('pickMbHit accepts a high-scoring, name-matching hit', () => {
  const hits = [{ id: '1', name: 'griz', score: 100 }];
  const hit = pickMbHit(hits, 'GRiZ');
  assert.equal(hit?.id, '1');
});

test('pickMbHit returns null with no hits', () => {
  assert.equal(pickMbHit([], 'GRiZ'), null);
  assert.equal(pickMbHit(undefined, 'GRiZ'), null);
});

// ---------------------------------------------------------------------------
// extractGenres / extractSoundcloudSlug / extractSpotifyId
// ---------------------------------------------------------------------------

test('extractGenres sorts by count desc, lowercases, dedupes, caps at 8', () => {
  const mbArtist = {
    genres: [
      { name: 'Future Bass', count: 3 },
      { name: 'DUBSTEP', count: 10 },
      { name: 'dubstep', count: 1 }, // dup after lowercasing
      { name: 'Funk', count: 5 },
    ],
  };
  assert.deepEqual(extractGenres(mbArtist), ['dubstep', 'funk', 'future bass']);
});

test('extractGenres falls back to tags when genres is empty', () => {
  const mbArtist = { genres: [], tags: [{ name: 'Bass House', count: 2 }] };
  assert.deepEqual(extractGenres(mbArtist), ['bass house']);
});

test('extractSoundcloudSlug pulls the slug from a url-rels relation', () => {
  const relations = [
    { url: { resource: 'https://twitter.com/griz' } },
    { url: { resource: 'https://soundcloud.com/griz' } },
  ];
  assert.equal(extractSoundcloudSlug(relations), 'griz');
});

test('extractSoundcloudSlug returns null with no soundcloud relation', () => {
  assert.equal(extractSoundcloudSlug([{ url: { resource: 'https://twitter.com/griz' } }]), null);
  assert.equal(extractSoundcloudSlug([]), null);
});

test('extractSpotifyId pulls the id from an open.spotify.com/artist/ url', () => {
  const relations = [{ url: { resource: 'https://open.spotify.com/artist/25oLRSUjqk4BurlUmVvDXR' } }];
  assert.equal(extractSpotifyId(relations), '25oLRSUjqk4BurlUmVvDXR');
});

// ---------------------------------------------------------------------------
// validateArtistExtras — the new optional festival-entry fields
// ---------------------------------------------------------------------------

test('validateArtistExtras accepts a fully-populated valid entry', () => {
  const artists = [{
    name: 'GRiZ',
    genres: ['future bass', 'bass house', 'disco'],
    soundcloudSlug: 'griz',
    spotifyId: '25oLRSUjqk4BurlUmVvDXR',
    youtubeQuery: 'GRiZ live set',
    youtubeVideoIds: ['a', 'b', 'c'],
    bandsintownId: 'griz',
  }];
  const r = validateArtistExtras(artists);
  assert.deepEqual(r.errors, []);
});

test('validateArtistExtras accepts entries with none of the new fields (unenriched festivals keep validating unchanged)', () => {
  const artists = [{ name: 'GRiZ', day: 'Day 2', stage: 'Lakeshore' }];
  const r = validateArtistExtras(artists);
  assert.deepEqual(r.errors, []);
});

test('validateArtistExtras rejects youtubeVideoIds over the cap of 4', () => {
  const artists = [{ name: 'GRiZ', youtubeVideoIds: ['a', 'b', 'c', 'd', 'e'] }];
  const r = validateArtistExtras(artists);
  assert.ok(r.errors.some((e) => /youtubeVideoIds/.test(e) && /cap/.test(e)), JSON.stringify(r.errors));
});

test('validateArtistExtras rejects genres over the cap of 8', () => {
  const artists = [{ name: 'GRiZ', genres: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }];
  const r = validateArtistExtras(artists);
  assert.ok(r.errors.some((e) => /genres/.test(e) && /cap/.test(e)), JSON.stringify(r.errors));
});

test('validateArtistExtras rejects empty-string array entries and empty-string scalar fields', () => {
  const artists = [{ name: 'GRiZ', genres: ['funk', ''], soundcloudSlug: '   ' }];
  const r = validateArtistExtras(artists);
  assert.ok(r.errors.some((e) => /genres\[1\]/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /soundcloudSlug/.test(e)), JSON.stringify(r.errors));
});

test('validateArtistExtras rejects a non-array genres field', () => {
  const artists = [{ name: 'GRiZ', genres: 'future bass' }];
  const r = validateArtistExtras(artists);
  assert.ok(r.errors.some((e) => /genres must be an array/.test(e)), JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// validateArtistOrder — the artists[] billing-vs-schedule declaration
// ---------------------------------------------------------------------------

test('validateArtistOrder accepts both enum values', () => {
  assert.deepEqual(validateArtistOrder({ artistOrder: 'billing' }).errors, []);
  assert.deepEqual(validateArtistOrder({ artistOrder: 'schedule' }).errors, []);
  assert.deepEqual(ARTIST_ORDERS, ['billing', 'schedule']);
});

test('validateArtistOrder accepts a festival with no artistOrder at all (absent = billing)', () => {
  assert.deepEqual(validateArtistOrder({ id: 'some-fest' }).errors, []);
});

test('validateArtistOrder rejects any value outside the two enum values', () => {
  for (const junk of ['Billing', 'SCHEDULE', 'chronological', '', 0, null, true, ['schedule'], {}]) {
    const r = validateArtistOrder({ artistOrder: junk });
    assert.ok(r.errors.length > 0, `expected an error for artistOrder=${JSON.stringify(junk)}`);
    assert.ok(/artistOrder must be one of/.test(r.errors[0]), JSON.stringify(r.errors));
  }
});

// ---------------------------------------------------------------------------
// validateGenresDoc — data/genres.json shape, and the shipped file itself
// ---------------------------------------------------------------------------

test('validateGenresDoc accepts a well-formed genre canon', () => {
  const doc = {
    canon: ['Dubstep', 'House', 'Pop'],
    synonyms: { 'brostep': 'Dubstep', 'chicago house': 'House' },
    suppress: ['electronic', 'edm'],
  };
  assert.deepEqual(validateGenresDoc(doc).errors, []);
});

test('validateGenresDoc rejects an empty or missing canon', () => {
  assert.ok(validateGenresDoc({ canon: [] }).errors.length > 0);
  assert.ok(validateGenresDoc({}).errors.length > 0);
});

test('validateGenresDoc rejects duplicate canon entries', () => {
  const r = validateGenresDoc({ canon: ['House', 'Pop', 'House'] });
  assert.ok(r.errors.some((e) => /duplicate/.test(e)), JSON.stringify(r.errors));
});

test('validateGenresDoc rejects a synonyms value that is not a canon entry', () => {
  const r = validateGenresDoc({ canon: ['House'], synonyms: { 'chicago house': 'House Music' } });
  assert.ok(r.errors.some((e) => /not a canon entry/.test(e)), JSON.stringify(r.errors));
});

test('validateGenresDoc rejects a suppress entry that shadows a canon entry (case-insensitive)', () => {
  const r = validateGenresDoc({ canon: ['House'], suppress: ['house'] });
  assert.ok(r.errors.some((e) => /collides with a canon entry/.test(e)), JSON.stringify(r.errors));
});

test('validateGenresDoc rejects a suppress entry that shadows a synonyms key', () => {
  const r = validateGenresDoc({ canon: ['House'], synonyms: { 'chicago house': 'House' }, suppress: ['chicago house'] });
  assert.ok(r.errors.some((e) => /collides with a synonyms key/.test(e)), JSON.stringify(r.errors));
});

test('validateGenresDoc rejects malformed shapes: canon as string, synonyms as array, suppress with non-string entries', () => {
  assert.ok(validateGenresDoc({ canon: 'House' }).errors.length > 0);
  assert.ok(validateGenresDoc({ canon: ['House'], synonyms: ['a'] }).errors.length > 0);
  assert.ok(validateGenresDoc({ canon: ['House'], suppress: [42] }).errors.length > 0);
  assert.ok(validateGenresDoc(null).errors.length > 0);
  assert.ok(validateGenresDoc([]).errors.length > 0);
});

test('the shipped data/genres.json passes validateGenresDoc', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'genres.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const r = validateGenresDoc(doc);
  assert.deepEqual(r.errors, []);
});
