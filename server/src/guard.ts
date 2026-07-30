import type { ChatPayload, ConsolidatePayload, DistillPayload } from './types';

// ── request input caps ──
// Server-side limits on what a client may send. The app trims its own payloads
// (30 chat turns, 60 memory facts), but that is the client's good manners, not
// a guarantee: the shared app token ships inside every build, so any caller can
// post anything. Without these caps the only ceiling on a request body is
// Cloudflare's 100 MB, and every byte of it is billed as prompt tokens by
// whichever provider answers.
//
// The numbers sit 3-6x above the largest real request (a chat call with a full
// 60-fact memory and 30 turns of history measures ~20 KB / ~6.5k tokens), so no
// genuine user reaches them.

export const LIMITS = {
  bodyBytes: 128 * 1024, // ~6x the largest real request
  msgs: 40, // the app sends 30; queued notes can add a few
  msgsChars: 12_000, // total across the kept window
  msgChars: 2_000, // one turn
  memory: 80, // the app caps its own list at 60 (consolidate.ts)
  factChars: 300,
  context: 20, // /distill's already-distilled tail
  strings: 8, // fresh / loops list length
  stringChars: 200,
} as const;

export type Parsed<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// Read and parse a JSON body, refusing anything past `max` bytes. Streams and
// aborts rather than buffering first: a 100 MB body would otherwise blow the
// isolate's 128 MB memory ceiling before any check could run. content-length is
// only a fast path — chunked requests omit it, so the byte counter is the one
// that actually holds.
export async function readJson<T>(request: Request, max: number = LIMITS.bodyBytes): Promise<Parsed<T>> {
  const declared = parseInt(request.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > max) return { ok: false, status: 413, error: 'body too large' };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: 'missing body' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'body too large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'unreadable body' };
  }

  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(buf)) as T;
    // every endpoint here takes an object; an array or a bare scalar is a caller bug
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, error: 'invalid JSON body' };
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
}

// Friendship day — interpolated straight into prompts ("Today is day N"), so it
// has to be a small integer and not whatever the caller felt like sending.
export function dayNum(v: unknown, fallback = 1): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 && n <= 100_000 ? n : fallback;
}

interface Turn {
  who?: string;
  text?: string;
}

// Which end of an over-long transcript to keep.
//
// 'newest' is what a context window wants: chat history and the /distill
// context tail both matter most at the recent end, and dropping the oldest is
// invisible to a real user.
//
// 'oldest' exists for ONE caller — the /distill chunk. Its reply addresses
// messages by 1-based position ("turn": n), and the app resolves that against
// its own copy of the chunk (state.chat[start + turn - 1] in distill.ts).
// Trimming the front would slide every index and staple memory tags onto the
// wrong lines, so an over-long chunk loses its tail instead: those messages go
// unexamined this pass, which costs a fact but never mis-attributes one.
type Keep = 'newest' | 'oldest';

export function capTurns(list: unknown, maxCount: number, maxTotal: number, keep: Keep = 'newest'): Turn[] {
  const src = Array.isArray(list) ? list : [];
  const fromEnd = keep === 'newest';
  const out: Turn[] = [];
  let total = 0;
  for (let n = 0; n < src.length && out.length < maxCount; n++) {
    const m = src[fromEnd ? src.length - 1 - n : n] as Turn | null;
    if (!m || typeof m !== 'object') continue;
    const text = String(m.text ?? '').slice(0, LIMITS.msgChars);
    if (!text.trim()) continue;
    if (total + text.length > maxTotal) break;
    total += text.length;
    out.push({ who: m.who === 'user' ? 'user' : 'pet', text });
  }
  return fromEnd ? out.reverse() : out;
}

interface Fact {
  fact?: string;
  kind?: string;
  mood?: string | null;
  day?: number;
}

// Memory facts. `day` rides into the prompt the same way the top-level one does,
// and kind/mood are re-validated downstream, so cap their length here too.
export function capMemory(list: unknown, maxCount = LIMITS.memory): Fact[] {
  const src = Array.isArray(list) ? list : [];
  const out: Fact[] = [];
  for (const raw of src) {
    if (out.length >= maxCount) break;
    const m = raw as Fact | null;
    if (!m || typeof m !== 'object') continue;
    const fact = String(m.fact ?? '').slice(0, LIMITS.factChars);
    if (!fact.trim()) continue;
    const item: Fact = { fact, day: dayNum(m.day) };
    if (typeof m.kind === 'string') item.kind = m.kind.slice(0, 24);
    if (typeof m.mood === 'string') item.mood = m.mood.slice(0, 24);
    out.push(item);
  }
  return out;
}

