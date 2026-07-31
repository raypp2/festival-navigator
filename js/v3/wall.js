// The wall — v3's main screen (atlas 21c/21d, lineup mode). Renders day
// sections of aura cards from the live crew doc, owns the tap cycle with the
// undo toast, search/sort, and the mobile dock's scrollspy.
//
// SECURITY RULE (Codex P2 gate, finding 6): every artist name, person name,
// and note text in this file goes through textContent / createElement — no
// innerHTML interpolation of doc-derived strings, ever.
import * as state from '../state.js';
import * as model from './model.js';
import { LEVEL_LABELS_V4 } from '../parse.js';
import { computeLanes } from '../overlap.js';
import { activityMinutes } from '../time.js';
import { auraBackground, whoCorner, aboutCorner, nameColor, subColor } from './aura.js';
import { BOARD } from './palette.js';
import { notesSection } from './notes.js'; // runtime-only cycle with this module (colorIndexOf) — safe
import { rankLineup } from '../discovery/score.js'; // For-you sort (M5) — reasons + ranking, same source the deck uses

// Genre canon fallback for a repaint that races ahead of app.js's async load
// (js/discovery/genres.js's own EMPTY_CANON shape, kept local rather than
// imported so this module never has to know about the fetch/cache module).
const EMPTY_CANON = { canon: [], synonyms: {}, suppress: [] };

// ---- person -> board color ---------------------------------------------------
// v4 people carry colorIndex. Legacy people carry a "R, G, B" string from the
// old 12-color palette; map its palette position onto the board (both are
// hue-spread, positions correspond) — deterministic on every device, no
// writes needed. Unknown strings hash the name (stable, collision-tolerable).
export function colorIndexOf(name, personObj) {
  if (Number.isInteger(personObj?.colorIndex)) return personObj.colorIndex;
  const legacyIdx = state.COLOR_PALETTE.indexOf(personObj?.color);
  if (legacyIdx >= 0) return legacyIdx % BOARD.length;
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % BOARD.length;
}

// ---- card data ----------------------------------------------------------------
function cardPeople(artist, picks, meName) {
  const byPerson = picks[artist] || {};
  const peopleObj = state.people();
  const out = [];
  for (const [person, level] of Object.entries(byPerson)) {
    const p = peopleObj[person];
    if (!state.isActivePerson(p)) continue;
    out.push({ name: person, colorIndex: colorIndexOf(person, p), isYou: person === meName, level });
  }
  return out;
}

const BOOKMARK_PATH = 'M1 1h8v11l-4-3-4 3z';

function svgBookmark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '7'); svg.setAttribute('height', '9'); svg.setAttribute('viewBox', '0 0 10 13');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', BOOKMARK_PATH); path.setAttribute('fill', '#fff');
  svg.appendChild(path);
  return svg;
}

