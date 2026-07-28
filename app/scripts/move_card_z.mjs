// Push a buddy's card mesh forward along its plane normal (fixes belly poking
// through the card). Geometry-level, rm-first write + readback.
// Usage: node move_card_z.mjs <id> <dz>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';

const R = '/Users/wuyue/Documents/Startup/spuddy';
const [ID, DZ_S] = process.argv.slice(2);
const DZ = Number(DZ_S);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const nrm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const cards = JSON.parse(fs.readFileSync(`${R}/app/public/models/cards.json`));
const N = nrm(cards[ID].normal);
const out = `${R}/app/public/models/${ID}.glb`;

const doc = await io.read(out);
const card = doc.getRoot().listNodes().find(n => n.getName() === 'card');
const pos = card.getMesh().listPrimitives()[0].getAttribute('POSITION');
const v = [0, 0, 0];
for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); v[0] += N[0]*DZ; v[1] += N[1]*DZ; v[2] += N[2]*DZ; pos.setElement(i, v); }
await doc.transform(draco());
fs.rmSync(out, { force: true });
await io.write(out, doc);

// readback: card front bulge along normal
const chk = await io.read(out);
const cp = chk.getRoot().listNodes().find(n => n.getName() === 'card').getMesh().listPrimitives()[0].getAttribute('POSITION');
const C = cards[ID].center; let cMax = -1e9;
for (let i = 0; i < cp.getCount(); i++) { cp.getElement(i, v); const d = [v[0]-C[0], v[1]-C[1], v[2]-C[2]]; const c = d[0]*N[0]+d[1]*N[1]+d[2]*N[2]; if (c > cMax) cMax = c; }
console.log(`${ID}: pushed card +${DZ} along normal, front bulge now ${cMax.toFixed(3)}, bytes=${fs.statSync(out).size}`);
