// Discovery scoring/reasons engine (build spec section 5). Fixture-driven:
// a small hand-built genre canon + artist set, independent of any shipped
// festival data (genre-tagged festival data is M1, not yet shipped) so this
// suite is self-contained and exercises exact copy + priority + edge cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS, BILLING_REASON_CUTOFF,
  buildTasteProfile, crewTasteProfile, scoreArtist, rankLineup, similarArtists,
  derivePopularity,
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

// ---- derivePopularity: schedule-derived billing prior for artistOrder:'schedule' festivals ----
// Bug being fixed: score.js used to treat artists[] array position as
// billing order everywhere. That's wrong for festivals whose artists[] is
// printed in SCHEDULE order (openers first, headliners last) — the billing
// prior inverted, cold start dealt openers first, and "#n on the bill"
// ribbons went to the wrong artists. derivePopularity() reads the actual
// per-day set times instead: headliners play LAST and LONGEST.

test('derivePopularity: a late + long set outranks an early + short one', () => {
  const fest = {
    artists: [{ name: 'Early Short' }, { name: 'Late Long' }],
    days: {
      'Day 1': {
        stages: ['Main'],
        artists: [
          { name: 'Early Short', stage: 'Main', time: '1:00 PM - 1:30 PM' },
          { name: 'Late Long', stage: 'Main', time: '11:00 PM - 1:00 AM' },
        ],
      },
    },
  };
  const pop = derivePopularity(fest);
  assert.ok(pop.get('Late Long') > pop.get('Early Short'));
  assert.equal(pop.get('Early Short'), 0);
  assert.equal(pop.get('Late Long'), 1);
});

test('derivePopularity: a cross-midnight set (12:30 AM on "Day 1") counts as LATE, not early', () => {
  // If AM times were read as literal small clock minutes instead of
  // js/time.js's after-midnight semantics, the 12:30 AM headliner would
  // score as the EARLIEST set of the day instead of the latest.
  const fest = {
    artists: [{ name: 'Afternoon Opener' }, { name: 'Midnight Headliner' }],
    days: {
      'Day 1': {
        stages: ['Main'],
        artists: [
          { name: 'Afternoon Opener', stage: 'Main', time: '1:00 PM - 2:00 PM' },
          { name: 'Midnight Headliner', stage: 'Main', time: '12:30 AM - 1:30 AM' },
        ],
      },
    },
  };
  const pop = derivePopularity(fest);
  assert.ok(pop.get('Midnight Headliner') > pop.get('Afternoon Opener'),
    'the 12:30 AM set must score as later, not earlier, than the 1 PM set on the same printed day');
  assert.equal(pop.get('Afternoon Opener'), 0);
  assert.equal(pop.get('Midnight Headliner'), 1);
});

test('derivePopularity: a multi-set artist takes their max set, not their last or their sum', () => {
  const fest = {
    artists: [{ name: 'Multi Artist' }, { name: 'Single Late' }],
    days: {
      'Day 1': {
        stages: ['Main'],
        artists: [{ name: 'Multi Artist', stage: 'Main', time: '1:00 PM - 1:10 PM' }], // tiny raw
      },
      'Day 2': {
        stages: ['Main'],
        artists: [
          { name: 'Multi Artist', stage: 'Main', time: '11:00 PM - 1:00 AM' }, // big raw
          { name: 'Single Late', stage: 'Main', time: '1:00 PM - 1:15 PM' }, // this day's baseline (tiny raw)
        ],
      },
      'Day 3': {
        stages: ['Main'],
        artists: [{ name: 'Multi Artist', stage: 'Main', time: '1:00 PM - 1:10 PM' }], // tiny raw again, and LAST seen
      },
    },
  };
  const pop = derivePopularity(fest);
  // Multi Artist's best set (Day 2) is the global max raw -> normalizes to 1.
  // If the implementation took the last-seen set instead of the max, this
  // would come back as Day 3's tiny value instead.
  assert.equal(pop.get('Multi Artist'), 1);
  assert.equal(pop.get('Single Late'), 0);
});

test('derivePopularity: an artist in artists[] with no printed set gets a low floor, not zero', () => {
  const fest = {
    artists: [
      { name: 'S1' }, { name: 'S2' }, { name: 'S3' }, { name: 'S4' }, { name: 'S5' },
      { name: 'Ghost Artist' },
    ],
    days: {
      'Day 1': {
        stages: ['Main'],
        artists: [
          { name: 'S1', stage: 'Main', time: '1:00 PM - 1:10 PM' },
          { name: 'S2', stage: 'Main', time: '3:00 PM - 3:30 PM' },
          { name: 'S3', stage: 'Main', time: '6:00 PM - 7:00 PM' },
          { name: 'S4', stage: 'Main', time: '9:00 PM - 10:30 PM' },
          { name: 'S5', stage: 'Main', time: '11:30 PM - 1:00 AM' },
        ],
      },
    },
  };
  const pop = derivePopularity(fest);
  const ghost = pop.get('Ghost Artist');
  assert.ok(ghost > 0, 'unscheduled artist must not be floored to zero -- it exists');
  assert.ok(ghost < pop.get('S2'), 'floor sits below the lowest ACTUAL scheduled set, not among real signal');
  // 10th percentile (linear interpolation, p=0.10 over 5 sorted normalized
  // values: idx = 0.4 -> between sorted[0]=0 and sorted[1]=3600/56700).
  const expectedFloor = (0 + ((3600 / 56700) - 0) * 0.4);
  assert.ok(Math.abs(ghost - expectedFloor) < 1e-9, `expected floor ~= ${expectedFloor}, got ${ghost}`);
});

