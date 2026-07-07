// Spuddy server — Cloudflare Worker.
//
//   GET  /cards          today's pre-generated card batch (all personas)
//   POST /chat           real-time chat reply (geo-routed, per-device quota)
//   POST /golden         real-time personalized golden card (same quota)
//   POST /greet          real-time personalized open-the-app greeting (same quota)
//   POST /admin/generate manual batch regen (protected) — run once after deploy
//   GET  /health         liveness
//
// Daily card pools are knit by the cron trigger (scheduled handler) and served
// from KV so ordinary draws never hit an LLM. Real-time endpoints route by the
// caller's country and are metered against a per-device daily budget.

import { PERSONAS, CHAT_IDS, buildChatSystem, buildGoldenPrompt, buildGreetPrompt, buildBatchPrompt, buildMutterPrompt, parseTag, parseGesture, parseRemember } from './personas.js';
import { callLLMChain, chatProviderChain, genProviderChain, loadConfig } from './providers.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pp-app,x-pp-admin,x-pp-provider,x-pp-model',
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

// Admin-gated per-request override for local A/B comparison testing. With a valid
// admin token, x-pp-provider (+ optional x-pp-model) forces the call onto ONE
// specific backend with no fallback — so the same message can be fired at
// openai/gemini/deepseek/anthropic and compared without touching the live KV
// config. Ungated only when no token is set at all (open dev). Returns the chain
// to try + the models map with the override folded in.
function withOverride(defaultChain, request, env, cfg) {
  let chain = defaultChain;
  let models = cfg.models;
  const want = env.ADMIN_TOKEN || env.APP_TOKEN;
  if (want && request.headers.get('x-pp-admin') !== want) return { chain, models };
  const p = request.headers.get('x-pp-provider');
  const m = request.headers.get('x-pp-model');
  if (p) chain = [p.trim().toLowerCase()]; // force exactly one backend for A/B
  if (m) models = { ...models, [chain[0]]: m.trim() };
  return { chain, models };
}

// Read-only budget check. Counting is deferred to bumpQuota, which only runs
// after a successful model reply — so a failed/errored/over-quota provider call
// never burns the user's daily budget.
async function quotaState(env, deviceId) {
  const limit = parseInt(env.CHAT_DAILY_LIMIT || '40', 10);
  const key = `q:${deviceId || 'anon'}:${today()}`;
  const used = parseInt((await env.KV.get(key)) || '0', 10);
  return { key, used, limit, ok: used < limit };
}

async function bumpQuota(env, q) {
  // TTL ~2 days so counters self-clean; KV is eventually consistent, so a burst
  // of concurrent calls may slip a couple over — fine for hobby anti-abuse.
  await env.KV.put(q.key, String(q.used + 1), { expirationTtl: 172800 });
}

