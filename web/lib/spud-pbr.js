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

/* Warm studio env — mirrors the desktop client's photo booth
   (app/src/scene/lighting.ts makeStudioEnvScene + LIGHT_BASE) so the website
   potato reads identically: gradient dome, warm softbox key, cooler side
   fill, warm back panel for rim sheen and a floor bounce, PMREM'd into the
   scene environment. */
export function applyEnvironment(renderer, scene) {
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(16, 32, 24);
  const colTop = new THREE.Color(0.40, 0.34, 0.26), colBot = new THREE.Color(0.15, 0.11, 0.08);
  const pos = geo.attributes.position, cols = [];
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.smoothstep(pos.getY(i) / 16, -1, 1);
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
  panel(7, 5, 4, 6, 5, 0xfff1dc, 5.0);    // key softbox — high right-front
  panel(8, 6, -7, 2, 2, 0xdfe8f2, 1.1);   // cool fill — left side
  panel(6, 4, -2, 4, -7, 0xffd9a8, 2.2);  // warm back panel (rim sheen)
  panel(10, 10, 0, -5, 0, 0xffc98f, 0.9); // floor bounce
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.environmentIntensity = 1.05;
  pmrem.dispose();
}
