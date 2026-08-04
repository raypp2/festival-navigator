// scripts/backfill-soundcloud.mjs — the gate that decides whether a searched
// SoundCloud profile is allowed to become an artist's soundcloudSlug.
//
// EVERY fixture below is a real payload captured from SoundCloud on
// 2026-08-04, including the wrong ones. That matters more here than usual:
// the whole reason this gate exists is that plausible-looking accounts are
// everywhere, and an invented fixture would encode what we IMAGINE a decoy
// looks like instead of what one actually looks like. `/honeyluv` really is a
// 66-follower account called "Honey Bunnss" — that is the exact shape naive
// slug-guessing walked into (19 of 20 guessed slugs resolved, 2 were right).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldName, nameForms, isBillingVariant, nameMatchKind, handleMatchesName, scoreCandidate, pickBest,
} from '../scripts/backfill-soundcloud.mjs';

// --- real profiles, right artist ------------------------------------------
const LOUD_LUXURY = { id: 20362178, username: 'LOUD LUXURY', permalink: 'loudluxury', verified: true, followers_count: 79111, track_count: 152 };
const SAN_HOLO = { id: 36551572, username: 'San Holo', permalink: 'sanholobeats', verified: true, followers_count: 478560, track_count: 240 };
const OBSKUR = { username: 'Obskϋr', permalink: 'obskurofficial', verified: true, followers_count: 48371, track_count: 51 };
const BUNT = { username: 'BUNT.', permalink: 'buntmusic', verified: true, followers_count: 85063, track_count: 106 };
const RIORDAN = { username: 'Riordan', permalink: 'riordanuk', verified: true, followers_count: 77227, track_count: 78 };
const HONEYLUV = { username: 'HoneyLuv', permalink: 'honeyluvmusic', verified: true, followers_count: 6289, track_count: 39 };
const PACKET_LOSS = { username: 'Packet Loss', permalink: 'pvcketloss', verified: false, followers_count: 6314, track_count: 15 };
const MAU_P = { username: 'Mau P', permalink: 'realmaup', verified: true, followers_count: 97733, track_count: 222 };
const RILO_KILEY = { username: 'Rilo Kiley', permalink: 'rilokileyofficial', verified: false, followers_count: 830, track_count: 59 };

// --- real profiles, WRONG artist (what guessing lands on) ------------------
const NOT_HONEYLUV = { username: 'Honey Bunnss', permalink: 'honeyluv', verified: false, followers_count: 66, track_count: 3 };
const NOT_BUNT = { username: 'Bunt', permalink: 'bunt', verified: false, followers_count: 1, track_count: 0 };
const DOT = { username: 'dot', permalink: 'dot', verified: false, followers_count: 705, track_count: 41 };

// --- real profiles behind auto-generated handles ---------------------------
// Both went straight into `auto` on the first dry run (2026-08-04) purely
// because `username` matched. They may well be the right artists; the point is
// that nothing but free text said so.
const SKILAH = { username: 'SKILAH', permalink: 'user-133963194', verified: false, followers_count: 7254, track_count: 29 };
const ALYSSA_JOLEE = { username: 'ALYSSA JOLEE', permalink: 'jmo-844048447', verified: false, followers_count: 6001, track_count: 9 };

test('foldName folds diacritics, homoglyphs and punctuation to one key', () => {
  assert.equal(foldName('BUNT.'), 'bunt');
  assert.equal(foldName('Loud Luxury'), 'loudluxury');
  // Greek upsilon-with-dialytika, not a Latin u — NFD alone leaves it Greek.
  assert.equal(foldName('Obskür'), foldName('Obskϋr'));
  assert.equal(foldName('Høldën'), 'holden'); // ø has no NFD decomposition; ë does
  // Real username: padded with invisible bidi marks.
  assert.equal(foldName('‏‏‎ ‎Dr. Dog'), 'drdog');
});

test('nameForms strips vanity affixes, keeping the original', () => {
  const forms = nameForms('sanholobeats');
  assert.ok(forms.has('sanholobeats'));
  assert.ok(forms.has('sanholo'));
  assert.ok(nameForms('riordanuk').has('riordan'));
  assert.ok(nameForms('obskurofficial').has('obskur'));
  // Too short to strip down to — refuse rather than invent a 2-char stem.
  assert.ok(!nameForms('djuk').has(''));
});

test('nameMatchKind: real artist handles match their billed name', () => {
  assert.equal(nameMatchKind('Loud Luxury', LOUD_LUXURY), 'exact');
  assert.equal(nameMatchKind('San Holo', SAN_HOLO), 'exact'); // via the "beats" affix
  assert.equal(nameMatchKind('Obskür', OBSKUR), 'exact'); // via homoglyph + "official"
  assert.equal(nameMatchKind('BUNT.', BUNT), 'exact');
  assert.equal(nameMatchKind('Riordan', RIORDAN), 'exact');
  assert.equal(nameMatchKind('Mau P', MAU_P), 'exact'); // via the "real" prefix
  assert.equal(nameMatchKind('Packet Loss', PACKET_LOSS), 'exact'); // username, not the vanity handle
});

