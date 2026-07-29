// ── daily card: the gacha draw, the golden weave, and the card offer ──
import { PERS, TXT, pool } from '../content';
import { lang } from '../locale';
import { quotesPool } from '../quotes';
import * as remote from '../remote';
import { sfx } from '../sfx';
import * as store from '../store';
import { closeOverlay } from '../ui/overlay';
import { showCard, showDrawAnim, showWeave, setWeaveLine } from '../ui/popups';
import { ctx, pp } from './context';
import { nextMemories } from './memory';
import { openBook } from './panels';
import { bubble } from './speech';
import type { Quote } from '../types';

// ── server-tunable knobs ──
// Every constant below is only the BUILT-IN DEFAULT: draws read the live value
// through remote.tune(key, default, min, max), which prefers the server's
// config tuning (riding on the daily /cards answer, set via POST
// /admin/config) — so odds and mix rates can be adjusted for every install
// with one admin call, no app release. Offline or unset keys fall back here.

// Daily draw limit ('drawLimit'). Left uncapped for now; to throttle, tune a
// concrete number (e.g. 3 = the first 3 draws a day give new cards, after
// that tapping the card just reopens the current one).
const DAILY_DRAW_LIMIT = Infinity;
export const dailyDrawLimit = (): number => remote.tune('drawLimit', DAILY_DRAW_LIMIT, 1, Infinity);

// Golden card (GOLDEN STITCH) chance — with pity / smoothing.
// Pure randomness (fixed probability) is streaky: long droughts, or several
// goldens at once. We smooth it with state.pity ("draws since last golden") —
// each miss ramps the chance up, and hitting a golden resets it to zero.
// Persists across days: a once-a-day user builds up pity over a few days and
// is guaranteed one, naturally recreating the "a golden every few days" rhythm.
// Start 25% + 5% per miss ⇒ guaranteed by the 16th draw; averages ~1 in 3 (≈33%).
// Want rarer: lower 'goldenBase'/'goldenRamp'; more generous: raise them. Just
// after a golden it drops back to base, so goldens rarely cluster.
const GOLDEN_BASE = 0.25; // starting chance right after a golden ('goldenBase')
const GOLDEN_RAMP = 0.05; // how much the chance grows per miss ('goldenRamp')

// Where a golden card's text comes from. A golden is either the live
// personalized weave (LLM + his memories of you) or a curated famous quote —
// both high quality, so we lean on the quotes and keep the live call a treat:
// once there's memory to personalize it, GOLDEN_LIVE_CHANCE of goldens attempt
// the weave; the rest (and every golden before any memory exists, and any live
// miss: offline, over budget) take a famous quote. The quote pool is bundled
// with the app, so a golden always lands even fully offline.
const GOLDEN_LIVE_CHANCE = 0.1; // ('weaveChance')

// Live-weave pity. A flat 10% roll leaves long all-quote streaks (0.9^8 ≈ 43%)
// that read as "the weave never happens". state.weavePity counts goldens since
// the last DELIVERED weave; at the limit the next golden skips the roll and
// attempts the weave outright. Misses count too (offline, over budget), so a
// dry stretch keeps trying every golden until one lands. It also accrues while
// no memory exists yet — the first golden after his first memory then weaves
// right away, which is exactly the moment it should feel personal.
const WEAVE_PITY_LIMIT = 8; // quote-goldens in a row before a weave is forced ('weavePity')

// How many memory facts a single live weave is fed. Kept small on purpose: the
// weave references one concrete memory, so feeding the whole set every time
// makes consecutive goldens circle the same fact and read alike. We rotate
// instead — a few unused facts per weave (see pickMemories).
const GOLDEN_MEMORY_FEED = 2;

const pickOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// No-replacement bookkeeping: the normal server pool's used-list resets when a
// fresh daily pool lands (its date stamp changes — including the first fetch).
function syncUsedCards(): void {
  const state = ctx.state;
  const d = remote.batchDate();
  if (!state.usedCards || state.usedCards.date !== d) state.usedCards = { date: d, used: [] };
}

// The persistent pools' used-lists remember full line texts and persist across
// days, so they'd grow without bound (fattening every state.json rewrite) and
// the old `includes` scan cost O(pool × used) per draw. Cap them to the most
// recent entries — the server serves those pools as small daily windows, so
// "not among the last 500 seen" is indistinguishable from perfect
// no-replacement — and do lookups through a Set.
const USED_RECENT_CAP = 500;
function trimUsed(used: string[]): void {
  if (used.length > USED_RECENT_CAP) used.splice(0, used.length - USED_RECENT_CAP);
}

