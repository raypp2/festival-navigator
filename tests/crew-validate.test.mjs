import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIncoming, validateMergedDoc, newCrewDoc, deepMerge, TOKEN_RE, LIMITS,
} from '../api/_lib/crew-shared.mjs';

const ok = (data) => assert.equal(validateIncoming(data).ok, true, JSON.stringify(validateIncoming(data)));
const bad = (data) => assert.equal(validateIncoming(data).ok, false);

test('valid full-shaped overlay passes', () => {
  ok({
    people: { Kevin: { color: '239, 68, 68' }, Rob: { color: '59, 130, 246', removed: true } },
    festivals: { 'acl-2026-w1': { selections: { GRiZ: { Kevin: 3, Rob: 0 } } } },
    affinity: { Kevin: { GRiZ: { songs: 12, followed: true } } },
    spotify: { clientId: 'a'.repeat(32) },
    meta: { name: 'Forest Fam' },
  });
});

test('unknown sections and keys rejected', () => {
  bad({ hax: {} });
  bad({ people: { Kevin: { color: '1, 2, 3', admin: true } } });
  bad({ festivals: { 'acl-2026': { schedule: {} } } });
  bad({ affinity: { Kevin: { GRiZ: { rank: 1 } } } });
  bad({ meta: { createdAt: 'x' } }); // createdAt is server-owned
});

test('person names: HTML-dangerous and control chars rejected', () => {
  bad({ people: { '<img src=x>': { color: '1, 2, 3' } } });
  bad({ people: { 'a"b': { color: '1, 2, 3' } } });
  bad({ people: { 'x\u0000y': { color: '1, 2, 3' } } }); // embedded control char
  ok({ people: { 'Uncle Jesse': { color: '1, 2, 3' } } }); // spaces in real names are fine
  bad({ people: { [' padded ']: { color: '1, 2, 3' } } });
  bad({ people: { ['x'.repeat(25)]: { color: '1, 2, 3' } } });
  ok({ people: { "Zoë O-Møller.Jr": { color: '1, 2, 3' } } }); // real-name chars fine
});

test('levels bounded 0..4 (v4: 4 = must), integers only', () => {
  bad({ festivals: { f: { selections: { A: { Kevin: 5 } } } } });
  bad({ festivals: { f: { selections: { A: { Kevin: -1 } } } } });
  bad({ festivals: { f: { selections: { A: { Kevin: 1.5 } } } } });
  bad({ festivals: { f: { selections: { A: { Kevin: '3' } } } } });
});

test('festival ids slug-only', () => {
  bad({ festivals: { 'ACL 2026!': { selections: {} } } });
  ok({ festivals: { 'edc-orlando-2026': { selections: {} } } });
});

test('spotify clientId 32-hex or empty', () => {
  bad({ spotify: { clientId: 'not-hex' } });
  ok({ spotify: { clientId: '' } });
  ok({ spotify: { clientId: '0123456789abcdef0123456789abcdef' } });
});

test('affinity songs bounded', () => {
  bad({ affinity: { K: { A: { songs: -1 } } } });
  bad({ affinity: { K: { A: { songs: 1000000 } } } });
  ok({ affinity: { K: { A: { songs: 0 } } } });
});

test('arrays and primitives rejected where objects expected', () => {
  bad([1, 2]);
  bad('hello');
  bad({ people: [] });
  bad({ festivals: { f: { selections: { A: [3] } } } });
});

test('merged-doc invariants: people cap counts only active', () => {
  const doc = newCrewDoc('x', 'now');
  for (let i = 0; i < LIMITS.activePeople; i++) doc.people['P' + i] = { color: '1, 2, 3' };
  assert.equal(validateMergedDoc(doc).ok, true);
  doc.people.Extra = { color: '1, 2, 3' };
  assert.equal(validateMergedDoc(doc).ok, false);
  doc.people.Extra.removed = true; // tombstones don't count
  assert.equal(validateMergedDoc(doc).ok, true);
});

test('merged-doc invariants: size cap', () => {
  const doc = newCrewDoc('x', 'now');
  doc.festivals = { f: { selections: {} } };
  const sel = doc.festivals.f.selections;
  for (let i = 0; i < 4000; i++) sel['Artist ' + i] = { Kevin: 3, Drew: 1, Rob: 2, Colby: 1, A: 1, B: 2, C: 3 };
  assert.equal(validateMergedDoc(doc).ok, false);
});

