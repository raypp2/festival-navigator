// Schedule assist engine (js/discovery/gaps.js) — pure, node:test only. Feeds
// real js/time.js computeDayArtists() output through dayPlan/findGaps/
// findClashes/gapCandidates, the same path js/discovery/my-day.js consumes in
// the browser. Cross-midnight fixtures are load-bearing: a 12:30 AM set must
// sort and gap/clash correctly against 10:30 PM sets on the "same" day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDayArtists } from '../js/time.js';
import {
  dayPlan, computeDayBounds, findGaps, findClashes, gapCandidates,
  clockLabel, windowLabel,
} from '../js/discovery/gaps.js';

// ---- fixture: a full day, cross-midnight, gaps + clashes + a sliver -------------
const DAY = {
  artists: [
    { name: 'FourTet', stage: 'Main', time: '2:00 PM - 3:00 PM' },
    { name: 'Passed1', stage: 'Main', time: '4:00 PM - 4:20 PM' },
    { name: 'SanHolo', stage: 'Main', time: '4:30 PM - 5:15 PM' },
    { name: 'Phrva', stage: 'Second', time: '5:00 PM - 5:45 PM' },
    { name: 'GRiZ', stage: 'Main', time: '6:30 PM - 8:00 PM' },
    { name: 'TinyGapA', stage: 'Main', time: '8:00 PM - 8:20 PM' },
    { name: 'TinyGapB', stage: 'Second', time: '8:40 PM - 9:00 PM' }, // 20-min sliver after TinyGapA — suppressed
    { name: 'Skrillex', stage: 'Main', time: '9:00 PM - 10:15 PM' },
    { name: 'AlisonWonderland', stage: 'Second', time: '9:15 PM - 10:30 PM' }, // overlaps Skrillex
    { name: 'GapOwl', stage: 'Second', time: '11:00 PM - 11:40 PM' }, // undecided, inside the late gap
    { name: 'EdgeArtist', stage: 'Second', time: '10:20 PM - 10:50 PM' }, // only 20 min inside the gap — excluded
    { name: 'LateOwl', stage: 'Second', time: '12:30 AM - 1:30 AM' }, // cross-midnight
  ],
};
const dayArtists = computeDayArtists(DAY);

const ME = 'Ray';
const PICKS = {
  FourTet: { [ME]: 4 },
  GRiZ: { [ME]: 2 },
  TinyGapA: { [ME]: 1 },
  TinyGapB: { [ME]: 1 },
  Skrillex: { [ME]: 4 },
  AlisonWonderland: { [ME]: 4 },
  LateOwl: { [ME]: 1 },
};
const PASSES = { Passed1: { [ME]: { ts: '2026-07-29T00:00:00.000Z' } } };

const plan = dayPlan({ dayArtists, picks: PICKS, me: ME });
const bounds = computeDayBounds(dayArtists);

// ---- dayPlan --------------------------------------------------------------------
test('dayPlan keeps only my level>=1 sets, sorted chronologically', () => {
  assert.deepEqual(plan.map((s) => s.name), [
    'FourTet', 'GRiZ', 'TinyGapA', 'TinyGapB', 'Skrillex', 'AlisonWonderland', 'LateOwl',
  ]);
  const fourTet = plan.find((s) => s.name === 'FourTet');
  assert.equal(fourTet.startMin, 14 * 60);
  assert.equal(fourTet.endMin, 15 * 60);
  assert.equal(fourTet.level, 4);
});

test('dayPlan excludes undecided and passed sets', () => {
  const names = plan.map((s) => s.name);
  assert.ok(!names.includes('SanHolo'));
  assert.ok(!names.includes('Passed1'));
});

// ---- computeDayBounds -------------------------------------------------------------
test('computeDayBounds spans every set that day, not just marked ones', () => {
  assert.equal(bounds.startMin, 14 * 60); // FourTet 2:00 PM
  assert.equal(bounds.endMin, 25 * 60 + 30); // LateOwl ends 1:30 AM -> 25:30 after-midnight
});

