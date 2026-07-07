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
import type { AnimMode, Animator } from './scene/motions';
import type { MutterMood } from './types';

export type BrainState =
  | 'watch' | 'alone' | 'play' | 'doze' | 'knock' | 'wait' | 'sulk' | 'greet';

// built-in mutter pools — the three MutterMood ones also have server pools
type MutterPool = MutterMood | 'sleepy' | 'ignored' | 'wake';

export const STATE_LABEL: Record<BrainState, string> = {
  watch: 'watching you work', alone: 'hanging out', play: 'self-play', doze: 'dozing',
  knock: 'saying hi', wait: 'waiting for you', sulk: 'feeling ignored', greet: 'welcome back',
};

const MUTTER: Record<MutterPool, string[]> = {
  watch: [
    'clack clack clack. look at them go.',
    'so focused today. proud. quietly.',
    "i'll supervise from here.",
    'that was a strong keystroke. felt it from here.',
    'important human business. do not interrupt. noted.',
    'they blinked. i blinked back. teamwork.',
  ],
  alone: [
    'counted my sprouts again. still three. consistency.',
    'do clouds get tired? note to self: ask a cloud.',
    "hm. that pixel wasn't there yesterday.",
    'quiet is nice. we like quiet.',
    "if i had knees, i'd stretch them.",
    "today's plan: sit. so far, flawless.",
    'i wonder what gravy dreams about.',
    'rearranged my card. big day.',
  ],
  lonely: [
    "they'll be back. they always come back.",
    'the cursor left. classic cursor.',
    'guarding the desk. nothing to report.',
    'i could learn to whistle. do i have lips? investigating.',
  ],
  sleepy: [
    'eyes are heavy… just resting them…',
    'not sleeping. thinking with my eyes closed…',
    'five more minutes…',
    'zz… mashed… no… whipped…',
    'the pixels are going soft…',
    'gonna rest my eyes. just the eyes.',
  ],
  ignored: [
    'noted. important human business.',
    "ok. filing this under 'later'.",
    "cool cool cool. i'll be right here.",
    'the knock economy is rough right now.',
  ],
  wake: [
    "i wasn't sleeping. i was thinking with my eyes closed.",
    'awake! was awake the whole time. mostly.',
    'mm. what year is it. ok good.',
    'dreamt i was a croissant. troubling.',
  ],
};

const SPEAK: Record<'greet' | 'knock' | 'delight', string[]> = {
  greet: [
    "oh! you're back. the desk is safe. i was very brave.",
    "you're back! nothing happened. except one dust bunny. it was huge.",
    'there you are. the chair missed you. i can tell.',
    'welcome back. i kept your pixels warm.',
  ],
  knock: [
    "knock knock. it's me. reason: none. just checking on you.",
    "hey. tiny check-in — water break? i'll wait.",
    "psst. shoulders down. they're not earrings.",
    "you've been at it a while. blink with me? one… two.",
    "quick survey: how's the human doing? one word is fine.",
  ],
  delight: [
    "you're here! hi. hello. ok. that's all i needed.",
    'worth it. carry on.',
    'ah, there you are. as you were.',
    "that's the stuff. ok. back to business.",
  ],
};

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
   mutter/speak take a string or an array of variants (picked at random) */
