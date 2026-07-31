// Shared, DOM-free logic for the crew API: deep-merge + write-time validation.
// Kept pure so node --test can exercise every rule (tests/crew-validate.test.mjs).
//
// Validation philosophy (from the project's data-quality rules): reject
// implausible values at write time so garbage never reaches the stored doc.
// The capability token is the access gate; validation is the shape gate.

// Name rules are SHARED with the client (js/name-rules.mjs): the join and
// create forms validate with exactly the rule this validator enforces, so a
// name can never pass the UI and fail the write (FLOW-5).
import { SAFE_NAME_RE, NAME_LIMITS, FORBIDDEN_NAME_KEYS, validName } from '../../js/name-rules.mjs';

export const LIMITS = {
  docBytes: 256 * 1024,   // hard cap on the stored crew document
  activePeople: 24,
  personName: NAME_LIMITS.personName,
  artistName: 100,
  crewName: NAME_LIMITS.crewName,
  festivalId: 64,
  affinitySongs: 99999,
  noteText: 500,
  noteId: 80,
  isoTs: 32,
  colorIndexMax: 23,      // the 24-board (js/v3/palette.js)
  spotifyCount: 999999,
  personDocBytes: 32 * 1024, // Phase 1 (crews registry only); Phase 2 raises it for the library summary
};

export const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
// Public person id — the ONLY person identifier allowed inside a crew doc.
// The person TOKEN is a master key (its doc lists every crew token) and must
// never appear where crew members can read it. The length range is DISJOINT
// from TOKEN_RE's {20,40} on purpose: no token-shaped value can ever pass as
// a pid, even by accident (Codex gate, P2). Generated ids are 12 chars.
export const PID_RE = /^[A-Za-z0-9_-]{10,16}$/;
const COLOR_RE = /^\d{1,3}, \d{1,3}, \d{1,3}$/;
const FESTIVAL_ID_RE = /^[a-z0-9-]{1,64}$/;
const CLIENT_ID_RE = /^[0-9a-fA-F]{32}$/;

// Keys that would rebind an object's prototype through the bracket-assign
// merge below. Validators reject them, and the merge skips them anyway
// (defense in depth — never rely on a single layer for pollution).
export const FORBIDDEN_KEYS = FORBIDDEN_NAME_KEYS;
export { SAFE_NAME_RE };

export function deepMerge(base, overlay) {
  if (overlay === undefined || overlay === null) return base;
  if (typeof overlay !== 'object') return overlay;
  // Arrays replace wholesale, matching jsonb_deep_merge (object×object is the
  // only recursing case there). Without this, an overlay array walked the
  // object path below and came out as {"0":..} — see js/merge.js twin.
  if (Array.isArray(overlay)) return overlay.slice();
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const k in overlay) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = deepMerge(out[k], overlay[k]);
  }
  return out;
}

export function newCrewDoc(name, createdAt) {
  return {
    v: 4, // v4 semantics from birth: picks 0-4, keyed-object notes
    meta: { name, createdAt },
    spotify: {},
    spotifyStats: {},
    people: {},
    festivals: {},
    affinity: {},
  };
}

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

// Attacker-controlled keys (artist names legitimately contain <>&"') get
// sanitized before riding an error message — error bodies end up in client
// UIs and logs, and raw reflection there is a latent XSS vector (Codex P3
// trail, finding 4).
export const safeKey = (k) => String(k).replace(/[<>&"'`\\]/g, '').slice(0, 40);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validArtistKey(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= LIMITS.artistName
    && !/[\x00-\x1f]/.test(v) && !FORBIDDEN_KEYS.has(v);
}

function validatePeople(people) {
  if (!isPlainObject(people)) return fail('people must be an object');
  for (const [name, p] of Object.entries(people)) {
    if (!validName(name, LIMITS.personName)) return fail(`invalid person name: ${JSON.stringify(name).slice(0, 60)}`);
    if (!isPlainObject(p)) return fail(`person ${name}: entry must be an object`);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'color') { if (typeof v !== 'string' || !COLOR_RE.test(v)) return fail(`person ${name}: bad color`); }
      else if (k === 'removed') { if (typeof v !== 'boolean') return fail(`person ${name}: removed must be boolean`); }
      else if (k === 'colorIndex') { if (!Number.isInteger(v) || v < 0 || v > LIMITS.colorIndexMax) return fail(`person ${name}: colorIndex must be 0..${LIMITS.colorIndexMax}`); }
      else if (k === 'pid') { if (typeof v !== 'string' || !PID_RE.test(v)) return fail(`person ${name}: bad pid`); }
      else return fail(`person ${name}: unknown key ${k}`);
    }
  }
  return OK;
}

