// ── input wiring: taps/pokes, window drag, hover panel, edge-dock naps,
// cursor tracking, and the click-through choreography ──
import { routineMs } from '../brain';
import { CARDHINT, POKE, RETAP } from '../content';
import { CLIPS, WOBBLE } from '../scene/motions';
import type { PickTarget } from '../scene/scene';
import { setSoundEnabled, sfx } from '../sfx';
import * as store from '../store';
import { heartsBurst } from '../ui/effects';
import { isDraggingModal, isOverlayOpen } from '../ui/overlay';
import { chatSend } from './chat';
import { $, ctx, pp } from './context';
import { DAILY_DRAW_LIMIT, drawToday, openCard } from './gacha';
import { openBook, openBuddies } from './panels';
import { bubble, hideBubble, setBubbleHover, setMutterHover } from './speech';

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
const TAP_POOL: [string, number][] = [
  ['squish', 1.5], ['hop', 0.6], ['wobble', 1], ['peek', 1], ['spin', 0.6],
  ['sneeze', 1.4], ['pirouette', 1],
  ['@chase', 3], ['@hum', 3],
];
const TAP_POOL_RIG: [string, number][] = [
  ['eyeroll', 1], ['bounceCard', 1.4], ['wave', 1.2],
  ['@study', 2.6], ['@juggle', 2.4], ['@practice', 2.2],
];
let tapHistory: string[] = [];
let tapBusyUntil = 0;
let retapIdx = 0;

export function playTapReaction(): string {
  const pool = (ctx.scene.hasRig() ? TAP_POOL.concat(TAP_POOL_RIG) : TAP_POOL)
    .filter(([k]) => !tapHistory.includes(k));
  let r = Math.random() * pool.reduce((s, [, w]) => s + w, 0);
  let name = pool[0][0];
  for (const [k, w] of pool) { r -= w; if (r <= 0) { name = k; break; } }
  tapHistory = [name, ...tapHistory].slice(0, 2);
  if (name[0] === '@') {
    const key = name.slice(1);
    ctx.brain.force(key);
    tapBusyUntil = performance.now() + routineMs(key);
  } else {
    ctx.anim().play(name);
    if (name === 'sneeze') sfx.sneeze();
    const clip = name === 'wobble' ? WOBBLE : CLIPS[name];
    tapBusyUntil = performance.now() + (clip ? clip.dur : 700);
  }
  return name;
}

// the card popup only opens from the white card itself (user request);
// body taps are pure play — random reaction, hearts, poke lines
export function tapPet(target: PickTarget): void {
  // the stage fills a 300×400 rectangle, but only the potato answers: a tap
  // on empty air (raycast hit nothing) is inert — no reaction, no waking, and
  // no need-nudge in the brain — so play tracks his silhouette, not the box.
  if (!target) return;
  if (ctx.anim().asleep) {
    wakeFromEdge(); // a tap rouses him from his edge nap
    return;
  }
  if (ctx.anim().tucked) {
    sfx.boing();
    ctx.anim().setTucked(false);
    $('zz').classList.add('hidden');
    ctx.anim().play('squish');
    return;
  }
  // the brain gets first dibs: waking him from a doze / answering his knock
  if (ctx.brain.poke()) return;

  if (target === 'card') {
    ctx.brain.interrupt(); // the card is functional UI — it always answers
    tapBusyUntil = 0;
    if (ctx.chatBusy || ctx.weaving || isOverlayOpen()) return;
    if (ctx.state.draws < DAILY_DRAW_LIMIT) {
      // still have draw budget (always true when uncapped) → draw a new card; once used up, tapping the card reopens the current one instead
      ctx.anim().play('squish'); // the card says "tap me :)" — this is the draw
      drawToday();
      return;
    }
    sfx.pop();
    openCard();
    return;
  }

  // debounce: while a reaction (or a click-launched show) plays, further
  // body taps are swallowed instead of stacking clips on top of each other
  if (performance.now() < tapBusyUntil) return;
  ctx.brain.interrupt();
  const name = playTapReaction();
  if (name[0] === '@') return; // the show brings its own lines and sfx
  sfx.boing();
  heartsBurst();
  if (!ctx.state.drawn) {
    bubble(Math.random() < 0.5 ? CARDHINT : POKE[Math.floor(Math.random() * POKE.length)]);
  } else if (Math.random() < 0.5) {
    bubble(POKE[Math.floor(Math.random() * POKE.length)]);
  } else {
    bubble(RETAP[retapIdx % RETAP.length]);
    retapIdx++;
  }
}

// ── edge-dock nap: drag him against a screen edge and he curls up to snooze,
// waking when you drag him back off the edge or tap him. The main process
// reports which edge (if any) the potato is currently pushed against.
let edgeSide: string | null = null;

function sleepAtEdge(): void {
  if (ctx.anim().asleep) return;
  ctx.brain.interrupt();
  hideBubble();
  $('mutter').classList.add('hidden');
  ctx.anim().asleep = true;
  ctx.anim().setMode('doze');
  $('zz').classList.remove('hidden');
  sfx.low();
}

export function wakeFromEdge(): void {
  if (!ctx.anim().asleep) return;
  ctx.anim().asleep = false;
  ctx.anim().setMode('idle');
  $('zz').classList.add('hidden');
  ctx.anim().play('squish');
  sfx.boing();
}

