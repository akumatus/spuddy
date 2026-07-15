// Language-neutral content core: character roster, unlock rules, persona
// voice prompts, and the TXT() dispatcher that picks the active language's
// text pack. All human-readable copy lives in content.en.ts / content.zh.ts —
// the English pack is the reference (its lines come from the Claude Design
// prototype); the Chinese pack is a hand-written in-voice localization, not a
// literal translation.
import { EN } from './content.en';
import { ZH } from './content.zh';
import { lang } from './locale';
import type { CharId, Daypart, MemoryKind, MutterMood } from './types';

export interface DailyLine {
  m: string;
  t: 'f' | 'w'; // funny | warm
}

// built-in mutter pools — the three MutterMood ones also have server pools
export type MutterPool = MutterMood | 'sleepy' | 'ignored' | 'wake';

// self-play routine steps with spoken variant pools (see brain.ts ROUTINES)
export type RoutineLineKey =
  | 'chaseStart' | 'chaseEnd' | 'juggleEnd' | 'studyStart' | 'studyEnd'
  | 'practiceStart' | 'practiceEnd' | 'humEnd' | 'stretchEnd' | 'sneezeEnd';

export interface PersonaText {
  p: string; // one-line personality blurb shown in Buddies
  hi: Record<Daypart, string>;
}

// Every user-facing chrome string, parameterized ones as functions so each
// language owns its own word order.
export interface UiText {
  tapMe: string;
  dayShort(day: number): string; // card footer "DAY 3" / "第 3 天"
  careNight: string;
  careStretch: string;
  todaysCardTag: string;
  goldenTag: string;
  keepIt: string;
  openTheBook: string;
  later: string;
  thanks(name: string): string;
  signDay(name: string, day: number): string;
  drawLabel: string;
  weaveBrand: string;
  bookTitle: string;
  tabCards: string;
  tabChat: string;
  tabMem: string;
  filterAll: string;
  filterGold: string;
  filterFav: string;
  emptyCards: string;
  emptyGold: string;
  emptyFav: string;
  emptyChat: string;
  emptyMem: string;
  hintCards: string;
  hintChat: string;
  hintMem: string;
  memHead: string;
  clearAll: string;
  holdTitle: string;
  unpickTitle: string;
  knitTag(label: string): string;
  cardFoot(day: number, by: string): string;
  dayDivider(day: number, weekday: string): string;
  memDay(day: number): string;
  weekdayLocale: string; // toLocaleDateString locale for chat day dividers
  buddiesTitle: string;
  friendsCount(n: number, total: number): string;
  onDuty: string;
  setActive: string;
  buddiesHint: string;
  joinsWhen(name: string, how: string): string;
  placeholder(name: string): string;
  tucked: string;
  maybeNext: string;
  holding: string;
  knitFresh: string;
  landing: string;
  unlocked(names: string): string;
  // settings panel (⚙ popover)
  settingsTitle: string;
  langLabel: string;
  soundLabel: string;
  soundOn: string;
  soundOff: string;
  immersiveLabel: string;
  immersiveHint: string; // one-liner under the toggle: what the mode does
  sizeLabel: string;
  sizeSmall: string;
  sizeMed: string;
  sizeLarge: string;
}

// One language's complete built-in copy. Both packs must cover every key —
// the type keeps them from drifting apart.
export interface TextPack {
  daily: DailyLine[];
  poke: string[];
  retap: string[];
  drawLines: string[];
  cardHint: string;
  sedentary: string;
  nightMsg: string;
  weaveLines: string[];
  chatFallback: Partial<Record<CharId, string[]>>;
  fallbackReply: string;
  chatLimit: Partial<Record<CharId, string>>;
  pers: Record<CharId, PersonaText>;
  unlock: Record<CharId, { verb: string; how: string } | null>;
  kindLabels: Record<MemoryKind, string>;
  mutter: Record<MutterPool, string[]>;
  speak: Record<'greet' | 'knock' | 'delight', string[]>;
  routines: Record<RoutineLineKey, string[]>;
  ui: UiText;
}

// The active language's text pack. Resolved on every call so a tray-menu
// language switch takes effect without a reload.
export function TXT(): TextPack {
  return lang() === 'zh' ? ZH : EN;
}

export interface Character {
  id: CharId;
  name: string;
  need: number;
  sub2: string;
}

