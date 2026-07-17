// Daily batch generation — run by the cron trigger and POST /admin/generate.
// Knits the shared normal pool and per-persona mutter pools — once per
// language — then stores each batch in KV (cards:current for English,
// cards:current:zh for Chinese). Golden cards are not baked here: the app
// draws them live or from the curated famous-quote pool (quotes-*.ts).
import { CHAT_IDS, buildBubblesPrompt, buildFlavorPrompt, buildNormalBatchPrompt, type BubblePart } from './personas';
import { callLLMChain, genProviderChain, loadConfig } from './providers';
import {
  BUBBLE_FLAT, BUBBLE_MOODS, DAYPARTS, MOODS, ROUTINE_KEYS, SPEAK_KEYS, batchKey,
  type Bubbles, type CardsBatch, type CharBatch, type Env, type Lang, type MutterMood,
} from './types';
import { clean, extractJson, today } from './util';

interface GenOpts {
  genChain: string[];
  models?: Record<string, string>;
  lang: Lang;
  nNormal: number;
  nMutters: number;
  runs: number;
}

// Near-identical lines across runs collapse to one (punctuation/case ignored).
// Unicode-aware: keep letters/digits in any script — the old [^a-z0-9] filter
// reduced every Chinese line to the same empty key and deduped the whole pool.
function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((s) => {
    const key = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeList(arr: unknown, max: number): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => clean(String(s)))
    .filter((s) => s.length > 3 && s.length < 200)
    .slice(0, max);
}

// Shared normal pool — one voice-neutral batch that every persona draws from.
// Several small calls instead of one big one: long single batches template out
// toward the tail, and each run draws its own inspiration seeds. Results are
// merged and deduped.
async function generateNormalPool(env: Env, opts: GenOpts): Promise<string[]> {
  const per = Math.ceil(opts.nNormal / opts.runs);
  const runOnce = async (): Promise<string[]> => {
    const prompt = buildNormalBatchPrompt(per, opts.lang); // fresh seeds per run
    // one retry — the batch call occasionally returns throttled/unparseable
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await callLLMChain(env, opts.genChain, {
          system: '',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 3000, // ~27 lines of JSON per run at ~90 tokens/line — truncation makes the run unparseable
          temperature: 1.0, // lowered from 1.2 — high heat corrupts JSON mode and non-English lines
          timeoutMs: 240000, // not latency-sensitive, and queued runs (Workers cap concurrent connections) eat into the timer
          json: true, // force clean JSON so parsing can't silently drop the batch
          models: opts.models,
        });
        const normal = sanitizeList(extractJson(text)?.normal, per);
        if (normal.length) return normal;
      } catch (e) {
        // transient (rate limit / timeout) — fall through to retry
      }
    }
    return [];
  };
  const results = await Promise.all(Array.from({ length: opts.runs }, runOnce));
  return dedupeLines(results.flat()).slice(0, opts.nNormal);
}

// Per-pool cap — generous slack above the prompt's asked-for counts so a chatty
// run isn't truncated to nothing useful, while a runaway response stays bounded.
const BUBBLE_POOL_MAX = 40;

// Coerce one part's parsed JSON into clean Bubbles groups, dropping anything
// malformed and deduping near-identical lines within each pool.
function sanitizeBubblesPart(parsed: Record<string, unknown> | null, part: BubblePart): Bubbles {
  const out: Bubbles = {};
  const group = (src: unknown, keys: readonly string[]): Record<string, string[]> | undefined => {
    if (!src || typeof src !== 'object') return undefined;
    const g: Record<string, string[]> = {};
    let any = false;
    for (const k of keys) {
      const lines = dedupeLines(sanitizeList((src as Record<string, unknown>)[k], BUBBLE_POOL_MAX));
      if (lines.length) { g[k] = lines; any = true; }
    }
    return any ? g : undefined;
  };
  if (part === 'voice') {
    out.mutter = group(parsed?.mutter, BUBBLE_MOODS);
    out.routines = group(parsed?.routines, ROUTINE_KEYS);
    return out;
  }
  out.speak = group(parsed?.speak, SPEAK_KEYS);
  out.hi = group(parsed?.hi, DAYPARTS);
  for (const k of BUBBLE_FLAT) {
    const lines = dedupeLines(sanitizeList(parsed?.[k], BUBBLE_POOL_MAX));
    if (lines.length) out[k] = lines;
  }
  return out;
}