export function renderCard(artistName, ctx, opts = {}) {
  const people = cardPeople(artistName, ctx.picks, ctx.meName);
  const el = document.createElement('div');
  el.className = 'card' + (opts.cell ? ' cell' : '') + (opts.time && !opts.cell ? ' timed' : '');
  el.dataset.artist = artistName;
  // For-you sort (M5): exactly one reason ribbon, or none — crew-type reasons
  // render NO text ribbon, the who-corner already says it (design notes).
  const showReasonRibbon = opts.reason && opts.reason.type !== 'crew';
  if (showReasonRibbon) el.classList.add('has-reason');
  if (opts.passed) el.classList.add('wall-passed');
  // Keyboard-first card (AX-1): real button semantics, and the accessible
  // name carries what SIGHTED users see — your level, the crew's picks, note
  // count, Spotify badge (audit 4.3). The explicit label overrides children,
  // so anything not folded in here is invisible to AT.
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const myLevel = (ctx.picks[artistName] || {})[ctx.meName] || 0;
  const crewCount = people.filter((p) => !p.isYou).length;
  const noteCountForLabel = model.noteCount(state.crewDoc, ctx.fid, 'artist', artistName);
  const affForLabel = ctx.affinity ? ctx.affinity[artistName.toLowerCase()] : null;
  const labelParts = [`${artistName} — ${myLevel === 4 ? 'must' : (LEVEL_LABELS_V4[myLevel] || 'not picked').toLowerCase()}`];
  if (crewCount) labelParts.push(`${crewCount} crew`);
  if (noteCountForLabel) labelParts.push(`${noteCountForLabel} note${noteCountForLabel === 1 ? '' : 's'}`);
  if (affForLabel) labelParts.push('in your Spotify');
  el.setAttribute('aria-label', labelParts.join(', '));
  el.title = artistName; // lane-split cells truncate hard — hover recovers (audit 9.2)
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onTap(artistName, el); }
  });
  // Stash render opts on the node so refreshCard can reproduce this exact
  // render — a single-card refresh must preserve every invariant the full
  // render established (CORE-1/CORE-3).
  if (opts.time) el.dataset.time = opts.time;
  if (opts.tag) {
    el.dataset.tag = opts.tag;
    const tag = document.createElement('span');
    tag.className = 'chip-weekend';
    tag.textContent = opts.tag;
    el.appendChild(tag);
  }
  const { background, animated } = auraBackground(people);
  el.style.background = background;
  if (animated && !ctx.lowPower) {
    el.classList.add('animated');
    const grain = document.createElement('span');
    grain.className = 'card-grain';
    el.appendChild(grain);
  }
  if (showReasonRibbon) {
    const ribbon = document.createElement('span');
    ribbon.className = 'card-reason-ribbon';
    ribbon.textContent = opts.reason.text;
    el.appendChild(ribbon);
  }
  if (opts.passed) {
    const passedChip = document.createElement('span');
    passedChip.className = 'card-passed-chip';
    passedChip.textContent = 'PASSED';
    el.appendChild(passedChip);
  }
  const nm = document.createElement('span');
  nm.className = 'name';
  nm.style.color = nameColor(people);
  nm.textContent = artistName;
  el.appendChild(nm);
  if (opts.time) {
    const t = document.createElement('span');
    t.className = 'time';
    t.style.color = subColor(people);
    t.textContent = opts.time;
    el.appendChild(t);
  }

  const about = document.createElement('span');
  about.className = 'corner-about';
  const noteN = model.noteCount(state.crewDoc, ctx.fid, 'artist', artistName);
  const aff = ctx.affinity ? ctx.affinity[artistName.toLowerCase()] : null;
  for (const chip of aboutCorner({ noteCount: noteN, spotify: aff ? { songs: aff.songs || 0, followed: !!aff.followed } : null })) {
    // The clickable note-count chip is a real button (audit 4.4); the Spotify
    // chip stays a passive span.
    const clickable = chip.kind === 'notes' && ctx.onOpenNotes;
    const c = document.createElement(clickable ? 'button' : 'span');
    c.className = chip.kind === 'notes' ? 'chip-notes' : 'chip-spotify';
    c.textContent = chip.label;
    if (chip.kind === 'spotify' && chip.followed) c.appendChild(svgBookmark());
    // Corner glow for high-affinity artists (followed + 5+ songs): a soft
    // Spotify-green mini-aura behind the badge corner — same visual language
    // as the people-auras, card geometry untouched (Kevin picked this over
    // rings/outlines 2026-07-13; thicker outlines broke pixel rhythm before).
    if (chip.kind === 'spotify' && chip.hot) {
      const glow = document.createElement('span');
      glow.className = 'spot-glow';
      glow.setAttribute('aria-hidden', 'true');
      el.appendChild(glow);
    }
    if (clickable) {
      c.style.cursor = 'pointer';
      c.setAttribute('aria-label', `${chip.label} note${chip.label === '1' ? '' : 's'} for ${artistName}`);
      c.addEventListener('click', (e) => { e.stopPropagation(); ctx.onOpenNotes(artistName); });
    }
    about.appendChild(c);
  }
  el.appendChild(about);

  // Pointer-fine hover affordance (DT-6): notes are reachable without knowing
  // the long-press. ✎, never a music note — that glyph belongs to Spotify.
  if (ctx.onOpenNotes) {
    const pen = document.createElement('button');
    pen.className = 'note-affordance';
    pen.textContent = '✎';
    pen.setAttribute('aria-label', `Notes for ${artistName}`);
    pen.addEventListener('click', (e) => { e.stopPropagation(); ctx.onOpenNotes(artistName); });
    el.appendChild(pen);
  }

  // Long-press (mobile) opens the artist notes sheet (~500ms, atlas 21g).
  // Digitizer jitter fires pointermove even on a still finger, so cancel only
  // past a real movement threshold (10px) — a genuine scroll-drag cancels,
  // a held finger does not (Codex P3 trail, finding 1).
  if (ctx.onOpenNotes) {
    let pressTimer = null;
    let longPressed = false;
    let startX = 0, startY = 0;
    el.addEventListener('pointerdown', (e) => {
      longPressed = false;
      startX = e.clientX; startY = e.clientY;
      // If a poll repaint detached this node mid-press, the new node owns the
      // gesture — a fire from the orphan would open the sheet uninvited.
      pressTimer = setTimeout(() => {
        // isConnected covers repaint detachment; offsetParent covers a screen
        // change hiding the wall mid-press (audit 10.2) — a sheet must never
        // pop over Settings or the landing after the fact.
        if (!el.isConnected || el.offsetParent === null) return;
        longPressed = true;
        ctx.onOpenNotes(artistName);
      }, 500);
    });
    const cancel = () => clearTimeout(pressTimer);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
    });
    el.addEventListener('click', (e) => { if (longPressed) { e.stopImmediatePropagation(); longPressed = false; } }, true);
  }

  const who = document.createElement('span');
  who.className = 'corner-who';
  for (const m of whoCorner(people)) {
    const s = document.createElement('span');
    s.className = 'mark' + (m.kind === 'ghost' ? ' ghost' : '');
    if (m.kind !== 'ghost') {
      s.style.width = m.width + 'px';
      s.style.background = m.fill;
      s.style.border = '1px solid ' + m.stroke;
      s.style.fontSize = m.kind === 'must' ? '7.5px' : '0px';
    }
    s.textContent = m.label;
    who.appendChild(s);
  }
  el.appendChild(who);

  el.addEventListener('click', () => ctx.onTap(artistName, el));
  return el;
}

