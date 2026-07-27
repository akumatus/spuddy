// Give a buddy a clean rounded-rectangle held-card, conformed to its own card
// footprint and depth so the paws still grip and the belly doesn't poke through.
//
// Some scans produce a warped card silhouette (Mochi's top edge droops). This
// takes a clean donor card mesh (Spud's — a tidy rounded rectangle), affine-fits
// it into the target's card footprint (from cards.json: center/normal/up/w/h, so
// proportions + placement are the target's), then conforms its FRONT depth to
// the target's ORIGINAL card surface: a bilinear-sampled depth map so the centre
// keeps the forward bulge that clears the belly while the edges stay back where
// the hands grip. Card thickness rides along the normal; UVs are re-projected by
// CardScreen at runtime.
//
// Usage: node clean_card_mesh.mjs <target.glb> <out.glb> <donor.glb> <cards.json> <targetId> [donorId=spud]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';

const [TARGET, OUT, DONOR, CARDS_JSON, TARGET_ID] = process.argv.slice(2);
const DONOR_ID = process.env.DONOR_ID || 'spud';
const MARGIN = Number(process.env.MARGIN || 0.008);
const GAIN = Number(process.env.GAIN || 1); // >1 pushes forward (belly) regions harder without moving the flat edges (paws)
const BUMP = Number(process.env.BUMP || 0); // extra forward bulge at the card's horizontal centre — clears a belly that pokes where the original card was flat
const BW = Number(process.env.BW || 0.42);  // |a| at which the bump tapers to 0 (keep < the paw grip at |a|~0.45)
const GN = 64; // depth-map resolution
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const frame = (p) => { const N = norm(p.normal), U = norm(p.up); return { C: p.center, N, U, R: norm(cross(U, N)), W: p.width, H: p.height }; };

const cards = JSON.parse(fs.readFileSync(CARDS_JSON, 'utf8'));
const S = frame(cards[DONOR_ID]), T = frame(cards[TARGET_ID]);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

// ---- donor card geometry ----
const sdoc = await io.read(DONOR);
const sCard = sdoc.getRoot().listNodes().find((n) => n.getName() === 'card');
const sPrim = sCard.getMesh().listPrimitives()[0];
const sPos = sPrim.getAttribute('POSITION'), sUv = sPrim.getAttribute('TEXCOORD_0'), sIdx = sPrim.getIndices();
const nV = sPos.getCount();
const inPos = new Float32Array(nV * 3), uvArr = sUv ? new Float32Array(nV * 2) : null;
const v = [0, 0, 0], q = [0, 0];
for (let i = 0; i < nV; i++) { sPos.getElement(i, v); inPos.set(v, i * 3); if (sUv) { sUv.getElement(i, q); uvArr.set(q, i * 2); } }
const idxArr = new Uint32Array(sIdx.getCount());
for (let i = 0; i < sIdx.getCount(); i++) idxArr[i] = sIdx.getScalar(i);
console.log(`donor card: ${nV} verts, ${idxArr.length / 3} tris`);

// ---- affine-fit into target footprint ----
const outPos = new Float32Array(nV * 3);
for (let i = 0; i < nV; i++) {
  const p = [inPos[i * 3], inPos[i * 3 + 1], inPos[i * 3 + 2]];
  const dp = sub(p, S.C);
  const a = dot(dp, S.R) / S.W, b = dot(dp, S.U) / S.H, c = dot(dp, S.N);
  for (let k = 0; k < 3; k++) outPos[i * 3 + k] = T.C[k] + T.R[k] * a * T.W + T.U[k] * b * T.H + T.N[k] * c;
}

// ---- read target doc + original card depth map ----
const tdoc = await io.read(TARGET);
const troot = tdoc.getRoot();
const tCard = troot.listNodes().find((n) => n.getName() === 'card');
if (!tCard) throw new Error('target has no card node');
const tr = tCard.getTranslation(), ro = tCard.getRotation(), sc = tCard.getScale();
if (tr.some((x) => Math.abs(x) > 1e-4) || sc.some((x) => Math.abs(x - 1) > 1e-4) || Math.abs(ro[3] - 1) > 1e-4)
  throw new Error(`card node not identity — need to compose its transform`);
const tPrim = tCard.getMesh().listPrimitives()[0];
const oPos = tPrim.getAttribute('POSITION');

