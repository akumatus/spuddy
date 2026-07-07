// The small one-shot popups: daily / golden card, care cards, the draw
// animation and the golden-weave spinner.
import { CHARS } from '../content';
import type { AppState } from '../types';
import { esc, openOverlay } from './overlay';

function cardFont(msg: string): number {
  const n = (msg || '').length;
  return n < 70 ? 31 : n < 110 ? 26 : 22;
}

// the card being offered, decoupled from what's rendered on the potato so a
// draw can be declined without touching it
export interface CardView {
  msg: string;
  rare: boolean;
  keptToday: boolean;
}

export interface CardActions {
  onKeep: () => void;
  onLater: () => void;
}

// Daily / golden card modal.
export function showCard(state: AppState, view: CardView, { onKeep, onLater }: CardActions): void {
  const ch = CHARS.find((c) => c.id === state.active) || CHARS[0];
  const gold = view.rare;
  const keepLabel = view.keptToday ? '♥ Open the Book' : 'Keep it ♥';
  openOverlay(`
    <div class="cardbox ${gold ? 'gold' : ''}">
      ${gold ? `
        <span class="sparkle" style="top:6px;left:14px;font-size:18px;">✦</span>
        <span class="sparkle" style="top:22px;right:20px;font-size:13px;animation-delay:.5s;">✦</span>
        <span class="sparkle" style="bottom:30px;left:24px;font-size:12px;animation-delay:.9s;">✦</span>` : ''}
      <div class="inner">
        <img class="avatar" src="./chars/char-${ch.id}.png" alt="" />
        <div class="tag">${gold ? 'RARE · GOLDEN STITCH' : "TODAY'S CARD"}</div>
        <div class="msg" style="font-size:${cardFont(view.msg)}px">${esc(view.msg)}</div>
        <div class="sign">— ${ch.name} · day ${state.day}</div>
        <div class="row">
          <button class="btn ${view.keptToday ? 'golddash' : 'dark'}" id="mKeep">${keepLabel}</button>
          <button class="btn ghost" id="mLater">Later</button>
        </div>
      </div>
    </div>`);
  document.getElementById('mKeep')!.onclick = onKeep;
  document.getElementById('mLater')!.onclick = onLater;
}

// Care card (night / stretch), one thanks button
export function showCareCard(state: AppState, tag: string, msg: string, onClose: () => void): void {
  const ch = CHARS.find((c) => c.id === state.active) || CHARS[0];
  openOverlay(`
    <div class="cardbox">
      <div class="inner">
        <img class="avatar" src="./chars/char-${ch.id}.png" alt="" />
        <div class="tag">${esc(tag)}</div>
        <div class="msg" style="font-size:${cardFont(msg)}px">${esc(msg)}</div>
        <button class="btn dark" id="mThanks">Thanks, ${ch.name} ♥</button>
      </div>
    </div>`);
  document.getElementById('mThanks')!.onclick = onClose;
}

export function showDrawAnim(): void {
  openOverlay(`
    <div class="drawback">
      <div class="inner">
        <div class="ring">♥</div>
        <div class="label">today's card</div>
        <div class="brand">SPUDDY</div>
      </div>
    </div>`);
}

export function showWeave(line: string): void {
  openOverlay(`
    <div class="weavebox">
      <div class="inner">
        <div class="spinner"><span class="orbit"></span><span class="ball"></span></div>
        <div class="line" id="weaveLine">${esc(line)}</div>
        <div class="brand">GOLDEN STITCH IN PROGRESS</div>
      </div>
    </div>`);
}

export function setWeaveLine(line: string): void {
  const el = document.getElementById('weaveLine');
  if (el) el.textContent = line;
}
