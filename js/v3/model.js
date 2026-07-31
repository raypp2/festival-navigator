// v4 doc semantics — version-aware reads, the one-shot v3->v4 migration
// overlay, and note helpers. Pure functions (node --test: tests/v3-model.test.mjs).
//
// Level semantics:
//   v4 docs: 0 cleared, 1-3 picked (alpha .5/.75/1), 4 must.
//   v3 docs: 0 cleared, 1 Nice, 2 Highlight, 3 "Must See".
// The LABELS carry meaning across versions, not the alphas: legacy 3 IS the
// new must. Read mapping is 1->1, 2->2, 3->4; nothing else changes.
// A v3 doc is upgraded ONCE, SERVER-SIDE (api/crew.js ?op=migrate): one
// atomic UPDATE maps every legacy leaf and stamps v=4 together. Clients
// cannot write v at all — a client-computed overlay could go stale between
// read and merge, and a bare stamp would corrupt legacy musts (Codex P2
// gate, findings 1 + 4). Clients just call the op when they see v3.
//
// LEGACY_MAP passes 4 through: a v4-semantics write can land on a not-yet-
// migrated doc in the migrate-race window, and reading it as 0 would eat
// the pick.

const LEGACY_MAP = { 0: 0, 1: 1, 2: 2, 3: 4, 4: 4 };

export function docVersion(doc) {
  return doc && doc.v === 4 ? 4 : 3;
}

export function readLevel(doc, raw) {
  if (!Number.isInteger(raw)) return 0;
  return docVersion(doc) === 4 ? raw : (LEGACY_MAP[raw] ?? 0);
}

// Normalized picks for a festival: {artist: {person: level}} in v4 semantics,
// zero-level tombstones dropped.
export function picksFor(doc, fid) {
  const sels = doc?.festivals?.[fid]?.selections || {};
  const out = {};
  for (const [artist, byPerson] of Object.entries(sels)) {
    for (const [person, raw] of Object.entries(byPerson)) {
      const level = readLevel(doc, raw);
      if (level < 1) continue;
      (out[artist] = out[artist] || {})[person] = level;
    }
  }
  return out;
}

// True when a client should request the server-side migrate op before its
// first v4-semantics write.
export function needsMigration(doc) {
  return docVersion(doc) !== 4;
}

// The crew's "home" festival by evidence: where the picks live. Used to
// backfill meta.inviteFestId on pre-v3.1 docs (FLOW-1) — links already out
// in group chats predate the stamp, so the app heals its own doc from the
// strongest crew-level signal instead of any one device's view.
export function busiestFestival(doc, knownIds) {
  const known = new Set(knownIds || []);
  let best = null;
  let bestCount = 0;
  for (const fid of Object.keys(doc?.festivals || {})) {
    if (!known.has(fid)) continue;
    const count = Object.keys(picksFor(doc, fid)).length;
    if (count > bestCount) { best = fid; bestCount = count; }
  }
  return best; // null when no fest has picks — caller falls back
}

// One stage-column order for the whole festival: the union of every day's
// stages, in first-appearance order. Each day's stages array is authored
// independently in the festival data, so the same physical stage used to sit
// in a different column on different days — scrolling down a stage silently
// changed stages under you. Days missing a stage render an empty column;
// that's the graceful case, not an error.
export function canonicalStages(fest) {
  const out = [];
  for (const day of Object.keys(fest?.days || {})) {
    for (const s of fest.days[day].stages || []) if (!out.includes(s)) out.push(s);
  }
  return out;
}

// The tap cycle: 0 -> 1 -> 2 -> 3 -> 4(must) -> 0 (the 5th tap clears; the
// UI wraps this in an undo toast — design open question 1, decided).
export function nextTapLevel(current) {
  const c = Number.isInteger(current) ? current : 0;
  return c >= 4 ? 0 : c + 1;
}

// ---- passes & recs (Discovery, spec §3.4) ---------------------------------------
// Storage: festivals[fid].passes[artist][person] = {ts, removed?}
//          festivals[fid].recs[artist][forPerson] = {by, ts, removed?}
// Same keyed-object/tombstone discipline as selections and notes (never
// arrays); unlike notes' one-way `deleted`, the tombstone here is a plain
// `removed: boolean` so a pass can be reversed (validatePasses/validateRecs,
// api/_lib/crew-shared.mjs). Active leaf = present && removed !== true.

// Passes for a festival: {artist: {person: {ts}}}, tombstoned leaves dropped.
export function passesFor(doc, fid) {
  const passes = doc?.festivals?.[fid]?.passes || {};
  const out = {};
  for (const [artist, byPerson] of Object.entries(passes)) {
    for (const [person, leaf] of Object.entries(byPerson)) {
      if (!leaf || leaf.removed === true) continue;
      (out[artist] = out[artist] || {})[person] = { ts: leaf.ts };
    }
  }
  return out;
}

