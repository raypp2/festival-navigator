// SPIKE — clash resolutions, device-local.
//
// A resolution records THE PLAN for a window of overlapping sets. It is
// deliberately NOT a pick level: pick level is taste ("how much do I want to
// see this"), and a resolution is intent ("what am I actually doing here").
// Conflating the two is what made the old chooseArtist demote everyone else to
// pick x1 — it said "I like them less" when the truth was "I like them the
// same, but one of them wins this slot", and the person was never told.
//
// Two kinds:
//   lead  — one artist is the plan, the rest stay as alternates
//   keep  — no lead; all of them stay and you sort it out on-site
//
// STORAGE IS DEVICE-LOCAL AND THAT IS A SPIKE DECISION, not a considered one.
// It reuses the shape of decide.js's existing clash dismissals so nothing
// touches the crew doc or the merge rules — the sharpest edge in this codebase
// — while the concept is still being judged. The cost is real and known: picks
// sync, plans do not, so a second device sees the window unresolved. If the
// idea survives testing, this is the first thing that has to move into the doc,
// and that is a schema question with multi-user consequences worth its own
// design pass.
//
// Keyed on day + the sorted artist names, exactly like the dismissal store, so
// a resolution survives a re-render but is correctly orphaned if the set of
// clashing artists changes — a different clash is a different question.
const LS_PREFIX = 'fp.clashPlan.';

function keyFor(day, names) {
  return `${day}|${[...names].sort().join('||')}`;
}
function loadAll(fid) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + fid) || '{}'); } catch { return {}; }
}
function saveAll(fid, all) {
  try { localStorage.setItem(LS_PREFIX + fid, JSON.stringify(all)); } catch { /* private mode / full */ }
}

// → { kind: 'lead', lead: '<name>' } | { kind: 'keep' } | null
export function getResolution(fid, day, names) {
  const r = loadAll(fid)[keyFor(day, names)];
  if (!r || !r.kind) return null;
  // A lead naming an artist who is no longer in this clash is stale — the
  // window changed under it, and guessing a replacement would be inventing a
  // decision nobody made.
  if (r.kind === 'lead' && !names.includes(r.lead)) return null;
  return r;
}

export function setResolution(fid, day, names, resolution) {
  const all = loadAll(fid);
  all[keyFor(day, names)] = resolution;
  saveAll(fid, all);
}

export function clearResolution(fid, day, names) {
  const all = loadAll(fid);
  delete all[keyFor(day, names)];
  saveAll(fid, all);
}
