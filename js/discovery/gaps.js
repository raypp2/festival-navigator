// Schedule assist — gaps & clashes engine (Discovery M6, build spec section 7.4,
// frames 2b/5d). Pure functions only — no DOM, no fetch, no Date.now(). Callers
// (js/discovery/my-day.js, the gap facet in filter.js) pass a day's computed sets
// (js/time.js computeDayArtists output — startMin/endMin already resolved,
// cross-midnight aware) plus doc-derived picks/passes; this module never reaches
// into a doc itself.
//
// Three jobs, all pure:
//   dayPlan       — which of a day's sets are MINE (level >= 1), sorted by time.
//   findGaps      — open windows between my marked sets (or one whole-day gap
//                    when nothing is marked yet). Slivers under 45 min are
//                    dropped — walking a festival ground takes real time.
//   findClashes   — groups of my marked sets that overlap in time, any stage
//                    (this is a DIFFERENT consumer than js/overlap.js's
//                    same-stage lane math — CONF-1 keeps that module untouched;
//                    a clash here means "I can't be in two places at once",
//                    which has nothing to do with which stage column a set
//                    renders in).
//   gapCandidates — artists actually playing inside a given gap window that I
//                    haven't decided on yet, ordered by score.js's rankLineup
//                    output (the caller's ranking, not re-derived here).
//
// Cross-midnight: computeDayArtists already resolves startMin/endMin as
// after-midnight minutes (a 12:30 AM set sorts past 11:59 PM, not before
// 9:00 AM) — every function here consumes those minutes directly and never
// re-parses a time string or touches Date.

const MIN_GAP_MINUTES = 45; // walking exists
const MIN_OVERLAP_MINUTES = 30; // "actually playing within the gap", not a 5-min sliver at the edge

