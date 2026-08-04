// js/discovery/setinfo.js — where and when an artist plays. Pure: no DOM, no
// state, no network. It moved out of artist-page.js on 2026-08-04 when the
// Discover deck card started showing set times too, and the point of the move
// was that BOTH surfaces read the same answer — so the two shapes it has to
// reconcile are worth pinning here rather than through either page's DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSetInfo, dayLabel, formatSetLinePlain } from '../js/discovery/setinfo.js';

// Shape 1: a LINEUP festival carries day/stage/time on the artists[] record.
const LINEUP = {
  dayMeta: { Thursday: { wd: 'Thu', num: 1, date: 'Jul 31' } },
  artists: [{ name: 'Direct', day: 'Thursday', stage: 'The Grove', time: '4:15 PM' }],
};

// Shape 2: a SCHEDULED festival's real times live under days[day].artists, and
// the artists[] record carries only day + stage (electric-forest-2026.json).
const SCHEDULED = {
  dayMeta: { 'Day 1': { wd: 'Thu', num: 1, date: 'Jun 25' } },
  days: {
    'Day 1': {
      artists: [
        { name: 'Effin', stage: 'Ranch Arena', time: '6:30 PM' },
        { name: 'Ranged', stage: 'Sherwood Court', time: '9:00 PM - 10:15 PM' },
      ],
    },
  },
  artists: [
    { name: 'Effin', day: 'Day 1', stage: 'Ranch Arena' },
    { name: 'Ranged', day: 'Day 1', stage: 'Sherwood Court' },
    { name: 'Unscheduled', day: 'Day 1', stage: 'Tripolee' },
    { name: 'Bare', genres: [] },
  ],
};

const meta = (fest, name) => fest.artists.find((a) => a.name === name);

test('a lineup entry answers from its own fields', () => {
  assert.deepEqual(findSetInfo(LINEUP, 'Direct', meta(LINEUP, 'Direct')),
    { day: 'Thursday', stage: 'The Grove', time: '4:15 PM' });
});

test('a scheduled festival is found through days[day].artists, not the lineup record', () => {
  // The lineup record has day + stage but NO time — the whole reason the day
  // scan exists. Answering from the record alone would silently drop the time.
  assert.deepEqual(findSetInfo(SCHEDULED, 'Effin', meta(SCHEDULED, 'Effin')),
    { day: 'Day 1', stage: 'Ranch Arena', time: '6:30 PM' });
});

test('a "start - end" slot reports the START time', () => {
  assert.equal(findSetInfo(SCHEDULED, 'Ranged', meta(SCHEDULED, 'Ranged')).time, '9:00 PM');
});

test('day-but-no-set degrades to day + stage rather than to nothing', () => {
  assert.deepEqual(findSetInfo(SCHEDULED, 'Unscheduled', meta(SCHEDULED, 'Unscheduled')),
    { day: 'Day 1', stage: 'Tripolee', time: null });
});

test('an artist with no day at all has no set info — never a placeholder', () => {
  assert.equal(findSetInfo(SCHEDULED, 'Bare', meta(SCHEDULED, 'Bare')), null);
  assert.equal(findSetInfo({}, 'Nobody', undefined), null);
});

test('dayLabel prefers the weekday from dayMeta, and falls back to the raw key', () => {
  assert.equal(dayLabel(SCHEDULED, 'Day 1'), 'THU');
  assert.equal(dayLabel(SCHEDULED, 'Day 9'), 'DAY 9'); // no dayMeta entry
  assert.equal(dayLabel({}, null), '');
});

test('formatSetLinePlain joins only the parts that exist', () => {
  assert.equal(
    formatSetLinePlain(SCHEDULED, findSetInfo(SCHEDULED, 'Effin', meta(SCHEDULED, 'Effin'))),
    'THU · 6:30 PM · Ranch Arena');
  // No time -> no empty separator left behind, which is what would show up on
  // a deck card for a lineup that has not published a schedule yet.
  assert.equal(
    formatSetLinePlain(SCHEDULED, findSetInfo(SCHEDULED, 'Unscheduled', meta(SCHEDULED, 'Unscheduled'))),
    'THU · Tripolee');
  assert.equal(formatSetLinePlain(SCHEDULED, null), '');
});
