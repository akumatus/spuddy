import { PetScene } from './scene.js';
import { SpudBrain, routineMs } from './brain.js';
import { CLIPS, WOBBLE } from './motions.js';
import { sfx, setSoundEnabled } from './sfx.js';
import * as store from './store.js';
import * as ui from './ui.js';
import * as remote from './remote.js';
import {
  DAILY, POKE, RETAP, CARDHINT, SEDENTARY, NIGHTMSG, WEAVELINES, DRAWLINES,
  CHARS, UNLOCK, PERS, greet, daypart, chatFallback, goldenFallback, limitReply,
  MEMORY_KIND_IDS,
} from './content.js';

const $ = (id) => document.getElementById(id);
const pp = window.pp; // preload bridge

let state = store.load();
// dev: PP_DEBUG=1 unlocks the whole crew so you can switch characters and test
// them without grinding each unlock condition
if (pp?.debug) state.unlockedIds = CHARS.map((c) => c.id);
let bookTab = 'cards';
let bookFilter = 'all';
let chatBusy = false;
const chatPending = []; // notes fired while he's mid-reply — answered next, never dropped
let weaving = false;
let retapIdx = 0;
let bubbleTimer = null;
let typeTimer = null;
let mutterTimer = null;
let bubbleHover = false; // pointer resting on the reply — freeze its auto-hide
let bubbleHold = 0; // full lifespan of the current bubble, so hover can resume it
let mutterHover = false; // pointer resting on the thought card — freeze its auto-hide
let mutterHold = 0; // lifespan of the current mutter, so hover can resume it

setSoundEnabled(state.sound);

const scene = new PetScene($('pet'));
await scene.setCharacter(state.active);
const anim = () => scene.animator;

// pull today's server-generated card pool (non-blocking — draws fall back to the
// built-in DAILY pool until it arrives), then re-poll hourly: the pet runs for
// days on end, and without this the "daily" pool would only ever change on app
// restart (the cron flips it at midnight Asia/Shanghai)
remote.refresh();
setInterval(() => remote.refresh(), 60 * 60 * 1000);

// ── personality engine (7a) — needs-driven autonomy, ported from lib/spud-brain.js ──
const per = state.personality || {};
const brain = new SpudBrain({
  animator: anim(),
  personality: {
    curious: (per.curiosity ?? 65) / 100,
    clingy: (per.clinginess ?? 60) / 100,
    drama: (per.drama ?? 55) / 100,
    sleepy: (per.sleepiness ?? 35) / 100,
  },
  // no decisions while you're actually using him (chat, book, weave) or he's
  // napping against a screen edge
  canAct: () =>
    !anim().tucked && !anim().asleep && !ui.isOverlayOpen() && !chatBusy && !weaving &&
    document.visibilityState !== 'hidden' && document.activeElement !== $('chatInput'),
  // fresh daily mutters (pre-generated server-side, no real-time LLM); ~half of
  // idle mutters come from today's batch, the rest from the built-in lines
  serverMutters: (mood) => remote.mutterPool(activeChar().id, mood),
  mutterFreshChance: 0.5,
  on: {
    mutter: (text) => showMutter(text),
    speak: (text, ms) => bubble(text, { hold: ms }),
    emote: (g) => spawnEmote(g),
    sfx: (n) => sfx[n] && sfx[n](),
    state: (key, zh) => { if (pp.debug) console.log('[brain]', key, zh); },
    log: (e) => { if (pp.debug) console.log('[brain]', e.kind, e.text); },
  },
});

function persist() {
  store.save(state);
  checkUnlocks();
  $('buddiesDot').classList.toggle('hidden', !state.buddyNew);
}

// mini card on the model — mirrors the design's rMiniVals
function updateCardScreen() {
  if (chatBusy) {
    scene.setCardContent({ top: '', main: '. . .' });
  } else if (state.drawn && state.msg) {
    scene.setCardContent({
      top: state.rare ? '✦ · ✦ · ✦' : '· · ♥ · ·',
      gold: state.rare,
      main: state.msg,
      footL: `DAY ${state.day}`,
      footR: `— ${activeChar().name}`,
    });
  } else {
    scene.setCardContent({ top: '· ♥ ·', main: 'tap me :)' });
  }
}

function activeChar() {
  return CHARS.find((c) => c.id === state.active) || CHARS[0];
}

// ── bubble ──
function bubble(text, { hold = 2600, type = false } = {}) {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('mutter').classList.add('hidden'); // speak outranks the inner monologue
  const el = $('bubble');
  el.classList.remove('hidden');
  if (!type) {
    el.textContent = text;
  } else {
    let i = 0;
    el.textContent = '';
    typeTimer = setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length + 1) clearInterval(typeTimer);
    }, 30);
  }
  bubbleHold = hold ? hold + (type ? text.length * 15 : 0) : 0;
  // while the pointer rests on the reply we leave it up — hoverEnd resumes the countdown
  if (bubbleHold && !bubbleHover) bubbleTimer = setTimeout(() => el.classList.add('hidden'), bubbleHold);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('bubble').classList.add('hidden');
}

