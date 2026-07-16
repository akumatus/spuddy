// Tiny helpers shared by the router and the batch generator.

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pp-app,x-pp-admin,x-pp-provider,x-pp-model',
};

export const json = (obj: unknown, status = 200): Response =>
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