// Re-render one card in place after a pick change (no full-wall repaint).
// The fresh card must land exactly where the old one was: same render opts
// (cell variant, time line) AND the placement the full render computed —
// grid position and lane split live as inline styles on the node (CORE-1).
const PLACEMENT_PROPS = ['grid-column', 'grid-row', 'width', 'margin-left', 'min-height'];
export function refreshCard(el, artistName, ctx) {
  const fresh = renderCard(artistName, ctx, {
    cell: el.classList.contains('cell'),
    time: el.dataset.time || undefined,
    tag: el.dataset.tag || undefined,
  });
  for (const prop of PLACEMENT_PROPS) {
    const v = el.style.getPropertyValue(prop);
    if (v) fresh.style.setProperty(prop, v);
  }
  // Keyboard users keep their place: replacing a focused node silently dumps
  // focus to <body>, forcing a full re-Tab per pick tap (audit 4.1).
  const hadFocus = document.activeElement === el;
  el.replaceWith(fresh);
  if (hadFocus) fresh.focus();
  return fresh;
}

// ---- day grouping (lineup mode) -----------------------------------------------
// Split a combined day string ("Saturday & Sunday") into real days. Returns
// null unless EVERY part matches a known day name — an unrecognized part means
// the string isn't a clean combination and stays a literal group (ST-1).
export function splitDays(dayStr, knownDays) {
  if (!dayStr || !knownDays?.length) return null;
  // No comma in the separator set: real combinations use & / + / "and", while
  // commas live inside single-day labels ("Wednesday, Sept 16 (pre-party)").
  const parts = String(dayStr).split(/\s*[&+/]\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const canon = new Map(knownDays.map((d) => [d.toLowerCase(), d]));
  const mapped = parts.map((p) => canon.get(p.toLowerCase()));
  return mapped.every(Boolean) ? mapped : null;
}

// The festival's real days, in intended order: dayMeta keys when curated,
// else the atomic (non-combined) day values in first-appearance order.
export function knownDaysOf(fest) {
  const meta = Object.keys(fest.dayMeta || {});
  if (meta.length) return meta;
  const days = [];
  for (const a of fest.artists || []) {
    if (!a.day || /[&+/]|\s+and\s+/i.test(a.day)) continue;
    if (!days.includes(a.day)) days.push(a.day);
  }
  return days;
}

// Artists keep billing order inside each group. Groups follow known-day order
// first, then first appearance; artists with no day form THE LINEUP block.
// A multi-day artist appears under EACH of its days (spec F4), never as a
// combined "Day X & Day Y" section.
export function groupByDay(artists, knownDays = []) {
  const groups = new Map();
  const add = (key, a) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  };
  for (const a of artists) {
    const split = splitDays(a.day, knownDays);
    if (split) for (const d of split) add(d, a);
    else add(a.day || '', a);
  }
  if (!knownDays.length) return groups;
  const ordered = new Map();
  if (groups.has('')) ordered.set('', groups.get(''));
  for (const d of knownDays) if (groups.has(d)) ordered.set(d, groups.get(d));
  for (const [k, v] of groups) if (!ordered.has(k)) ordered.set(k, v);
  return ordered;
}

function dayHeader(label, sub, opts = {}) {
  const rule = document.createElement('div');
  rule.className = 'day-rule';
  rule.dataset.day = label;
  const d = document.createElement('span');
  d.className = 'day';
  d.textContent = label.toUpperCase();
  const dt = document.createElement('span');
  dt.className = 'date';
  dt.textContent = sub || '';
  const line = document.createElement('span');
  line.className = 'line';
  rule.append(d, dt, line);
  // Day notes live at the day's front door (NT-2), not three scrolls past it.
  if (opts.onOpenNotes) {
    const chip = document.createElement('button');
    chip.className = 'chip-notes';
    chip.style.cssText = 'height: 17px; cursor: pointer; flex: none;';
    chip.textContent = opts.noteCount ? `${opts.noteCount} ✎` : '+ ✎';
    chip.setAttribute('aria-label', `Notes for ${label}`);
    chip.addEventListener('click', opts.onOpenNotes);
    rule.appendChild(chip);
  }
  return rule;
}

