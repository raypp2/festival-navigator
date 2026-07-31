// v4 data-layer semantics: version-aware reads, one-shot migration, notes
// merge safety. The concurrent-notes test is the load-bearing one — it proves
// the keyed-object shape survives what an array shape provably would not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  docVersion, readLevel, picksFor, needsMigration, nextTapLevel,
  makeNoteId, notesFor, noteCount, totalNoteCount, noteOverlay,
  togglePin, sortWithPins, canonicalStages,
  passesFor, isPassed, recsFor, recsForPerson, effectiveState,
} from '../js/v3/model.js';
import { deepMerge, validateIncoming, newCrewDoc } from '../api/_lib/crew-shared.mjs';

const V3_DOC = {
  v: 3,
  people: { Kevin: { color: '239, 68, 68' }, Colby: { color: '251, 191, 36' } },
  festivals: {
    'electric-forest-2026': {
      selections: {
        'H&RRY': { Kevin: 1 },
        'Alleycvt': { Kevin: 2, Colby: 3 },
        'Muzz': { Colby: 0 },
      },
    },
    'lollapalooza-2025': { selections: { 'Wild Rivers': { Kevin: 3 } } },
  },
};

test('legacy read mapping: 1->1 2->2 3->4, tombstones stay dead', () => {
  assert.equal(docVersion(V3_DOC), 3);
  assert.equal(readLevel(V3_DOC, 3), 4); // old Must See IS must
  assert.equal(readLevel(V3_DOC, 2), 2);
  assert.equal(readLevel(V3_DOC, 0), 0);
  const picks = picksFor(V3_DOC, 'electric-forest-2026');
  assert.deepEqual(picks, { 'H&RRY': { Kevin: 1 }, 'Alleycvt': { Kevin: 2, Colby: 4 } });
});

test('v4 docs read raw: 3 means picked x3, not must', () => {
  const v4 = { ...V3_DOC, v: 4 };
  assert.equal(readLevel(v4, 3), 3);
  assert.equal(picksFor(v4, 'lollapalooza-2025')['Wild Rivers'].Kevin, 3);
});

test('migration is server-only: clients cannot write v at all', () => {
  assert.equal(needsMigration(V3_DOC), true);
  assert.equal(needsMigration({ ...V3_DOC, v: 4 }), false);
  // The bare-stamp attack from the Codex gate (finding 1): rejected outright.
  assert.equal(validateIncoming({ v: 4 }).ok, false);
  assert.equal(validateIncoming({ v: 4, festivals: {} }).ok, false);
  assert.equal(validateIncoming({ v: 3 }).ok, false);
});

test('LEGACY_MAP passes 4 through: v4 write landing pre-migration is not eaten', () => {
  // A v4-semantics must (4) written onto a still-v3 doc must read as must,
  // not collapse to 0 through the legacy map.
  assert.equal(readLevel(V3_DOC, 4), 4);
});

test('tap cycle 0->1->2->3->4->0', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(nextTapLevel), [1, 2, 3, 4, 0]);
});

test('CONCURRENT NOTES SURVIVE: two writers, same artist, no loss', () => {
  const base = deepMerge(newCrewDoc('T', '2026-07-10T06:00:00Z'), {
    people: { Kevin: { colorIndex: 0 }, Maya: { colorIndex: 1 } },
  });
  const a = noteOverlay('portola-2026', 'artist', 'Robyn',
    { author: 'Kevin', ts: '2026-07-10T06:01:00Z', text: 'front left' }, 'Kevin.1.aaaaaa');
  const b = noteOverlay('portola-2026', 'artist', 'Robyn',
    { author: 'Maya', ts: '2026-07-10T06:01:01Z', text: 'pit floods right' }, 'Maya.2.bbbbbb');
  assert.deepEqual(validateIncoming(a), { ok: true });
  assert.deepEqual(validateIncoming(b), { ok: true });
  // Simulate the race both ways: inline-UPDATE semantics mean the second
  // writer merges onto the first's committed doc.
  for (const [first, second] of [[a, b], [b, a]]) {
    const doc = deepMerge(deepMerge(base, first), second);
    const notes = notesFor(doc, 'portola-2026', 'artist', 'Robyn');
    assert.equal(notes.length, 2, 'both notes must survive');
    assert.deepEqual(notes.map((n) => n.author).sort(), ['Kevin', 'Maya']);
  }
});

