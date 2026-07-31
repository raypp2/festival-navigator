# Design brief — "Discovery" for Festival Navigator

*Mobile-first, dark, existing design system. Everything you need is in this package.*

**How we want to work: wide and rough first, then narrow and polished.** Round 1 asks
for **many divergent low-fidelity concepts** — we are choosing a direction, not
refining a layout. Please do not jump to polished screens.

---

### 📦 What's in this package

| File | What it is | When you need it |
|---|---|---|
| **`00-START-HERE.md`** | This brief — product, problem, what to design, how to run the rounds. | Read first, all rounds. |
| **`01-design-tokens.css`** | The **real** production token file, verbatim. Every colour, radius, and type value the app uses. | Round 2 onward — use these values, don't invent. |
| **`02-current-ui-reference.html`** | **Open this in a browser.** A live render of the existing artist card in every state — the crew-colour "aura", the who/notes/Spotify corners, pick levels 1→must. This is the visual language you are designing into. | Look at it before you start. |
| **`03-reference-data.md`** | Real festival data: actual artist names (including the awkward long ones), real lineup sizes, and the data shapes available to display. | Use for realistic mockup content. |

**Please don't mock up with "Artist Name 1".** Real lineups are 100–400 names and some
of them are *"Skull Machine (Black Tiger Sex Machine x Kai Wachi)"*. Use `03` — layouts
that only survive short names will break on contact.

---

## 1. The product

A mobile-first PWA for planning music festivals **with your friends**. You add a
festival, share one unguessable link with your circle, and everyone's picks sync live.
No accounts, no passwords — the link *is* the access. Works offline, because the place
you actually need it is a field with one bar of signal.

**Tap an artist to pick it:** `picked ×1 → ×2 → ×3 → must → clear`. Everyone in the crew
has a colour, and overlapping picks **blend into the card's background**, so you can see
where the crew is converging at a glance.

The app has two views, and this split matters enormously (§3):
- **Artist wall** — a searchable, sortable list, while only the lineup is announced.
- **Timetable** — stage columns and a real clock, once set times are published.

## 2. What we're adding, and why

A lineup is 100–400 names. A person recognises maybe 15. The app is great at
**recording decisions you already made** and useless at helping you **make** them.

1. **You can't tell what an artist sounds like.** Acute for DJs — a producer's studio
   tracks can be nothing like their live set.
2. **No memory of rejection.** The scale is opt-in only, so "0" means both *"never
   looked"* and *"listened, not for me."* The app can never stop showing you the same
   385 names, and never learns.

## 3. The two phases — Discovery is really two different jobs

**This is the most important thing in this brief.** Discovery's purpose changes
completely when set times drop.

### Phase 1 — lineup only, no times: **exploration**
Open-ended, low-stakes, nothing conflicts because nothing has a time. *"Who is worth my
attention?"* Browse, sample unfamiliar artists, mark interest generously, mark passes.
**Genre is the primary lens** — people have favourite genres and navigate by them.

### Phase 2 — set times published: **decision-making**
The lineup becomes a schedule. *"Who am I actually seeing?"* Two distinct jobs:

- **Resolving overlaps.** The real work of festival planning: two or three artists you
  like play at once and you must choose. Help make that choice *informed* — why each is
  worth seeing, and what you'd be giving up.
- **Filling gaps.** Between your must-sees are hours with nothing marked. This is where
  discovery pays off most, because a bad pick costs nothing — you had nothing planned.
  Recommend artists you'd like **who are actually playing in that gap**.

  *Structural quirk worth exploiting:* festivals back-load headliners — the biggest
  names play latest. So early-day gaps are wide and full of unknown artists (highest
  discovery value), while late slots are usually already contested by headliners (an
  overlap problem, not a gap).

### Third context — at the festival
On-site, one bar, 20 minutes free. Phase 2 compressed: *"who's on now, or next, that I'd
like?"* No sampling, no browsing — just the call. **Discovery must never become a
prerequisite for planning.** It ranks and enriches; it never gates.

