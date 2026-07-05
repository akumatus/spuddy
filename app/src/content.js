// All written content and rules come from the Claude Design prototype
// (claude-design/project/Positive Potato 桌宠原型.dc.html) — keep in sync with it.

// Daily draw pool — always offline-safe (drawn by day index, never the LLM).
// The first 10 come from the design prototype; the rest are app-side additions
// so there's real variety before the cycle repeats. Keep the count coprime with
// 7 (see the `state.day * 7` index in main.js) so every line gets visited.
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
  { m: 'You are allowed to take up space today.', t: 'w' },
  { m: 'Unclench your jaw. Drop your shoulders. There — better.', t: 'f' },
  { m: "You can't pour from an empty spud. Refill first.", t: 'f' },
  { m: "Progress hides in boring days. You're making some.", t: 'w' },
  { m: 'One thing at a time. Then the next thing.', t: 'w' },
  { m: 'Being gentle with yourself counts as an accomplishment.', t: 'w' },
  { m: "You've handled every 'too much' so far. Still here.", t: 'f' },
  { m: 'The bad mood is weather, not climate. It passes.', t: 'w' },
  { m: "You don't need to earn your rest. Take it.", t: 'f' },
  { m: 'Comparison is a thief. Lock the door on it.', t: 'w' },
  { m: 'Half-done is still further than not-started.', t: 'w' },
  { m: "Breathe in for four. Out for four. I'll wait.", t: 'f' },
  { m: 'Good enough today is genuinely good enough.', t: 'w' },
  { m: "Your worth isn't a to-do list. It never was.", t: 'w' },
  { m: "Somebody's day gets warmer just because you exist.", t: 'f' },
  { m: "You're doing better than the voice in your head says.", t: 'w' },
  { m: "Tiny wins are still wins. I'm counting them.", t: 'f' },
  { m: 'You can start over at any hour. Even this one.', t: 'w' },
  { m: 'Soft days are for growing roots, not showing bloom.', t: 'w' },
  { m: "Whatever happened, you're still 100% potato.", t: 'f' },
  { m: "Plot twist: you're the main character. Act like it.", t: 'w' },
  { m: "You're not behind. You're on your own timeline. It's fashionable.", t: 'w' },
  { m: 'Even a couch potato is still a potato with dreams.', t: 'f' },
  { m: "You've survived every Monday so far. Basically a superhero.", t: 'f' },
  { m: "Perfectionism called. I hung up. You're welcome.", t: 'f' },
  { m: 'Water. Snack. Deep breath. In that order. Go.', t: 'f' },
  { m: 'You are allowed to be a work in progress and a masterpiece at once.', t: 'w' },
  { m: 'Bad day? Same you, fresh potato tomorrow.', t: 'f' },
  { m: "The to-do list survives one nap. I've tested this personally.", t: 'f' },
  { m: 'You bring something no algorithm can replace. Weird, warm you.', t: 'w' },
  { m: 'Growth is quiet. Nobody hears a potato getting wiser underground.', t: 'w' },
  { m: "Nobody has it all figured out. We're all just bluffing warmly.", t: 'f' },
  { m: "You got out of bed today. That's a certified boss move.", t: 'f' },
  { m: 'Your feelings are valid. Even the messy 3am ones. Especially those.', t: 'w' },
  { m: 'Confidence is just courage that stayed for breakfast.', t: 'w' },
  { m: "You're doing life for the first time. Cut yourself some slack.", t: 'w' },
  { m: 'A past version of you is so proud you made it here.', t: 'w' },
  { m: "Rest isn't quitting. It's recharging the main character.", t: 'f' },
  { m: 'You are 60% water and 100% doing your best. Great chemistry.', t: 'f' },
  { m: 'Showing up was the brave part. You already did it. Counts.', t: 'w' },
  { m: "You can't ruin a whole day. Reset the moment, not the mood.", t: 'w' },
  { m: "Be the reason you smile. Backup plan: I'm right here.", t: 'f' },
  { m: 'Mistakes mean you tried. Blank pages never got anything right either.', t: 'w' },
  { m: 'You are softer than you think and stronger than you feel.', t: 'w' },
  { m: 'Take the compliment. I said what I said. You are wonderful.', t: 'f' },
  { m: "Slow progress still laps the couch you didn't sit on.", t: 'f' },
  { m: 'Your only job right now is the next small right thing.', t: 'w' },
  { m: 'You matter on the loud days and the quiet ones alike.', t: 'w' },
  { m: "Fun fact: you've never once failed to be enough. Streak intact.", t: 'f' },
  { m: "Tomorrow's a fresh spud. Nothing carries over but the love.", t: 'f' },
];

