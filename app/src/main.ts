// Bootstrap: construct the scene + brain, seed the shared context, and wire
// the feature modules together. All feature logic lives under src/app/;
// rendering under src/scene/; popup markup under src/ui/.
import { SpudBrain } from './brain';
import { CHARS, PERS, TXT, daypart, greet, pool } from './content';
import { lang, setLangPref } from './locale';
import * as remote from './remote';
import { PetScene } from './scene/scene';
import { setSoundEnabled, sfx } from './sfx';
import * as store from './store';
import { isOverlayOpen } from './ui/overlay';
import { $, ctx, pp } from './app/context';
import { installDebugHooks } from './app/debug';
import { wireInteractions } from './app/interactions';
import { applyLangPref } from './app/lang';
import { presentCare } from './app/panels';
import { bubble, showMutter, spawnEmote } from './app/speech';
import { checkUnlocks } from './app/unlocks';

const state = store.load();
// dev: PP_DEBUG=1 unlocks the whole crew so you can switch characters and test
// them without grinding each unlock condition
if (pp?.debug) state.unlockedIds = CHARS.map((c) => c.id);

setSoundEnabled(state.sound && !state.immersive); // immersive mode gates sound off
setLangPref(state.lang); // resolve the language before any text renders

const scene = new PetScene($('pet') as HTMLCanvasElement);
ctx.init(state, scene);
scene.setPetSize(state.petSize); // apply the saved size before the model lands
// Model load runs in the background — an await here used to hold up the whole
// boot (interaction wiring included), so the window stayed click-through until
// the GLB was decoded. Everything below only needs the animator, which exists
// from the scene constructor; the greeting at the bottom gates on this promise
// so he never speaks before he's visible.
const modelReady = scene.setCharacter(state.active).catch((e) => {
  console.warn('[boot] model load failed:', e instanceof Error ? e.message : e);
});

// pull today's server-generated card pool (non-blocking — draws fall back to the
// built-in DAILY pool until it arrives), then re-poll hourly: the pet runs for
// days on end, and without this the "daily" pool would only ever change on app
// restart (the cron flips it at midnight Asia/Shanghai)
remote.refresh();
setInterval(() => remote.refresh(), 60 * 60 * 1000);

// ── personality engine (7a) — needs-driven autonomy, ported from lib/spud-brain.js ──
const per = state.personality || {};
ctx.brain = new SpudBrain({
  animator: ctx.anim(),
  personality: {
    curious: (per.curiosity ?? 65) / 100,
    clingy: (per.clinginess ?? 60) / 100,
    drama: (per.drama ?? 55) / 100,
    sleepy: (per.sleepiness ?? 35) / 100,
  },
  // no decisions while you're actually using him (chat, book, weave), he's
  // docked against a screen edge, or immersive mode has him on quiet duty
  // (no idle mutters, routines, knocks or dozes — tap reactions still work)
  canAct: () =>
    !state.immersive && !ctx.anim().docked &&
    !ctx.anim().tucked && !isOverlayOpen() && !ctx.chatBusy && !ctx.weaving &&
    document.visibilityState !== 'hidden' && document.activeElement !== $('chatInput'),
  // fresh daily mutters (pre-generated server-side, no real-time LLM); ~half of
  // idle mutters come from today's batch, the rest from the built-in lines
  serverMutters: (mood) => remote.mutterPool(ctx.activeChar().id, mood),
  mutterFreshChance: 0.5,
  on: {
    mutter: (text) => showMutter(text),
    speak: (text, ms) => bubble(text, { hold: ms }),
    emote: (g) => spawnEmote(g),
    sfx: (n) => { const f = (sfx as Record<string, (() => void) | undefined>)[n]; if (f) f(); },
    state: (key, label) => { if (pp.debug) console.log('[brain]', key, label); },
    log: (e) => { if (pp.debug) console.log('[brain]', e.kind, e.text); },
  },
});

