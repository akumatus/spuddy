// Spuddy server — Cloudflare Worker.
//
//   GET  /cards          today's pre-generated card batch (all personas)
//   POST /chat           real-time chat reply (provider fallback chain, per-device quota)
//   POST /distill        batch memory extraction over a transcript chunk (same quota)
//   POST /golden         real-time personalized golden card (same quota)
//   POST /greet          real-time personalized open-the-app greeting (same quota)
//   POST /admin/code?code=<phrase>&limit=<n>  mint a single-use invite
//                        passphrase (protected); limit=0 revokes it
//   POST /admin/generate?lang=en|zh  Worker-side batch regen via LLM (protected) —
//                        one language per call; run once per language after deploy
//   POST /admin/put?lang=en|zh  store a batch generated OUTSIDE the Worker
//                        (protected) — the free, membership-generated path
//   GET  /admin/quotes?lang=en|zh  the FULL quotes + inet libraries (protected) —
//                        the routine's dedupe/per-source view; /cards only
//                        serves a small daily window of each
//   POST /admin/quotes?lang=en|zh  append fresh famous quotes to the growing
//                        library (protected) — golden-card source
//   POST /admin/inet?lang=en|zh  append internet-era lines to the persistent
//                        normal-card pool (protected) — the daily hunt's
//                        no-source finds + maintainer curation
//   GET  /health         liveness
//
// Daily pools (shared normal pool + per-persona mutters) reach KV two ways: the
// cron trigger generates them via LLM (generate.ts), OR a scheduled Claude Code
// routine on the maintainer's membership POSTs a ready-made batch to /admin/put
// (no API cost). Ordinary draws read KV and never hit an LLM. Real-time
// endpoints (/chat, /golden, /greet) are metered against a per-device budget.

import { generateForLang, putForLang } from './generate';
import { adminExpected, capChat, capCodes, capConsolidate, capDistill, matchCode, readJson, tokenAccepted } from './guard';
import { appendInet, appendQuotes, dailyWindow, readInet, readQuotes } from './quotes-store';
import { PERSONAS, buildChatSystem, buildConsolidateSystem, buildDistillSystem, buildGoldenPrompt, buildGreetPrompt, consolidateList, distillTranscript, parseConsolidateOps, parseDistillFacts, parseDistillLoops, parseGesture, parseRemember, parseTag } from './personas';
import { callLLMChain, chatProviderChain, loadConfig, type RuntimeConfig } from './providers';
import { MOODS, asLang, batchKey, type CardsBatch, type ChatPayload, type ConsolidatePayload, type DistillPayload, type Env, type Lang } from './types';
import { CORS, clean, corsJson, json, today } from './util';

// Durable Object classes must be exported from the Worker's main module for the
// runtime to find them (bound in wrangler.toml [[durable_objects.bindings]]).
export { DeviceQuota, InviteCode } from './quota-do';

// The zh cron expression — must match the second entry in wrangler.toml's
// [triggers]; any other firing (the 14:00 one) generates the English batch.
const CRON_ZH = '20 14 * * *';

// The only routes a browser may legitimately call: public reads, no token, no
// cost. Preflight for anything else is refused outright (see fetch()).
const PUBLIC_PATHS = new Set(['/health', '/cards']);

// A browser attaches Origin to every cross-site request; the Electron main
// process never does — verified against a real Electron build, whose fetch
// sends sec-fetch-mode but no Origin. Nothing legitimate breaks: the website
// makes no API calls and the renderer reaches the server over IPC, so an Origin
// on a metered route means a web page is calling us. Together with the withheld
// CORS headers (util.ts) this closes the paste-a-fetch-into-the-console path.
// A scripted caller just omits the header — that one is the rate limit's job.
const fromBrowser = (request: Request): boolean => request.headers.has('origin');