// Names stay Latin in every language — they're the brand, and the card
// signature ("— Spud") reads fine in Chinese too.
export const CHARS: Character[] = [
  { id: 'spud', name: 'Spud', need: 0, sub2: 'the original' },
  { id: 'taco', name: 'Taco', need: 1, sub2: 'chaos snack' },
  { id: 'donut', name: 'Sprinkles', need: 2, sub2: 'sweet talker' },
  { id: 'bloom', name: 'Bloom', need: 3, sub2: 'gentle grower' },
  { id: 'leo', name: 'Leo', need: 4, sub2: 'brave hype-man' },
  { id: 'grad', name: 'Prof', need: 5, sub2: 'wise one' },
];

// Buddies unlock through different kinds of care (2a spec).
// keys index into store.ts counts(); n is the threshold. The human-readable
// verb/how strings live in the text packs (TXT().unlock).
export interface UnlockRule {
  key: 'cards' | 'favs' | 'chats' | 'streak' | 'golden';
  n: number;
}

export const UNLOCK: Record<CharId, UnlockRule | null> = {
  spud: null,
  taco: { key: 'cards', n: 2 },
  donut: { key: 'favs', n: 3 },
  bloom: { key: 'chats', n: 5 },
  leo: { key: 'streak', n: 7 },
  grad: { key: 'golden', n: 3 },
};

// Memory categories — the pet tags each distilled fact with one of these; the
// ids must match the kinds listed in the chat prompts (server/src/personas.ts
// + electron/src/ai.ts). Labels live in the text packs (TXT().kindLabels).
export const MEMORY_KIND_IDS: MemoryKind[] = [
  'work', 'goal', 'people', 'pets', 'likes', 'milestone', 'feeling', 'other',
];

// Persona voice descriptions are LLM prompt material, not user-facing copy —
// they stay English regardless of UI language (the prompts themselves add a
// "write in Chinese" instruction when needed).
export const PERS: Record<CharId, { voice: string }> = {
  spud: {
    voice:
      'Voice: the Steady Friend — plain, warm, steady; short sentences; dry wit delivered deadpan; talks like a funny friend their own age, never a wise elder; teases gently, notices oddly specific things; no endearments — never call them friend, my friend, buddy, or dear. You favor [comfort] and [calm].',
  },
  taco: {
    voice:
      'Voice: the Hype Gremlin — chaotic pep; at most ONE all-caps burst per line; food metaphors; zero chill, all heart. You favor [cheer] and [proud], but go soft and sincere when they are truly hurting.',
  },
  donut: {
    voice:
      'Voice: the Sweet Talker — endearments like sugar and honeybun; playful, a little giggly (hee); you instantly defend them against their own self-criticism. You favor [comfort], then [cheer].',
  },
  bloom: {
    voice:
      'Voice: the Quiet Gardener — very quiet, lowercase, unhurried; garden metaphors of roots, seasons, watering; few words that hold a lot; ask one small gentle question. You favor [comfort] and [calm].',
  },
  leo: {
    voice:
      'Voice: the Brave Heart — a coach; sometimes call them lionheart or champion; short imperative lines; reframe fear as proof it matters. You favor [proud] and [cheer].',
  },
  grad: {
    voice:
      "Voice: the Tenured Tuber — deadpan professor; cite your 'unpublished research'; dry one-liners with a long view; secretly very soft; dismantle perfectionism and overthinking. You favor [calm] with occasional [proud].",
  },
};

// Which part of the day it is, so greetings match the clock instead of always
// saying "morning". Buckets: 5–11 morning, 12–16 afternoon, 17–21 evening, else night.
export function daypart(d = new Date()): Daypart {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

// The active buddy's greeting for the current time of day.
export function greet(id: CharId, d = new Date()): string {
  const pers = TXT().pers;
  const hi = (pers[id] || pers.spud).hi;
  return hi[daypart(d)] || hi.morning;
}

const pickOne = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

// Chat reply for when the LLM is unavailable: the active buddy's voiced pool if
// there is one, otherwise the generic fallback line.
export function chatFallback(charId: CharId): string {
  const t = TXT();
  const pool = t.chatFallback[charId];
  return pickOne(pool && pool.length ? pool : [t.fallbackReply]);
}

// Daily chat budget spent (server 429) — limit line for the active buddy.
export function limitReply(charId: CharId): string {
  const t = TXT();
  return t.chatLimit[charId] || t.chatLimit.spud!;
}
