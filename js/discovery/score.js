// Discovery scoring & reasons engine (build spec section 5; copy is normative
// per design/discovery-handoff/project/Discovery - Notes for Claude Code.md
// section 2). Pure functions only — no DOM, no fetch, no Date.now(). Callers
// (deck, For-you wall, artist page) pass festival artists + doc-derived picks
// and passes; this module never reaches into a doc itself.
//
// Determinism & the one-reason guarantee (both load-bearing, both tested):
// - Same input -> same output. No randomness, no wall-clock reads.
// - Every recommendation carries EXACTLY ONE reason (taste > crew > billing).
//   No producible reason -> reason: null. The artist still scores and ranks
//   (the "plain list"); it just isn't presented as a recommendation.

import { canonicalize } from './genres.js';
import { computeDayArtists } from '../time.js';

// Tuning lives here, in one place, per the build spec ("weights in one
// exported const so tuning is one edit"). Everything a caller might want to
// retune — including thresholds that read like "constants" — is a field
// here rather than a scattered literal.
export const WEIGHTS = {
  // How much a candidate's secondary canonical genre counts relative to its
  // primary, both when building a taste profile from picks and when scoring
  // a candidate against that profile. Symmetric on purpose: "weakly this
  // genre too" should count less on both sides of the dot product.
  secondaryGenreWeight: 0.5,

  // >= this many of my passes sharing a canonical genre triggers down-weighting.
  passGenreThreshold: 2,
  // Amount subtracted from that genre's weight in my profile once triggered.
  // Flat subtraction (not a multiplier) so a genre I've never picked but keep
  // passing on still ends up negative, not stuck at 0.
  passGenrePenalty: 3,

  // Crew-interest signal, per candidate: a crewmate's must counts more than
  // a crewmate's pick.
  crewMustWeight: 3,
  crewPickWeight: 1,

  // How the three signals combine into one score. Affinity dominates so a
  // strong taste match can outrank a deep-bill crew pick; billing is the
  // lightest signal — it's the backbone at cold start (nothing else to add)
  // but shouldn't drown out real signal once it exists.
  affinity: 4,
  crew: 2,
  billing: 1,
};

// A "#137 on the bill" ribbon persuades nobody — deep positions get no
// billing reason (they still get a billing SCORE contribution, just no text).
export const BILLING_REASON_CUTOFF = 20;

// ---- internal helpers -------------------------------------------------------------

function canonicalGenresOf(artist, canonData) {
  return canonicalize(artist?.genres, canonData);
}

// All canonical genres an artist carries, primary first (order matters for
// deterministic tie-breaks downstream: callers that walk this list and keep
// the first max they see effectively prefer primary over secondary).
function allGenres({ primary, secondary }) {
  return [primary, ...(secondary || [])].filter(Boolean);
}

// Accumulate one person's picks into a genre-weight map + must-genre counts.
// Shared by buildTasteProfile (one person) and crewTasteProfile (everyone
// but one person) so the two stay in lockstep.
function accumulatePicks({ picks, artistsByName, canonData, includePerson }) {
  const genreWeights = {};
  const mustGenreCounts = {};

  for (const [artistName, byPerson] of Object.entries(picks || {})) {
    const meta = artistsByName?.[artistName];
    if (!meta) continue;
    const genres = canonicalGenresOf(meta, canonData);
    const genreList = allGenres(genres);
    if (genreList.length === 0) continue;

    for (const [person, rawLevel] of Object.entries(byPerson || {})) {
      if (!includePerson(person)) continue;
      const level = Number.isInteger(rawLevel) ? rawLevel : 0;
      if (level < 1) continue;

      if (genres.primary) {
        genreWeights[genres.primary] = (genreWeights[genres.primary] || 0) + level;
      }
      for (const g of genres.secondary) {
        genreWeights[g] = (genreWeights[g] || 0) + level * WEIGHTS.secondaryGenreWeight;
      }

      if (level === 4) {
        for (const g of genreList) mustGenreCounts[g] = (mustGenreCounts[g] || 0) + 1;
      }
    }
  }

  return { genreWeights, mustGenreCounts };
}