test('note ordering, counts, and tombstones', () => {
  const doc = deepMerge(
    deepMerge(newCrewDoc('T', '2026-07-10T06:00:00Z'),
      noteOverlay('acl-2025', 'day', 'Friday',
        { author: 'Kevin', ts: '2026-07-10T06:05:00Z', text: 'later note' }, 'Kevin.2.later0')),
    noteOverlay('acl-2025', 'day', 'Friday',
      { author: 'Maya', ts: '2026-07-10T06:01:00Z', text: 'earlier note' }, 'Maya.1.early0'),
  );
  const notes = notesFor(doc, 'acl-2025', 'day', 'Friday');
  assert.deepEqual(notes.map((n) => n.text), ['earlier note', 'later note']);
  assert.equal(noteCount(doc, 'acl-2025', 'day', 'Friday'), 2);
  // Author tombstones their own note — count drops, other note untouched
  const killed = deepMerge(doc, noteOverlay('acl-2025', 'day', 'Friday',
    { author: 'Maya', ts: '2026-07-10T06:01:00Z', text: '', deleted: true }, 'Maya.1.early0'));
  assert.equal(noteCount(killed, 'acl-2025', 'day', 'Friday'), 1);
  // fest scope + total
  const withFest = deepMerge(killed, noteOverlay('acl-2025', 'fest', null,
    { author: 'Kevin', ts: '2026-07-10T06:09:00Z', text: 'parking pass under Maya' }, 'Kevin.3.fest00'));
  assert.equal(totalNoteCount(withFest, 'acl-2025'), 2);
});

