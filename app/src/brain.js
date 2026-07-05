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
export const STATE_ZH = {
  watch: '看你干活', alone: '自己呆着', play: '自娱自乐', doze: '打瞌睡',
  knock: '搭讪中', wait: '等你回应', sulk: '被无视了', greet: '欢迎回来',
};

const MUTTER = {
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
  ],
  ignored: [
    'noted. important human business.',
    "ok. filing this under 'later'.",
    "cool cool cool. i'll be right here.",
  ],
  wake: [
    "i wasn't sleeping. i was thinking with my eyes closed.",
    'awake! was awake the whole time. mostly.',
  ],
};

const SPEAK = {
  greet: [
    "oh! you're back. the desk is safe. i was very brave.",
    "you're back! nothing happened. except one dust bunny. it was huge.",
  ],
  knock: [
    "knock knock. it's me. reason: none. just checking on you.",
    "hey. tiny check-in — water break? i'll wait.",
    "psst. shoulders down. they're not earrings.",
    "you've been at it a while. blink with me? one… two.",
  ],
  delight: [
    "you're here! hi. hello. ok. that's all i needed.",
    'worth it. carry on, friend.',
  ],
};

/* self-play routines: weight fn of personality, energy cost, step script.
   step: { clip | mode | mutter | speak | sfx | emote | wait(ms real) } */
const ROUTINES = {
  chase: {
    zh: '追尾巴', cost: 14, w: (P) => 0.5 + P.drama * 0.9,
    steps: [
      { mutter: 'is that… my tail? hold on.', wait: 1500 },
      { clip: 'chase', sfx: 'whoosh', wait: 2350 },
      { clip: 'wobble', wait: 2400 },
      { mutter: 'conclusion: the tail remains theoretical.' },
    ],
  },
  juggle: {
    zh: '颠卡片', cost: 10, w: (P) => 0.4 + P.drama * 0.8,
    steps: [
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'bounceCard', wait: 1950 },
      { clip: 'hop', sfx: 'boing', wait: 900 },
      { mutter: 'nailed it. nobody saw. still counts.' },
    ],
  },
  study: {
    zh: '读卡片', cost: 5, w: (P) => 0.4 + P.curious * 0.9,
    steps: [
      { mutter: 'card inspection time.', wait: 1300 },
      { clip: 'cardStudy', wait: 3450 },
      { mutter: 'checked twice. still true.' },
    ],
  },
  practice: {
    zh: '练习挥手', cost: 8, w: (P) => 0.35 + P.drama * 0.6,
    steps: [
      { mutter: 'rehearsal. gotta keep the wave sharp.', wait: 1400 },
      { clip: 'wave', wait: 1800 },
      { clip: 'wave', wait: 1900 },
      { mutter: 'wave form: excellent. audience: none.' },
    ],
  },
  hum: {
    zh: '哼小曲', cost: 6, w: (P) => 0.55 - P.drama * 0.2,
    steps: [
      { mode: 'hum', emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1400 },
      { emote: '♪', wait: 1300 },
      { emote: '♪', wait: 1300 },
      { mode: 'idle', mutter: 'that song has no words. perfect song.' },
    ],
  },
  stretch: {
    zh: '伸懒腰', cost: -4, w: () => 0.45,
    steps: [
      { clip: 'stretch', wait: 2450 },
      { mutter: 'ooh. heard a click. good click, i think.' },
    ],
  },
  peek: {
    zh: '张望', cost: 2, w: (P) => 0.3 + P.curious * 0.5,
    steps: [{ clip: 'peek', wait: 1650 }],
  },
  sneeze: {
    zh: '打喷嚏', cost: 3, w: () => 0,
    steps: [
      { clip: 'sneeze', sfx: 'sneeze', wait: 1450 },
      { mutter: '…dusty in here. excuse me.' },
    ],
  },
};
export const ROUTINE_KEYS = ['chase', 'juggle', 'study', 'practice', 'hum', 'stretch', 'peek', 'sneeze'];

