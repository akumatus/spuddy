// Convert a Rodin part-separated PBR GLB (base_basic_pbr.glb) to the app's
// model spec: named parts (body/card/handL/handR/eyeL/eyeR), simplified tris,
// 1024 webp textures (baseColor + normal + metallicRoughness kept for
// real-time lighting), Draco, card plane via PCA on the card mesh.
//
// The PBR export carries no baked lighting, so occlusion black, contact
// shadows and seam creases don't exist in the first place — the scene lights
// the model at runtime (IBL + tone mapping in src/scene/). Only the deep
// cavities (card slot, sockets) that no bake camera ever saw are black
// in the albedo; those get neighbor-diffused, with the eye UV islands
// protected (eye albedo is legitimately near-black).
//
// Deps are in devDependencies (npm install covers them).
// Usage:
//   1. bake the AO atlases (see scripts/bake_ao.py):
//      Blender -b -P bake_ao.py -- <in_pbr.glb> <dir>/ao.png <dir>/ao_all.png 2048 0.16
//   2. node process_rodin_pbr.mjs <in_pbr.glb> <out.glb> <card-plane-out.json>
//      AO_ATLAS / AO_ATLAS_ALL — atlas locations; default: ao.png / ao_all.png next to the input.
//      BAKED_DIFFUSE=1 — opt into the baked-diffuse hybrid experiment (needs
//      ao_all.png + base_basic_shaded.glb next to the input).
//      SIMPLIFY_ERROR=0.001 (default) — meshopt error bound; raise for smaller files.
//      ALBEDO_SATURATION / ALBEDO_BRIGHTNESS (default 1 = off) — global albedo grade,
//      for scans whose texture bake drifts from the reference doll.
//      AO_ALBEDO_GAMMA=0.5 AO_ALBEDO_FLOOR=0.48,0.33,0.24 AO_OCCLUSION_STRENGTH=0.7 —
//      how hard the baked AO darkens (albedo multiply curve / aoMap weight); the
//      defaults were tuned on the warmer 2026-07-04 scans, lighter bakes may want
//      a gentler floor.
//      TRIM_SILVER=1 — render the 'trim' part as bare polished metal (spud's wire
//      glasses): flat silver base, metallic 1, no sheen/AO/textures, so the IBL
//      supplies the shine. Leave unset for yarn trims (taco's shell, grad's cap).
// Then merge the card JSON into public/models/cards.json under the character id.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsSheen } from '@gltf-transform/extensions';
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
// shell, a grad cap, a flower bouquet, the pot half the face is baked onto —
// is decorative: it gets a neutral 'trim' name so the 6-part rig (src/scene/rig.ts
// rigParts) ignores it and it simply rides the body (root squash/move/spin)
// statically, with no hinge of its own.
// NB: don't pick eyes/hands by height — extra toppings can sit above the real
// eyes and steal their slot. And only accept the two smallest as eyes if they
// are actually eye-sized: some Rodin exports bake the bead eyes into the body
// and give us no eye mesh at all. Then eyes stay painted-on and fixed (no
// blink / dart) — which is fine, that's how the legacy single-mesh crew looks.
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
const eyeCand = pool.filter((p) => !hands.includes(p)).sort((a, c) => a.vol - c.vol).slice(0, 2);
// eye-sized = under 5% of the body's bbox volume; a real bead pair clears this
// by orders of magnitude, a stray body/topping never does.
const eyes = eyeCand.length === 2 && eyeCand.every((p) => p.vol < 0.05 * body.vol) ? eyeCand : [];
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

// ---- sheen: fabric backscatter on everything that is yarn ----
// Knitted fiber catches light at grazing angles in a way the base BRDF can't
// express — KHR_materials_sheen adds that soft fuzzy edge glow. three's
// GLTFLoader upgrades these materials to MeshPhysicalMaterial automatically.
// Bead eyes stay glossy plastic: no sheen there.
{
  const sheenExt = doc.createExtension(KHRMaterialsSheen);
  for (const p of parts) {
    if (p.node.getName().startsWith('eye')) continue;
    const mat = p.prim.getMaterial();
    if (!mat) continue;
    const sheen = sheenExt.createSheen()
      .setSheenColorFactor([0.33, 0.28, 0.22]) // warm fiber tint; magnitude = strength
      .setSheenRoughnessFactor(0.8);           // broad, soft falloff
    mat.setExtension('KHR_materials_sheen', sheen);
  }
}