// ---- findGaps ---------------------------------------------------------------------
test('findGaps reports the window between two marked sets, with a human label', () => {
  const gaps = findGaps(plan, bounds);
  const first = gaps.find((g) => g.startMin === 15 * 60); // FourTet ends 3:00 PM
  assert.ok(first, 'a gap opens right after FourTet');
  assert.equal(first.endMin, 18 * 60 + 30); // GRiZ starts 6:30 PM
  assert.equal(first.label, '3:00 – 6:30 PM');
});

test('findGaps suppresses slivers under 45 minutes (TinyGapA -> TinyGapB, 20 min)', () => {
  const gaps = findGaps(plan, bounds);
  const sliver = gaps.find((g) => g.startMin === 20 * 60 + 20); // TinyGapA ends 8:20 PM
  assert.equal(sliver, undefined, 'a 20-minute gap between two of my own sets never surfaces');
});

test('findGaps merges overlapping marked sets (Skrillex/Alison clash) into one block — no gap between them', () => {
  const gaps = findGaps(plan, bounds);
  // Skrillex starts 9:00 PM (21:00), Alison ends 10:30 PM (22:30) — the merged
  // block runs 21:00-22:30; the next gap must start at 22:30, not at either
  // individual set's own end.
  const postClash = gaps.find((g) => g.startMin === 22 * 60 + 30);
  assert.ok(postClash, 'the next gap starts at the merged block end, not mid-clash');
});

test('findGaps crosses midnight correctly: Alison (10:30 PM) -> LateOwl (12:30 AM next)', () => {
  const gaps = findGaps(plan, bounds);
  const lateGap = gaps.find((g) => g.startMin === 22 * 60 + 30);
  assert.equal(lateGap.endMin, 24 * 60 + 30); // 12:30 AM as after-midnight minutes
  assert.equal(lateGap.label, '10:30 PM – 12:30 AM');
});

test('findGaps: nothing marked yet -> one whole-day gap spanning dayBounds', () => {
  const emptyPlan = dayPlan({ dayArtists, picks: {}, me: ME });
  const gaps = findGaps(emptyPlan, bounds);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].startMin, bounds.startMin);
  assert.equal(gaps[0].endMin, bounds.endMin);
});

test('findGaps: no dayBounds (unscheduled) -> no gaps, not a throw', () => {
  assert.deepEqual(findGaps(plan, null), []);
});

// ---- findClashes --------------------------------------------------------------------
test('findClashes groups the Skrillex/Alison overlap with severity "musts" (both level 4)', () => {
  const clashes = findClashes(plan);
  assert.equal(clashes.length, 1);
  const [clash] = clashes;
  assert.deepEqual(clash.sets.map((s) => s.name).sort(), ['AlisonWonderland', 'Skrillex']);
  assert.equal(clash.severity, 'musts');
});

test('findClashes: an overlap with only one must is severity "picks"', () => {
  const day = { artists: [
    { name: 'A', stage: 'Main', time: '9:00 PM - 10:00 PM' },
    { name: 'B', stage: 'Second', time: '9:30 PM - 10:30 PM' },
  ] };
  const artists = computeDayArtists(day);
  const p = dayPlan({ dayArtists: artists, picks: { A: { [ME]: 4 }, B: { [ME]: 2 } }, me: ME });
  const clashes = findClashes(p);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].severity, 'picks');
});

test('findClashes: a 3-way overlap merges into a single group', () => {
  const day = { artists: [
    { name: 'A', stage: 'Main', time: '9:00 PM - 11:00 PM' },
    { name: 'B', stage: 'Second', time: '9:30 PM - 10:00 PM' },
    { name: 'C', stage: 'Third', time: '9:45 PM - 10:15 PM' },
  ] };
  const artists = computeDayArtists(day);
  const p = dayPlan({ dayArtists: artists, picks: { A: { [ME]: 1 }, B: { [ME]: 1 }, C: { [ME]: 1 } }, me: ME });
  const clashes = findClashes(p);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].sets.length, 3);
});

