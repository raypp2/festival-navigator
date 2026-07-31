// App state for the ACTIVE crew: the crew document, the pendingChanges
// overlay that makes sync offline-safe, and festival data access.
//
// Crew doc shape (v3, mirrors api/_lib/crew-shared.mjs):
//   { v, meta:{name,createdAt}, spotify:{clientId?},
//     people:  {name: {color, removed?}},                  // crew-wide
//     festivals: {fid: {selections: {artist: {person: level}}}},
//     affinity: {person: {artist: {songs?, followed?}}} }  // crew-wide
import { deepMerge, subtractLeaves } from './merge.js';
import { computeDayArtists } from './time.js';
import { loadJSON, saveLS } from './util.js';
import { FESTIVALS, FESTIVAL_INDEX, defaultFestivalId } from './festivals.js';
import { readLevel, isPassed } from './v3/model.js';

export { FESTIVALS };

export const COLOR_PALETTE = [
  '239, 68, 68', '59, 130, 246', '34, 197, 94', '251, 191, 36',
  '168, 85, 247', '236, 72, 153', '249, 115, 22', '20, 184, 166',
  '99, 102, 241', '132, 204, 22', '244, 63, 94', '14, 165, 233'
];
export const opacities = [0.5, 0.75, 1.0]; // index = level-1

export const LS = {
  doc: (t) => `fn_crew_doc_v3_${t}`,
  pending: (t) => `fn_crew_pending_v3_${t}`,
  fest: (t) => `fn_crew_fest_v3_${t}`,
  geminiKey: 'geminiApiKey',
};

// ---- active crew context ----------------------------------------------------
let crewToken = null;
export let crewDoc = null;        // full crew document (remote truth + pending overlay)
export let pendingChanges = {};   // only locally-changed leaves not yet pushed
export let activeFestivalId = null;
export let currentDay = null;
export let selectedPerson = null;
let editSeq = 0; // bumped on every local edit; guards the push/clear race
const dayCache = {}; // `${fid}|${day}` -> computed artists

export function getCrewToken() { return crewToken; }
export function getEditSeq() { return editSeq; }
export function setCurrentDay(d) { currentDay = d; }
export function setSelectedPerson(p) { selectedPerson = p; }

// Load a crew into the active slot (from cache; sync refreshes it after).
// NOTE: callers must `await loadFestival(state.activeFestivalId)` before
// rendering — the index tells us the id is valid, not that data is loaded.
// `festHint` (optional) is the invite's festival context — from the share
// link's &f= param or the doc's meta.inviteFestId. It only fills the void on
// a device with no saved fest for this crew; a returning device keeps its own.
export function activateCrew(token, doc, festHint) {
  crewToken = token;
  crewDoc = doc || loadJSON(LS.doc(token), null) || { v: 3, meta: {}, spotify: {}, people: {}, festivals: {}, affinity: {} };
  pendingChanges = loadJSON(LS.pending(token), {});
  // Write a heal back to disk immediately: subtractLeaves can never match the
  // corrupted disk leaf against the healed pushed one, so without this the
  // stale blob survives every successful push and re-pushes on every boot.
  if (healPlaylistArtists(pendingChanges)) saveLS(LS.pending(token), JSON.stringify(pendingChanges));
  healPlaylistArtists(crewDoc); // rendered copy; persists via the normal paths
  crewDoc = deepMerge(crewDoc, pendingChanges);
  const savedFest = localStorage.getItem(LS.fest(token));
  const known = (id) => FESTIVAL_INDEX.some((f) => f.id === id);
  const hinted = (festHint && known(festHint)) ? festHint : null;
  activeFestivalId = (savedFest && known(savedFest)) ? savedFest : (hinted || defaultFestivalId());
  if (hinted && activeFestivalId === hinted) saveLS(LS.fest(token), hinted);
  currentDay = null;
  selectedPerson = null;
  Object.keys(dayCache).forEach((k) => delete dayCache[k]);
  ensureFestivalState(activeFestivalId);
}

export function setActiveFestivalId(fid) {
  activeFestivalId = fid;
  saveLS(LS.fest(crewToken), fid);
}

export function persist() { saveLS(LS.doc(crewToken), JSON.stringify(crewDoc)); }

// Merge with what's already on disk, never a blind overwrite: two tabs on the
// same crew each hold their own in-memory pendingChanges, and last-writer-
// wins on the whole blob silently dropped the other tab's un-pushed edits
// (sweep, 2026-07-12). With the merge, the residual loss window is only a tab
// closing in the ~1s between the OTHER tab's clearPending and its own push.
export function persistPending() {
  const onDisk = loadJSON(LS.pending(crewToken), {});
  saveLS(LS.pending(crewToken), JSON.stringify(deepMerge(onDisk, pendingChanges)));
}

