// Card Book — the three-tab popup: kept cards, the day-grouped chat
// transcript, and the memory quilt with its doodled faces.
import { TXT } from '../content';
import { zhClass } from '../locale';
import type { AppState, MemoryFact, MemoryKind, MemoryMood } from '../types';
import { esc, modal, openOverlay } from './overlay';

export type BookTab = 'cards' | 'chat' | 'mem';
export type BookFilter = 'all' | 'gold' | 'fav';

export interface BookHandlers {
  onClose: () => void;
  onTab: (t: BookTab) => void;
  onFilter: (f: BookFilter) => void;
  onApply: (i: number) => void;
  onFav: (i: number) => void;
  onDel: (i: number) => void;
  onDelMem: (i: number) => void;
  onClearMem: () => void;
  onClearChat: () => void;
  onClearCards: () => void;
}

// ── Card Book · chat + memory doodles ──
const kindLabel = (id: MemoryKind) => TXT().kindLabels[id] || TXT().kindLabels.other;

// Weekday for a chat day-divider, from the ISO date stamped on the first message
// of that day (local, not UTC — parse the parts so "2026-07-07" reads as TUE here
// rather than shifting a day at the edges). Missing dates just drop the weekday.
// The locale follows the UI language: TUE in English, 周二 in Chinese.
function weekday(dateStr: string | undefined): string {
  const [y, mo, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !mo || !d) return '';
  return new Date(y, mo - 1, d)
    .toLocaleDateString(TXT().ui.weekdayLocale, { weekday: 'short' })
    .toUpperCase();
}

// A memory is a sunny patch, a rainy one, or a plain everyday one — the mood is
// the model's own stamp on its [[remember]] note (see rememberFact in chat.ts).
// Legacy facts predate the stamp; guess conservatively from category — worries
// rainy, milestones sunny, and everything else plain rather than wrongly cheerful.
function memMood(m: MemoryFact): MemoryMood {
  if (m.mood === 'sunny' || m.mood === 'rainy' || m.mood === 'plain') return m.mood;
  return m.kind === 'feeling' ? 'rainy' : m.kind === 'milestone' ? 'sunny' : 'plain';
}

// yarn-and-needle squiggle for the "knit into Memory" chat tag
const YARN =
  '<svg class="yarn" viewBox="0 0 24 16" fill="none" aria-hidden="true"><path d="M2 12C5 4 9 4 12 10s7 2 10-6" stroke="#b8912f" stroke-width="2" stroke-linecap="round"/></svg>';

// Little line-drawn faces for the memory quilt, doodled like the design's
// margin sketches — the accessory grows out of the head itself: a heart perched
// on the rim for someone they love, a pennant planted for milestones, drizzle
// or a trail of sigh-bubbles when the patch is a rainy one.
const INK = '#5a4a34';
const DOODLE_RED = '#c0503c';
const RAIN = '#6e86a8';
const face = (inner: string) =>
  `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="22" cy="26" r="13.5" stroke="${INK}" stroke-width="2"/>${inner}</svg>`;
const eyeDot = (x: number, y = 23.5) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${INK}"/>`;
// a wink: one eye closed in a happy downward arc
const eyeWink = `<path d="M14.5 24q2.3-2.7 4.6 0" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
const smile = `<path d="M17 29.5c2.4 2.8 7.6 2.8 10 0" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
const frown = `<path d="M17.5 31c2.4-2.6 7.3-2.6 9.7 0" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;

const FACE_SUNNY = face(eyeWink + eyeDot(27.5) + smile);
const FACE_SUNNY_HEART = face(
  eyeWink + eyeDot(27.5) + smile +
  `<path transform="rotate(14 34 12)" d="M34 17.5c-4.6-3.6-4.6-7.6-2.3-7.6 1.2 0 2.3 1.5 2.3 1.5s1.1-1.5 2.3-1.5c2.3 0 2.3 4-2.3 7.6z" fill="${DOODLE_RED}"/>`
);
const FACE_MILESTONE = face(
  eyeDot(17) + eyeDot(27.5) +
  `<path d="M17.5 28.5c2.5 3.4 7.5 3.4 10 0" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
  `<path d="M29 13V4.5" stroke="${INK}" stroke-width="2" stroke-linecap="round"/><path d="M29 4.5l7.5 2-7.5 2z" fill="${DOODLE_RED}"/>`
);
const FACE_RAINY = face(
  eyeDot(17, 24.5) + eyeDot(27.5, 24.5) + frown +
  `<path d="M31.5 7.5l-2 4.5M37 10l-2 4.5" stroke="${RAIN}" stroke-width="2" stroke-linecap="round"/>`
);
const FACE_RAINY_SIGH = face(
  eyeDot(17, 24.5) + eyeDot(27.5, 24.5) + frown +
  `<circle cx="30.5" cy="12.5" r="1.4" stroke="${INK}" stroke-width="1.8"/><circle cx="35" cy="8.5" r="2" stroke="${INK}" stroke-width="1.8"/><circle cx="41" cy="4.6" r="2.6" stroke="${INK}" stroke-width="1.8"/>`
);
const FACE_PLAIN = face(eyeDot(17) + eyeDot(27.5) + `<path d="M17.5 29.5h9.5" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`);

