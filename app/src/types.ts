// Shared types for the renderer AND the Electron main process. This file is
// environment-agnostic (types only) — it doubles as the IPC contract between
// the preload bridge (window.pp) and the handlers in electron/src.

export type CharId = 'spud' | 'taco' | 'donut' | 'bloom' | 'mochi' | 'grad';

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

// User "pet size" setting — how large the character draws inside the fixed
// stage. Mapped to a world-space scale by PET_SIZE_SCALE in scene/scene.ts.
export type PetSize = 'sm' | 'md' | 'lg';

// ── persisted state (store.ts) ──

export interface KeptCard {
  m: string;
  rare: boolean;
  day: number;
  by: string;
  src?: string; // famous-quote attribution (e.g. Gone with the Wind); absent on written cards
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
  // which buddy spoke this (pet) line — the transcript shows that buddy's face
  // beside it, not whoever happens to be active now. Absent on legacy lines.
  char?: CharId;
}

// A short-lived pending thing (an interview, a bug hunt, waiting on news) the
// pet asks about later — maintained by the distill pass, expires fast (store.ts).
export interface OpenLoop {
  text: string;
  day: number; // friendship day it was first noted — the expiry anchor
}

export interface MemoryFact {
  day: number;
  fact: string;
  kind: MemoryKind;
  mood?: MemoryMood;
  // In the attic: a consolidation pass judged this state long passed. Hidden
  // from every prompt and from the quilt, but kept (not deleted) so nothing a
  // model decided is unrecoverable; re-affirming the fact in chat un-retires
  // it (memory.ts rememberFact).
  retired?: boolean;
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
  weavePity: number; // goldens since the last delivered live weave; at the limit the next golden skips the roll and attempts the weave (gacha.ts)
  rare: boolean;
  msg: string;
  msgSrc: string; // attribution of the held card when it's a famous quote; '' otherwise
  keptToday: boolean;
  cards: KeptCard[];
  usedCards: UsedPool; // server normal-pool lines drawn this batch (no-replacement gacha)
  usedQuotes: string[]; // famous-quote lines drawn (golden source) — static pool, persists until it laps
  usedInet: string[]; // internet-line pool lines drawn (normal source) — persistent pool, persists until it laps
  usedMemory: UsedPool; // memory facts fed to a golden weave today (rotation, no same-day repeat); date = calendar day
  memory: MemoryFact[]; // durable facts he's distilled about the human
  loops: OpenLoop[]; // open threads to circle back to ("how did the interview go?")
  chat: ChatMessage[];
  // lifetime count of lines the HUMAN has sent him — the Bloom unlock's meter
  // (store.ts counts().chats). Its own counter rather than a read of the
  // transcript: state.chat is a sliding window, and clearing the chat must not
  // revoke progress the human already earned. Monotonic, never reset.
  chatTurns: number;
  // batch memory extraction cursor — how many chat.jsonl lines (absolute file
  // count, NOT an index into the state.chat window) have been distilled. See
  // app/distill.ts; healed by clamping when the transcript shrinks (clear chat).
  distilledUpTo: number;
  // friendship day of the last memory-consolidation pass (app/consolidate.ts);
  // 0 = never ran. A clean no-op pass counts — it still answered "this week".
  consolidatedDay: number;
  active: CharId;
  unlockedIds: CharId[];
  buddyNew: boolean;
  sound: boolean;
  // do-not-disturb (settings ⚙): no idle mutters/routines, no gaze tracking,
  // sound gated off while on — `sound` keeps the user's preference untouched
  immersive: boolean;
  petSize: PetSize; // character render size within the stage (settings ⚙)
  lang: LangPref; // UI/content language — 'auto' follows the system locale
  nightShownDate: string | null;
  personality: PersonalitySliders;
}

// A curated famous line (film / series / book / speech / internet). The server
// keeps a growing library and sends it in the /cards response; the app also
// bundles a static pool as its offline fallback (see quotes.en.ts / quotes.zh.ts).
export interface Quote {
  q: string; // the line itself
  s?: string; // attribution shown on the card; omitted for internet-era lines
}

// ── server card batch (remote.ts / cards-today IPC) ──

export interface CharBatch {
  golden?: string[];
  normal?: string[]; // older pre-split batches kept normals per persona
  mutters?: Partial<Record<MutterMood, string[]>>;
  // small daily set in THIS persona's voice, mixed into the shared pools at a
  // low rate so buddies keep their accent (see brain FLAVOR_CHANCE / greet)
  flavor?: { mutter?: string[]; greet?: string[] };
}

