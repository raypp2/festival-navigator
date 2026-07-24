# Forking & self-hosting this app

Everything needed to stand up your own deployment, and the non-obvious traps —
each one below cost real debugging time on 2026-07-23/24, so they are written
down rather than rediscovered.

The stack is Vercel (static + functions) + Neon Postgres. No build step.

---

## 1. Fork and point it at yourself

```bash
gh repo fork <upstream>/festival-navigator --clone
cd festival-navigator
git remote add upstream https://github.com/<upstream>/festival-navigator.git
npm ci
npm test          # 175 pass / 1 skipped without a database — see §5
```

> **Trap — the OAuth host is hardcoded, and it carries credentials.**
> `CANONICAL_HOST` in [`js/spotify.js`](../js/spotify.js) must be **your own**
> host. Spotify only accepts pre-registered, exact-match redirect URIs, so
> every non-canonical host (aliases, previews) *hops* to the canonical one —
> and the hop URL carries `#g=<crew token>` **and `&p=<person token>`, the
> master key**. Left at the upstream value, your users hand their credentials
> to the upstream author's domain. Change it before you deploy.
> Everything user-facing derives from that one constant — never add a second
> copy. `api/access.js` `HOST_ALLOW` also lists hostnames and needs the same
> treatment (or set `PUBLIC_BASE_URL`, which bypasses it).

## 2. Database (Neon)

1. Create a Neon project.
2. Load the schema — `db/schema.sql` is idempotent:
   - Neon Console → SQL Editor → paste and run, **or**
   - `psql "$DATABASE_URL" -f db/schema.sql` if you have `psql`.
3. Verify the merge function exists — this is the concurrency guarantee:
   ```sql
   SELECT jsonb_deep_merge('{"a":{"x":1}}'::jsonb, '{"a":{"y":2}}'::jsonb);
   -- expect {"a": {"x": 1, "y": 2}}
   ```

> **Nice-to-know — Vercel's Neon integration creates a `vercel-dev` branch**
> and points the Development environment at it. Local `vercel dev` then writes
> to that branch instead of production. Confirm this; without it, `localhost`
> writes to your **production** data.
> When querying, pass the right branch or you will query an empty one and
> conclude, wrongly, that nothing saved.

## 3. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Set it for **Development, Preview *and* Production**. Missing on Preview ⇒ every preview deploy 500s with "Store not configured". |
| `GEMINI_API_KEY` | no | AI festival research. See §4. |
| `OWNER_SPOTIFY_CLIENT_ID` | no | Slack access-request flow only. |
| `SLACK_WEBHOOK_URL` | no | ” |
| `APPROVE_SECRET` | no | ” |
| `PUBLIC_BASE_URL` | no | Canonical origin for approve links; bypasses `HOST_ALLOW`. |

The last four are **one feature — set all four or none.**

> **Trap — "Sensitive" variables cannot be read back.** Vercel returns the
> literal string `[SENSITIVE]` for them, including via `vercel env pull`. That
> is a redaction, **not your value** — do not conclude the key is a placeholder
> (we did, and were wrong). Sensitive values are also not exposed to the
> Development environment, so for local work add a **separate** key scoped to
> Development.

> **Trap — Deployment Protection breaks the product.** Vercel may enable
> "Vercel Authentication" by default, which puts an SSO wall in front of
> *everything*, including `data/festivals/*.json`. This app's premise is
> "the link **is** the access" — with protection on, every share link sends
> your friends to a Vercel login. Settings → Deployment Protection → disable
> for Production (Preview-only is fine).

## 4. Gemini (optional — AI festival research)

Key: <https://aistudio.google.com/apikey>. The free tier is enough.

