# Discovery — build specification (Epic A)

**Status:** Draft v1 · **Date:** 2026-07-30
**Parents:** [`PORT_REQUIREMENTS.md`](PORT_REQUIREMENTS.md) (requirements) ·
[`DISCOVERY_SPEC.md`](DISCOVERY_SPEC.md) (refined spec) ·
**Design of record:** Claude Design handoff *"Exploring fourteen layout directions"*
(`Discovery - Screens.dc.html` + `Discovery - Sample Player.dc.html` + notes)
**Target repo:** `github.com/raypp2/festival-navigator` (fork of khglynn/festival-navigator v2.0.0)

> Reading order: PORT_REQUIREMENTS → DISCOVERY_SPEC → design handoff → **this doc** → code.
> This is the file-by-file mapping and milestone plan. Where this doc and the design
> handoff disagree on visuals, the handoff wins; where either disagrees with the
> governing laws (G-1…G-7), the laws win.

---

## 0. Decisions locked (2026-07-30, Ray)

| Decision | Choice |
|---|---|
| Target codebase | Ray's fork `raypp2/festival-navigator`; Epic A0 (fork hygiene) is milestone M0 of this spec |
| Scope of this spec | **Everything designed**, delivered as independently shippable milestones (M0–M7) |
| Similarity source | **No external engine in v1.** Similarity = shared canonical genres + crew signal + billing order. ListenBrainz/Last.fm deferred until this baseline exists to measure against |
| "Recommend-ahead" for unopened members | **Stored recommendation** — an attributed `recommended for Sam by Drew` record in the crew doc. Never a pick written under another person's identity. Sam sees a queue on first open |
| Aggregate cross-crew picks (spec §6.2) | **Deferred** — needs its privacy sign-off; billing order supplies the popularity prior |
| Bandsintown | **Deferred** — the v2 player is YouTube/SoundCloud/Spotify only (matches design); Bandsintown remains a schema field + link-out candidate for later |

---

## 1. Design of record — frame index

The handoff bundle should be committed into the fork at `design/discovery-handoff/`
(static HTML; it renders standalone). Frames referenced throughout:

| Frame | Surface | Size |
|---|---|---|
| **2a** | Discover deck (swipe & sample) | mobile 390 |
| **2e** | Pool filter sheet | mobile 390 |
| **2b** | My schedule — gaps & clashes | mobile 390 |
| **4a** | Decide (clash resolver) | mobile 390 |
| **4b–4e** | States: no metadata / offline / cold start / zero artists | mobile 390 |
| **5a / 5b** | Artist page | mobile 390 / desktop 1440 |
| **5c** | Discovery three-pane | desktop 1440 |
| **5d** | Schedule + assist rail | desktop 1440 |
| **5e** | Decide side-by-side | desktop 1440 |
| Sample Player sheet | Full / compact / desktop player + states | component |

**The one flow change** (called out in the handoff): *every artist name in the app opens
the artist page* — wall rows, timetable sets, deck card names, crew feeds. The pick chip
lives on the artist page. Tap-to-cycle survives only where the design draws it (deck
action bar, artist-page tick). This is a deliberate change to today's wall/timetable
tap behavior and is implemented in M3.

---

## 2. Repo & environment (M0 — fork hygiene, Epic A0)

The fork exists. Before feature work:

- **Own infrastructure:** new Vercel project + new Neon database for the fork.
  Non-negotiable because the upstream staging *shares the production DATABASE_URL*
  (verified 2026-07-14) and prod promotes are Kevin's call. The fork gets its own
  `DATABASE_URL`; apply `db/schema.sql` fresh.
- **Keep green:** the full test suite (including `tests/db-merge.test.mjs` against
  PGlite and `tests/docs-truth.test.mjs`) must pass on the fork before M1 starts.
- **Spotify app:** register a fork-owned Spotify PKCE client id (the 5-user dev cap is
  per app); `SPOT-1` — the shipped Spotify feature ships unchanged.
- **Public-repo hygiene carries over:** no crew tokens in commits, `*.png` denied by
  default, apostrophe-free hook strings.
- Product name ("AI Festival Planner") is a rename decision — defer; nothing in this
  spec depends on it.

---