// Soft gate: a shared token baked into the app. Never real auth — it ships in
// every build and `npx asar extract` reveals it — so the per-device quota, the
// per-IP rate limit and the input caps remain the actual defense. What it does
// buy is keeping the endpoint out of reach of drive-by callers and automated
// scanners, which is why the value should no longer sit in the public repo.
//
// APP_TOKEN accepts a COMMA-SEPARATED list so a rotation never strands anyone:
// set it to "new,old", ship a build carrying the new value, then drop the old
// entry once everyone has updated. Blank (dev) leaves the door open.
function authed(request: Request, env: Env): boolean {
  return tokenAccepted(env.APP_TOKEN, request.headers.get('x-pp-app'));
}

const adminToken = (env: Env): string => adminExpected(env.ADMIN_TOKEN, env.APP_TOKEN);

// Admin-gated per-request override for local A/B comparison testing. With a valid
// admin token, x-pp-provider (+ optional x-pp-model) forces the call onto ONE
// specific backend with no fallback — so the same message can be fired at
// openai/gemini/deepseek/anthropic and compared without touching the live KV
// config. Ungated only when no token is set at all (open dev). Returns the chain
// to try + the models map with the override folded in.
function withOverride(defaultChain: string[], request: Request, env: Env, cfg: RuntimeConfig) {
  let chain = defaultChain;
  let models = cfg.models;
  const want = adminToken(env);
  if (want && request.headers.get('x-pp-admin') !== want) return { chain, models };
  const p = request.headers.get('x-pp-provider');
  const m = request.headers.get('x-pp-model');
  if (p) chain = [p.trim().toLowerCase()]; // force exactly one backend for A/B
  if (m) models = { ...models, [chain[0]]: m.trim() };
  return { chain, models };
}

