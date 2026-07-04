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
    s.drawn = false;
    s.rare = false;
    s.msg = '';
    s.keptToday = false;
  }
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

export function counts(s) {
  return {
    cards: s.cards.length,
    favs: s.cards.filter((c) => c.fav).length,
    chats: s.journal.length,
    streak: s.streak,
    golden: s.cards.filter((c) => c.rare).length,
  };
}