// The decoy OWNS the clean handle — /honeyluv is "Honey Bunnss" — so the name
// check alone says exact and would happily write it. This is the single most
// important assertion in the file: it pins down that name identity is not the
// defense, and that the follower/track signals are what actually stand between
// a stranger's account and an artist page.
test('a name check alone cannot reject the decoy — the gate has to', () => {
  assert.equal(nameMatchKind('HoneyLuv', NOT_HONEYLUV), 'exact');
  assert.equal(scoreCandidate('HoneyLuv', NOT_HONEYLUV).verdict, 'reject');
});

test('scoreCandidate auto-accepts verified profiles with real catalogues', () => {
  for (const [name, hit] of [['Loud Luxury', LOUD_LUXURY], ['San Holo', SAN_HOLO], ['Obskür', OBSKUR],
    ['BUNT.', BUNT], ['Riordan', RIORDAN], ['HoneyLuv', HONEYLUV], ['Mau P', MAU_P]]) {
    assert.equal(scoreCandidate(name, hit).verdict, 'auto', `${name} should auto-accept`);
  }
});

// The documented COST of requiring the handle to carry the name. Packet Loss
// is the real artist — 6,314 followers, 15 tracks, exact username — but its
// handle is leetspeak (`pvcketloss`), which a human reads instantly and a
// matcher cannot. It demotes to review rather than auto, and that is the
// trade we chose: a false accept puts a stranger's tracks on an artist page,
// a false reject leaves a gap that was already there.
test('an unverified profile behind a stylised handle demotes to review, not reject', () => {
  const r = scoreCandidate('Packet Loss', PACKET_LOSS);
  assert.equal(r.verdict, 'review');
  assert.equal(r.kind, 'exact'); // never lose the fact that it IS the artist
});

test('an unverified profile whose handle DOES carry the name still auto-applies', () => {
  // Capochino: 42,297 followers, 93 tracks, handle `capochinomusic` — the
  // "music" affix is stripped, the name matches, no human needed.
  const r = scoreCandidate('Capochino', {
    username: 'Capochino', permalink: 'capochinomusic', verified: false, followers_count: 42297, track_count: 93,
  });
  assert.equal(r.verdict, 'auto');
});

test('scoreCandidate sends a small unverified match to review, not to auto', () => {
  const r = scoreCandidate('Rilo Kiley', RILO_KILEY);
  assert.equal(r.verdict, 'review'); // 830 followers is under the auto bar
  assert.equal(r.kind, 'exact'); // ...but it IS the right artist, so never reject
});

test('an unverified match resting only on the free-text username goes to review', () => {
  // The handle carries no trace of the name — anyone can call themselves
  // "SKILAH" this afternoon, but /user-133963194 asserts nothing.
  assert.equal(handleMatchesName('Skilah', SKILAH), false);
  assert.equal(nameMatchKind('Skilah', SKILAH), 'exact'); // username matches...
  assert.equal(scoreCandidate('Skilah', SKILAH).verdict, 'review'); // ...but that is not enough

  assert.equal(handleMatchesName('Alyssa Jolee', ALYSSA_JOLEE), false);
  const r = scoreCandidate('Alyssa Jolee', ALYSSA_JOLEE);
  assert.equal(r.verdict, 'review');
  assert.ok(r.reasons.some((x) => /does not carry the name/.test(x)));
});

test('a verified account still auto-applies behind any handle', () => {
  // Verification is SoundCloud attesting to the account holder, which is a
  // stronger claim than any handle heuristic — it must not be second-guessed.
  assert.equal(scoreCandidate('Madison Palmer', { username: 'Madison Palmer', permalink: 'user-99', verified: true, followers_count: 5971, track_count: 84 }).verdict, 'auto');
});

test('scoreCandidate never auto-applies a short common name without a checkmark', () => {
  // "dot" is a word before it is an artist. 705 followers and 41 tracks look
  // fine in isolation; that is exactly why this rule is not a follower bar.
  const r = scoreCandidate('DOT', DOT);
  assert.equal(r.verdict, 'review');
  assert.ok(r.reasons.some((x) => /short\/common name/.test(x)));
});

test('scoreCandidate rejects wrong-name and empty profiles outright', () => {
  assert.equal(scoreCandidate('HoneyLuv', NOT_HONEYLUV).verdict, 'reject');
  const empty = scoreCandidate('BUNT.', NOT_BUNT);
  assert.equal(empty.verdict, 'reject');
  assert.ok(empty.reasons.some((x) => /no tracks/.test(x)));
});

test('isBillingVariant flags slots that are not one artist', () => {
  assert.ok(isBillingVariant('Torren Foot B2B Rawolf'));
  assert.ok(isBillingVariant('Of The Trees (Sunset Set)'));
  assert.equal(isBillingVariant('Loud Luxury'), null);
  assert.equal(isBillingVariant('Ganja White Night'), null); // "night" is not a set variant
});

test('pickBest ranks the real artist above the decoy regardless of search order', () => {
  const { best, runnerUp } = pickBest('HoneyLuv', [NOT_HONEYLUV, HONEYLUV]);
  assert.equal(best.hit.permalink, 'honeyluvmusic');
  assert.equal(best.verdict, 'auto');
  assert.equal(runnerUp.hit.permalink, 'honeyluv');
  assert.equal(runnerUp.verdict, 'reject');
});

test('pickBest survives an empty search result', () => {
  const { best } = pickBest('Nobody At All', []);
  assert.equal(best, null);
});