/* total playtime of a routine's step script (ms) — the app debounces taps
   against this so a click-launched show can't be piled onto */
export function routineMs(key) {
  const r = ROUTINES[key];
  return r ? r.steps.reduce((s, st) => s + (st.wait || 400), 0) : 0;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class SpudBrain {
  constructor({ animator, on = {}, personality, timeScale = 1, canAct }) {
    this.A = animator;
    this.on = on;                       // callbacks: mutter/speak/emote/state/log/needs/sfx
    this.P = { curious: 0.65, clingy: 0.6, drama: 0.55, sleepy: 0.35, ...(personality || {}) };
    this.timeScale = timeScale;
    this.canAct = canAct || (() => true);
    this.needs = { energy: 74, boredom: 38, social: 30 };
    this.state = 'alone';
    this.clock = 0;                     // scaled seconds lived
    this.lastPointer = -1e9;            // real ms
    this.leftAt = 0; this.simAway = false;
    this.busy = false; this.seqT = 0;
    this.lastMutterClock = -1e9; this.mutterGap = this.randMutterGap();
    this.lastKnockClock = -30; this.knockBackoff = 1;
    this.waitDeadline = 0;              // scaled clock deadline for knock reply
    this.lastZz = 0; this.lastPool = {};
    this.lastTick = performance.now();
    this.disposed = false;
    this.timer = setInterval(() => this.tick(), 200);
  }

  /* ── public api ── */
  setPersonality(p) { Object.assign(this.P, p); }
  setTimeScale(x) { this.timeScale = x; }
  setAway(v) {
    this.simAway = v;
    if (v) { this.leftAt = performance.now(); this.log('sys', '（假装离开工位…）'); }
    else this.pointerMove(true);
  }
  pointerMove(force) {
    const now = performance.now();
    const wasAwayFor = now - Math.max(this.lastPointer, this.leftAt || 0);
    const wasAway = this.present() === false;
    this.lastPointer = now;
    if (this.simAway && !force) return;
    if ((wasAway && wasAwayFor > 30000) || force) this.greetBack();
  }
  pointerLeft() { this.leftAt = performance.now(); }
  /* returns true when the brain consumed the tap (wake / knock reply) */
  poke() {
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
      this.log('act', '被戳醒了');
      setTimeout(() => this.mutter(this.fresh('wake')), 650);
      return true;
    }
    if (this.state === 'wait' || this.state === 'knock') { this.replyArrived(); return true; }
    return false;
  }
  force(key) {
    if (key === 'doze') { this.startDoze(true); return; }
    if (key === 'knock') { this.startKnock(true); return; }
    const r = ROUTINES[key];
    if (r) this.runRoutine(key, r);
  }
  /* app hook: the human started doing something (chat, book, weave, tuck) —
     drop whatever we were up to and get out of the way */
  interrupt() {
    this.abortSeq();
    this.A.setMode('idle');
    this.setState(this.present() ? 'watch' : 'alone');
  }
  dispose() { this.disposed = true; clearInterval(this.timer); clearTimeout(this.seqT); }

  /* ── internals ── */
  present() { return !this.simAway && performance.now() - this.lastPointer < 25000; }
  nearBy() { return !this.simAway && performance.now() - this.lastPointer < 60000; }
  randMutterGap() { return (9 + Math.random() * 8) / (0.55 + this.P.curious * 0.75); }
  fresh(poolKey) {
    const pool = MUTTER[poolKey];
    let m = pick(pool);
    if (pool.length > 2 && m === this.lastPool[poolKey]) m = pick(pool);
    this.lastPool[poolKey] = m;
    return m;
  }
  emitSfx(n) { this.on.sfx && this.on.sfx(n); }
  log(kind, text) { this.on.log && this.on.log({ kind, text }); }
  mutter(text) { if (!text) return; this.on.mutter && this.on.mutter(text); this.log('mutter', text); this.lastMutterClock = this.clock; }
  speak(text, ms) { this.on.speak && this.on.speak(text, ms || 3400); this.emitSfx('pop'); this.log('speak', text); }
  emote(g) { this.on.emote && this.on.emote(g); }
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.on.state && this.on.state(s, STATE_ZH[s]);
  }

  tick() {
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
        this.log('act', '睡饱了，自然醒');
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
      const keys = ['chase', 'juggle', 'study', 'practice', 'hum', 'peek'];
      const weighted = keys.flatMap((k) => Array(Math.max(1, Math.round(ROUTINES[k].w(P) * 10))).fill(k));
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

  runRoutine(key, r, quiet) {
    if (this.busy) return;
    this.lastRoutine = key;
    this.busy = true;
    this.setState('play');
    if (!quiet) this.log('act', `自娱自乐 → ${r.zh}（无聊 ${Math.round(this.needs.boredom)}）`);
    else this.log('act', r.zh);
    this.needs.boredom = Math.max(0, this.needs.boredom - 30);
    this.needs.energy = Math.max(0, this.needs.energy - r.cost);
    this.runSteps([...r.steps], () => {
      this.busy = false;
      this.A.setMode('idle');
      this.setState(this.present() ? 'watch' : 'alone');
    });
  }

  runSteps(steps, done) {
    if (this.disposed) return;
    const s = steps.shift();
    if (!s) { done && done(); return; }
    if (s.clip) this.A.play(s.clip);
    if (s.mode) this.A.setMode(s.mode);
    if (s.sfx) this.emitSfx(s.sfx);
    if (s.mutter) this.mutter(s.mutter);
    if (s.speak) this.speak(s.speak);
    if (s.emote) this.emote(s.emote);
    this.seqT = setTimeout(() => this.runSteps(steps, done), s.wait || 400);
  }

  abortSeq() { clearTimeout(this.seqT); this.busy = false; }

  startDoze(forced) {
    this.abortSeq();
    this.setState('doze');
    this.A.setMode('doze');
    this.log('act', forced ? '被按头睡觉' : `困了（精力 ${Math.round(this.needs.energy)}）→ 打瞌睡`);
    setTimeout(() => { if (this.state === 'doze') this.mutter(this.fresh('sleepy')); }, 1200);
  }

  startKnock(forced) {
    this.abortSeq();
    this.busy = true;
    this.setState('knock');
    this.lastKnockClock = this.clock;
    this.log('act', forced ? '搭讪（手动触发）' : `想你值 ${Math.round(this.needs.social)} 爆表 → 主动搭讪`);
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

  replyArrived() {
    this.abortSeq();
    this.busy = true;
    this.setState('greet');
    this.knockBackoff = 1;
    this.needs.social = 10;
    this.log('act', '你回应了！开心值 +999');
    this.emote('♥'); this.emote('♥');
    this.runSteps([
      { clip: 'cheer', sfx: 'chime', wait: 1600 },
      { speak: pick(SPEAK.delight), wait: 1400 },
    ], () => { this.busy = false; this.setState('watch'); });
  }

  knockIgnored() {
    this.busy = true;
    this.setState('sulk');
    this.knockBackoff = Math.min(8, this.knockBackoff * 2);
    this.needs.social = 46;
    this.log('act', `没人理…退避 ×${this.knockBackoff}，自己玩去了`);
    this.runSteps([
      { clip: 'sulk', wait: 2500 },
      { mutter: this.fresh('ignored'), wait: 1500 },
    ], () => {
      this.busy = false;
      this.setState(this.present() ? 'watch' : 'alone');
      this.needs.boredom = Math.min(100, this.needs.boredom + 18);
    });
  }

  greetBack() {
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
    this.log('act', '检测到你回来了 → 迎接');
    this.runSteps([
      { clip: 'hop', sfx: 'boing', wait: 750 },
      { speak: pick(SPEAK.greet), wait: 1500 },
    ], () => { this.busy = false; this.setState('watch'); });
  }
}