function memFace(mood: MemoryMood, kind: MemoryKind): string {
  if (mood === 'rainy') return kind === 'feeling' ? FACE_RAINY_SIGH : FACE_RAINY;
  if (mood === 'plain') return FACE_PLAIN;
  if (kind === 'milestone') return FACE_MILESTONE;
  return kind === 'people' || kind === 'pets' || kind === 'likes' ? FACE_SUNNY_HEART : FACE_SUNNY;
}

// corner marks, matching the design's margin doodles: a little hand-drawn sun
// (dot + four rays) for sunny, a blue drop for rainy, a sewn button for plain
// everyday patches (a cross-stitch read too much like the delete × it swaps
// with on hover)
const ICON_SUN =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="2.4" fill="#c9a227"/><path d="M12 3.5v3.4M12 17.1v3.4M3.5 12h3.4M17.1 12h3.4" stroke="#c9a227" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_DROP =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s-7 8.4-7 12.4a7 7 0 0014 0C19 11.4 12 3 12 3z" fill="#6e86a8"/></svg>';
const ICON_BUTTON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="#c0ab7f" stroke-width="2"/><circle cx="9.4" cy="9.4" r="1.2" fill="#c0ab7f"/><circle cx="14.6" cy="9.4" r="1.2" fill="#c0ab7f"/><circle cx="9.4" cy="14.6" r="1.2" fill="#c0ab7f"/><circle cx="14.6" cy="14.6" r="1.2" fill="#c0ab7f"/></svg>';
function memIcon(mood: MemoryMood): string {
  if (mood === 'rainy') return ICON_DROP;
  if (mood === 'plain') return ICON_BUTTON;
  return ICON_SUN;
}