// every save also re-checks unlock conditions and the Buddies badge dot
ctx.onPersist(() => {
  checkUnlocks();
  $('buddiesDot').classList.toggle('hidden', !state.buddyNew);
});

wireInteractions();

// ── language switch: the ⚙ settings panel and the tray menu share one path
// (app/lang.ts applyLangPref); the tray reaches it through this IPC push ──
pp.on('set-lang', (pref) => applyLangPref(pref));
pp.lang?.report(state.lang, lang()); // initial sync so the tray matches the saved pref

// ── update feedback: the updater's answers come out of the potato's own
// mouth — macOS may swallow system notifications, but nobody can mute him ──
pp.on('update-note', (text) => {
  if (typeof text === 'string' && text) bubble(text, { hold: 3600 });
});

// (the old random idle-hop scheduler is gone — the soul engine (7a) owns
// autonomous behavior now: boredom routines, dozing, knocking, mutters)

// night care at 23:00 (once per day) — only when he's actually been keeping
// us company across the 23:00 boundary. If the machine was off or asleep at 11
// and the app only came up later, we skip tonight's card rather than firing a
// stale catch-up the moment we open.
let lastCareTick = Date.now();
setInterval(() => {
  const now = new Date();
  const sinceLast = now.getTime() - lastCareTick;
  const prevHour = new Date(lastCareTick).getHours();
  lastCareTick = now.getTime();

  const today = state.lastDate;
  const crossedIntoNight = prevHour < 23 && now.getHours() >= 23;
  const ranThrough = sinceLast < 90_000; // continuous ticks, not a cold boot / wake gap
  if (crossedIntoNight && ranThrough && state.nightShownDate !== today) {
    state.nightShownDate = today;
    store.save(state);
    const nm = pool('nightMsg');
    presentCare(TXT().ui.careNight, nm[Math.floor(Math.random() * nm.length)]);
  }
}, 60000);

// sedentary reminder from the main process (90 min continuous activity)
pp.on('sedentary', () => {
  const sd = pool('sedentary');
  presentCare(TXT().ui.careStretch, sd[Math.floor(Math.random() * sd.length)]);
});

// ── boot ──
$('buddiesDot').classList.toggle('hidden', !state.buddyNew);
ctx.updateCardScreen();
pp.win.setIgnoreMouse(true);

installDebugHooks();

// Open-the-app greeting: a fresh, personalized hello from the LLM, coloured by
// what he remembers and the time of day. Falls back to a built-in daypart line
// when the LLM is unreachable / over budget. Returns null on any failure.
async function personalGreeting(): Promise<string | null> {
  if (!pp?.ai?.greet) return null; // no bridge (older preload)
  const ch = ctx.activeChar();
  try {
    return await pp.ai.greet({
      charId: ch.id,
      charName: ch.name,
      voice: PERS[ch.id].voice,
      daypart: daypart(),
      day: state.day,
      memory: state.memory.slice(-6),
      lang: lang(),
    });
  } catch (e) {
    return null;
  }
}

// Fire the greeting request at launch so it's usually ready by the time he
// speaks — no built-in-then-swap flicker.
const greetingReq = personalGreeting();

// … but not before the model is actually on screen: with the load running in
// the background, a fixed timer alone could have him wave and speak into an
// empty stage on a slow disk / first launch
const bootBeat = new Promise((r) => setTimeout(r, 900));
Promise.all([modelReady, bootBeat]).then(async () => {
  ctx.anim().play(scene.hasRig() ? 'wave' : 'hop'); // time-of-day greeting
  if (state.drawn) return;
  // prefer the personalized line, but never leave him silent: fall back to the
  // built-in daypart greeting if the LLM is slow / offline / over budget
  const line = await Promise.race([
    greetingReq,
    new Promise<string | null>((r) => setTimeout(() => r(null), 2200)),
  ]);
  if (state.drawn) return;
  bubble(line || greet(state.active), { hold: 5200 });
});
