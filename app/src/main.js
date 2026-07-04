import { PetScene } from './scene.js';
import { sfx, setSoundEnabled } from './sfx.js';
import * as store from './store.js';
import * as ui from './ui.js';
import {
  DAILY, RARE, POKE, RETAP, SEDENTARY, NIGHTMSG, WEAVELINES,
  CHARS, UNLOCK, PERS, FALLBACK_REPLY,
} from './content.js';

const $ = (id) => document.getElementById(id);
const pp = window.pp; // preload bridge

let state = store.load();
let bookTab = 'cards';
let bookFilter = 'all';
let chatBusy = false;
let weaving = false;
let retapIdx = 0;
let bubbleTimer = null;
let typeTimer = null;

setSoundEnabled(state.sound);

const scene = new PetScene($('pet'));
await scene.setCharacter(state.active);
const anim = () => scene.animator;

function persist() {
  store.save(state);
  checkUnlocks();
  $('bookCount').textContent = state.cards.length;
  $('bookDot').classList.toggle('hidden', !state.buddyNew);
}

// mini card on the model — mirrors the design's rMiniVals
function updateCardScreen() {
  if (chatBusy) {
    scene.setCardContent({ top: '', main: '. . .' });
  } else if (state.drawn && state.msg) {
    scene.setCardContent({
      top: state.rare ? '✦ · ✦ · ✦' : '· · ♥ · ·',
      gold: state.rare,
      main: state.msg,
      footL: `DAY ${state.day}`,
      footR: `— ${activeChar().name}`,
    });
  } else {
    scene.setCardContent({ top: '· ♥ ·', main: 'tap me :)' });
  }
}

function activeChar() {
  return CHARS.find((c) => c.id === state.active) || CHARS[0];
}

// ── bubble ──
function bubble(text, { hold = 2600, type = false } = {}) {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  const el = $('bubble');
  el.classList.remove('hidden');
  if (!type) {
    el.textContent = text;
  } else {
    let i = 0;
    el.textContent = '';
    typeTimer = setInterval(() => {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i >= text.length + 1) clearInterval(typeTimer);
    }, 30);
  }
  if (hold) bubbleTimer = setTimeout(() => el.classList.add('hidden'), hold + (type ? text.length * 15 : 0));
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  $('bubble').classList.add('hidden');
}

// ── unlocks (2a rules) ──
function checkUnlocks() {
  const cts = store.counts(state);
  const newly = CHARS.filter((ch) => {
    const d = UNLOCK[ch.id];
    return d && !state.unlockedIds.includes(ch.id) && cts[d.key] >= d.n;
  });
  if (!newly.length) return;
  state.unlockedIds = state.unlockedIds.concat(newly.map((c) => c.id));
  state.buddyNew = true;
  sfx.chime();
  anim().playCheer();
  ui.confettiBurst();
  bubble(`Unlocked: ${newly.map((c) => c.name).join(' & ')}! Meet them in the Book.`, { hold: 4200 });
  store.save(state);
  $('bookDot').classList.remove('hidden');
}

// ── emotion tags drive the body (trigger map) ──
function reactEmotion(tag) {
  if (tag === 'cheer') { sfx.chime(); anim().playCheer(); }
  else if (tag === 'proud') { sfx.chime(); anim().play('bigSquish'); }
  else if (tag === 'comfort') { sfx.low(); anim().play('comfort'); }
  else { sfx.pop(); anim().play('squish'); }
}

// ── daily card ──
function drawToday() {
  if (state.day % 5 === 3) return weaveGolden();
  const msg = DAILY[(state.day * 7) % DAILY.length].m;
  sfx.draw();
  ui.showDrawAnim();
  setTimeout(() => {
    state.drawn = true;
    state.rare = false;
    state.msg = msg;
    state.keptToday = false;
    persist();
    updateCardScreen();
    openCard();
    bubble("That one's yours today.");
  }, 1250);
}

async function weaveGolden() {
  if (weaving) return;
  weaving = true;
  sfx.draw();
  anim().play('bigSquish');
  anim().setMode('rock');
  scene.setCardPulse(true);
  ui.showWeave(WEAVELINES[0]);
  let li = 0;
  const weaveInt = setInterval(() => {
    li = (li + 1) % WEAVELINES.length;
    ui.setWeaveLine(WEAVELINES[li]);
  }, 2400);

  const ch = activeChar();
  const memory = state.journal.slice(-6);
  const [aiMsg] = await Promise.all([
    pp.ai.golden({ charId: ch.id, charName: ch.name, voice: PERS[ch.id].voice, memory }),
    new Promise((r) => setTimeout(r, 1800)),
  ]);
  clearInterval(weaveInt);
  weaving = false;
  anim().setMode('idle');
  scene.setCardPulse(false);
  sfx.chime();
  state.drawn = true;
  state.rare = true;
  state.msg = aiMsg || RARE[Math.floor(Math.random() * RARE.length)];
  state.keptToday = false;
  persist();
  updateCardScreen();
  openCard();
  bubble('Knit fresh, just for you.');
}