// ---- time labels (absMinToLabel in js/time.js drops minutes — ":00" only —
// which is fine for the hour-marker rail but not for gap windows like 4:30) --
function clockParts(absMin) {
  const m = ((absMin % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  let hr = h % 12; if (hr === 0) hr = 12;
  return { hr, mm, period };
}

// "4:30" — no meridiem, for compact chip labels ("San Holo · 4:30").
export function clockLabel(absMin) {
  const { hr, mm } = clockParts(absMin);
  return `${hr}:${String(mm).padStart(2, '0')}`;
}

// "4:00 – 6:00 PM" — start meridiem is dropped when it matches the end's
// (frame 2b/5d copy), shown when it differs (e.g. an 11:45 PM – 1:15 AM gap).
export function windowLabel(startMin, endMin) {
  const s = clockParts(startMin);
  const e = clockParts(endMin);
  const startStr = s.period === e.period
    ? clockLabel(startMin)
    : `${clockLabel(startMin)} ${s.period}`;
  return `${startStr} – ${clockLabel(endMin)} ${e.period}`;
}

// Rough duration copy for the desktop rail ("2 hrs free").
export function durationLabel(startMin, endMin) {
  const mins = Math.max(0, endMin - startMin);
  const hrs = mins / 60;
  const rounded = Math.round(hrs * 2) / 2; // nearest half hour
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} hr${rounded === 1 ? '' : 's'}`;
}

// ---- dayPlan ------------------------------------------------------------------
// My marked sets (level >= 1) for a day, sorted chronologically. Consumes
// computeDayArtists output directly — never reparses a.time.
export function dayPlan({ dayArtists, picks, me }) {
  const out = [];
  for (const a of dayArtists || []) {
    const level = (picks?.[a.name] || {})[me] || 0;
    if (level < 1) continue;
    out.push({ name: a.name, stage: a.stage, startMin: a.startMin, endMin: a.endMin, level });
  }
  out.sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin);
  return out;
}

// The day's overall span (earliest set start, latest set end) across EVERY
// set that day — not just marked ones. This is what a "nothing marked yet"
// whole-day gap spans, and what findGaps needs as its dayBounds argument.
export function computeDayBounds(dayArtists) {
  if (!dayArtists || !dayArtists.length) return null;
  let startMin = Infinity;
  let endMin = -Infinity;
  for (const a of dayArtists) {
    startMin = Math.min(startMin, a.startMin);
    endMin = Math.max(endMin, a.endMin);
  }
  return { startMin, endMin };
}

// ---- findGaps -------------------------------------------------------------------
// Merge my marked sets into occupied blocks (overlapping/clashing sets count
// as one block — there's no "gap" between two sets I've double-booked myself
// into), then report the open windows between consecutive blocks. Nothing
// marked yet -> one whole-day gap spanning dayBounds. Slivers under
// MIN_GAP_MINUTES are dropped.
function mergeBlocks(plan) {
  const sorted = [...plan].sort((a, b) => a.startMin - b.startMin);
  const blocks = [];
  for (const s of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && s.startMin < last.endMin) {
      last.endMin = Math.max(last.endMin, s.endMin);
    } else {
      blocks.push({ startMin: s.startMin, endMin: s.endMin });
    }
  }
  return blocks;
}

function pushGap(gaps, startMin, endMin) {
  if (endMin - startMin >= MIN_GAP_MINUTES) {
    gaps.push({ startMin, endMin, label: windowLabel(startMin, endMin) });
  }
}

export function findGaps(plan, dayBounds) {
  if (!dayBounds) return [];
  const blocks = mergeBlocks(plan || []);
  const gaps = [];
  if (!blocks.length) {
    pushGap(gaps, dayBounds.startMin, dayBounds.endMin);
    return gaps;
  }
  for (let i = 0; i < blocks.length - 1; i++) {
    pushGap(gaps, blocks[i].endMin, blocks[i + 1].startMin);
  }
  return gaps;
}

// ---- findClashes ----------------------------------------------------------------
// Groups of 2+ of my marked sets that overlap in time, any stage (sweep-line
// clustering — deliberately independent of js/overlap.js's same-stage lane
// math, a different consumer answering a different question). Severity is
// 'musts' when 2+ members of the group are level 4 (frame 2b's "⚡ Clash · 2 of
// your musts"), else 'picks'.
export function findClashes(plan) {
  // A clash is a set of sets that ALL overlap each other — not a chain of
  // pairwise overlaps. The difference is not academic: A 10:00-11:00,
  // B 10:45-12:00, C 11:30-13:00 chains into one group of three, and then the
  // app asks you to choose between A and C, which never overlap at all and can
  // both be seen comfortably. That is one conflict presented as a bigger one,
  // and it pushes people to drop an artist they never needed to drop.
  //
  // These are intervals, so the maximal groups are exactly "everything playing
  // at some instant", and it is enough to test the instant each set STARTS —
  // any group that all overlap share at least one start. Groups that turn out
  // to be contained in a larger one are dropped, so three mutually overlapping
  // sets stay a single group of three rather than becoming three pairs.
  //
  // O(n^2) on a DAY'S marked sets, which is a handful.
  const sorted = [...plan].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const byKey = new Map();
  for (const s of sorted) {
    const at = s.startMin;
    // filter preserves `sorted` order, so a group is time-ordered and its key
    // is stable — decide.js indexes into this output from a router key.
    const group = sorted.filter((o) => o.startMin <= at && o.endMin > at);
    if (group.length < 2) continue;
    const key = group.map((o) => o.name).join('\u0000');
    if (!byKey.has(key)) byKey.set(key, group);
  }
  const all = [...byKey.values()];
  const maximal = all.filter(
    (g) => !all.some((h) => h !== g && h.length > g.length && g.every((x) => h.includes(x))),
  );
  return maximal.map((sets) => {
    const musts = sets.filter((s) => s.level === 4).length;
    return { sets, severity: musts >= 2 ? 'musts' : 'picks' };
  });
}

// ---- gapCandidates --------------------------------------------------------------
// Artists actually playing WITHIN a gap window (set overlaps the gap by
// MIN_OVERLAP_MINUTES+) that I haven't decided on (no active pick, no active
// pass), ordered by the caller's `ranked` scores (score.js's rankLineup
// output — never re-derived here). `limit` defaults generously for the
// desktop rail; my-day.js caps to 3 for the mobile chip row itself.
export function gapCandidates({ gap, dayArtists, ranked, me, picks, passes, limit = 20 }) {
  const scoreByName = new Map((ranked || []).map((r) => [r.name, r.score]));
  const out = [];
  for (const a of dayArtists || []) {
    const overlapStart = Math.max(a.startMin, gap.startMin);
    const overlapEnd = Math.min(a.endMin, gap.endMin);
    if (overlapEnd - overlapStart < MIN_OVERLAP_MINUTES) continue;

    const level = (picks?.[a.name] || {})[me] || 0;
    if (level >= 1) continue;
    const passLeaf = (passes?.[a.name] || {})[me];
    if (passLeaf) continue;

    out.push({
      name: a.name,
      stage: a.stage,
      startMin: a.startMin,
      endMin: a.endMin,
      score: scoreByName.has(a.name) ? scoreByName.get(a.name) : -Infinity,
    });
  }
  out.sort((x, y) => y.score - x.score || x.startMin - y.startMin);
  return out.slice(0, limit);
}
