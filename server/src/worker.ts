// Spuddy server — Cloudflare Worker.
//
//   GET  /cards          today's pre-generated card batch (all personas)
//   POST /chat           real-time chat reply (geo-routed, per-device quota)
//   POST /golden         real-time personalized golden card (same quota)
//   POST /greet          real-time personalized open-the-app greeting (same quota)
//   POST /admin/generate?lang=en|zh  Worker-side batch regen via LLM (protected) —
//                        one language per call; run once per language after deploy
//   POST /admin/put?lang=en|zh  store a batch generated OUTSIDE the Worker
//                        (protected) — the free, membership-generated path
//   POST /admin/quotes?lang=en|zh  append fresh famous quotes to the growing
//                        library (protected) — golden-card source
//   GET  /health         liveness
//
// Daily pools (shared normal pool + per-persona mutters) reach KV two ways: the
// cron trigger generates them via LLM (generate.ts), OR a scheduled Claude Code
// routine on the maintainer's membership POSTs a ready-made batch to /admin/put
// (no API cost). Ordinary draws read KV and never hit an LLM. Real-time
// endpoints (/chat, /golden, /greet) are metered against a per-device budget.

import { generateForLang, putForLang } from './generate';
import { appendQuotes, readQuotes } from './quotes-store';
import { PERSONAS, buildChatSystem, buildGoldenPrompt, buildGreetPrompt, parseGesture, parseRemember, parseTag } from './personas';
import { callLLMChain, chatProviderChain, loadConfig, type RuntimeConfig } from './providers';
import { MOODS, asLang, batchKey, type CardsBatch, type ChatPayload, type Env, type Lang } from './types';
import { CORS, clean, json, today } from './util';

// The zh cron expression — must match the second entry in wrangler.toml's
// [triggers]; any other firing (the 16:00 one) generates the English batch.
const CRON_ZH = '20 16 * * *';

// Optional soft gate: baking a shared token into the app deters casual abuse of
// your key. It is not real auth (extractable from the build) — the per-device
// quota + Cloudflare rate limiting are the real defense.
function authed(request: Request, env: Env): boolean {
  if (!env.APP_TOKEN) return true; // open in dev
  return request.headers.get('x-pp-app') === env.APP_TOKEN;
}