// Shared, daily-refreshed bubble/greeting pools — one voice-neutral set every
// persona draws from (mirrors the shared `normal` card pool). Everything the
// potato says in a bubble lives here so it changes day to day; the built-in
// content packs (content.*.ts) are only the offline fallback. Loosely typed
// because it rides in as JSON: nested groups are keyed by MutterPool / speak
// kind / RoutineLineKey / Daypart; the flat ones are plain line pools.
export interface Bubbles {
  mutter?: Record<string, string[]>; // watch/alone/lonely/sleepy/ignored/wake
  speak?: Record<string, string[]>; // greet/knock/delight
  routines?: Record<string, string[]>; // chaseStart … sneezeEnd
  hi?: Record<string, string[]>; // daypart greetings: morning/afternoon/evening/night
  poke?: string[];
  retap?: string[];
  drawLines?: string[];
  weaveLines?: string[];
  cardHint?: string[];
  sedentary?: string[];
  nightMsg?: string[];
  landing?: string[];
}

export interface CardsBatch {
  date: string;
  normal?: string[]; // the shared voice-neutral pool every persona draws from
  bubbles?: Bubbles; // shared daily bubble/greeting pools (absent on pre-Phase-B batches)
  cards: Record<string, CharBatch | null | undefined>;
  quotes?: Quote[]; // today's window of the server quote library (golden source)
  inet?: string[]; // today's window of the internet-line pool (normal-card source, no attributions)
  tuning?: Record<string, number>; // server-tuned product knobs (gacha odds etc.) — see remote.ts tune()
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
  memory: MemoryFact[]; // the FULL fact list — the model needs it all to dedupe and stay consistent
  fresh?: string[]; // rotated subset of memory facts to prefer bringing up this turn
  loops?: string[]; // open threads — the prompt may weave a follow-up on one
  messages: ChatMessage[];
  lang?: Lang; // picks the matching daily-batch musings server-side
  // this build extracts memory in batch (app/distill.ts) — the server omits the
  // in-reply [[remember]] instructions from the chat prompt
  distill?: boolean;
}

export interface AiReplyResult {
  text?: string | null;
  // burst bubbles — the reply split into 1-3 short messages typed out one
  // after another (server splits on " ||| "); absent on older servers
  parts?: string[] | null;
  tag?: string; // EmotionTag, but the model may drift — validated app-side
  gesture?: string | null;
  remember?: RememberNote | null;
  limited?: boolean; // daily real-time budget spent (server 429)
}

// ── batch memory extraction (app/distill.ts ↔ POST /distill) ──

export interface AiDistillRequest {
  day: number;
  lang?: Lang; // 'zh' → facts written in Chinese
  memory: MemoryFact[]; // FULL current fact list — the server's "already known" dedupe context
  loops?: string[]; // current open-thread list — the pass returns the updated one
  context: { who: string; text: string }[]; // already-distilled tail — extract nothing from these
  messages: { who: string; text: string }[]; // the undistilled chunk
}

// One fact from the /distill response; turn = 1-based index of the chunk
// message that revealed it, for the transcript's "knit into Memory" stitch.
// updates = 1-based index into the memory list as sent: this fact corrects
// that (now outdated) card — rewrite it in place instead of adding a twin.
export interface DistilledFact {
  fact: string;
  kind?: string; // validated against MemoryKind app-side; unknown → 'other'
  mood?: MemoryMood | null;
  turn?: number;
  updates?: number;
}

export interface AiDistillResult {
  facts?: DistilledFact[] | null; // null: provider chain failed — keep the cursor, retry later
  loops?: string[] | null; // updated open-thread list; null/absent → keep the current one
  limited?: boolean; // daily real-time budget spent (server 429)
}

// ── periodic memory curation (app/consolidate.ts ↔ POST /consolidate) ──

export interface AiConsolidateRequest {
  day: number;
  lang?: Lang;
  memory: MemoryFact[]; // the ACTIVE fact list — op refs are 1-based indices into this
}

// One curation op; refs index the memory list as sent. merge folds `from`
// cards into `into`; reword replaces text only; retire moves a card to the attic.
export interface ConsolidateOpDto {
  op: 'merge' | 'reword' | 'retire';
  into?: number;
  from?: number[];
  target?: number;
  fact?: string;
  kind?: string;
  mood?: MemoryMood | null;
}

