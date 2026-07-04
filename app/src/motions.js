// Eight core motions from the Turn 3 motion spec. The timings, easings and
// amplitudes below are the source of truth from the design:
//   origin is always the contact point · squash preserves volume (sx·sy ≈ 1)
//   spring = cubic-bezier(.34,1.56,.64,1)
// Applied as root transforms on the (unrigged) Rodin model.

const D2R = Math.PI / 180;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// piecewise-linear sample over keyframes [{t, ...values}]
function sample(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const k = (t - a.t) / (b.t - a.t);
      const out = {};
      for (const prop of Object.keys(b)) {
        if (prop === 't') continue;
        out[prop] = lerp(a[prop] ?? defaults[prop], b[prop] ?? defaults[prop], k);
      }
      return out;
    }
  }
  return keys[keys.length - 1];
}

const defaults = { sx: 1, sy: 1, y: 0, x: 0, rotZ: 0, rotX: 0 };

// spring-ish overshoot for tuck/pop (approximates cubic-bezier(.34,1.56,.64,1))
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// One-shot clips. y in fractions of model height, rot in degrees.
const CLIPS = {
  // 02 · Tap Squish — 540ms ease-out · (1.22,.78)→(.92,1.10)→1
  squish: {
    dur: 540,
    keys: [
      { t: 0, sx: 1, sy: 1 },
      { t: 0.3, sx: 1.22, sy: 0.78 },
      { t: 0.55, sx: 0.92, sy: 1.1 },
      { t: 0.78, sx: 1.06, sy: 0.96 },
      { t: 1, sx: 1, sy: 1 },
    ],
  },
  bigSquish: {
    dur: 540,
    keys: [
      { t: 0, sx: 1, sy: 1 },
      { t: 0.3, sx: 1.28, sy: 0.72 },
      { t: 0.55, sx: 0.92, sy: 1.1 },
      { t: 0.78, sx: 1.06, sy: 0.96 },
      { t: 1, sx: 1, sy: 1 },
    ],
  },
  // 03 · Hop — 500ms arc · +28px apex · antic (.94,1.08) → land (1.14,.86)
  hop: {
    dur: 500,
    keys: [
      { t: 0, sx: 1, sy: 1, y: 0 },
      { t: 0.14, sx: 0.94, sy: 1.08, y: 0 },
      { t: 0.5, sx: 1, sy: 1, y: 0.16 },
      { t: 0.72, sx: 1.14, sy: 0.86, y: 0 },
      { t: 0.88, sx: 1, sy: 1.02, y: 0 },
      { t: 1, sx: 1, sy: 1, y: 0 },
    ],
  },
  // 07 · Cheer — 2 hops · 700ms ×2 · rotZ ±6° (played twice by caller)
  cheer: {
    dur: 700,
    keys: [
      { t: 0, y: 0, rotZ: 0, sx: 1, sy: 1 },
      { t: 0.3, y: 0.18, rotZ: -6, sx: 0.94, sy: 1.08 },
      { t: 0.55, y: 0, rotZ: 0, sx: 1.14, sy: 0.84 },
      { t: 0.75, y: 0.09, rotZ: 6, sx: 0.98, sy: 1.04 },
      { t: 1, y: 0, rotZ: 0, sx: 1, sy: 1 },
    ],
  },
  // comfort — slow lean-in, 2.2s (trigger map: reply tagged [comfort])
  comfort: {
    dur: 2200,
    keys: [
      { t: 0, rotZ: 0, x: 0 },
      { t: 0.25, rotZ: -4, x: -0.03 },
      { t: 0.75, rotZ: -4, x: -0.03 },
      { t: 1, rotZ: 0, x: 0 },
    ],
  },
  // 05 · Card Raise — 600ms spring · rotX 8° to camera
  raise: {
    dur: 600,
    keys: [
      { t: 0, rotX: 0, sy: 1 },
      { t: 0.5, rotX: 8, sy: 1.03 },
      { t: 1, rotX: 0, sy: 1 },
    ],
  },
};

export class Animator {
  constructor(root, modelHeight) {
    this.root = root;
    this.h = modelHeight;
    this.baseY = root.position.y;
    this.actives = []; // running one-shot clips
    this.mode = 'idle'; // idle | lean | rock
    this.tucked = false;
    this.tuckT = 1; // 0..1 progress of tuck slide (1 = fully in current state)
    this.tuckFrom = 0;
    this.tuckTo = 0;
    this.tuckOffset = 0;
    this.t0 = performance.now();
  }

  play(name) {
    const clip = CLIPS[name];
    if (!clip) return;
    this.actives.push({ clip, start: performance.now() });
  }

  playCheer() {
    this.play('cheer');
    setTimeout(() => this.play('cheer'), 700);
  }

  setMode(mode) {
    this.mode = mode;
  }

  setTucked(v) {
    if (this.tucked === v) return;
    this.tucked = v;
    this.tuckFrom = this.tuckOffset;
    this.tuckTo = v ? -0.76 * this.h : 0; // 06 · Tuck Away — translateY 76%
    this.tuckT = 0;
  }

  update() {
    const now = performance.now();
    const t = (now - this.t0) / 1000;

    // 01 · Idle Breathe — always on · 3.6s · scaleY 1→.975 · scaleX 1→1.02
    const br = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 3.6);
    let sx = 1 + 0.02 * br;
    let sy = 1 - 0.025 * br;
    let y = 0.002 * this.h * br;
    let x = 0;
    let rotZ = 0;
    let rotX = 0;

    // persistent modes
    if (this.mode === 'lean') {
      // 04 · Listen Lean — rotZ −4° · 1.2s ease (approximated with a soft sine settle)
      const k = Math.min(1, this.leanT === undefined ? 1 : 1);
      rotZ += -4 * Math.sin(Math.min((Math.PI / 2), t * 2)) * k;
      x += -0.02 * this.h;
    } else if (this.mode === 'rock') {
      // 08 · Golden Weave — rock rotZ ±3° · 2.4s loop
      rotZ += 3 * Math.sin((2 * Math.PI * t) / 2.4);
    }

    // one-shot clips (interrupt & return — additive on top of base)
    this.actives = this.actives.filter((a) => now - a.start < a.clip.dur);
    for (const a of this.actives) {
      const p = (now - a.start) / a.clip.dur;
      const v = sample(a.clip.keys, p);
      sx *= v.sx ?? 1;
      sy *= v.sy ?? 1;
      y += (v.y ?? 0) * this.h;
      x += (v.x ?? 0) * this.h;
      rotZ += v.rotZ ?? 0;
      rotX += v.rotX ?? 0;
    }

    // tuck slide — 700ms spring, then micro-bob ±2px · 3s loop
    if (this.tuckT < 1) this.tuckT = Math.min(1, this.tuckT + 16 / 700);
    this.tuckOffset = lerp(this.tuckFrom, this.tuckTo, easeOutBack(this.tuckT));
    if (this.tucked && this.tuckT >= 1) {
      this.tuckOffset = this.tuckTo + 0.006 * this.h * Math.sin((2 * Math.PI * t) / 3);
    }

    // squash from the contact point: scale about y=0 (model sits on origin)
    this.root.scale.set(sx, sy, sx);
    this.root.position.y = this.baseY + y + this.tuckOffset;
    this.root.position.x = x;
    this.root.rotation.z = rotZ * D2R;
    this.root.rotation.x = rotX * D2R;
  }
}
