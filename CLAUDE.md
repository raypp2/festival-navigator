# festival-navigator — agent notes

Non-inferable facts only (the code answers everything else — read it).

- **v3 design system**: static tokens in `assets/v3-tokens.css`, screen map +
  aura algorithm in `claude-plans/v3-inventory.md` — look values up, never
  invent them. UI vocabulary is exactly: picked / must / notes / fest. Pick
  levels are 0–4 (0 tombstone, 1–3 picked at alpha .5/.75/1, 4 must); legacy
  v3-doc levels map 1→1, 2→2, 3→4 at read time (old "Must See"=3 IS must —
  labels, not alphas, carry the semantics). Never a music-note glyph (Spotify is
  the green pill). Notes are stored as keyed objects, never arrays
  (jsonb_deep_merge replaces arrays — an array eats concurrent notes).

- **The three primary actions are ONE component on every surface, and the
  pick segments are always drawn.** `buildPrimaryActions`/`paintPrimaryActions`
  are exported from `js/discovery/deck.js` and used verbatim by the deck, the
  artist page (`ap-actions`) and the desktop focus pane (`dd2-pane-actions`) —
  only metrics differ, via CSS. Do not re-implement them per surface: that is
  exactly the state this replaced on 2026-08-01, when three screens each had
  their own idea of "pick" and the artist page kept its control in the hero.
  Two rules with teeth: (1) the bar goes along the BOTTOM, never in a header,
  because it holds the primary actions; (2) all three pick segments render
  whether lit or not — that is the only thing making "tap again to raise"
  legible *before* the first tap, and dropping the unlit ones re-hides the
  multi-tap cycle from anyone who has not already found it. On the artist page
  the bar is `position: sticky` inside `.ap-scroll`, NOT absolute or fixed:
  the overlay is itself the scroller, so an absolutely-placed bar rides the
  content up and out of reach, and a fixed one escapes the ≥1200px grid that
  re-places it into the left rail.
- **The festival accent (`--fest`) appears in exactly FOUR places**: the fest
  name, the active day tab, stage headers, and the current-fest border in
  Settings. Anything else that wants to look selected or "ours" uses `--brand`.
  This is a rule with teeth: the accent had crept into seven places by
  2026-07-12, including the loader shown while a crew is being CREATED — i.e.
  wearing a festival's colour before a festival had been chosen.

- **The 44px touch floor is applied to `button`, not to a list of selectors.**
  It used to name six, and the naming WAS the bug — every control added after
  those six (chips at 26px, the "+ ✎" note chip at 17px, every button in
  Settings) silently got nothing. If you add a control, it inherits the floor by
  being a button. Do not go back to enumerating. Cards are excluded on purpose
  (expanding them steals taps from neighbouring picks); the narrow *glyph*
  buttons get a wider horizontal upgrade, and that list only ever upgrades —
  forgetting to add to it still leaves a control safe.

- **The model is fests × circles × you (2026-07-14):** the UI is
  festival-first; a "crew" is internally a circle — one cluster, one link,
  the consent boundary — and the word barely surfaces. Two laws with teeth:
  (1) nobody ever sees people in circles they're not in — suggestions may
  rank what a person can already see, never expand it; (2) mute/hide is
  viewer-side only (device/person record), NEVER written to the shared doc.
  Direction doc: `claude-plans/2026-07-14-fests-circles-you-direction.md`.
- **The person token is a master key** (its doc lists every crew token): it
  travels ONLY in the `X-Person-Token` header — never a query param
  (platform logs), never in a crew doc (crew-readable). Crew docs carry the
  public `pid` only; PID_RE/TOKEN_RE length ranges are deliberately disjoint
  so one can never pass as the other.

- **Crew store is Neon Postgres**, project `floral-meadow-70237530` (Kevin's
  personal org). Merges MUST stay a single inline atomic `UPDATE` through
  `jsonb_deep_merge()` — a CTE-based read merges against a pre-lock snapshot
  and measurably lost 2/6 concurrent writes (2026-07-07). Schema source of
  truth: `db/schema.sql`.
- **The merge SQL lives in `api/_lib/crew-sql.mjs`, and that is deliberate**:
  `tests/db-merge.test.mjs` executes THOSE EXACT BYTES against a real Postgres
  (PGlite — in-process, no server, no secrets, runs in CI). Before 2026-07-12 the
  SQL sat inline in api/crew.js where only production could reach it, and the
  suite tested a JS "reference twin" that its own comments admit is NOT what
  production enforces. If you change the merge, change it there, and the test
  follows automatically. Never re-type the SQL into a test — a test against a
  copy passes through exactly the regression it exists to catch.
- **Active member names must be unique case-insensitively.** "Drew" and "drew"
  are one person to every human and two forever to the document, splitting their
  picks down the middle. Enforced in the merge's WHERE clause (the only place
  both concurrent writes are visible) as well as in validateMergedDoc.
- **Vercel Blob is banned for the crew doc.** Its read path is eventually
  consistent even with cache-busting query params; rapid merges lost writes
  outright (measured 2026-07-07). Old stores may still exist on the account.