test('derivePopularity is a pure function: same fest twice -> identical Map contents', () => {
  const fest = {
    artists: [{ name: 'A' }, { name: 'B' }],
    days: {
      'Day 1': {
        stages: ['Main'],
        artists: [
          { name: 'A', stage: 'Main', time: '1:00 PM - 1:30 PM' },
          { name: 'B', stage: 'Main', time: '11:00 PM - 1:00 AM' },
        ],
      },
    },
  };
  assert.deepEqual([...derivePopularity(fest)], [...derivePopularity(fest)]);
});

// ---- order:'schedule' ranking: popularity replaces the billing prior, reason copy changes ----

const SCHEDULE_LINEUP = ['A', 'B', 'C', 'D', 'E'].map((n) => ({ name: n, genres: [] }));
// Deliberately NOT in descending array-position order -- proves the score
// comes from popularity, not index, once order:'schedule' is set.
const SCHEDULE_POPULARITY = new Map([
  ['A', 0.9], ['B', 0.8], ['C', 0.7], ['D', 0.5], ['E', 0.1],
]);

test('order:"schedule": billing prior comes from popularity, never from array index -- numeric "#n on the bill" is never emitted', () => {
  const ranked = rankLineup({
    artists: SCHEDULE_LINEUP, picks: {}, passes: {}, me: 'Me', canonData: CANON,
    order: 'schedule', popularity: SCHEDULE_POPULARITY,
  });
  assert.deepEqual(ranked.map((r) => r.name), ['A', 'B', 'C', 'D', 'E'], 'ranks by popularity, matching array order here only incidentally');
  for (const r of ranked) {
    if (r.reason) assert.ok(!/^#\d+ on the bill$/.test(r.reason.text), `must never emit numeric billing copy, got: ${JSON.stringify(r.reason)}`);
  }
});

test('order:"schedule": "headlining" is emitted only for the top 3 by derived popularity', () => {
  const ranked = rankLineup({
    artists: SCHEDULE_LINEUP, picks: {}, passes: {}, me: 'Me', canonData: CANON,
    order: 'schedule', popularity: SCHEDULE_POPULARITY,
  });
  const byName = Object.fromEntries(ranked.map((r) => [r.name, r]));
  assert.deepEqual(byName.A.reason, { type: 'billing', text: 'headlining' });
  assert.deepEqual(byName.B.reason, { type: 'billing', text: 'headlining' });
  assert.deepEqual(byName.C.reason, { type: 'billing', text: 'headlining' });
  assert.equal(byName.D.reason, null);
  assert.equal(byName.E.reason, null);
});

test('order:"schedule": array position is irrelevant to the "headlining" gate -- a low-index, low-popularity artist gets no reason; a high-index, high-popularity artist does', () => {
  const lowIndexLowPop = scoreArtist({
    artist: { name: 'E', genres: [] }, index: 0, total: 5, profile: PROFILE,
    picks: {}, passes: {}, me: 'Me', canonData: CANON, order: 'schedule', popularity: SCHEDULE_POPULARITY,
  });
  assert.equal(lowIndexLowPop.reason, null, 'index 0 would be "headlining" under billing order, but E is not top-3 by popularity');

  const highIndexHighPop = scoreArtist({
    artist: { name: 'A', genres: [] }, index: 4, total: 5, profile: PROFILE,
    picks: {}, passes: {}, me: 'Me', canonData: CANON, order: 'schedule', popularity: SCHEDULE_POPULARITY,
  });
  assert.deepEqual(highIndexHighPop.reason, { type: 'billing', text: 'headlining' });
});

test('order:"schedule": taste and crew reasons are unaffected (still outrank billing/popularity copy)', () => {
  const artist = { name: 'Priority Test Artist', genres: ['Bass House'] };
  const { reason } = scoreArtist({
    artist, index: 0, total: 5, profile: PROFILE, picks: PICKS, passes: {}, me: 'Me', canonData: CANON,
    order: 'schedule', popularity: SCHEDULE_POPULARITY,
  });
  assert.equal(reason.type, 'taste');
  assert.equal(reason.text, 'shares Bass House with 1 of your musts');
});

// ---- order:'billing' (default/explicit) is byte-for-byte unchanged ----

test('order:"billing" explicit param produces identical output to omitting order/popularity entirely', () => {
  const lineup = [
    { name: 'Priority Test Artist', genres: ['Bass House'] },
    { name: 'Crew Over Billing Artist', genres: ['Techno'] },
    { name: 'Crew Popular Artist', genres: ['House'] },
    { name: 'Passed Artist', genres: ['Bass House'] },
    { name: 'Blank Filler', genres: [] },
  ];
  const withDefaults = rankLineup({ artists: lineup, picks: PICKS, passes: PASSES, me: 'Me', canonData: CANON });
  const withExplicitBilling = rankLineup({
    artists: lineup, picks: PICKS, passes: PASSES, me: 'Me', canonData: CANON,
    order: 'billing', popularity: SCHEDULE_POPULARITY, // popularity must be IGNORED under billing order
  });
  assert.deepEqual(withDefaults, withExplicitBilling);
});
