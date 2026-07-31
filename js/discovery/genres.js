// Genre canonicalization (Discovery, spec section 4). Pure functions over
// data/genres.json — no fetch here except loadGenreCanon(), which mirrors the
// fetch style of js/festivals.js (absolute path, cached module-level).
//
// `canon` in data/genres.json is ordered MOST-specific first: that order IS
// the specificity ranking used to pick `primary` among a tag set's survivors.

const EMPTY_CANON = { canon: [], synonyms: {}, suppress: [] };

let cachedCanon = null; // successful loads only — a fetch failure is not cached, so a later call can retry

export async function loadGenreCanon() {
  if (cachedCanon) return cachedCanon;
  try {
    const res = await fetch('/data/genres.json');
    if (!res.ok) throw new Error('genre canon failed: ' + res.status);
    const data = await res.json();
    cachedCanon = data;
    return cachedCanon;
  } catch {
    // Offline or missing file is a state, not a fault — degrade to "no genres"
    // rather than crashing the caller.
    return EMPTY_CANON;
  }
}

// Map one raw tag to its canonical genre name, or null if it drops out
// (suppressed, unrecognized, or junk). Never throws.
function resolveTag(rawTag, canon, synonyms, suppress) {
  if (typeof rawTag !== 'string') return null;
  const norm = rawTag.trim().toLowerCase();
  if (!norm) return null;
  if (suppress.includes(norm)) return null;
  const canonMatch = canon.find((c) => c.toLowerCase() === norm);
  if (canonMatch) return canonMatch;
  if (Object.prototype.hasOwnProperty.call(synonyms, norm)) return synonyms[norm];
  return null;
}

// canonicalize(rawTags, canonData) -> { primary, secondary }
// primary = surviving canon genre earliest in canonData.canon (most specific);
// secondary = the rest, in canon order, deduped, primary excluded.
export function canonicalize(rawTags, canonData) {
  const empty = { primary: null, secondary: [] };
  if (!Array.isArray(rawTags) || rawTags.length === 0) return empty;

  const canon = Array.isArray(canonData?.canon) ? canonData.canon : [];
  const synonyms = canonData?.synonyms && typeof canonData.synonyms === 'object' ? canonData.synonyms : {};
  const suppress = Array.isArray(canonData?.suppress) ? canonData.suppress : [];

  const survivors = new Set();
  for (const rawTag of rawTags) {
    const resolved = resolveTag(rawTag, canon, synonyms, suppress);
    if (resolved) survivors.add(resolved);
  }
  if (survivors.size === 0) return empty;

  // Rank by position in canon (specificity order); unknown entries (shouldn't
  // happen — synonyms/canon are curated together) sort last, stably.
  const ranked = [...survivors].sort((a, b) => {
    const ia = canon.indexOf(a);
    const ib = canon.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });

  const [primary, ...rest] = ranked;
  return { primary, secondary: rest };
}

// genreSubLine(rawTags, canonData) -> display string for the card/page
// sub-line, or null when there's no primary. Caller renders the "No genres
// tagged yet" copy in that case — this module never bakes in UI copy.
export function genreSubLine(rawTags, canonData) {
  const { primary, secondary } = canonicalize(rawTags, canonData);
  if (!primary) return null;
  if (secondary.length > 0) return `${primary} · ${secondary[0]}`;
  return primary;
}