function openCard() {
  anim().play('raise');
  scene.raiseCard();
  ui.showCard(state, {
    onKeep: () => {
      if (state.keptToday) {
        sfx.pop();
        openBook('cards');
        return;
      }
      sfx.pop();
      state.cards.push({ m: state.msg, rare: state.rare, day: state.day, by: activeChar().name });
      state.keptToday = true;
      persist();
      ui.closeOverlay();
      bubble('Tucked into the Book. ♥');
    },
    onLater: () => {
      ui.closeOverlay();
      bubble("I'll hold onto it. Tap me anytime.");
    },
  });
}

// ── tap / poke ──
function tapPet() {
  if (anim().tucked) {
    sfx.boing();
    anim().setTucked(false);
    $('zz').classList.add('hidden');
    anim().play('squish');
    return;
  }
  anim().play('squish');
  if (!state.drawn) return drawToday();
  if (state.msg && !ui.isOverlayOpen()) {
    // re-show today's card sometimes; otherwise poke lines
    if (Math.random() < 0.35) {
      sfx.pop();
      openCard();
      return;
    }
  }
  sfx.boing();
  ui.heartsBurst();
  if (Math.random() < 0.5) {
    bubble(POKE[Math.floor(Math.random() * POKE.length)]);
  } else {
    bubble(RETAP[retapIdx % RETAP.length]);
    retapIdx++;
  }
}

// ── chat (heart-to-heart) ──
async function chatSend() {
  const input = $('chatInput');
  const note = (input.value || '').trim();
  if (!note || chatBusy) return;
  sfx.pop();
  chatBusy = true;
  input.value = '';
  const saidEl = $('said');
  saidEl.textContent = `“${note}”`;
  saidEl.classList.remove('hidden');
  hideBubble();
  anim().setMode('rock'); // 08 · Golden Weave — while AI writes
  scene.setCardPulse(true);
  updateCardScreen();

  state.chat.push({ who: 'user', text: note });
  const ch = activeChar();
  const res = await pp.ai.reply({
    charId: ch.id,
    charName: ch.name,
    voice: PERS[ch.id].voice,
    day: state.day,
    memory: state.journal.slice(-10),
    messages: state.chat.slice(-12),
  });
  chatBusy = false;
  anim().setMode('idle');
  scene.setCardPulse(false);
  updateCardScreen();

  let tag = 'calm';
  let reply = FALLBACK_REPLY;
  if (res && res.text) {
    tag = res.tag || 'calm';
    reply = res.text;
  }
  reactEmotion(tag);
  state.chat.push({ who: 'pet', text: reply });
  state.journal.push({ day: state.day, note, reply });
  persist();
  bubble(reply, { hold: 9000, type: true });
  setTimeout(() => saidEl.classList.add('hidden'), 4200);
}

// ── Card Book ──
function openBook(tab) {
  bookTab = tab || bookTab;
  renderBook();
}

function renderBook() {
  ui.showBook(state, bookTab, bookFilter, {
    onClose: () => { sfx.pop(); ui.closeOverlay(); },
    onTab: (t) => {
      bookTab = t;
      if (t === 'buddies' && state.buddyNew) {
        state.buddyNew = false;
        persist();
      }
      renderBook();
    },
    onFilter: (f) => { bookFilter = f; renderBook(); },
    onFav: (i) => {
      sfx.pop();
      state.cards[i].fav = !state.cards[i].fav;
      persist();
      renderBook();
    },
    onDel: (i) => {
      sfx.pop();
      state.cards.splice(i, 1);
      persist();
      renderBook();
    },
    onPick: async (id) => {
      const ch = CHARS.find((c) => c.id === id);
      const d = UNLOCK[id];
      if (d && !state.unlockedIds.includes(id)) {
        sfx.low();
        ui.closeOverlay();
        bubble(`${ch.name} joins when you ${d.how}.`, { hold: 3600 });
        return;
      }
      sfx.pop();
      state.active = id;
      state.chat.push({ who: 'pet', text: PERS[id].hi });
      persist();
      ui.closeOverlay();
      await scene.setCharacter(id);
      updateCardScreen();
      anim().play('squish');
      bubble(PERS[id].hi, { hold: 3600 });
      $('chatInput').placeholder = `tell ${activeChar().name} what's on your mind…`;
    },
    onDelMem: (i) => {
      sfx.pop();
      state.journal.splice(i, 1);
      persist();
      renderBook();
    },
    onClearMem: () => {
      sfx.pop();
      state.journal = [];
      persist();
      renderBook();
    },
  });
}