// drop tangents — three.js derives tangents in-shader for normal maps, and
// welding/simplification work better without the extra attribute
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const t = prim.getAttribute('TANGENT');
    if (t) prim.setAttribute('TANGENT', null);
  }
}

// wave-fill: replace hole texels of an RGBA buffer with the average of their
// known neighbors, wave by wave. Shared by the albedo cavity fill and the
// baked-diffuse build (deep pits in the shaded texture).
function waveFill(buf, hole, W, H) {
  const N = W * H;
  const nb4 = (i, fn) => {
    const x = i % W;
    if (x > 0) fn(i - 1);
    if (x < W - 1) fn(i + 1);
    if (i >= W) fn(i - W);
    if (i < N - W) fn(i + W);
  };
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

    const cavity = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (covered[i] && !protect[i] && Math.max(data[o], data[o + 1], data[o + 2]) < 30) cavity[i] = 1;
    }
    const cavityFilled = waveFill(data, cavity, W, H);

    const bg = new Uint8Array(N);
    for (let i = 0; i < N; i++) bg[i] = covered[i] ? 0 : 1;
    const padded = waveFill(data, bg, W, H);
    console.log(`albedo fill: ${cavityFilled}px cavity, ${padded}px padding (eye UVs protected)`);
    tex.setImage(await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
    tex.setMimeType('image/png');
  }
}