export function showBook(state: AppState, tab: BookTab, filter: BookFilter, handlers: BookHandlers): void {
  const ui = TXT().ui;
  let body = '';
  if (tab === 'cards') {
    let view = state.cards.map((cd, i) => ({ ...cd, i })).reverse();
    if (filter === 'gold') view = view.filter((c) => c.rare);
    if (filter === 'fav') view = view.filter((c) => c.fav);
    const emptyLine =
      state.cards.length === 0 ? ui.emptyCards : filter === 'gold' ? ui.emptyGold : ui.emptyFav;
    body = `
      <div class="filters">
        <button class="f ${filter === 'all' ? 'on' : ''}" data-filter="all">${ui.filterAll}</button>
        <button class="f ${filter === 'gold' ? 'on' : ''}" data-filter="gold">${ui.filterGold}</button>
        <button class="f ${filter === 'fav' ? 'on' : ''}" data-filter="fav">${ui.filterFav}</button>
      </div>
      ${view.length === 0 ? `<div class="empty">${emptyLine}</div>` : ''}
      <div class="grid">
        ${view
          .map(
            (c) => `
          <div class="ccard ${c.rare ? 'gold' : ''}" data-apply="${c.i}" title="${ui.holdTitle}">
            <div class="acts">
              <button class="fav ${c.fav ? 'on' : ''}" data-fav="${c.i}">♥</button>
              <button class="del" data-del="${c.i}">×</button>
            </div>
            <div class="m ${zhClass(c.m)}">${esc(c.m)}</div>
            <div class="foot"><span>${ui.cardFoot(c.day, esc(c.by))}</span><span class="star">${c.rare ? '✦' : ''}</span></div>
          </div>`
          )
          .join('')}
      </div>
      <div class="bookfoot">
        <span class="hint">${ui.hintCards}</span>
        ${state.cards.length ? `<button class="clear" id="cardsClear">${ui.clearAll}</button>` : ''}
      </div>`;
  } else if (tab === 'chat') {
    // Full transcript, day by day: your lines as bubbles on the right, his in his
    // own handwriting on the left beside his face. A gold "knit into Memory" tag
    // trails the message that revealed a durable fact, so you can see the moment
    // a stitch was made. Dividers break the flow wherever the day rolls over.
    const turns = state.chat || [];
    const spoken = turns.filter((m) => m.who === 'user').length;
    const avatar = `./chars/char-${state.active || 'spud'}.png`;
    let rows = '';
    let lastDay: number | null = null;
    for (const m of turns) {
      const day = typeof m.day === 'number' ? m.day : null;
      if (day !== null && day !== lastDay) {
        rows += `<div class="cday"><span>${ui.dayDivider(day, weekday(m.date))}</span></div>`;
        lastDay = day;
      }
      if (m.who === 'user') {
        const knit = m.mem
          ? `<div class="knit">${YARN} ${ui.knitTag(esc(kindLabel(m.mem)))}</div>`
          : '';
        rows += `<div class="crow user"><div class="ubub ${zhClass(m.text)}">${esc(m.text)}</div>${knit}</div>`;
      } else {
        rows += `<div class="crow pet"><div class="pav" style="background-image:url('${avatar}')"></div><div class="pbub ${zhClass(m.text)}">${esc(m.text)}</div></div>`;
      }
    }
    body = `
      ${turns.length === 0 ? `<div class="empty">${ui.emptyChat}</div>` : ''}
      <div class="chatlog">${rows}</div>
      <div class="bookfoot">
        <span class="hint">${ui.hintChat}</span>
        ${spoken ? `<button class="clear" id="chatClear">${ui.clearAll}</button>` : ''}
      </div>`;
  } else {
    // Memory — the quilt he's making of you. Each distilled fact is its own
    // patch: sunny ones dashed gold, rainy ones dashed blue, a little doodle face
    // wearing the mood, the category stitched on and the day it was kept. Newest
    // first. Hover a patch to unpick it.
    const patches = state.memory
      .map((m, i) => ({ ...m, i }))
      .reverse()
      .map((m) => {
        const mood = memMood(m);
        const kind = m.kind || 'other';
        return `
          <div class="mcard ${mood}">
            <div class="mtop">
              <div class="mface">${memFace(mood, kind)}</div>
              <div class="mmark">
                <span class="micon">${memIcon(mood)}</span>
                <button class="del" data-delmem="${m.i}" title="${ui.unpickTitle}">×</button>
              </div>
            </div>
            <div class="mfact ${zhClass(m.fact)}">${esc(m.fact)}</div>
            <div class="mmeta">
              <span class="kind ${kind}">${esc(kindLabel(kind))}</span>
              <span class="mday">${ui.memDay(m.day)}</span>
            </div>
          </div>`;
      })
      .join('');
    body = `
      ${
        state.memory.length === 0
          ? `<div class="empty">${ui.emptyMem}</div>`
          : `<div class="memhead">${ui.memHead}</div>
             <div class="memgrid">${patches}</div>`
      }
      <div class="bookfoot">
        <span class="hint">${ui.hintMem}</span>
        ${state.memory.length ? `<button class="clear" id="memClear">${ui.clearAll}</button>` : ''}
      </div>`;
  }

  const headInner = `
        <span class="title">${ui.bookTitle}</span>
        <button class="tab ${tab === 'cards' ? 'on' : ''}" data-tab="cards">${ui.tabCards} · ${state.cards.length}</button>
        <button class="tab ${tab === 'chat' ? 'on' : ''}" data-tab="chat">${ui.tabChat}</button>
        <button class="tab ${tab === 'mem' ? 'on' : ''}" data-tab="mem">${ui.tabMem} · ${state.memory.length}</button>
        <button class="close" id="bookClose">×</button>`;

  // Re-render in place while the book is already open. Recreating #book (via
  // openOverlay's innerHTML swap) would replay its pp-cardin entrance animation
  // on every tab switch / delete / fav — that bounce-in reads as a flash. So
  // only swap the head + body content, leaving #book (and its animation) alone.
  const book = document.getElementById('book');
  if (book) {
    book.querySelector('.head')!.innerHTML = headInner;
    while (book.children.length > 1) book.lastElementChild!.remove();
    book.insertAdjacentHTML('beforeend', body);
  } else {
    openOverlay(`
      <div id="book">
        <div class="head">${headInner}</div>
        ${body}
      </div>`);
  }

  document.getElementById('bookClose')!.onclick = handlers.onClose;
  modal().querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.onclick = () => handlers.onTab(b.dataset.tab as BookTab)));
  modal().querySelectorAll<HTMLElement>('[data-filter]').forEach((b) => (b.onclick = () => handlers.onFilter(b.dataset.filter as BookFilter)));
  modal().querySelectorAll<HTMLElement>('[data-apply]').forEach((b) => (b.onclick = () => handlers.onApply(+b.dataset.apply!)));
  // fav / del sit on top of the card — stop the click from also "applying" it
  modal().querySelectorAll<HTMLElement>('[data-fav]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); handlers.onFav(+b.dataset.fav!); }));
  modal().querySelectorAll<HTMLElement>('[data-del]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); handlers.onDel(+b.dataset.del!); }));
  modal().querySelectorAll<HTMLElement>('[data-delmem]').forEach((b) => (b.onclick = () => handlers.onDelMem(+b.dataset.delmem!)));
  const mc = document.getElementById('memClear');
  if (mc) mc.onclick = handlers.onClearMem;
  const cc = document.getElementById('cardsClear');
  if (cc) cc.onclick = handlers.onClearCards;
  const chc = document.getElementById('chatClear');
  if (chc) chc.onclick = handlers.onClearChat;
}
