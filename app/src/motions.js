// Motion system ported from the design prototype's lib/spud-scene2.js
// (Turn 6 · part rig + easing pass, Turn 7 · soul-engine clips and the
// doze / hum idle modes) — keep in sync with it.
//   - eased keyframe sampler: every segment carries its own curve
//     (outBack 蓄力回弹 / outElastic 果冻余震 / ballistic jump timing)
//   - part tracks drive the rigged pivots (hands at the shoulder, eyes in
//     their sockets, card at its bottom edge) on part-separated models
//   - idle life: blinks 2.6–6.4s, gaze saccades, paw sway lagging the breath
//   - cursor tracking: eyes lead (k=16), head follows (k=6.5)
//   - drag spin: momentum while fast, underdamped spring-back once slow
// App-specific additions kept from the Turn 3 spec: the 'lean' listen mode,
// the root-only 'raise'/'comfort' clips for legacy single-mesh models, and
// 'bigSquish' for the [proud] emotion trigger.

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

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
    zh: '挥手 · Wave', pt: true,
    spec: '1.7s · 肩铰链: outBack 抬爪 → 3× inOutSine 摆动 → outBackSoft 放下 · 挥手时侧身 + 眨一下眼',
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
    zh: '眨眼 · Blink', pt: true,
    spec: '320ms · 合眼 inQuad 快 · 睁眼 outQuad 慢 — 真实眨眼的不对称时序',
    dur: 320,
    eyes: [{ t: 0 }, { t: 0.32, blink: 1, e: 'inQuad' }, { t: 0.48, blink: 1 }, { t: 1, blink: 0, e: 'outQuad' }],
  },
  shy: {
    zh: '害羞捂眼 · Shy', pt: true,
    spec: '3s · 双爪 outBack 飞到同侧眼睛前捂住 → 指缝偷看一眼 → inOutCubic 放下 · 全程低头缩肩',
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
    zh: '转眼珠 · Eye-roll', pt: true,
    spec: '1.5s · 双眼沿椭圆轨道转一整圈 (角度 inOutCubic 驱动) · 头微微跟着晃 · 结尾嫌弃地眨一下',
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
    zh: '举卡片 · Present', pt: true,
    // Deviation from the Turn-6 spec (lift .11 · tilt 16°): Rodin generates
    // the body with a card-shaped pocket the bakes never saw into — lifting
    // the card uncovers it as a dark pit. Push+tilt keeps the pocket covered
    // by the card itself while still handing it to the camera.
    spec: '2.4s · 卡片+双爪 outBack 递出 · push 9%h · 卡面 tilt 18° 递向镜头 · 顶点 ±2.5° 得意小晃 · 身体后仰 4°',
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
    zh: '摸摸 · Tap Squish',
    spec: '650ms · 压扁 outQuad 快进 → 恢复整段 outElastic 果冻回弹 (sx·sy≈1 体积守恒) · 爪子被挤得外翻',
    dur: 650,
    root: [{ t: 0 }, { t: 0.2, sx: 1.25, sy: 0.75, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    hands: [{ t: 0 }, { t: 0.2, raise: 16, out: 0.022, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    eyes: [{ t: 0 }, { t: 0.16, blink: 1, e: 'inQuad' }, { t: 0.4, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  // app-specific: bigger squish for the [proud] emotion trigger (Turn 3 map)
  bigSquish: {
    zh: '大摸摸 · Big Squish',
    spec: '650ms · squish 的加强版 · (1.32,.68) · [proud] 触发',
    dur: 650,
    root: [{ t: 0 }, { t: 0.2, sx: 1.32, sy: 0.68, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    hands: [{ t: 0 }, { t: 0.2, raise: 22, out: 0.028, e: 'outQuad' }, { t: 1, e: 'outElastic' }],
    eyes: [{ t: 0 }, { t: 0.16, blink: 1, e: 'inQuad' }, { t: 0.4, blink: 0, e: 'outQuad' }, { t: 1 }],
  },
  hop: {
    zh: '开心跳 · Hop',
    spec: '640ms 抛物线时序 · 蹲 → 蹬伸 → 上程 outQuad 减速 · 下程 inQuad 加速 → 落地 squash + outElastic 余震',
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
    zh: '欢呼 · Cheer', pt: true,
    spec: '1.5s 连续两跳 · 双爪 outBack 举高挥舞 · rotZ ∓6° · 眯眼笑 · 落地 outElastic 收尾',
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
    zh: '转圈展示 · Turntable',
    spec: '1.15s · 反向蓄力 −30° (outCubic) → 甩到 378° (inOutQuart 鞭梢感) → outBackSoft 回落 360° · 离心力把爪子甩开',
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
    zh: '跳跃转体 · Hop-spin',
    spec: '1s · 深蹲 → 蹬伸起跳 · 空中 rotY 360° (上程减速/下程加速的抛物线) · 落地 squash → outElastic 余震 · 转完晕得眨眼',
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
    zh: '伸懒腰 · Stretch', pt: true,
    spec: '2.4s · 拉长 14% + 后仰 7° · 双爪 outBack 举过头顶 · 眯眼 85% · outBackSoft 缩回',
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
    zh: '读卡片 · Study', pt: true,
    // card track deviates from the prototype (lift .1 · push .045 · tilt −24):
    // that much back-tilt digs the card top into Rodin's chest pocket — read
    // with a shallower tilt, pushed further out and lifted clear of the belly
    spec: '3.4s · 卡片 tilt −16° 翻向自己 (推出 8.5%h 提 6%h) · 眼珠沿字行左右扫读 · 头歪 ±4° 跟读',
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
    zh: '追尾巴 · Tail-chase',
    spec: '2.3s · 左右急转 4 次 (眼珠先行半拍) → 恼羞成怒甩 360° · 接不倒翁眩晕',
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
    zh: '颠卡片 · Card-juggle', pt: true,
    spec: '1.9s · 卡片两次抛接 (上程 outQuad / 下程 inQuad) · 眼珠全程追踪 · 身体跟着颠',
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
    zh: '敲玻璃 · Knock', pt: true,
    spec: '1.9s · 前倾 11° 贴近屏幕 · 右爪 curl 敲两下 (26° inQuad 快敲/outQuad 收) · 瞪大眼等回应',
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
    zh: '蔫了 · Sulk', pt: true,
    // card track deviates from the prototype (tilt −8 only): the backward
    // droop digs into Rodin's card pocket — push forward while tilted
    spec: '2.8s · 整体下垂: 头 9° · 爪 −13° · 眼帘 40% · 卡片也耷拉 · 慢 inOutSine 显失落',
    dur: 2800,
    root: [{ t: 0 }, { t: 0.3, rotX: 9, sy: 0.955, rotZ: -2, e: 'inOutSine' }, { t: 0.85, rotX: 9, sy: 0.955, rotZ: -2 }, { t: 1, e: 'inOutSine' }],
    hands: [{ t: 0 }, { t: 0.3, raise: -13, e: 'inOutSine' }, { t: 0.85, raise: -13 }, { t: 1 }],
    eyes: [{ t: 0 }, { t: 0.3, dy: -0.5, blink: 0.4, e: 'inOutSine' }, { t: 0.85, dy: -0.5, blink: 0.4 }, { t: 1, blink: 0, e: 'outQuad' }],
    card: [{ t: 0 }, { t: 0.3, tilt: -8, push: 0.026, e: 'inOutSine' }, { t: 0.85, tilt: -8, push: 0.026 }, { t: 1 }],
  },
  sneeze: {
    zh: '打喷嚏 · Sneeze',
    spec: '1.35s · 吸气后仰 −15° 拉长 → "啾" inQuad 甩头 16° + squash → outElastic 抖回 · 卡片被喷歪',
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
    zh: '惊醒 · Startle',
    spec: '0.9s · 原地弹起 5%h + 瞬间瞪眼 · 爪子 outBack 张开 · outElastic 落定',
    dur: 900,
    root: [{ t: 0 }, { t: 0.18, y: 0.05, sy: 1.1, sx: 0.94, rotX: -6, e: 'outBack' }, { t: 0.34, y: 0, sy: 0.93, sx: 1.09, e: 'inQuad' }, { t: 1, e: 'outElastic' }],
    eyes: [{ t: 0, blink: 0.8 }, { t: 0.16, blink: 0, dy: 0.5, e: 'outQuad' }, { t: 0.6, dy: 0.4 }, { t: 1 }],
    hands: [{ t: 0 }, { t: 0.18, raise: 40, out: 0.024, e: 'outBack' }, { t: 1, e: 'outElastic' }],
  },
  peek: {
    zh: '张望 · Look-around',
    spec: '1.6s · 眼珠先行、头跟半拍 · 左右各扫一遍回正',
    dur: 1600,
    root: [{ t: 0 }, { t: 0.2, rotY: -24, rotZ: -2, e: 'outCubic' }, { t: 0.5, rotY: 22, rotZ: 2, e: 'inOutSine' }, { t: 0.75, rotY: 0, rotZ: 0, e: 'inOutSine' }, { t: 1 }],
    eyes: [{ t: 0 }, { t: 0.16, dx: -0.55, e: 'outCubic' }, { t: 0.46, dx: 0.5, e: 'inOutSine' }, { t: 0.72, dx: 0 }, { t: 1 }],
  },
  // root-only clips for legacy single-mesh models (Turn 5 lib/spud-scene.js)
  comfort: {
    zh: '安慰贴贴 · Lean',
    spec: '2.2s · rotZ −4° 保持 · 像把身体靠过来 · [comfort] 触发',
    dur: 2200,
    root: [{ t: 0 }, { t: 0.25, rotZ: -4, x: -0.03, e: 'outCubic' }, { t: 0.75, rotZ: -4, x: -0.03 }, { t: 1, e: 'inOutSine' }],
  },
  raise: {
    zh: '举卡片 · Card Raise (legacy)',
    spec: '600ms spring · rotX 8° 朝镜头递过来 · 无拆件时配合 CardScreen.raise',
    dur: 600,
    root: [{ t: 0 }, { t: 0.5, rotX: 8, sy: 1.03, e: 'outBack' }, { t: 1, e: 'inOutSine' }],
  },
};

/* roly-poly 不倒翁 — decaying precession; eyes counter-sway to stay "level" */
export const WOBBLE = {
  zh: '不倒翁 · Roly-poly',
  spec: '2.6s 指数衰减进动 · rotZ/rotX 相位差 90° · 眼珠反向补偿保持水平 (前庭反射)',
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
    this.mode = 'idle'; // idle | lean | rock | doze | hum
    this.leanK = 0;
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
    this.blinkStart = -1e9;
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

    /* 04 · Listen Lean — eased toward/away from the lean pose */
    this.leanK += ((this.mode === 'lean' ? 1 : 0) - this.leanK) * (1 - Math.exp(-dt * 5));
    if (this.leanK > 0.001) {
      rotZ += -4 * this.leanK;
      x += -0.02 * this.h * this.leanK;
    }

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

    /* tuck slide — 700ms outBack, then micro-bob */
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
        h.g.rotation.set(v.curl * D2R, 0, h.sign * v.raise * D2R);
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