// Fold consecutive same-role turns into one message. The app appends burst
// bubbles as separate pet lines (and queued human notes as separate user
// lines); some providers (Anthropic) reject non-alternating roles outright.
function mergeTurns(msgs: { role: string; content: string }[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

// ── per-IP burst guard ──
// The daily quota meters deviceId, which the client makes up and can rotate on
// every request — so on its own it stops an honest user from over-using and
// nothing else. The caller's IP is the one identifier a client cannot choose,
// so the metered endpoints pass through here first. Costs no KV writes (see the
// RT_LIMIT note in types.ts); a missing binding or a throwing limiter allows the
// request, since an abuse guard must never be the thing that takes chat down.
async function burstOk(env: Env, request: Request): Promise<boolean> {
  if (!env.RT_LIMIT) return true;
  try {
    const { success } = await env.RT_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    return success;
  } catch {
    return true;
  }
}

// Body-too-large / malformed-JSON short circuit shared by every POST route.
const reject = (r: { status: number; error: string }): Response => json({ error: r.error }, r.status);

// The admin doors legitimately carry a whole day's batch (~60 KB), so they get a
// far roomier ceiling than the chat endpoints — still a ceiling, because the
// isolate has 128 MB of memory and Cloudflare would hand us a 100 MB body.
const ADMIN_BODY_BYTES = 2 * 1024 * 1024;

interface QuotaState {
  deviceId: string;
  used: number;
  tries: number;
  limit: number;
  tryLimit: number;
  ok: boolean;
}

// A failed provider walk deliberately does NOT spend the reply budget — an
// outage must not cost someone their day. That leaves a hole on its own: a
// caller who can make calls fail on purpose gets unmetered model calls forever.
// So attempts are counted too, against a ceiling this many times the reply
// budget. An honest client would need 150 failures in one day to notice (there
// is no retry loop anywhere in the app — a failure just prints a fallback
// line), while a caller farming failures runs out quickly.
const TRY_MULTIPLIER = 3;

// What the pet says when a passphrase lands. Deliberately oblivious — he has no
// idea what just happened, which is the whole joke. No model call is made, so
// this text is fixed rather than generated.
const UNLOCK_ZH = '咦……刚才有什么咔哒响了一下';
const UNLOCK_EN = 'huh... something just went click somewhere';

// The daily per-device budget: KV config:current.chatLimit (hot-updatable via
// POST /admin/config — applies from the very next request, no redeploy, no
// client change) with the CHAT_DAILY_LIMIT [vars] default as fallback. One
// shared budget across chat/distill/consolidate/golden/greet.
function dailyLimit(env: Env, cfg: RuntimeConfig): number {
  const v = cfg.chatLimit;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  return parseInt(env.CHAT_DAILY_LIMIT || '50', 10);
}

// Read-only budget check against BOTH ceilings. Counting is deferred to
// bumpQuota so an over-quota or errored call is decided before any money is
// spent. The counters live in one Durable Object per device (quota-do.ts):
// atomic, and no KV write budget spent.
async function quotaState(env: Env, deviceId: string | undefined, limit: number): Promise<QuotaState> {
  const id = deviceId || 'anon';
  const { used, tries, grant } = await env.QUOTA.get(env.QUOTA.idFromName(id)).state(today());
  // a redeemed passphrase raises this device above the global default for good
  const effective = Math.max(limit, grant);
  const tryLimit = effective * TRY_MULTIPLIER;
  return { deviceId: id, used, tries, limit: effective, tryLimit, ok: used < effective && tries < tryLimit };
}

// `ok: false` records the attempt without spending the reply budget.
async function bumpQuota(env: Env, q: QuotaState, ok = true): Promise<void> {
  await env.QUOTA.get(env.QUOTA.idFromName(q.deviceId)).bump(today(), ok);
}

// Walk the provider chain, making sure the attempt is recorded even when the
// walk THROWS (callLLMChain rethrows once every keyed backend has errored).
// Without this the throw would unwind to the top-level handler and the try
// would go uncounted — exactly the free-retry hole the try budget closes.
async function meteredChain(
  env: Env,
  q: QuotaState,
  chain: string[],
  args: Parameters<typeof callLLMChain>[2]
): Promise<Awaited<ReturnType<typeof callLLMChain>>> {
  try {
    return await callLLMChain(env, chain, args);
  } catch (e) {
    await bumpQuota(env, q, false);
    throw e;
  }
}

// ── real-time latency budget ──
// The app's serverFetch gives up at 28s, so a reply landing later than that is
// indistinguishable from being offline. The endpoints a human actively waits on
// (/chat, /greet, /golden) therefore cap each provider attempt at 12s (healthy
// backends answer in 4-7s) and the whole fallback walk at 22s — ~6s of network
// headroom. Background work (/distill, /consolidate, cron) keeps the roomier
// providers.ts defaults; nobody is watching those spinners.
const RT_TIMEOUT_MS = 12000;
const RT_DEADLINE_MS = 22000;

// ── provider circuit breaker ──
// A hung provider taxes every walk RT_TIMEOUT_MS before the fallback rescues
// it, so each walk reports its failures and later walks start from the healthy
// end: flagged backends move to the BACK of the chain — never removed, so if
// everything is flagged the order is moot, and expiry retries the primary
// automatically. One shared KV key; ~5min of demotion per incident report.
const BAD_KEY = 'providers:bad';
const BAD_TTL_S = 300;

async function badProviders(env: Env): Promise<string[]> {
  try {
    const list = JSON.parse((await env.KV.get(BAD_KEY)) || '[]') as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function demoteBad(chain: string[], bad: string[]): string[] {
  if (!bad.length) return chain;
  return [...chain.filter((p) => !bad.includes(p)), ...chain.filter((p) => bad.includes(p))];
}

// Record a walk's failures for later walks (fire-and-forget, off the response
// path). Single-provider chains are admin A/B pins — probing a flaky backend
// on purpose shouldn't demote it for real users. The write unions with the
// previous list (minus whoever just answered) so two flaky backends don't take
// turns amnestying each other; the TTL re-tries everyone soon enough.
function reportBad(ctx: ExecutionContext, env: Env, chain: string[], prevBad: string[], failed: string[], winner: string | null): void {
  if (chain.length < 2 || !failed.length) return;
  const next = [...new Set([...failed, ...prevBad.filter((p) => p !== winner)])];
  ctx.waitUntil(env.KV.put(BAD_KEY, JSON.stringify(next), { expirationTtl: BAD_TTL_S }));
}

// Per-language batch summary for the admin responses (/admin/generate, /admin/put).
function batchCounts(batch: CardsBatch): Record<string, unknown> {
  // total lines across the shared bubble pools (nested groups + flat arrays)
  const bubbles = Object.values(batch.bubbles || {}).reduce<number>((s, v) => {
    if (Array.isArray(v)) return s + v.length;
    const g = (v || {}) as Record<string, string[]>;
    return s + Object.values(g).reduce((t, a) => t + (Array.isArray(a) ? a.length : 0), 0);
  }, 0);
  return {
    normal: batch.normal.length,
    bubbles,
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
    if (!raw) return [];
    const batch = JSON.parse(raw) as CardsBatch;
    // prefer the shared daily bubble mutters; fall back to a legacy batch's
    // per-persona pools so older stored batches keep feeding the chat prompt
    const shared = batch.bubbles?.mutter;
    const mutters = shared && Object.keys(shared).length ? shared : batch.cards?.[charId || '']?.mutters;
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Preflight is answered only for the public read routes. Everything else
    // gets a bare 403, so a browser page never reaches the metered endpoints:
    // their content-type: application/json makes the preflight mandatory.
    if (request.method === 'OPTIONS') {
      return PUBLIC_PATHS.has(url.pathname)
        ? new Response(null, { headers: CORS })
        : new Response(null, { status: 403 });
    }

    try {
      if (url.pathname === '/health') return corsJson({ ok: true });

      if (url.pathname === '/cards' && request.method === 'GET') {
        const lang = asLang(url.searchParams.get('lang'));
        // two persistent pools ride on every answer — both stored separately
        // from the daily batch (quotes-store.ts), so they come along even when
        // the batch is missing/stale: the famous-quote library (golden source)
        // and the internet-line pool (normal-card source). Each is served as a
        // small DAILY WINDOW of the full library (quotes-store.ts dailyWindow)
        // so the payload stays light as the libraries grow toward their caps;
        // the full pools are visible on GET /admin/quotes for the routine.
        // config:current.tuning rides along too — the client product knobs
        // (gacha odds etc.), adjustable via POST /admin/config with no app
        // release; absent keys just leave the app on its built-in defaults.
        const [quotesLib, inetLib, cfg] = await Promise.all([readQuotes(env, lang), readInet(env, lang), loadConfig(env)]);
        const quotes = dailyWindow(quotesLib, today(), parseInt(env.QUOTES_WINDOW || '150', 10));
        const inet = dailyWindow(inetLib, today(), parseInt(env.INET_WINDOW || '200', 10));
        const tuning = cfg.tuning;
        // no en fallback for a missing zh batch (possible until the first cron
        // after deploy): the app treats an empty answer as "use built-ins",
        // which keeps a Chinese user on Chinese cards instead of English ones
        const raw = await env.KV.get(batchKey(lang));
        if (!raw) return corsJson({ stale: true, date: null, normal: [], cards: {}, quotes, inet, tuning });
        const data = JSON.parse(raw) as CardsBatch;
        const char = url.searchParams.get('char');
        if (char) return corsJson({ date: data.date, normal: data.normal || [], bubbles: data.bubbles, cards: { [char]: data.cards[char] || null }, quotes, inet, tuning });
        return corsJson({ ...data, quotes, inet, tuning });
      }

      if (url.pathname === '/chat' && request.method === 'POST') {
        if (fromBrowser(request)) return json({ error: 'forbidden' }, 403);
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!(await burstOk(env, request))) return json({ error: 'slow down' }, 429);
        const parsed = await readJson<ChatPayload>(request);
        if (!parsed.ok) return reject(parsed);
        const p = capChat(parsed.value);
        const [cfg, bad] = await Promise.all([loadConfig(env), badProviders(env)]);

        // A passphrase is just something you say to your pet — there is no
        // settings screen and nothing to paste. Checked BEFORE the quota gate
        // on purpose: running out of budget is exactly when someone reaches for
        // their invite, and redeeming costs no model call. A phrase nobody
        // configured, or one already spent by somebody else, falls through and
        // is answered as ordinary conversation.
        const said = matchCode(p.messages?.[p.messages.length - 1]?.text || '', cfg.codes);
        if (said && p.deviceId) {
          const { ok } = await env.INVITE.get(env.INVITE.idFromName(said.key)).redeem(p.deviceId);
          if (ok) {
            await env.QUOTA.get(env.QUOTA.idFromName(p.deviceId)).grant(said.limit);
            const line = asLang(p.lang) === 'zh' ? UNLOCK_ZH : UNLOCK_EN;
            return json({ tag: 'cheer', gesture: null, remember: null, text: line, parts: [line], provider: null, model: null });
          }
        }

        const q = await quotaState(env, p.deviceId, dailyLimit(env, cfg));
        if (!q.ok) return json({ limited: true, used: q.used, limit: q.limit }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
        const system = buildChatSystem(persona, p, await todaysMusings(env, p.charId, asLang(p.lang)));
        const messages = mergeTurns((p.messages || []).map((m) => ({
          role: m.who === 'user' ? 'user' : 'assistant',
          content: m.text || '',
        })));
        const { chain, models } = withOverride(demoteBad(chatProviderChain(env, cfg), bad), request, env, cfg);
        // temperature 1.0 — warm but coherent; higher tipped non-English replies into word salad
        const { text: raw, provider, model, failed } = await meteredChain(env, q, chain, { system, messages, maxTokens: 300, temperature: 1.0, models, timeoutMs: RT_TIMEOUT_MS, deadlineMs: RT_DEADLINE_MS });
        reportBad(ctx, env, chain, bad, failed, provider);
        const out = clean(raw);
        // whole chain failed/empty — costs no reply budget, but the try is counted
        if (!out) { await bumpQuota(env, q, false); return json(null); }
        await bumpQuota(env, q); // only a real reply counts
        const { tag, body } = parseTag(out);
        const { gesture, body: afterGesture } = parseGesture(body); // optional action to act out
        const { remember, body: text } = parseRemember(afterGesture); // optional durable fact to keep
        // burst bubbles: the model may split a reply into up to 3 short bubbles
        // with " ||| ". parts feeds newer clients (typed out one after another);
        // text stays the joined whole so older builds render one clean bubble.
        // Stray leading tags on later bubbles are stripped, not leaked.
        const parts = text.split(/\s*\|{2,}\s*/)
          .map((s) => parseGesture(parseTag(s).body).body.trim())
          .filter(Boolean)
          .slice(0, 3)
          .map((s) => s.slice(0, 180));
        return json({ tag, gesture, remember, text: parts.join(' ').slice(0, 420), parts, provider, model });
      }

      // Batch memory extraction — one call per conversation lull (see
      // app/src/app/distill.ts), not per message. Same per-device budget as
      // chat: a distill spends one unit, so the endpoint can't be farmed.
      // Returns { facts: [] } on a clean "nothing durable here" reply; null
      // facts only when the whole provider chain failed (the app keeps its
      // cursor and retries at the next trigger).
      if (url.pathname === '/distill' && request.method === 'POST') {
        if (fromBrowser(request)) return json({ error: 'forbidden' }, 403);
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!(await burstOk(env, request))) return json({ error: 'slow down' }, 429);
        const parsed = await readJson<DistillPayload>(request);
        if (!parsed.ok) return reject(parsed);
        const p = capDistill(parsed.value);
        const [cfg, bad] = await Promise.all([loadConfig(env), badProviders(env)]);
        const q = await quotaState(env, p.deviceId, dailyLimit(env, cfg));
        if (!q.ok) return json({ limited: true }, 429);
        const chunk = (p.messages || []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
        if (!chunk.length) return json({ facts: [] });

        const system = buildDistillSystem(p);
        const { chain, models } = withOverride(demoteBad(chatProviderChain(env, cfg), bad), request, env, cfg);
        // temperature 0.2 — extraction wants stability, not creativity
        const { text: raw, provider, model, failed } = await meteredChain(env, q, chain, {
          system,
          messages: [{ role: 'user', content: distillTranscript(p) }],
          maxTokens: 700, temperature: 0.2, json: true, models,
        });
        reportBad(ctx, env, chain, bad, failed, provider);
        // chain failed — no reply budget spent, but the try is counted
        if (!raw || !raw.trim()) { await bumpQuota(env, q, false); return json({ facts: null, provider }); }
        await bumpQuota(env, q); // a real extraction pass counts
        // loops: the updated open-thread list (null = model omitted the key → app keeps its own)
        return json({ facts: parseDistillFacts(raw, chunk.length, (p.memory || []).length), loops: parseDistillLoops(raw), provider, model });
      }

      // Periodic memory curation — the app calls this weekly-ish, or when the
      // fact list nears its cap (see app/src/app/consolidate.ts). Same budget
      // as chat. Returns { ops: [] } for a healthy list ("change nothing" is
      // the expected answer); null ops only when the provider chain failed.
      if (url.pathname === '/consolidate' && request.method === 'POST') {
        if (fromBrowser(request)) return json({ error: 'forbidden' }, 403);
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!(await burstOk(env, request))) return json({ error: 'slow down' }, 429);
        const parsed = await readJson<ConsolidatePayload>(request);
        if (!parsed.ok) return reject(parsed);
        const p = capConsolidate(parsed.value);
        const [cfg, bad] = await Promise.all([loadConfig(env), badProviders(env)]);
        const q = await quotaState(env, p.deviceId, dailyLimit(env, cfg));
        if (!q.ok) return json({ limited: true }, 429);
        const facts = (p.memory || []).filter((m) => m && typeof m.fact === 'string' && m.fact.trim());
        if (facts.length < 2) return json({ ops: [] }); // nothing to curate

        const { chain, models } = withOverride(demoteBad(chatProviderChain(env, cfg), bad), request, env, cfg);
        // temperature 0.2 — curation wants stability, not creativity
        const { text: raw, provider, model, failed } = await meteredChain(env, q, chain, {
          system: buildConsolidateSystem(p),
          messages: [{ role: 'user', content: consolidateList(p) }],
          maxTokens: 700, temperature: 0.2, json: true, models,
        });
        reportBad(ctx, env, chain, bad, failed, provider);
        // chain failed — no reply budget spent, but the try is counted
        if (!raw || !raw.trim()) { await bumpQuota(env, q, false); return json({ ops: null, provider }); }
        await bumpQuota(env, q); // a real curation pass counts
        return json({ ops: parseConsolidateOps(raw, facts.length, facts.map((m) => m.kind || 'other')), provider, model });
      }

      if (url.pathname === '/golden' && request.method === 'POST') {
        if (fromBrowser(request)) return json({ error: 'forbidden' }, 403);
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!(await burstOk(env, request))) return json({ error: 'slow down' }, 429);
        const parsed = await readJson<ChatPayload>(request);
        if (!parsed.ok) return reject(parsed);
        const p = capChat(parsed.value);
        const [cfg, bad] = await Promise.all([loadConfig(env), badProviders(env)]);
        const q = await quotaState(env, p.deviceId, dailyLimit(env, cfg));
        if (!q.ok) return json({ limited: true }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
        const prompt = buildGoldenPrompt(persona, p);
        const { chain, models } = withOverride(demoteBad(chatProviderChain(env, cfg), bad), request, env, cfg);
        // temperature 1.0 — creative but coherent
        const { text: raw, provider, model, failed } = await meteredChain(env, q, chain, {
          system: '', messages: [{ role: 'user', content: prompt }], maxTokens: 200, temperature: 1.0, models, timeoutMs: RT_TIMEOUT_MS, deadlineMs: RT_DEADLINE_MS,
        });
        reportBad(ctx, env, chain, bad, failed, provider);
        const out = clean(raw);
        // failed — no reply budget spent, but the try is counted
        if (!out) { await bumpQuota(env, q, false); return json({ text: null, provider }); }
        await bumpQuota(env, q); // successful weave counts
        return json({ text: out.length > 4 && out.length < 220 ? out : null, provider, model });
      }

      // Personalized open-the-app greeting — same per-device budget as chat.
      // Over budget or model failure just returns null text and the app speaks
      // its built-in daypart greeting instead.
      if (url.pathname === '/greet' && request.method === 'POST') {
        if (fromBrowser(request)) return json({ error: 'forbidden' }, 403);
        if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
        if (!(await burstOk(env, request))) return json({ text: null, error: 'slow down' }, 429);
        const parsed = await readJson<ChatPayload>(request);
        if (!parsed.ok) return reject(parsed);
        const p = capChat(parsed.value);
        const [cfg, bad] = await Promise.all([loadConfig(env), badProviders(env)]);
        const q = await quotaState(env, p.deviceId, dailyLimit(env, cfg));
        if (!q.ok) return json({ text: null, limited: true }, 429);

        const persona = PERSONAS[p.charId || ''] || PERSONAS.spud;
        const prompt = buildGreetPrompt(persona, p);
        const chain = demoteBad(chatProviderChain(env, cfg), bad);
        const { text: raw, provider, failed } = await meteredChain(env, q, chain, {
          system: '', messages: [{ role: 'user', content: prompt }], maxTokens: 120, temperature: 1.0, models: cfg.models, timeoutMs: RT_TIMEOUT_MS, deadlineMs: RT_DEADLINE_MS,
        });
        reportBad(ctx, env, chain, bad, failed, provider);
        const out = clean(raw);
        // failed — no reply budget spent, but the try is counted
        if (!out) { await bumpQuota(env, q, false); return json({ text: null, provider }); }
        await bumpQuota(env, q); // a real greeting counts
        return json({ text: out.length > 2 && out.length < 200 ? out : null, provider });
      }

      // Live provider/model switch. GET reads the current KV config, POST replaces
      // it. No redeploy needed — the next chat/golden/cron call reads the new value.
      //   curl -XPOST .../admin/config -H 'x-pp-admin: TOKEN' \
      //     -d '{"chat":"anthropic","gen":"openai","models":{"anthropic":"claude-haiku-4-5-20251001"}}'
      if (url.pathname === '/admin/config') {
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        if (request.method === 'GET') {
          const raw = await env.KV.get('config:current');
          return json(raw ? JSON.parse(raw) : {});
        }
        if (request.method === 'POST') {
          const parsed = await readJson<Record<string, unknown>>(request, ADMIN_BODY_BYTES);
          if (!parsed.ok) return reject(parsed);
          const body = parsed.value;
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
          // hot-updatable per-device daily budget: {"chatLimit":50}. POST
          // replaces the whole config, so omitting it reverts to the [vars]
          // default on the next request.
          const lim = Number(body.chatLimit);
          if (Number.isInteger(lim) && lim >= 1 && lim <= 100000) next.chatLimit = lim;
          // client product knobs: {"tuning":{"goldenBase":0.25,"inetChance":0.8,…}}
          // — served to the app on GET /cards, clamped and defaulted client-side,
          // so the gacha feel is adjustable without an app release. Finite
          // numbers only; key count capped against runaway configs.
          if (body.tuning && typeof body.tuning === 'object') {
            const t: Record<string, number> = {};
            for (const [k, v] of Object.entries(body.tuning as Record<string, unknown>).slice(0, 32)) {
              const n = Number(v);
              if (k.trim() && k.length <= 40 && Number.isFinite(n)) t[k.trim()] = n;
            }
            if (Object.keys(t).length) next.tuning = t;
          }
          await env.KV.put('config:current', JSON.stringify(next));
          return json({ ok: true, config: next });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      // Mint or revoke ONE invite passphrase without resending the whole config.
      //   POST /admin/code?code=<phrase>&limit=1000   mint
      //   POST /admin/code?code=<phrase>&limit=0      revoke
      // Revoking only removes it from the config; a phrase already redeemed
      // stays redeemed, and the device keeps the budget it was granted.
      if (url.pathname === '/admin/code' && request.method === 'POST') {
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const code = (url.searchParams.get('code') || '').trim();
        if (!code || code.length > 80) return json({ error: 'pass ?code=<phrase>' }, 400);
        const limit = Number(url.searchParams.get('limit'));
        if (!Number.isInteger(limit) || limit < 0 || limit > 100000) {
          return json({ error: 'pass ?limit=<1-100000>, or 0 to revoke' }, 400);
        }
        const cfg = await loadConfig(env);
        const codes: Record<string, unknown> = { ...(cfg.codes || {}) };
        if (limit === 0) delete codes[code];
        else codes[code] = limit;
        const next: RuntimeConfig = { ...cfg, codes: capCodes(codes) };
        if (!next.codes) delete next.codes;
        await env.KV.put('config:current', JSON.stringify(next));
        return json({ ok: true, code, limit: limit || null, codes: next.codes || {} });
      }

      if (url.pathname === '/admin/generate' && request.method === 'POST') {
        const want = adminToken(env);
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
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const parsed = await readJson<Record<string, unknown>>(request, ADMIN_BODY_BYTES);
        if (!parsed.ok) return reject(parsed);
        const batch = await putForLang(env, lang, parsed.value);
        return json({ ok: true, lang, date: batch.date, counts: batchCounts(batch) });
      }

      // FULL persistent libraries (quotes + inet), admin-gated — the daily
      // routine reads this before generating so it can dedupe (incl.
      // paraphrases) and count lines per source. GET /cards no longer works
      // for that: it serves only a small daily window of each pool.
      if (url.pathname === '/admin/quotes' && request.method === 'GET') {
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const [quotes, inet] = await Promise.all([readQuotes(env, lang), readInet(env, lang)]);
        return json({ lang, quotes, inet, totals: { quotes: quotes.length, inet: inet.length } });
      }

      // Append fresh famous quotes to the persistent library (the golden-card
      // source). The daily membership routine POSTs a few new lines here; the
      // Worker dedupes against the existing library and keeps the newest
      // QUOTES_LIB_MAX. No LLM work — same free path as /admin/put.
      // Body: { quotes: [{ q: "…", s?: "…" }, …] }.
      if (url.pathname === '/admin/quotes' && request.method === 'POST') {
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const parsed = await readJson<{ quotes?: unknown }>(request, ADMIN_BODY_BYTES);
        if (!parsed.ok) return reject(parsed);
        const max = parseInt(env.QUOTES_LIB_MAX || '5000', 10);
        const { added, total } = await appendQuotes(env, lang, parsed.value.quotes, max);
        return json({ ok: true, lang, added, total });
      }

      // Append internet-era lines to the persistent normal-card pool: the
      // daily routine POSTs the low-provenance half of its quote hunt here
      // (circulating 网络/no-source lines — see generate-pools.md §3), and the
      // maintainer can hand-add via the same door (seed lives in
      // scripts/internet-lines.*.txt). Body: { lines: ["…", …] }.
      if (url.pathname === '/admin/inet' && request.method === 'POST') {
        const want = adminToken(env);
        if (want && request.headers.get('x-pp-admin') !== want) return json({ error: 'unauthorized' }, 401);
        const langParam = url.searchParams.get('lang');
        if (!langParam) return json({ error: 'pass ?lang=en or ?lang=zh — one language per call' }, 400);
        const lang = asLang(langParam);
        const parsed = await readJson<{ lines?: unknown }>(request, ADMIN_BODY_BYTES);
        if (!parsed.ok) return reject(parsed);
        const max = parseInt(env.INET_LIB_MAX || '5000', 10);
        const { added, total } = await appendInet(env, lang, parsed.value.lines, max);
        return json({ ok: true, lang, added, total });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && (e as Error).message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Fallback generator. The membership routine normally POSTs today's batch in
    // the morning (server/scripts/generate-pools.md); this evening cron then
    // does nothing when today's batch is already there — so it only spends API
    // tokens on days the routine didn't run. One language per firing (see
    // generateForLang): the en and zh crons are separate invocations, each with
    // its own subrequest budget. Keep the expressions in sync with [triggers].
    const lang = event.cron === CRON_ZH ? 'zh' : 'en';
    ctx.waitUntil((async () => {
      const raw = await env.KV.get(batchKey(lang));
      if (raw) {
        try {
          if ((JSON.parse(raw) as CardsBatch).date === today()) return; // routine already ran today → skip
        } catch {}
      }
      await generateForLang(env, lang);
    })());
  },
} satisfies ExportedHandler<Env>;