## 4. What must be possible (the functional asks)

- **"For you" ranking** on the artist wall — recommended artists rise, each showing
  **why** in one short human phrase ("shares Big Room with 3 of your musts", "Drew has
  this as a must"). Every recommendation is explainable; no black box.
- **Sampling** — hear an artist in seconds. Sources have *distinct roles*:
  **SoundCloud / YouTube = the live set** (the truest impression of a DJ — first-class,
  not an afterthought); **Spotify = their produced tracks**; **Bandsintown = tour
  context**. Show only sources an artist actually has — never a dead control. Must work
  with **zero connected accounts**.
- **Pass ("not for me")** — record *considered and rejected*, distinctly from *never
  engaged*, reversibly. **Deliberately not a sixth tap** (the cycle is full, and it
  would slow clearing). *Tone matters more than mechanics:* passes are **visible to
  your crew**, so this must never read as a verdict on the artist or a judgement on a
  friend's taste. A thumbs-down aesthetic would poison a warm, social app. A passed
  artist should recede without looking broken, deleted, or disapproved-of — it stays
  searchable and still appears on the timetable, because it's a real set at a real time.
- **Genre as a navigational lens** — filter/group/browse by genre in Phase 1.
- **Artist detail** — genres, all sources, **the crew's decisions** (who picked at what
  level, **and who passed**), your seen-history ("Seen 4×", "Last seen Jul 2024"), notes.
- **Overlap assist** (Phase 2) — when picks collide, help choose between them.
- **Gap-fill** (Phase 2) — "you have nothing 4–6pm Saturday; here's who's on that you'd
  like."

## 5. The design system — use it, don't invent

Dark, violet-cast, hand-written CSS. **Look values up here; do not introduce new
colours, fonts, or radii.** (Round 1 is structural — but stay inside this system from
Round 2 on.)

**Surfaces** `page #0C0A14` · `card #141021` · `card-unpicked #1C1731` (artist card base)
· `dock/sheets #0A0812` · `hairline #241E38` · `border-card #2B2440` ·
`border-input #322A4D`