export interface RoutineStep {
  clip?: string;
  mode?: AnimMode;
  mutter?: string | string[];
  speak?: string | string[];
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
      { mutter: [
        'is that… my tail? hold on.',
        'something moved back there. suspicious.',
        'do i even have a tail? one way to find out.',
        'the tail. today is the day.',
      ], wait: 1500 },
      { clip: 'chase', sfx: 'whoosh', wait: 2350 },
      { clip: 'wobble', wait: 2400 },
      { mutter: [
        'conclusion: the tail remains theoretical.',
        'the tail wins again. respect.',
        'update: round on all sides. investigation ongoing.',
        "i'll catch it tomorrow. it knows i will.",
      ] },
    ],
  },
  juggle: {
    label: 'card-juggle', cost: 10, w: (P) => 0.4 + P.drama * 0.8,
    steps: [
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'hop', sfx: 'boing', wait: 900 },
      { mutter: [
        'nailed it. nobody saw. still counts.',
        'gravity tried. i tried harder.',
        'flawless routine. the stapler seemed impressed.',
        'and the crowd goes… quiet. impressed quiet.',
      ] },
    ],
  },
  study: {
    label: 'card-study', cost: 5, w: (P) => 0.4 + P.curious * 0.9,
    steps: [
      { mutter: [
        'card inspection time.',
        'daily card audit. very official.',
        'quality control. someone has to do it.',
      ], wait: 1300 },
      { clip: 'cardStudy', wait: 3450 },
      { mutter: [
        'checked twice. still true.',
        'all words present and accounted for.',
        'inspection complete. no notes.',
        'hm. reads even better upside down.',
      ] },
    ],
  },
  practice: {
    label: 'wave practice', cost: 8, w: (P) => 0.35 + P.drama * 0.6,
    steps: [
      { mutter: [
        'rehearsal. gotta keep the wave sharp.',
        'wave drills. form is everything.',
        'practicing my wave. for waving emergencies.',
      ], wait: 1400 },
      { clip: 'wave', wait: 1800 },
      { clip: 'wave', wait: 1900 },
      { mutter: [
        'wave form: excellent. audience: none.',
        'that one had real wrist in it. if i had wrists.',
        'the follow-through needs work. the enthusiasm does not.',
      ] },
    ],
  },
  hum: {
    label: 'humming', cost: 6, w: (P) => 0.55 - P.drama * 0.2,
    steps: [
      { mode: 'hum', emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1300 },
      { emote: '♪', wait: 1300 },
      { mode: 'idle', mutter: [
        'that song has no words. perfect song.',
        "i made that one up. it's about soup.",
        'same three notes as yesterday. a classic now.',
      ] },
    ],
  },
  stretch: {
    label: 'stretch', cost: -4, w: () => 0.45,
    steps: [
      { clip: 'stretch', wait: 2450 },
      { mutter: [
        'ooh. heard a click. good click, i think.',
        'taller now. probably. by a little.',
        'stretching complete. i am basically elastic.',
      ] },
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
      { mutter: [
        '…dusty in here. excuse me.',
        '…startled myself. again.',
        'that one came from deep in the starch.',
      ] },
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
const line = (v: string | string[]): string => (Array.isArray(v) ? pick(v) : v);

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
  // optional (mood) => string[] source of fresh, pre-generated daily mutters
  serverMutters?: ((mood: MutterMood) => string[] | null) | null;
  mutterFreshChance?: number;
}

export class SpudBrain {
  A: Animator;
  on: BrainCallbacks;
  P: Personality;
  timeScale: number;
  canAct: () => boolean;
  serverMutters: ((mood: MutterMood) => string[] | null) | null;
  mutterFreshChance: number;
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
  lastPool: Record<string, string>;
  lastTick: number;
  disposed: boolean;
  timer: number;
  lastRoutine?: RoutineKey;

  constructor({ animator, on = {}, personality, timeScale = 1, canAct, serverMutters = null, mutterFreshChance = 0.5 }: BrainOptions) {
    this.A = animator;
    this.on = on;                       // callbacks: mutter/speak/emote/state/log/needs/sfx
    this.P = { curious: 0.65, clingy: 0.6, drama: 0.55, sleepy: 0.35, ...(personality || {}) };
    this.timeScale = timeScale;
    this.canAct = canAct || (() => true);
    // optional (mood) => string[] source of fresh, pre-generated daily mutters;
    // ~mutterFreshChance of idle mutters come from it, the rest stay built-in
    this.serverMutters = serverMutters;
    this.mutterFreshChance = mutterFreshChance;
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
    this.lastZz = 0; this.lastPool = {};
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
    if ((wasAway && wasAwayFor > 30000) || force) this.greetBack();
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
  randMutterGap(): number { return (9 + Math.random() * 8) / (0.55 + this.P.curious * 0.75); }
  fresh(poolKey: MutterPool): string {
    // sometimes pull today's fresh server-generated line for this mood (only
    // watch/alone/lonely have server pools; other moods fall through to built-in)
    if (
      this.serverMutters && Math.random() < this.mutterFreshChance &&
      (poolKey === 'watch' || poolKey === 'alone' || poolKey === 'lonely')
    ) {
      const sp = this.serverMutters(poolKey);
      if (sp && sp.length) {
        const k = 'srv:' + poolKey;
        let m = pick(sp);
        if (sp.length > 2 && m === this.lastPool[k]) m = pick(sp);
        this.lastPool[k] = m;
        return m;
      }
    }
    const pool = MUTTER[poolKey];
    let m = pick(pool);
    if (pool.length > 2 && m === this.lastPool[poolKey]) m = pick(pool);
    this.lastPool[poolKey] = m;
    return m;
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
      if (!dozing) N.social = Math.max(0, Math.min(100, N.social + dt * (present ? 0.5 * (0.55 + P.clingy * 0.9) : 0.28)));
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
        // deviation from the prototype (always stretch): user wants it rare
        if (!blocked && Math.random() < 0.35) this.runRoutine('stretch', ROUTINES.stretch, true);
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
    if (N.social > 84 - P.clingy * 28 && this.nearBy() && (this.clock - this.lastKnockClock) > 38 * this.knockBackoff) {
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
    // deviation from the prototype (dt*0.02): user finds the stretch tiresome — keep it rare
    if (Math.random() < dt * 0.005) { this.runRoutine('stretch', ROUTINES.stretch, true); return; }

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
    if (s.mutter) this.mutter(line(s.mutter));
    if (s.speak) this.speak(line(s.speak));
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
      { speak: pick(SPEAK.knock), wait: 1300 },
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
      { speak: pick(SPEAK.delight), wait: 1400 },
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
      { speak: pick(SPEAK.greet), wait: 1500 },
    ], () => { this.busy = false; this.setState('watch'); });
  }
}
