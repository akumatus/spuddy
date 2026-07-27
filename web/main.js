/* main.js — drives the live 3D hero for the Spuddy site.
   Ported from the Claude Design prototype's DCLogic component to plain DOM +
   the spud-scene2 PetScene runtime: loads the potato, faces the cursor, spins
   with momentum when dragged, plays a weighted-random reaction (and the odd
   longer skit) on a tap, and cycles a deck of cards painted onto the mesh.
   The static "waking up…" overlay shows until the scene is ready, and a still
   image is the fallback if WebGL / model loading fails. */

const HERO_BUDDY = 'spud';

// Lines painted onto the card he actually holds, cycled with a cross-fade.
const CARD_DECK = [
  { top: 'TODAY', main: 'Your pace is a real pace.' },
  { top: 'A REMINDER', main: 'Rest counts as doing something.' },
  { top: 'PSST', main: 'Small steps still count.' },
  { top: 'HEY', main: 'You made it through every hard day so far.' },
  { top: 'FOR YOU', main: 'Done beats perfect.' },
  { top: '· ♥ ·', main: 'You don’t have to bloom today — just stay rooted.' },
  { top: 'GENTLE NUDGE', main: 'Go drink some water. I’ll watch your stuff.' },
  { top: 'GOLDEN STITCH', main: 'You’re doing better than you think.', gold: true },
];

// On a poke he plays a random motion (no immediate repeats), weighted like the
// real app; the two just-played clips are excluded so a run of taps stays varied.
const TAP_POOL = [
  ['squish', 1.4], ['wobble', 1.1], ['hop', 0.8], ['spin', 0.7], ['pirouette', 0.8],
  ['peek', 1.0], ['sneeze', 1.1], ['startle', 0.8], ['stretch', 1.0], ['wave', 1.0],
  ['cheer', 1.0], ['eyeroll', 0.9], ['knock', 1.0], ['cardStudy', 1.5], ['bounceCard', 1.4], ['present', 1.1],
  // '@' = a longer, extra-cute routine (sing / nap / dance), weighted heavy
  ['@sing', 2.8], ['@sleep', 2.6], ['@dance', 2.6],
];

const BUDDY_NAMES = { spud: 'Spud', taco: 'Taco', sprinkles: 'Sprinkles', bloom: 'Bloom', mochi: 'Mochi', prof: 'Prof' };

const stage = document.getElementById('hero-stage');
const canvas = document.getElementById('hero-canvas');
const fallback = document.getElementById('hero-fallback');
const waking = document.getElementById('hero-waking');
const singing = document.getElementById('hero-singing');
const sleeping = document.getElementById('hero-sleeping');

let mod = null;
let scene = null;
let ready = false;
let drag = null;
let busyUntil = 0;
let tapHist = [];
let cardI = 0;
let skitTO = [];

function buddyName() { return BUDDY_NAMES[HERO_BUDDY] || 'Spud'; }

function applyCard(i) {
  if (!scene || !scene.setCard) return;
  const c = CARD_DECK[((i % CARD_DECK.length) + CARD_DECK.length) % CARD_DECK.length];
  scene.setCard({ top: c.top, main: c.main, footR: '— ' + buddyName(), gold: !!c.gold });
}

function advanceCard() {
  if (!scene) return;
  cardI = (cardI + 1) % CARD_DECK.length;
  applyCard(cardI);
  const c = CARD_DECK[cardI];
  // the rare golden line gets handed toward you — but not mid-action
  if (c && c.gold && ready && performance.now() >= busyUntil) {
    scene.animator.play('present');
    busyUntil = performance.now() + 2400;
  }
}

function setSkit(s) {
  singing.style.display = (s === 'sing' || s === 'dance') ? '' : 'none';
  sleeping.style.display = (s === 'sleep') ? '' : 'none';
}

function clearSkit() {
  skitTO.forEach(clearTimeout);
  skitTO = [];
  setSkit(null);
}