## 3. Data & schema (M1)

### 3.1 Festival artist entry — optional extensions (`META-1`)

```jsonc
// data/festivals/<id>.json — artists[] entry. All fields optional; the 11 shipped
// festivals keep validating unchanged. Array position = billing order; never re-sort.
{ "name": "GRiZ", "day": "Day 2", "stage": "Lakeshore", "time": "6:30 PM - 8:00 PM",
  "genres": ["future bass", "bass house", "disco"],   // raw tags, canonicalized at read
  "soundcloudSlug": "griz", "spotifyId": "25oLRSUjqk4BurlUmVvDXR",
  "youtubeQuery": "GRiZ live set",
  "youtubeVideoIds": ["<top>", "<alt1>", "<alt2>"],    // cached; first = auto-pick
  "bandsintownId": "griz" }                            // stored, unused in v1
```

### 3.2 Shared artist cache (`META-2`)

`data/artists/artists.json` — name-keyed (case-insensitive key = trimmed lowercase
name), same fields as above plus `mbid` and `enrichedAt`. The festival entry is the
reference; the cache persists enrichment across festivals so no artist is researched
twice. Import merges cache → festival entry when the festival entry lacks a field.

### 3.3 Genre canon

`data/genres.json` — repo-owned, curated:

```jsonc
{ "canon": ["Big Room", "Progressive House", "Tech House", "Melodic Techno",
            "Hard Techno", "Dubstep", "Riddim", "Drum & Bass", "Trance", "Psytrance",
            "Hardstyle", "Future Bass", "Bass House", "Afro House", "Disco",
            "Garage", "Trap", /* … */],
  "synonyms": { "dnb": "Drum & Bass", "drum and bass": "Drum & Bass",
                "melodic house": "Melodic Techno", /* … */ },
  "suppress": ["electronic", "edm", "dance", "music", "pop"] }
```

### 3.4 Crew doc additions (shared, merged)

All keyed objects, tombstoned, never arrays (`G-1`). Byte-capped (`G-4`).

```jsonc
"festivals": { "<fid>": {
  "selections": { /* unchanged */ },
  "passes":  { "<artist>": { "<person>": { "ts": "…" } } },          // DISC-7, spec §5
  "recs":    { "<artist>": { "<forPerson>": { "by": "<person>", "ts": "…" } } }
}}
```

- `passes` semantics exactly per `DISCOVERY_SPEC.md` §5: mutually exclusive with a
  pick (writing one tombstones the other), reversible, crew-visible, suppresses but
  never deletes.
- `recs` is the **stored recommendation** (decision above). Writing a rec for a person
  who already picked/passed that artist is a no-op in the UI. When `forPerson` later
  picks or passes, the rec is tombstoned. Cap: one rec per (artist, forPerson) — a
  second sender overwrites `by`/`ts`.

### 3.5 Person doc additions

```jsonc
"taste": { "genres": { "Bass House": 0.8 }, "artists": { "griz": 4 } },
"seen":  { "griz": { "<entryId>": { "fest": "electric-forest-2026", "date": "…" } } }
```

Person-level (private, header-token only, `G-3`); crew projections summarized (`G-4`,
`SEEN-4`). Full TASTE/SEEN surfaces are Epic B — M1 lands only the schema + the
seen-count line the artist page displays ("Seen 4× · last Jul 2024"), sourced from the
person doc when present, hidden when absent.

### 3.6 Files touched

