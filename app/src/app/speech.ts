// Speech presentation: the reply bubble, the dashed mutter (inner monologue)
// card, and the floating emotes (♪ ♥ Z) drifting off his head (7a).
// Both cards are pointer-events:none — they float over other apps' windows, so
// they must never eat the desktop's clicks (which also retired the old
// hover-to-freeze-auto-hide behavior).
import { isOverlayOpen } from '../ui/overlay';
import { $, ctx } from './context';

let bubbleTimer = 0;
let typeTimer = 0;
let mutterTimer = 0;

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
  const life = hold ? hold + (type ? text.length * 15 : 0) : 0;
  if (life) bubbleTimer = window.setTimeout(() => el.classList.add('hidden'), life);
}

export function hideBubble(): void {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('bubble').classList.add('hidden');
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
  mutterTimer = window.setTimeout(() => el.classList.add('hidden'), 2300 + text.length * 40);
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
