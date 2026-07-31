// The SQL this whole app rests on, finally executed by a test.
//
// Everything the crew store promises — "no read-modify-write race, ever",
// tombstones instead of deletes, keyed notes because arrays would eat each
// other, the size/people/duplicate-name invariants — lives in db/schema.sql and
// api/_lib/crew-sql.mjs. Before the finish pass (2026-07-12) not one line of it
// ran in CI: the suite exercised a JS "reference twin" whose own comments admit
// it is NOT what production enforces, so a real regression in the real
// statement would have shipped green.
//
// This runs REAL Postgres (PGlite, in-process, no server, no secrets) against
// the SAME statement text api/crew.js executes. No re-typed copy — a test
// against a copy passes through exactly the regression it exists to catch.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { MERGE_SQL, DIAGNOSE_SQL } from '../api/_lib/crew-sql.mjs';
import { LIMITS } from '../api/_lib/crew-shared.mjs';

let db;
const TOKEN = 'dbtest_token_0123456789';

const baseDoc = () => ({
  v: 4,
  meta: { name: 'DB Test', createdAt: '2026-07-12T00:00:00.000Z' },
  spotify: {}, spotifyStats: {},
  people: { Kev: { colorIndex: 0 } },
  festivals: { ef: { selections: {} } },
  affinity: {},
});

const seed = async (doc = baseDoc(), token = TOKEN) => {
  await db.query('DELETE FROM crews WHERE token = $1', [token]);
  await db.query('INSERT INTO crews (token, doc) VALUES ($1, $2::jsonb)', [token, JSON.stringify(doc)]);
};

// Exactly how api/crew.js calls it.
const merge = (delta, token = TOKEN) => db.query(MERGE_SQL, [
  token, JSON.stringify(delta), JSON.stringify(delta), LIMITS.docBytes, LIMITS.activePeople,
]);

const readDoc = async (token = TOKEN) => {
  const r = await db.query('SELECT doc FROM crews WHERE token = $1', [token]);
  return r.rows[0]?.doc;
};

before(async () => {
  db = new PGlite();
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema); // the real schema file — not a paraphrase of it
});

after(async () => { await db?.close(); });

// ---- jsonb_deep_merge semantics ----------------------------------------------

test('merge is recursive: a pick lands without erasing its siblings', async () => {
  await seed();
  await merge({ festivals: { ef: { selections: { GRiZ: { Kev: 4 } } } } });
  await merge({ festivals: { ef: { selections: { 'Lane 8': { Kev: 3 } } } } });
  const doc = await readDoc();
  assert.equal(doc.festivals.ef.selections.GRiZ.Kev, 4, 'the first pick survives the second write');
  assert.equal(doc.festivals.ef.selections['Lane 8'].Kev, 3);
  assert.equal(doc.meta.name, 'DB Test', 'and untouched branches are untouched');
});

test('two people picking the same artist both land', async () => {
  await seed();
  await merge({ festivals: { ef: { selections: { GRiZ: { Kev: 4 } } } } });
  await merge({ festivals: { ef: { selections: { GRiZ: { Drew: 2 } } } } });
  const doc = await readDoc();
  assert.deepEqual(doc.festivals.ef.selections.GRiZ, { Kev: 4, Drew: 2 });
});

test('a leaf overwrite wins — changing your own pick level works', async () => {
  await seed();
  await merge({ festivals: { ef: { selections: { GRiZ: { Kev: 1 } } } } });
  await merge({ festivals: { ef: { selections: { GRiZ: { Kev: 4 } } } } });
  assert.equal((await readDoc()).festivals.ef.selections.GRiZ.Kev, 4);
});

test('ARRAYS ARE REPLACED WHOLESALE — this is why notes are keyed objects', async () => {
  // Load-bearing. If notes were ever stored as arrays, two people adding a note
  // at once would silently destroy one of them. This test is the reason the
  // rule exists, so it should fail loudly if the merge ever starts merging
  // arrays element-wise and someone "helpfully" switches notes back to a list.
  await seed({ ...baseDoc(), arr: ['a', 'b', 'c'] });
  await merge({ arr: ['z'] });
  assert.deepEqual((await readDoc()).arr, ['z'], 'the whole array is replaced, not merged');
});