// Reading a reply shouldn't race a timer: hovering the bubble freezes its
// auto-hide, and pulling the pointer away lets it linger a beat, then go.
function setBubbleHover(on) {
  if (on === bubbleHover) return;
  bubbleHover = on;
  const el = $('bubble');
  if (el.classList.contains('hidden') || !bubbleHold) return;
  clearTimeout(bubbleTimer);
  if (!on) bubbleTimer = setTimeout(() => el.classList.add('hidden'), 700);
}

// ── mutter — dashed thought bubble for the inner monologue (7a) ──
function showMutter(text) {
  if (anim().tucked || anim().asleep || ui.isOverlayOpen() || chatBusy || weaving) return;
  if (!$('bubble').classList.contains('hidden')) return; // speech first
  const el = $('mutter');
  clearTimeout(mutterTimer);
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth; // restart the pop-in
  el.style.animation = '';
  mutterHold = 2300 + text.length * 40;
  // like the reply bubble, resting the pointer on the thought card freezes its auto-hide
  if (!mutterHover) mutterTimer = setTimeout(() => el.classList.add('hidden'), mutterHold);
}

// Hovering the thought card freezes its auto-hide the same way the reply bubble
// does; pulling the pointer away lets it linger a beat, then go.
function setMutterHover(on) {
  if (on === mutterHover) return;
  mutterHover = on;
  const el = $('mutter');
  if (el.classList.contains('hidden') || !mutterHold) return;
  clearTimeout(mutterTimer);
  if (!on) mutterTimer = setTimeout(() => el.classList.add('hidden'), 700);
}