// ---- accessors ---------------------------------------------------------------
export function fest() { return FESTIVALS[activeFestivalId]; }
export function crewName() { return (crewDoc.meta && crewDoc.meta.name) || 'Your crew'; }
export function people() { return crewDoc.people; }
export function selections() { return crewDoc.festivals[activeFestivalId].selections; }
export function affinityFor(person) { return (crewDoc.affinity || {})[person] || null; }

// Case-insensitive affinity lookup for renderers: lineup names and Spotify
// names sometimes differ in casing.
export function affinityLookup(person) {
  const aff = person ? affinityFor(person) : null;
  if (!aff) return null;
  const map = {};
  for (const [name, v] of Object.entries(aff)) map[name.toLowerCase()] = v;
  return map;
}
export function spotifyClientId() { return (crewDoc.spotify || {}).clientId || ''; }

// A removed person is tombstoned ({removed:true}) rather than deleted,
// so the removal can sync (deep-merge can't express a key deletion).
export function isActivePerson(p) { return !!p && !p.removed; }
export function activePeople() { return Object.entries(people()).filter(([, p]) => isActivePerson(p)); }

export function ensureFestivalState(fid) {
  if (!crewDoc.festivals[fid]) {
    crewDoc.festivals[fid] = { selections: {} };
    // Sync the membership, not just the local render: this write is what
    // makes "the crew has this festival" true for OTHER devices. Without it,
    // every added festival was a ghost only this device could see — The
    // Crew's server doc held one festival while Kevin's phone showed six
    // (live, 2026-07-13). An empty selections object merges as a key with no
    // leaves, which is exactly right.
    const pf = (pendingChanges.festivals = pendingChanges.festivals || {});
    pf[fid] = pf[fid] || { selections: {} };
    editSeq++; persistPending();
  }
  if (!crewDoc.festivals[fid].selections) crewDoc.festivals[fid].selections = {};
}

export function nextColor(peopleObj) {
  const used = new Set(Object.values(peopleObj).filter(p => !p.removed).map(p => p.color));
  const open = COLOR_PALETTE.find(c => !used.has(c));
  return open || COLOR_PALETTE[Object.keys(peopleObj).length % COLOR_PALETTE.length];
}

// ---- pending-change recorders (each also applies to the local doc) -----------
export function recordSelection(artist, person, level) {
  recordSelectionFor(activeFestivalId, artist, person, level);
}

// Same, but for an explicit festival (person removal clears picks crew-wide).
export function recordSelectionFor(fid, artist, person, level) {
  const f = (pendingChanges.festivals = pendingChanges.festivals || {});
  const entry = (f[fid] = f[fid] || {});
  const s = (entry.selections = entry.selections || {});
  (s[artist] = s[artist] || {})[person] = level;
  editSeq++; persistPending();
}

// Passes are keyed objects (never arrays), same discipline as notes.
// Double-write: local doc for instant render — the artist page renders a
// pass immediately — pending for the push. `leaf` is the whole tombstone
// shape ({ts} active, {ts, removed:true} un-passed) per spec §3.4 /
// validatePasses (api/_lib/crew-shared.mjs); callers build it (see
// applyPass below for the high-level mutual-exclusion write).
export function recordPass(fid, artist, person, leaf) {
  const build = (root) => {
    const f = (root.festivals = root.festivals || {});
    const entry = (f[fid] = f[fid] || {});
    const passes = (entry.passes = entry.passes || {});
    (passes[artist] = passes[artist] || {})[person] = leaf;
  };
  build(pendingChanges);
  build(crewDoc);
  editSeq++; persistPending(); persist();
}

// Recs: same shape/discipline as recordPass. `leaf` = {by, ts, removed?}
// (validateRecs, api/_lib/crew-shared.mjs) — one rec per (artist,
// forPerson); a later sender overwrites by/ts.
export function recordRec(fid, artist, forPerson, leaf) {
  const build = (root) => {
    const f = (root.festivals = root.festivals || {});
    const entry = (f[fid] = f[fid] || {});
    const recs = (entry.recs = entry.recs || {});
    (recs[artist] = recs[artist] || {})[forPerson] = leaf;
  };
  build(pendingChanges);
  build(crewDoc);
  editSeq++; persistPending(); persist();
}

// High-level pass write: picks and passes are mutually exclusive by client
// enforcement only (spec §3.4 — the server does not arbitrate; see
// model.effectiveState's resolution rule for what happens when concurrent
// writes leave both). `on=true` marks the artist passed; `on=false` undoes
// it. Passing over an existing pick tombstones the pick (writes level 0)
// the same way applyPickLevel un-passes an existing pass below.
export function applyPass(fid, artist, person, on) {
  const now = new Date().toISOString();
  recordPass(fid, artist, person, on ? { ts: now } : { ts: now, removed: true });
  if (on) {
    const raw = crewDoc.festivals?.[fid]?.selections?.[artist]?.[person];
    if (readLevel(crewDoc, raw) >= 1) recordSelectionFor(fid, artist, person, 0);
  }
}