// Generic golden-tier fallback — the last resort when a golden draw can't reach
// the LLM and the active buddy has no voiced pool below.
export const RARE = [
  "Even mashed, you're still 100% potato. Nothing can un-potato you.",
  'No one claps for roots. Grow anyway — the blooming comes.',
  "You're somebody's reason to keep going. Probably mine.",
  'I stitched this one slow so it holds: you matter on the days you cannot feel it.',
  'Of every card in the basket, this is the one I saved for you.',
  'You have been someone else’s safe place. Today, let this one be yours.',
  "Roots don't get applause. But nothing grows without them — and neither would I.",
  'The world is a little softer with you in it. Truly.',
  "You're not too much and never too little. You're the exact right amount of you.",
  "On the days you can't hold yourself up, let this card do it. That's what it's for.",
  "Someone is quietly grateful you exist and hasn't found the words. So I found them for you.",
  "You've been the strong one so long. Let this card be strong for you today.",
  "Golden isn't rare for being perfect. It's rare for being honest. Like you.",
  'The bravest thing you ever did was keep going quietly. I noticed. I always notice.',
  "You are somebody's favorite plot twist, their comfort, their calm — and likely more than one somebody.",
  'If softness could shield you, this card would. Consider it stitched with intent.',
];

// Per-character golden fallback — when the LLM is unreachable (offline, no key,
// or the request failed), a golden draw still lands in the active buddy's own
// voice instead of the generic pool. App-side safety net, not from the
// prototype; keep each line short (~22 words), no emoji, no quotes, no tag —
// mirroring the ai-golden prompt in electron/main.cjs.
export const GOLDEN = {
  spud: [
    "Friend, you carried a lot today and you're still standing. That's the whole miracle, right there.",
    "No big speech. Just this: I'm glad you're mine to sit beside.",
    'You did the quiet, hard, unseen things today. I saw them. They counted.',
    "Rough day, friend. Doesn't change a thing about how much you're worth.",
    "Steady wins. You've been steady far longer than you give yourself credit for.",
    'Friend, the world got heavier today and you carried your corner of it. Well done.',
    "I don't say this lightly, and I mean it plain: I'm proud of you.",
    "You don't owe anyone a highlight reel. The quiet version of you is my favorite.",
    "Some days you just endure. That's not nothing, friend. That's the whole job, done.",
    "Come sit. Card's warm, you're worn, and both of those are fine. We'll rest together.",
  ],
  taco: [
    'listen. you are a fully loaded, extra-everything, absolute FEAST of a human. no notes.',
    'the world tried it today and you handled it. spicy. iconic. proud of you.',
    "you're the best thing on the whole menu and i will fight anyone who disagrees.",
    "okay hear me out — you're doing amazing and you deserve a snack and a nap.",
    "crunchy outside, pure soft heart inside. that's you. that's my favorite recipe.",
    "you? a snack. a meal. an entire buffet of a person. i'm not calm about it.",
    'bad day tried to cancel you and the reservation did NOT go through. still fully booked.',
    "you're doing the thing! badly? maybe! doing it?? ABSOLUTELY. that's the whole recipe, chef.",
    'warning: contents of this human are extremely precious. handle you with snacks and naps.',
    'i believe in you like i believe in second helpings. loudly, with my whole gremlin heart.',
  ],
  donut: [
    "hush now, sugar — that mean little voice doesn't know you like i do.",
    'sweetheart, you glazed your way through a hard day. keeping this card just for you. hee.',
    'honeybun, whoever made you doubt yourself was wrong. i have receipts. so many receipts.',
    "you're sweeter than you let on, sugar, and softer than you'll admit. i adore that.",
    'come here, love. you did enough. you are enough. let me say it twice — enough.',
    "sugar, if the world had eyes it'd see what i see: something rare and worth every fuss.",
    'that inner critic? not invited to the party, honeybun. hee. only nice things about you here.',
    'you deserve the soft life, love — the good coffee, the long hug, the card that says stay.',
    'oh sweetheart, look at you: still standing, still shining. i could just frost you with compliments.',
    "come closer, sugarplum. whatever they said, you're the sweetest thing on my whole shelf.",
  ],
  bloom: [
    'you grew today even where no one could see. roots do their quiet work first.',
    'some seasons are for resting in dark soil. this is one. rest, and trust it.',
    "you don't have to flower to be worth the water. you never did.",
    'small green thing, still reaching for light — that is the bravest kind of growing.',
    "i watered a little hope for you this morning. it's taking. so are you.",
    'even the slowest bloom is still blooming. you have not missed your season.',
    'the storm passed through and you are still rooted. that is its own kind of strong.',
    'rest, little seed. the growing happens in the dark, when you least feel it.',
    'you do not have to be in full flower to be worth the whole garden.',
    'i planted a little patience for you. water it gently. so much is already on its way.',
  ],
  leo: [
    'Lionheart. The fear you felt today was proof it mattered. You showed up anyway. That is courage.',
    "Chin up, champion. You wrestled the hard thing and you're still standing. Again tomorrow.",
    "You are braver than the story you tell yourself. I've watched you prove it.",
    "One more round, lionheart — not because it's easy, but because you don't quit.",
    "They'll underestimate you. Let them. Then go be exactly as strong as you are.",
    "Stand tall, champion. Today asked for courage and you found some. That's what winning looks like.",
    "You didn't back down. You shook, maybe, but you stayed. That's the definition of brave, lionheart.",
    'Fear showed up? Good. It only guards the things worth having. March past it. Again.',
    'You are not behind, champion. You are mid-comeback — the best part of every story.',
    'Rest is training too, lionheart. Even the strongest heart needs a quiet round. Take it.',
  ],
  grad: [
    'Per my unpublished research, you are doing far better than your internal reviewer claims.',
    'Findings, conclusive: perfectionism is a poor supervisor. I recommend you fire it. Effective today.',
    'A long view, from an old potato: this hard week will not make the final draft of you.',
    'The data is in. Against considerable resistance, you are still growing. Remarkable. Keep it up.',
    'My professional opinion, tenure and all: rest is not the opposite of progress. Class dismissed.',
    'Peer-reviewed conclusion: you are enough. Sample size of one. It was you. Deeply compelling.',
    'Correlation observed: you rest, you thrive. Causation suspected. Further research encouraged. Begin the nap immediately.',
    'In the long record of your bad days, the survival rate holds at a flawless one hundred percent.',
    'I have tenure and one firm opinion: be kinder to yourself. The evidence overwhelmingly supports it.',
    'Hypothesis: today felt impossible. Result: you are reading this. Conclusion: you did the impossible again. Noted.',
  ],
};

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Golden card text for when the LLM is unavailable: the active buddy's voiced
// pool if there is one, otherwise the generic RARE lines.
export function goldenFallback(charId) {
  const pool = GOLDEN[charId];
  return pickOne(pool && pool.length ? pool : RARE);
}

