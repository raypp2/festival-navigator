# 🎪 Festival Navigator

A fast, mobile-first PWA for planning your festivals with your people. Add
your fests, add each fest's circle of friends, share one link per group — and
everyone's picks sync live, whether the lineup just dropped or the set times
are already out. Works offline once loaded, because the place you actually
need it is a field with one bar of signal.

**Festivals loaded:** 11 — the list lives in
[`data/festivals/index.json`](data/festivals/index.json), which is the only place
it lives. Adding one: [`docs/add-a-festival.md`](docs/add-a-festival.md).

## ✨ How it works

- **Your groups are share links.** Every festival board mints an unguessable
  link for its circle of people. The link *is* the access — no accounts, no
  passwords, no email. Anyone holding it can read and write that board, and
  nobody can touch any other. Different friend groups get different links,
  exactly like real life; your own "My link" on the front page brings all of
  yours back on any device.
- **Two walls.** While only the lineup is announced you get a sortable,
  searchable **artist list**; once set times drop the same picks render as a
  **timetable** — stage columns, honest clock, overlaps side by side. Picks carry
  over automatically because they are keyed by artist, not by slot.
- **Tap to pick.** Levels are `picked ×1 → ×2 → ×3 → must → clear`. Everyone in
  the crew gets a color, and overlapping picks blend on the wall so you can see
  at a glance where the crew is converging.
- **Notes** attach to an artist, a day, or the festival itself.
- **Offline-first.** Picks land in `localStorage` instantly and sync when signal
  returns. The server merges every write atomically, so two people picking at
  once can never clobber each other.
- **Spotify (optional).** Members connect via PKCE — no secrets in the client —
  and artists they already listen to get badges on the wall. Picks can become a
  playlist on their own account. See *Spotify setup* below; the 2026 rules are
  restrictive and worth reading before you plan around them.
- **Add a festival with AI.** `api/festival-add.js` uses search-grounded Gemini
  to research a lineup and returns a *validated candidate* — nothing is saved
  until a human confirms it on screen.
- **Export.** A day of the wall as a PNG, or all your picks as paste-able text.

## 🗂️ Project structure

Full paths, one per line — `tests/docs-truth.test.mjs` asserts every one of them
still exists, so this block cannot quietly rot.

```
index.html                    app shell — all screens live here
service-worker.js             offline shell; bump CACHE_VERSION on any asset change
js/v3/app.js                  boot, wiring, screen assembly, sheets
js/v3/wall.js                 the wall: timetable + lineup, lanes, sticky stage strip
js/v3/settings.js             settings and its drills (Spotify, export, bulk paste)
js/v3/notes.js                notes at artist / day / fest scope
js/v3/model.js                the read model over a crew doc + festival data
js/v3/aura.js                 how a crew's picks blend into one card's color
js/v3/palette.js              the 24-color member board
js/v3/router.js               history-backed navigation
js/state.js                   crew doc + the pending-changes overlay
js/sync.js                    push / poll, retry, and the sync dot's one truth
js/crew.js                    tokens, the local crew registry, share links
js/merge.js                   the deep-merge the client and server agree on
js/overlap.js                 same-stage lane math
js/time.js                    parsing and flooring set times
js/name-rules.mjs             name validation SHARED with the server
api/crew.js                   the crew store: create, read, atomic merge
api/person.js                 the me link: one person across crews (public pid, secret token)
api/access.js                 Spotify access requests (Slack approve flow)
api/festival-add.js           AI lineup research; returns a candidate, saves nothing
api/selections.js             RETIRED endpoint — answers 410 so old clients self-heal
api/_lib/                     validation + guards shared by client and server
db/schema.sql                 Neon Postgres schema incl. the atomic jsonb_deep_merge()
assets/v3-tokens.css          design tokens — look values up here, never invent them
assets/v3.css                 components; hand-written, no framework, no build step
data/festivals/index.json     the festival list (single source of truth)
scripts/validate-festivals.mjs  run before committing festival data; CI enforces it
tests/                        node --test suites (npm test)
docs/user-flows.md            what every screen is supposed to do
docs/add-a-festival.md        how to add a festival
```

## 🔄 Sync model

Every pick writes to `localStorage` immediately, then the **delta** is pushed to
`/api/crew`, where Postgres merges it into the crew document in a single atomic
`UPDATE` via `jsonb_deep_merge()` (see [`db/schema.sql`](db/schema.sql)). Because
the merge is computed *inside* the UPDATE, a second write blocks on the row lock
and then re-evaluates against the winner's committed row — so write races are
structurally impossible rather than merely unlikely.

Other devices poll the merged doc every 25 seconds (stretching to 5 minutes in
low-power mode) and on focus. Removals sync as **tombstones** (`removed: true`,
and level-`0` picks) because a deep-merge cannot express deletion.

Two consequences worth knowing before you change anything here:

- **Notes are keyed objects at every level, never arrays.** `jsonb_deep_merge`
  replaces arrays wholesale, so an array would eat concurrent notes.
- **Vercel Blob is not an option for the crew document.** It was tried first and
  dropped: its read path is eventually consistent and it measurably lost writes
  under rapid merges.

## 🏗️ Setup (fork / self-host)

> **Forking?** Read [`docs/fork-setup.md`](docs/fork-setup.md) first. It covers
> the full walkthrough plus the non-obvious traps — the hardcoded Spotify OAuth
> host (which carries crew *and* person tokens, so it must be yours), Vercel
> `[SENSITIVE]` variables that cannot be read back, Deployment Protection
> silently breaking every share link, and the Gemini model pin that rots.

No build step — the CSS is hand-written and the JS ships as ES modules.

1. **Deploy to Vercel** (static + functions).
2. **Create a Postgres database** (the free Neon tier is plenty) and load the
   schema: `psql "$DATABASE_URL" -f db/schema.sql`
3. **Set environment variables:**

   | Variable | Required | What it does |
   |---|---|---|
   | `DATABASE_URL` | **yes** | the crew store |
   | `GEMINI_API_KEY` | no | AI festival research (`api/festival-add.js`) |
   | `OWNER_SPOTIFY_CLIENT_ID` | no | your Spotify app, offered to your crew |
   | `SLACK_WEBHOOK_URL` | no | where access requests get sent |
   | `APPROVE_SECRET` | no | signs the approve link in that Slack message |
   | `PUBLIC_BASE_URL` | no | the canonical origin for approve links |

   The last four are one feature and all four must be set together, or the app
   falls back to asking each member for their own Spotify Client ID.

4. **Local dev:** `npm i && vercel dev`. Two real gotchas: `vercel dev` will not
   serve files created after it started (restart it), and it pulls the *real*
   cloud env — so `localhost` hits your production database.

## 🎧 Spotify setup

Spotify's February 2026 rules shape this whole feature, so plan around them:
a development-mode app is capped at **5 authorized users**, a developer may hold
**one** development-mode app, and the app's owner needs **Premium**.

That is why the app offers three doors, in order of how most people will use it:

1. **Connect with the crew's app** — if the deployment sets the four variables
   above, members just connect. The owner adds them to the app's allowlist.
2. **Request access** — a member who is not yet allowlisted asks; the owner gets
   a Slack message with an approve button that drops them on the Spotify
   dashboard's user page.
3. **Bring your own Client ID** — the fork path. If you self-host and have your
   own Spotify app, paste its Client ID. Settings has a five-step guide.

## 📄 License

MIT