// Wires every DOM/IPC input handler. Called once from main.ts, after the
// scene, brain and state exist.
export function wireInteractions(): void {
  const stage = $('stage');
  const panel = $('hoverpanel');
  let hovT = 0;

  let panelHover = false; // pointer resting on the stage or one of the panel controls

  // The panel stays up while the pointer rests on it OR while the chat input holds
  // focus — a focused field means you're mid-message, so letting the pointer wander
  // off shouldn't yank the panel (and your half-typed text) away.
  function panelPinned(): boolean {
    return panelHover || document.activeElement === $('chatInput');
  }
  function showPanel(): void {
    clearTimeout(hovT);
    if (!ctx.anim().tucked && !isOverlayOpen()) panel.classList.add('show');
  }
  function hidePanelSoon(): void {
    clearTimeout(hovT);
    if (panelPinned()) return;
    hovT = window.setTimeout(() => panel.classList.remove('show'), 320);
  }
  stage.addEventListener('mouseenter', () => { panelHover = true; showPanel(); });
  stage.addEventListener('mouseleave', () => { panelHover = false; hidePanelSoon(); });
  // The panel container is click-through now (only its controls catch the mouse),
  // so keep-alive listens on each control instead of the whole panel box.
  for (const el of [$('said'), $('icons'), $('chatrow')]) {
    el.addEventListener('mouseenter', () => { panelHover = true; showPanel(); });
    el.addEventListener('mouseleave', () => { panelHover = false; hidePanelSoon(); });
  }

  // tap vs drag: dragging the potato moves the whole window; horizontal drag
  // also spins him — release lets the underdamped spring swing him back.
  // (the Turn 5/6 double-tap → pirouette mapping is gone: it hijacked every
  // second click during fast tapping into the same spin, which is exactly the
  // monotony the user asked to fix — pirouette lives in the random pool now)

  pp.on('edge', (side) => {
    edgeSide = side;
    if (!side) wakeFromEdge(); // pulled off the edge → he stirs awake
  });

  let drag: { x: number; y: number; moved: boolean } | null = null;
  // How far the potato is shifted up WITHIN the window. macOS pins the window's
  // top under the menu bar, and he's drawn ~490px below that top, so without this
  // he could never be dragged past mid-screen. When the window stalls at the top,
  // we slide the whole stage up instead so he keeps tracking the cursor to the top.
  let lift = 0;
  const LIFT_MAX = 360; // brings his head to the top edge without clipping it off
  function applyLift(): void {
    stage.style.transform = lift ? `translateY(${-lift}px)` : '';
  }

  stage.addEventListener('pointerdown', (e) => {
    if (isOverlayOpen()) return; // visible behind the modal, but hands off —
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
      ctx.brain.interrupt();
      ctx.anim().setDragging(true);
      wakeFromEdge(); // grabbing a sleeping potato wakes him
    }
    if (!drag.moved) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    ctx.anim().dragBy(dx * 0.5);

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
      ctx.anim().setDragging(false); // spring-back with one overshoot
      if (edgeSide) {
        sleepAtEdge(); // landed against an edge — tuck in for a nap
      } else {
        ctx.anim().play('bigSquish');
        sfx.boing();
        bubble('wheee— ok. landing.');
      }
      return;
    }
    tapPet(ctx.scene.pick(e.clientX, e.clientY));
  });

  const chatInput = $('chatInput') as HTMLInputElement;
  chatInput.addEventListener('keydown', (e) => {
    // Ignore the Enter that only confirms an IME candidate — otherwise chatSend
    // clears the field and the IME re-commits its text into it, so it never empties.
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) chatSend();
    if (e.key === 'Escape') chatInput.blur();
  });
  chatInput.addEventListener('focus', () => { ctx.brain.interrupt(); ctx.anim().setMode('lean'); }); // 04 · Listen Lean
  chatInput.addEventListener('blur', () => {
    if (!ctx.chatBusy && !ctx.weaving) ctx.anim().setMode('idle');
    hidePanelSoon(); // focus no longer pins the panel — hide it unless the pointer still holds it
  });
  chatInput.placeholder = `tell ${ctx.activeChar().name} what's on your mind…`;

  $('bookBtn').onclick = () => { sfx.pop(); openBook('cards'); };
  $('buddiesBtn').onclick = () => { sfx.pop(); openBuddies(); };
  $('soundBtn').onclick = () => {
    ctx.state.sound = !ctx.state.sound;
    setSoundEnabled(ctx.state.sound);
    $('soundBtn').classList.toggle('off', !ctx.state.sound);
    if (ctx.state.sound) sfx.pop();
    store.save(ctx.state);
  };
  $('soundBtn').classList.toggle('off', !ctx.state.sound);

  // click-through everywhere except interactive elements
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // In panel mode (Card Book / Buddies) the overlay backdrop is click-through,
    // so the desktop and other apps stay usable around the floating panel. The
    // panel content itself still carries data-interactive, so it stays clickable.
    const onPanelBackdrop = !!(el && el.id === 'overlay' && el.classList.contains('panel'));
    // while a popup is being dragged, hold the window mouse-active even as the
    // cursor sweeps over the click-through backdrop, so the drag keeps its events
    const interactive = isDraggingModal() || (!onPanelBackdrop && !!(el && el.closest('[data-interactive]')));
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
  let lastCursor: { x: number; y: number } | null = null;
  pp.on('cursor', ({ x, y }) => {
    // presence for the brain: the cursor actually moving means you're there
    if (lastCursor && Math.abs(x - lastCursor.x) + Math.abs(y - lastCursor.y) > 3) ctx.brain.pointerMove();
    lastCursor = { x, y };
    if (ctx.anim().tucked || ctx.anim().asleep || drag) return;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.55; // eye line, not stage center
    ctx.anim().facePoint(
      Math.max(-1, Math.min(1, (x - cx) / 420)),
      Math.max(-1, Math.min(1, (y - cy) / 420))
    );
  });
}