// The shared daily bubble pools — TWO calls per language (voice + social),
// replacing the old six per-persona mutter calls: cheaper, and every persona
// now shares one fresh voice-neutral set (per-persona flavor rides separately).
async function generateBubbles(env: Env, opts: GenOpts): Promise<Bubbles> {
  const part = async (p: BubblePart): Promise<Bubbles> => {
    const prompt = buildBubblesPrompt(p, opts.lang);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await callLLMChain(env, opts.genChain, {
          system: '',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 7000, // ~66 (social) to ~172 (voice) short JSON lines per part — headroom against truncation
          temperature: 0.95, // absurdity comes from the prompt; hotter corrupts JSON mode
          timeoutMs: 240000,
          json: true,
          models: opts.models,
        });
        const got = sanitizeBubblesPart(extractJson(text), p);
        if (Object.keys(got).length) return got;
      } catch (e) {
        // transient (rate limit / timeout) — fall through to retry
      }
    }
    return {};
  };
  const [voice, social] = await Promise.all([part('voice'), part('social')]);
  return { ...voice, ...social };
}

// Per-persona flavor lines — ONE small call for all six personas (~48 lines),
// so buddies keep their accent without a per-persona batch. Best-effort: an
// empty result just means the app serves pure shared pools today.
const FLAVOR_MAX = 8; // per kind per persona — prompt asks for 4, slack for a chatty run
async function generateFlavor(env: Env, opts: GenOpts): Promise<Record<string, CharBatch['flavor']>> {
  const prompt = buildFlavorPrompt(opts.lang);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await callLLMChain(env, opts.genChain, {
        system: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2500, // ~48 short JSON lines across six personas
        temperature: 0.95,
        timeoutMs: 240000,
        json: true,
        models: opts.models,
      });
      const parsed = extractJson(text);
      const out: Record<string, CharBatch['flavor']> = {};
      for (const id of CHAT_IDS) {
        const src = parsed?.[id] as Record<string, unknown> | undefined;
        const mutter = dedupeLines(sanitizeList(src?.mutter, FLAVOR_MAX));
        const greet = dedupeLines(sanitizeList(src?.greet, FLAVOR_MAX));
        if (mutter.length || greet.length) out[id] = { ...(mutter.length && { mutter }), ...(greet.length && { greet }) };
      }
      if (Object.keys(out).length) return out;
    } catch (e) {
      // transient — fall through to retry
    }
  }
  return {};
}

// One language's full batch: shared normal pool + per-persona mutters. Golden
// cards are no longer baked here — the app draws goldens from the live weave or
// the curated famous-quote pool (server/src/quotes-*.ts) instead.
async function generateBatch(env: Env, opts: GenOpts): Promise<CardsBatch> {
  // Generate the shared normal pool and the shared bubble pools CONCURRENTLY.
  // Sequential calls accumulate wall time and the later ones get throttled/cut;
  // concurrent keeps total time ~= one call. Per-persona mutters are no longer
  // generated here — the shared bubbles replaced them (storeBatch still carries
  // any previously stored per-persona mutters forward for older app versions).
  const [normalRaw, bubbles, flavor] = await Promise.all([
    generateNormalPool(env, opts).catch(() => [] as string[]),
    generateBubbles(env, opts).catch(() => ({} as Bubbles)),
    generateFlavor(env, opts).catch(() => ({} as Record<string, CharBatch['flavor']>)),
  ]);
  const cards: Record<string, CharBatch> = {};
  for (const id of Object.keys(flavor)) {
    cards[id] = { mutters: { watch: [], alone: [], lonely: [] } as Record<MutterMood, string[]>, flavor: flavor[id] };
  }
  return storeBatch(env, opts.lang, normalRaw, cards, bubbles);
}

