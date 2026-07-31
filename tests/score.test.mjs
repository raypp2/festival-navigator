// Discovery scoring/reasons engine (build spec section 5). Fixture-driven:
// a small hand-built genre canon + artist set, independent of any shipped
// festival data (genre-tagged festival data is M1, not yet shipped) so this
// suite is self-contained and exercises exact copy + priority + edge cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS, BILLING_REASON_CUTOFF,
  buildTasteProfile, crewTasteProfile, scoreArtist, rankLineup, similarArtists,
} from '../js/discovery/score.js';

// canon ordered most-specific-first (per genres.js): Bass House is more
// specific than Trap, which is more specific than Future Bass, etc. Chosen
// so a couple of fixture artists land on interesting primary/secondary
// splits (see similarArtists tests below).
const CANON = {
  canon: ['Bass House', 'Trap', 'Future Bass', 'Techno', 'House', 'Disco', 'Ambient'],
  synonyms: {},
  suppress: [],
};

// Genre metadata for artists referenced in picks/passes (buildTasteProfile /
// crewTasteProfile look artists up here to canonicalize their tags).
const ARTISTS_BY_NAME = {
  'Must Artist': { name: 'Must Artist', genres: ['Bass House'] },
  'Crew Must Artist': { name: 'Crew Must Artist', genres: ['Trap'] },
  'Crew Popular Artist': { name: 'Crew Popular Artist', genres: ['House'] },
  'Pass One': { name: 'Pass One', genres: ['Ambient'] },
  'Pass Two': { name: 'Pass Two', genres: ['Ambient'] },
};

// picksFor-shaped: {artist: {person: level}}. Includes my (Me) one must plus
// crew activity used across several tests below.
const PICKS = {
  'Must Artist': { Me: 4 },
  'Crew Must Artist': { Drew: 4 },
  'Crew Popular Artist': { Drew: 2, Pega: 2 },
  'Priority Test Artist': { Drew: 4 },
  'Crew Over Billing Artist': { Drew: 4 },
};

// passesFor-shaped: {artist: {person: {ts}}}. Just my own pass on one artist.
const PASSES = {
  'Passed Artist': { Me: { ts: '2026-01-01T00:00:00.000Z' } },
};

const PROFILE = buildTasteProfile({
  picks: PICKS, passes: PASSES, artistsByName: ARTISTS_BY_NAME, canonData: CANON, person: 'Me',
});

// ---- reason copy: EXACT match to the normative patterns ---------------------------

test('taste reason: exact copy "shares {genre} with {n} of your musts"', () => {
  const artist = { name: 'Taste Match', genres: ['Bass House'] };
  const { reason } = scoreArtist({
    artist, index: 10, total: 50, profile: PROFILE, picks: {}, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'taste', text: 'shares Bass House with 1 of your musts' });
});

test('crew reason (single must): exact copy "{name} has this as a must"', () => {
  const artist = { name: 'Crew Must Artist', genres: ['Trap'] };
  const { reason } = scoreArtist({
    artist, index: 10, total: 50, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'crew', text: 'Drew has this as a must' });
});

test('crew reason (n crewmates, no musts): exact copy "{n} of the crew picked"', () => {
  const artist = { name: 'Crew Popular Artist', genres: ['House'] };
  const { reason } = scoreArtist({
    artist, index: 10, total: 50, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'crew', text: '2 of the crew picked' });
});

test('billing reason: "headlining" at index 0', () => {
  const artist = { name: 'Blank Filler', genres: [] };
  const { reason } = scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: {}, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'billing', text: 'headlining' });
});

test('billing reason: "#{n} on the bill" (1-based)', () => {
  const artist = { name: 'Blank Filler', genres: [] };
  const { reason } = scoreArtist({
    artist, index: 4, total: 50, profile: PROFILE, picks: {}, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'billing', text: '#5 on the bill' });
});

// ---- priority: taste > crew > billing ----------------------------------------------

test('priority: taste wins over crew AND billing when all three apply', () => {
  // Shares Bass House with my must (taste), Drew has it as a must (crew),
  // AND it sits at index 0 (would be "headlining"). Taste must win.
  const artist = { name: 'Priority Test Artist', genres: ['Bass House'] };
  const { reason } = scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.equal(reason.type, 'taste');
  assert.equal(reason.text, 'shares Bass House with 1 of your musts');
});

test('priority: crew wins over billing when no taste signal applies', () => {
  // No genre overlap with my musts (Techno vs my only must's Bass House),
  // Drew has it as a must (crew), and it sits at index 0 ("headlining").
  // Crew must win over billing.
  const artist = { name: 'Crew Over Billing Artist', genres: ['Techno'] };
  const { reason } = scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(reason, { type: 'crew', text: 'Drew has this as a must' });
});

// ---- billing cutoff -----------------------------------------------------------------