export function isPassed(doc, fid, artist, person) {
  const leaf = doc?.festivals?.[fid]?.passes?.[artist]?.[person];
  return !!leaf && leaf.removed !== true;
}

// Recs for a festival: {artist: {forPerson: {by, ts}}}, tombstoned leaves dropped.
export function recsFor(doc, fid) {
  const recs = doc?.festivals?.[fid]?.recs || {};
  const out = {};
  for (const [artist, byForPerson] of Object.entries(recs)) {
    for (const [forPerson, leaf] of Object.entries(byForPerson)) {
      if (!leaf || leaf.removed === true) continue;
      (out[artist] = out[artist] || {})[forPerson] = { by: leaf.by, ts: leaf.ts };
    }
  }
  return out;
}

// One person's first-open queue: every active rec addressed to them, newest
// recommendation first (spec §3.4 / DISCOVERY_SPEC.md §5 "Sam sees a queue
// on first open").
export function recsForPerson(doc, fid, person) {
  const out = [];
  for (const [artist, byForPerson] of Object.entries(recsFor(doc, fid))) {
    const leaf = byForPerson[person];
    if (leaf) out.push({ artist, by: leaf.by, ts: leaf.ts });
  }
  return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

// Resolved pick/pass/must state for one (artist, person).
//
// RESOLUTION RULE: passes and picks are meant to be mutually exclusive
// (spec §3.4), but that exclusion is client-enforced only (js/state.js
// applyPass/applyPickLevel) — the server accepts both leaves independently
// (crew-shared.mjs), so two concurrent writes (a pass from one device, a
// pick from another, both racing the same merge) can briefly leave BOTH an
// active pass and a pick level >= 1 on the same (artist, person). Pick
// leaves are bare integers with no timestamp of their own, so there is no
// newer-ts tiebreak available between the two. When both are present, the
// PICK wins: positive intent is explicit and should stay visible, while the
// latent pass sits inert until the next local write (a future pass or pick
// on this artist) heals it via the tombstone dance in state.js.
export function effectiveState(doc, fid, artist, person) {
  const raw = doc?.festivals?.[fid]?.selections?.[artist]?.[person];
  const level = readLevel(doc, raw);
  if (level >= 4) return 'must';
  if (level >= 1) return 'picked';
  if (isPassed(doc, fid, artist, person)) return 'passed';
  return 'none';
}

// ---- notes ---------------------------------------------------------------------
// Storage: festivals[fid].notes[scope][targetId][noteId] = {author, ts, text,
// deleted?} for scope 'artist'|'day'; scope 'fest' skips targetId.

export function makeNoteId(author, ts, nonce) {
  const n = nonce ?? Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  // Keep within NOTE_ID_RE: letters, digits, |_.- only.
  const safeAuthor = String(author).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 20) || 'anon';
  const safeTs = String(Date.parse(ts) || 0);
  return `${safeAuthor}.${safeTs}.${n}`;
}

function noteMap(doc, fid, scope, target) {
  const notes = doc?.festivals?.[fid]?.notes?.[scope];
  if (!notes) return {};
  return (scope === 'fest' ? notes : notes[target]) || {};
}