// Famous-quote gacha without replacement — the golden card's non-live source.
// The pool persists (today's window of the server library, or the bundled
// static pool), so its used-list lives in state rather than resetting with the
// daily batch; it only clears once today's whole pool has been seen.
function pickQuote(pool: Quote[]): Quote {
  const state = ctx.state;
  const used = new Set(state.usedQuotes);
  const unseen = pool.filter((x) => !used.has(x.q) && x.q !== state.msg);
  let pick: Quote;
  if (unseen.length) {
    pick = pickOf(unseen);
  } else {
    state.usedQuotes = [];
    const lap = pool.filter((x) => x.q !== state.msg);
    pick = pickOf(lap.length ? lap : pool);
  }
  state.usedQuotes.push(pick.q);
  trimUsed(state.usedQuotes);
  return pick;
}

// Normal-card sources: the PERSISTENT internet-line pool (circulating
// 网络/no-source lines the server accumulates daily — the ambient-encouragement
// bed) mixed with the small DAILY generated batch (the dare/joke/sincere
// topping). When both are up, this is the share of draws that take an internet
// line; the rest (~20%) take the day's fresh batch. Either side alone serves
// 100%.
const INET_CHANCE = 0.8; // ('inetChance')

// Internet-line gacha without replacement — mirrors pickQuote: the pool
// persists (today's window of the server library), so its used-list lives in
// state and only clears once today's whole pool has been seen.
function pickInet(pool: string[]): string {
  const state = ctx.state;
  const used = new Set(state.usedInet);
  const unseen = pool.filter((m) => !used.has(m) && m !== state.msg);
  let pick: string;
  if (unseen.length) {
    pick = pickOf(unseen);
  } else {
    state.usedInet = [];
    const lap = pool.filter((m) => m !== state.msg);
    pick = pickOf(lap.length ? lap : pool);
  }
  state.usedInet.push(pick);
  trimUsed(state.usedInet);
  return pick;
}

export function drawToday(): void {
  const state = ctx.state;
  state.draws++;
  // The first draw of each calendar day is a guaranteed golden — a daily
  // welcome-back reward (state.draws resets to 0 on day rollover, so draws===1
  // is the day's first). Every later draw still rolls on the pity curve below,
  // so this is a floor on the first draw, not a return to one-card-a-day.
  if (state.draws === 1 || Math.random() < remote.tune('goldenBase', GOLDEN_BASE, 0, 1) + remote.tune('goldenRamp', GOLDEN_RAMP, 0, 1) * state.pity) {
    state.pity = 0;
    weaveGolden();
    return;
  }
  state.pity++;
  // Normal cards mix two server pools, both drawn without replacement: the
  // persistent internet-line pool (circulating no-source encouragement,
  // used-list in state until it laps) and the small daily generated
  // dare/joke/sincere batch (used-list resets with each new batch). Famous
  // quotes are reserved for goldens. The built-in DAILY pool is a pure
  // offline fallback — only when no server pool is reachable — and it draws
  // freely (no retirement, just no instant repeat).
  syncUsedCards();
  const dailyPool = remote.normalPool(ctx.activeChar().id);
  const inetPool = remote.serverInet();
  let msg: string;
  if (inetPool && (!dailyPool || Math.random() < remote.tune('inetChance', INET_CHANCE, 0, 1))) {
    msg = pickInet(inetPool);
  } else if (dailyPool) {
    const unseen = dailyPool.filter((m) => !state.usedCards.used.includes(m) && m !== state.msg);
    if (unseen.length) {
      msg = pickOf(unseen);
    } else {
      state.usedCards.used = [];
      const lap = dailyPool.filter((m) => m !== state.msg);
      msg = pickOf(lap.length ? lap : dailyPool);
    }
    state.usedCards.used.push(msg);
  } else {
    const DAILY = TXT().daily.map((d) => d.m);
    const noRepeat = DAILY.filter((m) => m !== state.msg);
    msg = pickOf(noRepeat.length ? noRepeat : DAILY);
  }
  ctx.persist(); // save the gacha bookkeeping (draws/pity/used) even before he keeps it
  sfx.draw();
  showDrawAnim();
  setTimeout(() => {
    // Don't put the card in his hands yet — the draw only offers it. It lands
    // on the potato in openCard's onKeep; "Later" leaves his hands untouched.
    openCard({ msg, rare: false }); // normal cards carry no attribution
    const lines = pool('drawLines');
    bubble(lines[Math.floor(Math.random() * lines.length)]);
  }, 1250);
}

