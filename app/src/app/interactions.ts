// ── input wiring: taps/pokes, window drag, hover panel, edge-dock naps,
// cursor tracking, and the click-through choreography ──
import { routineMs } from '../brain';
import { TXT, pool } from '../content';
import { hasHan, lang } from '../locale';
import { CLIPS, WOBBLE } from '../scene/motions';
import type { PickTarget } from '../scene/scene';
import { setSoundEnabled, sfx } from '../sfx';
import type { DockSide, EdgeInfo, PetSize } from '../types';
import * as store from '../store';
import { heartsBurst } from '../ui/effects';
import { isOverlayOpen } from '../ui/overlay';
import { chatSend } from './chat';
import { $, ctx, pp } from './context';
import { scheduleDistill } from './distill';
import { dailyDrawLimit, drawToday, openCard } from './gacha';
import { applyLangPref, onLangChange } from './lang';
import { openBook, openBuddies } from './panels';
import { bubble, hideBubble } from './speech';

// ── tap / poke ──
// Tap reaction pool: each tap plays a random motion (user feedback: a fixed
// squish got monotonous). A '@' prefix = the brain's full mini-skit (multi-step
// sequence + self-talk — tail-chase, hum, card-study…), and those are now the
// star attraction: the user loves the autonomous-personality routines but was
// barely seeing them on tap, so they carry the heaviest weight and a plain body
// tap lands on a skit ~half the time. The basic one-shots are connective tissue
// between skits, not the main event — hop and spin were dialed way down (user
// feedback: "way too many jumps, it gets dull"). squish keeps a moderate weight for the
// signature "squashed" feel; part-rigged models unlock a few more part-specific
// motions. The last two motions are excluded from the pool — any run of 3 taps
// is guaranteed not to repeat (user feedback: a single re-roll still collided
// too often). shy (cover-eyes) was pulled from the pool per the user's request.
// Body taps during a skit's playback are debounced so motions don't stack —
// which also means a launched skit gets watched to the end (per user request).
const TAP_POOL: [string, number][] = [
  ['squish', 1.5], ['hop', 0.6], ['wobble', 1], ['peek', 1], ['spin', 0.6],
  ['sneeze', 1.4], ['pirouette', 1],
  ['@chase', 3], ['@hum', 3],
];
const TAP_POOL_RIG: [string, number][] = [
  ['eyeroll', 1], ['bounceCard', 1.4], ['wave', 1.2],
  ['@study', 2.6], ['@juggle', 2.4], ['@practice', 2.2],
];
let tapHistory: string[] = [];
let tapBusyUntil = 0;
let retapIdx = 0;

// `quick` = this tap is cutting a still-playing reaction short (a re-tap): skip
// the multi-step skits and land a snappy one-shot, so every re-tap shows an
// immediate motion rather than a skit whose opening beat might be a mutter.
export function playTapReaction(quick = false): string {
  let pool = (ctx.scene.hasRig() ? TAP_POOL.concat(TAP_POOL_RIG) : TAP_POOL)
    .filter(([k]) => !tapHistory.includes(k));
  if (quick) pool = pool.filter(([k]) => k[0] !== '@');
  let r = Math.random() * pool.reduce((s, [, w]) => s + w, 0);
  let name = pool[0][0];
  for (const [k, w] of pool) { r -= w; if (r <= 0) { name = k; break; } }
  tapHistory = [name, ...tapHistory].slice(0, 2);
  if (name[0] === '@') {
    const key = name.slice(1);
    ctx.brain.force(key);
    tapBusyUntil = performance.now() + routineMs(key);
  } else {
    ctx.anim().play(name);
    if (name === 'sneeze') sfx.sneeze();
    const clip = name === 'wobble' ? WOBBLE : CLIPS[name];
    tapBusyUntil = performance.now() + (clip ? clip.dur : 700);
  }
  return name;
}

