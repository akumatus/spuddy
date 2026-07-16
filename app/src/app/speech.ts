// Speech presentation: the reply bubble, the dashed mutter (inner monologue)
// card, and the floating emotes (♪ ♥ Z) drifting off his head (7a).
// Both cards are pointer-events:none — they float over other apps' windows, so
// they must never eat the desktop's clicks (which also retired the old
// hover-to-freeze-auto-hide behavior).
import { hasHan } from '../locale';
import { isOverlayOpen } from '../ui/overlay';
import { $, ctx } from './context';

let bubbleTimer = 0;
let typeTimer = 0;
let mutterTimer = 0;
// A mutter is protected for its full reading dwell: while one is still on
// screen, a newly triggered line doesn't yank it away — it waits in this single
// slot (latest wins) and paints the moment the current line has had its dwell.
// Without this, an idle mutter + a routine's opening line (fired ~200ms apart)
// would flash the first away before it could be read.
let mutterHideAt = 0; // perf-time the current mutter is protected until
let pendingMutter: string | null = null;

// ── keep the head cards on screen ──
// Both cards hang over the potato's head, centered on the stage — but the
// window rides wherever he's dragged and can hang off a screen edge, so the
// centered spot may fall on the offscreen strip (or, at full lift, above the
// window's top). Measure the layout spot when a card pops, clamp it into
// view, and carry the shift in --shift so the ::after tail can counter-shift
// and keep pointing at him. offsetLeft/Top are used instead of the element's
// own rect because the pop-in keyframes scale it mid-animation; xAnchor covers
// transform-based centering (the mutter's translateX(-50%)), which offsetLeft
// doesn't see.
const EDGE = 10; // breathing room against screen/window edges

function clampOverhead(el: HTMLElement, xAnchor: number): void {
  const stage = $('stage').getBoundingClientRect(); // includes the lift transform
  const scr = screen as Screen & { availLeft?: number; availTop?: number };
  // the window's on-screen strip, in window coords
  const visL = Math.max((scr.availLeft ?? 0) - window.screenX, 0);
  const visR = Math.min((scr.availLeft ?? 0) + scr.availWidth - window.screenX, window.innerWidth);
  const visT = Math.max((scr.availTop ?? 0) - window.screenY, 0);
  const left = stage.left + el.offsetLeft - el.offsetWidth * xAnchor;
  const shiftX = Math.max(visL + EDGE, Math.min(left, visR - EDGE - el.offsetWidth)) - left;
  const shiftY = Math.max(visT + EDGE - (stage.top + el.offsetTop), 0); // only ever pushed down
  el.style.translate = `${shiftX}px ${shiftY}px`; // separate property — the keyframes own `transform`
  el.style.setProperty('--shift', `${shiftX}px`);
}

// Both cards are width:max-content clamped by max-width, so once the text
// wraps, the box sticks at the clamp while the last break may land well short
// of it — CJK kinsoku (。can't open a line) pulls breaks a full hanzi or two
// early, leaving a blank strip against the right border. Re-measure the laid
// out line boxes and hug the widest one. Must run while the pop-in animation
// is suppressed: Range rects are viewport-space, and the keyframes scale the
// element mid-flight.
function hugText(el: HTMLElement): void {
  el.style.width = ''; // measure at the natural clamp, not last message's hug
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = Array.from(range.getClientRects());
  if (lines.length < 2) return; // a single line already hugs
  const text = Math.max(...lines.map((r) => r.width));
  const cs = getComputedStyle(el);
  const chrome =
    parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  // +1 so subpixel rounding can't re-wrap the widest line (width is border-box)
  el.style.width = `${Math.ceil(text + chrome) + 1}px`;
}

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
  el.textContent = text; // even for typewriter: the clamp measures the final size
  el.style.animation = 'none'; // freeze the pop-in while hugText reads rects
  hugText(el);
  clampOverhead(el, 0); // auto-margin centering is plain layout — no transform share
  void el.offsetWidth; // restart the pop-in
  el.style.animation = '';
  // reading dwell scales with length so long replies stay up long enough to
  // read; hold is the floor for short lines. Start the countdown only once the
  // typewriter finishes, so the reveal never eats into the reading window.
  const dwell = hold ? hold + text.length * 55 : 0;
  const startHide = () => {
    if (dwell) bubbleTimer = window.setTimeout(() => el.classList.add('hidden'), dwell);
  };
  if (type) {
    let i = 0;
    el.textContent = '';
    typeTimer = window.setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length + 1) {
        clearInterval(typeTimer);
        startHide();
      }
    }, 30);
  } else {
    startHide();
  }
}

export function hideBubble(): void {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('bubble').classList.add('hidden');
}

// ── mutter — dashed thought bubble for the inner monologue (7a) ──
function mutterBlocked(): boolean {
  return !!(ctx.anim().tucked || ctx.anim().docked || isOverlayOpen() || ctx.chatBusy || ctx.weaving);
}

function paintMutter(text: string): void {
  const el = $('mutter');
  clearTimeout(mutterTimer);
  el.textContent = text;
  el.classList.toggle('zh', hasHan(text)); // mutter pools are per-language; size by the line itself
  el.classList.remove('hidden');
  el.style.animation = 'none'; // freeze the pop-in while hugText reads rects
  hugText(el);
  clampOverhead(el, 0.5); // centered by translateX(-50%), invisible to offsetLeft
  void el.offsetWidth; // restart the pop-in
  el.style.animation = '';
  const dwell = 2800 + text.length * 75; // reading window scales with length
  mutterHideAt = performance.now() + dwell;
  mutterTimer = window.setTimeout(() => {
    // hand off to a line that queued up while this one was being read, unless
    // speech / an overlay has since taken the stage — else just fade out
    if (pendingMutter !== null && $('bubble').classList.contains('hidden') && !mutterBlocked()) {
      const next = pendingMutter; pendingMutter = null;
      paintMutter(next);
    } else {
      pendingMutter = null;
      el.classList.add('hidden');
    }
  }, dwell);
}

export function showMutter(text: string): void {
  if (mutterBlocked()) return;
  if (!$('bubble').classList.contains('hidden')) return; // speech first
  // Don't pull a line out from under the reader: while the current mutter is
  // still inside its reading window, park this one (latest wins) to paint the
  // moment the current line has had its full dwell.
  const el = $('mutter');
  if (!el.classList.contains('hidden') && performance.now() < mutterHideAt) {
    pendingMutter = text;
    return;
  }
  paintMutter(text);
}

// ── floating emotes (♪ ♥ Z) drifting off his head (7a) ──
export function spawnEmote(g: string): void {
  if (ctx.anim().tucked || ctx.anim().docked || document.visibilityState === 'hidden') return;
  const el = document.createElement('span');
  el.className = 'em';
  el.textContent = g === 'z' ? 'Z' : g;
  el.style.left = `${40 + Math.random() * 22}%`;
  $('emotes').appendChild(el);
  setTimeout(() => el.remove(), 1900);
}