function validateSelections(selections) {
  if (!isPlainObject(selections)) return fail('selections must be an object');
  for (const [artist, byPerson] of Object.entries(selections)) {
    if (!validArtistKey(artist)) return fail('invalid artist key');
    if (!isPlainObject(byPerson)) return fail(`selections[${safeKey(artist)}] must be an object`);
    for (const [person, level] of Object.entries(byPerson)) {
      if (!validName(person, LIMITS.personName)) return fail(`selections[${safeKey(artist)}]: invalid person`);
      // v4 semantics: 0 tombstone, 1-3 picked (alpha ladder), 4 must.
      // Legacy v3 docs hold 0..3 with 3 meaning "Must See" — readers map
      // 3->4 by doc version (js/v3/model.js); the server accepts the union.
      if (!Number.isInteger(level) || level < 0 || level > 4) return fail(`selections[${safeKey(artist)}][${safeKey(person)}]: level must be 0..4`);
    }
  }
  return OK;
}

// Notes are keyed objects at EVERY level (never arrays — jsonb_deep_merge
// replaces arrays wholesale, which would eat concurrent notes). A note may be
// tombstoned by its author via deleted:true; text of tombstones may be ''.
const NOTE_ID_RE = /^[A-Za-z0-9|_.-]{8,80}$/;
const NOTE_SCOPES = new Set(['artist', 'day', 'fest']);

function validNoteTs(v) {
  return typeof v === 'string' && v.length <= LIMITS.isoTs && !Number.isNaN(Date.parse(v));
}

function validateNote(note, where) {
  if (!isPlainObject(note)) return fail(`${where}: note must be an object`);
  if (!validName(note.author ?? '', LIMITS.personName)) return fail(`${where}: bad author`);
  if (!validNoteTs(note.ts)) return fail(`${where}: bad ts`);
  for (const [k, v] of Object.entries(note)) {
    if (k === 'author' || k === 'ts') continue;
    else if (k === 'text') {
      if (typeof v !== 'string' || v.length > LIMITS.noteText || /[\x00-\x08\x0b-\x1f]/.test(v)) return fail(`${where}: bad text`);
    } else if (k === 'deleted') {
      if (v !== true) return fail(`${where}: deleted may only be true`);
    } else return fail(`${where}: unknown key ${k}`);
  }
  if (typeof note.text !== 'string') return fail(`${where}: text required`);
  if (note.text.length === 0 && note.deleted !== true) return fail(`${where}: empty text`);
  return OK;
}

// Note ids embed their author (sanitized) as the first dot-segment — the
// server requires the id prefix to match the note's author. Honest limits:
// with one shared capability token there is no per-user auth, so a member
// can still FORGE an author outright (same trust model as person names).
// What this rule does guarantee: a client writing under its own author can
// never accidentally or casually overwrite/tombstone a DIFFERENT author's
// note, because it cannot produce a matching id for them without also
// forging the author field (Codex P2 gate, findings 2 + 8).
export function sanitizeAuthorForId(author) {
  return String(author).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 20) || 'anon';
}