// A few of today's cron-baked mutters, fed into the chat prompt as the pet's
// inner life — conversational material the daily batch already paid for.
// Best-effort: any KV miss or shape change just means no musings this turn.
async function todaysMusings(env, charId) {
  try {
    const raw = await env.KV.get('cards:current');
    const mutters = raw ? JSON.parse(raw).cards?.[charId]?.mutters : null;
    if (!mutters) return [];
    const pool = MOODS.flatMap((k) => mutters[k] || []);
    const out = [];
    while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  } catch {
    return [];
  }
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
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ limited: true, used: q.used, limit: q.limit }, 429);

        const persona = PERSONAS[p.charId] || PERSONAS.spud;
        const system = buildChatSystem(persona, p, await todaysMusings(env, p.charId));
        const messages = (p.messages || []).map((m) => ({
          role: m.who === 'user' ? 'user' : 'assistant',
          content: m.text,
        }));
        const cfg = await loadConfig(env);
        const { chain, models } = withOverride(chatProviderChain(env, cfg), request, env, cfg);
        // temperature 1.0 — warm but coherent; higher tipped non-English replies into word salad
        const { text: raw, provider, model } = await callLLMChain(env, chain, { system, messages, maxTokens: 300, temperature: 1.0, models });
        const out = clean(raw);
        if (!out) return json(null); // whole chain failed/empty — don't spend budget
        await bumpQuota(env, q); // only a real reply counts
        const { tag, body } = parseTag(out);
        const { gesture, body: afterGesture } = parseGesture(body); // optional action to act out
        const { remember, body: text } = parseRemember(afterGesture); // optional durable fact to keep
        return json({ tag, gesture, remember, text: text.slice(0, 260), provider, model });
      }

      if (url.pathname === '/golden' && request.method === 'POST') {
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        const p = await request.json();
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ limited: true }, 429);

        const persona = PERSONAS[p.charId] || PERSONAS.spud;
        const prompt = buildGoldenPrompt(persona, p);
        const cfg = await loadConfig(env);
        const { chain, models } = withOverride(chatProviderChain(env, cfg), request, env, cfg);
        // temperature 1.0 — creative but coherent
        const { text: raw, provider, model } = await callLLMChain(env, chain, {
          system: '', messages: [{ role: 'user', content: prompt }], maxTokens: 200, temperature: 1.0, models,
        });
        const out = clean(raw);
        if (!out) return json({ text: null, provider }); // failed — don't spend budget
        await bumpQuota(env, q); // successful weave counts
        return json({ text: out.length > 4 && out.length < 220 ? out : null, provider, model });
      }

      // Personalized open-the-app greeting — same per-device budget as chat.
      // Over budget or model failure just returns null text and the app speaks
      // its built-in daypart greeting instead.
      if (url.pathname === '/greet' && request.method === 'POST') {
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        const p = await request.json();
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ text: null, limited: true }, 429);

        const persona = PERSONAS[p.charId] || PERSONAS.spud;
        const prompt = buildGreetPrompt(persona, p);
        const cfg = await loadConfig(env);
        const chain = chatProviderChain(env, cfg);
        const { text: raw, provider } = await callLLMChain(env, chain, {
          system: '', messages: [{ role: 'user', content: prompt }], maxTokens: 120, temperature: 1.0, models: cfg.models,
        });
        const out = clean(raw);
        if (!out) return json({ text: null, provider }); // failed — don't spend budget
        await bumpQuota(env, q); // a real greeting counts
        return json({ text: out.length > 2 && out.length < 200 ? out : null, provider });
      }

      // Live provider/model switch. GET reads the current KV config, POST replaces
      // it. No redeploy needed — the next chat/golden/cron call reads the new value.
      //   curl -XPOST .../admin/config -H 'x-pp-admin: TOKEN' \
      //     -d '{"chat":"anthropic","gen":"openai","models":{"anthropic":"claude-haiku-4-5-20251001"}}'
      if (url.pathname === '/admin/config') {
        const want = env.ADMIN_TOKEN || env.APP_TOKEN;
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        if (request.method === 'GET') {
          const raw = await env.KV.get('config:current');
          return json(raw ? JSON.parse(raw) : {});
        }
        if (request.method === 'POST') {
          const body = await request.json();
          const next = {};
          for (const k of ['chat', 'gen']) {
            if (typeof body[k] === 'string' && body[k].trim()) next[k] = body[k].trim().toLowerCase();
          }
          if (body.models && typeof body.models === 'object') {
            next.models = {};
            for (const [k, v] of Object.entries(body.models)) {
              if (typeof v === 'string' && v.trim()) next.models[k] = v.trim();
            }
          }
          await env.KV.put('config:current', JSON.stringify(next));
          return json({ ok: true, config: next });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      if (url.pathname === '/admin/generate' && request.method === 'POST') {
        const want = env.ADMIN_TOKEN || env.APP_TOKEN;
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const data = await generateAll(env);
        const counts = Object.fromEntries(
          Object.entries(data.cards).map(([k, v]) => [
            k,
            {
              normal: v.normal.length,
              golden: v.golden.length,
              mutters: v.mutters ? MOODS.reduce((s, m) => s + (v.mutters[m]?.length || 0), 0) : 0,
            },
          ])
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

// Near-identical lines across runs collapse to one (punctuation/case ignored).
function dedupeLines(lines) {
  const seen = new Set();
  return lines.filter((s) => {
    const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function generateForChar(env, id, opts) {
  const { genChain, nNormal, nGolden, runs } = opts;
  // Several small calls instead of one big one: long single batches template
  // out toward the tail, and each run draws its own inspiration seeds. Results
  // are merged and deduped.
  const perNormal = Math.ceil(nNormal / runs);
  const perGolden = Math.ceil(nGolden / runs);
  const runOnce = async () => {
    const prompt = buildBatchPrompt(PERSONAS[id], perNormal, perGolden); // fresh seeds per run
    // one retry — the batch call occasionally returns throttled/unparseable
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await callLLMChain(env, genChain, {
          system: '',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 3000, // ~27 lines of JSON per run at ~90 tokens/line — truncation makes the run unparseable
          temperature: 1.0, // lowered from 1.2 — high heat corrupts JSON mode and non-English lines
          timeoutMs: 240000, // not latency-sensitive, and queued runs (Workers cap concurrent connections) eat into the timer
          json: true, // force clean JSON so parsing can't silently drop a persona
          models: opts.models,
        });
        const parsed = extractJson(text);
        const normal = sanitizeList(parsed?.normal, perNormal);
        const golden = sanitizeList(parsed?.golden, perGolden);
        if (normal.length || golden.length) return { normal, golden };
      } catch (e) {
        // transient (rate limit / timeout) — fall through to retry
      }
    }
    return { normal: [], golden: [] };
  };
  const results = await Promise.all(Array.from({ length: runs }, runOnce));
  return {
    normal: dedupeLines(results.flatMap((r) => r.normal)).slice(0, nNormal),
    golden: dedupeLines(results.flatMap((r) => r.golden)).slice(0, nGolden),
  };
}

const MOODS = ['watch', 'alone', 'lonely'];

async function generateMuttersForChar(env, id, opts) {
  // Same small-runs strategy as the cards: fresh seeds per run, merge + dedupe.
  const per = Math.ceil(opts.nMutters / opts.runs);
  const runOnce = async () => {
    const prompt = buildMutterPrompt(PERSONAS[id], per); // fresh seeds per run
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await callLLMChain(env, opts.genChain, {
          system: '',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 1500, // ~24 short lines of JSON per run — headroom against truncation
          temperature: 0.95, // a notch below the cards: the mutter prompt already asks for absurdity, higher tips it into word salad
          timeoutMs: 240000, // same relaxed budget as the cards
          json: true,
          models: opts.models,
        });
        const parsed = extractJson(text);
        const out = {};
        for (const k of MOODS) out[k] = sanitizeList(parsed?.[k], per);
        if (MOODS.some((k) => out[k].length)) return out;
      } catch (e) {
        // transient — fall through to retry
      }
    }
    return null;
  };
  const results = (await Promise.all(Array.from({ length: opts.runs }, runOnce))).filter(Boolean);
  const mutters = {};
  for (const k of MOODS) mutters[k] = dedupeLines(results.flatMap((r) => r[k])).slice(0, opts.nMutters);
  return { mutters };
}

async function generateAll(env) {
  const cfg = await loadConfig(env);
  const opts = {
    genChain: genProviderChain(env, cfg),
    models: cfg.models,
    nNormal: parseInt(env.CARDS_PER_DAY || '24', 10),
    nGolden: parseInt(env.GOLDEN_PER_DAY || '10', 10),
    nMutters: parseInt(env.MUTTERS_PER_DAY || '12', 10),
    runs: Math.max(1, parseInt(env.GEN_RUNS || '2', 10)),
  };
  // Generate every persona CONCURRENTLY (cards + mutters). Sequential calls
  // accumulate wall time and the later ones get throttled/cut; concurrent keeps
  // total time ~= one call.
  const results = await Promise.all(
    CHAT_IDS.map(async (id) => {
      const [c, m] = await Promise.all([
        generateForChar(env, id, opts).catch(() => ({ normal: [], golden: [] })),
        generateMuttersForChar(env, id, opts).catch(() => ({ mutters: { watch: [], alone: [], lonely: [] } })),
      ]);
      return { ...c, ...m };
    })
  );
  const cards = {};
  CHAT_IDS.forEach((id, i) => { cards[id] = results[i]; });

  // Never clobber good content with empties — if a field hiccups this run, keep
  // whatever it had last time so no character is ever left with nothing.
  const prevRaw = await env.KV.get('cards:current');
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw).cards || {};
      for (const id of CHAT_IDS) {
        const p = prev[id];
        if (!p) continue;
        if (!cards[id].normal.length && p.normal?.length) cards[id].normal = p.normal;
        if (!cards[id].golden.length && p.golden?.length) cards[id].golden = p.golden;
        if (p.mutters) for (const k of MOODS) {
          if (!cards[id].mutters[k]?.length && p.mutters[k]?.length) cards[id].mutters[k] = p.mutters[k];
        }
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