// High-level pick write: the mirror of applyPass. Picking (level >= 1) over
// an existing ACTIVE pass un-passes it (writes the pass tombstone) so the
// two states don't linger together on this device's own writes — see
// model.effectiveState for what a remote device racing this can still
// produce, and how it resolves.
export function applyPickLevel(fid, artist, person, level) {
  recordSelectionFor(fid, artist, person, level);
  if (level >= 1 && isPassed(crewDoc, fid, artist, person)) {
    recordPass(fid, artist, person, { ts: new Date().toISOString(), removed: true });
  }
}

// Notes are keyed objects (never arrays — deep-merge would eat concurrent
// writes). Double-write: local doc for instant render, pending for the push.
export function recordNote(fid, scope, target, noteId, note) {
  const build = (root) => {
    const f = (root.festivals = root.festivals || {});
    const entry = (f[fid] = f[fid] || {});
    const notes = (entry.notes = entry.notes || {});
    const scoped = (notes[scope] = notes[scope] || {});
    const map = scope === 'fest' ? scoped : (scoped[target] = scoped[target] || {});
    map[noteId] = note;
  };
  build(pendingChanges);
  build(crewDoc);
  editSeq++; persistPending(); persist();
}

export function recordPerson(name, obj) {
  const pe = (pendingChanges.people = pendingChanges.people || {});
  pe[name] = obj;
  editSeq++; persistPending();
}

export function recordAffinity(person, artistMap) {
  // Double-write like every other recorder: local doc for the immediate
  // render, pending for the sync push.
  (crewDoc.affinity = crewDoc.affinity || {})[person] = artistMap;
  const aff = (pendingChanges.affinity = pendingChanges.affinity || {});
  aff[person] = artistMap;
  editSeq++; persistPending();
}

export function recordSpotifyStats(person, stats) {
  // Crew-visible "who's connected" glance: {likedCount, artistCount,
  // lastSynced, user}. Dropped in the 2026-07-12 rebuild (badgeAllCrewFests
  // wrote affinity only) — the drill showed local-cache numbers while the
  // crew doc stayed empty, verified live 2026-07-13.
  (crewDoc.spotifyStats = crewDoc.spotifyStats || {})[person] = stats;
  const st = (pendingChanges.spotifyStats = pendingChanges.spotifyStats || {});
  st[person] = stats;
  editSeq++; persistPending();
}

// Crew-shared playlist registry: spotify.playlists[fid] = {id, url, mode, by,
// at, artists[]} — what lets a later-connecting member find, open, and
// auto-extend the crew playlist. Validated server-side (crew-shared).
export function recordSpotifyPlaylist(fid, meta) {
  crewDoc.spotify = crewDoc.spotify || {};
  (crewDoc.spotify.playlists = crewDoc.spotify.playlists || {})[fid] = meta;
  const sp = (pendingChanges.spotify = pendingChanges.spotify || {});
  (sp.playlists = sp.playlists || {})[fid] = meta;
  editSeq++; persistPending();
}
export function spotifyPlaylistFor(fid) {
  return crewDoc.spotify?.playlists?.[fid] || null;
}

export function recordSpotifyClientId(clientId) {
  // Double-write like every other recorder — spotifyClientId() reads the
  // local doc, so a pending-only write left the drill stuck on the setup
  // state until the next full sync round-trip (CORE-14).
  crewDoc.spotify = crewDoc.spotify || {};
  crewDoc.spotify.clientId = clientId;
  pendingChanges.spotify = { clientId };
  editSeq++; persistPending(); persist();
}

export function recordCrewName(name) {
  crewDoc.meta = crewDoc.meta || {};
  crewDoc.meta.name = name;
  (pendingChanges.meta = pendingChanges.meta || {}).name = name;
  editSeq++; persistPending();
}

// Where new joiners land (FLOW-1): stamped at crew creation, refreshed when
// an invite is shared — so even old token-only links resolve to the right fest.
export function recordInviteFest(fid) {
  crewDoc.meta = crewDoc.meta || {};
  crewDoc.meta.inviteFestId = fid;
  (pendingChanges.meta = pendingChanges.meta || {}).inviteFestId = fid;
  editSeq++; persistPending();
}

export function hasPending() { return Object.keys(pendingChanges).length > 0; }

