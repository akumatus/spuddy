import { CHARS, UNLOCK, PERS, MEMORY_KINDS } from './content.js';
import { counts } from './store.js';

const overlay = () => document.getElementById('overlay');
const modal = () => document.getElementById('modal');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Card Book · chat + memory doodles ──
const KIND_LABEL = Object.fromEntries(MEMORY_KINDS.map((k) => [k.id, k.label]));
const kindLabel = (id) => KIND_LABEL[id] || 'Memory';

// Weekday for a chat day-divider, from the ISO date stamped on the first message
// of that day (local, not UTC — parse the parts so "2026-07-07" reads as TUE here
// rather than shifting a day at the edges). Missing dates just drop the weekday.
function weekday(dateStr) {
  const [y, mo, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !mo || !d) return '';
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
}

// A memory is a sunny patch, a rainy one, or a plain everyday one — the mood is
// the model's own stamp on its [[remember]] note (see rememberFact in main.js).
// Legacy facts predate the stamp; guess conservatively from category — worries
// rainy, milestones sunny, and everything else plain rather than wrongly cheerful.
function memMood(m) {
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
const face = (inner) =>
  `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="22" cy="26" r="13.5" stroke="${INK}" stroke-width="2"/>${inner}</svg>`;
const eyeDot = (x, y = 23.5) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${INK}"/>`;
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

function memFace(mood, kind) {
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
function memIcon(mood) {
  if (mood === 'rainy') return ICON_DROP;
  if (mood === 'plain') return ICON_BUTTON;
  return ICON_SUN;
}

const stageEl = () => document.getElementById('stage');
const panelEl = () => document.getElementById('hoverpanel');

// ── modal window choreography ──
// The pet window is small and sits wherever the user dragged the potato; a
// modal expands it to the full work area so the popup can center on screen.
// The stage is anchored right/bottom INSIDE the window, so the resize alone
// would teleport the potato to the screen corner. Instead of hiding him
// (earlier fix — he vanished for the whole modal), offset the stage by the
// window→work-area edge gap so he holds his exact on-screen spot, and order
// each step around actual paints/resizes so no frame catches him mid-jump.
let modalUp = false;
let modalSeq = 0; // open/close generation — stale async steps bail out

const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const resizedOrTimeout = (ms) =>
  new Promise((r) => {
    const done = () => { clearTimeout(t); window.removeEventListener('resize', done); r(); };
    const t = setTimeout(done, ms);
    window.addEventListener('resize', done, { once: true });
  });

async function expandForModal(seq) {
  const g = await (window.pp?.win?.modalGeometry?.() ?? null);
  if (seq !== modalSeq) return;
  if (g) {
    const st = stageEl().style;
    st.right = `${16 + g.dx}px`;
    st.bottom = `${g.dy}px`;
    await painted(); // the offset stage is on screen before the window grows
    if (seq !== modalSeq) return;
    window.pp.win.setModal(true);
    await resizedOrTimeout(250); // and the popup only shows once it can center
    if (seq !== modalSeq) return;
  }
  overlay().classList.remove('hidden');
}

// ── draggable popups ──
// Offset #modal (the popup wrapper) with a transform; #overlay's flex keeps it
// centered, so the transform is a pure delta from center. Grab any non-control
// part of a popup to drag it anywhere; buttons, inputs and cards keep their own
// clicks. isDraggingModal() lets main.js hold the window mouse-active mid-drag.
let dragOff = { x: 0, y: 0 };
let draggingModal = false;
export function isDraggingModal() {
  return draggingModal;
}
function resetModalDrag() {
  dragOff = { x: 0, y: 0 };
  modal().style.transform = '';
}
function initModalDrag() {
  const m = modal();
  if (m.dataset.dragInit) return; // #modal persists across popups — wire once
  m.dataset.dragInit = '1';
  let from = null;
  const NODRAG = 'button, input, textarea, select, a, [data-apply], [data-pick]';
  m.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest(NODRAG)) return;
    from = { x: e.clientX, y: e.clientY, ox: dragOff.x, oy: dragOff.y };
    draggingModal = true;
    m.classList.add('dragging');
    m.setPointerCapture(e.pointerId);
  });
  m.addEventListener('pointermove', (e) => {
    if (!from) return;
    dragOff = { x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) };
    m.style.transform = `translate(${dragOff.x}px, ${dragOff.y}px)`;
  });
  const end = (e) => {
    if (!from) return;
    from = null;
    draggingModal = false;
    m.classList.remove('dragging');
    try { m.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  m.addEventListener('pointerup', end);
  m.addEventListener('pointercancel', end);
}

// Every popup floats over the live desktop — no dim backdrop, and the area
// around it stays click-through (see the mousemove handler in main.js) so the
// rest of the screen stays usable. `panel` stays a hook (pass false for a dim,
// blocking modal) but every popup now defaults to the floating, draggable look.
export function openOverlay(html, { panel = true } = {}) {
  initModalDrag();
  modal().innerHTML = html;
  overlay().classList.toggle('panel', panel);
  if (modalUp) { overlay().classList.remove('hidden'); return; } // draw → weave → card chain: window already big
  modalUp = true;
  resetModalDrag(); // a fresh popup opens centered, not where the last was left
  // Hide the hover panel instantly. It's anchored bottom:78px INSIDE the window
  // but isn't offset like the stage, so when the window expands to fullscreen it
  // reflows to the taller window's bottom and visibly drops for a beat before the
  // dim overlay covers it. It sits behind the dim anyway, so just take it out.
  panelEl().classList.remove('show');
  panelEl().classList.add('hidden');
  expandForModal(++modalSeq);
}

export function closeOverlay() {
  const seq = ++modalSeq;
  modalUp = false;
  overlay().classList.add('hidden');
  overlay().classList.remove('panel');
  modal().innerHTML = '';
  resetModalDrag();
  window.pp?.win?.setModal(false);
  // release the stage offset only after the window is small again — resetting
  // early would flash the potato at the fullscreen corner for a frame
  const release = () => {
    if (seq !== modalSeq) return;
    const st = stageEl().style;
    st.right = '';
    st.bottom = '';
    panelEl().classList.remove('hidden'); // back to hover-gated (stays hidden until next hover)
  };
  window.addEventListener('resize', () => requestAnimationFrame(release), { once: true });
  setTimeout(release, 300); // fallback if no resize event fires
}

export function isOverlayOpen() {
  return !overlay().classList.contains('hidden');
}

function cardFont(msg) {
  const n = (msg || '').length;
  return n < 70 ? 31 : n < 110 ? 26 : 22;
}

// Daily / golden card modal. actions: {onKeep, onLater}
// view = { msg, rare, keptToday } — the card being offered, decoupled from
// what's rendered on the potato so a draw can be declined without touching it.
export function showCard(state, view, { onKeep, onLater }) {
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
  document.getElementById('mKeep').onclick = onKeep;
  document.getElementById('mLater').onclick = onLater;
}

// Care card (night / stretch), one thanks button
export function showCareCard(state, tag, msg, onClose) {
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
  document.getElementById('mThanks').onclick = onClose;
}

export function showDrawAnim() {
  openOverlay(`
    <div class="drawback">
      <div class="inner">
        <div class="ring">♥</div>
        <div class="label">today's card</div>
        <div class="brand">SPUDDY</div>
      </div>
    </div>`);
}

export function showWeave(line) {
  openOverlay(`
    <div class="weavebox">
      <div class="inner">
        <div class="spinner"><span class="orbit"></span><span class="ball"></span></div>
        <div class="line" id="weaveLine">${esc(line)}</div>
        <div class="brand">GOLDEN STITCH IN PROGRESS</div>
      </div>
    </div>`);
}

export function setWeaveLine(line) {
  const el = document.getElementById('weaveLine');
  if (el) el.textContent = line;
}

// ── Card Book ──
// handlers: {onClose, onTab, onFilter, onApply, onFav, onDel, onDelMem, onClearMem}
export function showBook(state, tab, filter, handlers) {
  let body = '';
  if (tab === 'cards') {
    let view = state.cards.map((cd, i) => ({ ...cd, i })).reverse();
    if (filter === 'gold') view = view.filter((c) => c.rare);
    if (filter === 'fav') view = view.filter((c) => c.fav);
    const emptyLine =
      state.cards.length === 0
        ? "No cards yet — tap your buddy for today's draw."
        : filter === 'gold'
          ? 'No golden cards yet — weave one.'
          : 'No favorites yet — tap the ♥ on a card.';
    body = `
      <div class="filters">
        <button class="f ${filter === 'all' ? 'on' : ''}" data-filter="all">all</button>
        <button class="f ${filter === 'gold' ? 'on' : ''}" data-filter="gold">golden ✦</button>
        <button class="f ${filter === 'fav' ? 'on' : ''}" data-filter="fav">favorites ♥</button>
      </div>
      ${view.length === 0 ? `<div class="empty">${emptyLine}</div>` : ''}
      <div class="grid">
        ${view
          .map(
            (c) => `
          <div class="ccard ${c.rare ? 'gold' : ''}" data-apply="${c.i}" title="hold this one">
            <div class="acts">
              <button class="fav ${c.fav ? 'on' : ''}" data-fav="${c.i}">♥</button>
              <button class="del" data-del="${c.i}">×</button>
            </div>
            <div class="m">${esc(c.m)}</div>
            <div class="foot"><span>day ${c.day} — ${esc(c.by)}</span><span class="star">${c.rare ? '✦' : ''}</span></div>
          </div>`
          )
          .join('')}
      </div>
      <div class="bookfoot">
        <span class="hint">your kept cards — clear them anytime</span>
        ${state.cards.length ? '<button class="clear" id="cardsClear">clear all</button>' : ''}
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
    let lastDay = null;
    for (const m of turns) {
      const day = typeof m.day === 'number' ? m.day : null;
      if (day !== null && day !== lastDay) {
        const wd = weekday(m.date);
        rows += `<div class="cday"><span>DAY ${day}${wd ? ` · ${wd}` : ''}</span></div>`;
        lastDay = day;
      }
      if (m.who === 'user') {
        const knit = m.mem
          ? `<div class="knit">${YARN} knit into Memory · ${esc(kindLabel(m.mem))}</div>`
          : '';
        rows += `<div class="crow user"><div class="ubub">${esc(m.text)}</div>${knit}</div>`;
      } else {
        rows += `<div class="crow pet"><div class="pav" style="background-image:url('${avatar}')"></div><div class="pbub">${esc(m.text)}</div></div>`;
      }
    }
    body = `
      ${turns.length === 0 ? `<div class="empty">No messages yet — say hi and he'll answer.</div>` : ''}
      <div class="chatlog">${rows}</div>
      <div class="bookfoot">
        <span class="hint">every word, kept — clearing wipes his context, not his memory of you</span>
        ${spoken ? '<button class="clear" id="chatClear">clear all</button>' : ''}
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
                <button class="del" data-delmem="${m.i}" title="unpick this stitch">×</button>
              </div>
            </div>
            <div class="mfact">${esc(m.fact)}</div>
            <div class="mmeta">
              <span class="kind ${kind}">${esc(kindLabel(kind))}</span>
              <span class="mday">DAY ${m.day}</span>
            </div>
          </div>`;
      })
      .join('');
    body = `
      ${
        state.memory.length === 0
          ? `<div class="empty">Nothing here yet — the more you tell him about your life, the more he'll remember, and knit into your golden cards.</div>`
          : `<div class="memhead">the quilt he's making of you — sunny patches and rainy ones, all kept</div>
             <div class="memgrid">${patches}</div>`
      }
      <div class="bookfoot">
        <span class="hint">his picture of you — unpick any stitch, anytime</span>
        ${state.memory.length ? '<button class="clear" id="memClear">clear all</button>' : ''}
      </div>`;
  }

  const headInner = `
        <span class="title">Card Book</span>
        <button class="tab ${tab === 'cards' ? 'on' : ''}" data-tab="cards">Cards · ${state.cards.length}</button>
        <button class="tab ${tab === 'chat' ? 'on' : ''}" data-tab="chat">Chat</button>
        <button class="tab ${tab === 'mem' ? 'on' : ''}" data-tab="mem">Memory · ${state.memory.length}</button>
        <button class="close" id="bookClose">×</button>`;

  // Re-render in place while the book is already open. Recreating #book (via
  // openOverlay's innerHTML swap) would replay its pp-cardin entrance animation
  // on every tab switch / delete / fav — that bounce-in reads as a flash. So
  // only swap the head + body content, leaving #book (and its animation) alone.
  const book = document.getElementById('book');
  if (book) {
    book.querySelector('.head').innerHTML = headInner;
    while (book.children.length > 1) book.lastElementChild.remove();
    book.insertAdjacentHTML('beforeend', body);
  } else {
    openOverlay(`
      <div id="book">
        <div class="head">${headInner}</div>
        ${body}
      </div>`);
  }

  document.getElementById('bookClose').onclick = handlers.onClose;
  modal().querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => handlers.onTab(b.dataset.tab)));
  modal().querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => handlers.onFilter(b.dataset.filter)));
  modal().querySelectorAll('[data-apply]').forEach((b) => (b.onclick = () => handlers.onApply(+b.dataset.apply)));
  // fav / del sit on top of the card — stop the click from also "applying" it
  modal().querySelectorAll('[data-fav]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); handlers.onFav(+b.dataset.fav); }));
  modal().querySelectorAll('[data-del]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); handlers.onDel(+b.dataset.del); }));
  modal().querySelectorAll('[data-delmem]').forEach((b) => (b.onclick = () => handlers.onDelMem(+b.dataset.delmem)));
  const mc = document.getElementById('memClear');
  if (mc) mc.onclick = handlers.onClearMem;
  const cc = document.getElementById('cardsClear');
  if (cc) cc.onclick = handlers.onClearCards;
  const chc = document.getElementById('chatClear');
  if (chc) chc.onclick = handlers.onClearChat;
}

// ── Buddies (standalone panel) ──
// handlers: {onClose, onPick}
export function showBuddies(state, handlers) {
  const cts = counts(state);
  const unlocked = (id) => !UNLOCK[id] || state.unlockedIds.includes(id);
  const unlockedCount = CHARS.filter((c) => unlocked(c.id)).length;

  openOverlay(`
    <div id="book" class="buddiespanel">
      <div class="head">
        <span class="title">Buddies</span>
        <span class="subcount">${unlockedCount}/6 friends</span>
        <button class="close" id="buddiesClose">×</button>
      </div>
      <div class="buddies">
        ${CHARS.map((ch) => {
          const un = unlocked(ch.id);
          const act = state.active === ch.id;
          const d = UNLOCK[ch.id];
          const btn = act ? 'On duty ♥' : un ? 'Set active' : `${Math.min(cts[d.key], d.n)}/${d.n} · ${d.verb}`;
          return `
          <div class="buddy ${un ? '' : 'locked'} ${act ? 'active' : ''}">
            <div class="pic" style="background-image:url('./chars/char-${ch.id}.png')"></div>
            <div class="nm">${ch.name}</div>
            <div class="ps">${un ? PERS[ch.id].p : d.how}</div>
            <button data-pick="${ch.id}">${btn}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="hint">each buddy joins for a different kind of care — keep · favorite · confide · show up · go gold. once a friend, always a friend</div>
    </div>`);

  document.getElementById('buddiesClose').onclick = handlers.onClose;
  modal().querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => handlers.onPick(b.dataset.pick)));
}

export function confettiBurst() {
  const host = document.getElementById('confetti');
  const colors = ['#E08A3C', '#C9A227', '#7E9469', '#C97B8E', '#6E86A8'];
  for (let i = 0; i < 18; i++) {
    const c = document.createElement('span');
    c.className = 'c';
    c.style.left = `${6 + Math.random() * 88}%`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dur', `${1.6 + Math.random() * 1.2}s`);
    c.style.setProperty('--delay', `${Math.random() * 0.5}s`);
    host.appendChild(c);
    setTimeout(() => c.remove(), 3800);
  }
}

export function heartsBurst() {
  const host = document.getElementById('hearts');
  const h = document.createElement('span');
  h.className = 'h';
  h.style.left = `${25 + Math.random() * 50}%`;
  h.style.fontSize = `${14 + Math.random() * 10}px`;
  h.textContent = '♥';
  host.appendChild(h);
  setTimeout(() => h.remove(), 950);
}