test('the JS merge twins agree with the SQL, arrays included', async () => {
  // "The same shape runs on the server" (js/merge.js header) is a claim this
  // test makes executable. The twins diverged once — the client index-merged
  // arrays into {"0":..} while the SQL replaced them — and the divergence
  // sync-blocked a real device (2026-07-13). Merge the playlist-artists shape
  // through all three and demand byte-identical docs.
  const { deepMerge: clientMerge } = await import('../js/merge.js');
  const { deepMerge: serverMerge } = await import('../api/_lib/crew-shared.mjs');
  const start = { ...baseDoc(), spotify: { playlists: { ef: { id: 'x', artists: ['GRiZ', 'Lane 8'] } } } };
  const delta = { spotify: { playlists: { ef: { artists: ['GRiZ', 'Lane 8', 'Excision'] } }, clientId: 'a'.repeat(32) } };
  await seed(start);
  await merge(delta);
  const sql = await readDoc();
  assert.deepEqual(clientMerge(start, delta), sql, 'js/merge.js drifted from jsonb_deep_merge');
  assert.deepEqual(serverMerge(start, delta), sql, 'crew-shared deepMerge drifted from jsonb_deep_merge');
  assert.ok(Array.isArray(sql.spotify.playlists.ef.artists));
});

test('person merge: the exact production bytes land a crews entry and return id + doc', async () => {
  const PTOKEN = 'persontest_token_0123456789';
  const { PERSON_MERGE_SQL } = await import('../api/_lib/crew-sql.mjs');
  const { newPersonDoc, LIMITS: L } = await import('../api/_lib/crew-shared.mjs');
  await db.query('DELETE FROM persons WHERE token = $1', [PTOKEN]);
  await db.query('INSERT INTO persons (id, token, doc) VALUES ($1, $2, $3::jsonb)',
    ['pid_dbtest_01', PTOKEN, JSON.stringify(newPersonDoc('Kev', '2026-07-13T00:00:00Z'))]);
  const delta = { crews: { [TOKEN]: { name: 'Kev', crewName: 'DB Test' } } };
  const r = await db.query(PERSON_MERGE_SQL, [PTOKEN, JSON.stringify(delta), L.personDocBytes]);
  assert.equal(r.rows[0].id, 'pid_dbtest_01', 'merge returns the public id');
  assert.deepEqual(r.rows[0].doc.crews[TOKEN], { name: 'Kev', crewName: 'DB Test' });
  assert.equal(r.rows[0].doc.name, 'Kev', 'existing leaves survive');

  // The size cap is inside the same UPDATE — a merge that would exceed it
  // updates zero rows (tested by shrinking the cap, not by a giant payload).
  const refused = await db.query(PERSON_MERGE_SQL, [PTOKEN, JSON.stringify(delta), 10]);
  assert.equal(refused.rows.length, 0, 'over-cap merge refuses atomically');

  // Unknown token: zero rows, so the API can 404 honestly.
  const gone = await db.query(PERSON_MERGE_SQL, ['persontest_gone_0123456789', JSON.stringify(delta), L.personDocBytes]);
  assert.equal(gone.rows.length, 0);
});