// Drop the leaves the server just accepted — and ONLY those.
//
// This used to write '{}' unconditionally, which re-opened on the clear path
// the exact race persistPending() closed on the write path: a second tab that
// recorded a pick to disk while our push was in flight had it erased, and if
// that tab closed before its own debounced push, the pick was gone for good.
// Subtracting the acked payload leaf-by-leaf leaves a concurrent tab's newer
// edits on disk to sync next round (finish pass, 2026-07-12).
//
// `pushed` is the exact payload the server accepted. Omitting it clears
// everything, which is only correct when there is nothing else to protect
// (crew switch, forget-crew).
// A NOTE must travel whole, and it is the only thing in this document that must.
//
// The server requires `author` and `ts` on every note it accepts (validateNote,
// api/_lib/crew-shared.mjs). Everything else in the crew doc is either a plain
// value (a pick level) or an object whose keys are independently optional (a
// person's colour, a Spotify stat). Notes are not: they are valid only complete.
//
// So subtraction must not descend into one. Edit a note while a push is in
// flight and a naive leaf-by-leaf subtraction drops the unchanged author and ts
// and leaves `{text: "..."}` — a fragment the server rejects with a 400, which
// (thanks to the refused-payload guard) would then wedge that device's sync
// entirely. Found by reading the two fixes against each other, before Codex did.
//
// path: festivals.<fid>.notes.<scope>.<target>.<noteId>   (fest scope has no target)
const NOTE_IS_ATOMIC = (path) => {
  if (path[0] !== 'festivals' || path[2] !== 'notes') return false;
  return path[3] === 'fest' ? path.length === 5 : path.length === 6;
};

export function clearPending(pushed) {
  if (!pushed) {
    pendingChanges = {};
    saveLS(LS.pending(crewToken), '{}');
    return;
  }
  // Subtract from BOTH copies, never blank either one:
  //   memory — an edit made while the push was in flight lives here, and
  //            blanking it would drop the edit from the next push entirely.
  //   disk   — another tab's edit lives here, and blanking it would drop that.
  pendingChanges = subtractLeaves(pendingChanges, pushed, NOTE_IS_ATOMIC);
  const onDisk = loadJSON(LS.pending(crewToken), {});
  saveLS(LS.pending(crewToken), JSON.stringify(subtractLeaves(onDisk, pushed, NOTE_IS_ATOMIC)));
}

// The pre-v31 deepMerge object-ified arrays ({"0":..,"1":..}) whenever one
// landed on a key that wasn't already an array. The playlist artists ledger
// is the only array that travels through pending, and a blob corrupted that
// way was refused by the server on every push — sync-blocking the device
// (live, 2026-07-13). The merge is fixed; this rebuilds blobs the old code
// already wrote to disk. Idempotent, drops nothing.
function healPlaylistArtists(container) {
  const lists = container && container.spotify && container.spotify.playlists;
  if (!lists) return false;
  let changed = false;
  for (const meta of Object.values(lists)) {
    const a = meta && meta.artists;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      meta.artists = Object.keys(a).sort((x, y) => Number(x) - Number(y)).map((k) => a[k]);
      changed = true;
    }
  }
  return changed;
}

// Cached copy of a crew doc (for offline joins / crew switching).
export function cachedDoc(token) { return loadJSON(LS.doc(token), null); }
export function cachedPending(token) {
  const p = loadJSON(LS.pending(token), {});
  healPlaylistArtists(p);
  return p;
}
export function clearCachedPending(token) { localStorage.removeItem(LS.pending(token)); }

// Rebuild local doc from remote + our pending overlay. Returns true if the
// visible slice actually changed (so callers repaint only when needed).
export function applyRemoteDoc(remote) {
  // The "visible slice" must cover everything the wall renders — notes and
  // meta included, or a note-only remote change never repaints (CORE-6).
  // passes/recs joined the slice for Discovery (spec §3.4): without them a
  // remote crewmate's pass (or a rec addressed to you) never triggers a
  // repaint — same bug, same fix.
  const visible = () => JSON.stringify({
    p: crewDoc.people,
    s: (crewDoc.festivals[activeFestivalId] || {}).selections || {},
    n: (crewDoc.festivals[activeFestivalId] || {}).notes || {},
    pa: (crewDoc.festivals[activeFestivalId] || {}).passes || {},
    r: (crewDoc.festivals[activeFestivalId] || {}).recs || {},
    a: crewDoc.affinity || {},
    m: crewDoc.meta || {},
  });
  const before = visible();
  crewDoc = deepMerge(remote || {}, pendingChanges);
  ensureFestivalState(activeFestivalId);
  persist();
  return visible() !== before;
}

// Returns computed artists for a day with startMin/endMin resolved (cached).
export function getDayArtists(day) {
  const key = `${activeFestivalId}|${day}`;
  if (dayCache[key]) return dayCache[key];
  const computed = computeDayArtists(fest().days[day]);
  dayCache[key] = computed;
  return computed;
}