> **Trap — the model pin rots.** `ListModels` will happily list a model your
> key cannot call: listing is not access. A retired model answers
> `404 NOT_FOUND "no longer available to new users"` on every
> `generateContent`, which reads like a bad key and is not.
> The model lives in **one** place — `GEMINI_MODEL` in
> [`api/_lib/guard.mjs`](../api/_lib/guard.mjs) — and is a floating alias
> (`gemini-flash-latest`) so it cannot decay the same way. If research starts
> 404ing, check there first.

> **Trap — 429 does not mean "you must pay".** Google Search grounding *does*
> work on the free tier (verified: `200` with 7 grounding chunks). But its
> rate limits are tight and grounded calls trip them first, returning
> `429 RESOURCE_EXHAUSTED "check your plan and billing details"` on every
> model — which reads as a billing wall and is not one. Space your calls out
> before concluding anything. (The endpoint already rate-limits real users to
> 5 research calls/hour.)

**Free tier vs. billing.** Free is enough to try research and to develop
against. For real use, enable billing on the key's Google Cloud project:
festival research is *grounded by definition*, grounded calls are exactly the
ones that exhaust free quota first, and a crew hitting 429s cannot tell a rate
limit from a broken feature. This deployment runs a billing-enabled key for
that reason. Billing raises the limits — it does not unlock grounding, which
was already available.

Grounding sometimes returns **zero source URLs** even on a good 200 response;
the UI says so out loud. Treat every result as a *candidate* — nothing is
saved until a human confirms it on screen.

## 5. Local development

```bash
vercel link
vercel env pull .env.local      # gitignored via .env*
vercel dev                      # http://localhost:3000
```

Run the full suite, including the real-Postgres concurrency test that is
skipped without a database:

```bash
node --env-file=.env.local --test tests/*.test.mjs   # 178 pass
```

> **Traps —**
> - `vercel dev` will not serve files created after it started, and can serve
>   **stale** copies of edited files. Restart it; verify with
>   `curl … | md5` against the local file.
> - There is deliberately **no `dev` npm script** — `vercel dev` refuses to run
>   if one calls it (recursion check).
> - **The service worker will serve you a stale app.** After deploying, a
>   browser holding the old SW keeps serving old JS even though the server has
>   new bytes — fixes read as "not applied". Bump `CACHE_VERSION` in
>   `service-worker.js` on every asset-changing commit; when testing, unregister
>   the SW and clear its cache. If `curl` and the browser disagree, the browser
>   is lying.
> - Node: CI and Vercel run **24.x**. Match it locally if you see odd behaviour.

## 6. Spotify (optional)

Spotify's Feb-2026 rules shape everything here: a development-mode app allows
**5 authorized users**, one dev-mode app per developer, and the owner needs
**Premium**.

1. <https://developer.spotify.com/dashboard> → **Create app**.
2. Add Redirect URIs — they must match **character for character**:
   - `https://<your CANONICAL_HOST>/spotify-callback`
   - `http://127.0.0.1:3000/spotify-callback` for local dev.
     Use `127.0.0.1`, **not** `localhost` — Spotify no longer accepts
     `localhost`, though the app treats both as local.
   - Add any other domain you actually serve from (each alias needs its own).
3. Choose **Web API**.
4. Copy the **Client ID** → paste it in-app under **Settings → Spotify**.
   It is stored per-crew in the crew doc, **not** as an env var. There is no
   client secret: this is PKCE, so the Client ID is public by design. If
   anything asks you for a secret, something is wrong.
5. **User Management** → add each member's Spotify account email, **including
   your own**. The owner is not automatically allowlisted, and nobody can
   connect until their email is on that list.

`INVALID_CLIENT: Invalid redirect URI` means the registered URI does not match
exactly — check scheme, host, and trailing slash.

## 7. Deploy

```bash
vercel deploy --prod
```

Then confirm it is genuinely public (not behind Deployment Protection):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-domain>/data/festivals/index.json
# expect 200, not 302
```

## 8. Adding festivals

See [`add-a-festival.md`](add-a-festival.md). Validate before committing —
CI enforces it:

```bash
node scripts/validate-festivals.mjs
```