export const POKE = [
  'boing!',
  'hehe. again.',
  "I'm 90% stuffing, 10% courage.",
  'careful — I bruise emotionally.',
  '*wiggles menacingly*',
  'all of me is the soft spot.',
];

// Body-poke flavor after you've already drawn — nudges toward another pull now
// that draws are unlimited and random (was "one card a day" copy).
export const RETAP = [
  "psst — the card's got more where that came from. tap away.",
  "another one? i've got a whole basket. help yourself.",
  "the good ones don't run out. tap the card again, go on.",
  "oh, you want seconds? i love that about you. tap away.",
  "infinite pep, one tap at a time. i don't tire. do you?",
  "there's always another card. the potato provides.",
];

// Bubble shown when a normal (non-golden) card is revealed — random each draw.
export const DRAWLINES = [
  "here's one, fresh off the vine.",
  "ta-da. this one found you.",
  "picked this one just for now — it's yours.",
  "fresh card, still warm. here.",
  "ooh, nice pull. keep it, or tap for another.",
  "this one had your name on it.",
];

// app-specific: the popup only opens from the card itself, so body pokes
// sometimes point at it when today's draw is still waiting
export const CARDHINT = "today's card is ready — the white one. give it a tap. ♥";

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

// Generic chat fallback — the last resort when the LLM can't be reached.
export const FALLBACK_REPLY = "mm — I'm listening. tell me a bit more?";