// Admin-gated per-request override for local A/B comparison testing. With a valid
// admin token, x-pp-provider (+ optional x-pp-model) forces the call onto ONE
// specific backend with no fallback — so the same message can be fired at
// openai/gemini/deepseek/anthropic and compared without touching the live KV
// config. Ungated only when no token is set at all (open dev). Returns the chain
// to try + the models map with the override folded in.
function withOverride(defaultChain: string[], request: Request, env: Env, cfg: RuntimeConfig) {
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

interface QuotaState {
  key: string;
  used: number;
  limit: number;
  ok: boolean;
}

// Read-only budget check. Counting is deferred to bumpQuota, which only runs
// after a successful model reply — so a failed/errored/over-quota provider call
// never burns the user's daily budget.
async function quotaState(env: Env, deviceId: string | undefined): Promise<QuotaState> {
  const limit = parseInt(env.CHAT_DAILY_LIMIT || '40', 10);
  const key = `q:${deviceId || 'anon'}:${today()}`;
  const used = parseInt((await env.KV.get(key)) || '0', 10);
  return { key, used, limit, ok: used < limit };
}

async function bumpQuota(env: Env, q: QuotaState): Promise<void> {
  // TTL ~2 days so counters self-clean; KV is eventually consistent, so a burst
  // of concurrent calls may slip a couple over — fine for hobby anti-abuse.
  await env.KV.put(q.key, String(q.used + 1), { expirationTtl: 172800 });
}

// Per-language batch summary for the admin responses (/admin/generate, /admin/put).
function batchCounts(batch: CardsBatch): Record<string, unknown> {
  return {
    normal: batch.normal.length,
    ...Object.fromEntries(
      Object.entries(batch.cards).map(([k, v]) => [
        k,
        { mutters: v.mutters ? MOODS.reduce((s, m) => s + (v.mutters[m]?.length || 0), 0) : 0 },
      ])
    ),
  };
}

// A few of today's cron-baked mutters, fed into the chat prompt as the pet's
// inner life — conversational material the daily batch already paid for.
// Best-effort: any KV miss or shape change just means no musings this turn.
async function todaysMusings(env: Env, charId: string | undefined, lang: Lang): Promise<string[]> {
  try {
    const raw = await env.KV.get(batchKey(lang));
    const mutters = raw ? (JSON.parse(raw) as CardsBatch).cards?.[charId || '']?.mutters : null;
    if (!mutters) return [];
    const pool = MOODS.flatMap((k) => mutters[k] || []);
    const out: string[] = [];
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
        const lang = asLang(url.searchParams.get('lang'));
        // the growing famous-quote library rides on every answer — it's stored
        // separately from the daily batch (quotes-store.ts) and is the golden
        // card's source, so it comes along even when the batch is missing/stale
        const quotes = await readQuotes(env, lang);
        // no en fallback for a missing zh batch (possible until the first cron
        // after deploy): the app treats an empty answer as "use built-ins",
        // which keeps a Chinese user on Chinese cards instead of English ones
        const raw = await env.KV.get(batchKey(lang));
        if (!raw) return json({ stale: true, date: null, normal: [], cards: {}, quotes });
        const data = JSON.parse(raw) as CardsBatch;
        const char = url.searchParams.get('char');
        if (char) return json({ date: data.date, normal: data.normal || [], cards: { [char]: data.cards[char] || null }, quotes });
        return json({ ...data, quotes });
      }

      if (url.pathname === '/chat' && request.method === 'POST') {
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        const p = (await request.json()) as ChatPayload;
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ limited: true, used: q.used, limit: q.limit }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
        const system = buildChatSystem(persona, p, await todaysMusings(env, p.charId, asLang(p.lang)));
        const messages = (p.messages || []).map((m) => ({
          role: m.who === 'user' ? 'user' : 'assistant',
          content: m.text || '',
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
        const p = (await request.json()) as ChatPayload;
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ limited: true }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
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
        const p = (await request.json()) as ChatPayload;
        const q = await quotaState(env, p.deviceId);
        if (!q.ok) return json({ text: null, limited: true }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
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
          const body = (await request.json()) as Record<string, unknown>;
          const next: RuntimeConfig = {};
          for (const k of ['chat', 'gen'] as const) {
            const v = body[k];
            if (typeof v === 'string' && v.trim()) next[k] = v.trim().toLowerCase();
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
        // One language per call — a single invocation's subrequest budget can't
        // fit both batches (see generateForLang). Run it once per language.
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const batch = await generateForLang(env, lang);
        return json({ ok: true, lang, date: batch.date, counts: batchCounts(batch) });
      }

      // Accept a batch generated OUTSIDE the Worker (e.g. a scheduled Claude
      // Code routine on the maintainer's membership) and store it. No LLM work
      // here, so this path is free against the API budget — the routine is the
      // generator, the Worker is just the inbox. Same admin gate + one language
      // per call as /admin/generate. Body: { normal: [...], cards: { id: { mutters: {...} } } }.
      if (url.pathname === '/admin/put' && request.method === 'POST') {
        const want = env.ADMIN_TOKEN || env.APP_TOKEN;
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400);
        const batch = await putForLang(env, lang, body);
        return json({ ok: true, lang, date: batch.date, counts: batchCounts(batch) });
      }

      // Append fresh famous quotes to the persistent library (the golden-card
      // source). The daily membership routine POSTs a few new lines here; the
      // Worker dedupes against the existing library and keeps the newest
      // QUOTES_LIB_MAX. No LLM work — same free path as /admin/put.
      // Body: { quotes: [{ q: "…", s?: "…" }, …] }.
      if (url.pathname === '/admin/quotes' && request.method === 'POST') {
        const want = env.ADMIN_TOKEN || env.APP_TOKEN;
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const body = (await request.json().catch(() => null)) as { quotes?: unknown } | null;
        if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400);
        const max = parseInt(env.QUOTES_LIB_MAX || '1000', 10);
        const { added, total } = await appendQuotes(env, lang, body.quotes, max);
        return json({ ok: true, lang, added, total });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && (e as Error).message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // One language per firing (see generateForLang): the en cron and the zh
    // cron are separate invocations, each with its own subrequest budget.
    // Keep the expressions in sync with [triggers] in wrangler.toml.
    const lang = event.cron === CRON_ZH ? 'zh' : 'en';
    ctx.waitUntil(generateForLang(env, lang));
  },
} satisfies ExportedHandler<Env>;