| File | Change |
|---|---|
| `scripts/validate-festivals.mjs` | accept new optional artist fields; validate `genres` entries are strings; validate `youtubeVideoIds` ≤ 4 (`G-5`, `X-1`) |
| `scripts/enrich-artists.mjs` **(new)** | import-time enrichment: MusicBrainz genre tags (keyless) → raw `genres`; YouTube `search.list` seeded by `youtubeQuery` → cached `youtubeVideoIds` (searched **once, ever** — 100 units/call, ~100/day quota); SoundCloud slug + Spotify id resolution with oEmbed verification; writes both festival entry and `artists.json`. Curator overrides = hand-edits to the JSON, which the script never clobbers (enriches only missing fields) |
| `scripts/import-festival.mjs` | merge from `artists.json` cache on import |
| `api/_lib/crew-sql.mjs` | `validateMergedDoc`: accept `passes` and `recs` shapes; enforce pick/pass mutual exclusion is **not** validated server-side (client concern — two concurrent writes may briefly hold both; reader resolves: a pass with `ts` newer than the pick's write wins). Extend `tests/db-merge.test.mjs` cases — the SQL itself is unchanged |
| `db/schema.sql` | no change (docs are jsonb) |

**Architectural rule (spec §8):** enrichment is a build/import step. The client only
ranks. Nothing fetches metadata live per user.

---

## 4. Genre normalization (client, `js/discovery/genres.js` — new)

Pure functions over `data/genres.json`:

- `canonicalize(rawTags[]) → { primary, secondary[] }` — map via synonyms, drop
  suppressed, rank by specificity (order in `canon` is the specificity ranking:
  curated, most-specific-wins among survivors). `primary` drives grouping, shelves,
  the Day/Genre filter, sort, and the sub-line's first token. `secondary` feeds
  similarity only — never shown as filters.
- No usable tag → `primary: null`, UI renders "No genres tagged yet" (frame 4b) —
  never a blank chip, never a dead filter entry.
- The genre filter (2e/5c) lists only canonical genres present in the current pool,
  with counts derived from `primary`.

---

## 5. Scoring & reasons (`js/discovery/score.js` — new)

Deterministic, explainable, client-side (spec §4). Input: festival artists +
crew doc + person taste (if any). Output per artist: `{ score, reason }`.

**Signals (v1, no external engine):**

| Signal | Source | Direction |
|---|---|---|
| Genre affinity | your picks/musts' primary+secondary genres vs candidate's | + (heaviest) |
| Crew interest | `selections` of crewmates (circle-scoped, `G-2`) | + |
| Billing order | array position (free prior; cold-start backbone) | + |
| Passes | yours heavily; repeated passes in a genre down-weight the genre | − |
| Schedule fit (M6) | plays inside one of your gaps / clashes with a must | + / route to Decide |

**Reason types — exactly one per recommendation** (handoff notes §2, copy is
normative):

| Type | Copy | Rendering |
|---|---|---|
| Taste | `shares {genre} with {n} of your musts` | violet tonal ribbon |
| Crew | `{name} has this as a must` / `{n} of the crew picked` | who-corner glyph only, no words |
| Billing | `headlining` / `#{n} on the bill` | text ribbon (cold-start workhorse) |
| Gap (M6) | `plays in your {window} gap` | ribbon / gap pill |

**Guarantee:** no producible reason ⇒ the artist is not presented *as a
recommendation* (it still appears in the plain ranked list). Never an empty reason.

**Recommend-ahead taste model:** members with zero activity get a per-member model
seeded from crew picks + billing (identical to the cold-start user's own seed). It
powers the "recommend to Sam" affordance; it writes nothing until a crewmate acts.

**Similar artists (5a/5b "Similar · and when they play"):** rank by shared
primary/secondary genre count, tie-break billing; annotate each with schedule state
when times exist (`in your {window} gap` / `clashes with {artist}` / plain time).

Weights live in one exported const, tuned in M5 against Electric Forest '26 and
Lollapalooza '25 (both fully timed).

---

## 6. Sample player (`js/discovery/player.js` + `player.css` — M2)

One module, one instance, three adapters. The Sample Player v2 sheet is normative;
the mechanics were validated in `player-research/` (TEST-PLAN.md).

**Core rules:**

- Tab priority **`['yt','sc','sp']`** doubles as the fallback order. A tab renders
  only if the artist resolved that source (`DISC-3`; no dead controls, AC-8). Zero
  sources ⇒ the block collapses to the "Nothing to sample yet" one-liner (4b).
- **Last-used source persists** under one localStorage key (`fp.sampleSource`),
  across artists and reloads; fall back down the priority order when an artist lacks
  it.
- **One player, always.** Switching source/artist/clip, closing a sheet, or deciding
  on a deck card tears the previous embed down first — enforced across all three
  embed types together. The card's ▶ and the page's player are the **same instance**:
  raising the sheet hands over source + position.
- **Tap-to-play, stop-on-leave.** No autoplay on scroll or on next-card mount
  (iOS-gesture-safe). A deck decision stops playback as the card leaves.
- **Stage shapes are fixed** and the panel height varies per tab (don't lock it):
  YouTube 16:9 · SoundCloud 166px · Spotify 352px. In a card, YouTube is an 82×46
  thumbnail with its own progress bar — a video source never hides behind a round
  play button.
- **Alternates:** YouTube = cached `youtubeVideoIds` labelled by festival + year;
  SoundCloud = live `getSounds()` (cap 6; handle lazy-loaded placeholder rows);
  Spotify = none (its embed lists top tracks itself). Rows: 3 on a card, 6 in the
  sheet, always visible.
- **Spotify honesty:** "30-sec preview" chip whenever no Premium session; full
  playback is a silent bonus, never implied.
- **SoundCloud attribution** rendered per SC terms (title + artist, link).
- **Errors:** YouTube 101/150/153 (embedding disabled) ⇒ strike the tab, fall through
  to next source, offer "Retry" (Sample Player sheet, state 4) — distinct from
  offline (grey, whole block dims, picks unaffected, 4c).
- **Secure context:** YouTube needs localhost or HTTPS; the embed pins no origin so
  one build runs on localhost, LAN IP, and the deployed domain.

**Layouts:** full (artist page / bottom sheet), compact (deck card), desktop
(≥1120px alternates rail beside the stage; 960–1120 stacked under a larger stage;
Spotify always full-width).

---

## 7. Surfaces — file-by-file

New code lives under `js/discovery/`; v3 shell files change minimally and are listed
per surface. All new controls are `<button>`s (the 44px floor is selector-inherited —
do not enumerate). Focus ring and reduced-motion/low-power rules apply as shipped;
grain and the deck animation are motion-optional (nothing depends on motion to be
understood).

### 7.1 Artist page (M3) — frames 5a/5b · `DISC-8`

- `js/discovery/artist-page.js` **(new)** — app-wide surface, not a Discovery screen.
  Route: `#a=<artist>` via `js/v3/router.js`; opened from wall rows, timetable sets,
  deck names, Decide cards, similar-artist rows.
- Anatomy (top→bottom, 5a): crew-aura hero with grain (reuse `js/v3/aura.js`; hero
  grain .4) · name · canonical genre chips · set line (day/time/stage — stage in fest
  accent, one of the four allowed places) · **headline pick control**: vertical tick,
  fixed 84px height regardless of name length, fills ×1→×2→×3→clear on tap (same
  glyph vocabulary as the who-corner); ★ must and ✕ pass beside it · sample player
  (full) · crew list (picks, passes at .55 opacity + "passed", unopened members
  dashed with **recommend →** action writing `recs`) · notes (existing
  `js/v3/notes.js` mounted in; bubble radius 8px 8px 8px 2px) · seen line · similar
  artists with schedule annotations.
- Pick/pass writes go through existing `js/state.js` paths; pass writes tombstone the
  pick and vice-versa (§3.4).
- **The flow change lands here:** `js/v3/wall.js` and the timetable change artist-name
  taps from cycle-pick to `router.push('#a=…')`. Deck action bar and artist-page
  controls are where levels change. Update `refreshCard` consumers accordingly.

### 7.2 Discover deck + filter (M4) — frames 2a/2e/4d · `DISC-2`

- `js/discovery/deck.js` **(new)** — entered from the festival screen ("Discover"
  tab/entry registered in `js/v3/app.js` screen switching + router).
  - Session header: `n / total`, segmented progress bar, filter button with
    active-facet count badge; sub-line names the active pool ("13 unheard left —
    sampling Riddim & Dubstep").
  - Card: canonical genre chips · name (long-name safe per reference data §2) ·
    exactly one reason ribbon · compact player. Card stack renders two ghost cards
    behind.
  - Action bar: **Pass · ＋ Pick ×1 · ★ Must** (repeat taps on Pick raise the level).
    Every decision is undoable (existing undo toast); pass is quiet, not a
    thumbs-down.
  - Deal order: current sort (default "For you"; cold start = billing order top-down,
    frame 4d — no separate cold-start UI).
  - Swipe gestures per the Swipe Demo sheet; taps always work (motion optional).
- `js/discovery/filter.js` **(new)** — bottom sheet (2e): Sort (For you / Popularity /
  A–Z) · Show (Undecided default / Passed / All) · Genres (canonical, in-pool) ·
  Day · toggles: Picked by the crew, Has a live set, Playing in my open gaps (greyed
  until set times exist). Footer CTA shows the resulting count ("Show 31 artists").
  Zero results ⇒ count shows 0 + one-tap "Reset filters" — never a dead pane.

### 7.3 "For you" wall mode (M5) — `DISC-1`

- `js/v3/sort-control.js`: add "For you" sort (default when Discovery data exists).
- `js/v3/wall.js`: reason ribbon on recommended cards (violet tonal strip above the
  card body, 5c grid card anatomy); passed cards render at .55 opacity with a PASSED
  chip under Show=All, hidden under Undecided, and sink in ranking. The who-corner
  cap (2 musts + 2 ticks + `+n`) is unchanged and is the crew-reason rendering.

### 7.4 Schedule assist (M6) — frames 2b/5d · `DISC-10`

- `js/discovery/gaps.js` **(new)** — pure: given a day's timed sets and your marked
  plan, return gaps (unmarked windows between marked sets) and clashes (two+ sets
  overlapping where you hold picks/musts). Uses `js/time.js` (`timeToMinutes`
  handles cross-midnight) and `js/overlap.js` lane math (`CONF-1` untouched).
- "Your day" view (`js/discovery/my-day.js` **new**): single-column timeline of your
  picks with auras; gap slots render striped with "Open · 4:00–6:00 PM" + up to 3
  gap-fill chips (artists you'd like actually playing then, ranked by score ×
  early-day discovery-value bias); clash slots render the ⚡ card routing to Decide.
  Tapping any set opens the artist page.

### 7.5 Decide (M6) — frames 4a/5e · `DISC-9`

- `js/discovery/decide.js` **(new)** — route `#decide=<day>:<slot>`. Two (or three)
  clashing artists as stacked (mobile) / side-by-side (desktop) cards, each with:
  full player · your level + crew lean · **Give up:** line · **Plays again:** line
  (same artist name elsewhere in the timetable — the cheap-skip signal) · "Choose
  {name}". Footer: "Split it — 45 min each" (plans both halves) and "keep both
  starred and decide on-site". **Never auto-picks**; choosing demotes the other to
  its prior non-conflicting state, undoable.

### 7.6 Desktop layouts (M7) — frames 5b/5c/5d/5e

- CSS-first: shell widens to 1120 on ≥1200px viewports for these surfaces
  (`assets/discovery.css`); artist page becomes the 5b two-column (hero+player left
  rail 440px; crew/notes side-by-side; similar 2-col grid); Discovery becomes the 5c
  three-pane (filters 216 · ranked wall grid · focused sample pane 320 — the pane
  reuses the compact player + headline tick, no modal); schedule gains the 5d assist
  rail (gaps + clashes); Decide goes side-by-side with full players (5e).
- The top bar (Wall / Discover / Timetable + sync dot + crew chip) is the 5c/5d
  header; mobile keeps the existing shell.

### 7.7 Design-system additions

- Tokens: none — the handoff uses shipped `v3-tokens.css` values exclusively. New
  component classes (source tabs, reason ribbon, vertical tick, gap slot, VS
  divider, session progress) go in `assets/discovery.css`, values looked up from
  tokens, no new colors/radii/fonts.
- Fest accent audit for new surfaces: it may appear **only** as fest name, active day
  tab, stage headers (incl. the artist-page set line), settings border. Everything
  "selected/ours" is brand violet.

---

## 8. Edge states (build checklist)

| State | Frame | Behavior |
|---|---|---|
| No metadata | 4b | Page fully functional; "No genres tagged yet"; player collapses to one-liner; picking unaffected |
| Offline | 4c | Grey dot, banner copy as drawn; only the player dims; picks/pass/timetable fully live; sync resumes per existing `sync.js` states |
| Cold start | 4d | Normal deck dealt by billing order; billing reasons; genres unlock as sampling happens |
| Zero artists | 4e | "Lineup not announced yet" + notify toggle (wire to `NOTIF-*` when Epic D lands; until then the toggle persists a local flag) |
| Zero results after filter | notes §3 | Count 0 + one-tap Reset filters |
| Genre shelf all-passed | notes §3 | Under Show=Undecided prompt to switch to All, never blank |
| 8-person crew | notes §3 | Who-corner cap 2 musts + 2 ticks + `+n` — verify, don't overflow |
| Source failed | player sheet | Strikethrough tab, fall through, Retry — distinct from offline |
| Spotify preview | player sheet | "30-sec preview" whenever no Premium session |

---

## 9. Milestones

> **Status (2026-07-31): M0–M7 complete** on branch `discovery` (18 commits, 376 tests).
> M0 was already done by Ray pre-spec. Deviations from plan, all documented in commit
> messages: desktop 5b/5c pulled forward during desktop testing; `artistOrder:
> billing|schedule` + `derivePopularity` added after discovering EF/Lolla arrays are
> schedule-ordered (EF's derived popularity limited by absent end times); the sample
> player gained seek + SoundCloud monetization honesty from live testing. Remaining
> operational (not spec) work: YouTube enrichment tail (~100 searches/day quota),
> remaining lineups' enrichment, preview deploy + phone pass, rec-queue surfacing (§11.2).

Each milestone is shippable and gated on the prior. AC = acceptance criteria
(numbers reference `DISCOVERY_SPEC.md` §9).

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **M0** | Fork hygiene | §2: own Vercel + Neon, env, Spotify app, tests green | Suite passes on fork infra; a throwaway crew syncs end-to-end |
| **M1** | Data foundation | §3 + §4: schema, validator, enrichment script, genre canon, `artists.json`; enrich **Electric Forest '26 + Lollapalooza '25** as pilots | CI validates; both pilots enriched with genres + ≥1 source for ~all artists; unenriched festivals render unchanged (AC-4 partial, `META-*` ACs) |
| **M2** | Sample player | §6, all three layouts + states | AC-1 (~15s to sample, zero accounts), AC-7, AC-8; one-player rule holds across sources on iOS Safari + Chrome |
| **M3** | Artist page + passes | §7.1, `passes`/`recs` merge support, flow change | AC-2 on the page; pick/pass mutual exclusion; recommend-ahead writes `recs`; every artist name in app opens the page |
| **M4** | Discover deck + filter | §7.2 | Deck completes a 30-artist session; filter facets + badge; 4b/4c/4d states pass; AC-6 (never a gate) |
| **M5** | For-you wall + reasons | §7.3, weight tuning | AC-3 (every rec shows its reason), AC-2 on wall ordering, AC-4 (cold start useful) |
| **M6** | Schedule assist + Decide | §7.4–7.5 | AC-5 (gaps named, in-gap recs) against both timed pilots; Decide never auto-picks; clash → choice → timetable write-back undoable |
| **M7** | Desktop | §7.6 | 5b/5c/5d/5e at 1440; mobile untouched below 1200 |

---

## 10. Deferred / out of scope (this epic)

- External similarity engine (ListenBrainz first when revisited — decision criteria in
  [`RECOMMENDATION_ENGINE_OPTIONS.md`](RECOMMENDATION_ENGINE_OPTIONS.md) §5).
- Aggregate cross-crew popularity (privacy sign-off required — spec §6.2).
- Bandsintown surface; Spotify playlist export additions (`SPOT-2`).
- Taste/seen full surfaces (Epic B), Claude authoring (C), notifications + transit
  (D), citywide (E).
- Light mode, member photos, changes to the pick cycle — explicitly out (brief §8).

## 11. Open items (small, non-blocking)

1. **Genre canon curation** — M1 ships the starter list from the design notes; owner
   is the repo (PRs). Revisit only if MusicBrainz tags prove unmappable in the pilots.
2. **Rec queue surfacing** — where Sam's first-open queue renders (toast → sheet on
   the wall is the working assumption); design as a small follow-up frame.
3. **"Split it" planning mechanics** (5e) — v1 stores the choice as both sets kept
   with a split note; real half-set scheduling is Epic D territory.
4. **Product rename** — no dependency in this spec.