// ---- optional albedo grade (saturation / brightness, 1 = no-op) ----
// The whole crew shares one atlas per texture slot, so this grades everything;
// eyes (near-black) and the card (near-white) barely move at small factors.
{
  const SAT = Number(process.env.ALBEDO_SATURATION || 1);
  const BRI = Number(process.env.ALBEDO_BRIGHTNESS || 1);
  if (SAT !== 1 || BRI !== 1) {
    for (const tex of new Set(root.listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean))) {
      tex.setImage(await sharp(tex.getImage()).modulate({ saturation: SAT, brightness: BRI }).png().toBuffer());
      tex.setMimeType('image/png');
    }
    console.log(`albedo grade: saturation ${SAT}, brightness ${BRI}`);
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

// ---- occlusion: per-part isolated AO atlas → ORM R channel ----
// bake_ao.py bakes each part's ambient occlusion with the other parts hidden
// from rays: stitch-level crevice shading (the yarn look the shaded export
// had) comes back, while cross-part contact shadows (the black-hole source)
// never exist in the map. The AO goes into the R channel of the existing
// metallicRoughness textures (glTF ORM layout, R was unused) and is
// registered as occlusionTexture — zero extra texture memory, and three.js
// applies it to indirect light (IBL + ambient) automatically.
{
  const aoPath = process.env.AO_ATLAS || srcPath.replace(/[^/\\]+$/, 'ao.png');
  if (fs.existsSync(aoPath)) {
    for (const tex of new Set(root.listMaterials().map((m) => m.getMetallicRoughnessTexture()).filter(Boolean))) {
      const { data, info } = await sharp(tex.getImage())
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const ao = await sharp(aoPath).resize(info.width, info.height).greyscale().raw().toBuffer();
      for (let i = 0; i < ao.length; i++) data[i * 4] = ao[i];
      tex.setImage(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer());
      tex.setMimeType('image/png');
    }
    const occlusionStrength = Number(process.env.AO_OCCLUSION_STRENGTH || 0.7);
    for (const m of root.listMaterials()) {
      const mr = m.getMetallicRoughnessTexture();
      if (mr) m.setOcclusionTexture(mr);
      // the albedo below carries the same AO — at full aoMap strength the
      // crevices would be deducted twice and the whole doll turns murky
      m.setOcclusionStrength(occlusionStrength);
    }
    console.log('AO atlas merged into ORM R channel:', aoPath);

    // …and, warm-tinted, into the albedo. three's aoMap only dims indirect
    // light, so the key/rim lights still flatten the crevices; the shaded
    // export darkened everything. Multiply a gamma-softened occlusion into
    // baseColor so direct light reads it too — tinted toward warm brown so
    // shadows read as yarn bounce light, not gray soot. The multiply is done
    // in linear space (baseColor is sRGB): for a per-texel constant factor,
    // (linear·f)^(1/2.2) = encoded·f^(1/2.2), so a 256-entry LUT of encoded
    // multipliers per channel is exact.
    const AO_ALBEDO_GAMMA = Number(process.env.AO_ALBEDO_GAMMA || 0.5); // softens the AO curve (lower = lighter mids); 1 = raw
    const AO_ALBEDO_FLOOR = (process.env.AO_ALBEDO_FLOOR || '0.48,0.33,0.24').split(',').map(Number); // multiplier at full occlusion
    const lut = [0, 1, 2].map((c) => {
      const t = new Float32Array(256);
      for (let a = 0; a < 256; a++) {
        const f = AO_ALBEDO_FLOOR[c] + (1 - AO_ALBEDO_FLOOR[c]) * Math.pow(a / 255, AO_ALBEDO_GAMMA);
        t[a] = Math.pow(f, 1 / 2.2);
      }
      return t;
    });
    for (const tex of new Set(root.listMaterials().map((m) => m.getBaseColorTexture()).filter(Boolean))) {
      const { data, info } = await sharp(tex.getImage())
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const ao = await sharp(aoPath).resize(info.width, info.height).greyscale().raw().toBuffer();
      for (let i = 0; i < ao.length; i++) {
        const o = i * 4;
        data[o] = Math.round(data[o] * lut[0][ao[i]]);
        data[o + 1] = Math.round(data[o + 1] * lut[1][ao[i]]);
        data[o + 2] = Math.round(data[o + 2] * lut[2][ao[i]]);
      }
      tex.setImage(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer());
      tex.setMimeType('image/png');
    }
    console.log('warm-tinted AO multiplied into albedo (gamma ' + AO_ALBEDO_GAMMA + ')');
  } else {
    console.warn('NO AO ATLAS at ' + aoPath + ' — run bake_ao.py first; writing model without occlusion');
  }
}

// ---- baked-diffuse hybrid: shaded softness + live PBR highlights ----
// The Rodin shaded export IS the cute look — a soft studio-GI photograph
// baked into a texture — but it also baked the neighbors' contact shadows
// (the black-hole artifacts). The two AO atlases from bake_ao.py measure that
// pollution per texel: ratio = all-visible / isolated < 1 exactly where a
// NEIGHBOR part darkened the bake. Dividing the shaded texture by the ratio
// (in linear space) un-bakes the cross-part shadows and touches nothing else.
// Deep pits no bake light ever reached (the card slot) cannot be recovered by
// division — those texels get wave-filled from their clean neighborhood.
//
// The cleaned shaded texture ships as EMISSIVE: the dominant, unlit diffuse
// look, exactly as soft and bright as the shaded export. The real-time PBR
// layer stays on top at low weight — normal / metallicRoughness / sheen keep
// producing live eye + glasses glints and fuzzy rim light as the doll turns
// (baseColor is dimmed so real-time diffuse only adds gentle modeling).
// Eyes keep their full real-time PBR material untouched.
// OPT-IN experiment (BAKED_DIFFUSE=1): tried 2026-07 and set aside — the
// fully-lit real-time look was preferred over the baked softness in the end.
{
  const aoAllPath = process.env.AO_ATLAS_ALL || srcPath.replace(/[^/\\]+$/, 'ao_all.png');
  const aoIsoPath = process.env.AO_ATLAS || srcPath.replace(/[^/\\]+$/, 'ao.png');
  const shadedPath = srcPath.replace(/[^/\\]+$/, 'base_basic_shaded.glb');
  const enabled = process.env.BAKED_DIFFUSE === '1'
    && fs.existsSync(aoAllPath) && fs.existsSync(aoIsoPath) && fs.existsSync(shadedPath);
  if (enabled) {
    const EMISSIVE_F = 0.85;  // weight of the baked shaded layer
    const DIFFUSE_F = 0.2;    // weight of the real-time diffuse on top
    const MIN_RATIO = 0.25;   // caps the un-shadow boost at 1/0.25 = 4x
    const PIT_THRESH = 56;    // ao_all below this (of 255) = pit, wave-fill

    const shadedDoc = await io.read(shadedPath);
    const shadedMat = shadedDoc.getRoot().listMaterials()[0];
    const shadedTex = shadedMat.getBaseColorTexture() || shadedMat.getEmissiveTexture();
    const { data, info } = await sharp(shadedTex.getImage())
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const aoIso = await sharp(aoIsoPath).resize(W, H).greyscale().raw().toBuffer();
    const aoAll = await sharp(aoAllPath).resize(W, H).greyscale().raw().toBuffer();

    const hole = new Uint8Array(W * H);
    let unshadowed = 0;
    for (let i = 0; i < W * H; i++) {
      if (aoAll[i] < PIT_THRESH) { hole[i] = 1; continue; }
      const r = Math.min(1, Math.max(MIN_RATIO, aoAll[i] / Math.max(aoIso[i], 1)));
      if (r > 0.995) continue;
      // for a per-texel constant factor, linear ÷ratio == sRGB-encoded ×ratio^(-1/2.2)
      const mult = Math.pow(r, -1 / 2.2);
      const o = i * 4;
      data[o] = Math.min(255, data[o] * mult);
      data[o + 1] = Math.min(255, data[o + 1] * mult);
      data[o + 2] = Math.min(255, data[o + 2] * mult);
      unshadowed++;
    }
    const filled = waveFill(data, hole, W, H);
    console.log(`baked-diffuse: un-shadowed ${unshadowed}px, pit-filled ${filled}px`);

    const bakedTex = doc.createTexture('shaded_baked')
      .setImage(await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer())
      .setMimeType('image/png');
    for (const p of parts) {
      if (p.node.getName().startsWith('eye')) continue;
      const mat = p.prim.getMaterial();
      if (!mat) continue;
      mat.setEmissiveTexture(bakedTex);
      mat.setEmissiveFactor([EMISSIVE_F, EMISSIVE_F, EMISSIVE_F]);
      mat.setBaseColorFactor([DIFFUSE_F, DIFFUSE_F, DIFFUSE_F, 1]);
    }
  } else if (process.env.BAKED_DIFFUSE === '1') {
    console.warn('baked-diffuse hybrid requested but skipped — need ao.png + ao_all.png + base_basic_shaded.glb next to the input');
  }
}

// ---- trim as polished metal (TRIM_SILVER=1) ----
// The scanned albedo paints spud's wire glasses near-black, and the yarn
// treatment (sheen + AO multiply) buries them further. Real thin wire reads
// silver because it mirrors the environment, not because its surface is
// light — so drop every texture from the trim material and let a bare
// metallic BRDF + the scene IBL do the work.
if (process.env.TRIM_SILVER === '1') {
  // TRIM_SILVER_COLOR tints the metal (F0): bright chrome ~0.72, gunmetal ~0.25.
  // TRIM_SILVER_ROUGH softens the glints as it rises.
  const tint = (process.env.TRIM_SILVER_COLOR || '0.72,0.73,0.75').split(',').map(Number);
  const rough = Number(process.env.TRIM_SILVER_ROUGH || 0.35);
  for (const p of parts) {
    if (p.node.getName() !== 'trim') continue;
    const mat = p.prim.getMaterial();
    if (!mat) continue;
    mat.setBaseColorTexture(null);
    mat.setBaseColorFactor([...tint, 1]);
    mat.setMetallicRoughnessTexture(null);
    mat.setMetallicFactor(1);
    mat.setRoughnessFactor(rough);
    mat.setNormalTexture(null);
    mat.setOcclusionTexture(null);
    mat.setExtension('KHR_materials_sheen', null);
    console.log(`trim -> metal (tint ${tint.join(',')} / rough ${rough})`);
  }
}

// ---- textures + compression ----
// normal + metallicRoughness carry shading signal — compress gently
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], slots: /baseColor/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 90, slots: /normal|metallicRoughness|occlusion|emissive/ }),
  prune(),
  draco(),
);

await io.write(outPath, doc);
console.log('written:', outPath, (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB');