function validateNoteMap(map, where) {
  if (!isPlainObject(map)) return fail(`${where} must be an object`);
  for (const [noteId, note] of Object.entries(map)) {
    if (!NOTE_ID_RE.test(noteId) || FORBIDDEN_KEYS.has(noteId)) return fail(`${where}: bad note id`);
    const r = validateNote(note, `${where}[${noteId.slice(0, 20)}]`);
    if (!r.ok) return r;
    const prefix = `${sanitizeAuthorForId(note.author)}.`;
    if (!noteId.startsWith(prefix)) return fail(`${where}: note id must begin with its author (${prefix}...)`);
  }
  return OK;
}

function validateNotes(notes, fid) {
  if (!isPlainObject(notes)) return fail(`festivals[${fid}].notes must be an object`);
  for (const [scope, targets] of Object.entries(notes)) {
    if (!NOTE_SCOPES.has(scope)) return fail(`festivals[${fid}].notes: unknown scope ${scope}`);
    if (scope === 'fest') {
      const r = validateNoteMap(targets, `notes.fest`);
      if (!r.ok) return r;
      continue;
    }
    if (!isPlainObject(targets)) return fail(`notes.${scope} must be an object`);
    for (const [target, map] of Object.entries(targets)) {
      if (!validArtistKey(target)) return fail(`notes.${scope}: invalid target key`);
      const r = validateNoteMap(map, `notes.${scope}[${safeKey(target).slice(0, 30)}]`);
      if (!r.ok) return r;
    }
  }
  return OK;
}

// `passes` and `recs` (Discovery, spec §3.4) are siblings of `selections` —
// same keyed-object/tombstone discipline, never arrays (G-1).
//
// Tombstone convention adopted: a `removed: boolean` field on the leaf
// object, exactly like `people[name].removed` above (validatePeople, the
// `k === 'removed'` branch) — NOT notes' one-way `deleted: true` (validateNote,
// `k === 'deleted'`, which rejects anything but `true` because a deleted note
// is dead forever). Passes are explicitly reversible (spec §3.4: "reversible");
// a plain boolean that can flip both ways is what makes that possible — with
// jsonb_deep_merge's object-leaf-merges-key-by-key semantics, re-passing after
// an un-pass MUST be able to write `removed:false` to clear a stale tombstone,
// which a one-way sentinel (like notes' `deleted`) cannot express. Recs reuse
// the same shape for consistency (one validator, one mental model) even though
// their tombstone (forPerson acts on the rec) is expected to only run one way
// in practice.
//
// As proven by tests/db-merge.test.mjs ("deletion is inexpressible"), sending
// a bare `null` leaf does NOT remove the key — jsonb_deep_merge has no delete
// operation, only overwrite — so, like selections' level-0 and notes'
// `deleted:true`, the tombstone must be a normal value inside the schema, not
// null.
function validRemovedFlag(v) {
  return typeof v === 'boolean';
}

function validatePasses(passes, fid) {
  if (!isPlainObject(passes)) return fail(`festivals[${fid}].passes must be an object`);
  for (const [artist, byPerson] of Object.entries(passes)) {
    if (!validArtistKey(artist)) return fail(`passes: invalid artist key`);
    if (!isPlainObject(byPerson)) return fail(`passes[${safeKey(artist)}] must be an object`);
    for (const [person, leaf] of Object.entries(byPerson)) {
      if (!validName(person, LIMITS.personName)) return fail(`passes[${safeKey(artist)}]: invalid person`);
      const where = `passes[${safeKey(artist)}][${safeKey(person)}]`;
      if (!isPlainObject(leaf)) return fail(`${where} must be an object`);
      if (!validNoteTs(leaf.ts)) return fail(`${where}: bad ts`);
      for (const [k, v] of Object.entries(leaf)) {
        if (k === 'ts') continue;
        else if (k === 'removed') { if (!validRemovedFlag(v)) return fail(`${where}: removed must be boolean`); }
        else return fail(`${where}: unknown key ${safeKey(k)}`);
      }
    }
  }
  return OK;
}