// the card popup only opens from the white card itself (user request);
// body taps are pure play — random reaction, hearts, poke lines
export function tapPet(target: PickTarget): void {
  // the stage fills a 300×400 rectangle, but only the potato answers: a tap
  // on empty air (raycast hit nothing) is inert — no reaction, no waking, and
  // no need-nudge in the brain — so play tracks his silhouette, not the box.
  if (!target) return;
  if (ctx.anim().docked) {
    undock(); // a tap on the peeking strip brings him back on screen
    return;
  }
  if (ctx.anim().tucked) {
    sfx.boing();
    ctx.anim().setTucked(false);
    ctx.anim().play('squish');
    return;
  }
  // the brain gets first dibs: waking him from a doze / answering his knock
  if (ctx.brain.poke()) return;

  if (target === 'card') {
    ctx.brain.interrupt(); // the card is functional UI — it always answers
    tapBusyUntil = 0;
    if (ctx.chatBusy || ctx.weaving || isOverlayOpen()) return;
    if (ctx.state.draws < dailyDrawLimit()) {
      // still have draw budget (always true when uncapped) → draw a new card; once used up, tapping the card reopens the current one instead
      ctx.anim().play('squish'); // the card says "tap me :)" — this is the draw
      drawToday();
      return;
    }
    sfx.pop();
    openCard();
    return;
  }

  // a tap mid-reaction cuts the current motion short and starts a fresh one, so
  // rapid pokes stay snappy instead of being swallowed. brain.interrupt() aborts
  // any running skit sequence (and drops the mode back to idle), stopClips()
  // clears the clip that was mid-play so the new one doesn't stack on top of it.
  // A re-tap forces a quick one-shot (see playTapReaction); a single tap left
  // alone still gets to unfold a full skit.
  const busy = performance.now() < tapBusyUntil;
  ctx.brain.interrupt();
  ctx.anim().stopClips();
  const name = playTapReaction(busy);
  if (name[0] === '@') return; // the show brings its own lines and sfx
  sfx.boing();
  heartsBurst();
  const cardHints = pool('cardHint');
  const pokes = pool('poke');
  const rndPoke = (): string => pokes[Math.floor(Math.random() * pokes.length)];
  if (!ctx.state.drawn) {
    bubble(Math.random() < 0.5 && cardHints.length ? cardHints[Math.floor(Math.random() * cardHints.length)] : rndPoke());
  } else if (Math.random() < 0.5) {
    bubble(rndPoke());
  } else {
    const rp = pool('retap');
    bubble(rp[retapIdx % rp.length]);
    retapIdx++;
  }
}

// ── edge-dock snap (贴边吸附): drag him to any edge — body hanging out, a
// golden strip lights the snap line — and on release he settles flush against
// it, only eyes-and-above peeking in, paws hooked over the edge, watching the
// screen. Sides have him rolled 90°, the top has him hanging upside down (the
// roll lives in scene.dockGeom). Docked = quiet duty: the same gates as
// immersive mode apply (no mutters, routines, gaze-tracking; sound off). A tap
// or a grab-and-drag brings him back. The main process streams which edge (if
// any) the potato is pushed against, with the edge line in window coords.
let edge: EdgeInfo = { side: null, ex: 0, ey: 0 };

// effective sound gate: the saved preference, muted by immersive mode or an
// edge dock (both are quiet duty; the preference itself stays untouched)
export function applySoundGate(): void {
  setSoundEnabled(ctx.state.sound && !ctx.state.immersive && !ctx.anim().docked);
}

// the stage's in-window vertical shift, shared by the drag-to-top lift and the
// top dock (which needs the canvas top flush with the window top: lift 240)
const DOCK_TOP_LIFT = 240;

export function dockTo(side: DockSide): void {
  if (ctx.anim().docked) return;
  ctx.brain.interrupt();
  hideBubble();
  $('mutter').classList.add('hidden');
  closeSettings();
  $('hoverpanel').classList.remove('show');
  sfx.low(); // one soft settle tone, then quiet duty
  // top needs the canvas flush with the window top; every other side hands the
  // hiding over to the in-scene dock pose, so any leftover drag lift eases home
  liftTo(side === 'top' ? DOCK_TOP_LIFT : 0);
  ctx.anim().setDock(side);
  applySoundGate();
  updateGlowEl();
  void pp?.win.dock(side); // tween the window flush against the edge
}