// Flat string lists (fresh memory candidates, open threads). personas.ts already
// slices these; doing it here as well keeps the cap next to the other limits and
// covers callers that reach the prompt builders by another path.
export function capStrings(list: unknown, maxCount = LIMITS.strings, maxChars = LIMITS.stringChars): string[] {
  return (Array.isArray(list) ? list : [])
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .slice(0, maxCount)
    .map((s) => s.slice(0, maxChars));
}

// Shared-app-token match. `configured` is the server's APP_TOKEN, which may be
// a COMMA-SEPARATED list so a rotation never strands a client: publish
// "new,old", ship a build carrying the new value, drop the old entry once
// everyone has updated. Empty/absent means an open door (local dev).
export function tokenAccepted(configured: string | undefined, sent: string | null): boolean {
  const accepted = (configured || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!accepted.length) return true;
  return !!sent && accepted.includes(sent);
}

// The admin gate's expected value. Falls back to the app token only when no
// ADMIN_TOKEN is set (open dev), and takes the FIRST entry because APP_TOKEN
// may be a rotation list.
export function adminExpected(adminToken: string | undefined, appToken: string | undefined): string {
  return adminToken || (appToken || '').split(',')[0].trim();
}

// ── invite passphrases ──
// Codes live in config:current.codes as { "<phrase>": <daily limit> }. There is
// no UI for redeeming one: the human simply says the phrase to their pet, and
// the worker recognises it before the message ever reaches a model.

// Normalise for comparison so a phrase survives being retyped: case and
// surrounding whitespace are forgiven, and full-width punctuation folds to
// ASCII (a Chinese IME produces ，。！？ where the config likely has none).
export function normalizeCode(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：]/g, '')
    .replace(/[.!?,;:]/g, '')
    .replace(/\s+/g, '');
}

// Match a chat message against the configured phrases. Returns the phrase's
// canonical key (the DO name) and the budget it grants, or null for the
// overwhelmingly common case of ordinary conversation. Anything long enough to
// be a real sentence is skipped without looking.
export function matchCode(text: string, codes: Record<string, number> | undefined): { key: string; limit: number } | null {
  if (!codes || !text || text.length > 80) return null;
  const said = normalizeCode(text);
  if (!said) return null;
  for (const [phrase, limit] of Object.entries(codes)) {
    if (normalizeCode(phrase) === said) return { key: phrase, limit };
  }
  return null;
}

// Validate the codes map coming in over the admin door. Bounded like the tuning
// map: a runaway config here would be read on every single chat request.
export function capCodes(codes: Record<string, unknown>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(codes).slice(0, 200)) {
    const phrase = k.trim();
    const n = Math.trunc(Number(v));
    if (phrase && phrase.length <= 80 && Number.isFinite(n) && n >= 1 && n <= 100_000) out[phrase] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

// deviceId becomes part of a KV key (`q:<id>:<date>`), and KV keys are capped at
// 512 bytes — an oversized one would fail the quota write rather than the
// request, i.e. the caller would get metered for free. charId only indexes a
// known persona map, but there is no reason to carry an unbounded string.
const id = (v: unknown, max: number): string | undefined => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || undefined;
};

// ── per-payload sanitizers ──
// Every metered endpoint runs its body through one of these before a prompt is
// built. Unknown fields are dropped: the app sends a few the server ignores
// (charName, voice), and rebuilding the object rather than patching it means a
// new one can never sneak into a prompt.

export function capChat(p: ChatPayload): ChatPayload {
  return {
    deviceId: id(p.deviceId, 64),
    charId: id(p.charId, 32),
    day: dayNum(p.day),
    daypart: id(p.daypart, 16),
    lang: p.lang === 'zh' ? 'zh' : 'en',
    memory: capMemory(p.memory),
    fresh: capStrings(p.fresh),
    loops: capStrings(p.loops),
    messages: capTurns(p.messages, LIMITS.msgs, LIMITS.msgsChars),
    distill: p.distill === true,
  };
}

export function capDistill(p: DistillPayload): DistillPayload {
  return {
    deviceId: id(p.deviceId, 64),
    day: dayNum(p.day),
    lang: p.lang === 'zh' ? 'zh' : 'en',
    memory: capMemory(p.memory),
    loops: capStrings(p.loops),
    context: capTurns(p.context, LIMITS.context, LIMITS.msgsChars),
    // 'oldest' keeps the chunk's turn numbering aligned with the app's — see capTurns
    messages: capTurns(p.messages, LIMITS.msgs, LIMITS.msgsChars, 'oldest'),
  };
}

export function capConsolidate(p: ConsolidatePayload): ConsolidatePayload {
  return {
    deviceId: id(p.deviceId, 64),
    day: dayNum(p.day),
    lang: p.lang === 'zh' ? 'zh' : 'en',
    memory: capMemory(p.memory),
  };
}