function validateRecs(recs, fid) {
  if (!isPlainObject(recs)) return fail(`festivals[${fid}].recs must be an object`);
  for (const [artist, byForPerson] of Object.entries(recs)) {
    if (!validArtistKey(artist)) return fail(`recs: invalid artist key`);
    if (!isPlainObject(byForPerson)) return fail(`recs[${safeKey(artist)}] must be an object`);
    for (const [forPerson, leaf] of Object.entries(byForPerson)) {
      if (!validName(forPerson, LIMITS.personName)) return fail(`recs[${safeKey(artist)}]: invalid forPerson`);
      const where = `recs[${safeKey(artist)}][${safeKey(forPerson)}]`;
      if (!isPlainObject(leaf)) return fail(`${where} must be an object`);
      if (!validName(leaf.by, LIMITS.personName)) return fail(`${where}: bad by`);
      if (!validNoteTs(leaf.ts)) return fail(`${where}: bad ts`);
      for (const [k, v] of Object.entries(leaf)) {
        if (k === 'by' || k === 'ts') continue;
        else if (k === 'removed') { if (!validRemovedFlag(v)) return fail(`${where}: removed must be boolean`); }
        else return fail(`${where}: unknown key ${safeKey(k)}`);
      }
    }
  }
  return OK;
}

function validateFestivals(festivals) {
  if (!isPlainObject(festivals)) return fail('festivals must be an object');
  for (const [fid, entry] of Object.entries(festivals)) {
    if (!FESTIVAL_ID_RE.test(fid)) return fail(`invalid festival id: ${fid.slice(0, 60)}`);
    if (!isPlainObject(entry)) return fail(`festivals[${fid}] must be an object`);
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'selections') {
        const r = validateSelections(v);
        if (!r.ok) return r;
      } else if (k === 'notes') {
        const r = validateNotes(v, fid);
        if (!r.ok) return r;
      } else if (k === 'passes') {
        const r = validatePasses(v, fid);
        if (!r.ok) return r;
      } else if (k === 'recs') {
        const r = validateRecs(v, fid);
        if (!r.ok) return r;
      } else return fail(`festivals[${fid}]: unknown key ${k}`);
    }
  }
  return OK;
}

function validateAffinity(affinity) {
  if (!isPlainObject(affinity)) return fail('affinity must be an object');
  for (const [person, byArtist] of Object.entries(affinity)) {
    if (!validName(person, LIMITS.personName)) return fail('affinity: invalid person name');
    if (!isPlainObject(byArtist)) return fail(`affinity[${person}] must be an object`);
    for (const [artist, aff] of Object.entries(byArtist)) {
      if (!validArtistKey(artist)) return fail('affinity: invalid artist key');
      if (!isPlainObject(aff)) return fail(`affinity[${safeKey(person)}][${safeKey(artist)}] must be an object`);
      for (const [k, v] of Object.entries(aff)) {
        if (k === 'songs') { if (!Number.isInteger(v) || v < 0 || v > LIMITS.affinitySongs) return fail('affinity: bad songs count'); }
        else if (k === 'followed') { if (typeof v !== 'boolean') return fail('affinity: followed must be boolean'); }
        else return fail(`affinity: unknown key ${k}`);
      }
    }
  }
  return OK;
}

// The crew-shared playlist registry (spotify.playlists[fid]) is what lets a
// member who connects LATER find, open, and auto-extend the crew playlist.
// The recorded `artists` list is the dedupe ledger for auto-extend — capped
// so a hostile write can't balloon the doc.
const SPOTIFY_PLAYLIST_ID_RE = /^[A-Za-z0-9]{10,40}$/;
const SPOTIFY_PLAYLIST_URL_RE = /^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]{10,40}(\?[\w=&-]*)?$/;

