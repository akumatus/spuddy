import { PetScene } from './scene.js';
import { SpudBrain } from './brain.js';
import { sfx, setSoundEnabled } from './sfx.js';
import * as store from './store.js';
import * as ui from './ui.js';
import {
  DAILY, RARE, POKE, RETAP, CARDHINT, SEDENTARY, NIGHTMSG, WEAVELINES,
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
let mutterTimer = null;

setSoundEnabled(state.sound);

const scene = new PetScene($('pet'));
await scene.setCharacter(state.active);
const anim = () => scene.animator;

// ── 人格引擎 (7a) — needs-driven autonomy, ported from lib/spud-brain.js ──
const per = state.personality || {};
const brain = new SpudBrain({
  animator: anim(),
  personality: {
    curious: (per.curiosity ?? 65) / 100,
    clingy: (per.clinginess ?? 60) / 100,
    drama: (per.drama ?? 55) / 100,
    sleepy: (per.sleepiness ?? 35) / 100,
  },
  // no decisions while you're actually using him (chat, book, weave, tuck)
  canAct: () =>
    !anim().tucked && !ui.isOverlayOpen() && !chatBusy && !weaving &&
    document.visibilityState !== 'hidden' && document.activeElement !== $('chatInput'),
  on: {
    mutter: (text) => showMutter(text),
    speak: (text, ms) => bubble(text, { hold: ms }),
    emote: (g) => spawnEmote(g),
    sfx: (n) => sfx[n] && sfx[n](),
    state: (key, zh) => { if (pp.debug) console.log('[brain]', key, zh); },
    log: (e) => { if (pp.debug) console.log('[brain]', e.kind, e.text); },
  },
});

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
  $('mutter').classList.add('hidden'); // speak outranks the inner monologue
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

// ── mutter — dashed thought bubble for the inner monologue (7a) ──
function showMutter(text) {
  if (anim().tucked || ui.isOverlayOpen() || chatBusy || weaving) return;
  if (!$('bubble').classList.contains('hidden')) return; // speech first
  const el = $('mutter');
  clearTimeout(mutterTimer);
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth; // restart the pop-in
  el.style.animation = '';
  mutterTimer = setTimeout(() => el.classList.add('hidden'), 2300 + text.length * 40);
}

// ── floating emotes (♪ ♥ Z) drifting off his head (7a) ──
function spawnEmote(g) {
  if (anim().tucked || document.visibilityState === 'hidden') return;
  const el = document.createElement('span');
  el.className = 'em';
  el.textContent = g === 'z' ? 'Z' : g;
  el.style.left = `${40 + Math.random() * 22}%`;
  $('emotes').appendChild(el);
  setTimeout(() => el.remove(), 1900);
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
  brain.interrupt();
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
  scene.raiseCard(); // rig models play 'present', legacy 'raise' + quad slide
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
// 摸摸的反应池：每次点击随机一个动作（用户反馈：固定 squish 太枯燥）。
// squish 权重最高保留"被按扁"的手感，其余当彩蛋；拆件模型多解锁几个部件动作。
// 最近两个动作直接从池子里排除——任意连着 3 次点击保证不重样（用户反馈：
// 单次重抽还是撞得太频）。shy 捂眼已按用户要求移出反应池。
const TAP_POOL = [
  ['squish', 3], ['hop', 2], ['wobble', 2], ['peek', 1.5], ['spin', 1.5],
  ['sneeze', 1], ['pirouette', 0.8],
];
const TAP_POOL_RIG = [['eyeroll', 1.5], ['bounceCard', 1.5], ['wave', 1]];
let tapHistory = [];

function playTapReaction() {
  const pool = (scene.hasRig() ? TAP_POOL.concat(TAP_POOL_RIG) : TAP_POOL)
    .filter(([k]) => !tapHistory.includes(k));
  let r = Math.random() * pool.reduce((s, [, w]) => s + w, 0);
  let name = pool[0][0];
  for (const [k, w] of pool) { r -= w; if (r <= 0) { name = k; break; } }
  tapHistory = [name, ...tapHistory].slice(0, 2);
  anim().play(name);
  if (name === 'sneeze') sfx.sneeze();
  return name;
}

// the card popup only opens from the white card itself (user request);
// body taps are pure play — random reaction, hearts, poke lines
function tapPet(target) {
  if (anim().tucked) {
    sfx.boing();
    anim().setTucked(false);
    $('zz').classList.add('hidden');
    anim().play('squish');
    return;
  }
  // the brain gets first dibs: waking him from a doze / answering his knock
  if (brain.poke()) return;
  brain.interrupt();

  if (target === 'card') {
    if (chatBusy || weaving || ui.isOverlayOpen()) return;
    if (!state.drawn) {
      anim().play('squish'); // the card says "tap me :)" — this is the draw
      return drawToday();
    }
    sfx.pop();
    openCard();
    return;
  }

  playTapReaction();
  sfx.boing();
  ui.heartsBurst();
  if (!state.drawn) {
    bubble(Math.random() < 0.5 ? CARDHINT : POKE[Math.floor(Math.random() * POKE.length)]);
  } else if (Math.random() < 0.5) {
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
  brain.interrupt();
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
  brain.interrupt();
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
      brain.interrupt();
      state.active = id;
      state.chat.push({ who: 'pet', text: PERS[id].hi });
      persist();
      ui.closeOverlay();
      await scene.setCharacter(id);
      updateCardScreen();
      anim().play(scene.hasRig() ? 'wave' : 'hop'); // reporting for duty
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
  brain.interrupt();
  sfx.chime();
  scene.raiseCard();
  ui.showCareCard(state, tag, msg, () => {
    sfx.pop();
    ui.closeOverlay();
  });
}

// ── debug switch (launch with PP_DEBUG=1) ──
// redraw simulates the next day: fresh text each time, golden weave every 5th
function debugRedraw() {
  if (weaving) return;
  ui.closeOverlay();
  state.day += 1;
  state.drawn = false;
  state.rare = false;
  state.msg = '';
  state.keptToday = false;
  persist();
  updateCardScreen();
  drawToday();
}

function debugReset() {
  store.reset();
  location.reload();
}

if (pp.debug) {
  $('dbgDrawBtn').classList.remove('hidden');
  $('dbgResetBtn').classList.remove('hidden');
  $('dbgDrawBtn').onclick = () => { sfx.pop(); debugRedraw(); };
  $('dbgResetBtn').onclick = () => { sfx.pop(); debugReset(); };
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

// tap vs drag: dragging the potato moves the whole window; horizontal drag
// also spins him (甩转) — release lets the underdamped spring swing him back.
// (the Turn 5/6 double-tap → pirouette mapping is gone: it hijacked every
// second click during fast tapping into the same spin, which is exactly the
// monotony the user asked to fix — pirouette lives in the random pool now)
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.screenX, y: e.screenY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4 && !drag.moved) {
    drag.moved = true;
    brain.interrupt();
    anim().setDragging(true);
  }
  if (drag.moved) {
    pp.win.moveBy(dx, dy);
    anim().dragBy(dx * 0.5);
    drag.x = e.screenX;
    drag.y = e.screenY;
  }
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) {
    anim().setDragging(false); // spring-back with one overshoot
    anim().play('bigSquish');
    sfx.boing();
    bubble('wheee— ok. landing.');
    return;
  }
  tapPet(scene.pick(e.clientX, e.clientY));
});

