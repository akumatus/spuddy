// ── daily card: the gacha draw, the golden weave, and the card offer ──
import { DAILY, DRAWLINES, PERS, WEAVELINES, goldenFallback } from '../content';
import * as remote from '../remote';
import { sfx } from '../sfx';
import { closeOverlay } from '../ui/overlay';
import { showCard, showDrawAnim, showWeave, setWeaveLine } from '../ui/popups';
import { ctx, pp } from './context';
import { openBook } from './panels';
import { bubble } from './speech';

// Daily draw limit. Left uncapped for now; to throttle, set a concrete number
// (e.g. 3 = the first 3 draws a day give new cards, after that tapping the
// card just reopens the current one).
export const DAILY_DRAW_LIMIT = Infinity;

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

// Where a golden card's text comes from. The live personalized weave (LLM +
// his memories of you) is a treat, not the default: it rolls in at this
// chance, otherwise the draw takes a line from today's cron-baked
// per-character golden pool. A live roll that misses (offline, over budget)
// also falls to the pool; the hand-written voiced built-ins are the last net
// when the pool is out of reach too (no server, no cached batch).
const GOLDEN_LIVE_CHANCE = 0.5;

// How often a draw dips into the hand-written built-in DAILY pool when the
// server pool is available. Kept rare: built-ins never refresh, so they'd wear
// out fast — and each one retires permanently once drawn (state.usedBuiltins).
const BUILTIN_CARD_CHANCE = 0.08;

const pickOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// No-replacement bookkeeping: the per-batch used lists reset when a fresh
// daily pool lands (its date stamp changes — including the first fetch).
function syncUsedCards(): void {
  const state = ctx.state;
  const d = remote.batchDate();
  if (!state.usedCards || state.usedCards.date !== d) state.usedCards = { date: d, used: [] };
  if (!state.usedGolden || state.usedGolden.date !== d) state.usedGolden = { date: d, used: [] };
}

// Golden-pool gacha without replacement — mirrors the normal pool's
// bookkeeping so pool draws don't repeat until today's goldens are exhausted.
function pickGoldenFromPool(pool: string[]): string {
  const state = ctx.state;
  syncUsedCards();
  const unseen = pool.filter((m) => !state.usedGolden.used.includes(m) && m !== state.msg);
  let msg: string;
  if (unseen.length) {
    msg = pickOf(unseen);
  } else {
    state.usedGolden.used = [];
    const lap = pool.filter((m) => m !== state.msg);
    msg = pickOf(lap.length ? lap : pool);
  }
  state.usedGolden.used.push(msg);
  return msg;
}

export function drawToday(): void {
  const state = ctx.state;
  state.draws++;
  if (Math.random() < GOLDEN_BASE + GOLDEN_RAMP * state.pity) {
    state.pity = 0;
    weaveGolden();
    return;
  }
  state.pity++;
  // Gacha without replacement: every drawn line is marked and sits out until
  // the day's pool is exhausted (then the marks clear and the pool laps).
  // Built-ins are a rare seasoning and never come back once seen; offline the
  // built-in DAILY pool carries alone.
  syncUsedCards();
  const serverPool = remote.normalPool(ctx.activeChar().id);
  const freshBuiltins = DAILY.map((d) => d.m).filter((m) => !state.usedBuiltins.includes(m));
  let msg: string;
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
  ctx.persist(); // save the gacha bookkeeping (draws/pity/used) even before he keeps it
  sfx.draw();
  showDrawAnim();
  setTimeout(() => {
    // Don't put the card in his hands yet — the draw only offers it. It lands
    // on the potato in openCard's onKeep; "Later" leaves his hands untouched.
    openCard({ msg, rare: false });
    bubble(DRAWLINES[Math.floor(Math.random() * DRAWLINES.length)]);
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
  showWeave(WEAVELINES[0]);
  let li = 0;
  const weaveInt = setInterval(() => {
    li = (li + 1) % WEAVELINES.length;
    setWeaveLine(WEAVELINES[li]);
  }, 2400);

  const ch = ctx.activeChar();
  const memory = ctx.state.memory.slice(-6);
  const [aiMsg] = await Promise.all([
    // live weave only on a GOLDEN_LIVE_CHANCE roll — skipping the call entirely
    // saves the shared daily budget for chat. .catch → null so a dropped
    // connection can't leave the weave stuck spinning.
    Math.random() < GOLDEN_LIVE_CHANCE
      ? pp.ai.golden({ charId: ch.id, charName: ch.name, voice: PERS[ch.id].voice, memory }).catch(() => null)
      : Promise.resolve(null),
    new Promise((r) => setTimeout(r, 1800)),
  ]);
  clearInterval(weaveInt);
  ctx.weaving = false;
  ctx.anim().setMode('idle');
  ctx.scene.setCardPulse(false);
  sfx.chime();
  // live weave when it rolled and landed; else today's cron golden pool
  // (no-replacement); the hand-written built-ins only when the pool is
  // unreachable
  const gPool = remote.goldenPool(ch.id);
  const gMsg = aiMsg || (gPool ? pickGoldenFromPool(gPool) : goldenFallback(ch.id));
  ctx.persist(); // save the golden bookkeeping (draws/pity, used-list) before he keeps it
  // Offer it in the overlay; it only lands on the potato if he keeps it.
  openCard({ msg: gMsg, rare: true });
  bubble('Knit fresh, just for you.');
}

// openCard(card) offers a freshly drawn card in the overlay without touching
// the potato's hands. card = { msg, rare } for a new draw; omit it to reopen
// whatever he's already holding (state.msg) — e.g. when the draw budget is used
// up. Only "Keep it" commits the card to his hands and the Book.
export function openCard(card?: { msg: string; rare: boolean }): void {
  const state = ctx.state;
  const fresh = !!card;
  const view = card
    ? { msg: card.msg, rare: card.rare, keptToday: false }
    : { msg: state.msg, rare: state.rare, keptToday: state.keptToday };
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
        ctx.updateCardScreen();
        ctx.scene.raiseCard(); // rig models play 'present', legacy 'raise' + quad slide
      }
      state.cards.push({ m: state.msg, rare: state.rare, day: state.day, by: ctx.activeChar().name });
      state.keptToday = true;
      ctx.persist();
      closeOverlay();
      bubble('Tucked into the Book. ♥');
    },
    // "Later" declines the draw: nothing enters the Book and his hands are
    // left holding exactly what they were before.
    onLater: () => {
      closeOverlay();
      bubble('Maybe next time. ♥');
    },
  });
}
