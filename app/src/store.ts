import type { AppState, ChatMessage, MemoryFact } from './types';

const KEY = 'pp_ritual_v1';

// State lives in files in userData (main process does the IO — see
// electron/src/store.ts), not localStorage: the chat log is unbounded and
// localStorage's ~5MB quota would make save() silently drop everything.
// state.json holds everything small and is rewritten whole on every save;
// the transcript has its own append-only chat.jsonl so a long history never
// bloats those rewrites (see the chat-window block below). localStorage
// remains as the read fallback so pre-file saves migrate on first launch, and
// as the store (full state, chat included) when running in a plain browser
// (vite dev).
const fileStore = () => window.pp?.store;

// ── chat window (file-store mode) ──
// state.chat is a window onto chat.jsonl, not the whole log: the last
// CHAT_TAIL lines at boot plus everything said this session, extended upward
// when the Book pages older history in (loadOlderChat). Plenty of tail for
// everything that reads recent chat — the LLM context is the last 12 lines.
const CHAT_TAIL = 100;
let chatBase = 0; // file lines above state.chat[0]
let chatOnDisk = 0; // leading entries of state.chat already written to the file

// a line that doesn't parse (crash mid-append) drops silently — losing one
// message beats refusing to load the transcript
function parseChatLines(lines: string[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const l of lines) {
    try {
      const m = JSON.parse(l) as ChatMessage;
      if (m && typeof m.text === 'string') out.push(m);
    } catch (e) {}
  }
  return out;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

// ── memory dedupe ──
// The model re-surfaces the same fact across conversations, often re-told with
// extra detail ("has a daughter named 芋圆" → "…芋圆, six months old"). Flatten
// case, punctuation and spacing so a re-telling that only adds a clause reads
// as containment of the shorter fact, not as a brand-new one.
export function normFact(f: string): string {
  return f.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Collapse facts that contain one another: the richer telling keeps the card,
// the earliest day stays (when he first learned it). Runs on load to heal
// saves that collected twins before containment-aware dedupe existed.
export function dedupeMemory(mem: MemoryFact[]): MemoryFact[] {
  const kept: MemoryFact[] = [];
  for (const m of mem) {
    const n = normFact(m.fact);
    const twin = n && kept.find((k) => {
      const kn = normFact(k.fact);
      return kn.includes(n) || n.includes(kn);
    });
    if (!twin) { kept.push({ ...m }); continue; }
    if (n.length > normFact(twin.fact).length) {
      twin.fact = m.fact;
      twin.kind = m.kind;
      twin.mood = m.mood;
    }
    twin.day = Math.min(twin.day, m.day);
  }
  return kept;
}

export function defaultState(): AppState {
  return {
    day: 1,
    streak: 1,
    lastDate: todayStr(),
    drawn: false,
    draws: 0, // draws taken today; limit is main.js DAILY_DRAW_LIMIT
    pity: 0, // draws since last golden, used for golden pity/smoothing; persists across days, see main.js drawToday
    rare: false,
    msg: '',
    msgSrc: '', // attribution of the held card when it's a famous quote
    keptToday: false,
    cards: [], // {m, rare, day, by, src, fav}
    usedCards: { date: null, used: [] }, // server normal-pool lines drawn this batch (no-replacement gacha; resets when a new daily pool lands)
    usedQuotes: [], // famous-quote lines drawn (golden source) — static pool, so this persists until it laps
    usedMemory: { date: null, used: [] }, // memory facts fed to a golden weave today — rotation, resets each calendar day
    memory: [], // {day, fact, kind, mood} — durable facts he's distilled about the human
    // The transcript starts empty — his daily hello lives in a spoken bubble, not
    // the record (see main.js). It fills as you actually talk.
    chat: [],
    active: 'spud',
    unlockedIds: ['spud'],
    buddyNew: false,
    sound: true,
    petSize: 'md', // character render size; tweakable in the ⚙ settings panel
    lang: 'en', // default to English; the tray menu offers Auto/中文 to switch
    nightShownDate: null,
    // personality engine (7a) — 0..100, design Tweaks defaults
    personality: { curiosity: 65, clinginess: 60, drama: 55, sleepiness: 35 },
  };
}

export function load(): AppState {
  let s = defaultState();
  try {
    const raw = JSON.parse(fileStore()?.load() || localStorage.getItem(KEY) || 'null') as
      | (Partial<AppState> & { journal?: unknown })
      | null;
    if (raw && Array.isArray(raw.cards)) {
      s = { ...s, ...raw };
      if (!s.unlockedIds.includes('spud')) s.unlockedIds = ['spud', ...s.unlockedIds];
      if (!Array.isArray(s.chat)) s.chat = [];
      // Long-term memory moved from raw {day, note, reply} chat excerpts to
      // {day, fact} distilled facts. Old excerpts don't translate — start clean.
      if (!Array.isArray(s.memory)) s.memory = [];
      // heal twins saved before dedupe became containment-aware (chat.ts rememberFact)
      s.memory = dedupeMemory(s.memory);
      // pre-TS saves carried a journal field — drop it on load
      delete (s as { journal?: unknown }).journal;
    }
  } catch (e) {}
  // roll the real calendar forward: new day → fresh draw, streak counts consecutive days
  const today = todayStr();
  if (s.lastDate !== today) {
    const gap = daysBetween(s.lastDate, today);
    s.day += 1;
    s.streak = gap === 1 ? s.streak + 1 : 1;
    s.lastDate = today;
    s.draws = 0;
  }
  // the card in his hands is ephemeral: every launch (and every new day) starts
  // back on "tap me" for a fresh draw — kept cards live on in the Book
  s.drawn = false;
  s.rare = false;
  s.msg = '';
  s.msgSrc = '';
  s.keptToday = false;
  if (typeof s.draws !== 'number') s.draws = s.drawn ? 1 : 0; // migrate old saves
  if (typeof s.pity !== 'number') s.pity = 0; // golden pity counter persists across days, not reset on day rollover
  if (s.lang !== 'en' && s.lang !== 'zh') s.lang = 'auto'; // pre-i18n saves + bad values
  if (s.petSize !== 'sm' && s.petSize !== 'md' && s.petSize !== 'lg') s.petSize = 'md'; // absent in older saves / bad values

  // swap the raw chat array for a window onto chat.jsonl (see block up top)
  const fs = fileStore();
  if (fs) {
    try {
      // Legacy save: the transcript used to live inside state.json. Move it
      // into chat.jsonl once, then strip it via the immediate save below so a
      // crashed launch can't migrate twice. If chat.jsonl already has lines,
      // a previous migration wrote the file but the strip never landed — the
      // file is the newer copy, so it wins and the state.json one just drops.
      const legacy = s.chat.length > 0;
      if (legacy && fs.chatLoad(null, 0).total === 0) {
        fs.chatRewrite(s.chat.map((m) => JSON.stringify(m)));
      }
      const r = fs.chatLoad(null, CHAT_TAIL);
      s.chat = parseChatLines(r.lines);
      chatBase = r.total - r.lines.length;
      chatOnDisk = s.chat.length;
      if (legacy) save(s); // rewrites state.json without the chat field
    } catch (e) {}
  }
  return s;
}

export function save(s: AppState): void {
  try {
    const fs = fileStore();
    if (!fs) {
      // plain browser (vite dev): everything, chat included, in localStorage
      localStorage.setItem(KEY, JSON.stringify({ ...s, memory: s.memory.slice(-60) }));
      return;
    }
    const slim: Partial<AppState> = { ...s, memory: s.memory.slice(-60) };
    delete slim.chat; // lives in chat.jsonl
    fs.save(JSON.stringify(slim));
    if (s.chat.length < chatOnDisk) {
      // the window only ever shrinks via "clear chat" — start the file over
      fs.chatRewrite(s.chat.map((m) => JSON.stringify(m)));
      chatBase = 0;
      chatOnDisk = s.chat.length;
    } else {
      // Append finished turns only — up to the last pet reply. Trailing user
      // lines still waiting on an answer stay memory-only for now: the reply
      // may yet stitch a mem tag onto them (chat.ts rememberFact), and a line
      // already on disk couldn't take the stitch.
      let upto = s.chat.length;
      while (upto > chatOnDisk && s.chat[upto - 1].who !== 'pet') upto--;
      if (upto > chatOnDisk) {
        fs.chatAppend(s.chat.slice(chatOnDisk, upto).map((m) => JSON.stringify(m)));
        chatOnDisk = upto;
      }
    }
  } catch (e) {}
}

// Page older history into the front of the state.chat window (Book scroll-up).
// Returns how many messages were prepended — 0 means the beginning is loaded.
export function loadOlderChat(s: AppState, n: number): number {
  const fs = fileStore();
  if (!fs || chatBase <= 0) return 0;
  try {
    const r = fs.chatLoad(chatBase, n);
    if (r.lines.length === 0) {
      chatBase = 0; // file shrank under us — treat as fully loaded
      return 0;
    }
    const older = parseChatLines(r.lines);
    chatBase -= r.lines.length;
    chatOnDisk += older.length;
    s.chat.unshift(...older);
    return older.length;
  } catch (e) {
    return 0;
  }
}

// whether chat.jsonl still has lines above the loaded window
export function hasOlderChat(): boolean {
  return chatBase > 0;
}

export function reset(): void {
  try {
    // clear both: a leftover localStorage copy would resurrect pre-migration
    // state through load()'s fallback on the next boot
    fileStore()?.reset();
    localStorage.removeItem(KEY);
    chatBase = 0;
    chatOnDisk = 0;
  } catch (e) {}
}

export function counts(s: AppState) {
  return {
    cards: s.cards.length,
    favs: s.cards.filter((c) => c.fav).length,
    chats: s.memory.length,
    streak: s.streak,
    golden: s.cards.filter((c) => c.rare).length,
  };
}
