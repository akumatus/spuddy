// Speech presentation: the reply bubble, the dashed mutter (inner monologue)
// card, and the floating emotes (♪ ♥ Z) drifting off his head (7a).
import { isOverlayOpen } from '../ui/overlay';
import { $, ctx } from './context';

let bubbleTimer = 0;
let typeTimer = 0;
let mutterTimer = 0;
let bubbleHover = false; // pointer resting on the reply — freeze its auto-hide
let bubbleHold = 0; // full lifespan of the current bubble, so hover can resume it
let mutterHover = false; // pointer resting on the thought card — freeze its auto-hide
let mutterHold = 0; // lifespan of the current mutter, so hover can resume it

export interface BubbleOpts {
  hold?: number;
  type?: boolean; // typewriter reveal
}

// ── bubble ──
export function bubble(text: string, { hold = 2600, type = false }: BubbleOpts = {}): void {
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
    typeTimer = window.setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length + 1) clearInterval(typeTimer);
    }, 30);
  }
  bubbleHold = hold ? hold + (type ? text.length * 15 : 0) : 0;
  // while the pointer rests on the reply we leave it up — hoverEnd resumes the countdown
  if (bubbleHold && !bubbleHover) bubbleTimer = window.setTimeout(() => el.classList.add('hidden'), bubbleHold);
}

export function hideBubble(): void {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('bubble').classList.add('hidden');
}

// Reading a reply shouldn't race a timer: hovering the bubble freezes its
// auto-hide, and pulling the pointer away lets it linger a beat, then go.
export function setBubbleHover(on: boolean): void {
  if (on === bubbleHover) return;
  bubbleHover = on;
  const el = $('bubble');
  if (el.classList.contains('hidden') || !bubbleHold) return;
  clearTimeout(bubbleTimer);
  if (!on) bubbleTimer = window.setTimeout(() => el.classList.add('hidden'), 700);
}

// ── mutter — dashed thought bubble for the inner monologue (7a) ──
export function showMutter(text: string): void {
  if (ctx.anim().tucked || ctx.anim().asleep || isOverlayOpen() || ctx.chatBusy || ctx.weaving) return;
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
  if (!mutterHover) mutterTimer = window.setTimeout(() => el.classList.add('hidden'), mutterHold);
}

// Hovering the thought card freezes its auto-hide the same way the reply bubble
// does; pulling the pointer away lets it linger a beat, then go.
export function setMutterHover(on: boolean): void {
  if (on === mutterHover) return;
  mutterHover = on;
  const el = $('mutter');
  if (el.classList.contains('hidden') || !mutterHold) return;
  clearTimeout(mutterTimer);
  if (!on) mutterTimer = window.setTimeout(() => el.classList.add('hidden'), 700);
}

// ── floating emotes (♪ ♥ Z) drifting off his head (7a) ──
export function spawnEmote(g: string): void {
  if (ctx.anim().tucked || ctx.anim().asleep || document.visibilityState === 'hidden') return;
  const el = document.createElement('span');
  el.className = 'em';
  el.textContent = g === 'z' ? 'Z' : g;
  el.style.left = `${40 + Math.random() * 22}%`;
  $('emotes').appendChild(el);
  setTimeout(() => el.remove(), 1900);
}
