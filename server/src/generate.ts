// Daily batch generation — run by the cron trigger and POST /admin/generate.
// Knits the shared normal pool, per-persona golden pools and mutter pools —
// once per language — then stores each batch in KV (cards:current for
// English, cards:current:zh for Chinese).
import { CHAT_IDS, PERSONAS, buildGoldenBatchPrompt, buildMutterPrompt, buildNormalBatchPrompt } from './personas';
import { callLLMChain, genProviderChain, loadConfig } from './providers';
import { MOODS, batchKey, type CardsBatch, type CharBatch, type Env, type Lang, type MutterMood } from './types';
import { clean, today } from './util';

interface GenOpts {
  genChain: string[];
  models?: Record<string, string>;
  lang: Lang;
  nNormal: number;
  nGolden: number;
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

// Per-persona golden pool — fewer, braver lines in the character's own voice,
// anchored on the hand-written golden examples so the register stays direct.
// The pool is small, so half the runs of the normal batch is plenty.
async function generateGoldenForChar(env: Env, id: string, opts: GenOpts): Promise<string[]> {
  const runs = Math.max(1, Math.round(opts.runs / 2));
  const per = Math.ceil(opts.nGolden / runs);
  const runOnce = async (): Promise<string[]> => {
    const prompt = buildGoldenBatchPrompt(PERSONAS[id], per, opts.lang);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await callLLMChain(env, opts.genChain, {
          system: '',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 1500, // ~10 lines of JSON per run — headroom against truncation
          temperature: 1.0,
          timeoutMs: 240000,
          json: true,
          models: opts.models,
        });
        const golden = sanitizeList(extractJson(text)?.golden, per);
        if (golden.length) return golden;
      } catch (e) {
        // transient — fall through to retry
      }
    }
    return [];
  };
  const results = await Promise.all(Array.from({ length: runs }, runOnce));
  return dedupeLines(results.flat()).slice(0, opts.nGolden);
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

// One language's full batch: shared normal pool + per-persona golden/mutters.
async function generateBatch(env: Env, opts: GenOpts): Promise<CardsBatch> {
  // Generate the shared pool and every persona CONCURRENTLY (golden + mutters).
  // Sequential calls accumulate wall time and the later ones get throttled/cut;
  // concurrent keeps total time ~= one call.
  const [normalRaw, results] = await Promise.all([
    generateNormalPool(env, opts).catch(() => [] as string[]),
    Promise.all(
      CHAT_IDS.map(async (id): Promise<CharBatch> => {
        const [golden, m] = await Promise.all([
          generateGoldenForChar(env, id, opts).catch(() => [] as string[]),
          generateMuttersForChar(env, id, opts).catch(() => ({
            mutters: { watch: [], alone: [], lonely: [] } as Record<MutterMood, string[]>,
          })),
        ]);
        return { golden, ...m };
      })
    ),
  ]);
  let normal = normalRaw;
  const cards: Record<string, CharBatch> = {};
  CHAT_IDS.forEach((id, i) => { cards[id] = results[i]; });

  // Never clobber good content with empties — if a field hiccups this run, keep
  // whatever it had last time so no character is ever left with nothing.
  const key = batchKey(opts.lang);
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
        if (!cards[id].golden.length && p.golden?.length) cards[id].golden = p.golden;
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

// ONE language per invocation — hard requirement, not a preference. A single
// batch is ~40 LLM fetches (4 normal runs + 6 personas × 6 runs) and the free
// plan caps an invocation at ~50 subrequests. Generating both languages in one
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
    nGolden: parseInt(env.GOLDEN_PER_DAY || '10', 10),
    nMutters: parseInt(env.MUTTERS_PER_DAY || '12', 10),
    runs: Math.max(1, parseInt(env.GEN_RUNS || '2', 10)),
  });
}
