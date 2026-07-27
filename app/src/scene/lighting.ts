import * as THREE from 'three';
import type { CharId } from '../types';

/* ──────────── warm studio environment for IBL ────────────
   Replaces three's RoomEnvironment (a neutral office box that reads cold and
   plasticky on yarn) with a photo-booth setup: a warm gradient dome, one big
   warm softbox as the key, a cooler side fill for color contrast in the knit,
   a back panel for rim sheen and a floor bounce. PMREM converts it into the
   scene environment; the per-part AO baked into the PBR models darkens exactly
   this indirect light inside the stitch crevices. */
export function makeStudioEnvScene(neutral = false): THREE.Scene {
  const scene = new THREE.Scene();

  // gradient dome — warm cream overhead falling to amber near the floor;
  // the neutral variant is a white-gray studio for yarn colors the warm
  // dome would tint (sprinkles' pink reads salmon under amber light)
  const dome = new THREE.SphereGeometry(16, 32, 24);
  const top = neutral ? new THREE.Color(0.37, 0.37, 0.39) : new THREE.Color(0.40, 0.34, 0.26);
  const bottom = neutral ? new THREE.Color(0.15, 0.15, 0.16) : new THREE.Color(0.15, 0.11, 0.08);
  const pos = dome.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.smoothstep(pos.getY(i) / 16, -1, 1);
    c.copy(bottom).lerp(top, t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  // unlit panels read as pure radiance in the PMREM capture
  const panel = (color: number, intensity: number, w: number, h: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) })
    );
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  if (neutral) {
    panel(0xffffff, 5.0, 7, 5, 4, 6, 5);    // key softbox — high right-front
    panel(0xf0f4fa, 1.2, 8, 6, -7, 2, 2);   // barely-cool fill — left side
    panel(0xffffff, 2.0, 6, 4, -2, 4, -7);  // back panel (rim sheen)
    panel(0xf3f3f5, 0.9, 10, 10, 0, -5, 0); // floor bounce
  } else {
    panel(0xfff1dc, 5.0, 7, 5, 4, 6, 5);    // key softbox — high right-front
    panel(0xdfe8f2, 1.1, 8, 6, -7, 2, 2);   // cool fill — left side
    panel(0xffd9a8, 2.2, 6, 4, -2, 4, -7);  // warm back panel (rim sheen)
    panel(0xffc98f, 0.9, 10, 10, 0, -5, 0); // floor bounce
  }
  return scene;
}

/* ──────────── per-character lighting ────────────
   One studio doesn't flatter every yarn color. LIGHT_BASE is the shared warm
   setup; LIGHT_TWEAKS overrides fields per character id — taco's face sits in
   the shadow of its own shell overhang and needs a stronger, more head-on key;
   sprinkles' pink frosting turns yellowish under the warm key, so its lights
   go neutral-white. Characters not listed use LIGHT_BASE as-is. */
export interface LightSpec {
  color: number;
  intensity: number;
  pos: [number, number, number];
}

export interface LightRig {
  exposure: number;
  envMap: 'warm' | 'neutral'; // which studio PMREM to use
  env: number;
  ambient: { color: number; intensity: number };
  key: LightSpec;
  rim: LightSpec;
}

export const LIGHT_BASE: LightRig = {
  exposure: 1.12,
  envMap: 'warm',
  env: 1.05,
  ambient: { color: 0xffedd0, intensity: 0.16 },
  key: { color: 0xffeccf, intensity: 1.05, pos: [2, 3, 5.5] },
  rim: { color: 0xffe8c8, intensity: 0.45, pos: [-3, 2, -2] },
};

export const LIGHT_TWEAKS: Partial<Record<CharId, Partial<LightRig>>> = {
  taco: {
    env: 1.15,
    ambient: { color: 0xffedd0, intensity: 0.24 },
    key: { color: 0xfff3e0, intensity: 1.3, pos: [1.2, 2.2, 6] },
  },
  // the reference doll is baby pink shot on white — everything warm must go,
  // including the environment, or the frosting drifts salmon
  donut: {
    exposure: 1.15,
    envMap: 'neutral',
    env: 1.0,
    ambient: { color: 0xffffff, intensity: 0.2 },
    key: { color: 0xffffff, intensity: 1.1, pos: [2, 3, 5.5] },
    rim: { color: 0xeef2ff, intensity: 0.4, pos: [-3, 2, -2] },
  },
  // pale pink petals go dusty mauve under amber light — same neutral-studio
  // treatment as the donut; the caramel pot keeps its warmth from the albedo
  bloom: {
    exposure: 1.15,
    envMap: 'neutral',
    env: 1.0,
    ambient: { color: 0xffffff, intensity: 0.2 },
    key: { color: 0xffffff, intensity: 1.15, pos: [2, 3, 5.5] },
    rim: { color: 0xeef2ff, intensity: 0.4, pos: [-3, 2, -2] },
  },
  // the reference is bright mustard gold — keep the warm studio but push
  // brightness, and bring the key head-on so the mane overhang can't dim the face
  mochi: {
    exposure: 1.16,
    env: 1.15,
    ambient: { color: 0xffedd0, intensity: 0.24 },
    key: { color: 0xfff6e2, intensity: 1.28, pos: [1.5, 2.5, 6] },
  },
  // oatmeal beige reads sallow under the warm dome — neutral studio, white light
  grad: {
    exposure: 1.14,
    envMap: 'neutral',
    env: 1.0,
    ambient: { color: 0xffffff, intensity: 0.2 },
    key: { color: 0xffffff, intensity: 1.1, pos: [2, 3, 5.5] },
    rim: { color: 0xeef2ff, intensity: 0.4, pos: [-3, 2, -2] },
  },
};

// contact shadow — scales & fades as the pet leaves the ground (Turn 5)
export function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  rg.addColorStop(0, 'rgba(70,48,22,0.42)');
  rg.addColorStop(0.55, 'rgba(70,48,22,0.20)');
  rg.addColorStop(1, 'rgba(70,48,22,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
