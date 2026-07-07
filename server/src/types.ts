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
  GOLDEN_PER_DAY?: string;
  MUTTERS_PER_DAY?: string;
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

// POST body shared by /chat, /golden and /greet (fields used vary per route)
export interface ChatPayload {
  deviceId?: string;
  charId?: string;
  day?: number;
  daypart?: string;
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
  golden: string[];
  normal?: string[]; // pre-split batches kept normals per persona
  mutters: Record<MutterMood, string[]>;
}

// the daily batch stored in KV (cards:current) and served by GET /cards
export interface CardsBatch {
  date: string;
  normal: string[]; // the shared voice-neutral pool every persona draws from
  cards: Record<string, CharBatch>;
}
