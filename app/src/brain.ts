// SpudBrain ported from the design prototype's lib/spud-brain.js (Turn 7 ·
// soul engine) — keep in sync with it.
//
//   Three needs drift over time:      energy / boredom / social (missing you)
//   A utility tick (every 200ms) picks what to do:
//     boredom high  → self-play routine (tail-chase, card-juggle, study…)
//     energy  low   → doze off (nod-and-catch), wakes when rested/startled
//     social  high  → proactively knock on the "glass"; if ignored → sulk,
//                     back-off doubles (never annoying)
//
// App deviations from the prototype:
//   - presence comes from the global cursor poll (any movement = you're
//     there), not canvas hover — he lives on the desktop, not in a demo box
//   - poke() returns true when the brain consumed the tap (waking him /
//     answering his knock); plain pokes fall through to the app's own lines
//   - canAct() gate: no decisions or mutters while you're chatting, weaving,
//     browsing the Book, or he's tucked away
//   - routine step mutter/speak lines are variant pools (arrays picked at
//     random), not the prototype's single fixed strings
import { pool, type MutterPool } from './content';
import type { AnimMode, Animator } from './scene/motions';

export type BrainState =
  | 'watch' | 'alone' | 'play' | 'doze' | 'knock' | 'wait' | 'sulk' | 'greet';

export const STATE_LABEL: Record<BrainState, string> = {
  watch: 'watching you work', alone: 'hanging out', play: 'self-play', doze: 'dozing',
  knock: 'saying hi', wait: 'waiting for you', sulk: 'feeling ignored', greet: 'welcome back',
};

// All spoken text (mutter pools, social lines, routine step lines) lives in
// the language packs — TXT().mutter / .speak / .routines — and is resolved at
// speak time, so a language switch applies to the very next line.

export interface Personality {
  curious: number;
  clingy: number;
  drama: number;
  sleepy: number;
}

interface Needs {
  energy: number;
  boredom: number;
  social: number;
}

/* self-play routines: weight fn of personality, energy cost, step script.
   step: { clip | mode | mutter | speak | sfx | emote | wait(ms real) }
   mutter/speak take a string, an array of variants (picked at random), or a
   thunk resolved at play time — the language-pack lines are thunks so they
   follow the active language */
export type SpokenLine = string | string[] | (() => string | string[]);

export interface RoutineStep {
  clip?: string;
  mode?: AnimMode;
  mutter?: SpokenLine;
  speak?: SpokenLine;
  sfx?: string;
  emote?: string;
  wait?: number;
}

export interface Routine {
  label: string;
  cost: number;
  w: (P: Personality) => number;
  steps: RoutineStep[];
}

export type RoutineKey =
  | 'chase' | 'juggle' | 'study' | 'practice' | 'hum' | 'stretch' | 'peek' | 'sneeze';

const ROUTINES: Record<RoutineKey, Routine> = {
  chase: {
    label: 'tail-chase', cost: 14, w: (P) => 0.5 + P.drama * 0.9,
    steps: [
      { mutter: () => pool('routines', 'chaseStart'), wait: 1500 },
      { clip: 'chase', sfx: 'whoosh', wait: 2350 },
      { clip: 'wobble', wait: 2400 },
      { mutter: () => pool('routines', 'chaseEnd') },
    ],
  },
  juggle: {
    label: 'card-juggle', cost: 10, w: (P) => 0.4 + P.drama * 0.8,
    steps: [
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'hop', sfx: 'boing', wait: 900 },
      { mutter: () => pool('routines', 'juggleEnd') },
    ],
  },
  study: {
    label: 'card-study', cost: 5, w: (P) => 0.4 + P.curious * 0.9,
    steps: [
      { mutter: () => pool('routines', 'studyStart'), wait: 1300 },
      { clip: 'cardStudy', wait: 3450 },
      { mutter: () => pool('routines', 'studyEnd') },
    ],
  },
  practice: {
    label: 'wave practice', cost: 8, w: (P) => 0.35 + P.drama * 0.6,
    steps: [
      { mutter: () => pool('routines', 'practiceStart'), wait: 1400 },
      { clip: 'wave', wait: 1800 },
      { clip: 'wave', wait: 1900 },
      { mutter: () => pool('routines', 'practiceEnd') },
    ],
  },
  hum: {
    label: 'humming', cost: 6, w: (P) => 0.55 - P.drama * 0.2,
    steps: [
      { mode: 'hum', emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1300 },
      { emote: '♪', wait: 1300 },
      { mode: 'idle', mutter: () => pool('routines', 'humEnd') },
    ],
  },
  stretch: {
    label: 'stretch', cost: -4, w: () => 0.45,
    steps: [
      { clip: 'stretch', wait: 2450 },
      { mutter: () => pool('routines', 'stretchEnd') },
    ],
  },
  peek: {
    label: 'look-around', cost: 2, w: (P) => 0.3 + P.curious * 0.5,
    steps: [{ clip: 'peek', wait: 1650 }],
  },
  sneeze: {
    label: 'sneeze', cost: 3, w: () => 0,
    steps: [
      { clip: 'sneeze', sfx: 'sneeze', wait: 1450 },
      { mutter: () => pool('routines', 'sneezeEnd') },
    ],
  },
};
export const ROUTINE_KEYS: RoutineKey[] = ['chase', 'juggle', 'study', 'practice', 'hum', 'stretch', 'peek', 'sneeze'];

