// Convert a Rodin part-separated PBR GLB (base_basic_pbr.glb) to the app's
// model spec: named parts (body/card/handL/handR/eyeL/eyeR), simplified tris,
// 1024 webp textures (baseColor + normal + metallicRoughness kept for
// real-time lighting), Draco, card plane via PCA on the card mesh.
//
// The PBR export carries no baked lighting, so occlusion black, contact
// shadows and seam creases don't exist in the first place — the scene lights
// the model at runtime (IBL + tone mapping in src/scene.js). Only the deep
// cavities (card slot, sockets) that no bake camera ever saw are black
// in the albedo; those get neighbor-diffused, with the eye UV islands
// protected (eye albedo is legitimately near-black).
//
// Deps are in devDependencies (npm install covers them).
// Usage:
//   node process_rodin_pbr.mjs <in_pbr.glb> <out.glb> <card-plane-out.json>
//   SIMPLIFY_ERROR=0.001 (default) — meshopt error bound; raise for smaller files.
// Then merge the card JSON into public/models/cards.json under the character id.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, textureCompress, prune, draco } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';

const [srcPath, outPath, cardJsonPath] = process.argv.slice(2);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(srcPath);
const root = doc.getRoot();

// ---- identify parts by bbox ----
function bbox(prim) {
  const pos = prim.getAttribute('POSITION');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    for (let k = 0; k < 3; k++) {
      if (v[k] < min[k]) min[k] = v[k];
      if (v[k] > max[k]) max[k] = v[k];
    }
  }
  return {
    min, max,
    size: min.map((m, k) => max[k] - m),
    center: min.map((m, k) => (max[k] + m) / 2),
  };
}

const parts = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prim = mesh.listPrimitives()[0];
  const b = bbox(prim);
  const vol = b.size[0] * b.size[1] * b.size[2];
  parts.push({ node, mesh, prim, b, vol });
}
parts.sort((a, c) => c.vol - a.vol);

// biggest = body; flattest wide = card. Of what's left, hands are the two
// most lateral meshes (arms reaching out to the sides) and eyes the two
// smallest (little symmetric buttons). Anything still unclaimed — a taco's
// shell, a grad cap — is decorative: it gets a neutral 'trim' name so the
// 6-part rig (scene.js rigParts) ignores it and it simply rides the body
// (root squash/move/spin) statically, with no hinge of its own.
// NB: don't pick eyes/hands by height — extra toppings can sit above the
// real eyes and steal their slot.
const body = parts[0];
const rest = parts.slice(1);
const card = rest.reduce((best, p) => {
  const flat = Math.min(...p.b.size) / Math.max(...p.b.size);
  const bestFlat = Math.min(...best.b.size) / Math.max(...best.b.size);
  return p.b.size[0] > 0.5 && flat < bestFlat ? p : best;
});
const pool = rest.filter((p) => p !== card);
const byX = [...pool].sort((a, c) => a.b.center[0] - c.b.center[0]);
const hands = pool.length >= 2 ? [byX[0], byX[byX.length - 1]] : [];
const eyes = pool.filter((p) => !hands.includes(p)).sort((a, c) => a.vol - c.vol).slice(0, 2);
const name = (p) => {
  if (p === body) return 'body';
  if (p === card) return 'card';
  const side = p.b.center[0] >= 0 ? 'R' : 'L';
  if (eyes.includes(p)) return 'eye' + side;
  if (hands.includes(p)) return 'hand' + side;
  return 'trim'; // decorative extra — no rig slot, rides the body statically
};
for (const p of parts) {
  const n = name(p);
  p.node.setName(n);
  p.mesh.setName(n);
  const mat = p.prim.getMaterial();
  if (mat) mat.setName(n);
  console.log(`part ${n}: tris=${p.prim.getIndices().getCount() / 3} center=[${p.b.center.map((x) => x.toFixed(3))}] size=[${p.b.size.map((x) => x.toFixed(3))}]`);
}

// drop tangents — three.js derives tangents in-shader for normal maps, and
// welding/simplification work better without the extra attribute
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const t = prim.getAttribute('TANGENT');
    if (t) prim.setAttribute('TANGENT', null);
  }
}