// ── care cards (scheduler / OS events) ──
function presentCare(tag, msg) {
  if (ui.isOverlayOpen() || anim().tucked) return;
  sfx.chime();
  anim().play('raise');
  ui.showCareCard(state, tag, msg, () => {
    sfx.pop();
    ui.closeOverlay();
  });
}

// ── input wiring ──
const stage = $('stage');
const panel = $('hoverpanel');
let hovT = null;

function showPanel() {
  clearTimeout(hovT);
  if (!anim().tucked) panel.classList.add('show');
}
function hidePanelSoon() {
  clearTimeout(hovT);
  hovT = setTimeout(() => panel.classList.remove('show'), 320);
}
stage.addEventListener('mouseenter', showPanel);
stage.addEventListener('mouseleave', hidePanelSoon);
panel.addEventListener('mouseenter', showPanel);
panel.addEventListener('mouseleave', hidePanelSoon);

// tap vs drag: dragging the potato moves the whole window
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.screenX, y: e.screenY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    pp.win.moveBy(dx, dy);
    drag.x = e.screenX;
    drag.y = e.screenY;
  }
});
stage.addEventListener('pointerup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) {
    anim().play('bigSquish');
    sfx.boing();
    bubble('wheee— ok. landing.');
  } else {
    tapPet();
  }
});

$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') chatSend();
  if (e.key === 'Escape') $('chatInput').blur();
});
$('chatInput').addEventListener('focus', () => anim().setMode('lean')); // 04 · Listen Lean
$('chatInput').addEventListener('blur', () => { if (!chatBusy && !weaving) anim().setMode('idle'); });
$('chatInput').placeholder = `tell ${activeChar().name} what's on your mind…`;

$('bookBtn').onclick = () => { sfx.pop(); openBook('cards'); };
$('tuckBtn').onclick = () => {
  sfx.pop();
  hideBubble();
  panel.classList.remove('show');
  ui.closeOverlay();
  anim().setTucked(true);
  $('zz').classList.remove('hidden');
};
$('soundBtn').onclick = () => {
  state.sound = !state.sound;
  setSoundEnabled(state.sound);
  $('soundBtn').classList.toggle('off', !state.sound);
  if (state.sound) sfx.pop();
  store.save(state);
};
$('soundBtn').classList.toggle('off', !state.sound);

// click-through everywhere except interactive elements
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const interactive = !!(el && el.closest('[data-interactive]'));
  pp.win.setIgnoreMouse(!interactive || (el.id === 'overlay' && false));
});
document.addEventListener('mouseleave', () => pp.win.setIgnoreMouse(true));

// ── scheduler: random idle hops (every 20–60s, sometimes) ──
function scheduleHop() {
  setTimeout(() => {
    if (!anim().tucked && !ui.isOverlayOpen() && document.visibilityState !== 'hidden' && Math.random() < 0.6) {
      anim().play('hop');
      if (Math.random() < 0.18) sfx.boing(); // rare boing
    }
    scheduleHop();
  }, 20000 + Math.random() * 40000);
}
scheduleHop();

// night care at 23:00 (once per day)
setInterval(() => {
  const now = new Date();
  const today = state.lastDate;
  if (now.getHours() >= 23 && state.nightShownDate !== today) {
    state.nightShownDate = today;
    store.save(state);
    presentCare('NIGHT CARE', NIGHTMSG);
  }
}, 60000);

// sedentary reminder from the main process (90 min continuous activity)
pp.on('sedentary', () => presentCare('STRETCH BREAK', SEDENTARY));

// ── boot ──
$('bookCount').textContent = state.cards.length;
$('bookDot').classList.toggle('hidden', !state.buddyNew);
updateCardScreen();
pp.win.setIgnoreMouse(true);

// debug hook for automated UI tests (PP_UITEST=js:...)
window._pp = {
  tap: tapPet,
  state: () => state,
  setChar: (id) => scene.setCharacter(id).then(updateCardScreen),
  sceneObj: scene,
  cardProbe: () => {
    const planes = [];
    scene.scene.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry') {
        planes.push({ pos: o.position.toArray().map((v) => +v.toFixed(3)), parent: o.parent?.uuid?.slice(0, 8) });
      }
    });
    return { planes, canvas: [scene.cardScreen.canvas.width, scene.cardScreen.canvas.height] };
  },
};

setTimeout(() => {
  if (!state.drawn) bubble(PERS[state.active].hi, { hold: 5200 });
}, 900);