// The day rule's subtitle: real dates beat internal numbering (ST-4).
function dayRuleSub(meta) {
  if (!meta) return '';
  return [meta.wd, meta.date || (meta.num ? `Day ${meta.num}` : '')].filter(Boolean).join(' · ');
}

// ---- search / sort / weekend -----------------------------------------------------
// Fold diacritics so "tiesto" finds Tiësto — nobody hunts for the ë on a
// phone keyboard in a field (audit walker anomaly, verified real).
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function applyFilter(artists, query) {
  const q = fold((query || '').trim());
  if (!q) return artists;
  return artists.filter((a) => fold(a.name).includes(q));
}

// Multi-weekend fests (ST-3): 'all' shows everyone; W1/W2 shows that
// weekend's lineup (artists playing both always stay).
export function applyWeekend(artists, weekend) {
  if (!weekend || weekend === 'all') return artists;
  return artists.filter((a) => !a.weekends || a.weekends === 'both' || a.weekends === weekend);
}

// For-you ranking (M5): rankLineup over the WHOLE billing list (never the
// already-searched/weekend-filtered subset applySort receives — billing
// position has to mean the real bill, or a search would skew the score), then
// looked up by name. ctx.canonData is populated by app.js's one-time genre
// canon fetch; a repaint that races ahead of it degrades to billing/crew
// signal only (no genre-driven reasons yet) rather than blocking the wall.
function forYouRanked(ctx) {
  const fest = state.fest();
  return rankLineup({
    artists: fest.artists || [],
    picks: ctx.picks || {},
    passes: ctx.passes || {},
    me: ctx.meName,
    canonData: ctx.canonData || EMPTY_CANON,
  });
}

export function applySort(artists, mode, ctx) {
  const arr = [...artists];
  const myLevel = (a) => (ctx.picks[a.name] || {})[ctx.meName] || 0;
  const crewHeat = (a) => Object.values(ctx.picks[a.name] || {}).reduce((s, l) => s + l, 0);
  if (mode === 'az') arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'mine') arr.sort((a, b) => myLevel(b) - myLevel(a));
  else if (mode === 'crew') arr.sort((a, b) => crewHeat(b) - crewHeat(a));
  else if (mode === 'foryou') {
    const rankIndex = new Map(forYouRanked(ctx).map((r, i) => [r.name, i]));
    const isPassed = (a) => !!(ctx.passes && ctx.passes[a.name] && ctx.passes[a.name][ctx.meName]);
    arr.sort((a, b) => {
      // My passed artists sink to the bottom, regardless of score.
      const ap = isPassed(a), bp = isPassed(b);
      if (ap !== bp) return ap ? 1 : -1;
      const ai = rankIndex.has(a.name) ? rankIndex.get(a.name) : Infinity;
      const bi = rankIndex.has(b.name) ? rankIndex.get(b.name) : Infinity;
      return ai - bi;
    });
  }
  return arr; // 'billing' and 'day' keep source order; day grouping handles days
}

// ---- set-times grid (atlas 21d: the same cards, on a clock) ---------------------
// One vertical page: every day gets a rule + a clock grid. Mobile shows ~2
// stages and swipes; desktop fits them all.
//
// The stage columns are CANONICAL across days (model.canonicalStages): every
// day renders the same columns in the same order on the same template, all
// day scrollers mirror ONE horizontal position, and a single sticky strip
// carries the stage names for the whole page — so scrolling straight down a
// column stays on one stage from Thursday to Sunday. The strip lives OUTSIDE
// the horizontal scrollers because position:sticky can't escape an
// overflow-x container (the same physics that put the hour rail outside).
export function computeTimesLayout(fest, getDayArtists) {
  const stages = model.canonicalStages(fest);
  const days = Object.keys(fest.days || {});
  // The everything-else column is reserved festival-wide: if ANY day needs
  // it, every day gets it, or the shared template (and the strip) would lie.
  const hasEE = days.some((d) => ((fest.activities || {})[d] || []).length > 0
    || getDayArtists(d).some((a) => !stages.includes(a.stage)));
  return {
    stages,
    hasEE,
    colsTemplate: `repeat(${stages.length + (hasEE ? 1 : 0)}, minmax(150px, 1fr))`,
  };
}

function stageHead(label, { muted = false } = {}) {
  const h = document.createElement('div');
  h.className = 'stage-head';
  if (muted) h.style.color = 'var(--text-secondary)'; // neutral tint — not a stage
  h.textContent = label;
  h.title = label; // long names ellipsize — hover recovers
  return h;
}