// ---- albedo cavity fill ----
// Deep cavities (the card slot, sockets) are black in the albedo — no bake
// camera ever saw inside. Diffuse surrounding yarn color into them so parts
// animating apart never reveal black material. Eye and trim UV islands are
// protected: their albedo is legitimately near-black by design (bead eyes, a
// black felt grad cap) — flooding it would smear the surrounding yarn over a
// visible surface. Also flood the uncovered atlas background with the nearest
// island colors so bilinear/mipmap edges after the 2048→1024 resize never
// sample stray background.
{
  const rasterize = (prim, mask, W, H) => {
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const q = [0, 0];
    const pts = [[0, 0], [0, 0], [0, 0]];
    for (let t = 0; t < idx.getCount(); t += 3) {
      for (let k = 0; k < 3; k++) {
        uv.getElement(idx.getScalar(t + k), q);
        pts[k][0] = Math.min(Math.max(q[0], 0), 1) * (W - 1);
        pts[k][1] = Math.min(Math.max(q[1], 0), 1) * (H - 1);
      }
      const [p0, p1, p2] = pts;
      const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (!area) continue;
      const s = Math.sign(area);
      const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
      const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        if (s * ((p1[0] - p0[0]) * (cy - p0[1]) - (p1[1] - p0[1]) * (cx - p0[0])) >= 0 &&
            s * ((p2[0] - p1[0]) * (cy - p1[1]) - (p2[1] - p1[1]) * (cx - p1[0])) >= 0 &&
            s * ((p0[0] - p2[0]) * (cy - p2[1]) - (p0[1] - p2[1]) * (cx - p2[0])) >= 0) {
          mask[y * W + x] = 1;
        }
      }
    }
  };

  for (const tex of new Set(root.listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean))) {
    const { data, info } = await sharp(tex.getImage())
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, N = W * H;

    const dilate1 = (m) => {
      const out = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) ||
            (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) out[i] = 1;
      }
      return out;
    };

    // eye + trim UV coverage (+2px margin) — their albedo is near-black by
    // design (bead eyes, a black felt grad cap), so keep the fill out of them
    let protect = new Uint8Array(N);
    const covered = new Uint8Array(N);
    for (const p of parts) {
      const mat = p.prim.getMaterial();
      if (!mat || mat.getBaseColorTexture() !== tex) continue;
      rasterize(p.prim, covered, W, H);
      const nm = p.node.getName();
      if (nm.startsWith('eye') || nm === 'trim') rasterize(p.prim, protect, W, H);
    }
    protect = dilate1(dilate1(protect));

    // wave-fill: replace hole texels with the average of their known
    // neighbors, wave by wave
    const nb4 = (i, fn) => {
      const x = i % W;
      if (x > 0) fn(i - 1);
      if (x < W - 1) fn(i + 1);
      if (i >= W) fn(i - W);
      if (i < N - W) fn(i + W);
    };
    const waveFill = (buf, hole) => {
      const state = new Uint8Array(N);
      for (let i = 0; i < N; i++) state[i] = hole[i] ? 0 : 1;
      let frontier = [];
      for (let i = 0; i < N; i++) {
        if (state[i] === 1) nb4(i, (j) => { if (state[j] === 0) { state[j] = 2; frontier.push(j); } });
      }
      let n = 0;
      while (frontier.length) {
        const acc = new Float32Array(frontier.length * 3);
        let k = 0;
        for (const i of frontier) {
          let r = 0, g = 0, b = 0, c = 0;
          nb4(i, (j) => { if (state[j] === 1) { const o = j * 4; r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; c++; } });
          acc[k++] = r / c; acc[k++] = g / c; acc[k++] = b / c;
        }
        k = 0;
        for (const i of frontier) {
          const o = i * 4;
          buf[o] = acc[k++]; buf[o + 1] = acc[k++]; buf[o + 2] = acc[k++];
          state[i] = 1;
          n++;
        }
        const next = [];
        for (const i of frontier) nb4(i, (j) => { if (state[j] === 0) { state[j] = 2; next.push(j); } });
        frontier = next;
      }
      return n;
    };

    const cavity = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (covered[i] && !protect[i] && Math.max(data[o], data[o + 1], data[o + 2]) < 30) cavity[i] = 1;
    }
    const cavityFilled = waveFill(data, cavity);

    const bg = new Uint8Array(N);
    for (let i = 0; i < N; i++) bg[i] = covered[i] ? 0 : 1;
    const padded = waveFill(data, bg);
    console.log(`albedo fill: ${cavityFilled}px cavity, ${padded}px padding (eye UVs protected)`);
    tex.setImage(await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
    tex.setMimeType('image/png');
  }
}

