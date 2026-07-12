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

// gold running-stitch for the "knit into Memory" chat tag (design §1a)
const YARN =
  '<svg class="yarn" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 10 C5 4.5 8 11.5 14 5.5" stroke="#C9A227" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2.4"/></svg>';

// Potato doodles for the memory quilt, one per category, taken verbatim from
// the design file (claude-design/project/Card Book 重设计.dc.html, §1c quilt +
// §1d spec). Same round potato every time; the accessory names the category —
// a heart on the rim for people & pets, a trail of sigh-bubbles for feelings,
// a briefcase for work, a sprout for goals, a sparkle for likes, a pennant for
// milestones, a loose ball of yarn for everything else. Rainy patches wear the
// frown; a rainy people-patch trades its heart for the quilt's rain cloud.
const INK = '#3E3226';
const SMILE = '<path d="M29.5 37 Q32 39.5 34.5 37"/>';
const FROWN = '<path d="M29.5 38.5 Q32 37 34.5 38.5"/>';
// stroked doodles ride inside the outline group; filled ones sit after it,
// exactly as the design file layers them
const potato = (stroked: string, filled = '') =>
  `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><g stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 12 C42 12 49 19 51 28 C53 36 49 46 43 50 C38.5 53 34.5 54 32 54 C29.5 54 25.5 53 21 50 C15 46 11 36 13 28 C15 19 22 12 32 12 Z"/>${stroked}</g><circle cx="26" cy="30" r="2.4" fill="${INK}"/><circle cx="38" cy="30" r="2.4" fill="${INK}"/>${filled}</svg>`;

const HEART =
  '<path d="M50 18 C47.5 15.5 44 14 44 10.8 C44 8.9 45.9 8 47.4 8.8 C48.6 9.4 49.5 10.4 50 11.2 C50.5 10.4 51.4 9.4 52.6 8.8 C54.1 8 56 8.9 56 10.8 C56 14 52.5 15.5 50 18 Z" fill="#B9543F"/>';
const RAIN_CLOUD =
  '<path d="M43 5 C47 3 53 3 56 6"/><path d="M46 11 V14.5"/><path d="M51 10 V13.5"/>';
const BUBBLES =
  '<circle cx="45" cy="14" r="2"/><circle cx="50" cy="9" r="2.8"/><circle cx="56" cy="3.5" r="3"/>';
const BRIEFCASE = '<rect x="41" y="7" width="16" height="12" rx="2.5"/><path d="M46 7 V4.5 H52 V7"/>';
const SPROUT =
  '<path d="M32 12 C32 8 32 6 32 3.5"/><path d="M32 7 C28.5 7 26.5 5 25.5 2.5"/><path d="M32 7 C35.5 7 37.5 5 38.5 2.5"/>';
const SPARKLE =
  '<path d="M49 2 L50.8 7.2 L56 9 L50.8 10.8 L49 16 L47.2 10.8 L42 9 L47.2 7.2 Z" fill="#C9A227"/>';
const FLAGPOLE = '<path d="M47 19 V4"/>';
const PENNANT = '<path d="M47 4.5 L57 7.5 L47 10.5 Z" fill="#B9543F"/>';
const YARN_BALL =
  '<circle cx="49" cy="9" r="6"/><path d="M44.5 6.5 C47 8.5 51 8.5 53.5 11.5"/><path d="M44.5 11.5 C47 9.5 51 11.5 53.5 6.5"/>';

const KIND_ART: Record<MemoryKind, { stroked?: string; filled?: string }> = {
  people: { filled: HEART },
  pets: { filled: HEART },
  feeling: { stroked: BUBBLES },
  work: { stroked: BRIEFCASE },
  goal: { stroked: SPROUT },
  likes: { filled: SPARKLE },
  milestone: { stroked: FLAGPOLE, filled: PENNANT },
  other: { stroked: YARN_BALL },
};

function memFace(mood: MemoryMood, kind: MemoryKind): string {
  const rainy = mood === 'rainy';
  if (rainy && (kind === 'people' || kind === 'pets')) return potato(FROWN + RAIN_CLOUD);
  const art = KIND_ART[kind] || KIND_ART.other;
  // the feelings potato frowns even on sunny days — that's its whole face
  const mouth = rainy || kind === 'feeling' ? FROWN : SMILE;
  return potato(mouth + (art.stroked || ''), art.filled || '');
}

// tone stitches from the design: a gold sun on sunny patches, a raindrop on
// rainy ones; plain everyday patches carry no stitch, just the hover ×
const ICON_SUN =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="#C9A227"/><g stroke="#C9A227" stroke-width="1.8" stroke-linecap="round"><path d="M8 1.5 V3.4"/><path d="M8 12.6 V14.5"/><path d="M1.5 8 H3.4"/><path d="M12.6 8 H14.5"/></g></svg>';
const ICON_DROP =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 C10.8 5.4 12 7.9 10.5 10.4 C9.4 12.3 6.6 12.3 5.5 10.4 C4 7.9 5.2 5.4 8 1.5 Z" fill="#8FA3B8"/></svg>';
function memIcon(mood: MemoryMood): string {
  if (mood === 'rainy') return ICON_DROP;
  if (mood === 'plain') return '';
  return ICON_SUN;
}

// short blue seam sewn over the top edge of a rainy patch (design §1c)
const STITCH =
  '<svg class="stitch" viewBox="0 0 26 14" aria-hidden="true"><path d="M2 7 H24" stroke="#8FA3B8" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="4 3"/></svg>';

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
            ${mood === 'rainy' ? STITCH : ''}
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