test('token shape', () => {
  assert.equal(TOKEN_RE.test('abc'), false);
  assert.equal(TOKEN_RE.test('x'.repeat(27)), true);
  assert.equal(TOKEN_RE.test('has spaces here-no-good-x'), false);
});

test('merge + validate round trip preserves crew semantics', () => {
  const doc = newCrewDoc('Fam', '2026-07-07');
  const merged = deepMerge(doc, { people: { Kevin: { color: '1, 2, 3' } }, festivals: { ef: { selections: { GRiZ: { Kevin: 3 } } } } });
  assert.equal(merged.meta.name, 'Fam');
  assert.equal(merged.festivals.ef.selections.GRiZ.Kevin, 3);
  assert.equal(validateMergedDoc(merged).ok, true);
});

// ---- passes / recs (Discovery §3.4) ------------------------------------------

test('passes: valid shapes accepted, tombstone (removed) accepted', () => {
  ok({ festivals: { f: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  ok({ festivals: { f: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z', removed: true } } } } } });
  ok({ festivals: { f: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z', removed: false } } } } } });
});

test('passes: an array where passes should be an object is rejected', () => {
  bad({ festivals: { f: { passes: [] } } });
  bad({ festivals: { f: { passes: { GRiZ: [] } } } });
  bad({ festivals: { f: { passes: { GRiZ: { Kev: ['not-a-leaf'] } } } } });
});

test('passes: a numeric ts is rejected', () => {
  bad({ festivals: { f: { passes: { GRiZ: { Kev: { ts: 1753833600000 } } } } } });
});

test('passes: bad person key, bad artist key, unknown leaf key rejected', () => {
  bad({ festivals: { f: { passes: { GRiZ: { '<img>': { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  bad({ festivals: { f: { passes: { '': { Kev: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  bad({ festivals: { f: { passes: { GRiZ: { Kev: { ts: '2026-07-30T00:00:00.000Z', extra: 1 } } } } } });
  bad({ festivals: { f: { passes: { GRiZ: { Kev: { removed: true } } } } } }); // ts required even on tombstone
});

test('recs: valid shapes accepted, tombstone (removed) accepted', () => {
  ok({ festivals: { f: { recs: { GRiZ: { Sam: { by: 'Drew', ts: '2026-07-30T00:00:00.000Z' } } } } } });
  ok({ festivals: { f: { recs: { GRiZ: { Sam: { by: 'Drew', ts: '2026-07-30T00:00:00.000Z', removed: true } } } } } });
});

test('recs: a rec leaf missing "by" is rejected', () => {
  bad({ festivals: { f: { recs: { GRiZ: { Sam: { ts: '2026-07-30T00:00:00.000Z' } } } } } });
  bad({ festivals: { f: { recs: { GRiZ: { Sam: { by: '', ts: '2026-07-30T00:00:00.000Z' } } } } } });
});

test('recs: a numeric ts is rejected', () => {
  bad({ festivals: { f: { recs: { GRiZ: { Sam: { by: 'Drew', ts: 1753833600000 } } } } } });
});

test('recs: an array where recs should be an object is rejected', () => {
  bad({ festivals: { f: { recs: [] } } });
  bad({ festivals: { f: { recs: { GRiZ: [] } } } });
});

test('recs: bad forPerson key, bad by name, unknown leaf key rejected', () => {
  bad({ festivals: { f: { recs: { GRiZ: { '<img>': { by: 'Drew', ts: '2026-07-30T00:00:00.000Z' } } } } } });
  bad({ festivals: { f: { recs: { GRiZ: { Sam: { by: '<img>', ts: '2026-07-30T00:00:00.000Z' } } } } } });
  bad({ festivals: { f: { recs: { GRiZ: { Sam: { by: 'Drew', ts: '2026-07-30T00:00:00.000Z', note: 'hi' } } } } } });
});

test('prototype-pollution keys rejected everywhere and skipped by merge', () => {
  bad({ people: { ['__proto__']: { color: '1, 2, 3' } } });
  bad({ people: { constructor: { color: '1, 2, 3' } } });
  bad({ festivals: { f: { selections: { ['__proto__']: { Kevin: 1 } } } } });
  bad({ affinity: { Kevin: { prototype: { songs: 1 } } } });
  const out = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}'));
  assert.equal(out.safe, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});