$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') chatSend();
  if (e.key === 'Escape') $('chatInput').blur();
});
$('chatInput').addEventListener('focus', () => { brain.interrupt(); anim().setMode('lean'); }); // 04 · Listen Lean
$('chatInput').addEventListener('blur', () => { if (!chatBusy && !weaving) anim().setMode('idle'); });
$('chatInput').placeholder = `tell ${activeChar().name} what's on your mind…`;

$('bookBtn').onclick = () => { sfx.pop(); openBook('cards'); };
$('tuckBtn').onclick = () => {
  sfx.pop();
  brain.interrupt();
  hideBubble();
  $('mutter').classList.add('hidden');
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

// 转头看你的光标 (Turn 5) — the main process polls the global cursor so he
// keeps watching even while the pointer roams other windows; eyes lead, head
// follows (Turn 6). ±420px from his nose = full turn.
let lastCursor = null;
pp.on('cursor', ({ x, y }) => {
  // presence for the brain: the cursor actually moving means you're there
  if (lastCursor && Math.abs(x - lastCursor.x) + Math.abs(y - lastCursor.y) > 3) brain.pointerMove();
  lastCursor = { x, y };
  if (anim().tucked || drag) return;
  const r = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height * 0.55; // eye line, not stage center
  anim().facePoint(
    Math.max(-1, Math.min(1, (x - cx) / 420)),
    Math.max(-1, Math.min(1, (y - cy) / 420))
  );
});

// (the old random idle-hop scheduler is gone — the soul engine (7a) owns
// autonomous behavior now: boredom routines, dozing, knocking, mutters)

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
  tapCard: () => tapPet('card'),
  tapReact: playTapReaction,
  state: () => state,
  brain,
  redraw: debugRedraw,
  reset: debugReset,
  play: (name) => anim().play(name),
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
  anim().play(scene.hasRig() ? 'wave' : 'hop'); // morning greeting
  if (!state.drawn) bubble(PERS[state.active].hi, { hold: 5200 });
}, 900);
