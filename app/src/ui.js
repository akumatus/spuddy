import { CHARS, UNLOCK, PERS, MEMORY_KINDS } from './content.js';
import { counts } from './store.js';

const overlay = () => document.getElementById('overlay');
const modal = () => document.getElementById('modal');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
    // Full conversation, shown in the old Memory card style: each exchange is a
    // card — what you said, then how he answered (his reply in his handwriting).
    // Fold the flat who/text log into note+reply pairs; runs of your messages
    // collapse into one note, his opening greeting stands as a reply-only card.
    const turns = state.chat || [];
    const spoken = turns.filter((m) => m.who === 'user').length;
    const pairs = [];
    let cur = null;
    for (const m of turns) {
      if (m.who === 'user') {
        if (cur && !cur.reply) cur.note = cur.note ? `${cur.note}\n${m.text}` : m.text;
        else { if (cur) pairs.push(cur); cur = { note: m.text, reply: '' }; }
      } else {
        if (!cur) cur = { note: '', reply: m.text };
        else { cur.reply = cur.reply ? `${cur.reply}\n${m.text}` : m.text; pairs.push(cur); cur = null; }
      }
    }
    if (cur) pairs.push(cur);
    body = `
      ${turns.length === 0 ? `<div class="empty">No messages yet — say hi and he'll answer.</div>` : ''}
      <div class="mems">
        ${pairs
          .map(
            (p) => `
          <div class="mem">
            <div class="body">
              ${p.note ? `<div class="note">you: ${esc(p.note)}</div>` : ''}
              ${p.reply ? `<div class="reply">${esc(p.reply)}</div>` : ''}
            </div>
          </div>`
          )
          .join('')}
      </div>
      <div class="bookfoot">
        <span class="hint">the whole conversation — clearing it just wipes context, not his memory</span>
        ${spoken ? '<button class="clear" id="chatClear">clear all</button>' : ''}
      </div>`;
  } else {
    // Memory — distilled facts grouped into a little profile by category.
    const groups = MEMORY_KINDS
      .map((k) => ({
        ...k,
        items: state.memory.map((m, i) => ({ ...m, i })).filter((m) => (m.kind || 'other') === k.id).reverse(),
      }))
      .filter((g) => g.items.length);
    body = `
      ${state.memory.length === 0 ? `<div class="empty">Nothing here yet — the more you tell him about your life, the more he'll remember, and knit into your golden cards.</div>` : ''}
      <div class="mems">
        ${groups
          .map(
            (g) => `
          <div class="memgroup">
            <div class="memgroup-head"><span class="kind ${g.id}">${g.emoji} ${esc(g.label)}</span></div>
            ${g.items
              .map(
                (m) => `
              <div class="mem">
                <span class="day">DAY ${m.day}</span>
                <div class="body"><div class="fact">${esc(m.fact)}</div></div>
                <button class="del" data-delmem="${m.i}">×</button>
              </div>`
              )
              .join('')}
          </div>`
          )
          .join('')}
      </div>
      <div class="bookfoot">
        <span class="hint">his picture of you — remove anything, anytime</span>
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
