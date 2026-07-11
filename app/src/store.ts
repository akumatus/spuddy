import type { AppState } from './types';

const KEY = 'pp_ritual_v1';

// State lives in a JSON file in userData (main process does the IO — see
// electron/src/store.ts), not localStorage: the chat log is unbounded and
// localStorage's ~5MB quota would make save() silently drop everything.
// localStorage remains as the read fallback so pre-file saves migrate on
// first launch, and as the store when running in a plain browser (vite dev).
const fileStore = () => window.pp?.store;

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
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
    keptToday: false,
    cards: [], // {m, rare, day, by, fav}
    usedCards: { date: null, used: [] }, // server-pool lines drawn this batch (no-replacement gacha; resets when a new daily pool lands)
    usedGolden: { date: null, used: [] }, // golden-pool lines drawn this batch — same no-replacement bookkeeping
    usedBuiltins: [], // built-in DAILY lines ever drawn — each retires permanently once seen
    memory: [], // {day, fact, kind, mood} — durable facts he's distilled about the human
    // The transcript starts empty — his daily hello lives in a spoken bubble, not
    // the record (see main.js). It fills as you actually talk.
    chat: [],
    active: 'spud',
    unlockedIds: ['spud'],
    buddyNew: false,
    sound: true,
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
  s.keptToday = false;
  if (typeof s.draws !== 'number') s.draws = s.drawn ? 1 : 0; // migrate old saves
  if (typeof s.pity !== 'number') s.pity = 0; // golden pity counter persists across days, not reset on day rollover
  if (s.lang !== 'en' && s.lang !== 'zh') s.lang = 'auto'; // pre-i18n saves + bad values
  return s;
}

export function save(s: AppState): void {
  try {
    const json = JSON.stringify({ ...s, memory: s.memory.slice(-60) });
    const fs = fileStore();
    if (fs) fs.save(json);
    else localStorage.setItem(KEY, json);
  } catch (e) {}
}

export function reset(): void {
  try {
    // clear both: a leftover localStorage copy would resurrect pre-migration
    // state through load()'s fallback on the next boot
    fileStore()?.reset();
    localStorage.removeItem(KEY);
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
