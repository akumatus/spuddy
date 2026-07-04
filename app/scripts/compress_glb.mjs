// Compress a GLB for lightweight web/design reference:
//   weld → mesh simplify → square WebP textures → prune → Draco geometry.
// Unlike process_rodin_pbr.mjs this does NO part separation or card-plane
// extraction — it just shrinks the file while preserving the original look
// (e.g. the clean PBR albedo bake). Defaults match the app pipeline's
// compression exactly.
//
// Deps are in devDependencies (npm install covers them).
// Usage:
//   node compress_glb.mjs <in.glb> <out.glb>
//   SIMPLIFY_RATIO=0.065  — target fraction of triangles kept (default 0.065, = app)
//   SIMPLIFY_ERROR=0.001  — meshopt error bound; raise for smaller files
//   TEXTURE_SIZE=1024     — resize every texture to this square
//   DRACO=1               — Draco-compress geometry (set 0 for tools without a Draco decoder)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, textureCompress, prune, draco } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error('usage: node compress_glb.mjs <in.glb> <out.glb>');
  process.exit(1);
}
const ratio = Number(process.env.SIMPLIFY_RATIO ?? 0.065);
const error = Number(process.env.SIMPLIFY_ERROR ?? 0.001);
const texSize = Number(process.env.TEXTURE_SIZE ?? 1024);
const useDraco = process.env.DRACO !== '0';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(srcPath);
const root = doc.getRoot();

const tris = () => {
  let t = 0;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      t += idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
    }
  return Math.round(t);
};

console.log(`in : ${srcPath} (${(fs.statSync(srcPath).size / 1024 / 1024).toFixed(1)}MB, ${tris()} tris)`);

const steps = [
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize] }),
  prune(),
];
if (useDraco) steps.push(draco());
await doc.transform(...steps);

await io.write(outPath, doc);
console.log(`out: ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)}MB, ${tris()} tris, ` +
  `ratio ${ratio}, tex ${texSize}, draco ${useDraco ? 'on' : 'off'})`);