// playful = a tap woke him (pop + squish + lift back down). A grab-and-drag
// passes false: the drag has taken over — no fanfare, and a top dock keeps its
// stage lift so the drag mechanics can spend it dragging him down.
export function undock(playful = true): void {
  if (!ctx.anim().docked) return;
  ctx.anim().setDock(null);
  if (playful) liftTo(0); // ease the stage home (only ever shifted by a top dock)
  applySoundGate(); // restore sound before the pop, so it's heard
  if (playful) {
    ctx.anim().play('squish');
    sfx.boing();
  }
  ctx.brain.interrupt();
}

// animate the stage's lift with a transition (the drag path sets it raw)
let liftAnimT = 0;
function liftTo(v: number): void {
  const stage = $('stage');
  clearTimeout(liftAnimT);
  stage.style.transition = 'transform 300ms cubic-bezier(0.33, 1, 0.68, 1)';
  setLift(v);
  liftAnimT = window.setTimeout(() => { stage.style.transition = ''; }, 320);
}
// wired inside wireInteractions (the lift state lives there); split so the
// dock choreography above can drive it too
let setLift: (v: number) => void = () => {};

// ── golden snap highlight: a soft glow washing in from the screen-edge line
// while a drag holds him in a snap zone ──
// SPAN = band length along the edge; DEPTH = how far the wash reaches inward.
// The opaque end sits on the edge line (edge.ex / edge.ey), the faded end
// points into the screen. Side bands center vertically on the stage (window
// y 240..640, mid 440), so top = 440 − SPAN/2.
const GLOW_SPAN = 360;
const GLOW_DEPTH = 64;
function updateGlowEl(dragging = false): void {
  const g = $('dockGlow');
  const show = dragging && !!edge.side && !ctx.anim().docked;
  g.classList.toggle('hidden', !show);
  if (!show || !edge.side) return;
  g.dataset.side = edge.side;
  const midY = 440 - GLOW_SPAN / 2;
  const halfSpan = GLOW_SPAN / 2;
  if (edge.side === 'left') g.style.cssText = `left:${edge.ex}px;top:${midY}px;`;
  else if (edge.side === 'right') g.style.cssText = `left:${edge.ex - GLOW_DEPTH}px;top:${midY}px;`;
  else if (edge.side === 'top') g.style.cssText = `top:${edge.ey}px;left:calc(50% - ${halfSpan}px);`;
  else g.style.cssText = `top:${edge.ey - GLOW_DEPTH}px;left:calc(50% - ${halfSpan}px);`;
}

// The static chrome that carries language: the chat placeholder. (The icon
// buttons deliberately have no hover tooltips.) Called at boot and on switch.
export function applyLangChrome(): void {
  const ui = TXT().ui;
  ($('chatInput') as HTMLInputElement).placeholder = ui.placeholder(ctx.activeChar().name);
}

// ── ⚙ settings panel (design: Hover 图标重设计 §2) ──
// Language pills (中文 / English) + the sound toggle that replaced the old
// one-click ♪ mute. The popover pins the hover panel open while it's up.
let settingsOpen = false;

export function isSettingsOpen(): boolean {
  return settingsOpen;
}

