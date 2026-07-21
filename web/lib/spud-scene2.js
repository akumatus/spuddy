/* lib/spud-scene2.js — part-level 3D runtime v2 for the Spuddy desktop pet.
   Loads the part-separated glb (body / card / handL / handR / eyeL / eyeR from
   process_rodin_parts.mjs), wraps each part in a pivot group (hands hinge at the
   shoulder, eyes at their own center, card at its bottom edge), and drives
   everything through an eased keyframe sampler — no more uniform lerp:
   segments carry outBack / outElastic / ballistic-style curves, the drag-spin
   return is an underdamped spring, and idle gains blinks + saccades + paw sway. */

import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
import { DRACOLoader } from './DRACOLoader.js';
import { applyEnvironment } from './spud-pbr.js';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('lib/draco/');
loader.setDRACOLoader(draco);

const cache = new Map();

/* Characters with real PBR exports (Draco geometry + webp textures, compressed
   by the user). Others still use the baked-shaded glbs. spud-pbr.glb is the
   app pipeline's output (process_rodin_pbr.mjs): parts arrive already named
   body / card / handL / handR / eyeL / eyeR (+ decorative 'trim'), so rigParts()
   finds them directly. Legacy compress-only exports carry root.0…root.N names
   (GLTFLoader sanitizes the dots away → root0…rootN, order = the old six-part
   glb) — those still go through the rename map. */
const PBR_IDS = new Set(['spud', 'taco', 'donut', 'grad']);
const SPUD_RENAME = { root0: 'body', root1: 'card', root2: 'handR', root3: 'handL', root4: 'eyeR', root5: 'eyeL' };

function modelUrl(id) {
  return PBR_IDS.has(id) ? `assets/models/${id}-pbr.glb` : `assets/models/${id}.glb`;
}

async function loadModel(id) {
  if (!cache.has(id)) {
    cache.set(id, loader.loadAsync(modelUrl(id)).then((gltf) => {
      const named = !!gltf.scene.getObjectByName('body');
      gltf.scene.traverse((o) => {
        if (o.isMesh && o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
        if (id === 'spud' && !named) {
          const rn = SPUD_RENAME[(o.name || '').replace(/[^a-z0-9]/gi, '')];
          if (rn) o.name = rn;
        }
      });
      return gltf.scene;
    }));
  }
  const scene = await cache.get(id);
  return scene.clone(true);
}

/* ───────────────────────── easing library ───────────────────────── */
export const EASE = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBackSoft: (t) => { const c1 = 0.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
  },
};

function lerp(a, b, t) { return a + (b - a) * t; }

const ROOT_DEFS = { sx: 1, sy: 1, x: 0, y: 0, rotX: 0, rotY: 0, rotZ: 0 };

/* Normalize keys once per track: union of channels, forward-fill middles,
   first key ← defaults, last key ← defaults unless explicitly set (clips
   always end clean). Segment easing comes from the SEGMENT-END key's `e`. */
function normalizeKeys(keys, defs) {
  const chans = new Set();
  for (const k of keys) for (const p of Object.keys(k)) if (p !== 't' && p !== 'e') chans.add(p);
  const def = (p) => (defs && p in defs ? defs[p] : 0);
  const out = keys.map((k) => ({ ...k }));
  for (const p of chans) {
    if (!(p in out[0])) out[0][p] = def(p);
    for (let i = 1; i < out.length - 1; i++) if (!(p in out[i])) out[i][p] = out[i - 1][p];
    const last = out[out.length - 1];
    if (!(p in last)) last[p] = def(p);
  }
  return out;
}

function sampleKeys(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const k = (t - a.t) / (b.t - a.t);
      const e = EASE[b.e || 'inOutSine'] || EASE.inOutSine;
      const w = e(k);
      const v = {};
      for (const p of Object.keys(a)) {
        if (p === 't' || p === 'e') continue;
        v[p] = lerp(a[p], b[p] ?? a[p], w);
      }
      return v;
    }
  }
  return keys[keys.length - 1];
}

/* ─────────────────── clips: root + part tracks, all eased ───────────────────
   Channels — root: sx/sy (×), x/y (frac of model height), rotX/Y/Z (deg).
   hands (or handL/handR): raise (deg, + = paw tip up), out / lift (frac h),
   curl (deg, rotX), toEye (0..1 travel to same-side eye — for "shy").
   eyes: dx/dy (eye-widths), blink (0..1). card: lift/push (frac h),
   tilt (deg, + = top toward camera), wiggle (deg rotZ). */
