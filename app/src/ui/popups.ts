// The small one-shot popups: daily / golden card, care cards, the draw
// animation and the golden-weave spinner.
import { CHARS, TXT } from '../content';
import { hasHan, zhClass } from '../locale';
import type { AppState } from '../types';
import { esc, openOverlay } from './overlay';

// CJK carries ~2× the message per character, so Chinese lines hit the same
// visual length at about half the count — size by the CJK thresholds then.
function cardFont(msg: string): number {
  const s = msg || '';
  const n = s.length;
  // CJK handwriting renders heavier than Caveat, so size Chinese a notch below
  // the Latin sizes (matches the html.zh trims elsewhere); the card box always
  // fits it since smaller only helps.
  if (hasHan(s)) return n < 30 ? 26 : n < 48 ? 22 : 18;
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
  const ui = TXT().ui;
  const ch = CHARS.find((c) => c.id === state.active) || CHARS[0];
  const gold = view.rare;
  const keepLabel = view.keptToday ? ui.openTheBook : ui.keepIt;
  openOverlay(`
    <div class="cardbox ${gold ? 'gold' : ''}">
      ${gold ? `
        <span class="sparkle" style="top:6px;left:14px;font-size:18px;">✦</span>
        <span class="sparkle" style="top:22px;right:20px;font-size:13px;animation-delay:.5s;">✦</span>
        <span class="sparkle" style="bottom:30px;left:24px;font-size:12px;animation-delay:.9s;">✦</span>` : ''}
      <div class="inner">
        <img class="avatar" src="./chars/char-${ch.id}.png" alt="" />
        <div class="tag">${gold ? ui.goldenTag : ui.todaysCardTag}</div>
        <div class="msg ${zhClass(view.msg)}" style="font-size:${cardFont(view.msg)}px">${esc(view.msg)}</div>
        <div class="sign">${ui.signDay(ch.name, state.day)}</div>
        <div class="row">
          <button class="btn ${view.keptToday ? 'golddash' : 'dark'}" id="mKeep">${keepLabel}</button>
          <button class="btn ghost" id="mLater">${ui.later}</button>
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
        <div class="msg ${zhClass(msg)}" style="font-size:${cardFont(msg)}px">${esc(msg)}</div>
        <button class="btn dark" id="mThanks">${TXT().ui.thanks(ch.name)}</button>
      </div>
    </div>`);
  document.getElementById('mThanks')!.onclick = onClose;
}

export function showDrawAnim(): void {
  openOverlay(`
    <div class="drawback">
      <div class="inner">
        <div class="ring">♥</div>
        <div class="label">${TXT().ui.drawLabel}</div>
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
        <div class="brand">${TXT().ui.weaveBrand}</div>
      </div>
    </div>`);
}

export function setWeaveLine(line: string): void {
  const el = document.getElementById('weaveLine');
  if (el) el.textContent = line;
}