function validateSpotifyPlaylist(fid, p) {
  if (typeof fid !== 'string' || !FESTIVAL_ID_RE.test(fid)) return fail('spotify.playlists: bad festival id');
  if (!isPlainObject(p)) return fail(`spotify.playlists[${safeKey(fid)}] must be an object`);
  for (const [k, v] of Object.entries(p)) {
    if (k === 'id') {
      if (typeof v !== 'string' || !SPOTIFY_PLAYLIST_ID_RE.test(v)) return fail('playlist: bad id');
    } else if (k === 'url') {
      if (typeof v !== 'string' || !SPOTIFY_PLAYLIST_URL_RE.test(v)) return fail('playlist: url must be an open.spotify.com playlist link');
    } else if (k === 'mode') {
      if (v !== 'everyone' && v !== 'mine') return fail('playlist: mode must be everyone|mine');
    } else if (k === 'by') {
      if (!validName(v, LIMITS.personName)) return fail('playlist: bad by');
    } else if (k === 'at') {
      if (!validNoteTs(v)) return fail('playlist: bad at');
    } else if (k === 'artists') {
      if (!Array.isArray(v) || v.length > 500) return fail('playlist: artists must be an array (max 500)');
      for (const n of v) if (typeof n !== 'string' || !n.length || n.length > LIMITS.artistName) return fail('playlist: bad artist name');
    } else return fail(`playlist: unknown key ${safeKey(k)}`);
  }
  if (!p.id || !p.url) return fail('playlist: id and url are required');
  return OK;
}

function validateSpotify(spotify) {
  if (!isPlainObject(spotify)) return fail('spotify must be an object');
  for (const [k, v] of Object.entries(spotify)) {
    if (k === 'clientId') {
      // Empty string allowed: it is how a crew clears its client ID.
      if (typeof v !== 'string' || (v !== '' && !CLIENT_ID_RE.test(v))) return fail('spotify.clientId must be a 32-hex-char Spotify Client ID');
    } else if (k === 'playlists') {
      if (!isPlainObject(v)) return fail('spotify.playlists must be an object');
      if (Object.keys(v).length > 24) return fail('spotify.playlists: too many');
      for (const [fid, p] of Object.entries(v)) {
        const r = validateSpotifyPlaylist(fid, p);
        if (!r.ok) return r;
      }
    } else return fail(`spotify: unknown key ${safeKey(k)}`);
  }
  return OK;
}

function validateMeta(meta) {
  if (!isPlainObject(meta)) return fail('meta must be an object');
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'name') {
      if (!validName(v, LIMITS.crewName)) return fail('meta.name invalid');
    } else if (k === 'inviteFestId') {
      // The festival new joiners should land on (FLOW-1). Recorded when a
      // crew is created and refreshed when an invite is shared.
      if (typeof v !== 'string' || !FESTIVAL_ID_RE.test(v)) return fail('meta.inviteFestId invalid');
    } else return fail(`meta: only name and inviteFestId may be written (got ${k})`);
  }
  return OK;
}

// Per-person Spotify glance stats (Settings shows state; the drill page acts).
// Badges themselves stay in `affinity` — this is display metadata only.
function validateSpotifyStats(stats) {
  if (!isPlainObject(stats)) return fail('spotifyStats must be an object');
  for (const [person, s] of Object.entries(stats)) {
    if (!validName(person, LIMITS.personName)) return fail('spotifyStats: invalid person');
    if (!isPlainObject(s)) return fail(`spotifyStats[${person}] must be an object`);
    for (const [k, v] of Object.entries(s)) {
      if (k === 'likedCount' || k === 'artistCount') {
        if (!Number.isInteger(v) || v < 0 || v > LIMITS.spotifyCount) return fail(`spotifyStats[${person}]: bad ${k}`);
      } else if (k === 'lastSynced') {
        if (!validNoteTs(v)) return fail(`spotifyStats[${person}]: bad lastSynced`);
      } else if (k === 'user') {
        if (!validName(v, 64)) return fail(`spotifyStats[${person}]: bad user`);
      } else return fail(`spotifyStats[${person}]: unknown key ${k}`);
    }
  }
  return OK;
}