// Sorted oldest-first (conversation order); tombstones dropped.
export function notesFor(doc, fid, scope, target) {
  return Object.entries(noteMap(doc, fid, scope, target))
    .filter(([, n]) => n && n.deleted !== true && typeof n.text === 'string')
    .map(([id, n]) => ({ id, ...n }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export function noteCount(doc, fid, scope, target) {
  return notesFor(doc, fid, scope, target).length;
}

// Total across all scopes for the wall's Notes chip.
export function totalNoteCount(doc, fid) {
  const notes = doc?.festivals?.[fid]?.notes || {};
  let n = notesFor(doc, fid, 'fest').length;
  for (const scope of ['artist', 'day']) {
    for (const target of Object.keys(notes[scope] || {})) n += notesFor(doc, fid, scope, target).length;
  }
  return n;
}

// Merge payload for adding one note. Consumed by the merge-safety tests
// (tests/v3-model.test.mjs) as the canonical note-write shape; the live
// write path (state.recordNote) builds the same shape against two roots.
export function noteOverlay(fid, scope, target, note, id) {
  const noteId = id ?? makeNoteId(note.author, note.ts);
  const leaf = { [noteId]: note };
  const scoped = scope === 'fest' ? leaf : { [target]: leaf };
  return { festivals: { [fid]: { notes: { [scope]: scoped } } } };
}

// ---- pins (device-local, never synced) -------------------------------------------
// pins[fid] = [noteId, ...] in localStorage key fn_pins_v1.

export function togglePin(pins, fid, noteId) {
  const list = new Set(pins?.[fid] || []);
  if (list.has(noteId)) list.delete(noteId);
  else list.add(noteId);
  return { ...pins, [fid]: [...list] };
}

export function sortWithPins(notes, pinnedIds) {
  const pinned = new Set(pinnedIds || []);
  return [...notes].sort((a, b) => {
    const pa = pinned.has(a.id) ? 0 : 1;
    const pb = pinned.has(b.id) ? 0 : 1;
    return pa - pb || Date.parse(a.ts) - Date.parse(b.ts);
  });
}

// ---- fests × circles × you (2026-07-14) -------------------------------------------
// The landing lists FESTIVALS, not crews: every (crew, fest) pair the device
// knows becomes one row, ordered by the festival index (curated ≈ date
// order). Two circles at one fest = two rows — honest, unfused until the
// merged-board arc. A crew whose doc was never cached can't name its fests
// and falls back to a single crew-named row (fid null).

export function landingPairs(crews, docFor, festIndex) {
  // Date order, not index order (Kevin, 2026-07-14: "sort by and show dates").
  // Upcoming fests soonest-first; archived ones sink below, most recent
  // first, muted by the renderer. startsOn is an ISO string, so plain string
  // comparison sorts it — no Date parsing, no clock needed (archived status,
  // not "today", decides what counts as past).
  const meta = new Map(festIndex.map((f) => [f.id, f]));
  const sortKey = (fid) => {
    const m = fid ? meta.get(fid) : null;
    if (!m || !m.startsOn) return { past: 2, key: '' };           // uncached / custom: last
    if (m.status === 'archived') return { past: 1, key: m.startsOn }; // past, recent first
    return { past: 0, key: m.startsOn };                          // upcoming, soonest first
  };
  const pairs = [];
  for (const c of crews) {
    const doc = docFor(c.token);
    const fids = doc ? Object.keys(doc.festivals || {}) : [];
    const people = doc
      ? Object.entries(doc.people || {}).filter(([, p]) => p && !p.removed).map(([n, p]) => ({ name: n, p }))
      : [];
    if (!fids.length) { pairs.push({ token: c.token, fid: null, crewName: c.name || '', people, past: false }); continue; }
    for (const fid of fids) {
      pairs.push({ token: c.token, fid, crewName: c.name || '', people, past: (meta.get(fid) || {}).status === 'archived' });
    }
  }
  return pairs.sort((a, b) => {
    const ka = sortKey(a.fid);
    const kb = sortKey(b.fid);
    if (ka.past !== kb.past) return ka.past - kb.past;
    if (ka.past === 1) return kb.key.localeCompare(ka.key); // past: most recent first
    return ka.key.localeCompare(kb.key);
  });
}

// Label a fest id the landing may not have metadata for: catalog fests come
// from the index; crew-private (AI-added) fests only load inside their crew,
// so their id prettifies ("amish-acl-2026" -> "Amish Acl 2026") rather than
// rendering as a slug.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function festLabelFor(fid, festIndex) {
  const meta = festIndex.find((f) => f.id === fid);
  if (meta) {
    // "Sep '26" beside the name — "I just want to know WHEN when looking at
    // lists" (Kevin, 2026-07-14). Month from startsOn, year as already styled.
    const month = meta.startsOn ? MONTHS[Number(meta.startsOn.slice(5, 7)) - 1] : '';
    const year = [month, meta.year || ''].filter(Boolean).join(' ');
    return { name: meta.name, year, accent: meta.accent || null };
  }
  const pretty = String(fid).split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return { name: pretty, year: '', accent: null };
}

// The + Add sheet's one-tap picker: active people from every OTHER crew this
// device knows — your recurring humans (Drew, Pega, Rosten) one tap away
// instead of retyped. Deduped case-insensitively; excludes people already
// active here and yourself. First-seen order.
export function otherFestPeople(currentToken, crews, docFor, currentPeople, meName) {
  const here = new Set(Object.entries(currentPeople || {})
    .filter(([, p]) => p && !p.removed).map(([n]) => n.toLowerCase()));
  if (meName) here.add(String(meName).toLowerCase());
  const seen = new Set();
  const out = [];
  for (const c of crews) {
    if (c.token === currentToken) continue;
    const doc = docFor(c.token);
    for (const [n, p] of Object.entries((doc && doc.people) || {})) {
      if (!p || p.removed) continue;
      const key = n.toLowerCase();
      if (here.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: n, fromCrew: c.name || '' });
    }
  }
  return out;
}
