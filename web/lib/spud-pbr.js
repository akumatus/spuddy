/* lib/spud-pbr.js — PBR material override for the Spud model.
   The Rodin "shaded" export bakes lighting (incl. hard black shadows) into an
   emissive texture; this swaps Spud's meshes to a real MeshStandardMaterial
   (albedo + normal + metallic-roughness from assets/models/spud-pbr-*.webp)
   and gives the scene a warm studio environment so metals/gloss have
   something to reflect. Other characters keep their baked look. */

import * as THREE from './three.module.js';

let matPromise = null;

export function loadSpudPBRMaterial() {
  if (!matPromise) {
    matPromise = (async () => {
      const tl = new THREE.TextureLoader();
      const [map, normalMap, mrMap] = await Promise.all([
        tl.loadAsync('assets/models/spud-pbr-albedo.webp'),
        tl.loadAsync('assets/models/spud-pbr-normal.webp'),
        tl.loadAsync('assets/models/spud-pbr-mr.webp'),
      ]);
      map.colorSpace = THREE.SRGBColorSpace;
      for (const t of [map, normalMap, mrMap]) { t.flipY = false; t.needsUpdate = true; }
      return new THREE.MeshStandardMaterial({
        map,
        normalMap,
        roughnessMap: mrMap,
        metalnessMap: mrMap,
        roughness: 1,
        metalness: 1,
        side: THREE.DoubleSide,
      });
    })();
  }
  return matPromise;
}

/* Swap every mesh under root to the shared PBR material. */
export async function applySpudPBR(root) {
  const mat = await loadSpudPBRMaterial();
  root.traverse((o) => { if (o.isMesh) o.material = mat; });
  return root;
}

/* Warm cream studio env — gradient dome + two bright softbox panels,
   PMREM'd so MeshStandardMaterial gets diffuse fill + speculars. */
export function applyEnvironment(renderer, scene) {
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const colTop = new THREE.Color(0xfff8ea), colBot = new THREE.Color(0xd6c2a0);
  const pos = geo.attributes.position, cols = [];
  for (let i = 0; i < pos.count; i++) {
    const k = (pos.getY(i) / 10 + 1) / 2;
    const c = colBot.clone().lerp(colTop, k);
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const panel = (w, h, x, y, z, hex, mul) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(mul) });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    p.position.set(x, y, z);
    p.lookAt(0, 0, 0);
    env.add(p);
  };
  panel(4, 4, 3, 4, 4, 0xffffff, 1.35);
  panel(3, 5, -4, 2, -2, 0xffe8c8, 1.0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();
}