**Text** `header #EDEAF4` · `primary #FFFFFF` · `body #C6CBD6` · `secondary #8E86A8` ·
`tertiary #877FA4` · unpicked artist name `#B9B3CC`
*(tertiary was deliberately lightened to pass AA in daylight — don't darken it back.)*

**Identity colours — fixed meanings, do not reuse**
- **Spotify** fill `rgba(18,138,62,.5)`, stroke `rgb(103,185,138)` — a green pill.
  **Never a music-note glyph**; the green pill *is* Spotify here.
- **Notes** fill `rgba(108,91,212,.5)`, stroke `rgb(196,189,238)`, chip stroke `#8B7BFF`
- **Tonal button** fill `rgba(192,132,252,.13)`, text `#D8B4FE`
- **Brand violet** `rgb(192,132,252)` — anything that wants to look "selected" or "ours"
- **Sync** ok `#10B981` · syncing `#F59E0B` · offline `#6B7280` (grey — a state, not a
  fault) · error `#F87171`

**The festival accent** (`--fest`, per-festival RGB) appears in **exactly four places**:
the festival name, the active day tab, stage headers, and the current-festival border in
Settings. **Nowhere else** — anything else that wants to look selected uses brand violet.
This rule has teeth; the accent crept into seven places once and had to be pulled back.

**Type** Display **Anton** (titles, festival names, day headers), tracking `.05em`.
UI **Inter**. Micro-labels 11px/800, tracking `.12em`. Fluid 390→1440px: display
`clamp(26px,4.5vw,40px)` · screen title `clamp(30px,5vw,44px)` · card name
`clamp(13.5px,1.2vw,15px)` · body `clamp(12.5px,1.1vw,13.5px)` · micro `11px`.
Shell max-width 960px (1080 ≥1100px).

**Radii** card `8px` · rows/buttons `10px` · settings cards `12px` · pill `999px` ·
**notes bubble `8px 8px 8px 2px`** (the sharp lower-left corner is the notes identity).

**Texture** subtle film grain over cards at `.3` opacity, heroes `.4`.

**Non-negotiables** · **44px minimum touch target on every button** · focus ring
`2px solid rgba(192,132,252,.9)`, `2px` offset · `prefers-reduced-motion` and a
low-power mode kill **all** animation and hide grain, so **no design may depend on
motion to be understood** · UI vocabulary is exactly **picked / must / notes / fest**.

### The artist card is already fully allocated — the sharpest constraint here

A card today carries:
- **Background** = the crew "aura": one radial-gradient layer per person who picked, in
  their colour, over base `#1C1731`. Musts innermost at full alpha; picks at `.5/.75/1`.
  **An unpicked card is flat** — no gradient. The blend *is* the crew-convergence signal.
- **Bottom-right ("who")** = lettered pills for musts, 4px ticks for picks, `+n` ghost.
- **Bottom-left ("about")** = violet notes bubble with a count, then the green Spotify
  pill (glows for demonstrated favourites).
- **Name** white when picked, `#B9B3CC` when not.

**So genres, a recommendation reason, and "passed" state have nowhere obvious to go —
and the card a recommendation most needs to mark is the flat, unpicked one.** Solving
this without collision, or proposing a different card for Discovery, is central.

## 6. How we want the exploration run

### Round 1 — **wide and rough** (what we want now)
**10–15 genuinely different concepts**, low fidelity: boxes, labels, arrows. No colour,
no type styling, no polish. We are exploring **structure and interaction models**, not
looks. Divergence is the point — we would rather see three ideas we reject outright
than five variations of one.

Push on the real unknowns:
- **How is Discovery reached?** A third view beside wall/timetable? A mode on the wall?
  A sheet? Something that surfaces contextually when you have a gap?
- **What is the unit?** One artist at a time (swipe/card-stack), a ranked list, a
  genre-first browse, groups of similar artists, a time-slot-first view (Phase 2)?
- **Where does "pass" live**, and how does a passed thing look?
- **How do Phase 1 and Phase 2 relate?** One surface that changes, or two?
- **Gap-fill**: is it part of the timetable itself (fill the empty space in the grid),
  or a separate recommendation surface?
- **Overlap assist**: inline on the timetable where the clash is, or a dedicated
  compare view?
- **Sampling**: inline in a card, in a sheet, or only on the artist page?

Include at least a couple of deliberately contrarian options (e.g. no separate Discover
surface at all — discovery entirely as wall ranking + artist page; or a
time-slot-first Phase 2 view where you browse *hours*, not artists).

### Round 2 — **mid fidelity**, after we pick 2–3 directions
Real layout, real hierarchy, the design system applied, mobile 390px. Include the awkward
states (§7), not just the happy path.

### Round 3 — **high fidelity** on the chosen direction
Mobile 390px + desktop 1440px (desktop is a *designed* size, not a stretched phone),
full states, ready to build against.

## 7. States that must survive (bring these in from Round 2)

- **Cold start** — new person, no taste data. Must still be useful; never an empty screen.
- **Offline** — sampling unavailable; picking and timetable still work perfectly.
  Offline is grey, not red: expected, not an error.
- **No metadata** — artist with no genres and no sources.
- **Long names** — "Skull Machine (Black Tiger Sex Machine x Kai Wachi)", "Boys Noize
  B2B Brutalismus 3000". B2B names are common and long.
- **Dense lineup** — 300+ artists; and a **dense timetable**, 15 stages × 14 hours.

## 8. Explicitly out of scope

Light mode or themes (single dark system, deliberately) · member photos (members are
colour + initials) · changing the pick cycle `×1 → ×2 → ×3 → must → clear` · anything
making Discovery a prerequisite for picking or the timetable · new brand colours, fonts,
or radii.