function applyPassDownweighting({ genreWeights, passes, artistsByName, canonData, person }) {
  const passGenreArtists = {}; // genre -> Set(artistName), so repeats of the same artist don't double-count

  for (const [artistName, byPerson] of Object.entries(passes || {})) {
    const leaf = byPerson?.[person];
    if (!leaf || leaf.removed) continue;
    const meta = artistsByName?.[artistName];
    if (!meta) continue;
    const genreList = allGenres(canonicalGenresOf(meta, canonData));
    for (const g of genreList) {
      (passGenreArtists[g] = passGenreArtists[g] || new Set()).add(artistName);
    }
  }

  for (const [genre, artistSet] of Object.entries(passGenreArtists)) {
    if (artistSet.size >= WEIGHTS.passGenreThreshold) {
      genreWeights[genre] = (genreWeights[genre] || 0) - WEIGHTS.passGenrePenalty;
    }
  }
}

// Dot product of a candidate's own canonical genres against a genre-weight
// profile. Same primary/secondary weighting as profile-building, applied to
// the query side too, so the score is symmetric.
function affinityFor(genres, genreWeights) {
  let score = 0;
  if (genres.primary && genreWeights[genres.primary] != null) {
    score += genreWeights[genres.primary];
  }
  for (const g of genres.secondary) {
    if (genreWeights[g] != null) score += genreWeights[g] * WEIGHTS.secondaryGenreWeight;
  }
  return score;
}

// Crewmates (excluding me) who have any pick on this artist, split must vs.
// picked. Names sorted so the reason text is deterministic regardless of the
// doc's own key insertion order.
function crewSignal({ artistName, picks, me }) {
  const byPerson = picks?.[artistName] || {};
  const musts = [];
  const others = [];
  for (const [person, rawLevel] of Object.entries(byPerson)) {
    if (person === me) continue;
    const level = Number.isInteger(rawLevel) ? rawLevel : 0;
    if (level < 1) continue;
    if (level >= 4) musts.push(person);
    else others.push(person);
  }
  musts.sort();
  others.sort();
  return { musts, others };
}

function tasteReason(genres, mustGenreCounts) {
  const candidateGenres = allGenres(genres); // primary first
  let best = null;
  for (const g of candidateGenres) {
    const n = mustGenreCounts?.[g] || 0;
    if (n >= 1 && (!best || n > best.n)) best = { genre: g, n };
  }
  if (!best) return null;
  return { type: 'taste', text: `shares ${best.genre} with ${best.n} of your musts` };
}

function crewReason(crew) {
  // Exactly one crewmate at must level -> name them, regardless of anything
  // else going on for this artist. Two or more crewmates with any pick
  // (musts included, once there's more than one) -> the aggregate count.
  // A single non-must crewmate pick isn't enough signal for a reason on its
  // own (spec: crew reason needs a must, or >= 2 crewmates).
  if (crew.musts.length === 1) {
    return { type: 'crew', text: `${crew.musts[0]} has this as a must` };
  }
  const crewCount = crew.musts.length + crew.others.length;
  if (crewCount >= 2) {
    return { type: 'crew', text: `${crewCount} of the crew picked` };
  }
  return null;
}

function billingReason(index) {
  if (index === 0) return { type: 'billing', text: 'headlining' };
  if (index < BILLING_REASON_CUTOFF) return { type: 'billing', text: `#${index + 1} on the bill` };
  return null;
}

// order:'schedule' variant. A numeric bill position is a lie on a
// schedule-ordered festival (array position isn't billing), so it is NEVER
// emitted — only 'headlining', and only for the top 3 artists by DERIVED
// popularity (not array position).
function scheduleBillingReason(name, popularity) {
  if (!popularity) return null;
  const top = topPopularityNames(popularity, 3);
  if (top.has(name)) return { type: 'billing', text: 'headlining' };
  return null;
}

function indexByName(artists) {
  const out = {};
  for (const a of artists || []) if (a && a.name) out[a.name] = a;
  return out;
}

// Read one artist's prior out of a derivePopularity() result. Accepts either
// a Map (what derivePopularity returns) or a plain object (documented as an
// acceptable shape too), so callers that serialize/rebuild the prior aren't
// forced through a Map.
function popularityFor(popularity, name) {
  if (!popularity) return 0;
  if (typeof popularity.get === 'function') {
    const v = popularity.get(name);
    return typeof v === 'number' ? v : 0;
  }
  const v = popularity[name];
  return typeof v === 'number' ? v : 0;
}

// The top N artist names by derived popularity, for order:'schedule''s
// "headlining" gate (top 3 — see scheduleBillingReason). Ties keep whatever
// order the popularity map iterates in (Array#sort is stable), which for
// derivePopularity's own output is festival artists[] order — deterministic.
function topPopularityNames(popularity, n) {
  const entries = popularity && typeof popularity.entries === 'function'
    ? [...popularity.entries()]
    : Object.entries(popularity || {});
  const sorted = entries.slice().sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, n).map(([name]) => name));
}

