// Surgical eye-socket softener for a processed Rodin buddy GLB.
//
// process_rodin_pbr.mjs multiplies a warm-tinted ambient-occlusion atlas into
// the albedo AND registers it as occlusionTexture; the scan itself also baked a
// little shadow around the sunk-in bead eyes. Both leave a dark brown halo
// around the eyes. This repaints BODY texels within a 3D radius of each eye
// centre (feathered) toward the plain body-yarn colour: it un-bakes the AO,
// pulls the residual scan-shadow toward the median yarn tone, and opens the
// occlusion map so live lighting keeps it bright. Only body texels near the
// eyes are touched — beads, nose, buns, card and the rest of the body are left
// exactly as they were.
//
// Usage: node soften_eye_sockets.mjs <in.glb> <out.glb> <ao.png>
//   RIN  (default 0.08)  full effect within this model-space radius of an eye
//   ROUT (default 0.20)  feather to no change by here
//   PULL (default 0.80)  how hard the core is pulled to the median yarn colour
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';

const [IN, OUT, AO_PATH] = process.argv.slice(2);
const RIN = Number(process.env.RIN || 0.08);
const ROUT = Number(process.env.ROUT || 0.20);
const PULL = Number(process.env.PULL || 0.80);
const GAMMA = 0.5, FLOOR = [0.48, 0.33, 0.24]; // same albedo-AO curve the pipeline baked

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(IN);
const root = doc.getRoot();

const prims = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) prims.push({ name: node.getName(), prim });
}
const centreOf = (prim) => {
  const pos = prim.getAttribute('POSITION');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; } }
  return [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
};
const eyes = prims.filter((p) => p.name.startsWith('eye')).map((p) => centreOf(p.prim));
const bodyPrims = prims.filter((p) => p.name === 'body');
console.log('eyes:', eyes.map((c) => c.map((x) => x.toFixed(3)).join(',')));

const bodyMat = bodyPrims[0].prim.getMaterial();
const baseTex = bodyMat.getBaseColorTexture();
const ormTex = bodyMat.getMetallicRoughnessTexture();
const base = await sharp(baseTex.getImage()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const orm = await sharp(ormTex.getImage()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = base.info.width, H = base.info.height;
if (orm.info.width !== W || orm.info.height !== H) throw new Error('base/orm dims differ');
const baseData = base.data, ormData = orm.data;
const aoBuf = await sharp(AO_PATH).resize(W, H).greyscale().raw().toBuffer();

const inv = [0, 1, 2].map((c) => {
  const t = new Float32Array(256);
  for (let a = 0; a < 256; a++) { const f = FLOOR[c] + (1 - FLOOR[c]) * Math.pow(a / 255, GAMMA); t[a] = 1 / Math.pow(f, 1 / 2.2); }
  return t;
});

// ---- rasterize BODY → per-texel weight (near an eye) + coverage (for median) ----
const weight = new Float32Array(W * H);
const cover = new Uint8Array(W * H);
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const nearestEye2 = (p) => { let m = Infinity; for (const e of eyes) { const d = (p[0] - e[0]) ** 2 + (p[1] - e[1]) ** 2 + (p[2] - e[2]) ** 2; if (d < m) m = d; } return m; };
const RIN2 = RIN * RIN, ROUT2 = ROUT * ROUT;

for (const { prim } of bodyPrims) {
  const pos = prim.getAttribute('POSITION');
  const uv = prim.getAttribute('TEXCOORD_0');
  const idx = prim.getIndices();
  const n = idx.getCount();
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], U = [[0, 0], [0, 0], [0, 0]];
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const j = idx.getScalar(t + k);
      pos.getElement(j, P[k]);
      const q = [0, 0]; uv.getElement(j, q);
      U[k][0] = Math.min(1, Math.max(0, q[0])) * (W - 1);
      U[k][1] = Math.min(1, Math.max(0, q[1])) * (H - 1);
    }
    const [u0, u1, u2] = U;
    const area = (u1[0] - u0[0]) * (u2[1] - u0[1]) - (u1[1] - u0[1]) * (u2[0] - u0[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(u0[0], u1[0], u2[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(u0[0], u1[0], u2[0])));
    const y0 = Math.max(0, Math.floor(Math.min(u0[1], u1[1], u2[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(u0[1], u1[1], u2[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const b0 = ((u1[0] - px) * (u2[1] - py) - (u2[0] - px) * (u1[1] - py)) / area;
      const b1 = ((u2[0] - px) * (u0[1] - py) - (u0[0] - px) * (u2[1] - py)) / area;
      const b2 = 1 - b0 - b1;
      if (b0 < -0.01 || b1 < -0.01 || b2 < -0.01) continue;
      const i = y * W + x;
      cover[i] = 1;
      const p3 = [b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0], b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1], b0 * P[0][2] + b1 * P[1][2] + b2 * P[2][2]];
      const d2 = nearestEye2(p3);
      if (d2 >= ROUT2) continue;
      const w = d2 <= RIN2 ? 1 : smooth((ROUT2 - d2) / (ROUT2 - RIN2));
      if (w > weight[i]) weight[i] = w;
    }
  }
}

// ---- median body-yarn colour: bright body texels, away from the eyes ----
const samples = [[], [], []];
for (let i = 0; i < W * H; i++) {
  if (!cover[i] || weight[i] > 0) continue;
  const o = i * 4, R = baseData[o], G = baseData[o + 1], B = baseData[o + 2];
  const luma = 0.299 * R + 0.587 * G + 0.114 * B;
  if (R > 150 && luma > 90 && luma < 210) { samples[0].push(R); samples[1].push(G); samples[2].push(B); }
}
const median = samples.map((s) => { s.sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 180; });
console.log('body yarn median RGB:', median.map((x) => Math.round(x)).join(','), '| samples', samples[0].length);

// ---- apply: un-AO, then pull toward the median yarn colour; open occlusion ----
let touched = 0;
for (let i = 0; i < W * H; i++) {
  const w = weight[i];
  if (w <= 0) continue;
  touched++;
  const o = i * 4, a = aoBuf[i];
  for (let c = 0; c < 3; c++) {
    const unAO = Math.min(255, baseData[o + c] * (1 + w * (inv[c][a] - 1)));
    const k = w * PULL;                       // pull toward median yarn colour
    baseData[o + c] = Math.round(unAO * (1 - k) + median[c] * k);
  }
  ormData[o] = Math.round(ormData[o] + w * (255 - ormData[o])); // fully lit
}
console.log(`repainted ${touched} socket texels (RIN=${RIN} ROUT=${ROUT} PULL=${PULL})`);

baseTex.setImage(await sharp(baseData, { raw: { width: W, height: H, channels: 4 } }).webp().toBuffer()).setMimeType('image/webp');
ormTex.setImage(await sharp(ormData, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 90 }).toBuffer()).setMimeType('image/webp');

await doc.transform(draco());
await io.write(OUT, doc);
console.log('written:', OUT, (fs.statSync(OUT).size / 1024 | 0), 'KB');