// ---- simplify to ~80k total ----
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.065, error: Number(process.env.SIMPLIFY_ERROR || 0.001) }),
);
let total = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) total += prim.getIndices().getCount() / 3;
}
console.log('total tris after simplify:', total);

// ---- card plane via PCA on the simplified card mesh ----
{
  const prim = card.mesh.listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const n = pos.getCount();
  const v = [0, 0, 0];
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    for (let k = 0; k < 3; k++) mean[k] += v[k] / n;
  }
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const d = v.map((x, k) => x - mean[k]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += (d[r] * d[c]) / n;
  }
  // Jacobi eigen decomposition (3x3 symmetric)
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const A = C.map((row) => row.slice());
  for (let iter = 0; iter < 50; iter++) {
    let p = 0, q = 1, m = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > m) { p = 0; q = 2; m = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > m) { p = 1; q = 2; m = Math.abs(A[1][2]); }
    if (m < 1e-12) break;
    const theta = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let k = 0; k < 3; k++) {
      const akp = A[k][p], akq = A[k][q];
      A[k][p] = c * akp - s * akq;
      A[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = A[p][k], aqk = A[q][k];
      A[p][k] = c * apk - s * aqk;
      A[q][k] = s * apk + c * aqk;
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = c * vkp - s * vkq;
      V[k][q] = s * vkp + c * vkq;
    }
  }
  const eig = [0, 1, 2].map((i) => ({ val: A[i][i], vec: [V[0][i], V[1][i], V[2][i]] }));
  eig.sort((a, b) => a.val - b.val);
  let normal = eig[0].vec;
  if (normal[2] < 0) normal = normal.map((x) => -x); // face +z (toward camera)
  const nlen = Math.hypot(...normal);
  normal = normal.map((x) => x / nlen);
  // up = world +y projected onto the card plane
  let up = [0 - normal[0] * normal[1], 1 - normal[1] * normal[1], 0 - normal[2] * normal[1]];
  const ulen = Math.hypot(...up);
  up = up.map((x) => x / ulen);
  const right = [up[1] * normal[2] - up[2] * normal[1], up[2] * normal[0] - up[0] * normal[2], up[0] * normal[1] - up[1] * normal[0]];
  // extents in plane basis
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const d = v.map((x, k) => x - mean[k]);
    const proj = [right, up, normal].map((ax) => d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]);
    for (let k = 0; k < 3; k++) {
      if (proj[k] < lo[k]) lo[k] = proj[k];
      if (proj[k] > hi[k]) hi[k] = proj[k];
    }
  }
  const mid = lo.map((l, k) => (l + hi[k]) / 2);
  const center = [0, 1, 2].map((k) => mean[k] + right[k] * mid[0] + up[k] * mid[1] + normal[k] * mid[2]);
  const entry = {
    center,
    normal,
    up,
    width: hi[0] - lo[0],
    height: hi[1] - lo[1],
    // clear the front face of the yarn card: half slab thickness + margin
    offset: (hi[2] - lo[2]) / 2 + 0.015,
  };
  console.log('card plane:', JSON.stringify(entry, null, 1));
  if (cardJsonPath) fs.writeFileSync(cardJsonPath, JSON.stringify(entry, null, 1));
}

// ---- textures + compression ----
// normal + metallicRoughness carry shading signal — compress gently
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], slots: /baseColor/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 90, slots: /normal|metallicRoughness/ }),
  prune(),
  draco(),
);

await io.write(outPath, doc);
console.log('written:', outPath, (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB');