test('billing cutoff: last reason-bearing index is BILLING_REASON_CUTOFF - 1', () => {
  assert.equal(BILLING_REASON_CUTOFF, 20);
  const artist = { name: 'Blank Filler', genres: [] };
  const atCutoffEdge = scoreArtist({
    artist, index: BILLING_REASON_CUTOFF - 1, total: 100, profile: PROFILE, picks: {}, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(atCutoffEdge.reason, { type: 'billing', text: `#${BILLING_REASON_CUTOFF} on the bill` });
});

test('billing cutoff: index >= cutoff with no other signal -> reason null (still ranks)', () => {
  const artist = { name: 'Blank Filler', genres: [] };
  const past = scoreArtist({
    artist, index: BILLING_REASON_CUTOFF, total: 100, profile: PROFILE, picks: {}, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.equal(past.reason, null);
  assert.equal(typeof past.score, 'number');
  assert.ok(Number.isFinite(past.score));
});

// ---- my pass excludes the artist -----------------------------------------------------

test('my pass excludes the artist from recommendation: reason null, passed true', () => {
  // Would otherwise taste-match (Bass House) AND sit at index 0 (headlining)
  // — the pass must override both.
  const artist = { name: 'Passed Artist', genres: ['Bass House'] };
  const result = scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: {}, passes: PASSES, me: 'Me', canonData: CANON,
  });
  assert.equal(result.reason, null);
  assert.equal(result.passed, true);
});

test('a tombstoned (removed) pass does not exclude the artist', () => {
  const removedPasses = { 'Passed Artist': { Me: { ts: '2026-01-01T00:00:00.000Z', removed: true } } };
  const artist = { name: 'Passed Artist', genres: ['Bass House'] };
  const result = scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: {}, passes: removedPasses, me: 'Me', canonData: CANON,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.reason, { type: 'taste', text: 'shares Bass House with 1 of your musts' });
});

// ---- pass-genre down-weighting -------------------------------------------------------

test('pass-genre down-weighting: >=2 passes sharing a genre push its weight negative', () => {
  const passesAmbient = {
    'Pass One': { Me: { ts: '2026-01-01T00:00:00.000Z' } },
    'Pass Two': { Me: { ts: '2026-01-01T00:00:00.000Z' } },
  };
  const base = buildTasteProfile({
    picks: {}, passes: {}, artistsByName: ARTISTS_BY_NAME, canonData: CANON, person: 'Me',
  });
  const downweighted = buildTasteProfile({
    picks: {}, passes: passesAmbient, artistsByName: ARTISTS_BY_NAME, canonData: CANON, person: 'Me',
  });
  assert.equal(base.genreWeights.Ambient, undefined);
  assert.equal(downweighted.genreWeights.Ambient, -WEIGHTS.passGenrePenalty);
});

test('pass-genre down-weighting changes ranking (rankLineup, not just the raw weight)', () => {
  // Ambient Candidate out-bills Neutral Candidate (index 0 vs 1), so with no
  // taste signal it should rank first on billing alone. Once I've passed on
  // two Ambient artists, the down-weighted Ambient affinity should be enough
  // to flip the order.
  const lineup = [
    { name: 'Ambient Candidate', genres: ['Ambient'] },
    { name: 'Neutral Candidate', genres: [] },
    { name: 'Pass One', genres: ['Ambient'] },
    { name: 'Pass Two', genres: ['Ambient'] },
  ];
  const passesAmbient = {
    'Pass One': { Me: { ts: '2026-01-01T00:00:00.000Z' } },
    'Pass Two': { Me: { ts: '2026-01-01T00:00:00.000Z' } },
  };

  const baseRanked = rankLineup({ artists: lineup, picks: {}, passes: {}, me: 'Me', canonData: CANON });
  const baseNames = baseRanked.map((r) => r.name);
  assert.ok(baseNames.indexOf('Ambient Candidate') < baseNames.indexOf('Neutral Candidate'));

  const downRanked = rankLineup({ artists: lineup, picks: {}, passes: passesAmbient, me: 'Me', canonData: CANON });
  const downNames = downRanked.map((r) => r.name);
  assert.ok(downNames.indexOf('Neutral Candidate') < downNames.indexOf('Ambient Candidate'),
    'down-weighting Ambient should flip Neutral ahead of Ambient Candidate');
});

// ---- cold start: affinity 0, billing carries, purely from the math ------------------

test('cold start (zero picks, zero passes): ranks by billing, billing reasons throughout', () => {
  const lineup = Array.from({ length: 5 }, (_, i) => ({ name: `Cold Artist ${i}`, genres: [] }));
  const ranked = rankLineup({ artists: lineup, picks: {}, passes: {}, me: 'Me', canonData: CANON });

  assert.deepEqual(ranked.map((r) => r.name), lineup.map((a) => a.name), 'order falls out of billing alone');
  assert.deepEqual(ranked[0].reason, { type: 'billing', text: 'headlining' });
  assert.deepEqual(ranked[1].reason, { type: 'billing', text: '#2 on the bill' });
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].score < ranked[i - 1].score, 'score strictly decreases with billing position');
  }
});