// ── floating emotes (♪ ♥ Z) drifting off his head (7a) ──
function spawnEmote(g) {
  if (anim().tucked || anim().asleep || document.visibilityState === 'hidden') return;
  const el = document.createElement('span');
  el.className = 'em';
  el.textContent = g === 'z' ? 'Z' : g;
  el.style.left = `${40 + Math.random() * 22}%`;
  $('emotes').appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

// ── unlocks (2a rules) ──
function checkUnlocks() {
  const cts = store.counts(state);
  const newly = CHARS.filter((ch) => {
    const d = UNLOCK[ch.id];
    return d && !state.unlockedIds.includes(ch.id) && cts[d.key] >= d.n;
  });
  if (!newly.length) return;
  state.unlockedIds = state.unlockedIds.concat(newly.map((c) => c.id));
  state.buddyNew = true;
  sfx.chime();
  anim().playCheer();
  ui.confettiBurst();
  bubble(`Unlocked: ${newly.map((c) => c.name).join(' & ')}! Say hi in Buddies.`, { hold: 4200 });
  store.save(state);
  $('buddiesDot').classList.remove('hidden');
}

// ── emotion tags drive the body (trigger map) ──
function reactEmotion(tag) {
  if (tag === 'cheer') { sfx.chime(); anim().playCheer(); }
  else if (tag === 'proud') { sfx.chime(); anim().play('bigSquish'); }
  else if (tag === 'comfort') { sfx.low(); anim().play('comfort'); }
  else { sfx.pop(); anim().play('squish'); }
}

// ── chat gestures: a named action → the clip that acts it out (kept in sync
// with GESTURES in server/src/personas.js and GESTURE_RE in electron/main.cjs) ──
const GESTURE_CLIP = {
  wave: 'wave', hug: 'hug', dance: 'pirouette', spin: 'spin', cheer: 'cheer',
  hop: 'hop', sing: 'sing', stretch: 'stretch', shy: 'shy', peek: 'peek',
  sulk: 'sulk', sneeze: 'sneeze', present: 'present',
};
// which sfx suits a gesture (upbeat ones chime, a hug is soft, the rest pop)
const GESTURE_SFX = { sing: 'chime', dance: 'chime', cheer: 'chime', hop: 'chime', hug: 'low', sulk: 'low' };

// Client-side safety net so "sing me a song" still moves him when the LLM is
// offline / over budget and returned no gesture of its own. Keyword-matched
// against what the human just said.
function detectGesture(text) {
  const t = (text || '').toLowerCase();
  if (/\b(sing|song|serenade|a tune)\b/.test(t)) return 'sing';
  if (/\b(hug|cuddle|hold me|squeeze|embrace)\b/.test(t)) return 'hug';
  if (/\b(dance|boogie|twirl|pirouette)\b/.test(t)) return 'dance';
  if (/\b(spin|turn around)\b/.test(t)) return 'spin';
  if (/\b(wave|say hi|greet)\b/.test(t)) return 'wave';
  if (/\b(jump|hop|bounce)\b/.test(t)) return 'hop';
  if (/\b(stretch|yawn)\b/.test(t)) return 'stretch';
  if (/\b(cheer|celebrate|hooray|hurray|yay|woohoo|party)\b/.test(t)) return 'cheer';
  if (/\b(hide|be shy|peekaboo|peek-?a-?boo)\b/.test(t)) return 'shy';
  return null;
}

// Play a chat reply's body: a specific gesture if one fits, else the emotion clip.
function reactToReply(tag, gesture) {
  const clip = gesture && GESTURE_CLIP[gesture];
  if (!clip) { reactEmotion(tag); return; }
  const s = GESTURE_SFX[gesture] || 'pop';
  if (sfx[s]) sfx[s]();
  anim().play(clip);
}

// ── daily card ──
// Daily draw limit. Left uncapped for now; to throttle, set a concrete number
// (e.g. 3 = the first 3 draws a day give new cards, after that tapping the
// card just reopens the current one).
const DAILY_DRAW_LIMIT = Infinity;

// Golden card (GOLDEN STITCH) chance — with pity / smoothing.
// Pure randomness (fixed probability) is streaky: long droughts, or several
// goldens at once. We smooth it with state.pity ("draws since last golden") —
// each miss ramps the chance up, and hitting a golden resets it to zero.
// Persists across days: a once-a-day user builds up pity over a few days and
// is guaranteed one, naturally recreating the "a golden every few days" rhythm.
// Start 20% + 15% per miss ⇒ guaranteed by the 7th draw; averages ~1 in 2.7 (≈37%).
// Want rarer: lower BASE/RAMP; more generous: raise them. Just after a golden it
// drops back to BASE, so goldens rarely cluster.
const GOLDEN_BASE = 0.20; // starting chance right after a golden
const GOLDEN_RAMP = 0.15; // how much the chance grows per miss

// How often a draw dips into the hand-written built-in DAILY pool when the
// server pool is available. Kept rare: built-ins never refresh, so they'd wear
// out fast — and each one retires permanently once drawn (state.usedBuiltins).
const BUILTIN_CARD_CHANCE = 0.08;

const pickOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

// No-replacement bookkeeping: the per-batch used list resets when a fresh
// daily pool lands (its date stamp changes — including the first fetch).
function syncUsedCards() {
  const d = remote.batchDate();
  if (!state.usedCards || state.usedCards.date !== d) state.usedCards = { date: d, used: [] };
}

function drawToday() {
  state.draws++;
  if (Math.random() < GOLDEN_BASE + GOLDEN_RAMP * state.pity) {
    state.pity = 0;
    return weaveGolden();
  }
  state.pity++;
  // Gacha without replacement: every drawn line is marked and sits out until
  // the day's pool is exhausted (then the marks clear and the pool laps).
  // Built-ins are a rare seasoning and never come back once seen; offline the
  // built-in DAILY pool carries alone.
  syncUsedCards();
  const serverPool = remote.normalPool(activeChar().id);
  const freshBuiltins = DAILY.map((d) => d.m).filter((m) => !state.usedBuiltins.includes(m));
  let msg;
  let fromBuiltin = false;
  if (serverPool) {
    const unseen = serverPool.filter((m) => !state.usedCards.used.includes(m) && m !== state.msg);
    if (freshBuiltins.length && Math.random() < BUILTIN_CARD_CHANCE) {
      msg = pickOf(freshBuiltins);
      fromBuiltin = true;
    } else if (unseen.length) {
      msg = pickOf(unseen);
    } else {
      state.usedCards.used = [];
      const lap = serverPool.filter((m) => m !== state.msg);
      msg = pickOf(lap.length ? lap : serverPool);
    }
  } else if (freshBuiltins.length) {
    const noRepeat = freshBuiltins.filter((m) => m !== state.msg);
    msg = pickOf(noRepeat.length ? noRepeat : freshBuiltins);
    fromBuiltin = true;
  } else {
    // offline with every built-in retired — reruns beat showing nothing
    const all = DAILY.map((d) => d.m).filter((m) => m !== state.msg);
    msg = pickOf(all.length ? all : DAILY.map((d) => d.m));
  }
  if (fromBuiltin) state.usedBuiltins.push(msg);
  else if (serverPool) state.usedCards.used.push(msg);
  sfx.draw();
  ui.showDrawAnim();
  setTimeout(() => {
    state.drawn = true;
    state.rare = false;
    state.msg = msg;
    state.keptToday = false;
    persist();
    updateCardScreen();
    openCard();
    bubble(DRAWLINES[Math.floor(Math.random() * DRAWLINES.length)]);
  }, 1250);
}

async function weaveGolden() {
  if (weaving) return;
  weaving = true;
  brain.interrupt();
  sfx.draw();
  anim().play('bigSquish');
  anim().setMode('rock');
  scene.setCardPulse(true);
  ui.showWeave(WEAVELINES[0]);
  let li = 0;
  const weaveInt = setInterval(() => {
    li = (li + 1) % WEAVELINES.length;
    ui.setWeaveLine(WEAVELINES[li]);
  }, 2400);

  const ch = activeChar();
  const memory = state.memory.slice(-6);
  const [aiMsg] = await Promise.all([
    // .catch → null so a dropped connection can't leave the weave stuck spinning
    pp.ai.golden({ charId: ch.id, charName: ch.name, voice: PERS[ch.id].voice, memory }).catch(() => null),
    new Promise((r) => setTimeout(r, 1800)),
  ]);
  clearInterval(weaveInt);
  weaving = false;
  anim().setMode('idle');
  scene.setCardPulse(false);
  sfx.chime();
  state.drawn = true;
  state.rare = true;
  // personalized weave first; if it couldn't reach the LLM (offline or over the
  // daily budget), fall back 50/50 between today's server golden pool and the
  // hand-written voiced pool — the built-ins are strong, keep them in rotation
  const gPool = remote.goldenPool(ch.id);
  const gFallback = gPool && Math.random() < 0.5
    ? gPool[Math.floor(Math.random() * gPool.length)]
    : goldenFallback(ch.id);
  state.msg = aiMsg || gFallback;
  state.keptToday = false;
  persist();
  updateCardScreen();
  openCard();
  bubble('Knit fresh, just for you.');
}

function openCard() {
  scene.raiseCard(); // rig models play 'present', legacy 'raise' + quad slide
  ui.showCard(state, {
    onKeep: () => {
      if (state.keptToday) {
        sfx.pop();
        openBook('cards');
        return;
      }
      sfx.pop();
      state.cards.push({ m: state.msg, rare: state.rare, day: state.day, by: activeChar().name });
      state.keptToday = true;
      persist();
      ui.closeOverlay();
      bubble('Tucked into the Book. ♥');
    },
    onLater: () => {
      ui.closeOverlay();
      bubble("I'll hold onto it. Tap me anytime.");
    },
  });
}

// ── tap / poke ──
// Tap reaction pool: each tap plays a random motion (user feedback: a fixed
// squish got monotonous). A '@' prefix = the brain's full mini-skit (multi-step
// sequence + self-talk — tail-chase, hum, card-study…), and those are now the
// star attraction: the user loves the autonomous-personality routines but was
// barely seeing them on tap, so they carry the heaviest weight and a plain body
// tap lands on a skit ~half the time. The basic one-shots are connective tissue
// between skits, not the main event — hop and spin were dialed way down (user
// feedback: "way too many jumps, it gets dull"). squish keeps a moderate weight for the
// signature "squashed" feel; part-rigged models unlock a few more part-specific
// motions. The last two motions are excluded from the pool — any run of 3 taps
// is guaranteed not to repeat (user feedback: a single re-roll still collided
// too often). shy (cover-eyes) was pulled from the pool per the user's request.
// Body taps during a skit's playback are debounced so motions don't stack —
// which also means a launched skit gets watched to the end (per user request).
const TAP_POOL = [
  ['squish', 1.5], ['hop', 0.6], ['wobble', 1], ['peek', 1], ['spin', 0.6],
  ['sneeze', 1.4], ['pirouette', 1],
  ['@chase', 3], ['@hum', 3],
];
const TAP_POOL_RIG = [
  ['eyeroll', 1], ['bounceCard', 1.4], ['wave', 1.2],
  ['@study', 2.6], ['@juggle', 2.4], ['@practice', 2.2],
];
let tapHistory = [];
let tapBusyUntil = 0;

function playTapReaction() {
  const pool = (scene.hasRig() ? TAP_POOL.concat(TAP_POOL_RIG) : TAP_POOL)
    .filter(([k]) => !tapHistory.includes(k));
  let r = Math.random() * pool.reduce((s, [, w]) => s + w, 0);
  let name = pool[0][0];
  for (const [k, w] of pool) { r -= w; if (r <= 0) { name = k; break; } }
  tapHistory = [name, ...tapHistory].slice(0, 2);
  if (name[0] === '@') {
    const key = name.slice(1);
    brain.force(key);
    tapBusyUntil = performance.now() + routineMs(key);
  } else {
    anim().play(name);
    if (name === 'sneeze') sfx.sneeze();
    const clip = name === 'wobble' ? WOBBLE : CLIPS[name];
    tapBusyUntil = performance.now() + (clip ? clip.dur : 700);
  }
  return name;
}

// the card popup only opens from the white card itself (user request);
// body taps are pure play — random reaction, hearts, poke lines
function tapPet(target) {
  // the stage fills a 300×400 rectangle, but only the potato answers: a tap
  // on empty air (raycast hit nothing) is inert — no reaction, no waking, and
  // no need-nudge in the brain — so play tracks his silhouette, not the box.
  if (!target) return;
  if (anim().asleep) {
    wakeFromEdge(); // a tap rouses him from his edge nap
    return;
  }
  if (anim().tucked) {
    sfx.boing();
    anim().setTucked(false);
    $('zz').classList.add('hidden');
    anim().play('squish');
    return;
  }
  // the brain gets first dibs: waking him from a doze / answering his knock
  if (brain.poke()) return;

  if (target === 'card') {
    brain.interrupt(); // the card is functional UI — it always answers
    tapBusyUntil = 0;
    if (chatBusy || weaving || ui.isOverlayOpen()) return;
    if (state.draws < DAILY_DRAW_LIMIT) {
      // still have draw budget (always true when uncapped) → draw a new card; once used up, tapping the card reopens the current one instead
      anim().play('squish'); // the card says "tap me :)" — this is the draw
      return drawToday();
    }
    sfx.pop();
    openCard();
    return;
  }

  // debounce: while a reaction (or a click-launched show) plays, further
  // body taps are swallowed instead of stacking clips on top of each other
  if (performance.now() < tapBusyUntil) return;
  brain.interrupt();
  const name = playTapReaction();
  if (name[0] === '@') return; // the show brings its own lines and sfx
  sfx.boing();
  ui.heartsBurst();
  if (!state.drawn) {
    bubble(Math.random() < 0.5 ? CARDHINT : POKE[Math.floor(Math.random() * POKE.length)]);
  } else if (Math.random() < 0.5) {
    bubble(POKE[Math.floor(Math.random() * POKE.length)]);
  } else {
    bubble(RETAP[retapIdx % RETAP.length]);
    retapIdx++;
  }
}

// ── chat (heart-to-heart) ──
// Sending never blocks: whatever you type goes straight into the transcript and
// a pending queue. If he's already writing, it folds into his next turn instead
// of being dropped — so you can fire off several lines in a row.
function chatSend() {
  const input = $('chatInput');
  const note = (input.value || '').trim();
  if (!note) return;
  sfx.pop();
  brain.interrupt();
  input.value = '';
  const saidEl = $('said');
  saidEl.textContent = `“${note}”`;
  saidEl.classList.remove('hidden');
  hideBubble();

  state.chat.push({ who: 'user', text: note });
  chatPending.push(note);

  if (chatBusy) return; // a reply is already brewing — he'll pick this up next
  runChat();
}

// Long-term memory is now the pet's own distillation, not a filter over raw
// chat: the reply carries an optional `remember` — a durable fact he chose to
// keep about the human, tagged with a category. Store it once, skipping
// near-duplicates (models re-surface the same fact across a conversation).
const normFact = (f) => f.trim().toLowerCase().replace(/[.!?]+$/, '');
function rememberFact(fact, kind) {
  const f = (fact || '').trim();
  if (f.length < 4) return;
  if (state.memory.some((m) => normFact(m.fact) === normFact(f))) return;
  const k = MEMORY_KIND_IDS.includes(kind) ? kind : 'other';
  state.memory.push({ day: state.day, fact: f, kind: k });
}

async function runChat() {
  chatBusy = true;
  anim().setMode('rock'); // 08 · Golden Weave — while AI writes
  scene.setCardPulse(true);
  scene.setCardThinking(true); // animated three dots on the card while he thinks
  updateCardScreen();

  // Answer everything queued so far; anything typed mid-reply loops back around.
  while (chatPending.length) {
    const covered = chatPending.slice(); // the notes this reply speaks to
    const ch = activeChar();
    const res = await pp.ai.reply({
      charId: ch.id,
      charName: ch.name,
      voice: PERS[ch.id].voice,
      day: state.day,
      memory: state.memory.slice(-10),
      messages: state.chat.slice(-12),
    }).catch(() => null); // dropped connection → fall back instead of hanging chatBusy
    chatPending.splice(0, covered.length); // clear what he just answered; keep mid-flight arrivals

    let tag = 'calm';
    let gesture = null;
    let reply = chatFallback(ch.id);
    if (res && res.limited) {
      // daily real-time budget spent — warm "let's pick this up tomorrow" line
      reply = limitReply(ch.id);
    } else if (res && res.text) {
      tag = res.tag || 'calm';
      gesture = res.gesture || null;
      reply = res.text;
    }
    // let the LLM lead; fall back to a keyword read of what they asked for so
    // "sing me a song" still lands even offline / over budget
    if (!gesture) gesture = detectGesture(covered.join(' '));
    reactToReply(tag, gesture);
    state.chat.push({ who: 'pet', text: reply });
    if (res && res.remember && res.remember.fact) rememberFact(res.remember.fact, res.remember.kind);
    persist();
    bubble(reply, { hold: 9000, type: true });
    setTimeout(() => $('said').classList.add('hidden'), 4200);

    // let the reply land before he turns to whatever you said meanwhile
    if (chatPending.length) await new Promise((r) => setTimeout(r, 1200));
  }

  chatBusy = false;
  anim().setMode('idle');
  scene.setCardPulse(false);
  scene.setCardThinking(false);
  updateCardScreen();
}

// ── Card Book ──
function openBook(tab) {
  brain.interrupt();
  bookTab = tab || bookTab;
  renderBook();
}

function renderBook() {
  ui.showBook(state, bookTab, bookFilter, {
    onClose: () => { sfx.pop(); ui.closeOverlay(); },
    onTab: (t) => { bookTab = t; renderBook(); },
    onFilter: (f) => { bookFilter = f; renderBook(); },
    onApply: (i) => {
      const c = state.cards[i];
      if (!c) return;
      sfx.pop();
      // hold this card in his hands — persists until the next daily draw,
      // and survives chat / switching buddies (updateCardScreen reads state.msg)
      state.msg = c.m;
      state.rare = !!c.rare;
      state.drawn = true;
      persist();
      updateCardScreen();
      ui.closeOverlay();
      scene.raiseCard();
      bubble('Holding this one for you. ♥');
    },
    onFav: (i) => {
      sfx.pop();
      state.cards[i].fav = !state.cards[i].fav;
      persist();
      renderBook();
    },
    onDel: (i) => {
      sfx.pop();
      state.cards.splice(i, 1);
      persist();
      renderBook();
    },
    onDelMem: (i) => {
      sfx.pop();
      state.memory.splice(i, 1);
      persist();
      renderBook();
    },
    onClearMem: () => {
      sfx.pop();
      state.memory = [];
      persist();
      renderBook();
    },
    // Chat and memory clear independently now that each has its own tab: this
    // wipes only the running conversation (context he replies from), resetting
    // it to a fresh greeting; his distilled memory stays put.
    onClearChat: () => {
      sfx.pop();
      state.chat = [{ who: 'pet', text: greet(state.active) }];
      chatPending.length = 0;
      persist();
      renderBook();
    },
    onClearCards: () => {
      sfx.pop();
      state.cards = [];
      persist();
      renderBook();
    },
  });
}

// ── Buddies (standalone panel) ──
function openBuddies() {
  brain.interrupt();
  if (state.buddyNew) {
    state.buddyNew = false;
    persist();
  }
  renderBuddies();
}

function renderBuddies() {
  ui.showBuddies(state, {
    onClose: () => { sfx.pop(); ui.closeOverlay(); },
    onPick: async (id) => {
      const ch = CHARS.find((c) => c.id === id);
      const d = UNLOCK[id];
      if (d && !state.unlockedIds.includes(id)) {
        sfx.low();
        ui.closeOverlay();
        bubble(`${ch.name} joins when you ${d.how}.`, { hold: 3600 });
        return;
      }
      sfx.pop();
      brain.interrupt();
      state.active = id;
      state.chat.push({ who: 'pet', text: greet(id) });
      persist();
      ui.closeOverlay();
      await scene.setCharacter(id);
      updateCardScreen();
      anim().play(scene.hasRig() ? 'wave' : 'hop'); // reporting for duty
      bubble(greet(id), { hold: 3600 });
      $('chatInput').placeholder = `tell ${activeChar().name} what's on your mind…`;
    },
  });
}

// ── care cards (scheduler / OS events) ──
function presentCare(tag, msg) {
  if (ui.isOverlayOpen() || anim().tucked) return;
  brain.interrupt();
  sfx.chime();
  scene.raiseCard();
  ui.showCareCard(state, tag, msg, () => {
    sfx.pop();
    ui.closeOverlay();
  });
}

// ── debug switch (launch with PP_DEBUG=1) ──
// redraw simulates the next day: fresh text each time, golden by pity-smoothed roll
function debugRedraw() {
  if (weaving) return;
  ui.closeOverlay();
  state.day += 1;
  state.drawn = false;
  state.draws = 0;
  state.rare = false;
  state.msg = '';
  state.keptToday = false;
  persist();
  updateCardScreen();
  drawToday();
}

function debugReset() {
  store.reset();
  location.reload();
}

// ── input wiring ──
const stage = $('stage');
const panel = $('hoverpanel');
let hovT = null;

function showPanel() {
  clearTimeout(hovT);
  if (!anim().tucked && !ui.isOverlayOpen()) panel.classList.add('show');
}
function hidePanelSoon() {
  clearTimeout(hovT);
  hovT = setTimeout(() => panel.classList.remove('show'), 320);
}
stage.addEventListener('mouseenter', showPanel);
stage.addEventListener('mouseleave', hidePanelSoon);
// The panel container is click-through now (only its controls catch the mouse),
// so keep-alive listens on each control instead of the whole panel box.
for (const el of [$('said'), $('icons'), $('chatrow')]) {
  el.addEventListener('mouseenter', showPanel);
  el.addEventListener('mouseleave', hidePanelSoon);
}

// tap vs drag: dragging the potato moves the whole window; horizontal drag
// also spins him — release lets the underdamped spring swing him back.
// (the Turn 5/6 double-tap → pirouette mapping is gone: it hijacked every
// second click during fast tapping into the same spin, which is exactly the
// monotony the user asked to fix — pirouette lives in the random pool now)

// ── edge-dock nap: drag him against a screen edge and he curls up to snooze,
// waking when you drag him back off the edge or tap him. The main process
// reports which edge (if any) the potato is currently pushed against.
let edgeSide = null;

function sleepAtEdge() {
  if (anim().asleep) return;
  brain.interrupt();
  hideBubble();
  $('mutter').classList.add('hidden');
  anim().asleep = true;
  anim().setMode('doze');
  $('zz').classList.remove('hidden');
  sfx.low();
}

function wakeFromEdge() {
  if (!anim().asleep) return;
  anim().asleep = false;
  anim().setMode('idle');
  $('zz').classList.add('hidden');
  anim().play('squish');
  sfx.boing();
}

pp.on('edge', (side) => {
  edgeSide = side;
  if (!side) wakeFromEdge(); // pulled off the edge → he stirs awake
});

let drag = null;
// How far the potato is shifted up WITHIN the window. macOS pins the window's
// top under the menu bar, and he's drawn ~490px below that top, so without this
// he could never be dragged past mid-screen. When the window stalls at the top,
// we slide the whole stage up instead so he keeps tracking the cursor to the top.
let lift = 0;
const LIFT_MAX = 360; // brings his head to the top edge without clipping it off
function applyLift() {
  stage.style.transform = lift ? `translateY(${-lift}px)` : '';
}

stage.addEventListener('pointerdown', (e) => {
  if (ui.isOverlayOpen()) return; // visible behind the modal, but hands off —
  // dragging would move the fullscreen window and taps could stack modals
  drag = { x: e.screenX, y: e.screenY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', async (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4 && !drag.moved) {
    drag.moved = true;
    brain.interrupt();
    anim().setDragging(true);
    wakeFromEdge(); // grabbing a sleeping potato wakes him
  }
  if (!drag.moved) return;
  drag.x = e.screenX;
  drag.y = e.screenY;
  anim().dragBy(dx * 0.5);

  // Dragging back down: spend the in-window lift before the window itself moves,
  // so he peels off the top smoothly instead of the window lurching down first.
  let winDy = dy;
  if (dy > 0 && lift > 0) {
    const take = Math.min(lift, dy);
    lift -= take;
    winDy -= take;
  }
  const shortfall = await pp.win.moveBy(dx, winDy); // px the window couldn't rise
  if (shortfall > 0) lift = Math.min(lift + shortfall, LIFT_MAX);
  applyLift();
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) {
    anim().setDragging(false); // spring-back with one overshoot
    if (edgeSide) {
      sleepAtEdge(); // landed against an edge — tuck in for a nap
    } else {
      anim().play('bigSquish');
      sfx.boing();
      bubble('wheee— ok. landing.');
    }
    return;
  }
  tapPet(scene.pick(e.clientX, e.clientY));
});