function renderSettingsPanel(): void {
  const sp = $('spanel');
  const ui = TXT().ui;
  const zh = lang() === 'zh';
  const imm = ctx.state.immersive;
  const on = ctx.state.sound && !imm; // immersive gates sound; the pref itself is kept
  const sz = ctx.state.petSize;
  sp.classList.toggle('zh', zh);
  sp.innerHTML = `
    <div class="sp-head">
      <span class="sp-title">${ui.settingsTitle}</span>
      <button class="sp-x" id="spClose">×</button>
    </div>
    <div class="sp-div"></div>
    <div class="sp-lbl">${ui.langLabel}</div>
    <div class="sp-pills">
      <div class="sp-pill ${zh ? 'on' : ''}" id="spZh">中文</div>
      <div class="sp-pill ${zh ? '' : 'on'}" id="spEn">English</div>
    </div>
    <div class="sp-lbl sp-sub">${ui.sizeLabel}</div>
    <div class="sp-pills">
      <div class="sp-pill ${sz === 'sm' ? 'on' : ''}" id="spSizeS">${ui.sizeSmall}</div>
      <div class="sp-pill ${sz === 'md' ? 'on' : ''}" id="spSizeM">${ui.sizeMed}</div>
      <div class="sp-pill ${sz === 'lg' ? 'on' : ''}" id="spSizeL">${ui.sizeLarge}</div>
    </div>
    <div class="sp-row">
      <span class="sp-lbl">${ui.soundLabel}</span>
      <div class="sp-snd">
        <span class="sp-word ${on ? 'on' : ''}">${on ? ui.soundOn : ui.soundOff}</span>
        <div class="sp-tgl ${on ? 'on' : ''}" id="spTgl"><div class="sp-knob"></div></div>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-lbl">${ui.immersiveLabel}</span>
      <div class="sp-tgl ${imm ? 'on' : ''}" id="spImm"><div class="sp-knob"></div></div>
    </div>
    <div class="sp-hint">${ui.immersiveHint}</div>`;
  $('spClose').onclick = () => closeSettings();
  $('spZh').onclick = () => { applyLangPref('zh'); sfx.pop(); };
  $('spEn').onclick = () => { applyLangPref('en'); sfx.pop(); };
  const setSize = (s: PetSize) => {
    if (ctx.state.petSize === s) return;
    ctx.state.petSize = s;
    ctx.scene.setPetSize(s); // live rescale — no model reload, animation keeps playing
    store.save(ctx.state);
    sfx.pop();
    renderSettingsPanel();
  };
  $('spSizeS').onclick = () => setSize('sm');
  $('spSizeM').onclick = () => setSize('md');
  $('spSizeL').onclick = () => setSize('lg');
  $('spTgl').onclick = () => {
    const s = ctx.state;
    if (s.immersive) {
      // immersive mode is what's holding sound off — asking for sound back
      // lifts the whole mode (turning sound on ⇒ leave do-not-disturb)
      s.sound = true;
      setImmersive(false);
      sfx.pop();
      renderSettingsPanel();
      return;
    }
    s.sound = !s.sound;
    applySoundGate();
    store.save(s);
    if (s.sound) sfx.pop(); // turning it on gets to say so; turning it off goes quiet at once
    renderSettingsPanel();
  };
  $('spImm').onclick = () => {
    setImmersive(!ctx.state.immersive);
    if (!ctx.state.immersive && ctx.state.sound) sfx.pop(); // sound may just have come back
    renderSettingsPanel();
  };
}

// Enter / leave immersive (do-not-disturb) mode. Entering also cuts any running
// skit, clears the spoken leftovers and re-centers his gaze; either way sound
// is re-gated and the state persisted. Both the immersive toggle and the sound
// toggle (turning sound back on) drive this.
function setImmersive(v: boolean): void {
  const s = ctx.state;
  if (s.immersive === v) return;
  s.immersive = v;
  if (v) {
    ctx.brain.interrupt();
    hideBubble();
    $('mutter').classList.add('hidden');
    ctx.anim().facePoint(0, 0);
  }
  applySoundGate();
  store.save(s);
}

function openSettings(): void {
  settingsOpen = true;
  renderSettingsPanel();
  $('spanel').classList.remove('hidden');
  $('settingsBtn').classList.add('open');
}

export function closeSettings(): void {
  if (!settingsOpen) return;
  settingsOpen = false;
  $('spanel').classList.add('hidden');
  $('settingsBtn').classList.remove('open');
}

