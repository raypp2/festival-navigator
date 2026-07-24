// Crew-scoped festival add via LLM lineup research.
//
//   POST /api/festival-add?t=<crew token>  {name}
//       -> Gemini (search-grounded) researches the festival, returns a
//          VALIDATED candidate doc + source URLs. NOTHING IS SAVED — the
//          client shows a preview the user must confirm (the human approval
//          gate; this endpoint reads untrusted web content, so LLM output is
//          data only, schema-validated, never executed or trusted).
//   POST /api/festival-add?t=<token>  {confirm: true, festival: {...}, sources?: []}
//       -> re-validates server-side, upserts into custom_festivals keyed
//          (token, fest id). Idempotent; retries safe.
//   GET  /api/festival-add?t=<token>
//       -> this crew's custom festivals (loader merges with the static catalog).
//
// Custom festivals are PRIVATE to the crew (no moderation surface); the repo's
// data/festivals/*.json stays canonical for shared festivals.
import { neon } from '@neondatabase/serverless';
import { rateLimited, crossSite, callGemini, GEMINI_MODEL } from './_lib/guard.mjs';
import { TOKEN_RE, LIMITS } from './_lib/crew-shared.mjs';
import { validateFestivalDoc, SLUG_RE } from './_lib/festival-rules.mjs';

const NAME_RE = /^[^\x00-\x1f<>"'`\\]{2,80}$/;

function researchPrompt(name) {
  return `Research the music festival "${name}" using web search. Return ONLY a JSON object (no markdown fence, no prose before or after) with this exact shape:
{
  "id": "<lowercase-slug-with-year, e.g. bonnaroo-2026>",
  "name": "<festival display name, no year>",
  "year": "<'YY with apostrophe, e.g. '26>",
  "subtitle": "<venue name>",
  "location": "<City, ST or City, Country>",
  "dates": "<human-readable dates>",
  "status": "<lineup if artists are announced but not set times; archived if the festival already happened; lineup if unsure>",
  "artists": [{"name": "<official spelling>", "day": "<Friday etc, omit if unknown>"}]
}
Rules: artist names must use the artist's own official spelling/casing. Include the COMPLETE announced lineup, not a sample. If a field is unknown, omit it rather than guessing — never invent dates or artists. If you cannot find this festival at all, return {"notFound": true, "closest": ["<candidate names you did find>"]}.`;
}

// Extract the first top-level JSON object from grounded (prose-capable) output.
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = inStr; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (crossSite(req)) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'Store not configured' });

  const token = (req.query.t || '').toString();
  if (!TOKEN_RE.test(token)) return res.status(400).json({ error: 'Missing or malformed crew token' });
  const sql = neon(process.env.DATABASE_URL);

  try {
    const crew = await sql`SELECT 1 FROM crews WHERE token = ${token}`;
    if (!crew.length) return res.status(404).json({ error: 'Crew not found' });

    if (req.method === 'GET') {
      const rows = await sql`SELECT doc, source_urls, created_at FROM custom_festivals WHERE token = ${token} ORDER BY created_at`;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ festivals: rows.map((r) => r.doc) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};

    // ---- confirm & save (idempotent upsert) ----
    if (body.confirm === true) {
      if (rateLimited(req, 'festival-save', 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many saves — try later' });
      const fest = body.festival;
      const { errors } = validateFestivalDoc(fest);
      if (errors.length) return res.status(400).json({ error: `Festival failed validation: ${errors[0]}` });
      if (!SLUG_RE.test(fest.id)) return res.status(400).json({ error: 'Bad festival id' });
      const bytes = Buffer.byteLength(JSON.stringify(fest), 'utf8');
      if (bytes > LIMITS.docBytes) return res.status(413).json({ error: 'Festival document too large' });
      const sources = Array.isArray(body.sources) ? body.sources.filter((s) => typeof s === 'string' && s.startsWith('http')).slice(0, 12) : [];
      const createdBy = typeof body.person === 'string' ? body.person.slice(0, LIMITS.personName) : null;
      await sql`
        INSERT INTO custom_festivals (token, fest_id, doc, source_urls, model, created_by)
        VALUES (${token}, ${fest.id}, ${JSON.stringify(fest)}::jsonb, ${JSON.stringify(sources)}::jsonb, ${GEMINI_MODEL}, ${createdBy})
        ON CONFLICT (token, fest_id) DO UPDATE SET doc = EXCLUDED.doc, source_urls = EXCLUDED.source_urls, updated_at = now()`;
      return res.status(200).json({ saved: true, id: fest.id });
    }

    // ---- research (preview only; nothing saved) ----
    if (rateLimited(req, 'festival-research', 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Research limit reached — try again in an hour' });
    const name = (body.name || '').toString().trim();
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Give the festival a plausible name (2-80 characters)' });

    const result = await callGemini(researchPrompt(name), { grounded: true });
    if (result.error) return res.status(result.status).json({ error: result.error });
    const candidate = extractJson(result.text);
    if (!candidate) return res.status(502).json({ error: 'Research returned no usable data — try again or add manually' });
    if (candidate.notFound) return res.status(404).json({ error: 'Could not find that festival', closest: (candidate.closest || []).slice(0, 5) });

    const { errors, warnings } = validateFestivalDoc(candidate);
    if (errors.length) return res.status(502).json({ error: `Research result failed validation: ${errors[0]}` });
    return res.status(200).json({ candidate, warnings, sources: result.sources || [] });
  } catch (error) {
    console.error('festival-add error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
