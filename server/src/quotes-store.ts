// The persistent famous-quote library — a growing, deduped pool the app draws
// golden cards from. Unlike the daily batch (normal + mutters, REPLACED each
// day), the quote library ACCUMULATES: the daily membership routine generates a
// few genuinely new famous lines and POSTs them to /admin/quotes, which appends
// here. Bounded by QUOTES_LIB_MAX (oldest drop off past the cap) so KV and the
// /cards payload stay in check while the pool still refreshes over time.
import type { Env, Lang, Quote } from './types';
import { clean } from './util';

const libKey = (lang: Lang): string => (lang === 'zh' ? 'quotes:zh' : 'quotes:en');

// Normalized identity for dedupe — script-aware, punctuation/case-insensitive
// (mirrors generate.ts dedupeLines so en + zh both collapse correctly).
const normKey = (q: string): string => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();

export async function readQuotes(env: Env, lang: Lang): Promise<Quote[]> {
  const raw = await env.KV.get(libKey(lang));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Quote[]) : [];
  } catch {
    return [];
  }
}

// Attribution labels that rotted the pre-2026-07 pool — golden lines are
// attributed-only now (house rules: scripts/generate-pools.md §2). Sourceless
// lines and shrug-labels are rejected at the door; proverbs and the classical
// textbook canon too. Internet-era lines belong in the normal-pool reservoir
// (scripts/internet-lines.*.txt), not here.
const JUNK_SOURCE =
  /^(网络|网络流传|网友|佚名|俗语|谚语|民谚|民间|古语|老话|论语|孟子|老子|庄子|荀子|淮南子|增广贤文)$|proverb|anonymous|unknown|folk|^internet$/i;

// Coerce arbitrary POST input into clean {q, s} quotes, dropping malformed,
// sourceless, junk-labeled and out-of-bounds lines and collapsing
// near-duplicates within the incoming set.
function sanitizeQuotes(arr: unknown): Quote[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const rec = x as Record<string, unknown>;
    const q = clean(String(rec.q ?? ''));
    if (q.length <= 3 || q.length >= 200) continue;
    const s = rec.s != null ? clean(String(rec.s)) : '';
    if (!s || s.length > 40 || JUNK_SOURCE.test(s)) continue;
    const key = normKey(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ q, s });
  }
  return out;
}

// Append fresh quotes to the library: dedupe against what's already there, then
// keep the newest `max`. Returns how many were actually new and the new total.
export async function appendQuotes(
  env: Env,
  lang: Lang,
  incoming: unknown,
  max: number
): Promise<{ added: number; total: number }> {
  const existing = await readQuotes(env, lang);
  const have = new Set(existing.map((qt) => normKey(qt.q)));
  const fresh = sanitizeQuotes(incoming).filter((qt) => {
    const k = normKey(qt.q);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  let lib = existing.concat(fresh);
  if (lib.length > max) lib = lib.slice(lib.length - max); // drop the oldest
  await env.KV.put(libKey(lang), JSON.stringify(lib));
  return { added: fresh.length, total: lib.length };
}

// ---------------------------------------------------------------------------
// Internet-line pool — the quote library's sourceless sibling. Human-circulated
// 网络/无出处 lines serve NORMAL cards (no attribution shown), alongside the
// small daily generated joke/dare batch. Same shape as the quote library
// (persistent, deduped, capped): the daily routine's quote hunt sorts by
// provenance — real attributions go to the quote library above, no-source
// finds land here via POST /admin/inet (generate-pools.md §3) — and the
// maintainer hand-curates through the same door (seed lives in
// scripts/internet-lines.*.txt). Past the cap the oldest drop off, so the
// pool is a rolling, daily-refreshed window.

const inetKey = (lang: Lang): string => (lang === 'zh' ? 'inet:zh' : 'inet:en');

export async function readInet(env: Env, lang: Lang): Promise<string[]> {
  const raw = await env.KV.get(inetKey(lang));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]).filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function sanitizeLines(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const q = clean(String(x ?? ''));
    if (q.length <= 3 || q.length >= 200) continue;
    const key = normKey(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

export async function appendInet(
  env: Env,
  lang: Lang,
  incoming: unknown,
  max: number
): Promise<{ added: number; total: number }> {
  const existing = await readInet(env, lang);
  const have = new Set(existing.map(normKey));
  const fresh = sanitizeLines(incoming).filter((q) => {
    const k = normKey(q);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  let lib = existing.concat(fresh);
  if (lib.length > max) lib = lib.slice(lib.length - max); // drop the oldest
  await env.KV.put(inetKey(lang), JSON.stringify(lib));
  return { added: fresh.length, total: lib.length };
}

// ---------------------------------------------------------------------------
// Daily window — the persistent pools grew past the point of shipping whole
// (quotes cap 5000 ≈ 400KB), so GET /cards serves a small rotating page
// instead: a STABLE pseudo-shuffle of the library (so one day's window mixes
// eras instead of being a contiguous age-slice) with the window start
// advancing by one window-length per day — the whole library cycles through in
// ceil(len/size) days. Purely deterministic (no state, no randomness), so
// every client sees the same page all day and the app's own used-list
// bookkeeping keeps working unchanged.
export function dailyWindow<T>(items: T[], dayKey: string, size: number): T[] {
  if (size <= 0 || items.length <= size) return items;
  // Knuth multiplicative hash over the index — a cheap stable permutation;
  // ties (impossible below 2^32 items) fall back to index order.
  const spread = (i: number): number => (i * 2654435761) % 4294967296;
  const idx = items.map((_, i) => i).sort((a, b) => spread(a) - spread(b) || a - b);
  const day = Math.floor(Date.parse(dayKey) / 86400000) || 0;
  const start = ((day * size) % items.length + items.length) % items.length;
  const out: T[] = [];
  for (let k = 0; k < size; k++) out.push(items[idx[(start + k) % items.length]]);
  return out;
}