test('findClashes: back-to-back (non-overlapping) sets are not a clash', () => {
  const day = { artists: [
    { name: 'A', stage: 'Main', time: '9:00 PM - 10:00 PM' },
    { name: 'B', stage: 'Second', time: '10:00 PM - 11:00 PM' },
  ] };
  const artists = computeDayArtists(day);
  const p = dayPlan({ dayArtists: artists, picks: { A: { [ME]: 4 }, B: { [ME]: 4 } }, me: ME });
  assert.deepEqual(findClashes(p), []);
});

// ---- gapCandidates ------------------------------------------------------------------
const RANKED = [
  { name: 'GapOwl', score: 5 },
  { name: 'EdgeArtist', score: 100 }, // deliberately high — must still be excluded by overlap threshold
  { name: 'SanHolo', score: 3 },
  { name: 'Phrva', score: 9 },
];

test('gapCandidates only includes artists overlapping the gap by >= 30 minutes', () => {
  const gaps = findGaps(plan, bounds);
  const lateGap = gaps.find((g) => g.startMin === 22 * 60 + 30); // 10:30 PM -> 12:30 AM
  const cands = gapCandidates({ gap: lateGap, dayArtists, ranked: RANKED, me: ME, picks: PICKS, passes: PASSES });
  const names = cands.map((c) => c.name);
  assert.ok(names.includes('GapOwl'), 'GapOwl sits fully inside the gap');
  assert.ok(!names.includes('EdgeArtist'), 'EdgeArtist only overlaps 20 minutes — below the 30-min floor');
});

test('gapCandidates excludes artists I have already decided on (picked or passed)', () => {
  const firstGap = findGaps(plan, bounds).find((g) => g.startMin === 15 * 60); // 3:00 -> 6:30 PM
  const cands = gapCandidates({ gap: firstGap, dayArtists, ranked: RANKED, me: ME, picks: PICKS, passes: PASSES });
  const names = cands.map((c) => c.name);
  assert.ok(!names.includes('Passed1'), 'I passed on Passed1 — never a candidate');
  assert.ok(names.includes('SanHolo'));
  assert.ok(names.includes('Phrva'));
});

test('gapCandidates orders by the caller-supplied ranked score, descending', () => {
  const firstGap = findGaps(plan, bounds).find((g) => g.startMin === 15 * 60);
  const cands = gapCandidates({ gap: firstGap, dayArtists, ranked: RANKED, me: ME, picks: PICKS, passes: PASSES });
  assert.deepEqual(cands.map((c) => c.name), ['Phrva', 'SanHolo']); // 9 > 3
});

test('gapCandidates respects a limit param (chips cap at 3, callers may ask for more)', () => {
  const day = { artists: [
    { name: 'W', stage: 'Main', time: '4:00 PM - 4:30 PM' },
    { name: 'X', stage: 'Second', time: '4:15 PM - 4:45 PM' },
    { name: 'Y', stage: 'Third', time: '4:30 PM - 5:00 PM' },
    { name: 'Z', stage: 'Fourth', time: '4:45 PM - 5:15 PM' },
  ] };
  const artists = computeDayArtists(day);
  const gap = { startMin: 16 * 60, endMin: 17 * 60, label: '4:00 – 5:00 PM' };
  const ranked = [{ name: 'W', score: 4 }, { name: 'X', score: 3 }, { name: 'Y', score: 2 }, { name: 'Z', score: 1 }];
  const capped = gapCandidates({ gap, dayArtists: artists, ranked, me: ME, picks: {}, passes: {}, limit: 3 });
  assert.equal(capped.length, 3);
  assert.deepEqual(capped.map((c) => c.name), ['W', 'X', 'Y']);
});

// ---- label helpers ------------------------------------------------------------------
test('clockLabel formats minutes without a meridiem', () => {
  assert.equal(clockLabel(16 * 60 + 30), '4:30');
  assert.equal(clockLabel(24 * 60 + 30), '12:30'); // after-midnight wraps back to 12-hour clock
});

test('windowLabel drops the start meridiem when it matches the end', () => {
  assert.equal(windowLabel(16 * 60, 18 * 60), '4:00 – 6:00 PM');
});

test('windowLabel keeps the start meridiem when it differs from the end', () => {
  assert.equal(windowLabel(22 * 60 + 30, 24 * 60 + 30), '10:30 PM – 12:30 AM');
});
