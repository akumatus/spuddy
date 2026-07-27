// Drop stray mini-meshes from a processed buddy GLB.
//
// Rodin sometimes splits tiny disconnected chunks off the scan (here: two small
// flakes near Mochi's paws that float beside the card). process_rodin_pbr.mjs
// names every non body/card/hand/eye part 'trim' and rides it on the body, so
// these strays survive as floating debris. This removes 'trim' nodes whose
// bounding box is smaller than THRESH in every axis — that catches the flakes
// while sparing real trims (Mochi's buns, a taco shell, a grad cap), which are
// always large. Everything else is untouched.
//
// Usage: node drop_stray_bits.mjs <in.glb> <out.glb>
//   THRESH (default 0.6)  a trim whose largest bbox dimension is under this is a stray
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';

const [IN, OUT] = process.argv.slice(2);
const THRESH = Number(process.env.THRESH || 0.6);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(IN);
const root = doc.getRoot();

const bboxSize = (mesh) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; } }
  }
  return { size: [0, 1, 2].map((k) => max[k] - min[k]), centre: [0, 1, 2].map((k) => (min[k] + max[k]) / 2) };
};

const drop = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const { size, centre } = bboxSize(mesh);
  const maxDim = Math.max(...size);
  const name = node.getName();
  const stray = name === 'trim' && maxDim < THRESH;
  console.log(`${stray ? 'DROP' : 'keep'}  ${name.padEnd(6)} maxDim=${maxDim.toFixed(3)} centre=[${centre.map((x) => x.toFixed(2))}]`);
  if (stray) drop.push(node);
}
if (!drop.length) { console.log('no strays found — nothing to drop'); process.exit(0); }
for (const node of drop) { const m = node.getMesh(); node.dispose(); if (m) m.dispose(); }
console.log(`dropped ${drop.length} stray mesh(es)`);

await doc.transform(prune(), draco());
await io.write(OUT, doc);
console.log('written:', OUT, (fs.statSync(OUT).size / 1024 | 0), 'KB');
