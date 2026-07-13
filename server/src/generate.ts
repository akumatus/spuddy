// Daily batch generation — run by the cron trigger and POST /admin/generate.
// Knits the shared normal pool and per-persona mutter pools — once per
// language — then stores each batch in KV (cards:current for English,
// cards:current:zh for Chinese). Golden cards are not baked here: the app
// draws them live or from the curated famous-quote pool (quotes-*.ts).
import { CHAT_IDS, PERSONAS, buildMutterPrompt, buildNormalBatchPrompt } from './personas';
import { callLLMChain, genProviderChain, loadConfig } from './providers';
import { MOODS, batchKey, type CardsBatch, type CharBatch, type Env, type Lang, type MutterMood } from './types';
import { clean, today } from './util';

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

function extractJson(text: string): Record<string, unknown> | null {
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

async function generateMuttersForChar(env: Env, id: string, opts: GenOpts): Promise<{ mutters: Record<MutterMood, string[]> }> {
  // Same small-runs strategy as the cards: fresh seeds per run, merge + dedupe.
  const per = Math.ceil(opts.nMutters / opts.runs);
  const runOnce = async (): Promise<Record<MutterMood, string[]> | null> => {
    const prompt = buildMutterPrompt(PERSONAS[id], per, opts.lang); // fresh seeds per run
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
        const out = {} as Record<MutterMood, string[]>;
        for (const k of MOODS) out[k] = sanitizeList(parsed?.[k], per);
        if (MOODS.some((k) => out[k].length)) return out;
      } catch (e) {
        // transient — fall through to retry
      }
    }
    return null;
  };
  const results = (await Promise.all(Array.from({ length: opts.runs }, runOnce))).filter(
    (r): r is Record<MutterMood, string[]> => r !== null
  );
  const mutters = {} as Record<MutterMood, string[]>;
  for (const k of MOODS) mutters[k] = dedupeLines(results.flatMap((r) => r[k])).slice(0, opts.nMutters);
  return { mutters };
}

// One language's full batch: shared normal pool + per-persona mutters. Golden
// cards are no longer baked here — the app draws goldens from the live weave or
// the curated famous-quote pool (server/src/quotes-*.ts) instead.
async function generateBatch(env: Env, opts: GenOpts): Promise<CardsBatch> {
  // Generate the shared pool and every persona's mutters CONCURRENTLY.
  // Sequential calls accumulate wall time and the later ones get throttled/cut;
  // concurrent keeps total time ~= one call.
  const [normalRaw, results] = await Promise.all([
    generateNormalPool(env, opts).catch(() => [] as string[]),
    Promise.all(
      CHAT_IDS.map((id): Promise<CharBatch> =>
        generateMuttersForChar(env, id, opts).catch(() => ({
          mutters: { watch: [], alone: [], lonely: [] } as Record<MutterMood, string[]>,
        }))
      )
    ),
  ]);
  const cards: Record<string, CharBatch> = {};
  CHAT_IDS.forEach((id, i) => { cards[id] = results[i]; });
  return storeBatch(env, opts.lang, normalRaw, cards);
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
  cards: Record<string, CharBatch>
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
        if (p.mutters) for (const k of MOODS) {
          if (!cards[id].mutters[k]?.length && p.mutters[k]?.length) cards[id].mutters[k] = p.mutters[k];
        }
      }
    } catch (e) {}
  }

  const data: CardsBatch = { date: today(), normal, cards };
  await env.KV.put(key, JSON.stringify(data));
  return data;
}

// Store a batch generated OUTSIDE the Worker (e.g. a scheduled Claude Code
// routine running on the maintainer's own membership, POSTed to /admin/put).
// The Worker does no LLM work here — it only sanitizes and stores, so this path
// costs nothing against the API budget. Body shape mirrors what the app reads:
//   { normal: string[], cards: { <charId>: { mutters: { watch, alone, lonely } } } }
export async function putForLang(env: Env, lang: Lang, body: unknown): Promise<CardsBatch> {
  const b = (body || {}) as { normal?: unknown; cards?: Record<string, { mutters?: Record<string, unknown> }> };
  const nNormal = parseInt(env.CARDS_PER_DAY || '24', 10);
  const nMutters = parseInt(env.MUTTERS_PER_DAY || '12', 10);
  const normal = dedupeLines(sanitizeList(b.normal, nNormal));
  const cards: Record<string, CharBatch> = {};
  for (const id of CHAT_IDS) {
    const src = b.cards?.[id]?.mutters || {};
    const mutters = {} as Record<MutterMood, string[]>;
    for (const k of MOODS) mutters[k] = dedupeLines(sanitizeList(src[k], nMutters));
    cards[id] = { mutters };
  }
  return storeBatch(env, lang, normal, cards);
}

// ONE language per invocation — hard requirement, not a preference. A single
// batch is a couple dozen LLM fetches (normal runs + 6 personas × mutter runs;
// goldens no longer generated) and the free plan caps an invocation at ~50
// subrequests. Generating both languages in one
// invocation spends the whole budget on en + the head of zh, and every later zh
// call dies instantly at the exact same spot — which is how the zh pools ended
// up with only the shared normal pool and the first persona filled. Callers
// (the per-language cron firings and POST /admin/generate?lang=) give each
// language its own invocation and therefore its own budget.
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
