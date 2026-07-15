// Shared server types: the Worker environment and the request/response shapes
// exchanged with the app (see app/src/types.ts for the client-side mirror).

export interface Env {
  KV: KVNamespace;

  // secrets (wrangler secret put NAME) — a missing key just skips that backend
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  APP_TOKEN?: string;
  ADMIN_TOKEN?: string;

  // [vars] defaults — the live values may be overridden via KV config:current
  CHAT_PROVIDER?: string;
  GEN_PROVIDER?: string;
  DEEPSEEK_MODEL?: string;
  OPENAI_MODEL?: string;
  GEMINI_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  CHAT_DAILY_LIMIT?: string;
  CARDS_PER_DAY?: string;
  MUTTERS_PER_DAY?: string;
  QUOTES_LIB_MAX?: string; // cap on the persistent quote library; oldest drop off past it
  GEN_RUNS?: string;
}

// a durable fact the model chose to keep about the human (chat replies)
export interface RememberNote {
  fact: string;
  kind: string;
  mood: string | null;
}

export interface MemoryItem {
  fact?: string;
  day?: number;
}

// batch/content language: English is the default and the legacy behavior
export const LANGS = ['en', 'zh'] as const;
export type Lang = (typeof LANGS)[number];
export const asLang = (v: string | null | undefined): Lang => (v === 'zh' ? 'zh' : 'en');
// per-language KV key for the daily batch — 'cards:current' stays the en key
// so app builds from before the i18n work keep reading English pools
export const batchKey = (lang: Lang): string => (lang === 'zh' ? 'cards:current:zh' : 'cards:current');

// POST body shared by /chat, /golden and /greet (fields used vary per route)
export interface ChatPayload {
  deviceId?: string;
  charId?: string;
  day?: number;
  daypart?: string;
  lang?: string; // 'zh' → zh prompts + zh daily-batch musings
  memory?: MemoryItem[];
  messages?: { who?: string; text?: string }[];
}

export interface ChatTurn {
  role: string;
  content: string;
}

// the moods brain.ts picks idle mutters by — each gets its own daily pool
export const MOODS = ['watch', 'alone', 'lonely'] as const;
export type MutterMood = (typeof MOODS)[number];

export interface CharBatch {
  normal?: string[]; // pre-split batches kept normals per persona
  mutters: Record<MutterMood, string[]>;
  // a small daily set of lines in THIS persona's voice, mixed into the shared
  // pools at a low rate on the app side (~4 mutters + ~4 greetings per day)
  flavor?: { mutter?: string[]; greet?: string[] };
}

// Shared, daily-refreshed bubble/greeting pools — ONE voice-neutral set every
// persona draws from (mirrors the shared `normal` pool; the app falls back to
// its built-in packs when a group is missing). Group/key names mirror the
// app's content packs: mutter moods (all six), routine step lines, spoken
// social lines, daypart greetings, and the flat reaction/care pools.
export const BUBBLE_MOODS = ['watch', 'alone', 'lonely', 'sleepy', 'ignored', 'wake'] as const;
export const ROUTINE_KEYS = [
  'chaseStart', 'chaseEnd', 'juggleEnd', 'studyStart', 'studyEnd',
  'practiceStart', 'practiceEnd', 'humEnd', 'stretchEnd', 'sneezeEnd',
] as const;
export const SPEAK_KEYS = ['greet', 'knock', 'delight'] as const;
export const DAYPARTS = ['morning', 'afternoon', 'evening', 'night'] as const;
export const BUBBLE_FLAT = ['poke', 'retap', 'drawLines', 'weaveLines', 'cardHint', 'sedentary', 'nightMsg'] as const;

export interface Bubbles {
  mutter?: Record<string, string[]>;
  speak?: Record<string, string[]>;
  routines?: Record<string, string[]>;
  hi?: Record<string, string[]>;
  poke?: string[];
  retap?: string[];
  drawLines?: string[];
  weaveLines?: string[];
  cardHint?: string[];
  sedentary?: string[];
  nightMsg?: string[];
}

// A curated famous line (film / series / book / speech / internet). Lives in a
// persistent, growing KV library (quotes:<lang>, see quotes-store.ts) that the
// daily membership routine APPENDS to; GET /cards serves the whole library
// alongside the batch. The app also bundles a static pool as offline fallback.
export interface Quote {
  q: string; // the line itself
  s?: string; // attribution shown on the card; omitted for internet-era lines
}

// the daily batch stored in KV (cards:current) and served by GET /cards.
// Quotes are NOT part of the stored batch — they're a separate KV library the
// /cards handler merges into the response.
export interface CardsBatch {
  date: string;
  normal: string[]; // the shared voice-neutral pool every persona draws from
  bubbles?: Bubbles; // shared daily bubble/greeting pools (absent on pre-bubbles batches)
  cards: Record<string, CharBatch>;
}