/* total playtime of a routine's step script (ms) — the app debounces taps
   against this so a click-launched show can't be piled onto */
export function routineMs(key: string): number {
  const r = ROUTINES[key as RoutineKey];
  return r ? r.steps.reduce((s, st) => s + (st.wait || 400), 0) : 0;
}

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export interface BrainCallbacks {
  mutter?: (text: string) => void;
  speak?: (text: string, ms?: number) => void;
  emote?: (g: string) => void;
  sfx?: (n: string) => void;
  state?: (key: BrainState, label: string) => void;
  log?: (e: { kind: string; text: string }) => void;
  needs?: (n: Needs) => void;
}

export interface BrainOptions {
  animator: Animator;
  on?: BrainCallbacks;
  personality?: Partial<Personality>;
  timeScale?: number;
  canAct?: () => boolean;
  // today's flavor mutters for the ACTIVE buddy (small, in its own voice) — a
  // thunk so buddy switches apply immediately; mixed in at FLAVOR_CHANCE
  flavor?: () => string[] | null;
}

// How often an idle mutter comes from the active buddy's tiny flavor set
// instead of the shared pool — enough accent to be felt, rare enough that the
// ~4 flavor lines don't wear out within a day.
const FLAVOR_CHANCE = 0.15;

export class SpudBrain {
  A: Animator;
  on: BrainCallbacks;
  P: Personality;
  timeScale: number;
  canAct: () => boolean;
  flavor: () => string[] | null;
  needs: Needs;
  state: BrainState;
  clock: number;
  lastPointer: number;
  leftAt: number;
  simAway: boolean;
  busy: boolean;
  seqT: number;
  lastMutterClock: number;
  mutterGap: number;
  lastKnockClock: number;
  knockBackoff: number;
  waitDeadline: number;
  lastZz: number;
  seen: WeakMap<string[], Set<number>>; // no-replacement bookkeeping: per pool array, the indices already drawn this lap
  lastTick: number;
  disposed: boolean;
  timer: number;
  lastRoutine?: RoutineKey;