const G = new Float32Array(GN * GN).fill(-Infinity);
const cellOf = (a, b) => Math.min(GN - 1, Math.max(0, Math.floor((b + 0.5) * GN))) * GN + Math.min(GN - 1, Math.max(0, Math.floor((a + 0.5) * GN)));
{
  const p = [0, 0, 0];
  for (let i = 0; i < oPos.getCount(); i++) {
    oPos.getElement(i, p);
    const dp = sub(p, T.C), a = dot(dp, T.R) / T.W, b = dot(dp, T.U) / T.H, c = dot(dp, T.N);
    const idx = cellOf(a, b);
    if (c > G[idx]) G[idx] = c;
  }
  let mean = 0, cnt = 0;
  for (const g of G) if (g > -Infinity) { mean += g; cnt++; }
  mean /= cnt || 1;
  for (let i = 0; i < G.length; i++) if (G[i] === -Infinity) G[i] = mean;
}
// bilinear sample — smooth surface that keeps the belly-clearing peak
const sampleG = (a, b) => {
  const fx = Math.min(GN - 1, Math.max(0, (a + 0.5) * GN - 0.5)), fy = Math.min(GN - 1, Math.max(0, (b + 0.5) * GN - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(GN - 1, x0 + 1), y1 = Math.min(GN - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  return (G[y0 * GN + x0] * (1 - tx) + G[y0 * GN + x1] * tx) * (1 - ty) + (G[y1 * GN + x0] * (1 - tx) + G[y1 * GN + x1] * tx) * ty;
};
let spudFront = -Infinity;
for (let i = 0; i < nV; i++) { const c = dot(sub([outPos[i * 3], outPos[i * 3 + 1], outPos[i * 3 + 2]], T.C), T.N); if (c > spudFront) spudFront = c; }
let maxOff = 0;
for (let i = 0; i < nV; i++) {
  const dp = sub([outPos[i * 3], outPos[i * 3 + 1], outPos[i * 3 + 2]], T.C);
  const a = dot(dp, T.R) / T.W, b = dot(dp, T.U) / T.H;
  const bump = BUMP * (1 - smoothstep(BW * 0.5, BW, Math.abs(a)));
  const off = GAIN * Math.max(0, sampleG(a, b) - spudFront) + MARGIN + bump;
  if (off > maxOff) maxOff = off;
  for (let k = 0; k < 3; k++) outPos[i * 3 + k] += T.N[k] * off;
}
console.log(`conformed to original depth (spudFront=${spudFront.toFixed(3)}, max push=${maxOff.toFixed(3)})`);

// ---- normals from the final geometry ----
const nrm = new Float32Array(nV * 3);
for (let t = 0; t < idxArr.length; t += 3) {
  const [i0, i1, i2] = [idxArr[t], idxArr[t + 1], idxArr[t + 2]];
  const p0 = [outPos[i0 * 3], outPos[i0 * 3 + 1], outPos[i0 * 3 + 2]];
  const p1 = [outPos[i1 * 3], outPos[i1 * 3 + 1], outPos[i1 * 3 + 2]];
  const p2 = [outPos[i2 * 3], outPos[i2 * 3 + 1], outPos[i2 * 3 + 2]];
  const fn = cross(sub(p1, p0), sub(p2, p0));
  for (const ii of [i0, i1, i2]) { nrm[ii * 3] += fn[0]; nrm[ii * 3 + 1] += fn[1]; nrm[ii * 3 + 2] += fn[2]; }
}
for (let i = 0; i < nV; i++) nrm.set(norm([nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]), i * 3);

// ---- write into target card primitive ----
const buf = troot.listBuffers()[0];
for (const s of tPrim.listSemantics()) tPrim.setAttribute(s, null);
tPrim.setAttribute('POSITION', tdoc.createAccessor().setType('VEC3').setArray(outPos).setBuffer(buf));
tPrim.setAttribute('NORMAL', tdoc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buf));
if (uvArr) tPrim.setAttribute('TEXCOORD_0', tdoc.createAccessor().setType('VEC2').setArray(uvArr).setBuffer(buf));
tPrim.setIndices(tdoc.createAccessor().setType('SCALAR').setArray(idxArr).setBuffer(buf));

await tdoc.transform(prune(), draco());
await io.write(OUT, tdoc);
console.log('clean card ->', OUT, (fs.statSync(OUT).size / 1024 | 0), 'KB');