// Per-character chat fallback — when the LLM is unreachable, the pet can't
// actually respond to what was said, so these are warm in-voice "I'm here,
// keep going" lines that fit any message without pretending to understand it.
// App-side safety net; picked at random, mirrors goldenFallback above.
export const CHAT_FALLBACK = {
  spud: [
    "mm. i'm here, friend. i'm listening — tell me a little more?",
    "i hear you. take your time; i've got nowhere else to be.",
    "that lands with me, friend. say more when you're ready.",
    "i'm right here with you. no rush, no fixing — just here.",
    "noted, and held. keep going, friend — i'm all ears.",
  ],
  taco: [
    "ok i'm LISTENING listening. spill it, i've got snacks and full attention.",
    "tell me everything, i'm basically a very supportive burrito right now.",
    "mmhm mmhm keep going — you've got my whole crunchy little heart here.",
    "i'm nodding so hard. lay it on me, friend, all of it.",
    "ooh, a feelings buffet? load me up. i'm here for every bite.",
  ],
  donut: [
    "aw, i'm listening, sugar. go on, tell me what's on that sweet mind.",
    "mm-hm, honeybun, i'm right here. let it all out, no judgment. hee.",
    "talk to me, love. i've got all the time in the world for you.",
    "keep going, sweetheart. every word of yours is worth hearing.",
    "i'm here, sugarplum. tell me more — i'm hanging on every bit.",
  ],
  bloom: [
    "i'm here. say it slowly, like watering. i'm listening.",
    "mm. let it out, little one. i have all the quiet you need.",
    "i hear you. no need to say it perfectly — just let it grow.",
    "keep going, softly. i'm rooted right here beside you.",
    "tell me more. some things need saying twice; i won't mind.",
  ],
  leo: [
    "i'm listening, lionheart. say it plain — i'm right here in your corner.",
    "go on, champion. whatever it is, you don't carry it alone.",
    "i've got your back. tell me more — i'm not going anywhere.",
    "speak, brave heart. i'm here for every word of it.",
    "lay it down, champion. i'm listening, and i'm on your side.",
  ],
  grad: [
    "i'm listening — with, i'll note, my full and undivided attention. go on.",
    "mm. tell me more. my research improves considerably with additional data.",
    "noted for the record. continue; i find this genuinely worth my time.",
    "i'm here, and i'm paying attention. that is the whole syllabus today.",
    "say more. per long observation, most things feel lighter once said aloud.",
  ],
};

// Chat reply for when the LLM is unavailable: the active buddy's voiced pool if
// there is one, otherwise the generic FALLBACK_REPLY.
export function chatFallback(charId) {
  const pool = CHAT_FALLBACK[charId];
  return pickOne(pool && pool.length ? pool : [FALLBACK_REPLY]);
}

// Shown when the day's real-time chat budget is spent (server returns 429). The
// server meters live replies to keep the shared API bill in check — these are
// warm, in-voice "let's pick this up tomorrow" lines so the cap never feels
// like an error. He'll still draw cards; only the live back-and-forth rests.
export const CHAT_LIMIT = {
  spud: "we've done a lot of good talking today, friend. i'm here — let's pick this back up tomorrow.",
  taco: "ok my little brain is FULL of feelings for one day. same time tomorrow? i'll bring snacks.",
  donut: "sugar, i've been chatting my glaze off — let me rest my sprinkles and we'll talk more tomorrow, hm?",
  bloom: "we've watered enough words today. let them settle overnight; i'll be right here tomorrow.",
  leo: "great rounds today, champion. even fighters rest — regroup with me tomorrow, i'm in your corner.",
  grad: "per my notes, we've reached today's word quota. the research resumes tomorrow. class dismissed, warmly.",
};

// Limit line for the active buddy, falling back to the steady friend's.
export function limitReply(charId) {
  return CHAT_LIMIT[charId] || CHAT_LIMIT.spud;
}