  constructor({ animator, on = {}, personality, timeScale = 1, canAct, flavor }: BrainOptions) {
    this.A = animator;
    this.on = on;                       // callbacks: mutter/speak/emote/state/log/needs/sfx
    this.P = { curious: 0.65, clingy: 0.6, drama: 0.55, sleepy: 0.35, ...(personality || {}) };
    this.timeScale = timeScale;
    this.canAct = canAct || (() => true);
    this.flavor = flavor || (() => null);
    this.needs = { energy: 74, boredom: 38, social: 30 };
    this.state = 'alone';
    this.clock = 0;                     // scaled seconds lived
    this.lastPointer = -1e9;            // real ms
    this.leftAt = 0; this.simAway = false;
    this.busy = false; this.seqT = 0;
    // start the mutter clock at 0 (not -∞) so the first idle thought waits a
    // full gap after launch — otherwise he blurts one on the first tick, before
    // the boot greeting has a chance to speak
    this.lastMutterClock = 0; this.mutterGap = this.randMutterGap();
    this.lastKnockClock = -30; this.knockBackoff = 1;
    this.waitDeadline = 0;              // scaled clock deadline for knock reply
    this.lastZz = 0; this.seen = new WeakMap();
    this.lastTick = performance.now();
    this.disposed = false;
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  /* ── public api ── */
  setPersonality(p: Partial<Personality>): void { Object.assign(this.P, p); }
  setTimeScale(x: number): void { this.timeScale = x; }
  setAway(v: boolean): void {
    this.simAway = v;
    if (v) { this.leftAt = performance.now(); this.log('sys', '(pretending to step away…)'); }
    else this.pointerMove(true);
  }
  pointerMove(force?: boolean): void {
    const now = performance.now();
    const wasAwayFor = now - Math.max(this.lastPointer, this.leftAt || 0);
    const wasAway = this.present() === false;
    this.lastPointer = now;
    if (this.simAway && !force) return;
    // greet only after a real break — a short step-away (grabbing water, a
    // quick chat) greeting back every time reads as clingy, not warm
    if ((wasAway && wasAwayFor > 600000) || force) this.greetBack();
  }
  pointerLeft(): void { this.leftAt = performance.now(); }
  /* returns true when the brain consumed the tap (wake / knock reply) */
  poke(): boolean {
    this.lastPointer = performance.now();
    this.needs.social = Math.max(4, this.needs.social - 42);
    this.needs.boredom = Math.max(0, this.needs.boredom - 16);
    if (this.state === 'doze') {
      this.abortSeq();
      this.A.setMode('idle');
      this.A.play('startle');
      this.emitSfx('boing');
      this.needs.energy = Math.min(100, this.needs.energy + 22);
      this.setState('watch');
      this.log('act', 'poked awake');
      setTimeout(() => this.mutter(this.fresh('wake')), 650);
      return true;
    }
    if (this.state === 'wait' || this.state === 'knock') { this.replyArrived(); return true; }
    return false;
  }
  force(key: string): void {
    if (key === 'doze') { this.startDoze(true); return; }
    if (key === 'knock') { this.startKnock(true); return; }
    const r = ROUTINES[key as RoutineKey];
    if (r) this.runRoutine(key as RoutineKey, r);
  }
  /* app hook: the human started doing something (chat, book, weave, tuck) —
     drop whatever we were up to and get out of the way */
  interrupt(): void {
    this.abortSeq();
    this.A.setMode('idle');
    this.setState(this.present() ? 'watch' : 'alone');
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); clearTimeout(this.seqT); }

  /* ── internals ── */
  present(): boolean { return !this.simAway && performance.now() - this.lastPointer < 25000; }
  nearBy(): boolean { return !this.simAway && performance.now() - this.lastPointer < 60000; }
  // Gap between idle mutters. Kept deliberately long — a desk pet muttering
  // every ~10s reads as nagging; ~90–180s (at default curiosity) feels like
  // occasional company. Still personality-scaled: higher curiosity → shorter.
  randMutterGap(): number { return (93 + Math.random() * 93) / (0.55 + this.P.curious * 0.75); }
  fresh(poolKey: MutterPool): string {
    // Occasionally the active buddy's own tiny flavor set — its accent — and
    // otherwise today's shared pool for this mood (all six moods via
    // Bubbles.mutter), else the built-in lines. Always without replacement,
    // so a pool cycles fully before any repeat.
    const fl = this.flavor();
    if (fl && fl.length && Math.random() < FLAVOR_CHANCE) return this.pickNoRepeat(fl);
    return this.pickNoRepeat(pool('mutter', poolKey));
  }
  // Draw one line from a pool WITHOUT replacement. Used indices are tracked per
  // pool array (keyed by identity — TXT() and server pools are stable references
  // within a language/day), and only reshuffle once every line has been shown.
  // This is what kills the "same mutter again a few lines later" repetition a
  // plain random pick caused on these small pools.
  pickNoRepeat(pool: string[]): string {
    if (!pool || !pool.length) return '';
    if (pool.length === 1) return pool[0]!;
    let used = this.seen.get(pool);
    if (!used || used.size >= pool.length) { used = new Set(); this.seen.set(pool, used); }
    let i = Math.floor(Math.random() * pool.length);
    while (used.has(i)) i = Math.floor(Math.random() * pool.length);
    used.add(i);
    return pool[i]!;
  }
  // Resolve a spoken line (string, variant array, or fn returning either) to
  // text; variant arrays draw without replacement via pickNoRepeat.
  pickLine(v: SpokenLine): string {
    const r = typeof v === 'function' ? v() : v;
    return Array.isArray(r) ? this.pickNoRepeat(r) : r;
  }
  emitSfx(n: string): void { this.on.sfx && this.on.sfx(n); }
  log(kind: string, text: string): void { this.on.log && this.on.log({ kind, text }); }
  mutter(text: string): void { if (!text) return; this.on.mutter && this.on.mutter(text); this.log('mutter', text); this.lastMutterClock = this.clock; }
  speak(text: string, ms?: number): void { this.on.speak && this.on.speak(text, ms || 3400); this.emitSfx('pop'); this.log('speak', text); }
  emote(g: string): void { this.on.emote && this.on.emote(g); }
  setState(s: BrainState): void {
    if (this.state === s) return;
    this.state = s;
    this.on.state && this.on.state(s, STATE_LABEL[s]);
  }