export async function weaveGolden(): Promise<void> {
  if (ctx.weaving) return;
  ctx.weaving = true;
  ctx.brain.interrupt();
  sfx.draw();
  ctx.anim().play('bigSquish');
  ctx.anim().setMode('rock');
  ctx.scene.setCardPulse(true);
  const weaveLines = pool('weaveLines');
  showWeave(weaveLines[0]);
  let li = 0;
  const weaveInt = setInterval(() => {
    li = (li + 1) % weaveLines.length;
    setWeaveLine(weaveLines[li]);
  }, 2400);

  const ch = ctx.activeChar();
  // The live weave only earns its token when there's memory to personalize it —
  // with nothing remembered yet it degrades to a generic "keep it universal"
  // line, which a curated famous quote beats for free. So gate the call on
  // having memory AND (a GOLDEN_LIVE_CHANCE roll OR the weave pity maturing);
  // otherwise skip straight to the quote. When it does fire, feed a ROTATING
  // slice of memory (not the same recent facts every time) so consecutive
  // goldens don't read alike.
  // .catch → null so a dropped connection can't leave the weave spinning.
  const tryLive =
    store.activeMemory(ctx.state).length > 0 &&
    (ctx.state.weavePity >= remote.tune('weavePity', WEAVE_PITY_LIMIT, 1, 99) ||
      Math.random() < remote.tune('weaveChance', GOLDEN_LIVE_CHANCE, 0, 1));
  const memory = tryLive ? nextMemories(GOLDEN_MEMORY_FEED) : [];
  const [aiMsg] = await Promise.all([
    tryLive
      ? pp?.ai.golden({ charId: ch.id, charName: ch.name, voice: PERS[ch.id].voice, day: ctx.state.day, memory, lang: lang() }).catch(() => null)
      : Promise.resolve(null),
    new Promise((r) => setTimeout(r, 1800)),
  ]);
  clearInterval(weaveInt);
  ctx.weaving = false;
  ctx.anim().setMode('idle');
  ctx.scene.setCardPulse(false);
  sfx.chime();
  // live weave when it rolled and landed; otherwise a curated famous quote.
  // The quote pool is bundled with the app, so it's always there — even offline.
  let gMsg: string;
  let gSrc = '';
  if (aiMsg) {
    ctx.state.weavePity = 0; // a weave actually landed — the pity clock restarts
    gMsg = aiMsg; // personalized weave — his own words, no attribution
  } else {
    ctx.state.weavePity++; // quote golden (not rolled, or the live call missed)
    const pick = pickQuote(quotesPool());
    gMsg = pick.q;
    // A curated line with no known author (a genuinely anonymous internet quote)
    // still gets an attribution — the localized "Anonymous" — so it reads as a
    // QUOTE, not the buddy's own weave. Weaves leave gSrc empty and fall through
    // to the buddy name; a source-less quote must not look identical to them.
    gSrc = pick.s || TXT().ui.anon;
  }
  ctx.persist(); // save the golden bookkeeping (draws/pity, used-list) before he keeps it
  // Offer it in the overlay; it only lands on the potato if he keeps it.
  openCard({ msg: gMsg, src: gSrc, rare: true });
  bubble(TXT().ui.knitFresh);
}

// openCard(card) offers a freshly drawn card in the overlay without touching
// the potato's hands. card = { msg, src?, rare } for a new draw; omit it to
// reopen whatever he's already holding (state.msg) — e.g. when the draw budget
// is used up. Only "Keep it" commits the card to his hands and the Book.
export function openCard(card?: { msg: string; src?: string; rare: boolean }): void {
  const state = ctx.state;
  const fresh = !!card;
  const view = card
    ? { msg: card.msg, src: card.src || '', rare: card.rare, keptToday: false }
    : { msg: state.msg, src: state.msgSrc, rare: state.rare, keptToday: state.keptToday };
  if (!fresh) ctx.scene.raiseCard(); // reopening the held card — present it now
  showCard(state, view, {
    onKeep: () => {
      if (!fresh && state.keptToday) { // already in the Book → just open it
        sfx.pop();
        openBook('cards');
        return;
      }
      sfx.pop();
      if (card) {
        // this is the moment the card lands in his hands
        state.drawn = true;
        state.rare = card.rare;
        state.msg = card.msg;
        state.msgSrc = card.src || '';
        ctx.updateCardScreen();
        ctx.scene.raiseCard(); // rig models play 'present', legacy 'raise' + quad slide
      }
      state.cards.push({
        m: state.msg,
        rare: state.rare,
        day: state.day,
        by: ctx.activeChar().name,
        src: state.msgSrc || undefined, // only famous quotes carry an attribution
      });
      state.keptToday = true;
      ctx.persist();
      closeOverlay();
      bubble(TXT().ui.tucked);
    },
    // "Later" declines the draw: nothing enters the Book and his hands are
    // left holding exactly what they were before.
    onLater: () => {
      closeOverlay();
      bubble(TXT().ui.maybeNext);
    },
  });
}
