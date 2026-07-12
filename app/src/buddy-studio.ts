// Buddy portrait studio — dev-only page (buddy-studio.html), sibling of
// icon-studio.html. Drives the real PetScene for a single frame per buddy:
// transparent background, each buddy's own lighting rig, and the held card
// showing its resting face ("· ♥ ·" / "tap me :)" — the same thing the card
// says in-app before the day's draw). Each frame is cropped to its alpha
// bounding box and POSTed to the dev-server middleware (vite.config.ts),
// which writes public/chars/char-<id>.png — the portraits the Buddies panel,
// unlock popups and card-book avatar all read.
import { CHARS } from './content';
import { PetScene } from './scene/scene';
import type { CharId } from './types';

const SIZE = 768;
// icon-studio's proven square framing (design 1b), reused verbatim
const CAM: [number, number, number] = [0, 1.56, 6.2];
const LOOK: [number, number, number] = [0, 1.04, 0];
const FOV = 25.5;
const PAD = 0.03; // breathing room around the alpha bbox, fraction of its size

const status = (m: string) => (document.getElementById('status')!.textContent = m);

async function main(): Promise<void> {
  const gl = document.createElement('canvas');
  gl.width = gl.height = SIZE;

  // PetScene starts its own rAF loop in the constructor; swallow that one
  // registration so we can render single frames manually instead
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;
  const scene = new PetScene(gl);
  window.requestAnimationFrame = raf;

  scene.renderer.setPixelRatio(1);
  scene.renderer.setSize(SIZE, SIZE, false);
  scene.camera.aspect = 1;
  scene.camera.fov = FOV;
  scene.camera.updateProjectionMatrix();
  scene.camera.position.set(...CAM);
  scene.camera.lookAt(...LOOK);
  // portraits are cutouts — the panels they sit in supply the ground
  scene.shadow.visible = false;
  // the app normalizes buddies to 1.5 for speech-bubble headroom the studio
  // doesn't have — fill the square frame like the icon's 2.0 instead
  scene.holder.scale.multiplyScalar(2 / 1.5);

  // the card text must not rasterize with fallback fonts
  await Promise.all([
    document.fonts.load('700 48px Caveat'),
    document.fonts.load('800 24px Nunito'),
  ]);

  for (const ch of CHARS) {
    status(`rendering ${ch.name}…`);
    await renderOne(scene, gl, ch.id, ch.name);
  }
  status('saved all portraits to public/chars/ — review them below');
}

async function renderOne(scene: PetScene, gl: HTMLCanvasElement, id: CharId, name: string): Promise<void> {
  await scene.setCharacter(id);
  scene.cardScreen.redraw(); // attach() may have first painted before the fonts resolved
  scene.renderer.render(scene.scene, scene.camera);
  const portrait = cropAlpha(gl);

  const blob = await new Promise<Blob | null>((r) => portrait.toBlob(r, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  const res = await fetch(`/__char-save?id=${id}`, { method: 'POST', body: blob });
  if (!res.ok) throw new Error(`save ${id} failed: ${res.status}`);

  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(portrait);
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = `${name} · ${portrait.width}×${portrait.height}`;
  cell.appendChild(nm);
  document.getElementById('grid')!.appendChild(cell);
}

// tight-crop the transparent frame the way the shipped portraits are cropped,
// so `.pic`'s contain-fit sizes every buddy consistently
function cropAlpha(gl: HTMLCanvasElement): HTMLCanvasElement {
  const w = gl.width;
  const h = gl.height;
  const flat = document.createElement('canvas');
  flat.width = w;
  flat.height = h;
  const fctx = flat.getContext('2d')!;
  fctx.drawImage(gl, 0, 0); // must happen in the same task as the GL render
  const a = fctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('empty render');
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * PAD);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(flat, -minX, -minY);
  return out;
}

main().catch((e) => {
  console.error('buddy studio failed', e);
  status('failed: ' + (e instanceof Error ? e.message : String(e)));
});