function renderStageStrip(layout) {
  const strip = document.createElement('div');
  strip.className = 'times-wrap stage-strip';
  const spacer = document.createElement('div');
  spacer.className = 'strip-rail'; // matches the hour rail's width for column alignment
  const scroll = document.createElement('div');
  scroll.className = 'times-scroll';
  const grid = document.createElement('div');
  grid.className = 'times-grid';
  grid.style.gridTemplateColumns = layout.colsTemplate;
  grid.style.gridTemplateRows = '32px';
  for (const s of layout.stages) grid.appendChild(stageHead(s));
  if (layout.hasEE) grid.appendChild(stageHead('EVERYTHING ELSE', { muted: true }));
  scroll.appendChild(grid);
  strip.append(spacer, scroll);
  return strip;
}

// Mirror one horizontal position across the strip and every day's scroller.
// Setting scrollLeft programmatically fires a scroll event on the target; the
// lastSet map recognizes that echo (same element, same value) and drops it
// instead of ping-ponging.
export function wireTimesScrollSync(root) {
  const scrollers = [...root.querySelectorAll('.times-scroll')];
  if (scrollers.length < 2) return;
  const lastSet = new Map();
  for (const s of scrollers) {
    s.addEventListener('scroll', () => {
      if (lastSet.get(s) === s.scrollLeft) { lastSet.delete(s); return; }
      for (const o of scrollers) {
        if (o !== s && o.scrollLeft !== s.scrollLeft) {
          lastSet.set(o, s.scrollLeft);
          o.scrollLeft = s.scrollLeft;
        }
      }
    }, { passive: true });
  }
}

function renderScheduledDay(root, day, ctx, layout) {
  const fest = state.fest();
  const computed = state.getDayArtists(day);
  const stages = layout.stages;
  const meta = (fest.dayMeta || {})[day];
  root.appendChild(dayHeader(day, dayRuleSub(meta), {
    noteCount: model.noteCount(state.crewDoc, ctx.fid, 'day', day),
    onOpenNotes: ctx.onOpenDayNotes ? () => ctx.onOpenDayNotes(day) : null,
  }));

  const acts = (fest.activities || {})[day] || [];

  // A day with no timed sets must not mint a NaN grid (Math.min of nothing
  // is Infinity). Activities-only days render as a quiet list; truly empty
  // days say so instead of rendering nothing.
  if (!computed.length) {
    if (acts.length) {
      const list = document.createElement('div');
      list.className = 'ee-col';
      for (const a of acts) list.appendChild(eeActivityRow(a));
      root.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: var(--text-tertiary); font-size: 12px; font-weight: 600; padding: 6px 0 2px;';
      empty.textContent = 'No set times for this day yet.';
      root.appendChild(empty);
    }
    if (ctx.onNotesChange) root.appendChild(notesSection('day', day, day, ctx, ctx.onNotesChange));
    return;
  }

  // Cards are laid out on DISPLAY extents: every set gets at least 30 visual
  // minutes (2 rows) so its name + time always fit. The lane math further
  // down runs on these same extents — the readability floor can make two
  // sets overlap VISUALLY that never overlap in time, and they need lanes
  // exactly like real overlaps (Codex arc gate, P1).
  const drawn = computed.map((a) => ({
    ...a, endMin: Math.max(a.endMin ?? a.startMin + 60, a.startMin + 30),
  }));
  const dayStart = Math.min(...drawn.map((a) => a.startMin));
  const dayEnd = Math.max(...drawn.map((a) => a.endMin));
  const startRow = Math.floor(dayStart / 15);
  const rows = Math.ceil(dayEnd / 15) - startRow;

  // Rail and grid are siblings sharing one rows template: the hour axis stays
  // pinned at the left while stage columns scroll (CORE-2). Stage names live
  // in the shared sticky strip above, not in per-day header rows.
  const rowsTemplate = `repeat(${rows}, 20px)`;
  const wrap = document.createElement('div');
  wrap.className = 'times-wrap';
  const rail = document.createElement('div');
  rail.className = 'times-rail';
  rail.style.gridTemplateRows = rowsTemplate;
  const scroll = document.createElement('div');
  scroll.className = 'times-scroll';
  scroll.dataset.day = day;
  const grid = document.createElement('div');
  grid.className = 'times-grid';
  grid.style.gridTemplateRows = rowsTemplate;
  grid.style.gridTemplateColumns = layout.colsTemplate;

  for (let r = startRow; r < startRow + rows; r++) {
    if (r % 4 !== 0) continue; // hour marks only
    const mins = r * 15;
    const hr = Math.floor(mins / 60) % 24;
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.style.gridRow = String(r - startRow + 1);
    label.textContent = `${hr % 12 === 0 ? 12 : hr % 12} ${hr < 12 ? 'AM' : 'PM'}`;
    rail.appendChild(label);
  }
  // Everything that isn't a stage set lives in ONE far-right column (ST-2):
  // activities (workshops, ceremonies) and any set whose stage isn't a known
  // column. Anything with stage+time stays on the clock.
  const strays = drawn.filter((a) => stages.indexOf(a.stage) === -1);
  const dayHasEE = acts.length > 0 || strays.length > 0;

  // Same-stage overlaps split their column into side-by-side lanes (the old
  // grid's fix, dropped in the first v3 pass — the Codex P6 sweep surfaced
  // that EF genuinely has these; js/overlap.js is very much alive). Lanes are
  // computed on the drawn extents above, so display-floored collisions split
  // the column too.
  const lanes = computeLanes(drawn);
  for (const a of drawn) {
    const col = stages.indexOf(a.stage);
    if (col === -1) continue; // strays render in the everything-else column
    const cell = renderCard(a.name, ctx, { cell: true, time: a.startStr });
    cell.style.gridColumn = String(col + 1);
    const row = Math.floor(a.startMin / 15) - startRow + 1;
    // endMin here IS the display extent — minimum 2 rows (44px), below which
    // the name + time can't fit (Kevin's screenshot, 2026-07-12).
    const span = Math.max(1, Math.ceil((a.endMin - a.startMin) / 15));
    cell.style.gridRow = `${row} / span ${span}`;
    cell.style.minHeight = '0';
    const lane = lanes.get(a);
    if (lane && lane.lanes > 1) {
      // Lane math assumes border-box sizing (v3.css sets it on .card):
      // width% + margin-left% ≤ 100% keeps every lane inside its own column.
      cell.style.width = `calc(${(100 / lane.lanes).toFixed(3)}% - 2px)`;
      cell.style.marginLeft = `${((lane.lane * 100) / lane.lanes).toFixed(3)}%`;
    }
    grid.appendChild(cell);
  }

  if (dayHasEE) {
    const col = document.createElement('div');
    col.className = 'ee-col';
    col.style.gridColumn = String(stages.length + 1);
    col.style.gridRow = `1 / span ${rows}`;
    const entries = [
      ...strays.map((a) => ({ min: a.startMin, artist: a })),
      ...acts.map((a) => ({ min: activityMinutes((a.time || '').split(' - ')[0] || '12:00 PM'), act: a })),
    ].sort((x, y) => x.min - y.min);
    for (const e of entries) {
      if (e.artist) {
        col.appendChild(renderCard(e.artist.name, ctx, { cell: true, time: e.artist.startStr }));
      } else {
        col.appendChild(eeActivityRow(e.act));
      }
    }
    grid.appendChild(col);
  }
  scroll.appendChild(grid);
  wrap.append(rail, scroll);
  root.appendChild(wrap);

  if (ctx.onNotesChange) root.appendChild(notesSection('day', day, day, ctx, ctx.onNotesChange));
}