// Merge a freshly-built batch into KV and return it. Never clobbers good
// content with empties: if a field came back empty this run, whatever it held
// last time is kept, so no character is ever left with nothing. Shared by the
// cron/API generator (generateBatch) and the externally-generated POST
// /admin/put path (putForLang) so both get the same safety net.
export async function storeBatch(
  env: Env,
  lang: Lang,
  normalRaw: string[],
  cards: Record<string, CharBatch>,
  bubbles: Bubbles = {}
): Promise<CardsBatch> {
  let normal = normalRaw;
  const key = batchKey(lang);
  const prevRaw = await env.KV.get(key);
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as Partial<CardsBatch>;
      const prevCards = prev.cards || {};
      // pre-split batches kept normals per persona — flatten those so upgrading
      // a hiccuping run never lands on an empty shared pool
      const prevNormal = Array.isArray(prev.normal) && prev.normal.length
        ? prev.normal
        : dedupeLines(CHAT_IDS.flatMap((id) => prevCards[id]?.normal || []));
      if (!normal.length && prevNormal.length) normal = prevNormal;
      for (const id of CHAT_IDS) {
        const p = prevCards[id];
        if (!p) continue;
        if (!cards[id]) cards[id] = { mutters: { watch: [], alone: [], lonely: [] } as Record<MutterMood, string[]> };
        if (p.mutters) for (const k of MOODS) {
          if (!cards[id].mutters[k]?.length && p.mutters[k]?.length) cards[id].mutters[k] = p.mutters[k];
        }
        if (!cards[id].flavor && p.flavor) cards[id].flavor = p.flavor; // flavor never-clobber
      }
      // bubbles never-clobber, per group: a part that came back empty this run
      // keeps whatever the last batch held, so no pool ever goes dark
      const prevBubbles = (prev.bubbles || {}) as Record<string, unknown>;
      const merged = bubbles as Record<string, unknown>;
      for (const g of Object.keys(prevBubbles)) {
        if (merged[g] == null) merged[g] = prevBubbles[g];
      }
    } catch (e) {}
  }

  const data: CardsBatch = { date: today(), normal, cards };
  if (Object.keys(bubbles).length) data.bubbles = bubbles;
  await env.KV.put(key, JSON.stringify(data));
  return data;
}

// Store a batch generated OUTSIDE the Worker (e.g. a scheduled Claude Code
// routine running on the maintainer's own membership, POSTed to /admin/put).
// The Worker does no LLM work here — it only sanitizes and stores, so this path
// costs nothing against the API budget. Body shape mirrors what the app reads:
//   { normal: string[], bubbles: { mutter, speak, routines, hi, poke, … },
//     cards: { <charId>: { mutters: { watch, alone, lonely } } } }   (cards optional/legacy)
export async function putForLang(env: Env, lang: Lang, body: unknown): Promise<CardsBatch> {
  const b = (body || {}) as {
    normal?: unknown;
    bubbles?: Record<string, unknown>;
    cards?: Record<string, { mutters?: Record<string, unknown>; flavor?: Record<string, unknown> }>;
  };
  const nNormal = parseInt(env.CARDS_PER_DAY || '24', 10);
  const nMutters = parseInt(env.MUTTERS_PER_DAY || '12', 10);
  const normal = dedupeLines(sanitizeList(b.normal, nNormal));
  const cards: Record<string, CharBatch> = {};
  for (const id of CHAT_IDS) {
    const src = b.cards?.[id]?.mutters || {};
    const mutters = {} as Record<MutterMood, string[]>;
    for (const k of MOODS) mutters[k] = dedupeLines(sanitizeList(src[k], nMutters));
    cards[id] = { mutters };
    const fl = b.cards?.[id]?.flavor;
    if (fl) {
      const mutter = dedupeLines(sanitizeList(fl.mutter, 8));
      const greet = dedupeLines(sanitizeList(fl.greet, 8));
      if (mutter.length || greet.length) cards[id].flavor = { ...(mutter.length && { mutter }), ...(greet.length && { greet }) };
    }
  }
  const bubbles: Bubbles = {
    ...sanitizeBubblesPart(b.bubbles || null, 'voice'),
    ...sanitizeBubblesPart(b.bubbles || null, 'social'),
  };
  return storeBatch(env, lang, normal, cards, bubbles);
}

// ONE language per invocation — hard requirement, not a preference. A single
// batch is ~10 LLM fetches (GEN_RUNS normal runs + one mutter call per persona;
// goldens no longer generated) and the free plan caps an invocation at ~50
// subrequests. Two languages in one invocation would still risk starving the zh
// tail under retries — which is how the zh pools once ended up with only the
// shared normal pool and the first persona filled. Callers (the per-language
// cron firings and POST /admin/generate?lang=) give each language its own
// invocation and therefore its own budget.
export async function generateForLang(env: Env, lang: Lang): Promise<CardsBatch> {
  const cfg = await loadConfig(env);
  return generateBatch(env, {
    genChain: genProviderChain(env, cfg),
    models: cfg.models,
    lang,
    nNormal: parseInt(env.CARDS_PER_DAY || '24', 10),
    nMutters: parseInt(env.MUTTERS_PER_DAY || '12', 10),
    runs: Math.max(1, parseInt(env.GEN_RUNS || '2', 10)),
  });
}
