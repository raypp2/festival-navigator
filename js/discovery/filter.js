// Discover pool filter — pure functions only (build spec section 7.2). No
// DOM, no fetch, no localStorage: deck.js owns persistence (one localStorage
// key per festival, device-local — filter/sort state is a VIEWER preference
// and is never written to the shared crew doc) and UI; this module only
// decides which artists are in the pool and in what order.
//
// applyFilters ranks the WHOLE lineup via score.js's rankLineup first (so
// billing position and reasons are computed against the real bill, not a
// pre-narrowed subset), then filters and reorders that ranked list per the
// facets. The deck deals straight from the returned array — every entry
// already carries the one-reason-or-null this festival's rankLineup produced.
import { rankLineup, derivePopularity } from './score.js';
import { canonicalize } from './genres.js';
import { computeDayArtists } from '../time.js';
import { dayPlan, computeDayBounds, findGaps, gapCandidates } from './gaps.js';

// One shape, one place — deck.js and the filter sheet both start from this.
export const DEFAULT_FACETS = {
  sort: 'foryou',      // 'foryou' | 'popularity' | 'az'
  show: 'undecided',   // 'undecided' | 'passed' | 'all'
  genres: [],           // canonical genre names, OR'd
  day: 'all',           // 'all' or an exact day token
  crewPicked: false,    // someone else picked, I haven't decided
  hasLiveSet: false,    // any sample source resolved
  gap: false,           // playing inside one of MY open gaps (timed festivals only — build spec 7.4/M6)
};

function withDefaults(facets) {
  return { ...DEFAULT_FACETS, ...(facets || {}), genres: (facets && facets.genres) || [] };
}

function indexByName(artists) {
  const out = {};
  for (const a of artists || []) if (a && a.name) out[a.name] = a;
  return out;
}

// A raw day string can be a combination ("Saturday & Sunday" — build spec
// META-1 / wall.js's splitDays handles the same shape for the timetable).
// Filtering by a single day must still match a multi-day artist.
function dayTokens(dayStr) {
  if (!dayStr) return [];
  return String(dayStr).split(/\s*[&+/]\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
}

function hasLiveSetSource(meta) {
  return !!(
    (Array.isArray(meta?.youtubeVideoIds) && meta.youtubeVideoIds.length)
    || meta?.youtubeQuery
    || meta?.soundcloudSlug
    || meta?.spotifyId
  );
}

// Number of individual selections currently narrowing the pool — the deck
// header's filter badge (frame 2a: 2 genre chips selected -> badge "2").
// Sort is a priority lever, not a narrowing facet, so it never counts.
export function activeFacetCount(facets) {
  const f = withDefaults(facets);
  let n = 0;
  if (f.show !== 'undecided') n++;
  n += f.genres.length;
  if (f.day !== 'all') n++;
  if (f.crewPicked) n++;
  if (f.hasLiveSet) n++;
  if (f.gap) n++;
  return n;
}

// Every artist name playing inside any of MY current open gaps, across every
// scheduled day (js/discovery/gaps.js's own findGaps/gapCandidates — reused,
// not re-derived: the "undecided by me" exclusion and the 30-min overlap
// floor both come straight from gapCandidates). `ranked` is intentionally
// omitted (empty) — this only needs SET MEMBERSHIP, not a score ordering.
function gapArtistNames(fest, picks, passes, me) {
  const names = new Set();
  for (const day of Object.keys(fest?.days || {})) {
    const dayData = fest.days[day];
    if (!dayData?.artists?.length) continue;
    const dayArtists = computeDayArtists(dayData);
    const plan = dayPlan({ dayArtists, picks, me });
    const bounds = computeDayBounds(dayArtists);
    for (const gap of findGaps(plan, bounds)) {
      const cands = gapCandidates({ gap, dayArtists, ranked: [], me, picks, passes, limit: Infinity });
      for (const c of cands) names.add(c.name);
    }
  }
  return names;
}

// Canonical genres actually present in this pool, most-specific-first (same
// order as data/genres.json's canon) — the filter sheet's chip list.
export function availableGenres(artists, canonData) {
  const set = new Set();
  for (const a of artists || []) {
    const { primary, secondary } = canonicalize(a?.genres, canonData);
    if (primary) set.add(primary);
    for (const g of secondary || []) set.add(g);
  }
  const canon = Array.isArray(canonData?.canon) ? canonData.canon : [];
  return [...set].sort((a, b) => {
    const ia = canon.indexOf(a); const ib = canon.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });
}

// Day tokens actually present on this festival's artists, first-appearance
// order — the filter sheet's Day row (only rendered when this is non-empty).
export function availableDays(artists) {
  const seen = [];
  for (const a of artists || []) {
    for (const d of dayTokens(a?.day)) if (!seen.includes(d)) seen.push(d);
  }
  return seen;
}

// applyFilters(artists, picks, passes, facets, me, canonData, fest) -> pool
// artists = festival artists[] (billing order); picks = picksFor output
// ({artist:{person:level}}); passes = passesFor output
// ({artist:{person:{ts}}}); pool = ranked entries
// ({name, index, score, reason, passed, primary, secondary}), filtered and
// ordered per facets.sort. `passed` on each entry means "I passed this",
// straight from score.js (same `me`) — no re-derivation needed. `fest` is
// optional and only consulted when facets.gap is set (it needs fest.days —
// the gap facet is meaningless, and the caller keeps it hidden, on a
// lineup-only festival with no `fest.days` to compute against).
export function applyFilters(artists, picks, passes, facets, me, canonData, fest) {
  const f = withDefaults(facets);
  const list = Array.isArray(artists) ? artists : [];
  const byName = indexByName(list);
  // Schedule-ordered festivals (artistOrder:"schedule") replace the array-
  // position billing prior with derived popularity — same wiring as
  // wall.js's forYouRanked; rankLineup suppresses "#n on the bill" copy.
  const order = fest?.artistOrder || 'billing';
  const ranked = rankLineup({
    artists: list, picks, passes, me, canonData,
    order, popularity: order === 'schedule' ? derivePopularity(fest) : undefined,
  });

  const genreSet = new Set(f.genres);
  const gapNames = (f.gap && fest?.days && Object.keys(fest.days).length)
    ? gapArtistNames(fest, picks, passes, me)
    : null;

  const filtered = ranked.filter((r) => {
    const meta = byName[r.name];
    if (!meta) return false;

    const myLevel = (picks?.[r.name] || {})[me] || 0;

    if (f.show === 'undecided' && (myLevel >= 1 || r.passed)) return false;
    if (f.show === 'passed' && !r.passed) return false;
    // 'all': no decision-state filter

    if (genreSet.size) {
      const candidateGenres = [r.primary, ...(r.secondary || [])].filter(Boolean);
      if (!candidateGenres.some((g) => genreSet.has(g))) return false;
    }

    if (f.day !== 'all' && !dayTokens(meta.day).includes(f.day)) return false;

    if (f.crewPicked) {
      const byPerson = picks?.[r.name] || {};
      const someoneElsePicked = Object.entries(byPerson).some(([p, lvl]) => p !== me && lvl >= 1);
      if (!someoneElsePicked) return false;
    }

    if (f.hasLiveSet && !hasLiveSetSource(meta)) return false;

    if (gapNames && !gapNames.has(r.name)) return false;

    return true;
  });

  if (f.sort === 'popularity') filtered.sort((a, b) => a.index - b.index);
  else if (f.sort === 'az') filtered.sort((a, b) => a.name.localeCompare(b.name));
  // 'foryou': ranked is already score-desc, and Array.prototype.filter
  // preserves that relative order.

  return filtered;
}
