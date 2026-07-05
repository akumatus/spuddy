// Spuddy server — Cloudflare Worker.
//
//   GET  /cards          today's pre-generated card batch (all personas)
//   POST /chat           real-time chat reply (geo-routed, per-device quota)
//   POST /golden         real-time personalized golden card (same quota)
//   POST /admin/generate manual batch regen (protected) — run once after deploy
//   GET  /health         liveness
//
// Daily card pools are knit by the cron trigger (scheduled handler) and served
// from KV so ordinary draws never hit an LLM. Real-time endpoints route by the
// caller's country and are metered against a per-device daily budget.

import { PERSONAS, CHAT_IDS, buildChatSystem, buildGoldenPrompt, buildBatchPrompt, parseTag } from './personas.js';
import { callLLM, pickChatProvider } from './providers.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pp-app,x-pp-geo,x-pp-admin',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

const today = () => new Date().toISOString().slice(0, 10);
const clean = (out) => (out || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');

// Optional soft gate: baking a shared token into the app deters casual abuse of
// your key. It is not real auth (extractable from the build) — the per-device
// quota + Cloudflare rate limiting are the real defense.
function authed(request, env) {
  if (!env.APP_TOKEN) return true; // open in dev
  return request.headers.get('x-pp-app') === env.APP_TOKEN;
}

// x-pp-geo overrides Cloudflare's geoip — handy for testing routing locally.
function geoOf(request) {
  return (request.headers.get('x-pp-geo') || request.cf?.country || 'US').toUpperCase();
}

async function checkQuota(env, deviceId) {
  const limit = parseInt(env.CHAT_DAILY_LIMIT || '40', 10);
  const key = `q:${deviceId || 'anon'}:${today()}`;
  const used = parseInt((await env.KV.get(key)) || '0', 10);
  if (used >= limit) return { ok: false, used, limit };
  // TTL ~2 days so counters self-clean; KV is eventually consistent, so a burst
  // of concurrent calls may slip a couple over — fine for hobby anti-abuse.
  await env.KV.put(key, String(used + 1), { expirationTtl: 172800 });
  return { ok: true, used: used + 1, limit };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/health') return json({ ok: true });

      if (url.pathname === '/cards' && request.method === 'GET') {
        const raw = await env.KV.get('cards:current');
        if (!raw) return json({ stale: true, date: null, cards: {} });
        const data = JSON.parse(raw);
        const char = url.searchParams.get('char');
        if (char) return json({ date: data.date, cards: { [char]: data.cards[char] || null } });
        return json(data);
      }

      if (url.pathname === '/chat' && request.method === 'POST') {
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        const p = await request.json();
        const q = await checkQuota(env, p.deviceId);
        if (!q.ok) return json({ limited: true, used: q.used, limit: q.limit }, 429);

        const persona = PERSONAS[p.charId] || PERSONAS.spud;
        const system = buildChatSystem(persona, p);
        const messages = (p.messages || []).map((m) => ({
          role: m.who === 'user' ? 'user' : 'assistant',
          content: m.text,
        }));
        const provider = pickChatProvider(geoOf(request), env);
        const out = clean(await callLLM(env, provider, { system, messages, maxTokens: 300 }));
        if (!out) return json(null);
        const { tag, body } = parseTag(out);
        return json({ tag, text: body.slice(0, 220), provider });
      }

      if (url.pathname === '/golden' && request.method === 'POST') {
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        const p = await request.json();
        const q = await checkQuota(env, p.deviceId);
        if (!q.ok) return json({ limited: true }, 429);

        const persona = PERSONAS[p.charId] || PERSONAS.spud;
        const prompt = buildGoldenPrompt(persona, p);
        const provider = pickChatProvider(geoOf(request), env);
        const out = clean(
          await callLLM(env, provider, { system: '', messages: [{ role: 'user', content: prompt }], maxTokens: 200 })
        );
        return json({ text: out && out.length > 4 && out.length < 220 ? out : null, provider });
      }

      if (url.pathname === '/admin/generate' && request.method === 'POST') {
        const want = env.ADMIN_TOKEN || env.APP_TOKEN;
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const data = await generateAll(env);
        const counts = Object.fromEntries(
          Object.entries(data.cards).map(([k, v]) => [k, { normal: v.normal.length, golden: v.golden.length }])
        );
        return json({ ok: true, date: data.date, counts });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateAll(env));
  },
};

async function generateForChar(env, id, opts) {
  const { genProvider, nNormal, nGolden } = opts;
  const prompt = buildBatchPrompt(PERSONAS[id], nNormal, nGolden);
  let last = { normal: [], golden: [] };
  // one retry — the batch call occasionally returns throttled/unparseable
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callLLM(env, genProvider, {
        system: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 3000, // 34 lines of JSON — 1600 truncated the tail (invalid JSON)
        temperature: 0.9,
        json: true, // force clean JSON so parsing can't silently drop a persona
      });
      const parsed = extractJson(text);
      const normal = sanitizeList(parsed?.normal, nNormal);
      const golden = sanitizeList(parsed?.golden, nGolden);
      if (normal.length || golden.length) return { normal, golden };
      last = { normal, golden };
    } catch (e) {
      // transient (rate limit / timeout) — fall through to retry
    }
  }
  return last;
}

async function generateAll(env) {
  const opts = {
    genProvider: env.GEN_PROVIDER || 'deepseek',
    nNormal: parseInt(env.CARDS_PER_DAY || '24', 10),
    nGolden: parseInt(env.GOLDEN_PER_DAY || '10', 10),
  };
  // Generate every persona CONCURRENTLY. Sequential calls accumulate wall time
  // and the later ones get throttled/cut; concurrent keeps total time ~= one call.
  const results = await Promise.all(
    CHAT_IDS.map((id) => generateForChar(env, id, opts).catch(() => ({ normal: [], golden: [] })))
  );
  const cards = {};
  CHAT_IDS.forEach((id, i) => { cards[id] = results[i]; });

  // Never clobber a good pool with an empty one — if a persona hiccups this run,
  // keep whatever it had last time so no character is ever left with no cards.
  const prevRaw = await env.KV.get('cards:current');
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw).cards || {};
      for (const id of CHAT_IDS) {
        if (!cards[id].normal.length && !cards[id].golden.length && prev[id]) cards[id] = prev[id];
      }
    } catch (e) {}
  }

  const data = { date: today(), cards };
  await env.KV.put('cards:current', JSON.stringify(data));
  return data;
}

function sanitizeList(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => clean(String(s)))
    .filter((s) => s.length > 3 && s.length < 200)
    .slice(0, max);
}

function extractJson(text) {
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