$('chatInput').addEventListener('keydown', (e) => {
  // Ignore the Enter that only confirms an IME candidate — otherwise chatSend
  // clears the field and the IME re-commits its text into it, so it never empties.
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) chatSend();
  if (e.key === 'Escape') $('chatInput').blur();
});
$('chatInput').addEventListener('focus', () => { brain.interrupt(); anim().setMode('lean'); }); // 04 · Listen Lean
$('chatInput').addEventListener('blur', () => { if (!chatBusy && !weaving) anim().setMode('idle'); });
$('chatInput').placeholder = `tell ${activeChar().name} what's on your mind…`;

$('bookBtn').onclick = () => { sfx.pop(); openBook('cards'); };
$('buddiesBtn').onclick = () => { sfx.pop(); openBuddies(); };
$('soundBtn').onclick = () => {
  state.sound = !state.sound;
  setSoundEnabled(state.sound);
  $('soundBtn').classList.toggle('off', !state.sound);
  if (state.sound) sfx.pop();
  store.save(state);
};
$('soundBtn').classList.toggle('off', !state.sound);

// click-through everywhere except interactive elements
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // In panel mode (Card Book / Buddies) the overlay backdrop is click-through,
  // so the desktop and other apps stay usable around the floating panel. The
  // panel content itself still carries data-interactive, so it stays clickable.
  const onPanelBackdrop = !!(el && el.id === 'overlay' && el.classList.contains('panel'));
  // while a popup is being dragged, hold the window mouse-active even as the
  // cursor sweeps over the click-through backdrop, so the drag keeps its events
  const interactive = ui.isDraggingModal() || (!onPanelBackdrop && !!(el && el.closest('[data-interactive]')));
  pp.win.setIgnoreMouse(!interactive);
  setBubbleHover(!!(el && el.closest('#bubble')));
  setMutterHover(!!(el && el.closest('#mutter')));
});
document.addEventListener('mouseleave', () => {
  pp.win.setIgnoreMouse(true);
  setBubbleHover(false);
  setMutterHover(false);
});