// Linear interpolation percentile over an ascending-sorted array (p in [0,1]).
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

// ---- public API --------------------------------------------------------------------

// My genre-weight profile from what I've picked/musted, plus the internal
// must-genre-count table scoreArtist needs to write "N of your musts" text
// without re-deriving it from raw picks on every call. genreWeights is the
// field the spec names explicitly (recommend-ahead reuses it directly);
// mustGenreCounts rides along on the same object.
export function buildTasteProfile({ picks, passes, artistsByName, canonData, person }) {
  const { genreWeights, mustGenreCounts } = accumulatePicks({
    picks,
    artistsByName,
    canonData,
    includePerson: (p) => p === person,
  });
  applyPassDownweighting({ genreWeights, passes, artistsByName, canonData, person });
  return { genreWeights, mustGenreCounts };
}

// Same shape, seeded from EVERYONE's picks except excludePerson — the
// cold-start seed for a crew member with zero activity of their own
// (recommend-ahead; design notes section 2). No passes input: a person with
// no picks has no passes to down-weight by, by definition of "zero activity".
export function crewTasteProfile({ picks, artistsByName, canonData, excludePerson }) {
  return accumulatePicks({
    picks,
    artistsByName,
    canonData,
    includePerson: (p) => p !== excludePerson,
  });
}

// Derive a billing prior from the SCHEDULE rather than from artists[]
// position — for festivals whose artists[] is printed in schedule order
// (openers first, headliners last: `artistOrder: 'schedule'`, see
// scripts/validate-festivals.mjs) rather than billing order (headliners
// first, the default contract). The build spec's own observation is that
// headliners play LAST and LONGEST, so each set's raw weight is:
//
//   lateness (minutes from that day's earliest start, cross-midnight aware)
//   x length (minutes)
//
// via js/time.js's computeDayArtists (reused, not re-implemented, so AM/PM
// and cross-midnight parsing stay in one place). An artist with multiple
// sets takes their single best (max raw) set. Raw values are then min-max
// normalized to [0,1] across the whole schedule. Artists in artists[] but
// never seen in fest.days (no printed set time) get a low floor rather than
// 0 — they're on the lineup, just unscheduled — pinned at the 10th
// percentile of the scheduled distribution.
//
// Pure: reads only the fest object passed in, no fetch/DOM/Date.now.
export function derivePopularity(fest) {
  const days = fest && typeof fest.days === 'object' && fest.days ? fest.days : {};
  const rawByArtist = new Map(); // name -> best (max) raw lateness*length across all its sets

  for (const dayData of Object.values(days)) {
    if (!dayData || !Array.isArray(dayData.artists) || dayData.artists.length === 0) continue;
    let resolved;
    try { resolved = computeDayArtists(dayData); } catch { continue; }
    if (!resolved.length) continue;

    const dayStart = Math.min(...resolved.map((a) => a.startMin));
    for (const set of resolved) {
      const lateness = set.startMin - dayStart;
      const endMin = set.endMin != null ? set.endMin : set.startMin;
      const length = Math.max(0, endMin - set.startMin);
      const raw = lateness * length;
      const prev = rawByArtist.get(set.name);
      if (prev === undefined || raw > prev) rawByArtist.set(set.name, raw);
    }
  }

  const rawValues = [...rawByArtist.values()];
  const min = rawValues.length ? Math.min(...rawValues) : 0;
  const max = rawValues.length ? Math.max(...rawValues) : 0;
  const span = max - min;

  const normalized = new Map();
  for (const [name, raw] of rawByArtist) {
    // span === 0 (every scheduled set equally "late x long", or only one
    // set exists) -> no signal to rank by; park everyone at the midpoint
    // rather than an arbitrary 0 or 1.
    normalized.set(name, span > 0 ? (raw - min) / span : 0.5);
  }

  const sortedNormalized = [...normalized.values()].sort((a, b) => a - b);
  const floor = sortedNormalized.length ? percentile(sortedNormalized, 0.10) : 0;

  const priors = new Map();
  const artists = Array.isArray(fest?.artists) ? fest.artists : [];
  for (const a of artists) {
    if (!a || !a.name) continue;
    priors.set(a.name, normalized.has(a.name) ? normalized.get(a.name) : floor);
  }
  // Defensive: a scheduled set whose artist is somehow missing from
  // artists[] still gets its derived prior rather than silently vanishing.
  for (const [name, val] of normalized) {
    if (!priors.has(name)) priors.set(name, val);
  }

  return priors;
}

