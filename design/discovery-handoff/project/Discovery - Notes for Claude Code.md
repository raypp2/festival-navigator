# Discovery — notes for Claude Code

Open items we deliberately deferred from design to engineering. Design is build-ready
without these resolved; Discovery's *quality* depends on the first two.

---

## 1. Genre normalization  (solve in code)

**Problem.** An artist carries 1–8 raw tags of wildly varying usefulness — `"electronic"`
is true and useless, `"riddim"` is specific and valuable. A raw tag cloud cannot drive the
genre filter, the genre shelves, or the "shares X with N musts" reason.

**What the design assumes exists:**
- A **primary genre** per artist — one canonical value used for grouping, shelves, the Day/Genre
  filter, and sort. This is what the UI shows as the genre sub-line's first token.
- **Secondary tags** (canonical) used for similarity matching and the recommendation engine,
  not shown as filters.

**Suggested approach:**
- A curated **canonical genre list** (Big Room, Progressive/Tech/Melodic House, Hard/Melodic Techno,
  Dubstep, Riddim, DnB, Trance, Hardstyle, Future/Bass House, Afro House, Disco, Garage, Trap…).
- Map each raw tag → a canonical genre (or drop it). Maintain a synonym/rollup table.
- **Rank tags by specificity**; suppress over-broad ones (`electronic`, `dance`, `edm`) from filters
  and from the visible sub-line. Pick the most specific surviving tag as primary.
- Degrade gracefully: no usable tag → "no genres tagged yet" (see state 4b), never a blank chip.

**Data:** `genres[]` ships with Discovery; today's data has none.

---

## 2. Recommendation reasons  (solve in code)

**Rule:** every recommendation surfaces **exactly one** short human phrase — no black box.

**Reason types & copy pattern:**
- Taste match — `shares {genre} with {n} of your musts` → rendered as the tonal-violet **ribbon**.
- Crew signal — `{name} has this as a must` / `{n} of the crew picked` → rendered by the
  **who-corner glyph only, no words** (the pill/tick says it).
- Billing — `headlining` / `#{n} on the bill` → text ribbon (used heavily at cold start).
- Gap (Phase 2) — `plays in your {window} gap`.

**Recommend-ahead:** members who haven't opened the app still get a taste-based rec ("recommend to
Sam"), so friends can be picked for. Needs a per-member taste model that seeds from crew picks +
billing order before that member has any data (same seed as a cold-start user).

**Guarantee:** if no reason can be produced, the artist is not shown as a *recommendation* (it can
still appear in the plain ranked list) — never show a rec with an empty reason.

---

## 3. Error / null states  (note only — build in code)

Drawn already: no-metadata (4b), offline (4c), zero-artist festival (4e), cold start (4d).

Still to build (no mock needed, behavior noted):
- **Zero results after filtering** — show the count at 0 with a one-tap "Reset filters"; never a dead
  blank pane.
- **Genre with only passed artists** — with Show = Undecided, the shelf is empty; prompt to switch to
  "All" rather than showing nothing.
- **8-person crew on a card** — who-corner caps at 2 musts + 2 ticks, then `+n` ghost (per the existing
  card spec); confirm the cap logic, don't overflow the corner.
- **Sampling error** (a source exists but fails to load) — distinct from offline: show a retry and fall
  through to the next available source; do NOT treat as "no sources".
- **Spotify preview only** — label playback "30-sec preview" whenever no Premium session; never imply
  full playback.

---

## 4. Sampling plumbing (confirmed by research — carry into build)

- **SoundCloud** — Widget API embeds the artist's posted tracks; public tracks stream with no session
  (full plays). Requires attribution per SoundCloud terms. Default tab / the live set.
- **YouTube** — Data API `search.list` (100 units, 10k/day default) → user picks a representative clip;
  the keyless IFrame player plays it. **Cache results per artist** (quota). Old "load search in player"
  mode is deprecated (4xx).
- **Spotify** — embed = top tracks; anonymous/Free = 30-sec preview only.
- One player instance, one thing playing at a time; `▶` on a card and on the page target the same source.
