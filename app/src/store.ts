import type { AppState, ChatMessage, MemoryFact, MemoryKind } from './types';

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

// Roll the real calendar forward: new day → fresh draws, streak counts
// consecutive days. Runs at load AND on a runtime tick (main.ts) — a desktop
// pet routinely stays open across midnight, and without the runtime check
// day/streak/draws (and the daily first-draw golden) only ever advance on a
// relaunch. Returns whether a new day started so the tick can persist.
export function rollDay(s: AppState): boolean {
  const today = todayStr();
  if (s.lastDate === today) return false;
  s.day += 1;
  s.streak = daysBetween(s.lastDate, today) === 1 ? s.streak + 1 : 1;
  s.lastDate = today;
  s.draws = 0;
  return true;
}

// ── memory dedupe ──
// The model re-surfaces the same fact across conversations, often re-told with
// extra detail ("has a cat named Mochi" → "…Mochi, adopted last spring"). Flatten
// case, punctuation and spacing so a re-telling that only adds a clause reads
// as containment of the shorter fact, not as a brand-new one.
export function normFact(f: string): string {
  return f.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Character bigrams with spaces stripped — works for both CJK (no word
// boundaries to lean on) and Latin text, at the cost of junction bigrams
// across former word breaks (symmetric on both sides, so harmless).
function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

// How many bigrams a fuzzy match needs before it's trusted. Short facts carry
// too little signal — "喜欢喝咖啡" vs "喜欢喝茶" score high on any char metric —
// so below this floor only exact containment can merge (precision over recall:
// a false merge silently destroys a memory, a miss just leaves a twin card).
const TWIN_MIN_BIGRAMS = 12;
// Fraction of the shorter fact's bigrams that must appear in the longer one.
// Calibrated on observed twin cards: paraphrased re-tellings land ≈0.75+, facts
// that merely share an entity ("猫叫年糕" vs "猫会开门了") stay ≤0.5.
const TWIN_BIGRAM_SCORE = 0.72;
// Latin-only second gate: swapping one word ("cat"→"dog") barely dents char
// bigrams, so the shorter fact's words must (nearly) all appear in the longer.
const TWIN_WORD_SCORE = 0.82;

// Are these two tellings of the same fact? True on containment (one normalized
// string inside the other) or on high bigram overlap for longer paraphrases —
// re-orderings and reworded twins that containment can't see.
export function factTwin(a: string, b: string): boolean {
  const na = normFact(a);
  const nb = normFact(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  if (small.size < TWIN_MIN_BIGRAMS) return false;
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  if (hit / small.size < TWIN_BIGRAM_SCORE) return false;
  const latin = (na.match(/[a-z]/g) || []).length > na.length / 2;
  if (latin) {
    const wa = new Set(na.split(' '));
    const wb = new Set(nb.split(' '));
    const [ws, wl] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
    let whit = 0;
    for (const w of ws) if (wl.has(w)) whit++;
    if (whit / ws.size < TWIN_WORD_SCORE) return false;
  }
  return true;
}

// Collapse twin tellings of one fact: the richer telling keeps the card, the
// earliest day stays (when he first learned it). Runs on load to heal saves
// that collected twins before dedupe learned each trick (containment first,
// bigram paraphrases later).
export function dedupeMemory(mem: MemoryFact[]): MemoryFact[] {
  const kept: MemoryFact[] = [];
  for (const m of mem) {
    const n = normFact(m.fact);
    const twin = n && kept.find((k) => factTwin(k.fact, m.fact));
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
    distilledUpTo: 0, // batch memory-extraction cursor, in absolute chat.jsonl lines (app/distill.ts)
    consolidatedDay: 0, // friendship day of the last memory-curation pass (app/consolidate.ts)
    active: 'spud',
    unlockedIds: ['spud'],
    buddyNew: false,
    sound: true,
    immersive: false, // do-not-disturb mode; tweakable in the ⚙ settings panel
    petSize: 'md', // character render size; tweakable in the ⚙ settings panel
    lang: 'auto', // follow the system locale (zh → Chinese, else English); the tray menu offers Auto/中文/English to switch
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
  rollDay(s);
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
  if (typeof s.immersive !== 'boolean') s.immersive = false; // absent in older saves

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
  // Batch-extraction cursor (app/distill.ts). Saves from before the field
  // existed backfill the last few messages once — history distilled under the
  // old in-reply rules gets a second read — then clamp into the transcript
  // (it can point past the end after an external truncation).
  const total = chatTotal(s);
  if (typeof s.distilledUpTo !== 'number') s.distilledUpTo = Math.max(0, total - 30);
  s.distilledUpTo = Math.max(0, Math.min(s.distilledUpTo, total));
  if (typeof s.consolidatedDay !== 'number') s.consolidatedDay = 0; // pre-curation saves
  return s;
}

// Facts that feed prompts and the quilt — attic (retired) cards stay out.
// Callers that mutate cards keep going through state.memory; this is the
// read view for anything the pet says or shows.
export function activeMemory(s: AppState): MemoryFact[] {
  return s.memory.filter((m) => !m.retired);
}

// ── memory cap ──
// state.json is rewritten whole on every save, so memory must stay bounded.
// The cap used to be a straight slice(-60): the oldest fact dropped regardless
// of what it was — "her daughter's name" aged out exactly like "likes mango".
// Evict kind-aware instead: kinds that expire by nature go first (oldest
// within the tier), identity kinds only when nothing else is left to give.
const MEMORY_MAX = 60;
// the attic (retired cards) gets its own smaller quota — kept for recovery,
// not worth unbounded growth; oldest-inserted drop first
const ATTIC_MAX = 40;
const EVICT_TIERS: MemoryKind[][] = [
  ['other'],
  ['feeling'],
  ['likes', 'goal', 'work'],
  ['people', 'pets', 'milestone'],
];
function capActive(active: MemoryFact[], max: number): MemoryFact[] {
  const out = active.slice();
  while (out.length > max) {
    let victim = -1;
    for (const tier of EVICT_TIERS) {
      for (let i = 0; i < out.length; i++) {
        if (!tier.includes(out[i].kind)) continue;
        if (victim === -1 || out[i].day < out[victim].day) victim = i;
      }
      if (victim !== -1) break;
    }
    // only unknown kinds left (corrupt/future data) — drop the oldest-inserted
    out.splice(victim === -1 ? 0 : victim, 1);
  }
  return out;
}
export function capMemory(mem: MemoryFact[], max = MEMORY_MAX): MemoryFact[] {
  const active = mem.filter((m) => !m.retired);
  const attic = mem.filter((m) => m.retired);
  if (active.length <= max && attic.length <= ATTIC_MAX) return mem;
  const keep = new Set<MemoryFact>([
    ...capActive(active, max),
    ...attic.slice(-ATTIC_MAX),
  ]);
  return mem.filter((m) => keep.has(m));
}

export function save(s: AppState): void {
  try {
    const fs = fileStore();
    if (!fs) {
      // plain browser (vite dev): everything, chat included, in localStorage
      localStorage.setItem(KEY, JSON.stringify({ ...s, memory: capMemory(s.memory) }));
      return;
    }
    const slim: Partial<AppState> = { ...s, memory: capMemory(s.memory) };
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

// Total transcript length in absolute chat.jsonl lines — the coordinate space
// of the distill cursor (state.chat indexes shift as the Book pages history in,
// absolute counts don't). In browser mode the window IS the whole log.
export function chatTotal(s: AppState): number {
  return chatBase + s.chat.length;
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
