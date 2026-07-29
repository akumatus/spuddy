// Bootstrap: construct the scene + brain, seed the shared context, and wire
// the feature modules together. All feature logic lives under src/app/;
// rendering under src/scene/; popup markup under src/ui/.
import { SpudBrain } from './brain';
import { CHARS, TXT, daypart, greet, pool } from './content';
import { lang, setLangPref } from './locale';
import * as remote from './remote';
import { PetScene } from './scene/scene';
import { setSoundEnabled, sfx } from './sfx';
import * as store from './store';
import { isOverlayOpen } from './ui/overlay';
import { $, ctx, pp } from './app/context';
import { initConsolidate } from './app/consolidate';
import { installDebugHooks } from './app/debug';
import { initDistill } from './app/distill';
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

// catch up on a transcript tail left undistilled by quitting mid-lull
// (batch memory extraction — see app/distill.ts)
initDistill();
// weekly-ish memory curation, after the distill catch-up settles
// (merge fragments, refresh aged wording, retire long-passed states)
initConsolidate();

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
  // docked against a screen edge, immersive mode has him on quiet duty, or
  // your cursor lives on another display (no idle mutters, routines, knocks
  // or dozes — tap reactions still work)
  canAct: () =>
    !state.immersive && !ctx.anim().docked && !ctx.otherDisplay &&
    !ctx.anim().tucked && !isOverlayOpen() && !ctx.chatBusy && !ctx.weaving &&
    document.visibilityState !== 'hidden' && !ctx.chatFocused,
  // the active buddy's daily flavor mutters — its accent, mixed into the
  // shared pools at a low rate (brain FLAVOR_CHANCE)
  flavor: () => remote.flavor(ctx.activeChar().id, 'mutter'),
  on: {
    mutter: (text) => showMutter(text),
    speak: (text, ms) => bubble(text, { hold: ms }),
    emote: (g) => spawnEmote(g),
    sfx: (n) => { const f = (sfx as Record<string, (() => void) | undefined>)[n]; if (f) f(); },
    state: (key, label) => { if (pp?.debug) console.log('[brain]', key, label); },
    log: (e) => { if (pp?.debug) console.log('[brain]', e.kind, e.text); },
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
pp?.on('set-lang', (pref) => applyLangPref(pref));
pp?.lang?.report(state.lang, lang()); // initial sync so the tray matches the saved pref

// ── update feedback: the updater's answers come out of the potato's own
// mouth — macOS may swallow system notifications, but nobody can mute him ──
pp?.on('update-note', (text) => {
  if (typeof text === 'string' && text) bubble(text, { hold: 3600 });
});

// (the old random idle-hop scheduler is gone — the soul engine (7a) owns
// autonomous behavior now: boredom routines, dozing, knocking, mutters)

// midnight watch: he stays open for days at a time, so the calendar must roll
// at runtime too — load()-only rollover would freeze day/streak/draws (and the
// daily first-draw golden) for as long as he keeps us company. Also catches a
// sleep→wake gap that jumped the boundary. The held card stays in his hands:
// clearing it is a per-launch thing, and it'd be jarring mid-session.
setInterval(() => {
  if (store.rollDay(state)) {
    store.save(state);
    ctx.updateCardScreen(); // the held card's "DAY n" footer
  }
}, 60000);

// night care during the 23:00 hour (once per day) — and only to a human who is
// actually there. The wall clock alone knows nothing about presence: the old
// 23:00 edge trigger fired even when the display had been dark for hours (a
// machine kept awake overnight, or a Power Nap dark-wake straddling 23:00) and
// the card then sat in the overlay till morning — a "goodnight" at 8am. So gate
// on input recency instead, and retry through the hour: stepping away right at
// 23:00 still gets the card on return at 23:20, being busy in a panel gets it
// once the panel closes, and an empty chair all hour gets no card at all.
// nightShownDate is stamped only when the card actually presented — the old
// stamp-then-try lost the card entirely if he happened to be docked at 23:00.
const NIGHT_IDLE_GATE = 120; // seconds since last input that still count as "there"
setInterval(async () => {
  if (new Date().getHours() < 23) return; // past midnight rollDay makes it tomorrow, closing the window
  const today = state.lastDate;
  if (state.nightShownDate === today) return;
  const idle = pp?.idleSeconds ? await pp.idleSeconds().catch(() => 0) : 0; // no bridge (browser dev) → assume present
  if (idle > NIGHT_IDLE_GATE) return;
  const nm = pool('nightMsg');
  if (!presentCare(TXT().ui.careNight, nm[Math.floor(Math.random() * nm.length)])) return; // busy/docked — retry next minute
  state.nightShownDate = today;
  store.save(state);
}, 60000);

// sedentary reminder from the main process (90 min continuous activity)
pp?.on('sedentary', () => {
  const sd = pool('sedentary');
  presentCare(TXT().ui.careStretch, sd[Math.floor(Math.random() * sd.length)]);
});

// ── boot ──
$('buddiesDot').classList.toggle('hidden', !state.buddyNew);
ctx.updateCardScreen();
pp?.win.setIgnoreMouse(true);

installDebugHooks();

// Personalized follow-up hello: when an open thread is pending (yesterday's
// interview, that stubborn bug), he asks how it went a beat after the pool
// hello — the canned line lands instantly, the caring question follows once
// the server answers. Fired only when a thread exists, so quiet days cost no
// quota; any failure just means the pool hello stands alone.
async function greetFollowUp(): Promise<void> {
  const loops = store.activeLoops(state);
  if (!loops.length || !pp?.ai.greet) return;
  const minBeat = new Promise((r) => setTimeout(r, 7000)); // let the hello finish its dwell
  const text = await Promise.all([
    pp.ai.greet({
      charId: state.active,
      day: state.day,
      daypart: daypart(),
      memory: store.activeMemory(state),
      loops,
      lang: lang(),
    }).catch(() => null),
    minBeat,
  ]).then(([t]) => t);
  // stand down if the moment passed: they started chatting or drew the card
  if (!text || ctx.chatBusy || state.drawn || isOverlayOpen()) return;
  bubble(text, { hold: 8000, type: true });
}

// Open-the-app greeting: today's daypart line from the daily pool (with the
// built-in pack line as offline fallback) — no LLM round-trip at boot.
// But not before the model is actually on screen: with the load running in
// the background, a fixed timer alone could have him wave and speak into an
// empty stage on a slow disk / first launch
const bootBeat = new Promise((r) => setTimeout(r, 900));
Promise.all([modelReady, bootBeat]).then(() => {
  ctx.anim().play(scene.hasRig() ? 'wave' : 'hop'); // time-of-day greeting
  if (state.drawn) return;
  bubble(greet(state.active), { hold: 5200 });
  void greetFollowUp();
});