// One quiet row in the everything-else column (also the whole body of an
// activities-only day).
function eeActivityRow(act) {
  const rowEl = document.createElement('div');
  rowEl.className = 'ee-item';
  const t = document.createElement('span');
  t.className = 'ee-time';
  t.textContent = act.time || '';
  const n = document.createElement('span');
  n.className = 'ee-name';
  n.textContent = act.name;
  const v = document.createElement('span');
  v.className = 'ee-venue';
  v.textContent = act.venue || '';
  rowEl.append(t, n, v);
  return rowEl;
}

// ---- the wall ------------------------------------------------------------------
// The repaint boundary preserves ephemeral client state (audit Class 1): a
// remote sync tearing down #wall-root must never cost the user their scroll
// position or a half-typed note. Harvest before teardown, restore after.
function harvestEphemera(root) {
  const scrolls = new Map();
  // Every timetable scroller mirrors one shared position now — harvest it once.
  const anyScroller = root.querySelector('.times-scroll');
  if (anyScroller && anyScroller.scrollLeft) scrolls.set('*', anyScroller.scrollLeft);
  const drafts = new Map();
  for (const input of root.querySelectorAll('.composer input[data-draft-key]')) {
    if (input.value) {
      drafts.set(input.dataset.draftKey, {
        value: input.value,
        focused: document.activeElement === input,
        caret: input.selectionStart,
      });
    }
  }
  return { scrolls, drafts };
}

function restoreEphemera(root, { scrolls, drafts }) {
  const left = scrolls.get('*');
  if (left) {
    for (const s of root.querySelectorAll('.times-scroll')) s.scrollLeft = left;
  }
  for (const input of root.querySelectorAll('.composer input[data-draft-key]')) {
    const d = drafts.get(input.dataset.draftKey);
    if (!d) continue;
    input.value = d.value;
    if (d.focused) {
      input.focus();
      try { input.setSelectionRange(d.caret, d.caret); } catch { /* type quirks */ }
    }
  }
}

