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

// Coerce arbitrary POST input into clean {q, s?} quotes, dropping malformed and
// out-of-bounds lines and collapsing near-duplicates within the incoming set.
function sanitizeQuotes(arr: unknown): Quote[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const rec = x as Record<string, unknown>;
    const q = clean(String(rec.q ?? ''));
    if (q.length <= 3 || q.length >= 200) continue;
    const key = normKey(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const s = rec.s != null ? clean(String(rec.s)) : '';
    out.push(s ? { q, s } : { q });
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
