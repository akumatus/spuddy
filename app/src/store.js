import { PERS } from './content.js';

const KEY = 'pp_ritual_v1';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function defaultState() {
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
    journal: [], // {day, note, reply}
    chat: [{ who: 'pet', text: "Morning! I kept a card warm for you — tap me. Or just talk to me, I remember things." }],
    active: 'spud',
    unlockedIds: ['spud'],
    buddyNew: false,
    sound: true,
    nightShownDate: null,
    // personality engine (7a) — 0..100, design Tweaks defaults
    personality: { curiosity: 65, clinginess: 60, drama: 55, sleepiness: 35 },
  };
}

export function load() {
  let s = defaultState();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && Array.isArray(raw.cards)) {
      s = { ...s, ...raw };
      if (!s.unlockedIds.includes('spud')) s.unlockedIds = ['spud', ...s.unlockedIds];
      if (!Array.isArray(s.chat) || !s.chat.length) {
        s.chat = [{ who: 'pet', text: PERS[s.active]?.hi || PERS.spud.hi }];
      }
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
  return s;
}

export function save(s) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...s, chat: s.chat.slice(-40), journal: s.journal.slice(-60) })
    );
  } catch (e) {}
}

export function reset() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {}
}

export function counts(s) {
  return {
    cards: s.cards.length,
    favs: s.cards.filter((c) => c.fav).length,
    chats: s.journal.length,
    streak: s.streak,
    golden: s.cards.filter((c) => c.rare).length,
  };
}