test('re-running schema.sql on a PRE-v32 database retightens the pid CHECK', async () => {
  // CREATE TABLE IF NOT EXISTS silently skips an existing table, so the
  // {8,24}→{10,16} disjointness fix needed an explicit migration block —
  // this test builds the OLD schema first, applies the current file, and
  // proves a token-length id can no longer be inserted (Codex gate round 2).
  const old = new PGlite();
  await old.exec(`CREATE TABLE persons (
    id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,24}$'),
    token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{20,40}$'),
    doc JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await old.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await assert.rejects(
    old.query('INSERT INTO persons (id, token, doc) VALUES ($1, $2, $3::jsonb)',
      ['a'.repeat(20), 'upgradetest_token_0123456789', '{}']),
    /persons_id_check/,
    'a 20-char (token-length) id must violate the migrated CHECK');
  await old.query('INSERT INTO persons (id, token, doc) VALUES ($1, $2, $3::jsonb)',
    ['pid_upgrade_ok', 'upgradetest_token_0123456780', '{}']); // 14 chars still fits
  await old.close();
});

test('deletion is inexpressible — which is why tombstones exist', async () => {
  await seed();
  await merge({ people: { Drew: { colorIndex: 1 } } });
  await merge({ people: { Drew: null } });
  const doc = await readDoc();
  assert.notEqual(doc.people.Drew, undefined, 'null cannot remove a key; only a {removed:true} tombstone can');
});

test('a note from each of two people survives both writes', async () => {
  await seed();
  const note = (author, id, text) => ({
    festivals: { ef: { notes: { artist: { GRiZ: { [id]: { author, ts: '2026-07-12T00:00:00.000Z', text } } } } } },
  });
  await merge(note('Kev', 'Kev.note-0001', 'meet at the rail'));
  await merge(note('Drew', 'Drew.note-0001', 'bring earplugs'));
  const notes = (await readDoc()).festivals.ef.notes.artist.GRiZ;
  assert.equal(Object.keys(notes).length, 2, 'concurrent notes must not eat each other');
});

// ---- the invariants, as production enforces them ------------------------------

test('the people cap is enforced by the WHERE clause, not by trust', async () => {
  await seed();
  const people = {};
  for (let i = 0; i < LIMITS.activePeople + 1; i++) people[`P${i}`] = { colorIndex: i % 24 };
  const r = await merge({ people });
  assert.equal(r.rows.length, 0, 'the write is refused — no row updated');
  assert.equal(Object.keys((await readDoc()).people).length, 1, 'and the stored doc is untouched');
});

test('removed people do not count against the cap', async () => {
  await seed(); // the base doc already holds one active member (Kev)
  const people = {};
  const room = LIMITS.activePeople - 1; // fill the crew exactly to the cap
  for (let i = 0; i < room; i++) people[`P${i}`] = { colorIndex: i % 24 };
  for (let i = 0; i < 8; i++) people[`Gone${i}`] = { removed: true }; // ...plus tombstones

  const r = await merge({ people });
  assert.equal(r.rows.length, 1, 'tombstones are free — a crew that churns members is not punished forever');

  const doc = await readDoc();
  const active = Object.values(doc.people).filter((p) => !p.removed).length;
  assert.equal(active, LIMITS.activePeople, 'exactly at the cap, with 8 tombstones alongside');
});

test('the size cap is enforced against the CANDIDATE doc, before it is stored', async () => {
  await seed();
  const big = 'x'.repeat(LIMITS.docBytes + 1000);
  const r = await merge({ meta: { name: big } });
  assert.equal(r.rows.length, 0);
  assert.equal((await readDoc()).meta.name, 'DB Test', 'the oversized write never lands');
});

test('two active members differing only by case are refused BY THE MERGE', async () => {
  // The clients each check this against their own in-memory doc — which cannot
  // see the other phone joining in the same breath. The merge is the only place
  // both writes are visible.
  await seed();
  await merge({ people: { Drew: { colorIndex: 1 } } });
  const r = await merge({ people: { drew: { colorIndex: 2 } } });
  assert.equal(r.rows.length, 0, '"Drew" and "drew" must not become two people');
  const doc = await readDoc();
  assert.equal(doc.people.drew, undefined);
  assert.equal(doc.people.Drew.colorIndex, 1);
});

test('a removed member frees their name for re-use in another case', async () => {
  await seed();
  await merge({ people: { Drew: { removed: true } } });
  const r = await merge({ people: { drew: { colorIndex: 2 } } });
  assert.equal(r.rows.length, 1, 'a tombstone must not haunt the namespace forever');
});

test('the diagnostic says WHICH invariant refused the write', async () => {
  await seed();
  await merge({ people: { Drew: { colorIndex: 1 } } });
  const delta = JSON.stringify({ people: { drew: { colorIndex: 2 } } });
  const r = await db.query(DIAGNOSE_SQL, [TOKEN, delta, delta]);
  assert.equal(Number(r.rows[0].dupes), 1, 'a duplicate name reports as a duplicate name...');
  assert.ok(Number(r.rows[0].active) <= LIMITS.activePeople, '...not as "your crew is full"');
});

// ---- what this file can and CANNOT prove ---------------------------------------

test('many writers merged in sequence all survive (NOT a concurrency test — see below)', async () => {
  // This used to be called "CONCURRENT MERGES: every writer survives — the claim,
  // finally tested", and it was a lie. Codex disproved it (finish gate,
  // 2026-07-12): it swapped the inline UPDATE for the BANNED pre-lock CTE — the
  // exact shape that lost 2 of 6 writes in production — reran this Promise.all
  // for 50 rounds, and lost ZERO writes. The test stayed green through precisely
  // the regression it existed to catch.
  //
  // The reason: PGlite is a SINGLE connection. Promise.all does not make these
  // writers race; it serialises them. Nothing here can ever collide on a row lock,
  // so nothing here can ever prove the row lock works.
  //
  // Real concurrency lives in tests/db-concurrency.test.mjs, which uses Neon's
  // HTTP driver (one independent session per request) and carries a CONTROL that
  // asserts the banned CTE shape DOES lose writes — so we know the harness can
  // see a lost write, rather than trusting another green tick.
  //
  // What THIS file is genuinely good for is everything above: merge semantics and
  // the WHERE-clause invariants, run against real Postgres, in CI, with no
  // database to provision. That is worth having. It just isn't this.
  await seed();

  const writers = ['Kev', 'Drew', 'Sam', 'Riley', 'Alex', 'Jo'];
  for (const who of writers) {
    await merge({ festivals: { ef: { selections: { GRiZ: { [who]: 4 } } } } });
  }

  const picks = (await readDoc()).festivals.ef.selections.GRiZ;
  assert.deepEqual(
    Object.keys(picks).sort(), [...writers].sort(),
    'every writer\'s pick lands and none clobbers another (sequentially — the row-lock behaviour is db-concurrency.test.mjs)',
  );
});

test('the v4 and legacy deltas are not swapped — $2 and $3 select by the row\'s OWN version', async () => {
  // Codex: the helper above passes the SAME json for $2 and $3, so it could never
  // catch a swapped placeholder or an inverted CASE branch, even though production
  // deliberately sends DIFFERENT deltaV4 and delta values. Send different ones.
  const v4Delta = JSON.stringify({ festivals: { ef: { selections: { GRiZ: { Kev: 4 } } } } });
  const legacyDelta = JSON.stringify({ festivals: { ef: { selections: { GRiZ: { Kev: 3 } } } } });

  // A v4 stored doc must take $2 (the v4-mapped delta).
  await seed(); // baseDoc is v:4
  await db.query(MERGE_SQL, [TOKEN, v4Delta, legacyDelta, LIMITS.docBytes, LIMITS.activePeople]);
  assert.equal(
    (await readDoc()).festivals.ef.selections.GRiZ.Kev, 4,
    'a v4 doc takes the v4 delta ($2)',
  );

  // A legacy (v3) stored doc must take $3 — the client's un-remapped bytes.
  await seed({ ...baseDoc(), v: 3 });
  await db.query(MERGE_SQL, [TOKEN, v4Delta, legacyDelta, LIMITS.docBytes, LIMITS.activePeople]);
  assert.equal(
    (await readDoc()).festivals.ef.selections.GRiZ.Kev, 3,
    'a v3 doc takes the legacy delta ($3) — swap the placeholders and this flips',
  );
});

// ---- passes / recs (Discovery §3.4) --------------------------------------------
// Siblings of `selections` — same keyed-object/tombstone discipline. Tombstone
// convention: a `removed: boolean` leaf field (mirrors people[name].removed,
// NOT notes' one-way `deleted:true` — see api/_lib/crew-shared.mjs for why).

test('two people passing the same artist concurrently both survive the merge', async () => {
  await seed();
  await merge({ festivals: { ef: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  await merge({ festivals: { ef: { passes: { GRiZ: { Drew: { ts: '2026-07-30T00:01:00.000Z' } } } } } });
  const doc = await readDoc();
  assert.deepEqual(doc.festivals.ef.passes.GRiZ, {
    Kev: { ts: '2026-07-30T00:00:00.000Z' },
    Drew: { ts: '2026-07-30T00:01:00.000Z' },
  }, 'concurrent passes from two people must not eat each other');
});

test('pass then tombstone reads as passed-removed, per the removed:boolean convention', async () => {
  await seed();
  await merge({ festivals: { ef: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  await merge({ festivals: { ef: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:05:00.000Z', removed: true } } } } } });
  const leaf = (await readDoc()).festivals.ef.passes.GRiZ.Kev;
  assert.deepEqual(leaf, { ts: '2026-07-30T00:05:00.000Z', removed: true }, 'tombstone lands as removed:true, key never disappears');

  // And because it is `removed:boolean` (not a one-way sentinel), re-passing
  // by writing removed:false clears the tombstone — this is what makes the
  // convention support the "reversible" semantics spec §3.4 requires.
  await merge({ festivals: { ef: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:10:00.000Z', removed: false } } } } } });
  const leaf2 = (await readDoc()).festivals.ef.passes.GRiZ.Kev;
  assert.deepEqual(leaf2, { ts: '2026-07-30T00:10:00.000Z', removed: false }, 'removed:false un-tombstones the pass');
});

test('a rec written for Sam by Drew, then overwritten by Mara, holds Mara\'s by/ts', async () => {
  await seed();
  await merge({ festivals: { ef: { recs: { GRiZ: { Sam: { by: 'Drew', ts: '2026-07-30T00:00:00.000Z' } } } } } });
  await merge({ festivals: { ef: { recs: { GRiZ: { Sam: { by: 'Mara', ts: '2026-07-30T00:02:00.000Z' } } } } } });
  const leaf = (await readDoc()).festivals.ef.recs.GRiZ.Sam;
  assert.deepEqual(leaf, { by: 'Mara', ts: '2026-07-30T00:02:00.000Z' }, 'a second sender overwrites by/ts at the leaf');
});

test('a pass and a pick for the same artist/person both survive at the doc level (client resolves)', async () => {
  await seed();
  await merge({ festivals: { ef: { selections: { GRiZ: { Kev: 4 } } } } });
  await merge({ festivals: { ef: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  const fest = (await readDoc()).festivals.ef;
  assert.equal(fest.selections.GRiZ.Kev, 4, 'the pick is not dropped by a concurrent pass');
  assert.deepEqual(fest.passes.GRiZ.Kev, { ts: '2026-07-30T00:00:00.000Z' }, 'the pass is not dropped by the pick either — mutual exclusion is a CLIENT concern');
});

// ---- festival membership sync (the ghost-festival fix, 2026-07-13) -----------
// Adding a festival used to write only the local doc — The Crew's server doc
// held ONE festival while Kevin's device showed six. The fix syncs an empty
// selections object; this proves the real SQL creates the key from it.
test('an added festival with zero picks still lands as a key on the server doc', async () => {
  await seed();
  await merge({ festivals: { 'lollapalooza-2025': { selections: {} } } });
  const doc = await readDoc();
  assert.ok(doc.festivals['lollapalooza-2025'], 'the festival key exists crew-wide');
  assert.deepEqual(doc.festivals['lollapalooza-2025'].selections, {});
  assert.deepEqual(doc.festivals.ef.selections, {}, 'existing fests untouched');
  // And a later pick merges INTO it rather than replacing it.
  await merge({ festivals: { 'lollapalooza-2025': { selections: { 'Wild Rivers': { Kev: 4 } } } } });
  const doc2 = await readDoc();
  assert.equal(doc2.festivals['lollapalooza-2025'].selections['Wild Rivers'].Kev, 4);
});