test('server validator: new sections accept good and reject bad', () => {
  const ok = validateIncoming({
    people: { Kevin: { colorIndex: 23 } },
    spotifyStats: { Kevin: { likedCount: 11423, artistCount: 342, lastSynced: '2026-06-24T00:00:00Z', user: 'kevglynn.sf' } },
    festivals: { 'portola-2026': { selections: { Robyn: { Kevin: 4 } } } },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(validateIncoming({ v: 4 }).ok, false); // v is never client-writable
  assert.equal(validateIncoming({ v: 5 }).ok, false);
  assert.equal(validateIncoming({ people: { K: { colorIndex: 24 } } }).ok, false);
  assert.equal(validateIncoming({ festivals: { f: { selections: { A: { K: 5 } } } } }).ok, false);
  assert.equal(validateIncoming({ festivals: { f: { notes: { artist: { A: { 'short': { author: 'K', ts: '2026-01-01', text: 'x' } } } } } } }).ok, false); // id too short
  assert.equal(validateIncoming({ festivals: { f: { notes: { artist: { A: { 'K.1.aaaaaa': { author: 'K', ts: 'nope', text: 'x' } } } } } } }).ok, false); // bad ts
  assert.equal(validateIncoming({ festivals: { f: { notes: { artist: { A: { 'K.1.aaaaaa': { author: 'K', ts: '2026-01-01', text: 'x'.repeat(501) } } } } } } }).ok, false);
  assert.equal(validateIncoming({ festivals: { f: { notes: { vibe: {} } } } }).ok, false); // unknown scope
});

test('pins: toggle + pinned-first sort, purely local', () => {
  let pins = {};
  pins = togglePin(pins, 'acl-2025', 'Maya.1.early0');
  assert.deepEqual(pins['acl-2025'], ['Maya.1.early0']);
  const sorted = sortWithPins(
    [{ id: 'a', ts: '2026-07-10T06:00:00Z' }, { id: 'Maya.1.early0', ts: '2026-07-10T07:00:00Z' }],
    pins['acl-2025'],
  );
  assert.equal(sorted[0].id, 'Maya.1.early0'); // pinned floats above older note
  pins = togglePin(pins, 'acl-2025', 'Maya.1.early0');
  assert.deepEqual(pins['acl-2025'], []);
});

test('makeNoteId sanitizes hostile authors into the server id alphabet', () => {
  const id = makeNoteId('K<img>|evil name', '2026-07-10T06:00:00Z', 'abc123');
  assert.match(id, /^[A-Za-z0-9|_.-]{8,80}$/);
  assert.ok(!id.includes('<') && !id.includes('|evil'));
});

test('note ownership: id prefix must match author (Codex finding 2)', () => {
  const note = (author) => ({ author, ts: '2026-07-10T06:00:00Z', text: 'hi' });
  const wrap = (id, n) => ({ festivals: { f: { notes: { artist: { Robyn: { [id]: n } } } } } });
  // Kevin writing under his own id: fine
  assert.equal(validateIncoming(wrap('Kevin.123.abcdef', note('Kevin'))).ok, true);
  // Kevin's client targeting MAYA's note id while authoring as Kevin: rejected
  assert.equal(validateIncoming(wrap('Maya.123.abcdef', note('Kevin'))).ok, false);
  // Tombstoning someone else's id under your own author: rejected
  assert.equal(validateIncoming(wrap('Maya.123.abcdef',
    { author: 'Kevin', ts: '2026-07-10T06:00:00Z', text: '', deleted: true })).ok, false);
  // makeNoteId output always satisfies the prefix rule for its own author
  const id = makeNoteId('Maya', '2026-07-10T06:00:00Z', 'zzzzzz');
  assert.equal(validateIncoming(wrap(id, note('Maya'))).ok, true);
});

// ---- canonical cross-day stage columns (Kevin note 1.2, 2026-07-12) ----------
// Same physical stage, same column, every day — regardless of how each day's
// stages array was authored.
test('canonicalStages: union across days in first-appearance order', () => {
  const fest = {
    days: {
      Friday: { stages: ['Alpha', 'Beta'] },
      Saturday: { stages: ['Beta', 'Gamma', 'Alpha'] },
      Sunday: { stages: ['Delta'] },
    },
  };
  assert.deepEqual(canonicalStages(fest), ['Alpha', 'Beta', 'Gamma', 'Delta']);
});

test('canonicalStages: tolerates missing days, missing stages, empty fest', () => {
  assert.deepEqual(canonicalStages({}), []);
  assert.deepEqual(canonicalStages(null), []);
  assert.deepEqual(canonicalStages({ days: { Friday: {} } }), []);
});

// ---- passes & recs (Discovery, spec §3.4) ----------------------------------------

test('passesFor drops tombstones, keeps active leaves', () => {
  const doc = {
    v: 4,
    festivals: {
      'portola-2026': {
        passes: {
          Robyn: { Kevin: { ts: '2026-07-10T06:00:00Z' }, Maya: { ts: '2026-07-10T06:05:00Z', removed: true } },
          GRiZ: { Kevin: { ts: '2026-07-10T06:01:00Z', removed: false } },
        },
      },
    },
  };
  assert.deepEqual(passesFor(doc, 'portola-2026'), {
    Robyn: { Kevin: { ts: '2026-07-10T06:00:00Z' } },
    GRiZ: { Kevin: { ts: '2026-07-10T06:01:00Z' } },
  });
  assert.equal(isPassed(doc, 'portola-2026', 'Robyn', 'Kevin'), true);
  assert.equal(isPassed(doc, 'portola-2026', 'Robyn', 'Maya'), false, 'tombstoned pass reads as not-passed');
  assert.equal(isPassed(doc, 'portola-2026', 'Robyn', 'NoOne'), false, 'never-passed reads as not-passed');
  assert.deepEqual(passesFor(doc, 'nonexistent-fest'), {}, 'missing festival is an empty map, not a throw');
});

test('recsFor drops tombstones and reflects a second sender overwriting by/ts', () => {
  const base = deepMerge(newCrewDoc('T', '2026-07-10T06:00:00Z'), {
    people: { Kevin: { colorIndex: 0 }, Maya: { colorIndex: 1 }, Sam: { colorIndex: 2 } },
  });
  const firstRec = { festivals: { 'portola-2026': { recs: { Robyn: { Sam: { by: 'Kevin', ts: '2026-07-10T06:00:00Z' } } } } } };
  const withFirst = deepMerge(base, firstRec);
  assert.deepEqual(recsFor(withFirst, 'portola-2026'), { Robyn: { Sam: { by: 'Kevin', ts: '2026-07-10T06:00:00Z' } } });

  // A second sender overwrites by/ts — one rec per (artist, forPerson), per spec §3.4.
  const secondRec = { festivals: { 'portola-2026': { recs: { Robyn: { Sam: { by: 'Maya', ts: '2026-07-10T06:10:00Z' } } } } } };
  const withSecond = deepMerge(withFirst, secondRec);
  assert.deepEqual(recsFor(withSecond, 'portola-2026'), { Robyn: { Sam: { by: 'Maya', ts: '2026-07-10T06:10:00Z' } } });

  // Sam picks/passes -> the rec is tombstoned and drops out of recsFor.
  const tombstoned = deepMerge(withSecond, {
    festivals: { 'portola-2026': { recs: { Robyn: { Sam: { by: 'Maya', ts: '2026-07-10T06:10:00Z', removed: true } } } } },
  });
  assert.deepEqual(recsFor(tombstoned, 'portola-2026'), {});

  // Both writes pass server validation (crew-shared.mjs validateRecs).
  assert.equal(validateIncoming(firstRec).ok, true);
  assert.equal(validateIncoming(secondRec).ok, true);
});

test('recsForPerson: one person\'s first-open queue, newest recommendation first', () => {
  const doc = {
    v: 4,
    festivals: {
      'portola-2026': {
        recs: {
          Robyn: { Sam: { by: 'Kevin', ts: '2026-07-10T06:00:00Z' } },
          GRiZ: { Sam: { by: 'Maya', ts: '2026-07-10T06:10:00Z' }, Kevin: { by: 'Sam', ts: '2026-07-10T06:20:00Z' } },
          Muzz: { Sam: { by: 'Kevin', ts: '2026-07-10T06:05:00Z', removed: true } }, // tombstoned, excluded
          Alleycvt: { Colby: { by: 'Kevin', ts: '2026-07-10T06:30:00Z' } }, // addressed to someone else
        },
      },
    },
  };
  const queue = recsForPerson(doc, 'portola-2026', 'Sam');
  assert.deepEqual(queue.map((r) => r.artist), ['GRiZ', 'Robyn'], 'newest ts first, tombstones and other-person recs excluded');
  assert.equal(queue[0].by, 'Maya');
});

test('effectiveState: must, picked, passed, none, and legacy v3 mapping', () => {
  const v4 = {
    v: 4,
    festivals: {
      f: {
        selections: { Must: { Kevin: 4 }, Picked: { Kevin: 2 }, ClearedPick: { Kevin: 0 } },
        passes: { Passed: { Kevin: { ts: '2026-07-10T06:00:00Z' } } },
      },
    },
  };
  assert.equal(effectiveState(v4, 'f', 'Must', 'Kevin'), 'must');
  assert.equal(effectiveState(v4, 'f', 'Picked', 'Kevin'), 'picked');
  assert.equal(effectiveState(v4, 'f', 'Passed', 'Kevin'), 'passed');
  assert.equal(effectiveState(v4, 'f', 'ClearedPick', 'Kevin'), 'none');
  assert.equal(effectiveState(v4, 'f', 'NeverTouched', 'Kevin'), 'none');

  // Legacy v3 doc: old level 3 ("Must See") reads as must via readLevel's mapping.
  const legacy = {
    v: 3,
    festivals: { f: { selections: { OldMust: { Kevin: 3 }, OldHighlight: { Kevin: 2 } } } },
  };
  assert.equal(effectiveState(legacy, 'f', 'OldMust', 'Kevin'), 'must');
  assert.equal(effectiveState(legacy, 'f', 'OldHighlight', 'Kevin'), 'picked');

  // RESOLUTION RULE: concurrent writes leave both an active pass and a pick
  // >= 1 on the same (artist, person) — the pick wins (positive intent stays
  // visible; the latent pass is healed by the next local write, js/state.js
  // applyPass/applyPickLevel).
  const both = {
    v: 4,
    festivals: {
      f: {
        selections: { Contested: { Kevin: 2 } },
        passes: { Contested: { Kevin: { ts: '2026-07-10T06:00:00Z' } } },
      },
    },
  };
  assert.equal(effectiveState(both, 'f', 'Contested', 'Kevin'), 'picked', 'pick wins over a concurrently-held pass');

  const bothMust = {
    v: 4,
    festivals: {
      f: {
        selections: { Contested: { Kevin: 4 } },
        passes: { Contested: { Kevin: { ts: '2026-07-10T06:00:00Z' } } },
      },
    },
  };
  assert.equal(effectiveState(bothMust, 'f', 'Contested', 'Kevin'), 'must', 'must also wins over a concurrent pass');
});