export function renderWall(root, ctx) {
  const ephemera = harvestEphemera(root);
  renderWallInner(root, ctx);
  restoreEphemera(root, ephemera);
}

function renderWallInner(root, ctx) {
  root.textContent = '';
  const fest = state.fest();
  const scheduled = fest.days && Object.keys(fest.days).length;

  if (scheduled && !ctx.query) {
    const layout = computeTimesLayout(fest, state.getDayArtists);
    if (layout.stages.length) root.appendChild(renderStageStrip(layout));
    for (const day of Object.keys(fest.days)) renderScheduledDay(root, day, ctx, layout);
    wireTimesScrollSync(root);
    if (ctx.onNotesChange) {
      root.appendChild(dayHeader(`NOTES · ${fest.name.toUpperCase()}`, ''));
      root.appendChild(notesSection('fest', null, '', ctx, ctx.onNotesChange));
    }
    return;
  }

  // Searching a scheduled fest must still answer "where and when" (CORE-4):
  // matches render per day, chronological, each card carrying stage · time.
  if (scheduled) {
    const q = ctx.query.trim().toLowerCase();
    const scheduledNames = new Set();
    let any = false;
    for (const day of Object.keys(fest.days)) {
      const computed = state.getDayArtists(day);
      computed.forEach((a) => scheduledNames.add(a.name));
      const matches = computed.filter((a) => a.name.toLowerCase().includes(q))
        .sort((x, y) => x.startMin - y.startMin);
      if (!matches.length) continue;
      any = true;
      const meta = (fest.dayMeta || {})[day];
      root.appendChild(dayHeader(day, meta ? `${meta.wd || ''} ${meta.num || ''}`.trim() : ''));
      const grid = document.createElement('div');
      grid.className = 'wall-grid';
      for (const a of matches) grid.appendChild(renderCard(a.name, ctx, { time: `${a.stage} · ${a.startStr}` }));
      root.appendChild(grid);
    }
    // Lineup entries with no set time yet still deserve to be findable.
    const extra = applyFilter((fest.artists || []).filter((a) => !scheduledNames.has(a.name)), ctx.query);
    if (extra.length) {
      any = true;
      root.appendChild(dayHeader('EVERYTHING ELSE', 'NO SET TIME YET'));
      const grid = document.createElement('div');
      grid.className = 'wall-grid';
      for (const a of extra) grid.appendChild(renderCard(a.name, ctx));
      root.appendChild(grid);
    }
    if (!any) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: var(--text-tertiary); font-size: 12px; font-weight: 600; text-align: center; padding: 30px 0;';
      empty.textContent = 'No artists match — try fewer letters.';
      root.appendChild(empty);
    }
    return;
  }

  const artists = applySort(applyFilter(applyWeekend(fest.artists || [], ctx.weekend), ctx.query), ctx.sort, ctx);

  if (!artists.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color: var(--text-tertiary); font-size: 12px; font-weight: 600; text-align: center; padding: 30px 0;';
    empty.textContent = ctx.query ? 'No artists match — try fewer letters.' : 'Lineup coming soon — notes work now. Leave the first one below.';
    root.appendChild(empty);
    if (ctx.query) return;
    // An empty lineup is when planning notes matter MOST (CORE-10) — the
    // festival composer stays.
    if (ctx.onNotesChange) {
      root.appendChild(dayHeader(`NOTES · ${fest.name.toUpperCase()}`, ''));
      root.appendChild(notesSection('fest', null, '', ctx, ctx.onNotesChange));
    }
    return;
  }

  const grouped = ctx.sort === 'billing' || ctx.sort === 'day'
    ? groupByDay(artists, knownDaysOf(fest))
    : new Map([['', artists]]);
  // For-you (M5): one reason lookup per repaint, reused for every card in the
  // flat list — rankLineup already ran once inside applySort to order this
  // same `artists` array; this is the metadata half of that same ranking.
  const forYouMeta = ctx.sort === 'foryou' ? new Map(forYouRanked(ctx).map((r) => [r.name, r])) : null;
  for (const [day, list] of grouped) {
    const meta = (fest.dayMeta || {})[day];
    root.appendChild(dayHeader(
      day || (ctx.sort === 'foryou' ? 'FOR YOU' : 'THE LINEUP'),
      day ? dayRuleSub(meta) : (ctx.sort === 'billing' ? 'BILLING ORDER' : (ctx.sort === 'foryou' ? 'EVERY CARD SHOWS WHY' : '')),
      day && ctx.onOpenDayNotes ? {
        noteCount: model.noteCount(state.crewDoc, ctx.fid, 'day', day),
        onOpenNotes: () => ctx.onOpenDayNotes(day),
      } : {},
    ));
    const grid = document.createElement('div');
    grid.className = 'wall-grid';
    const showTags = !ctx.weekend || ctx.weekend === 'all';
    for (const a of list) {
      const tag = showTags && (a.weekends === 'W1' || a.weekends === 'W2') ? a.weekends : undefined;
      const fy = forYouMeta ? forYouMeta.get(a.name) : null;
      // A reason explains a RECOMMENDATION — an artist I already decided on
      // (picked, musted, or passed) isn't one, so it carries no ribbon even
      // when it ranks high (my own must "sharing a genre with my musts" was
      // just noise, caught on the first live For-you render).
      const undecided = !((ctx.picks[a.name] || {})[ctx.meName]) && !(fy && fy.passed);
      grid.appendChild(renderCard(a.name, ctx, { tag, reason: fy && undecided ? fy.reason : null, passed: fy ? fy.passed : false }));
    }
    root.appendChild(grid);
    // Day notes with personal pins live under each real day's cards (21e).
    if (day && ctx.onNotesChange) {
      root.appendChild(notesSection('day', day, day, ctx, ctx.onNotesChange));
    }
  }

  // Fest-wide notes close the wall (21c bottom).
  if (ctx.onNotesChange) {
    root.appendChild(dayHeader(`NOTES · ${fest.name.toUpperCase()}`, ''));
    root.appendChild(notesSection('fest', null, '', ctx, ctx.onNotesChange));
  }
}

