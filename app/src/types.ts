// Shared types for the renderer AND the Electron main process. This file is
// environment-agnostic (types only) — it doubles as the IPC contract between
// the preload bridge (window.pp) and the handlers in electron/src.

export type CharId = 'spud' | 'taco' | 'donut' | 'bloom' | 'leo' | 'grad';

// UI / built-in-content language. 'auto' follows the system locale; the
// resolved language is always a concrete Lang (see locale.ts).
export type Lang = 'en' | 'zh';
export type LangPref = 'auto' | Lang;

// Emotion tag the LLM leads every chat reply with — drives the body reaction.
export type EmotionTag = 'comfort' | 'cheer' | 'proud' | 'calm';

// Memory quilt patch color — the model's own stamp on a [[remember]] note.
export type MemoryMood = 'sunny' | 'rainy' | 'plain';

// Memory categories — must match MEMORY_KINDS in content.ts (and the chat
// prompts in server/src/personas.ts + electron/src/ai.ts).
export type MemoryKind =
  | 'work' | 'goal' | 'people' | 'pets' | 'likes' | 'milestone' | 'feeling' | 'other';

// Idle-mutter moods with pre-generated server pools (see brain.ts).
export type MutterMood = 'watch' | 'alone' | 'lonely';

export type Daypart = 'morning' | 'afternoon' | 'evening' | 'night';

// ── persisted state (store.ts) ──

export interface KeptCard {
  m: string;
  rare: boolean;
  day: number;
  by: string;
  fav?: boolean;
}

export interface ChatMessage {
  who: 'user' | 'pet';
  text: string;
  day: number;
  date: string;
  // category of the durable fact this (user) line revealed — shows the
  // "knit into Memory" tag in the Card Book transcript
  mem?: MemoryKind;
}

export interface MemoryFact {
  day: number;
  fact: string;
  kind: MemoryKind;
  mood?: MemoryMood;
}

// No-replacement gacha bookkeeping for a server pool — resets when a fresh
// daily batch lands (its date stamp changes).
export interface UsedPool {
  date: string | null;
  used: string[];
}

// personality engine sliders (7a) — 0..100, design Tweaks defaults
export interface PersonalitySliders {
  curiosity: number;
  clinginess: number;
  drama: number;
  sleepiness: number;
}

export interface AppState {
  day: number;
  streak: number;
  lastDate: string;
  drawn: boolean;
  draws: number; // draws taken today; limit is gacha.ts DAILY_DRAW_LIMIT
  pity: number; // draws since last golden, used for golden pity/smoothing; persists across days
  rare: boolean;
  msg: string;
  keptToday: boolean;
  cards: KeptCard[];
  usedCards: UsedPool; // server-pool lines drawn this batch (no-replacement gacha)
  usedGolden: UsedPool; // golden-pool lines drawn this batch — same bookkeeping
  usedBuiltins: string[]; // built-in DAILY lines ever drawn — each retires permanently once seen
  memory: MemoryFact[]; // durable facts he's distilled about the human
  chat: ChatMessage[];
  active: CharId;
  unlockedIds: CharId[];
  buddyNew: boolean;
  sound: boolean;
  lang: LangPref; // UI/content language — 'auto' follows the system locale
  nightShownDate: string | null;
  personality: PersonalitySliders;
}

// ── server card batch (remote.ts / cards-today IPC) ──

export interface CharBatch {
  golden?: string[];
  normal?: string[]; // older pre-split batches kept normals per persona
  mutters?: Partial<Record<MutterMood, string[]>>;
}

export interface CardsBatch {
  date: string;
  normal?: string[]; // the shared voice-neutral pool every persona draws from
  cards: Record<string, CharBatch | null | undefined>;
}

// ── AI requests / replies over the preload bridge ──

// A durable fact the pet chose to keep about the human, parsed from the
// reply's trailing [[remember: kind | mood | fact]] note.
export interface RememberNote {
  fact: string;
  kind?: string; // validated against MemoryKind app-side; unknown → 'other'
  mood?: MemoryMood | null;
}

export interface AiReplyRequest {
  charId: CharId;
  charName: string;
  voice: string;
  day: number;
  memory: MemoryFact[];
  messages: ChatMessage[];
  lang?: Lang; // picks the matching daily-batch musings server-side
}

export interface AiReplyResult {
  text?: string | null;
  tag?: string; // EmotionTag, but the model may drift — validated app-side
  gesture?: string | null;
  remember?: RememberNote | null;
  limited?: boolean; // daily real-time budget spent (server 429)
}

export interface AiGoldenRequest {
  charId: CharId;
  charName: string;
  voice: string;
  memory: MemoryFact[];
  lang?: Lang; // 'zh' → the card is written in Chinese
}

export interface AiGreetRequest {
  charId: CharId;
  charName: string;
  voice: string;
  daypart: Daypart;
  day: number;
  memory: MemoryFact[];
  lang?: Lang; // 'zh' → the greeting is spoken in Chinese
}

// ── preload bridge (window.pp) ──

export type EdgeSide = 'left' | 'right' | 'top' | null;

// payload per push channel the main process emits
export interface PpEventMap {
  sedentary: void;
  cursor: { x: number; y: number };
  edge: EdgeSide;
  'set-lang': LangPref; // tray menu language pick — renderer persists + applies
  'update-note': string; // updater feedback, pre-localized — the pet says it out loud
}

export interface PreloadBridge {
  debug: boolean;
  ai: {
    reply(payload: AiReplyRequest): Promise<AiReplyResult | null>;
    golden(payload: AiGoldenRequest): Promise<string | null>;
    greet(payload: AiGreetRequest): Promise<string | null>;
  };
  cards: {
    today(lang?: Lang): Promise<CardsBatch | null>;
  };
  store?: {
    // persisted-state JSON file in userData. load is synchronous — read once
    // at boot before anything renders; null ⇒ no file yet (first run, or a
    // pre-file save still living in localStorage)
    load(): string | null;
    save(json: string): void;
    reset(): void;
  };
  lang?: {
    // renderer → main: keeps the tray menu's language checkmark in sync
    report(pref: LangPref, effective: Lang): void;
  };
  win: {
    setIgnoreMouse(v: boolean): void;
    // resolves to how many px the window fell short of the requested vertical
    // move (macOS pins the top under the menu bar)
    moveBy(dx: number, dy: number): Promise<number>;
    // which flank of the potato the hover panel fits on, given where the
    // window sits on screen — queried at boot and after each drag ends
    panelSide(): Promise<'left' | 'right'>;
    setModal(v: boolean): void;
    modalGeometry(): Promise<{ dx: number; dy: number } | null>;
  };
  on<K extends keyof PpEventMap>(channel: K, cb: (data: PpEventMap[K]) => void): void;
}

declare global {
  interface Window {
    pp?: PreloadBridge;
    // debug hook for automated UI tests (PP_UITEST=js:...) — see debug.ts
    _pp?: Record<string, unknown>;
  }
}
