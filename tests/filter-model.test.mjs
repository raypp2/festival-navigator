// Discover pool filter model (js/discovery/filter.js) — pure functions, no
// DOM. Facet-by-facet, combinations, zero-result, has-live-set, and
// crew-picked semantics (build spec section 7.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, activeFacetCount, availableGenres, availableDays, DEFAULT_FACETS } from '../js/discovery/filter.js';

const CANON = {
  canon: ['Riddim', 'Dubstep', 'Bass House', 'Future Bass', 'Trance'],
  synonyms: {},
  suppress: ['electronic', 'edm'],
};

const ARTISTS = [
  { name: 'Skrillex', day: 'Day 1', genres: ['dubstep', 'riddim'], soundcloudSlug: 'skrillex' },
  { name: 'GRiZ', day: 'Day 1', genres: ['future bass', 'bass house'], spotifyId: 'griz-id' },
  { name: 'Wooli', day: 'Day 2', genres: ['riddim'] },
  { name: 'NoGenre', day: 'Day 2 & Day 3', genres: [] },
  { name: 'Excision', day: 'Day 3', genres: ['dubstep'], youtubeQuery: 'Excision live set' },
];

const ME = 'Ray';
const names = (pool) => pool.map((e) => e.name);

test('default facets (Show=Undecided) excludes my picks and passes', () => {
  const picks = { GRiZ: { Ray: 2 } };
  const passes = { Wooli: { Ray: { ts: '2026-07-01T00:00:00.000Z' } } };
  const pool = applyFilters(ARTISTS, picks, passes, DEFAULT_FACETS, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Excision', 'NoGenre', 'Skrillex']);
});

test('Show=passed returns only artists I passed', () => {
  const passes = { Wooli: { Ray: { ts: '2026-07-01T00:00:00.000Z' } } };
  const pool = applyFilters(ARTISTS, {}, passes, { ...DEFAULT_FACETS, show: 'passed' }, ME, CANON);
  assert.deepEqual(names(pool), ['Wooli']);
});

test('Show=all includes everyone regardless of my decision', () => {
  const picks = { GRiZ: { Ray: 4 } };
  const passes = { Wooli: { Ray: { ts: '2026-07-01T00:00:00.000Z' } } };
  const pool = applyFilters(ARTISTS, picks, passes, { ...DEFAULT_FACETS, show: 'all' }, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Excision', 'GRiZ', 'NoGenre', 'Skrillex', 'Wooli']);
});

test('genre facet ORs across selected canonical genres (primary or secondary)', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', genres: ['Riddim'] };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Skrillex', 'Wooli']);
});

test('genre facet with two genres still ORs (not ANDs)', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', genres: ['Riddim', 'Bass House'] };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['GRiZ', 'Skrillex', 'Wooli']);
});

test('day facet matches a single day and a combined day string ("Day 2 & Day 3")', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', day: 'Day 2' };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['NoGenre', 'Wooli']);
});

test('crewPicked: someone else picked, I have not decided — independent of whether I already decided elsewhere', () => {
  // Drew picked GRiZ (I'm undecided) and Excision (I already picked it too).
  const picks = { GRiZ: { Drew: 3 }, Excision: { Ray: 2, Drew: 1 } };
  const facets = { ...DEFAULT_FACETS, crewPicked: true }; // show stays 'undecided' (default)
  const pool = applyFilters(ARTISTS, picks, {}, facets, ME, CANON);
  // Excision is excluded by Show=Undecided (I already picked it), even though
  // Drew also picked it — crewPicked narrows further, it doesn't override Show.
  assert.deepEqual(names(pool), ['GRiZ']);
});

test('crewPicked with Show=all surfaces both, including ones I already decided', () => {
  const picks = { GRiZ: { Drew: 3 }, Excision: { Ray: 2, Drew: 1 } };
  const facets = { ...DEFAULT_FACETS, show: 'all', crewPicked: true };
  const pool = applyFilters(ARTISTS, picks, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Excision', 'GRiZ']);
});

test('hasLiveSet: any resolved sample source (youtube/soundcloud/spotify)', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', hasLiveSet: true };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Excision', 'GRiZ', 'Skrillex']);
});

test('combination: genre + hasLiveSet narrows to the intersection', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', genres: ['Dubstep'], hasLiveSet: true };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool).sort(), ['Excision', 'Skrillex']);
});

test('zero-result: an over-narrow combination returns an empty pool, never throws', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', genres: ['Trance'] };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(pool, []);
});

test('sort=popularity orders by billing index', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', sort: 'popularity' };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool), ['Skrillex', 'GRiZ', 'Wooli', 'NoGenre', 'Excision']);
});

test('sort=az orders alphabetically', () => {
  const facets = { ...DEFAULT_FACETS, show: 'all', sort: 'az' };
  const pool = applyFilters(ARTISTS, {}, {}, facets, ME, CANON);
  assert.deepEqual(names(pool), ['Excision', 'GRiZ', 'NoGenre', 'Skrillex', 'Wooli']);
});

test('sort=foryou (default) ranks a genre-affinity match above plain billing', () => {
  // My own must on Skrillex (canonical primary Riddim, secondary Dubstep)
  // seeds a taste profile weighted toward Riddim. Wooli (Riddim) and Excision
  // (Dubstep only) both pick up a taste reason from it, but Wooli's primary-
  // genre match outweighs Excision's secondary-genre one, so Wooli ranks
  // above both Excision and GRiZ (no genre overlap at all, billing-only).
  const picks = { Skrillex: { Ray: 4 } };
  const facets = { ...DEFAULT_FACETS, show: 'all' };
  const pool = applyFilters(ARTISTS, picks, {}, facets, ME, CANON);
  assert.equal(pool[0].name, 'Skrillex'); // I already must'd it — still ranks, still in the "plain list" under Show=all
  const order = names(pool);
  assert.ok(order.indexOf('Wooli') < order.indexOf('Excision'));
  assert.ok(order.indexOf('Excision') < order.indexOf('GRiZ'));
  const wooli = pool.find((e) => e.name === 'Wooli');
  const excision = pool.find((e) => e.name === 'Excision');
  assert.ok(wooli.reason && /riddim/i.test(wooli.reason.text));
  assert.ok(excision.reason && /dubstep/i.test(excision.reason.text));
});

test('activeFacetCount counts each individual selection, sort excluded', () => {
  assert.equal(activeFacetCount(DEFAULT_FACETS), 0);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, sort: 'az' }), 0);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, show: 'passed' }), 1);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, genres: ['Riddim', 'Dubstep'] }), 2);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, day: 'Day 1' }), 1);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, crewPicked: true }), 1);
  assert.equal(activeFacetCount({ ...DEFAULT_FACETS, hasLiveSet: true }), 1);
  assert.equal(activeFacetCount({
    ...DEFAULT_FACETS, show: 'all', genres: ['Riddim'], day: 'Day 1', crewPicked: true, hasLiveSet: true,
  }), 5);
});

test('availableGenres lists canonical genres present, most-specific-first', () => {
  assert.deepEqual(availableGenres(ARTISTS, CANON), ['Riddim', 'Dubstep', 'Bass House', 'Future Bass']);
});

test('availableDays lists day tokens present, splitting combined strings', () => {
  assert.deepEqual(availableDays(ARTISTS), ['Day 1', 'Day 2', 'Day 3']);
});

test('applyFilters never throws on artists missing genres/day entirely', () => {
  const bare = [{ name: 'Bare' }];
  const pool = applyFilters(bare, {}, {}, DEFAULT_FACETS, ME, CANON);
  assert.deepEqual(names(pool), ['Bare']);
});