// Doc schema version is NOT client-writable. The v3 -> v4 upgrade happens
// ONLY through the server-side migrate op (api/crew.js ?op=migrate): one
// atomic UPDATE that maps every legacy selection leaf (3 -> 4) and stamps
// v=4 together — a bare {v:4} stamp that skipped conversion would silently
// downgrade every legacy "Must See" to picked-x3 (Codex P2 gate, finding 1).
const SECTION_VALIDATORS = {
  people: validatePeople,
  festivals: validateFestivals,
  affinity: validateAffinity,
  spotify: validateSpotify,
  spotifyStats: validateSpotifyStats,
  meta: validateMeta,
};

// Validate an incoming merge overlay (client-sent partial crew doc).
export function validateIncoming(data) {
  if (!isPlainObject(data)) return fail('data must be an object');
  for (const [section, value] of Object.entries(data)) {
    const validator = SECTION_VALIDATORS[section];
    if (!validator) return fail(`unknown section: ${section}`);
    const r = validator(value);
    if (!r.ok) return r;
  }
  return OK;
}

// Post-merge invariants that only make sense on the whole doc.
// NOTE: in production these are enforced INSIDE api/crew.js's atomic UPDATE
// (same limits, SQL-side) so there is no check-then-write gap. This JS twin
// is the readable reference implementation, exercised by the test suite.
export function validateMergedDoc(doc) {
  const activeNames = Object.entries(doc.people || {})
    .filter(([, p]) => p && !p.removed)
    .map(([name]) => name);

  if (activeNames.length > LIMITS.activePeople) return fail(`too many active people (max ${LIMITS.activePeople})`);

  // Two members whose names differ only by case are ONE person to every human
  // who looks at the crew, and two people to the document forever: their picks,
  // notes and Spotify badges split silently down the middle with nothing on
  // screen to explain it. The clients each check for this, but only against
  // their own in-memory copy — which cannot see the other phone joining in the
  // same breath. The merge is the only place both writes are visible, so the
  // invariant belongs here (finish pass, 2026-07-12; verified first that no
  // existing crew already holds such a pair, or this rule would have bricked
  // every future write to it).
  const seen = new Map();
  for (const name of activeNames) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return fail(`two crew members named "${safeKey(seen.get(key))}" and "${safeKey(name)}" — names must differ by more than capitalization`);
    }
    seen.set(key, name);
  }

  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (bytes > LIMITS.docBytes) return fail(`crew document too large (${bytes} bytes, max ${LIMITS.docBytes})`);
  return OK;
}

// ---- person records (the "me link") -----------------------------------------
// One person across crews. The doc is tiny by design: a default name plus a
// crews registry — { <crewToken>: { name, crewName } } — where `name` is who
// this person is INSIDE that crew (legacy divergence like Ross/Rosss stays
// honest) and `crewName` is a display cache so a restore renders the landing
// before any crew doc has been fetched.

export function newPersonDoc(name, createdAt) {
  return { v: 1, name, createdAt, crews: {} };
}

// Validate an incoming person merge overlay. Same philosophy as crews:
// unknown sections are rejected, v/createdAt are not client-writable.
export function validatePersonIncoming(data) {
  if (!isPlainObject(data)) return fail('data must be an object');
  for (const [section, value] of Object.entries(data)) {
    if (section === 'name') {
      if (!validName(value, LIMITS.personName)) return fail('person: invalid name');
    } else if (section === 'crews') {
      if (!isPlainObject(value)) return fail('person: crews must be an object');
      for (const [crewToken, entry] of Object.entries(value)) {
        if (!TOKEN_RE.test(crewToken)) return fail('person: bad crew token key');
        if (!isPlainObject(entry)) return fail('person: crew entry must be an object');
        for (const [k, v] of Object.entries(entry)) {
          if (k === 'name') { if (!validName(v, LIMITS.personName)) return fail('person: bad crew name claim'); }
          else if (k === 'crewName') { if (!validName(v, LIMITS.crewName)) return fail('person: bad crewName'); }
          else return fail(`person: unknown crew entry key ${safeKey(k)}`);
        }
      }
    } else {
      return fail(`person: unknown section ${safeKey(section)}`);
    }
  }
  return OK;
}