// Score + reason for one artist. `index`/`total` are this artist's position
// and the lineup length (billing order, never re-sorted — build spec 3.1).
// `order` ('billing' default | 'schedule') and `popularity` (a
// derivePopularity() Map/object) are optional — omitted, behavior is
// byte-for-byte the original billing-order scoring. order:'schedule'
// replaces the billing-position prior with the derived popularity prior for
// this artist, and swaps the billing reason: no numeric "#n on the bill"
// (array position isn't billing on these festivals), and 'headlining' only
// for the top 3 artists by derived popularity.
export function scoreArtist({
  artist, index, total, profile, picks, passes, me, canonData, order = 'billing', popularity,
}) {
  const name = artist?.name;
  const passLeaf = passes?.[name]?.[me];
  const passed = !!(passLeaf && !passLeaf.removed);

  const genres = canonicalGenresOf(artist, canonData);
  const genreWeights = profile?.genreWeights || {};
  const affinityScore = affinityFor(genres, genreWeights);

  const crew = crewSignal({ artistName: name, picks, me });
  const crewScore = crew.musts.length * WEIGHTS.crewMustWeight + crew.others.length * WEIGHTS.crewPickWeight;

  const billingScore = order === 'schedule'
    ? popularityFor(popularity, name)
    : (total > 0 ? (total - index) / total : 0);

  const score = WEIGHTS.affinity * affinityScore + WEIGHTS.crew * crewScore + WEIGHTS.billing * billingScore;

  // A pass excludes the artist from RECOMMENDATION (reason null) entirely —
  // it still scores/ranks (the "plain list"), and passed:true lets callers
  // sink or filter it.
  let reason = null;
  if (!passed) {
    reason = tasteReason(genres, profile?.mustGenreCounts)
      || crewReason(crew)
      || (order === 'schedule' ? scheduleBillingReason(name, popularity) : billingReason(index));
  }

  return { score, reason, passed };
}

// Rank a whole lineup. artists = the festival's artists[] (billing order by
// default; schedule order when the festival declares `artistOrder:
// 'schedule'` — pass order:'schedule' + a derivePopularity(fest) result in
// that case). picks = picksFor output ({artist:{person:level}}); passes =
// passesFor output shape ({artist:{person:{ts}}}).
export function rankLineup({ artists, picks, passes, me, canonData, order = 'billing', popularity }) {
  const list = Array.isArray(artists) ? artists : [];
  const total = list.length;
  const artistsByName = indexByName(list);
  const profile = buildTasteProfile({ picks, passes, artistsByName, canonData, person: me });

  const ranked = list.map((artist, index) => {
    const { score, reason, passed } = scoreArtist({
      artist, index, total, profile, picks, passes, me, canonData, order, popularity,
    });
    const { primary, secondary } = canonicalGenresOf(artist, canonData);
    return { name: artist.name, index, score, reason, passed, primary, secondary };
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked;
}

// Ranked "similar artists" for the artist page (5a/5b). Shared canonical
// genres, where a genre that's PRIMARY for either artist counts double a
// genre that's shared only as secondary-secondary. Tie-break: billing index.
// Excludes the artist itself; artists with no canonical genres never match
// (on either side).
export function similarArtists({ name, artists, canonData, limit = 4 }) {
  const list = Array.isArray(artists) ? artists : [];
  const targetIndex = list.findIndex((a) => a && a.name === name);
  if (targetIndex === -1) return [];

  const target = canonicalGenresOf(list[targetIndex], canonData);
  const targetGenreSet = new Set(allGenres(target));
  if (targetGenreSet.size === 0) return [];

  const results = [];
  list.forEach((artist, index) => {
    if (index === targetIndex) return;
    const genres = canonicalGenresOf(artist, canonData);
    const candidateGenres = allGenres(genres); // primary first
    if (candidateGenres.length === 0) return;

    let score = 0;
    let best = null; // strongest shared genre, primary-preferred via iteration order
    for (const g of candidateGenres) {
      if (!targetGenreSet.has(g)) continue;
      const points = (g === target.primary || g === genres.primary) ? 2 : 1;
      score += points;
      if (!best || points > best.points) best = { genre: g, points };
    }
    if (score === 0) return;

    results.push({
      name: artist.name, index, score, sharedGenre: best.genre,
      primary: genres.primary, secondary: genres.secondary,
    });
  });

  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return results.slice(0, limit);
}