  tick(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dtReal = Math.min(0.35, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const dt = dtReal * this.timeScale;
    this.clock += dt;
    const N = this.needs, P = this.P;
    const present = this.present();
    const dozing = this.state === 'doze';
    const blocked = !this.canAct();

    /* needs drift (frozen while the app has him busy elsewhere) */
    if (!blocked) {
      N.energy = Math.max(0, Math.min(100, N.energy + dt * (dozing ? 2.6 : this.busy ? -0.9 * (0.8 + P.drama * 0.5) : -0.12)));
      if (!this.busy && !dozing) N.boredom = Math.max(0, Math.min(100, N.boredom + dt * (present ? 0.34 : 0.62)));
      if (!dozing) N.social = Math.max(0, Math.min(100, N.social + dt * (present ? 0.3 * (0.55 + P.clingy * 0.9) : 0.28)));
    }
    this.on.needs && this.on.needs(N);

    /* doze upkeep: Zz emotes, snore-catch sfx, natural wake */
    if (dozing) {
      if (now - this.lastZz > 2300) { this.lastZz = now; this.emote('z'); }
      if (this.A.out && this.A.out.nodCatch) this.emitSfx('catch');
      if (N.energy > 66 + P.sleepy * 22) {
        this.A.setMode('idle');
        this.setState(present ? 'watch' : 'alone');
        this.log('act', 'well rested — woke up on his own');
        // an occasional wake-up stretch — kept infrequent on purpose
        if (!blocked && Math.random() < 0.12) this.runRoutine('stretch', ROUTINES.stretch, true);
      }
      return;
    }

    if (blocked) return;

    /* knock reply window */
    if (this.state === 'wait') {
      if (this.clock > this.waitDeadline) this.knockIgnored();
      return;
    }
    if (this.busy || this.state === 'knock' || this.state === 'greet' || this.state === 'sulk') return;

    /* baseline state */
    this.setState(present ? 'watch' : 'alone');

    /* decisions, roughly by priority */
    if (N.energy < 15 + P.sleepy * 24) { this.startDoze(); return; }
    // knocking on the "glass" is the most attention-demanding thing he does
    // (it comes with a knock sfx), so the bar is set high and the buildup slow
    if (N.social > 92 - P.clingy * 22 && this.nearBy() && (this.clock - this.lastKnockClock) > 38 * this.knockBackoff) {
      this.startKnock(); return;
    }
    if (N.boredom > 64 - P.drama * 18) {
      const keys: RoutineKey[] = ['chase', 'juggle', 'study', 'practice', 'hum', 'peek'];
      const weighted = keys.flatMap((k) => Array<RoutineKey>(Math.max(1, Math.round(ROUTINES[k].w(P) * 10))).fill(k));
      let k = pick(weighted);
      if (k === this.lastRoutine) k = pick(weighted);
      this.runRoutine(k, ROUTINES[k]);
      return;
    }
    if (Math.random() < dt * 0.004) { this.runRoutine('sneeze', ROUTINES.sneeze, true); return; }
    // spontaneous stretch — deliberately rare (~9 min mean when idle)
    if (Math.random() < dt * 0.0018) { this.runRoutine('stretch', ROUTINES.stretch, true); return; }

    /* idle mutters */
    if (this.clock - this.lastMutterClock > this.mutterGap) {
      this.mutterGap = this.randMutterGap();
      const poolKey = present ? 'watch' : (N.social > 55 ? 'lonely' : 'alone');
      this.mutter(this.fresh(poolKey));
    }
  }

  runRoutine(key: RoutineKey, r: Routine, quiet?: boolean): void {
    if (this.busy) return;
    this.lastRoutine = key;
    this.busy = true;
    this.setState('play');
    if (!quiet) this.log('act', `self-play → ${r.label} (boredom ${Math.round(this.needs.boredom)})`);
    else this.log('act', r.label);
    this.needs.boredom = Math.max(0, this.needs.boredom - 30);
    this.needs.energy = Math.max(0, this.needs.energy - r.cost);
    this.runSteps([...r.steps], () => {
      this.busy = false;
      this.A.setMode('idle');
      this.setState(this.present() ? 'watch' : 'alone');
    });
  }

  runSteps(steps: RoutineStep[], done?: () => void): void {
    if (this.disposed) return;
    const s = steps.shift();
    if (!s) { done && done(); return; }
    if (s.clip) this.A.play(s.clip);
    if (s.mode) this.A.setMode(s.mode);
    if (s.sfx) this.emitSfx(s.sfx);
    if (s.mutter) this.mutter(this.pickLine(s.mutter));
    if (s.speak) this.speak(this.pickLine(s.speak));
    if (s.emote) this.emote(s.emote);
    this.seqT = window.setTimeout(() => this.runSteps(steps, done), s.wait || 400);
  }

  abortSeq(): void { clearTimeout(this.seqT); this.busy = false; }

  startDoze(forced?: boolean): void {
    this.abortSeq();
    this.setState('doze');
    this.A.setMode('doze');
    this.log('act', forced ? 'put to sleep by hand' : `sleepy (energy ${Math.round(this.needs.energy)}) → dozing off`);
    setTimeout(() => { if (this.state === 'doze') this.mutter(this.fresh('sleepy')); }, 1200);
  }

  startKnock(forced?: boolean): void {
    this.abortSeq();
    this.busy = true;
    this.setState('knock');
    this.lastKnockClock = this.clock;
    this.log('act', forced ? 'knock (manually triggered)' : `missing-you meter ${Math.round(this.needs.social)} maxed → knocking`);
    this.runSteps([
      { clip: 'peek', wait: 1100 },
      { clip: 'knock', sfx: 'knock', wait: 700 },
      { speak: () => pool('speak', 'knock'), wait: 1300 },
    ], () => {
      this.busy = false;
      this.setState('wait');
      this.waitDeadline = this.clock + 9;
    });
  }

  replyArrived(): void {
    this.abortSeq();
    this.busy = true;
    this.setState('greet');
    this.knockBackoff = 1;
    this.needs.social = 10;
    this.log('act', 'you responded! happiness +999');
    this.emote('♥'); this.emote('♥');
    this.runSteps([
      { clip: 'cheer', sfx: 'chime', wait: 1600 },
      { speak: () => pool('speak', 'delight'), wait: 1400 },
    ], () => { this.busy = false; this.setState('watch'); });
  }

  knockIgnored(): void {
    this.busy = true;
    this.setState('sulk');
    this.knockBackoff = Math.min(8, this.knockBackoff * 2);
    this.needs.social = 46;
    this.log('act', `no reply… backoff ×${this.knockBackoff}, off to self-play`);
    this.runSteps([
      { clip: 'sulk', wait: 2500 },
      { mutter: this.fresh('ignored'), wait: 1500 },
    ], () => {
      this.busy = false;
      this.setState(this.present() ? 'watch' : 'alone');
      this.needs.boredom = Math.min(100, this.needs.boredom + 18);
    });
  }

  greetBack(): void {
    if (this.busy && this.state !== 'doze') return;
    if (!this.canAct()) return;
    if (this.state === 'doze') {
      this.A.setMode('idle');
      this.A.play('startle');
      this.needs.energy = Math.min(100, this.needs.energy + 15);
    }
    this.abortSeq();
    this.busy = true;
    this.setState('greet');
    this.needs.social = Math.max(6, this.needs.social - 30);
    this.log('act', 'you are back → greeting');
    this.runSteps([
      { clip: 'hop', sfx: 'boing', wait: 750 },
      { speak: () => pool('speak', 'greet'), wait: 1500 },
    ], () => { this.busy = false; this.setState('watch'); });
  }
}