// ---- crewTasteProfile: seeds from everyone but excludePerson ------------------------

test('crewTasteProfile seeds a useful profile and honors excludePerson', () => {
  const picks = {
    'Crew Must Artist': { Drew: 4 },
    'Crew Popular Artist': { Drew: 2, Pega: 2 },
    'Must Artist': { Me: 4 }, // mine — must NOT leak into a crew seed that excludes me
  };
  const profile = crewTasteProfile({
    picks, artistsByName: ARTISTS_BY_NAME, canonData: CANON, excludePerson: 'Me',
  });
  assert.equal(profile.genreWeights.Trap, 4); // Drew's must, full weight at level 4
  assert.equal(profile.genreWeights.House, 4); // Drew(2) + Pega(2), non-must picks
  assert.equal(profile.genreWeights['Bass House'], undefined, 'my own must must not leak in');
  assert.equal(profile.mustGenreCounts.Trap, 1);
  assert.equal(profile.mustGenreCounts.House, undefined, 'level-2 picks are not musts');
});

// ---- similarArtists -------------------------------------------------------------------

const SIMILAR_ARTISTS = [
  { name: 'Target Artist', genres: ['Bass House', 'Future Bass'] }, // primary Bass House, secondary [Future Bass]
  { name: 'Primary Match', genres: ['Bass House'] },                // shares target's PRIMARY -> double
  { name: 'Secondary Match', genres: ['Trap', 'Future Bass'] },     // primary Trap, secondary [Future Bass] -> shares only as secondary/secondary
  { name: 'No Genres', genres: [] },
  { name: 'Unrelated', genres: ['Techno'] },
  { name: 'Primary Match Late', genres: ['Bass House'] },
  { name: 'Extra Match', genres: ['Bass House'] },
  { name: 'Extra Match 2', genres: ['Bass House'] },
];

test('similarArtists: shared primary counts double vs a secondary-only match', () => {
  const results = similarArtists({ name: 'Target Artist', artists: SIMILAR_ARTISTS, canonData: CANON, limit: 8 });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName['Primary Match'].score, 2);
  assert.equal(byName['Primary Match'].sharedGenre, 'Bass House');
  assert.equal(byName['Secondary Match'].score, 1);
  assert.equal(byName['Secondary Match'].sharedGenre, 'Future Bass');
  assert.ok(byName['Primary Match'].score > byName['Secondary Match'].score);
});

test('similarArtists: excludes itself, excludes genre-less artists on either side, unrelated genres never match', () => {
  const results = similarArtists({ name: 'Target Artist', artists: SIMILAR_ARTISTS, canonData: CANON, limit: 8 });
  const names = results.map((r) => r.name);
  assert.ok(!names.includes('Target Artist'));
  assert.ok(!names.includes('No Genres'));
  assert.ok(!names.includes('Unrelated'));

  assert.deepEqual(similarArtists({ name: 'No Genres', artists: SIMILAR_ARTISTS, canonData: CANON }), []);
  assert.deepEqual(similarArtists({ name: 'Nonexistent Artist', artists: SIMILAR_ARTISTS, canonData: CANON }), []);
});

test('similarArtists: ties tie-break by billing index, respects limit', () => {
  const top4 = similarArtists({ name: 'Target Artist', artists: SIMILAR_ARTISTS, canonData: CANON, limit: 4 });
  assert.deepEqual(top4.map((r) => r.name), ['Primary Match', 'Primary Match Late', 'Extra Match', 'Extra Match 2']);

  const top2 = similarArtists({ name: 'Target Artist', artists: SIMILAR_ARTISTS, canonData: CANON, limit: 2 });
  assert.deepEqual(top2.map((r) => r.name), ['Primary Match', 'Primary Match Late']);
});

// ---- determinism ---------------------------------------------------------------------

test('determinism: same input twice -> identical rankLineup output', () => {
  const lineup = [
    { name: 'Priority Test Artist', genres: ['Bass House'] },
    { name: 'Crew Over Billing Artist', genres: ['Techno'] },
    { name: 'Crew Popular Artist', genres: ['House'] },
    { name: 'Passed Artist', genres: ['Bass House'] },
    { name: 'Blank Filler', genres: [] },
  ];
  const run = () => rankLineup({ artists: lineup, picks: PICKS, passes: PASSES, me: 'Me', canonData: CANON });
  assert.deepEqual(run(), run());
});

test('determinism: same input twice -> identical scoreArtist output', () => {
  const artist = { name: 'Priority Test Artist', genres: ['Bass House'] };
  const run = () => scoreArtist({
    artist, index: 0, total: 50, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
  });
  assert.deepEqual(run(), run());
});
