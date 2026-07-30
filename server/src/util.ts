// Tiny helpers shared by the router and the batch generator.

// CORS is enforced by BROWSERS, never by servers: curl, a Node script, and the
// Electron main process all ignore these headers. Serving them on every route
// therefore protected nothing — it only granted web pages permission to call
// the endpoints that spend money. They now ride on the two public read routes
// (/health, /cards), where a browser is a plausible caller and nothing costs
// anything. Withholding them from the metered routes makes a JSON POST from a
// page fail its preflight, which removes the zero-effort way to abuse them:
// pasting a fetch() into a browser console. A scripted caller is unaffected —
// that is what the rate limit and the input caps are for.
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pp-app',
};

// Default response — no CORS headers, so a browser cannot read it.
export const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// For the public read routes only (/health, /cards).
export const corsJson = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

export const today = (): string => new Date().toISOString().slice(0, 10);

export const clean = (out: string | null | undefined): string =>
  (out || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');

// Pull the first JSON object out of an LLM reply, tolerating code fences and
// trailing commas. Shared by the batch generator and the /distill parser.
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    // tolerate trailing commas before } or ]
    try {
      return JSON.parse(m[0].replace(/,(\s*[}\]])/g, '$1'));
    } catch (e2) {
      return null;
    }
  }
}
