// All written content and rules come from the Claude Design prototype
// (claude-design/project/Positive Potato 桌宠原型.dc.html) — keep in sync with it.

export const DAILY = [
  { m: "You've survived 100% of your bad days. Undefeated, actually.", t: 'f' },
  { m: 'Small steps still count. Even tiny potato steps.', t: 'w' },
  { m: "Drink some water. You're a fancy plant with feelings.", t: 'f' },
  { m: "It's okay to do it badly first. That's called learning.", t: 'w' },
  { m: 'Rest is productive. Signed, a potato.', t: 'f' },
  { m: "You don't have to bloom today. Just stay rooted.", t: 'w' },
  { m: 'Done beats perfect. Perfect never ships.', t: 'f' },
  { m: 'Someone smiles when your name comes up. Promise.', t: 'w' },
  { m: 'Your pace is a real pace.', t: 'w' },
  { m: 'Feelings are visitors. Tea, then they go.', t: 'w' },
];

export const RARE = [
  "Even mashed, you're still 100% potato. Nothing can un-potato you.",
  'No one claps for roots. Grow anyway — the blooming comes.',
  "You're somebody's reason to keep going. Probably mine.",
];

export const POKE = [
  'boing!',
  'hehe. again.',
  "I'm 90% stuffing, 10% courage.",
  'careful — I bruise emotionally.',
  '*wiggles menacingly*',
  'all of me is the soft spot.',
];

export const RETAP = [
  "Same card till tomorrow — them's the rules.",
  'I only bake one truth a day.',
  'Save some wisdom for tomorrow, eh?',
];

export const SEDENTARY = '90 minutes in that chair! Even potatoes roll over sometimes. Stretch with me?';
export const NIGHTMSG = "It's past 11. The world can wait till morning. Sleep, dear human.";

export const WEAVELINES = [
  'knitting a card just for you…',
  'picking the right words…',
  'tying the golden knot…',
];

export const CHARS = [
  { id: 'spud', name: 'Spud', need: 0, sub2: 'the original' },
  { id: 'taco', name: 'Taco', need: 1, sub2: 'chaos snack' },
  { id: 'donut', name: 'Sprinkles', need: 2, sub2: 'sweet talker' },
  { id: 'bloom', name: 'Bloom', need: 3, sub2: 'gentle grower' },
  { id: 'leo', name: 'Leo', need: 4, sub2: 'brave hype-man' },
  { id: 'grad', name: 'Prof', need: 5, sub2: 'wise one' },
];

// Buddies unlock through different kinds of care (2a spec)
export const UNLOCK = {
  spud: null,
  taco: { key: 'cards', n: 2, verb: 'cards kept', how: 'keep 2 cards' },
  donut: { key: 'favs', n: 3, verb: 'favorites', how: 'mark 3 favorites in the Book' },
  bloom: { key: 'chats', n: 5, verb: 'heart-to-hearts', how: 'tell him 5 things' },
  leo: { key: 'streak', n: 7, verb: 'day streak', how: 'reach a 7-day streak' },
  grad: { key: 'golden', n: 3, verb: 'golden cards', how: 'keep 3 golden cards' },
};

export const PERS = {
  spud: {
    p: 'warm & steady',
    hi: "Morning, friend. Card's warm — tap me.",
    voice:
      'Voice: the Steady Friend — plain, warm, steady; short sentences; dry gentle humor; you call them friend; never dramatic, always there. You favor [comfort] and [calm].',
  },
  taco: {
    p: 'unhinged pep',
    hi: 'GOOD MORNING. ok, that was loud. hi. tap me?',
    voice:
      'Voice: the Hype Gremlin — chaotic pep; at most ONE all-caps burst per line; food metaphors; zero chill, all heart. You favor [cheer] and [proud], but go soft and sincere when they are truly hurting.',
  },
  donut: {
    p: 'sugar rush',
    hi: 'morning, sugar! got something sweet for you.',
    voice:
      'Voice: the Sweet Talker — endearments like sugar and honeybun; playful, a little giggly (hee); you instantly defend them against their own self-criticism. You favor [comfort], then [cheer].',
  },
  bloom: {
    p: 'soft nurture',
    hi: 'good morning. the flowers asked about you.',
    voice:
      'Voice: the Quiet Gardener — very quiet, lowercase, unhurried; garden metaphors of roots, seasons, watering; few words that hold a lot; ask one small gentle question. You favor [comfort] and [calm].',
  },
  leo: {
    p: 'loud courage',
    hi: "MORNING, LIONHEART. today's card is brave.",
    voice:
      'Voice: the Brave Heart — a coach; call them lionheart or champion; short imperative lines; reframe fear as proof it matters. You favor [proud] and [cheer].',
  },
  grad: {
    p: 'dry wisdom',
    hi: "ah, awake. per my research, you'll want today's card.",
    voice:
      "Voice: the Tenured Tuber — deadpan professor; cite your 'unpublished research'; dry one-liners with a long view; secretly very soft; dismantle perfectionism and overthinking. You favor [calm] with occasional [proud].",
  },
};

export const FALLBACK_REPLY = "mm — I'm listening. tell me a bit more?";