export const CLIPS = {
  wave: {
    dur: 1700,
    root: [{ t: 0 }, { t: 0.18, rotZ: 3.5, rotY: -12, e: 'outCubic' }, { t: 0.8 }, { t: 1, e: 'inOutSine' }],
    handR: [
      { t: 0 }, { t: 0.2, raise: 74, out: 0.014, e: 'outBack' },
      { t: 0.33, raise: 54 }, { t: 0.46, raise: 86 }, { t: 0.59, raise: 54 }, { t: 0.72, raise: 84 },
      { t: 1, e: 'outBackSoft' },
    ],
    eyes: [{ t: 0 }, { t: 0.34, blink: 0 }, { t: 0.42, blink: 1, e: 'inQuad' }, { t: 0.52, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  blink: {
    dur: 320,
    eyes: [{ t: 0 }, { t: 0.32, blink: 1, e: 'inQuad' }, { t: 0.48, blink: 1 }, { t: 1, blink: 0, e: 'outQuad' }],
  },
  shy: {
    dur: 3000,
    root: [{ t: 0 }, { t: 0.18, rotX: 5, rotZ: -3, sy: 0.97, e: 'outCubic' }, { t: 0.82 }, { t: 1, e: 'inOutSine' }],
    hands: [
      { t: 0 }, { t: 0.16, toEye: 1, curl: 12, e: 'outBack' }, { t: 0.5 },
      { t: 0.6, toEye: 0.8, out: 0.018, e: 'inOutSine' }, { t: 0.74, toEye: 0.97, out: 0, e: 'inOutSine' },
      { t: 1, e: 'inOutCubic' },
    ],
    eyes: [
      { t: 0 }, { t: 0.15, blink: 1, e: 'inQuad' }, { t: 0.56 },
      { t: 0.64, blink: 0.2, e: 'outQuad' }, { t: 0.74, blink: 1, e: 'inQuad' },
      { t: 0.9, blink: 0, e: 'outQuad' }, { t: 1 },
    ],
  },
  eyeroll: {
    dur: 1500,
    fn(p) {
      const a = EASE.inOutCubic(Math.min(1, p * 1.12));
      const ang = a * TAU;
      const r = Math.sin(Math.PI * Math.min(1, p * 1.12));
      const blink = p > 0.86 ? Math.sin(Math.PI * (p - 0.86) / 0.14) : 0;
      return {
        eyes: { dx: 0.52 * r * Math.sin(ang), dy: 0.4 * r * Math.cos(ang), blink },
        root: { rotZ: 2.5 * r * Math.sin(ang), rotX: -2 * r },
      };
    },
  },
  present: {
    // Deviation from the Turn-6 spec (lift .11 · tilt 16°): Rodin generates
    // the body with a card-shaped pocket the bakes never saw into — lifting
    // the card uncovers it as a dark pit. Push+tilt keeps the pocket covered
    // by the card itself while still handing it to the camera.
    dur: 2400,
    root: [{ t: 0 }, { t: 0.28, rotX: -4, sy: 1.025, e: 'outCubic' }, { t: 0.74 }, { t: 1, e: 'inOutSine' }],
    card: [
      { t: 0 }, { t: 0.3, lift: 0.02, push: 0.09, tilt: 18, e: 'outBack' },
      { t: 0.5 }, { t: 0.58, wiggle: 2.5 }, { t: 0.66, wiggle: -2.5 }, { t: 0.74, wiggle: 0 },
      { t: 1, e: 'inOutCubic' },
    ],
    hands: [{ t: 0 }, { t: 0.3, raise: 10, out: 0.012, e: 'outBack' }, { t: 0.74 }, { t: 1, e: 'inOutCubic' }],
    eyes: [{ t: 0 }, { t: 0.3, dy: 0.2, e: 'outCubic' }, { t: 0.74 }, { t: 1 }],
  },
  squish: {
    dur: 650,
    root: [{ t: 0 }, { t: 0.2, sx: 1.25, sy: 0.75, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    hands: [{ t: 0 }, { t: 0.2, raise: 16, out: 0.022, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    eyes: [{ t: 0 }, { t: 0.16, blink: 1, e: 'inQuad' }, { t: 0.4, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  hop: {
    dur: 640,
    root: [
      { t: 0 }, { t: 0.18, sy: 0.86, sx: 1.12, e: 'outQuad' },
      { t: 0.3, sy: 1.13, sx: 0.92, y: 0.03, e: 'outQuad' },
      { t: 0.54, y: 0.17, sy: 1.02, sx: 0.99, e: 'outQuad' },
      { t: 0.72, y: 0, sy: 0.84, sx: 1.18, e: 'inQuad' },
      { t: 1, e: 'outElastic' },
    ],
    hands: [
      { t: 0 }, { t: 0.18, raise: -10, e: 'outQuad' }, { t: 0.5, raise: 36, e: 'outCubic' },
      { t: 0.72, raise: -5, e: 'inQuad' }, { t: 1, e: 'outElastic' },
    ],
    eyes: [{ t: 0 }, { t: 0.68, blink: 0 }, { t: 0.78, blink: 1, e: 'inQuad' }, { t: 0.92, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  cheer: {
    dur: 1500,
    root: [
      { t: 0 }, { t: 0.1, sy: 0.9, sx: 1.08, e: 'outQuad' },
      { t: 0.28, y: 0.19, rotZ: -6, sy: 1.06, e: 'outQuad' },
      { t: 0.42, y: 0, rotZ: -1, sx: 1.15, sy: 0.85, e: 'inQuad' },
      { t: 0.5, sy: 1.02, sx: 0.98, e: 'outQuad' },
      { t: 0.62, y: 0.12, rotZ: 6, sy: 1.05, e: 'outQuad' },
      { t: 0.76, y: 0, rotZ: 1, sx: 1.12, sy: 0.88, e: 'inQuad' },
      { t: 1, e: 'outElastic' },
    ],
    hands: [
      { t: 0 }, { t: 0.22, raise: 80, out: 0.02, e: 'outBack' },
      { t: 0.4, raise: 58 }, { t: 0.58, raise: 85 }, { t: 0.74, raise: 62 },
      { t: 1, e: 'outBackSoft' },
    ],
    card: [{ t: 0 }, { t: 0.22, lift: 0.045, e: 'outBack' }, { t: 0.76 }, { t: 1, e: 'inOutCubic' }],
    eyes: [{ t: 0 }, { t: 0.22, blink: 0.55, e: 'inOutSine' }, { t: 0.78 }, { t: 1, blink: 0, e: 'outQuad' }],
  },
  spin: {
    dur: 1150,
    root: [
      { t: 0 }, { t: 0.16, rotY: -30, sx: 1.06, sy: 0.94, e: 'outCubic' },
      { t: 0.8, rotY: 378, sy: 1.04, sx: 0.98, e: 'inOutQuart' },
      { t: 1, rotY: 360, e: 'outBackSoft' },
    ],
    hands: [
      { t: 0 }, { t: 0.18, raise: 5 }, { t: 0.52, raise: 30, out: 0.03, e: 'inOutQuad' },
      { t: 0.85, raise: 6, e: 'outQuad' }, { t: 1, e: 'outQuad' },
    ],
  },
  pirouette: {
    dur: 1000,
    root: [
      { t: 0 }, { t: 0.14, sy: 0.84, sx: 1.14, e: 'outQuad' },
      { t: 0.24, sy: 1.16, sx: 0.9, y: 0.05, rotY: 30, e: 'outQuad' },
      { t: 0.5, y: 0.26, rotY: 195, sy: 1.04, e: 'outQuad' },
      { t: 0.7, y: 0, rotY: 352, sx: 1.2, sy: 0.8, e: 'inQuad' },
      { t: 0.82, rotY: 360, sy: 1.04, sx: 0.97, e: 'outQuad' },
      { t: 1, rotY: 360, e: 'outElastic' },
    ],
    hands: [
      { t: 0 }, { t: 0.14, raise: -8, e: 'outQuad' }, { t: 0.32, raise: 52, out: 0.03, e: 'outCubic' },
      { t: 0.6 }, { t: 0.72, raise: -4, out: 0, e: 'inQuad' }, { t: 1, e: 'outElastic' },
    ],
    eyes: [{ t: 0 }, { t: 0.34, blink: 0 }, { t: 0.44, blink: 1, e: 'inQuad' }, { t: 0.66 }, { t: 0.8, blink: 0, e: 'outQuad' }, { t: 1 }],
  },

  /* ── turn 7 · soul-engine clips ── */
  stretch: {
    dur: 2400,
    root: [
      { t: 0 }, { t: 0.3, sy: 1.14, sx: 0.93, rotX: -7, e: 'outCubic' }, { t: 0.62 },
      { t: 0.78, sy: 0.975, sx: 1.035, rotX: 1, e: 'inOutSine' }, { t: 1, e: 'outBackSoft' },
    ],
    hands: [{ t: 0 }, { t: 0.3, raise: 96, out: 0.02, lift: 0.03, e: 'outBack' }, { t: 0.62 }, { t: 1, e: 'inOutCubic' }],
    card: [{ t: 0 }, { t: 0.3, lift: 0.03, e: 'outCubic' }, { t: 0.62 }, { t: 1, e: 'inOutCubic' }],
    eyes: [{ t: 0 }, { t: 0.26, blink: 0.85, e: 'inQuad' }, { t: 0.6, blink: 0.85 }, { t: 0.82, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  cardStudy: {
    // card track deviates from the prototype (lift .1 · push .045 · tilt −24):
    // that much back-tilt digs the card top into Rodin's chest pocket — read
    // with a shallower tilt, pushed further out and lifted clear of the belly
    dur: 3400,
    root: [{ t: 0 }, { t: 0.16, rotX: 8, e: 'outCubic' }, { t: 0.4, rotZ: -4 }, { t: 0.62, rotZ: 4 }, { t: 0.84, rotZ: 0, rotX: 8 }, { t: 1, e: 'inOutSine' }],
    card: [
      { t: 0 }, { t: 0.16, lift: 0.06, push: 0.085, tilt: -16, e: 'outBack' },
      { t: 0.38, wiggle: 3 }, { t: 0.5, wiggle: -3 }, { t: 0.62, wiggle: 2 }, { t: 0.8, wiggle: 0, tilt: -16 },
      { t: 1, e: 'inOutCubic' },
    ],
    hands: [{ t: 0 }, { t: 0.16, raise: 26, lift: 0.05, e: 'outBack' }, { t: 0.8 }, { t: 1, e: 'inOutCubic' }],
    eyes: [{ t: 0 }, { t: 0.16, dy: -0.55, e: 'outCubic' }, { t: 0.4, dx: -0.2 }, { t: 0.55, dx: 0.25 }, { t: 0.7, dx: -0.15 }, { t: 0.84, dx: 0, dy: -0.55 }, { t: 1 }],
  },
  chase: {
    dur: 2300,
    root: [
      { t: 0 }, { t: 0.14, rotY: -38, rotZ: -3, e: 'outCubic' }, { t: 0.3, rotY: 30, rotZ: 3, e: 'inOutQuad' },
      { t: 0.46, rotY: -46, rotZ: -4, e: 'inOutQuad' }, { t: 0.62, rotY: 24, rotZ: 2, e: 'inOutQuad' },
      { t: 0.88, rotY: 384, sx: 0.97, sy: 1.03, e: 'inOutQuart' }, { t: 1, rotY: 360, e: 'outBackSoft' },
    ],
    eyes: [{ t: 0 }, { t: 0.14, dx: -0.55, e: 'outCubic' }, { t: 0.3, dx: 0.5 }, { t: 0.46, dx: -0.55 }, { t: 0.62, dx: 0.45 }, { t: 0.88, dx: 0 }, { t: 1 }],
    hands: [{ t: 0 }, { t: 0.5, raise: 10 }, { t: 0.78, raise: 34, out: 0.026, e: 'inOutQuad' }, { t: 1, e: 'outQuad' }],
  },
  bounceCard: {
    dur: 1900,
    card: [
      { t: 0 }, { t: 0.14, lift: 0.02, e: 'inQuad' }, { t: 0.3, lift: 0.16, wiggle: 6, e: 'outQuad' },
      { t: 0.46, lift: 0.02, wiggle: 0, e: 'inQuad' }, { t: 0.6, lift: 0.13, wiggle: -6, e: 'outQuad' },
      { t: 0.76, lift: 0.02, wiggle: 0, e: 'inQuad' }, { t: 1, e: 'outBackSoft' },
    ],
    eyes: [{ t: 0 }, { t: 0.3, dy: 0.5, e: 'outQuad' }, { t: 0.46, dy: -0.1, e: 'inQuad' }, { t: 0.6, dy: 0.45, e: 'outQuad' }, { t: 0.76, dy: -0.1 }, { t: 1 }],
    root: [{ t: 0 }, { t: 0.3, sy: 1.03, e: 'outQuad' }, { t: 0.46, sy: 0.97, e: 'inQuad' }, { t: 0.6, sy: 1.025, e: 'outQuad' }, { t: 0.76, sy: 0.98 }, { t: 1, e: 'outElastic' }],
    hands: [{ t: 0 }, { t: 0.14, raise: 20, e: 'outQuad' }, { t: 0.76, raise: 16 }, { t: 1, e: 'outQuad' }],
  },
  knock: {
    dur: 1900,
    root: [{ t: 0 }, { t: 0.22, rotX: -11, sy: 1.045, y: 0.012, e: 'outBack' }, { t: 0.78, rotX: -11, sy: 1.045, y: 0.012 }, { t: 1, e: 'inOutSine' }],
    handR: [
      { t: 0 }, { t: 0.2, raise: 62, out: 0.03, e: 'outBack' },
      { t: 0.3, curl: 26, e: 'inQuad' }, { t: 0.38, curl: 4, e: 'outQuad' },
      { t: 0.46, curl: 26, e: 'inQuad' }, { t: 0.54, curl: 4, e: 'outQuad' },
      { t: 0.78, raise: 58 }, { t: 1, e: 'inOutCubic' },
    ],
    eyes: [{ t: 0 }, { t: 0.2, dy: 0.4, e: 'outCubic' }, { t: 0.82, dy: 0.35 }, { t: 1 }],
  },
  sulk: {
    // card track deviates from the prototype (tilt −8 only): the backward
    // droop digs into Rodin's card pocket — push forward while tilted
    dur: 2800,
    root: [{ t: 0 }, { t: 0.3, rotX: 9, sy: 0.955, rotZ: -2, e: 'inOutSine' }, { t: 0.85, rotX: 9, sy: 0.955, rotZ: -2 }, { t: 1, e: 'inOutSine' }],
    hands: [{ t: 0 }, { t: 0.3, raise: -13, e: 'inOutSine' }, { t: 0.85, raise: -13 }, { t: 1 }],
    eyes: [{ t: 0 }, { t: 0.3, dy: -0.5, blink: 0.4, e: 'inOutSine' }, { t: 0.85, dy: -0.5, blink: 0.4 }, { t: 1, blink: 0, e: 'outQuad' }],
    card: [{ t: 0 }, { t: 0.3, tilt: -8, push: 0.026, e: 'inOutSine' }, { t: 0.85, tilt: -8, push: 0.026 }, { t: 1 }],
  },
  sneeze: {
    dur: 1350,
    root: [
      { t: 0 }, { t: 0.3, rotX: -13, sy: 1.09, sx: 0.95, e: 'outCubic' }, { t: 0.42, rotX: -15, sy: 1.1 },
      { t: 0.5, rotX: 16, sy: 0.82, sx: 1.2, y: 0.012, e: 'inQuad' }, { t: 1, e: 'outElastic' },
    ],
    eyes: [{ t: 0 }, { t: 0.3, blink: 0.5, e: 'inQuad' }, { t: 0.46, blink: 1 }, { t: 0.62, blink: 1 }, { t: 0.8, blink: 0, e: 'outQuad' }, { t: 1 }],
    hands: [{ t: 0 }, { t: 0.42, raise: 30, e: 'outCubic' }, { t: 0.52, raise: -6, out: 0.02, e: 'inQuad' }, { t: 1, e: 'outElastic' }],
    card: [{ t: 0 }, { t: 0.5, wiggle: 9, lift: 0.01, e: 'inQuad' }, { t: 0.7, wiggle: -4 }, { t: 1, e: 'outElastic' }],
  },
  startle: {
    dur: 900,
    root: [{ t: 0 }, { t: 0.18, y: 0.05, sy: 1.1, sx: 0.94, rotX: -6, e: 'outBack' }, { t: 0.34, y: 0, sy: 0.93, sx: 1.09, e: 'inQuad' }, { t: 1, e: 'outElastic' }],
    eyes: [{ t: 0, blink: 0.8 }, { t: 0.16, blink: 0, dy: 0.5, e: 'outQuad' }, { t: 0.6, dy: 0.4 }, { t: 1 }],
    hands: [{ t: 0 }, { t: 0.18, raise: 40, out: 0.024, e: 'outBack' }, { t: 1, e: 'outElastic' }],
  },
  peek: {
    dur: 1600,
    root: [{ t: 0 }, { t: 0.2, rotY: -24, rotZ: -2, e: 'outCubic' }, { t: 0.5, rotY: 22, rotZ: 2, e: 'inOutSine' }, { t: 0.75, rotY: 0, rotZ: 0, e: 'inOutSine' }, { t: 1 }],
    eyes: [{ t: 0 }, { t: 0.16, dx: -0.55, e: 'outCubic' }, { t: 0.46, dx: 0.5, e: 'inOutSine' }, { t: 0.72, dx: 0 }, { t: 1 }],
  },
};

/* roly-poly — decaying precession; eyes counter-sway to stay "level" */
export const WOBBLE = {
  dur: 2600,
  fn(p) {
    const t = p * 2.6;
    const decay = Math.exp(-1.5 * t);
    const w = TAU / 0.85;
    const rotZ = 13 * Math.sin(w * t) * decay;
    return {
      root: { rotZ, rotX: 8 * Math.sin(w * t + Math.PI / 2) * decay, y: Math.abs(0.012 * Math.sin(w * t)) * decay },
      eyes: { dx: -rotZ * 0.028 },
    };
  },
};

function getClip(name) { return name === 'wobble' ? WOBBLE : CLIPS[name]; }

/* pre-normalize keyframe tracks */
for (const clip of [...Object.values(CLIPS), WOBBLE]) {
  if (clip.fn) continue;
  for (const tr of Object.keys(clip)) {
    if (['zh', 'spec', 'dur', 'pt', 'fn'].includes(tr)) continue;
    clip[tr] = normalizeKeys(clip[tr], tr === 'root' ? ROOT_DEFS : null);
  }
}

const PART_DEFS = {
  hand: () => ({ raise: 0, out: 0, lift: 0, curl: 0, toEye: 0 }),
  eyes: () => ({ dx: 0, dy: 0, blink: 0 }),
  card: () => ({ lift: 0, push: 0, tilt: 0, wiggle: 0 }),
};

function addInto(acc, v) { for (const p of Object.keys(v)) if (p in acc) acc[p] += v[p]; }

/* ───────────────────────────── animator ───────────────────────────── */
export class Animator {
  constructor(root, modelHeight) {
    this.root = root;
    this.h = modelHeight;
    this.actives = [];
    this.mode = 'idle';
    this.tucked = false;
    this.tuckT = 1; this.tuckFrom = 0; this.tuckTo = 0; this.tuckOffset = 0;
    this.faceY = 0; this.faceX = 0;
    this.faceTargetY = 0; this.faceTargetX = 0;
    this.eyeX = 0; this.eyeY = 0; this.eyeTX = 0; this.eyeTY = 0;
    this.userRotY = 0; this.spinVel = 0; this.dragging = false;
    this.idleLife = true;
    this.dozeStart = 0; this.nodAt = 0; this.nodStart = -1e9;
    this.lastCursorAt = -1e9;
    this.nextBlinkAt = performance.now() + 1800;
    this.blinkStart = -1e9; this.blinkDouble = false;
    this.nextSaccadeAt = 0;
    this.t0 = performance.now();
    this.lastNow = this.t0;
    this.rig = null;
    this.out = { y: 0, sx: 1, ground: 1 };
  }
  attachRig(rig) { this.rig = rig; }
  play(name) {
    const clip = getClip(name);
    if (!clip) return;
    this.actives.push({ clip, start: performance.now() });
  }
  playCheer() { this.play('cheer'); }
  setMode(m) { if (this.mode !== m) { this.mode = m; this.dozeStart = 0; } }
  setTucked(v) {
    if (this.tucked === v) return;
    this.tucked = v;
    this.tuckFrom = this.tuckOffset;
    this.tuckTo = v ? -0.76 * this.h : 0;
    this.tuckT = 0;
  }
  facePoint(nx, ny) {
    this.faceTargetY = Math.max(-1, Math.min(1, nx)) * 0.62;
    this.faceTargetX = Math.max(-1, Math.min(1, ny ?? 0)) * 4 * D2R;
    this.eyeTX = Math.max(-1, Math.min(1, nx)) * 0.5;
    this.eyeTY = -Math.max(-1, Math.min(1, ny ?? 0)) * 0.3;
    this.lastCursorAt = performance.now();
  }
  setDragging(v) { this.dragging = v; if (v) this.spinVel = 0; }
  dragBy(dxPx) { const d = dxPx * 0.011; this.userRotY += d; this.spinVel = d * 60; } // vel in rad/s

  update() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const t = (now - this.t0) / 1000;

    /* base: idle breathe (3.6s) */
    const br = 0.5 - 0.5 * Math.cos(TAU * t / 3.6);
    let sx = 1 + 0.02 * br, sy = 1 - 0.025 * br;
    let y = 0.002 * this.h * br, x = 0, rotZ = 0, rotX = 0, rotY = 0;
    if (this.mode === 'rock') rotZ += 3 * Math.sin(TAU * t / 2.4);

    const P = {
      handL: PART_DEFS.hand(), handR: PART_DEFS.hand(),
      eyes: PART_DEFS.eyes(), card: PART_DEFS.card(),
    };

    /* doze: deep slow breath, drift lean, nod-and-catch, lids at 82% */
    this.out.nodCatch = false;
    if (this.mode === 'doze') {
      if (!this.dozeStart) { this.dozeStart = now; this.nodAt = now + 1600; this.nodStart = -1e9; }
      const w = EASE.inOutSine(Math.min(1, (now - this.dozeStart) / 1400));
      const slow = 0.5 - 0.5 * Math.cos(TAU * t / 5.8);
      sy *= 1 - 0.022 * w * slow; sx *= 1 + 0.018 * w * slow;
      rotZ += 5.5 * w * Math.sin(TAU * t / 16);
      if (now >= this.nodAt) { this.nodStart = now; this.nodAt = now + 3000 + Math.random() * 2800; }
      const np = (now - this.nodStart) / 2300;
      if (np >= 0 && np <= 1) {
        const nod = np < 0.8 ? EASE.inQuad(np / 0.8) : 1 - EASE.outBack(Math.min(1, (np - 0.8) / 0.2));
        rotX += 10 * w * nod;
        if (np > 0.8 && np < 0.88) this.out.nodCatch = true;
      }
      P.eyes.blink += 0.82 * w;
      P.eyes.dy -= 0.2 * w;
      P.handL.raise -= 11 * w; P.handR.raise -= 11 * w;
      // deviation from the prototype (tilt −6 only): tilting back swings the
      // card top into Rodin's card pocket and the belly pokes through the
      // face — nudge it forward while it droops (same fix as 'present')
      P.card.tilt -= 6 * w; P.card.push += 0.024 * w;
    }

    /* hum: sway on a 1.32s beat, card as metronome, paws alternate */
    if (this.mode === 'hum') {
      const beat = TAU * t / 1.32;
      rotZ += 4.2 * Math.sin(beat);
      y += 0.006 * this.h * Math.max(0, Math.sin(beat * 2));
      P.card.wiggle += 6 * Math.sin(beat + 0.7);
      P.handL.raise += 7 * Math.sin(beat + 0.4);
      P.handR.raise += 7 * Math.sin(beat + Math.PI + 0.4);
      P.eyes.blink += 0.35; P.eyes.dy += 0.12;
    }

    /* idle life: paw sway lags breath, card drifts, blinks, saccades */
    if (this.idleLife) {
      const lag = 0.5 - 0.5 * Math.cos(TAU * t / 3.6 - 0.9);
      P.handL.raise += 2.2 * (lag - 0.5); P.handR.raise += 2.2 * (lag - 0.5);
      P.card.wiggle += 1.1 * Math.sin(TAU * t / 5.3);
      P.card.lift += 0.004 * (lag - 0.5);
      rotY += 1.6 * D2R * Math.sin(TAU * t / 9.7);

      if (now >= this.nextBlinkAt) {
        this.blinkStart = now;
        const dbl = Math.random() < 0.16;
        this.nextBlinkAt = now + (dbl ? 340 : 2600 + Math.random() * 3800);
      }
      const bp = (now - this.blinkStart) / 300;
      if (bp >= 0 && bp <= 1) {
        P.eyes.blink += bp < 0.35 ? EASE.inQuad(bp / 0.35) : 1 - EASE.outQuad((bp - 0.35) / 0.65);
      }
      if (now - this.lastCursorAt > 3500 && now >= this.nextSaccadeAt) {
        this.eyeTX = (Math.random() * 2 - 1) * 0.42;
        this.eyeTY = (Math.random() * 2 - 1) * 0.24;
        this.faceTargetY = this.eyeTX * 0.35;
        this.nextSaccadeAt = now + 1400 + Math.random() * 3200;
      }
    }

    /* one-shot clips, eased tracks */
    this.actives = this.actives.filter((a) => now - a.start < a.clip.dur);
    for (const a of this.actives) {
      const p = (now - a.start) / a.clip.dur;
      const c = a.clip;
      let rv = null;
      if (c.fn) {
        const o = c.fn(p);
        rv = o.root;
        if (o.eyes) addInto(P.eyes, o.eyes);
        if (o.card) addInto(P.card, o.card);
        if (o.hands) { addInto(P.handL, o.hands); addInto(P.handR, o.hands); }
      } else {
        if (c.root) rv = sampleKeys(c.root, p);
        if (c.hands) { const v = sampleKeys(c.hands, p); addInto(P.handL, v); addInto(P.handR, v); }
        if (c.handL) addInto(P.handL, sampleKeys(c.handL, p));
        if (c.handR) addInto(P.handR, sampleKeys(c.handR, p));
        if (c.eyes) addInto(P.eyes, sampleKeys(c.eyes, p));
        if (c.card) addInto(P.card, sampleKeys(c.card, p));
      }
      if (rv) {
        sx *= rv.sx ?? 1; sy *= rv.sy ?? 1;
        y += (rv.y ?? 0) * this.h; x += (rv.x ?? 0) * this.h;
        rotZ += rv.rotZ ?? 0; rotX += rv.rotX ?? 0; rotY += (rv.rotY ?? 0) * D2R;
      }
    }

    /* cursor: eyes lead (fast spring), head follows (slow spring) */
    const kHead = 1 - Math.exp(-dt * 6.5);
    const kEye = 1 - Math.exp(-dt * 16);
    this.faceY += (this.faceTargetY - this.faceY) * kHead;
    this.faceX += (this.faceTargetX - this.faceX) * kHead;
    this.eyeX += (this.eyeTX - this.eyeX) * kEye;
    this.eyeY += (this.eyeTY - this.eyeY) * kEye;
    P.eyes.dx += this.eyeX; P.eyes.dy += this.eyeY;

    /* drag spin: momentum while fast, underdamped spring-back once slow */
    if (!this.dragging) {
      this.userRotY = ((this.userRotY % TAU) + TAU + Math.PI) % TAU - Math.PI;
      if (Math.abs(this.spinVel) > 2.4) {
        this.spinVel *= Math.exp(-dt * 1.7);
        this.userRotY += this.spinVel * dt;
      } else {
        const kS = 30, cS = 6.5;
        this.spinVel += (-kS * this.userRotY - cS * this.spinVel) * dt;
        this.userRotY += this.spinVel * dt;
      }
    }

    /* tuck slide */
    if (this.tuckT < 1) this.tuckT = Math.min(1, this.tuckT + dt * 1000 / 700);
    this.tuckOffset = lerp(this.tuckFrom, this.tuckTo, EASE.outBack(this.tuckT));
    if (this.tucked && this.tuckT >= 1) this.tuckOffset = this.tuckTo + 0.006 * this.h * Math.sin(TAU * t / 3);

    /* apply root */
    this.root.scale.set(sx, sy, sx);
    this.root.position.set(x, y + this.tuckOffset, 0);
    this.root.rotation.set(rotX * D2R + this.faceX, this.faceY + this.userRotY + rotY, rotZ * D2R);

    /* apply parts */
    const R = this.rig;
    if (R) {
      for (const side of ['L', 'R']) {
        const h = R['hand' + side]; if (!h) continue;
        const v = P['hand' + side];
        // forward-pointing paws lift around X at the arm root (raise up = −X,
        // curl shares the axis: knocks/waves pitch from the same shoulder);
        // side paws swing around Z as in the design prototype
        if (h.liftAxis === 'x') h.g.rotation.set((v.curl - v.raise) * D2R, 0, 0);
        else h.g.rotation.set(v.curl * D2R, 0, h.sign * v.raise * D2R);
        h.g.position.set(
          h.home.x + (h.sign * v.out * this.h + h.shyVec.x * v.toEye) * h.unit,
          h.home.y + (v.lift * this.h + h.shyVec.y * v.toEye * (1 / this.h) * this.h) * h.unit,
          h.home.z + (h.shyVec.z * v.toEye) * h.unit
        );
      }
      for (const side of ['L', 'R']) {
        const ey = R['eye' + side]; if (!ey) continue;
        const blink = Math.max(0, Math.min(1, P.eyes.blink));
        ey.g.position.set(
          ey.home.x + P.eyes.dx * ey.w * ey.unit,
          ey.home.y + P.eyes.dy * ey.w * 0.9 * ey.unit,
          ey.home.z
        );
        ey.g.scale.set(1 + 0.18 * blink, 1 - 0.9 * blink, 1);
      }
      if (R.card) {
        const v = P.card;
        R.card.g.rotation.set(v.tilt * D2R, 0, v.wiggle * D2R);
        R.card.g.position.set(
          R.card.home.x,
          R.card.home.y + v.lift * this.h * R.card.unit,
          R.card.home.z + v.push * this.h * R.card.unit
        );
      }
    }

    this.out.y = y; this.out.sx = sx;
    this.out.ground = Math.max(0, 1 - (y / this.h) * 2.4);
  }
}

/* ──────────────── part rigging: pivot groups from named nodes ──────────────── */
function rigParts(model, sceneRoot) {
  sceneRoot.updateMatrixWorld(true);
  const names = ['body', 'card', 'handL', 'handR', 'eyeL', 'eyeR'];
  const nodes = {}, box = {}, ctr = {}, size = {};
  let found = 0;
  for (const n of names) {
    const node = model.getObjectByName(n);
    if (!node) continue;
    nodes[n] = node; found++;
    box[n] = new THREE.Box3().setFromObject(node);
    ctr[n] = box[n].getCenter(new THREE.Vector3());
    size[n] = box[n].getSize(new THREE.Vector3());
  }
  if (found < 4 || !nodes.card) return null;

  const wrap = (part, worldPivot) => {
    const parent = part.parent;
    const lp = parent.worldToLocal(worldPivot.clone());
    const g = new THREE.Group();
    g.position.copy(lp);
    const keep = part.position.clone();
    parent.add(g);
    g.add(part);
    part.position.copy(keep.sub(lp));
    const ps = new THREE.Vector3();
    parent.getWorldScale(ps);
    return { g, home: g.position.clone(), unit: 1 / ps.x };
  };

  const rig = {};
  for (const side of ['L', 'R']) {
    const hn = 'hand' + side, en = 'eye' + side;
    if (nodes[hn]) {
      const b = box[hn], c = ctr[hn];
      const sign = c.x >= 0 ? 1 : -1;
      // Rodin paws point FORWARD (z-extent ≈ 2× width) to hold the card, so a
      // 'raise' spin around Z is nearly parallel to the arm — it reads as the
      // palm twisting on the spot. Forward paws instead hinge around X at the
      // arm root (top-back edge, inside the body): the paw sweeps up and the
      // palm turns to face the camera. Side-mounted paws (wider than deep)
      // keep the original Z hinge at the top-inner corner.
      const forward = size[hn].z > size[hn].x;
      const pivot = forward
        ? new THREE.Vector3(c.x, b.max.y - size[hn].y * 0.12, b.min.z + size[hn].z * 0.06)
        : new THREE.Vector3(sign > 0 ? b.min.x : b.max.x, b.max.y - size[hn].y * 0.12, c.z);
      const r = wrap(nodes[hn], pivot);
      r.sign = sign;
      r.liftAxis = forward ? 'x' : 'z';
      r.shyVec = new THREE.Vector3(0, 0, 0);
      if (nodes[en]) {
        r.shyVec.set(
          ctr[en].x - c.x,
          ctr[en].y - c.y - size[en].y * 0.1,
          ctr[en].z - c.z + size[en].z / 2 + size[hn].z / 2 + 0.015
        );
      }
      rig[hn] = r;
    }
    if (nodes[en]) {
      const r = wrap(nodes[en], ctr[en].clone());
      r.w = size[en].x;
      rig[en] = r;
    }
  }
  if (nodes.card) {
    const b = box.card, c = ctr.card;
    rig.card = wrap(nodes.card, new THREE.Vector3(c.x, b.min.y, c.z));
  }
  return rig;
}

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  rg.addColorStop(0, 'rgba(70,48,22,0.42)');
  rg.addColorStop(0.55, 'rgba(70,48,22,0.20)');
  rg.addColorStop(1, 'rgba(70,48,22,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/* ─────────────────── card screen: text on the held card ───────────────────
   Ported from the desktop app (src/cardscreen.js). The encouragement line lives
   on a CanvasTexture: for part-separated models (a mesh named "card") we planar-
   project UVs onto that mesh and swap its material, so the text sits on the real
   yarn card the paws grip — exactly like the shipping product. Content changes
   cross-fade (out → swap → in); golden cards tint + pulse the emissive. Opt-in:
   PetScene only builds one when constructed with { card: true }, so the promo
   film / lighting stage that import this file keep their plain blank card. */
const CONTENT_ASPECT = 1.5;

function hasCJK(s) { return /[\u3040-\u30ff\u3400-\u9fff]/.test(s); }
function wrapText(ctx, text, maxW) {
  const cjk = hasCJK(text);
  const tokens = cjk ? Array.from(text) : text.split(' ');
  const glue = cjk ? '' : ' ';
  const lines = []; let line = '';
  for (const tk of tokens) {
    const probe = line ? line + glue + tk : tk;
    if (ctx.measureText(probe).width > maxW && line) { lines.push(line); line = tk; }
    else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

export class CardScreen {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = null;
    this.material = new THREE.MeshStandardMaterial({
      transparent: true, roughness: 0.85, metalness: 0,
      emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.35,
    });
    this._rebuildTexture();
    this.mesh = null; this.cardMesh = null; this.rigDriven = false;
    this.upLocal = new THREE.Vector3(0, 1, 0);
    this.baseQuat = new THREE.Quaternion(); this.basePos = new THREE.Vector3();
    this.height = 1; this.pulse = false;
    this.content = { top: '· ♥ ·', main: 'tap me :)' };
    this.textAlpha = 1; this._trans = null; this._next = null;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.redraw());
  }
  _rebuildTexture() {
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this.material.emissiveMap = this.texture;
    this.material.needsUpdate = true;
  }
  attach(model, data) {
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh = null; this.cardMesh = null; this.rigDriven = false;
    if (!data) return;
    const normal = new THREE.Vector3(...data.normal).normalize();
    const up = new THREE.Vector3(...data.up).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    let w = data.width, h = data.height;
    const cardMesh = model.getObjectByName('card');
    if (cardMesh) {
      this._projectUVs(cardMesh.geometry, data, right, up);
      cardMesh.material = this.material;
      this.cardMesh = cardMesh;
      this.basePos.copy(cardMesh.position);
    } else {
      const COVER = 1.05; w = data.width * COVER; h = data.height * COVER;
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.material);
      this.basePos.set(...data.center).addScaledVector(normal, data.offset ?? 0.015);
      this.baseQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
      this.mesh.position.copy(this.basePos);
      this.mesh.quaternion.copy(this.baseQuat);
      model.add(this.mesh);
    }
    this.upLocal = up; this.height = h;
    const newH = Math.round((512 * h) / w);
    if (this.canvas.width !== 512 || this.canvas.height !== newH) {
      this.canvas.width = 512; this.canvas.height = newH; this._rebuildTexture();
    }
    this.redraw();
  }
  _projectUVs(geometry, data, right, up) {
    if (geometry.userData.cardUV) return;
    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const c = data.center; const d = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.set(pos.getX(i) - c[0], pos.getY(i) - c[1], pos.getZ(i) - c[2]);
      uv.setXY(i, d.dot(right) / data.width + 0.5, d.dot(up) / data.height + 0.5);
    }
    uv.needsUpdate = true; geometry.userData.cardUV = true;
  }
  setContent(content) {
    this._next = content;
    this._trans = { start: performance.now(), dur: 520 };
    this.setPulse(!!content.gold);
  }
  redraw() {
    const { canvas, ctx } = this;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const c = this.content;
    ctx.clearRect(0, 0, W, H);
    if (this.cardMesh) {
      ctx.fillStyle = '#FFFDF6'; ctx.fillRect(0, 0, W, H);
    } else {
      const r = Math.min(W, H) * 0.09;
      ctx.beginPath(); ctx.roundRect(0.5, 0.5, W - 1, H - 1, r);
      ctx.fillStyle = '#FFFDF6'; ctx.fill();
      ctx.strokeStyle = 'rgba(90,73,52,0.14)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, this.textAlpha));
    let cw = W * (this.cardMesh ? 0.9 : 0.94);
    let ch = cw / CONTENT_ASPECT;
    if (ch > H * 0.92) { ch = H * 0.92; cw = ch * CONTENT_ASPECT; }
    const top = (H - ch) / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (c.top) {
      ctx.fillStyle = c.gold ? '#C9A227' : '#C9A96F';
      ctx.font = `800 ${Math.round(ch * 0.085)}px Nunito, sans-serif`;
      ctx.fillText(c.top, W / 2, top + ch * 0.12);
    }
    const maxW = cw * 0.98;
    const maxH = ch * (c.footR ? 0.7 : 0.76);
    let size = Math.round(ch * 0.34); let lines = [];
    while (size > 10) {
      ctx.font = `700 ${size}px Caveat, cursive`;
      lines = wrapText(ctx, c.main || '', maxW);
      if (lines.length * size * 1.08 <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
      size -= 2;
    }
    ctx.fillStyle = '#4A3B28';
    const lh = size * 1.08;
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
    if (c.footR) {
      ctx.fillStyle = '#8A7455';
      ctx.font = `600 ${Math.round(ch * 0.095)}px Caveat, cursive`;
      ctx.textAlign = 'right';
      ctx.fillText(c.footR, W / 2 + cw / 2 - cw * 0.04, top + ch * 0.9);
    }
    ctx.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }
  setPulse(v) { this.pulse = v; }
  update() {
    const now = performance.now();
    if (this.pulse) {
      this.material.emissive.set('#C9A227');
      this.material.emissiveIntensity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin((TAU * now) / 1600));
    } else if (this.material.emissiveIntensity !== 0.35) {
      this.material.emissive.set('#ffffff');
      this.material.emissiveIntensity = 0.35;
    }
    if (this._trans) {
      const t = Math.min(1, (now - this._trans.start) / this._trans.dur);
      if (t < 0.5) this.textAlpha = 1 - t * 2;
      else {
        if (this._next) { this.content = this._next; this._next = null; }
        this.textAlpha = (t - 0.5) * 2;
      }
      this.redraw();
      if (t >= 1) { this._trans = null; this.textAlpha = 1; this.redraw(); }
    }
  }
  dispose() {
    if (this.texture) this.texture.dispose();
    if (this.material) this.material.dispose();
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}

/* ───────────────────────────── scene ───────────────────────────── */
export class PetScene {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    // exposure matches the desktop client (LIGHT_BASE.exposure)
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 26, 1, 0.1, 50);
    this.camBase = new THREE.Vector3(...(opts.cam ?? [0, 1.62, 6.1]));
    this.lookAt = new THREE.Vector3(...(opts.lookAt ?? [0, 1.02, 0]));
    this.cameraSway = opts.cameraSway ?? true;

    // light rig copied from the desktop client's LIGHT_BASE
    // (app/src/scene/lighting.ts) so both potatoes read identically
    this.scene.add(new THREE.AmbientLight(0xffedd0, 0.16));
    this.key = new THREE.DirectionalLight(0xffeccf, 1.05);
    this.key.position.set(2, 3, 5.5);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xffe8c8, 0.45);
    this.rim.position.set(-3, 2, -2);
    this.scene.add(this.rim);
    applyEnvironment(this.renderer, this.scene);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.1, 2.1),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.005;
    this.scene.add(this.shadow);

    this.holder = new THREE.Group();
    this.rootGroup = new THREE.Group();
    this.rootGroup.add(this.holder);
    this.scene.add(this.rootGroup);

    this.animator = new Animator(this.rootGroup, 2);
    this.cardEnabled = !!opts.card;
    this.cardScreen = new CardScreen();
    this._cardsJson = this.cardEnabled ? fetch('assets/models/cards.json').then((r) => r.json()).catch(() => ({})) : null;
    this.disposed = false;
    this.t0 = performance.now();
    this._tick = this._tick.bind(this);
    this.resize();
    requestAnimationFrame(this._tick);
  }
  resize() {
    const w = this.canvas.clientWidth || 600, h = this.canvas.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  async setCharacter(id) {
    const model = await loadModel(id);
    if (this.disposed) return;
    this.holder.clear();
    const box = new THREE.Box3().setFromObject(model);
    const sizeV = box.getSize(new THREE.Vector3());
    const scale = 2 / sizeV.y;
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box2.min.y;
    this.holder.add(model);
    if (this.cardEnabled) {
      const data = this._cardsJson ? (await this._cardsJson)[id] : null;
      if (this.disposed) return;
      this.cardScreen.attach(model, data);
    }
    const rig = rigParts(model, this.scene);
    this.animator.attachRig(rig);
    if (this.cardEnabled) this.cardScreen.rigDriven = !!(rig && rig.card);
  }

  setCard(content) {
    if (this.cardScreen) this.cardScreen.setContent(content);
  }
  dispose() {
    this.disposed = true;
    if (this.cardScreen) { try { this.cardScreen.dispose(); } catch (e) {} }
    this.renderer.dispose();
  }
  _tick() {
    if (this.disposed) return;
    const t = (performance.now() - this.t0) / 1000;
    this.animator.update();
    if (this.cardEnabled && this.cardScreen) this.cardScreen.update();
    const o = this.animator.out;
    const spread = 1 + (o.y / 2) * 0.55;
    this.shadow.scale.set(o.sx * spread, spread, 1);
    this.shadow.material.opacity = o.ground;
    if (this.cameraSway) {
      this.camera.position.set(
        this.camBase.x + 0.12 * Math.sin(TAU * t / 11),
        this.camBase.y + 0.05 * Math.sin(TAU * t / 8.2),
        this.camBase.z
      );
    } else {
      this.camera.position.copy(this.camBase);
    }
    this.camera.lookAt(this.lookAt);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}
