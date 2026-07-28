// Nudge a buddy's hand meshes forward along +Z (toward camera) to fix an
// arm that clips into the body/card. Geometry-level so the animator (which
// drives the shoulder pivots) can't override it.
// Usage: node move_hands_z.mjs <in.glb> <out.glb>   (HAND_Z=0.05)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const [IN, OUT] = process.argv.slice(2);
const DZ = Number(process.env.HAND_Z || 0.05);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(IN);
let moved = 0;
for (const node of doc.getRoot().listNodes()) {
  const nm = node.getName();
  if (nm !== 'handL' && nm !== 'handR') continue;
  const pos = node.getMesh().listPrimitives()[0].getAttribute('POSITION');
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); v[2] += DZ; pos.setElement(i, v); }
  moved++;
  console.log(`${nm}: ${pos.getCount()} verts +${DZ}z`);
}
if (moved !== 2) console.warn(`expected 2 hands, moved ${moved}`);
await doc.transform(draco());
await io.write(OUT, doc);
console.log('written', OUT);
