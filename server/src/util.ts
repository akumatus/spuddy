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