- **Sync states are online / syncing / offline / error / blocked.** `offline` is
  gray because it is a state, not a fault (you are in a field; we expected this).
  `error` and `blocked` are red because a human is needed. `blocked` means the
  server understood us and said no — a deterministic rejection, so re-sending the
  same bytes is pointless; sync.js remembers the refused payload and waits for a
  NEW edit rather than re-POSTing forever.
- **Docs cannot lie any more, and that is enforced**: `tests/docs-truth.test.mjs`
  asserts the README's structure block points at files that exist, that no doc
  tells anyone to run an npm script that does not exist, that no doc presents
  Tailwind or Blob as part of the stack, and that the festival list lives ONLY in
  `data/festivals/index.json`. History files (DEVLOG, claude-plans) are exempt —
  they are supposed to talk about what we dropped.
- `vercel dev` does not serve files created after it starts, and can serve
  STALE copies of edited files too (measured 2026-07-12: an edited app.js
  served an old version until restart) — when in doubt, restart it, and
  verify with `curl | md5` against the local file. It also refuses to run if
  package.json has a `dev` script that calls `vercel dev` (recursion check),
  which is why there is no `dev` script. Local `vercel dev` pulls the REAL
  cloud env (DATABASE_URL included) — localhost /api hits the production
  Neon DB; treat writes accordingly.
- **The service worker will serve you a stale app while you are testing.** After
  deploying, a browser that already has the old SW keeps serving the OLD cached
  JS/CSS even though the server has the new bytes — verified live 2026-07-12,
  where every fix read as "not applied" until the SW was unregistered and its
  cache deleted. `curl | md5` says the server is right; the browser is lying.
  Unregister + `caches.delete()` + hard reload before believing a browser check.
  And bump `CACHE_VERSION` on every asset-changing commit. **Even with the SW
  gone, hash-only navigations (`#g=…` → `#new`) keep the page's module map —
  edited JS only reloads on a REAL document load (hop via about:blank), and
  the ES-module cache also survives `Network.clearBrowserCache`** (burned a
  test cycle 2026-07-14).
- **Preview deploys share the PRODUCTION DATABASE_URL — on this fork too, and
  as of 2026-08-02 that fires automatically.** Verified empirically on
  upstream 2026-07-14 (a person row created on staging was deleted through the
  prod Neon connection), and re-confirmed on THIS project 2026-08-02: the
  `DATABASE_URL` and `DATABASE_URL_UNPOOLED` env vars are scoped to
  `production,preview`, not production alone. Now that the repo is
  git-connected, **every push to any branch builds a preview that writes to
  the production database** — there is no isolated environment to develop
  against, and no step where you opt in. Preview writes are prod writes: test
  with throwaway crews/persons and delete them after. If you want a real
  staging boundary, it needs a separate Neon branch bound to the preview
  target; nothing today provides one.
- Styling is hand-written CSS in `assets/v3-tokens.css` (tokens) and
  `assets/v3.css` (components) — no build step, no framework. (Tailwind was
  dropped in v3; there is no `npm run css`.)
- Hook command strings in `.claude/settings.json` must stay apostrophe-free
  (a `'` closes the shell quote and silently breaks compaction).
- The Write tool has serialized literal control bytes (`\x00`) into files in
  this repo twice when escape sequences were intended — after writing
  regexes/tests with `\xNN`, verify with `python3 -c "open(...,'rb')"`.
- **This repo is PUBLIC.** A crew token (`#g=…`) IS the credential for that
  crew's data. Never commit one; scan before every commit with `&&` (never `;`,
  which runs the commit even when the scan trips). `.gitignore` denies `*.png`
  by default and allowlists the three icons that ship, because an audit run once
  dumped 50 screenshots into the repo root.
- **This is Ray's fork (`raypp2/festival-navigator`), not Kevin's upstream, and
  it deploys to Ray's OWN Vercel project** — `festival-navigator` under team
  `raypp2` (`prj_xt5Sgi5RhwTTJfdfF0u47WqpJTHq`), serving
  `ray-festival.vercel.app`. Promoting to production here is Ray's call and
  needs no one else's sign-off: nobody is on this deployment yet, so it is
  effectively pre-release. The old "production promote is Kevin's call,
  always" rule came from upstream and does NOT govern this repo — it applies
  only to `khglynn/festival-navigator`. Note the trap that produced that
  confusion: `.vercel/project.json` is byte-identical in the upstream clone
  and in this fork, because BOTH local checkouts are linked to Ray's project —
  identical link files are not evidence you are pointed at Kevin's.
- **The project is git-connected as of 2026-08-02: a push to `main` IS a
  production release.** No `vercel --prod` needed, and no confirmation step
  between the push and the live site — other branches get preview URLs
  instead. `main` was fast-forwarded to the 27-commit `discovery` branch the
  same day, so the two agree; before that merge, Discovery existed ONLY on
  `discovery` and a deploy from `main` would have shipped a site with no
  Discovery in it at all. Connecting the repo needed the Vercel GitHub App
  installed on the GitHub account — a Vercel *login* connection alone returns
  a "make sure there aren't any typos" error that has nothing to do with typos.
- Adding a festival: `docs/add-a-festival.md`. Validate with
  `node scripts/validate-festivals.mjs` before committing — CI enforces it.