export interface AiConsolidateResult {
  ops?: ConsolidateOpDto[] | null; // null: provider chain failed — retry at the next trigger
  limited?: boolean; // daily real-time budget spent (server 429)
}

// Open-the-app follow-up hello (POST /greet): fired only when an open thread
// is pending, so the pet greets with "how did it go?" instead of a pool line.
export interface AiGreetRequest {
  charId: CharId;
  day: number;
  daypart: Daypart;
  memory: MemoryFact[];
  loops: string[];
  lang?: Lang;
}

export interface AiGoldenRequest {
  charId: CharId;
  charName: string;
  voice: string;
  day?: number; // today's friendship day — lets the prompt age old feeling/goal facts
  memory: MemoryFact[];
  lang?: Lang; // 'zh' → the card is written in Chinese
}

// ── preload bridge (window.pp) ──

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom' | null;
export type DockSide = Exclude<EdgeSide, null>;

// Edge-proximity report: which screen edge the potato is pushed against, plus
// where that edge's line sits in window coordinates (ex for left/right, ey for
// top/bottom) so the renderer can draw the snap highlight exactly on it.
export interface EdgeInfo {
  side: EdgeSide;
  ex: number;
  ey: number;
}

// payload per push channel the main process emits
export interface PpEventMap {
  sedentary: void;
  cursor: { x: number; y: number; sameDisplay?: boolean }; // sameDisplay absent on older preloads
  edge: EdgeInfo;
  'set-lang': LangPref; // tray menu language pick — renderer persists + applies
  'update-note': string; // updater feedback, pre-localized — the pet says it out loud
}

export interface PreloadBridge {
  debug: boolean;
  ai: {
    reply(payload: AiReplyRequest): Promise<AiReplyResult | null>;
    distill?(payload: AiDistillRequest): Promise<AiDistillResult | null>; // absent on older preloads
    consolidate?(payload: AiConsolidateRequest): Promise<AiConsolidateResult | null>; // absent on older preloads
    golden(payload: AiGoldenRequest): Promise<string | null>;
    greet?(payload: AiGreetRequest): Promise<string | null>; // absent on older preloads
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
    // chat transcript, its own append-only chat.jsonl (one message per line):
    // chatLoad returns raw lines [before-limit, before) — before = null means
    // the tail — plus the file's total line count; the renderer parses.
    chatLoad(before: number | null, limit: number): { lines: string[]; total: number };
    chatAppend(lines: string[]): void;
    chatRewrite(lines: string[]): void;
  };
  lang?: {
    // renderer → main: keeps the tray menu's language checkmark in sync
    report(pref: LangPref, effective: Lang): void;
  };
  // seconds since the last user input, system-wide (powerMonitor) — presence
  // gate for features that must not fire at an empty chair. Absent on older
  // preloads; callers treat that as "present".
  idleSeconds?(): Promise<number>;
  win: {
    setIgnoreMouse(v: boolean): void;
    // resolves to how many px the window fell short of the requested vertical
    // move (macOS pins the top under the menu bar); lift = how far the stage is
    // slid up within the window, so edge detection tracks the potato, not the box
    moveBy(dx: number, dy: number, lift?: number): Promise<number>;
    // edge-dock snap: tween the window flush against the given screen edge
    dock(side: DockSide): Promise<void>;
    // which flank of the potato the hover panel fits on, given where the
    // window sits on screen — queried at boot and after each drag ends
    panelSide(): Promise<'left' | 'right'>;
  };
  // pet-renderer side of the popup-window bridge (see src/ui/overlay.ts):
  // mirror the staging markup out; clicks and page-up reports (a
  // data-page-up box scrolled to its top) come back as child-index paths
  popup: {
    show(html: string, panel: boolean, htmlClass: string): void;
    hide(): void;
    onClick(cb: (path: number[]) => void): void;
    onPageUp(cb: (path: number[]) => void): void;
  };
  // popup-window side (see src/popup-shell.ts)
  popupShell: {
    onRender(cb: (html: string, panel: boolean, htmlClass: string) => void): void;
    // the window was hidden (popup closed) — the Page Visibility API can't
    // report this itself while backgroundThrottling is off
    onHidden(cb: () => void): void;
    click(path: number[]): void;
    pageUp(path: number[]): void;
    resize(w: number, h: number): void;
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
