// Where and when an artist plays — the one place that answers it.
//
// Its own module rather than an export from artist-page.js, because
// artist-page.js already imports the primary-action builders FROM deck.js: a
// set-info export in either file would close a real import cycle the moment
// the deck card started showing set times. Same reason my-day.js reaches
// openDeck through a lazy import instead of a static one.
//
// Two shapes exist in the wild: a lineup entry carries day/stage/time directly
// on the artists[] record (build spec 3.1's example); a SCHEDULED festival's
// real times live under fest.days[day].artists instead
// (electric-forest-2026.json etc.) — so this checks the direct fields first,
// then searches every day's computed sets for a match. Pure: uses time.js's
// computeDayArtists directly rather than state.getDayArtists's cache, which is
// keyed to the global activeFestivalId and would tie these to app boot state.
import { computeDayArtists } from '../time.js';

export function findSetInfo(fest, name, meta) {
  if (meta?.day && meta?.stage && meta?.time) {
    return { day: meta.day, stage: meta.stage, time: meta.time };
  }
  for (const day of Object.keys(fest?.days || {})) {
    const dayData = fest.days[day];
    if (!dayData?.artists?.length) continue;
    const hit = computeDayArtists(dayData).find((a) => a.name === name);
    if (hit) return { day, stage: hit.stage, time: hit.startStr };
  }
  if (meta?.day) return { day: meta.day, stage: meta.stage || null, time: null };
  return null;
}

export function dayLabel(fest, day) {
  const meta = (fest?.dayMeta || {})[day];
  return (meta?.wd || day || '').toUpperCase();
}

export function formatSetLinePlain(fest, setInfo) {
  if (!setInfo) return '';
  const bits = [];
  if (setInfo.day) bits.push(dayLabel(fest, setInfo.day));
  if (setInfo.time) bits.push(setInfo.time);
  if (setInfo.stage) bits.push(setInfo.stage);
  return bits.join(' · ');
}