// turns to watch your cursor (Turn 5) — the main process polls the global cursor so he
// keeps watching even while the pointer roams other windows; eyes lead, head
// follows (Turn 6). ±420px from his nose = full turn.
let lastCursor = null;
pp.on('cursor', ({ x, y }) => {
  // presence for the brain: the cursor actually moving means you're there
  if (lastCursor && Math.abs(x - lastCursor.x) + Math.abs(y - lastCursor.y) > 3) brain.pointerMove();
  lastCursor = { x, y };
  if (anim().tucked || anim().asleep || drag) return;
  const r = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height * 0.55; // eye line, not stage center
  anim().facePoint(
    Math.max(-1, Math.min(1, (x - cx) / 420)),
    Math.max(-1, Math.min(1, (y - cy) / 420))
  );
});

// (the old random idle-hop scheduler is gone — the soul engine (7a) owns
// autonomous behavior now: boredom routines, dozing, knocking, mutters)

// night care at 23:00 (once per day)
setInterval(() => {
  const now = new Date();
  const today = state.lastDate;
  if (now.getHours() >= 23 && state.nightShownDate !== today) {
    state.nightShownDate = today;
    store.save(state);
    presentCare('NIGHT CARE', NIGHTMSG);
  }
}, 60000);

// sedentary reminder from the main process (90 min continuous activity)
pp.on('sedentary', () => presentCare('STRETCH BREAK', SEDENTARY));