// Wires every DOM/IPC input handler. Called once from main.ts, after the
// scene, brain and state exist.
export function wireInteractions(): void {
  const stage = $('stage');
  const panel = $('hoverpanel');
  let hovT = 0;

  let panelHover = false; // pointer resting on one of the panel controls

  // The panel stays up while the pointer rests on its controls or on the
  // potato himself, while the chat input holds focus (mid-message), or while
  // the ⚙ settings popover is open — all of these mean the human is around.
  function panelPinned(): boolean {
    return panelHover || onPotato || settingsOpen || ctx.chatFocused;
  }
  function showPanel(): void {
    clearTimeout(hovT);
    // docked: quiet duty — hovering the peeking strip shouldn't pop controls
    if (!ctx.anim().tucked && !ctx.anim().docked) panel.classList.add('show');
  }
  function hidePanelSoon(): void {
    clearTimeout(hovT);
    if (panelPinned()) return;
    // The grace stretches with the lift: parked at the top of the screen the
    // stage rides up but the panel stays anchored at the window bottom, so the
    // silhouette→controls trip crosses up to ~LIFT_MAX extra px of dead air.
    hovT = window.setTimeout(() => panel.classList.remove('show'), 320 + lift);
  }
  // The panel pops on hovering the potato himself (see the raycast hit test in
  // the mousemove handler below — the stage box is no longer a hover target).
  // The panel container is click-through (only its controls catch the mouse),
  // so keep-alive listens on each control instead of the whole panel box.
  for (const el of [$('said'), $('icons'), $('chatrow')]) {
    el.addEventListener('mouseenter', () => { panelHover = true; showPanel(); });
    el.addEventListener('mouseleave', () => { panelHover = false; hidePanelSoon(); });
  }

  // Which flank of the potato the panel hangs on. Recomputed when a drag
  // settles (and once at boot): parked near the left screen edge the default
  // left-side panel would clip offscreen, so it mirrors to his right.
  async function settlePanelSide(): Promise<void> {
    panel.classList.toggle('flip', (await pp?.win.panelSide()) === 'right');
  }
  void settlePanelSide(); // boot: the spawn corner is right, but resolve it anyway

  // tap vs drag: dragging the potato moves the whole window; horizontal drag
  // also spins him — release lets the underdamped spring swing him back.
  // (the Turn 5/6 double-tap → pirouette mapping is gone: it hijacked every
  // second click during fast tapping into the same spin, which is exactly the
  // monotony the user asked to fix — pirouette lives in the random pool now)

  let drag: { x: number; y: number; moved: boolean } | null = null;

  // the main process streams edge proximity as the window moves — the snap
  // highlight follows the edge line live while a drag holds him in the zone
  pp?.on('edge', (info) => {
    edge = info;
    updateGlowEl(!!(drag && drag.moved));
  });

  // How far the potato is shifted up WITHIN the window. macOS pins the window's
  // top under the menu bar, and he's drawn ~490px below that top, so without this
  // he could never be dragged past mid-screen. When the window stalls at the top,
  // we slide the whole stage up instead so he keeps tracking the cursor to the top.
  // Positive lift slides the stage up (dragging past the menu-bar pin);
  // negative lift slides it DOWN past the work-area floor — the window is
  // clamped there (see move-by in electron/src/window.ts), so sinking the
  // stage is what lets his body visually dip below the screen's bottom edge.
  let lift = 0;
  const LIFT_MAX = 360; // brings his head to the top edge without clipping it off
  const LIFT_MIN = -240; // enough to bury him below the bottom edge entirely
  function applyLift(): void {
    stage.style.transform = lift ? `translateY(${-lift}px)` : '';
  }
  // hand the dock choreography (module scope) a handle on the lift state
  setLift = (v: number) => { lift = v; applyLift(); };

  stage.addEventListener('pointerdown', (e) => {
    // Only his body takes a grab. Stage air is normally click-through and never
    // reaches us, but the mouse-active state trails the cursor by a beat
    // (throttled raycast below), so a stale press could sneak in — re-check.
    if (!ctx.scene.pick(e.clientX, e.clientY)) return;
    drag = { x: e.screenX, y: e.screenY, moved: false };
    // a dock lift animation may still be easing — the drag needs raw control
    clearTimeout(liftAnimT);
    stage.style.transition = '';
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      // synthetic/exotic pointers (UI tests, some tablets) may not be capturable —
      // the drag still works, it just loses the capture guarantee
    }
  });
  stage.addEventListener('pointermove', async (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4 && !drag.moved) {
      drag.moved = true;
      ctx.brain.interrupt();
      ctx.anim().setDragging(true);
      // grabbing the peeking strip pulls him back out; a top dock keeps its
      // lift so the normal drag mechanics spend it on the way down
      undock(false);
    }
    if (!drag.moved) return;
    drag.x = e.screenX;
    drag.y = e.screenY;
    ctx.anim().dragBy(dx * 0.5);

    // Dragging back toward center: spend the in-window lift (either sign)
    // before the window itself moves, so he peels off the edge smoothly
    // instead of the window lurching first.
    let winDy = dy;
    if (dy > 0 && lift > 0) {
      const take = Math.min(lift, dy);
      lift -= take;
      winDy -= take;
    } else if (dy < 0 && lift < 0) {
      const take = Math.max(lift, dy); // both negative
      lift -= take;
      winDy -= take;
    }
    const shortfall = (await pp?.win.moveBy(dx, winDy, lift)) ?? 0; // px the window couldn't move
    if (shortfall > 0) lift = Math.min(lift + shortfall, LIFT_MAX); // pinned under the menu bar
    else if (shortfall < 0) lift = Math.max(lift + shortfall, LIFT_MIN); // held at the floor
    applyLift();
    updateGlowEl(true); // an edge event may have landed while we awaited
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    lastCast = 0; // bypass the throttle — the last mid-drag verdict is stale here
    refreshMouseRegion(e.clientX, e.clientY); // settle click-through right away —
    // the drop spot may be off his silhouette and shouldn't hold the mouse
    if (moved) {
      void settlePanelSide(); // the drop spot decides which flank the panel takes
      ctx.anim().setDragging(false); // spring-back with one overshoot
      updateGlowEl(); // drag over — snap highlight off
      if (edge.side) {
        dockTo(edge.side); // dropped in a snap zone — settle onto that edge
      } else {
        if (lift < 0) liftTo(0); // dropped half-sunk but shy of the snap zone — surface
        ctx.anim().play('bigSquish');
        sfx.boing();
        const ld = pool('landing');
        bubble(ld[Math.floor(Math.random() * ld.length)]!);
      }
      return;
    }
    tapPet(ctx.scene.pick(e.clientX, e.clientY));
  });
  // a captured drag can be cancelled out from under us (system gestures etc.);
  // without cleanup `drag` would pin the window mouse-active forever
  stage.addEventListener('pointercancel', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      void settlePanelSide(); // the window stays wherever the cancel left it
      ctx.anim().setDragging(false); // drop the pose — no landing fanfare
      updateGlowEl();
      if (lift < 0) liftTo(0); // never leave him half-buried below the floor
    }
    lastCast = 0;
    refreshMouseRegion(e.clientX, e.clientY);
  });

  const chatInput = $('chatInput') as HTMLInputElement;
  chatInput.addEventListener('keydown', (e) => {
    // Ignore the Enter that only confirms an IME candidate — otherwise chatSend
    // clears the field and the IME re-commits its text into it, so it never empties.
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) chatSend();
    if (e.key === 'Escape') chatInput.blur();
  });
  // Typed text is content, any language regardless of locale — stamp its
  // sizing from the value (the empty field falls back to the html.zh locale
  // default, which owns the placeholder). chatSend's programmatic clear fires
  // no input event, so chat.ts drops the stamps itself.
  chatInput.addEventListener('input', () => {
    const v = chatInput.value;
    chatInput.classList.toggle('zh', !!v && hasHan(v));
    chatInput.classList.toggle('latin', !!v && !hasHan(v));
    // typing counts as conversation activity: keep the distill lull from
    // firing under a slow typer mid-composition (see distill.ts LULL_MS)
    scheduleDistill();
  });
  chatInput.addEventListener('focus', () => { ctx.chatFocused = true; ctx.brain.interrupt(); ctx.anim().setMode('lean'); }); // 04 · Listen Lean
  chatInput.addEventListener('blur', () => {
    ctx.chatFocused = false; // clear before hidePanelSoon so panelPinned() sees the input released
    if (!ctx.chatBusy && !ctx.weaving) ctx.anim().setMode('idle');
    hidePanelSoon(); // focus no longer pins the panel — hide it unless the pointer still holds it
  });
  applyLangChrome();
  // a language switch (panel pills or tray) refreshes the chrome and, if the
  // popover is up, re-renders it in the new language on the spot
  onLangChange(() => {
    applyLangChrome();
    if (settingsOpen) renderSettingsPanel();
  });

  $('bookBtn').onclick = () => { sfx.pop(); closeSettings(); openBook('cards'); };
  $('buddiesBtn').onclick = () => { sfx.pop(); closeSettings(); openBuddies(); };
  $('settingsBtn').onclick = () => {
    sfx.pop();
    if (settingsOpen) closeSettings();
    else openSettings();
  };

  // ── click-through everywhere except interactive elements ──
  // The stage box is 300×400 but the potato only fills part of it, so the
  // window takes the mouse strictly where something real sits under the
  // cursor: his raycast silhouette (holder-only cast — the ground shadow is
  // outside the holder and stays click-through), the hover panel's visible
  // controls, or a popup. The speech bubble / mutter card are pointer-events:
  // none, so the desktop above his head stays usable while he talks.
  let onPotato = false; // cursor currently over his silhouette (throttle-cached)
  let lastCast = 0;
  let castTrail = 0; // deferred re-cast for a sample the throttle swallowed
  let lastPos: { x: number; y: number } | null = null; // last in-window pointer spot

  function refreshMouseRegion(cx: number, cy: number): void {
    clearTimeout(castTrail);
    const el = document.elementFromPoint(cx, cy);
    const onStage = !!(el && el.closest('#stage'));
    const was = onPotato;
    if (!onStage) {
      onPotato = false;
      lastCast = 0; // next stage entry raycasts immediately
    } else if (performance.now() - lastCast > 40) {
      // raycasting the model on every high-rate mousemove would be wasteful —
      // one cast per ~40ms, the verdict holds in between
      lastCast = performance.now();
      onPotato = !!ctx.scene.pick(cx, cy);
    } else {
      // this sample fell inside the hold — re-cast once when it expires, so a
      // pointer that stops right after crossing his outline can't keep a stale
      // verdict (no newer mousemove means the cursor is still at cx, cy)
      castTrail = window.setTimeout(() => refreshMouseRegion(cx, cy), 45);
    }
    // his silhouette is also the hover-panel trigger now, not the stage box
    if (onPotato && !was) showPanel();
    else if (!onPotato && was) hidePanelSoon();
    const interactive =
      // while the potato is being dragged, hold the window mouse-active even
      // as the cursor outruns the moving silhouette
      !!drag ||
      onPotato ||
      !!(el && el.closest('[data-interactive]'));
    pp?.win.setIgnoreMouse(!interactive);
  }

  document.addEventListener('mousemove', (e) => {
    lastPos = { x: e.clientX, y: e.clientY };
    refreshMouseRegion(e.clientX, e.clientY);
  });
  document.addEventListener('mouseleave', () => {
    lastPos = null;
    clearTimeout(castTrail);
    onPotato = false;
    lastCast = 0;
    pp?.win.setIgnoreMouse(true);
    hidePanelSoon();
  });
  // He also moves under a parked cursor — hops, skits, edge naps and
  // spring-backs all shift the silhouette with no mousemove to notice it. A
  // slow re-check at the resting spot keeps the hit region honest (cheap:
  // off-stage it's just an elementFromPoint, on stage one BVH cast per tick).
  window.setInterval(() => {
    if (lastPos && !drag) refreshMouseRegion(lastPos.x, lastPos.y);
  }, 200);

  // turns to watch your cursor (Turn 5) — the main process polls the global cursor so he
  // keeps watching even while the pointer roams other windows; eyes lead, head
  // follows (Turn 6). ±420px from his nose = full turn.
  let lastCursor: { x: number; y: number } | null = null;
  pp?.on('cursor', ({ x, y, sameDisplay }) => {
    // presence for the brain: the cursor actually moving means you're there
    if (lastCursor && Math.abs(x - lastCursor.x) + Math.abs(y - lastCursor.y) > 3) ctx.brain.pointerMove();
    lastCursor = { x, y };
    // on another monitor → canAct() parks idle behavior (older preloads
    // don't send the flag — treat missing as "same display")
    ctx.otherDisplay = sameDisplay === false;
    // immersive mode / edge dock: presence still registers (cheap, and the
    // brain is gated anyway), but his eyes stay off your cursor — while docked
    // they rest on the screen's interior instead (see Animator.setDock)
    if (ctx.state.immersive || ctx.anim().docked) return;
    if (ctx.anim().tucked || drag) return;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.55; // eye line, not stage center
    ctx.anim().facePoint(
      Math.max(-1, Math.min(1, (x - cx) / 420)),
      Math.max(-1, Math.min(1, (y - cy) / 420))
    );
  });
}