let toastTimer = null;

// A toast with no action — for states the user can't undo (migration gate,
// offline explanations). Never render a button that does nothing (CORE-17).
export function showToast(container, message, ms = 4000) {
  container.textContent = '';
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  const msg = document.createElement('span');
  msg.textContent = message;
  toast.appendChild(msg);
  container.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { container.textContent = ''; }, ms);
}

// ---- undo toast (design open question 1: tap-5 clears via undo window) ---------
export function showUndoToast(container, message, onUndo) {
  container.textContent = '';
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  const msg = document.createElement('span');
  msg.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'undo-btn';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => { clearTimeout(toastTimer); container.textContent = ''; onUndo(); });
  toast.append(msg, btn);
  container.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { container.textContent = ''; }, 5000);
}

// ---- day-nav scrollspy ------------------------------------------------------------
// One observer drives every tab container (mobile dock + desktop rail): the
// active day is a single fact rendered in two places.
export function wireScrollspy(containers, wallRoot) {
  const list = Array.isArray(containers) ? containers : [containers];
  const tabs = list.flatMap((c) => [...c.querySelectorAll('.day-tab')]);
  if (!tabs.length) return () => {};
  const tabDays = new Set(tabs.map((t) => t.dataset.day));
  // Observe ONLY headers that correspond to a tab — the NOTES/EVERYTHING-ELSE
  // pseudo-headers share dayHeader() anatomy and used to de-highlight every
  // tab when they scrolled into the band (audit 1.3).
  const headers = [...wallRoot.querySelectorAll('.day-rule[data-day]')]
    .filter((h) => tabDays.has(h.dataset.day));
  const setActive = (day) => {
    tabs.forEach((t) => {
      const on = t.dataset.day === day;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
  };
  // The first day is on screen at load — say so instead of nothing.
  setActive(tabs[0].dataset.day);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      setActive(e.target.dataset.day);
    }
  }, { rootMargin: '-10% 0px -80% 0px' });
  headers.forEach((h) => io.observe(h));

  // The observer only speaks when a header crosses a thin band at 10–20% of the
  // viewport. Any scroll big enough to clear that band in one go — a scrollbar
  // drag, End, Page-Down, a hard fling on a 6,000px page — never trips it, so
  // the day tab kept pointing at Thursday while you stood in Sunday's grid, and
  // stayed wrong until a header happened to drift back through the band. A nav
  // indicator that lies about where you are is worse than no indicator.
  //
  // So geometry gets the last word: after every scroll, the active day is simply
  // the last day-rule you have scrolled past. rAF-throttled, and it reads the
  // same --jump-offset the day-tab jump lands against, so the two agree.
  let ticking = false;
  const syncFromGeometry = () => {
    ticking = false;
    if (!headers.length) return;
    const offset = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--jump-offset'),
    ) || 8;
    let current = headers[0];
    for (const h of headers) {
      if (h.getBoundingClientRect().top <= offset + 1) current = h;
      else break; // headers are in document order
    }
    setActive(current.dataset.day);
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(syncFromGeometry);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    io.disconnect();
    window.removeEventListener('scroll', onScroll);
  };
}