// ── boot ──
$('buddiesDot').classList.toggle('hidden', !state.buddyNew);
updateCardScreen();
pp.win.setIgnoreMouse(true);

// debug hook for automated UI tests (PP_UITEST=js:...)
window._pp = {
  tap: tapPet,
  tapCard: () => tapPet('card'),
  tapReact: playTapReaction,
  state: () => state,
  brain,
  redraw: debugRedraw,
  reset: debugReset,
  play: (name) => anim().play(name),
  setChar: (id) => scene.setCharacter(id).then(updateCardScreen),
  sceneObj: scene,
  cardProbe: () => {
    const planes = [];
    scene.scene.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry') {
        planes.push({ pos: o.position.toArray().map((v) => +v.toFixed(3)), parent: o.parent?.uuid?.slice(0, 8) });
      }
    });
    return { planes, canvas: [scene.cardScreen.canvas.width, scene.cardScreen.canvas.height] };
  },
};

// Open-the-app greeting: a fresh, personalized hello from the LLM, coloured by
// what he remembers and the time of day. Falls back to a built-in daypart line
// when the LLM is unreachable / over budget. Returns null on any failure.
async function personalGreeting() {
  if (!pp?.ai?.greet) return null; // no bridge (older preload)
  const ch = activeChar();
  try {
    return await pp.ai.greet({
      charId: ch.id,
      charName: ch.name,
      voice: PERS[ch.id].voice,
      daypart: daypart(),
      day: state.day,
      memory: state.memory.slice(-6),
    });
  } catch (e) {
    return null;
  }
}

// Fire the greeting request at launch so it's usually ready by the time he
// speaks — no built-in-then-swap flicker.
const greetingReq = personalGreeting();

setTimeout(async () => {
  anim().play(scene.hasRig() ? 'wave' : 'hop'); // time-of-day greeting
  if (state.drawn) return;
  // prefer the personalized line, but never leave him silent: fall back to the
  // built-in daypart greeting if the LLM is slow / offline / over budget
  const line = await Promise.race([
    greetingReq,
    new Promise((r) => setTimeout(() => r(null), 2200)),
  ]);
  if (state.drawn) return;
  bubble(line || greet(state.active), { hold: 5200 });
}, 900);
