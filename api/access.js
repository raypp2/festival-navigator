// Spotify allowlist requests — the recordOS-style Slack flow, ported.
//
// Spotify dev-mode apps require the OWNER to manually add each user's Spotify
// email in the developer dashboard, and owners rarely know friends' emails.
// This flow: friend submits their email in-app -> owner gets a Slack message
// with an approve button -> approving flips the row here AND redirects the
// owner to the Spotify dashboard to paste the email (the REAL gate) -> the
// friend's app polls its way to "approved" and offers the connect button.
//
//   GET  /api/access?config=1                         -> { enabled, ownerClientId }
//   POST /api/access            { email }             -> { status }  (+ Slack ping)
//   GET  /api/access?email=x                          -> { status }  (polled)
//   GET  /api/access?approve=1&email=x&exp=t&sig=h    -> 302 to Spotify dashboard
//
// Enabled only when SLACK_WEBHOOK_URL + APPROVE_SECRET + OWNER_SPOTIFY_CLIENT_ID
// are set; the client shows the flow only for crews using the owner's app —
// other crews bring their own Spotify apps and their owners aren't on this Slack.
//
// Security: the approve link carries a per-email, time-limited HMAC (not the
// raw secret), and its origin comes from a trusted canonical base URL, never
// the request Host header. So a spoofed-Host request cannot make the Slack
// link point at an attacker origin, and a leaked link cannot approve any
// email but the one it was minted for, nor survive past its expiry.
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { rateLimited, crossSite } from './_lib/guard.mjs';

// Conservative address shape: the permissive old RE ([^@\s]+) admitted Slack
// mrkdwn metacharacters (<, |, *) in the local part — enough to inject a
// styled link into the OWNER's approval message (sweep P1, 2026-07-12).
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Belt to the RE's suspenders: escape mrkdwn's specials wherever an email is
// interpolated into a Slack message (per Slack's own escaping rules).
const mrkdwnEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const APPROVE_TTL_MS = 60 * 60 * 1000; // approve links expire after an hour
// Hosts we will build an approve link for when PUBLIC_BASE_URL is unset.
// Only THIS deployment's own hostnames, whose `-raypp2` team-slug suffix an
// attacker cannot forge. A bare `.vercel.app$` would trust every tenant's
// deployments — the hole this list closes.
//
// FORK: upstream allowlisted kevinhg.com + `-kevinhg` preview URLs. Left
// as-is, this deployment would refuse to build an approve link on its OWN
// hosts (falling through to "no trusted base URL") while trusting the
// upstream author's. Both the production alias and the longer preview form
// are listed. Setting PUBLIC_BASE_URL bypasses this list entirely.
const HOST_ALLOW = [
  /^ray-festival\.vercel\.app$/,
  /^festival-navigator-raypp2\.vercel\.app$/,
  /^festival-navigator-[a-z0-9]+-raypp2\.vercel\.app$/,
];
const hostAllowed = (host) => HOST_ALLOW.some((re) => re.test(host));

const enabled = () =>
  !!(process.env.SLACK_WEBHOOK_URL && process.env.APPROVE_SECRET && process.env.OWNER_SPOTIFY_CLIENT_ID);

// Per-email, expiring HMAC. base64url(HMAC-SHA256(secret, "email|exp")).
function sign(email, exp) {
  return crypto.createHmac('sha256', process.env.APPROVE_SECRET)
    .update(`${email}|${exp}`).digest('base64url');
}
function validSig(email, exp, sig) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
  const expected = sign(email, exp);
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Trusted origin for the approve link — env first, then an allowlisted Host.
// Returns null if neither is trustworthy (link is then omitted, never forged).
function canonicalBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = (req.headers.host || '').toString();
  if (hostAllowed(host.split(':')[0])) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
    return `${proto}://${host}`;
  }
  return null;
}

async function notifySlack(email, baseUrl) {
  const exp = Date.now() + APPROVE_TTL_MS;
  const approveUrl = `${baseUrl}/api/access?approve=1&email=${encodeURIComponent(email)}&exp=${exp}&sig=${sign(email, exp)}`;
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🎪 Festival Navigator — Spotify access request' } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${mrkdwnEscape(email)}* wants to connect Spotify.\nApproving opens the Spotify dashboard — paste their email under User Management there (that's the real gate).` } },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve + open Spotify dashboard' }, url: approveUrl }] },
      ],
    }),
  });
  return res.ok;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (crossSite(req)) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });

  // Config probe works even when disabled, so the client can hide the UI.
  if (req.method === 'GET' && req.query.config) {
    return res.status(200).json({ enabled: enabled(), ownerClientId: process.env.OWNER_SPOTIFY_CLIENT_ID || '' });
  }
  if (!enabled()) return res.status(503).json({ error: 'Access requests are not enabled on this deployment' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'Store not configured' });
  const sql = neon(process.env.DATABASE_URL);

  // ---- owner approval (the Slack button) ----
  if (req.method === 'GET' && req.query.approve) {
    const email = String(req.query.email || '').toLowerCase();
    if (!validSig(email, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'Approval link is invalid or expired' });
    }
    const rows = await sql`
      UPDATE access_requests SET status = 'approved', approved_at = now()
      WHERE email = ${email} RETURNING email`;
    if (!rows.length) return res.status(404).json({ error: 'No such request' });
    // no-referrer so the signed link is not sent on to spotify.com; no-store
    // so no intermediary caches the approval redirect.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', `https://developer.spotify.com/dashboard/${process.env.OWNER_SPOTIFY_CLIENT_ID}/users`);
    return res.status(302).end();
  }

  // ---- status poll ----
  if (req.method === 'GET') {
    if (rateLimited(req, 'access-poll', 120, 10 * 60 * 1000)) return res.status(429).json({ error: 'Polling too fast' });
    const email = String(req.query.email || '').toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Invalid email' });
    const rows = await sql`SELECT status FROM access_requests WHERE email = ${email}`;
    return res.status(200).json({ status: rows.length ? rows[0].status : 'none' });
  }

  // ---- new request ----
  if (req.method === 'POST') {
    if (rateLimited(req, 'access-request', 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests — try again later' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'That does not look like an email address' });

    // Already approved? Skip straight there (returning member, new device).
    const rows = await sql`
      INSERT INTO access_requests (email) VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING status`;
    const status = rows[0].status;
    let notified = false;
    if (status === 'pending') {
      const baseUrl = canonicalBaseUrl(req);
      if (baseUrl) {
        try { notified = await notifySlack(email, baseUrl); } catch (e) { console.error('slack notify failed:', e); }
      } else {
        console.error('access: no trusted base URL (set PUBLIC_BASE_URL); Slack link omitted');
      }
    }
    return res.status(200).json({ status, notified });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