function runSkit(name) {
  const s = scene; if (!s) return;
  const A = s.animator;
  clearSkit();
  const at = (ms, fn) => skitTO.push(setTimeout(fn, ms));
  if (name === 'sleep') {
    A.play('stretch');                                   // a big yawn first
    at(1500, () => { A.setMode('doze'); setSkit('sleep'); });         // dozes off, Zzz float up
    at(6600, () => { A.setMode('idle'); A.play('startle'); setSkit(null); }); // wakes with a start
    busyUntil = performance.now() + 7500;
  } else if (name === 'sing') {
    A.setMode('hum'); setSkit('sing');                   // sways on the beat, ♪ notes
    at(3000, () => A.play('cheer'));                      // a little chorus climax
    at(5800, () => { A.setMode('idle'); setSkit(null); });
    busyUntil = performance.now() + 6000;
  } else if (name === 'dance') {
    A.setMode('hum'); setSkit('dance');
    at(0, () => A.play('hop'));
    at(800, () => A.play('spin'));
    at(1700, () => A.play('hop'));
    at(2500, () => A.play('pirouette'));
    at(3700, () => A.play('cheer'));
    at(5000, () => { A.setMode('idle'); setSkit(null); });
    busyUntil = performance.now() + 5200;
  }
}

function playTapReaction() {
  const s = scene; if (!s) return;
  const pool = TAP_POOL.filter(([k]) => !tapHist.includes(k));
  const total = pool.reduce((a, kw) => a + kw[1], 0);
  let r = Math.random() * total;
  let name = pool[0][0];
  for (const [k, w] of pool) { r -= w; if (r <= 0) { name = k; break; } }
  tapHist = [name, ...tapHist].slice(0, 3);
  if (name[0] === '@') { runSkit(name.slice(1)); return; }
  s.animator.play(name);
  const clips = mod && mod.CLIPS;
  const clip = name === 'wobble' ? (mod && mod.WOBBLE) : (clips && clips[name]);
  // gate further taps for the full length of whatever just played (+ a short tail)
  busyUntil = performance.now() + (clip ? clip.dur : 900) + 200;
}

/* ── pointer wiring (facePoint on hover, spin on drag, tap → reaction) ── */
stage.addEventListener('pointermove', (e) => {
  const s = scene; if (!s) return;
  const rect = stage.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  if (drag && drag.on) {
    const dx = e.clientX - drag.x;
    drag.x = e.clientX;
    drag.moved += Math.abs(dx);
    s.animator.dragBy(dx);
  } else {
    s.animator.facePoint(nx, ny * 0.6);
  }
});
stage.addEventListener('pointerdown', (e) => {
  const s = scene; if (!s) return;
  drag = { on: true, x: e.clientX, moved: 0 };
  s.animator.setDragging(true);
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
});
stage.addEventListener('pointerup', () => {
  const s = scene; if (!s) return;
  if (drag && drag.moved < 5 && performance.now() >= busyUntil) playTapReaction();
  drag = null;
  s.animator.setDragging(false);
});
stage.addEventListener('pointerleave', () => {
  const s = scene; if (!s) return;
  drag = null;
  s.animator.setDragging(false);
});

async function ensureScene() {
  try {
    mod = await import('./lib/spud-scene2.js');
    scene = new mod.PetScene(canvas, { cameraSway: true, card: true });
    scene.animator.idleLife = true;
    await scene.setCharacter(HERO_BUDDY);
    applyCard(0);
    const ro = new ResizeObserver(() => { if (scene) scene.resize(); });
    ro.observe(stage);
    scene.resize();
    ready = true;
    waking.style.display = 'none';
    setInterval(advanceCard, 4200);
  } catch (e) {
    // WebGL unavailable or model failed — fall back to the still render
    console.error('Spuddy hero init failed:', e);
    canvas.style.display = 'none';
    waking.style.display = 'none';
    fallback.style.display = '';
  }
}

// Respect reduced-motion: keep the still image, skip the live scene.
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduce) {
  canvas.style.display = 'none';
  waking.style.display = 'none';
  fallback.style.display = '';
} else {
  ensureScene();
}
