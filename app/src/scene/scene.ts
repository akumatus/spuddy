import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Animator } from './motions';
import { CardScreen, type CardPlacement } from './cardscreen';
import { rigParts } from './rig';
import { LIGHT_BASE, LIGHT_TWEAKS, makeShadowTexture, makeStudioEnvScene, type LightRig } from './lighting';
import type { CharId, PetSize } from '../types';

// BVH-accelerated raycasting: the scan models run 125k–332k triangles and a
// naive cast costs ~10ms — pick() now fires on hover (interactions.ts hit
// region), not just on click, so that would hitch the render loop. With a
// per-geometry BVH a cast is well under 0.1ms. Meshes without a boundsTree
// (e.g. the legacy card quad) silently fall back to the stock raycast.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./draco/');
loader.setDRACOLoader(draco);
// warm the decoder now: the wasm fetch + compile otherwise only starts on the
// first decode, serializing it behind the GLB fetch on the startup path
draco.preload();

const cache = new Map<string, THREE.Group>();

// BVH builds run off the startup path: the largest scans (332k tris) cost high
// hundreds of ms on the main thread, which used to land inside the first
// setCharacter and hold up boot. Until a mesh's tree exists, raycasts fall
// back to the stock three.js path (~10ms per cast — fine for the few
// throttled hover casts that can happen in that window).
const bvhQueue: THREE.Mesh[] = [];
let bvhPumping = false;

function pumpBvhQueue(): void {
  const mesh = bvhQueue.shift();
  // clones share geometry with the cached original, so each model id pays
  // the build once and every clone reuses the tree
  if (mesh && !mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
  bvhPumping = bvhQueue.length > 0;
  if (bvhPumping) scheduleBvhPump();
}

function scheduleBvhPump(): void {
  // one mesh per idle slice keeps multi-mesh models from stacking their
  // builds into a single long frame stall
  if ('requestIdleCallback' in window) requestIdleCallback(() => pumpBvhQueue(), { timeout: 2000 });
  else setTimeout(pumpBvhQueue, 200);
}

function queueBvhBuild(meshes: THREE.Mesh[]): void {
  bvhQueue.push(...meshes);
  if (!bvhPumping && bvhQueue.length) {
    bvhPumping = true;
    scheduleBvhPump();
  }
}

// Only the card's center answers as functional UI (the gacha draw). Taps near
// the rim — bare paper with no text, the part the hands grip — read as body
// pokes instead, so you can still play with him around the edges of the card.
// UV half-extent from center (0.5, 0.5); 0.3 ⇒ a central 60%×60% draw zone.
const CARD_DRAW_ZONE = 0.3;

// User-facing "pet size" setting → world-space scale on the normalized model.
// Applied to the holder group (the animator drives rootGroup, so this rides on
// top of the squash rather than fighting it) with the contact shadow tracking
// it in _tick. The pet's feet stay planted at y=0 and it grows upward inside
// the fixed canvas, so the range stays modest — 'lg' must not push the head up
// into the speech bubble (see TARGET_H note in setCharacter).
export const PET_SIZE_SCALE: Record<PetSize, number> = { sm: 0.82, md: 1, lg: 1.2 };

// what the pointer landed on — see PetScene.pick
export type PickTarget = 'card' | 'body' | null;

async function loadModel(id: string): Promise<THREE.Group> {
  const cached = cache.get(id);
  if (cached) return cached.clone(true);
  const gltf = await loader.loadAsync(`./models/${id}.glb`);
  const scene = gltf.scene;
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const mesh = o as THREE.Mesh;
      meshes.push(mesh);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // legacy single-mesh scans are a baked emissive texture (black base
      // color, lights don't touch them) — skip tone mapping so they keep the
      // exact pre-PBR look
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.emissiveMap && !mat.map) mat.toneMapped = false;
    }
  });
  queueBvhBuild(meshes);
  cache.set(id, scene);
  return scene.clone(true);
}

export class PetScene {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  camBase: THREE.Vector3;
  lookAt: THREE.Vector3;
  cameraSway: boolean;
  envMaps: Record<'warm' | 'neutral', THREE.Texture>;
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  holder: THREE.Group;
  rootGroup: THREE.Group;
  animator: Animator;
  cardScreen: CardScreen;
  cardsData: Promise<Record<string, CardPlacement | undefined>>;
  t0: number;
  private _charGen = 0;
  private _raycaster?: THREE.Raycaster;
  private _ndc?: THREE.Vector2;
  // user "pet size" as a world-space scale (see PET_SIZE_SCALE); lives on the
  // holder so it composes with the animator's squash, which drives rootGroup
  sizeScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    // high-key: the reference dolls are shot bright product-photo style — keep
    // exposure above neutral so saturated yarn stays sunny (per-char value
    // applied in applyLighting)
    this.renderer.toneMappingExposure = LIGHT_BASE.exposure;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    // pulled back + aimed a touch lower than the head so he reads smaller (more
    // "little pet") and his contact shadow keeps footroom inside the canvas
    this.camBase = new THREE.Vector3(0, 1.62, 7.4);
    this.lookAt = new THREE.Vector3(0, 1.16, 0);
    this.cameraSway = true; // camera breathing sway, 11s/8.2s dual cycle (Turn 5)

    // The PBR part-rigged model gets its texture from real-time lighting: the
    // warm studio IBL provides most of the fill (so the baked aoMap, which only
    // darkens indirect light, actually reads), a warm key light shapes it, rim
    // light traces the outline. The legacy baked model is unaffected by lighting.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMaps = {
      warm: pmrem.fromScene(makeStudioEnvScene(), 0.04).texture,
      neutral: pmrem.fromScene(makeStudioEnvScene(true), 0.04).texture,
    };
    this.scene.environment = this.envMaps[LIGHT_BASE.envMap];
    this.scene.environmentIntensity = LIGHT_BASE.env;
    pmrem.dispose();

    this.ambient = new THREE.AmbientLight(LIGHT_BASE.ambient.color, LIGHT_BASE.ambient.intensity);
    this.scene.add(this.ambient);
    // key sits low and frontal, softbox-style: the face must never fall into
    // its own shadow side (the plush dolls read cute because they're lit flat)
    this.key = new THREE.DirectionalLight(LIGHT_BASE.key.color, LIGHT_BASE.key.intensity);
    this.key.position.set(...LIGHT_BASE.key.pos);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(LIGHT_BASE.rim.color, LIGHT_BASE.rim.intensity);
    this.rim.position.set(...LIGHT_BASE.rim.pos);
    this.scene.add(this.rim);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.1, 2.1),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.005;
    this.scene.add(this.shadow);

    this.holder = new THREE.Group(); // scaled/positioned per model
    this.rootGroup = new THREE.Group(); // animated by Animator, origin at contact point
    this.rootGroup.add(this.holder);
    this.scene.add(this.rootGroup);

    // exists from construction (not first model load) so boot can wire the
    // brain and interactions without waiting on the GLB — clips played on the
    // empty holder are simply invisible
    this.animator = new Animator(this.rootGroup, 2);
    this.cardScreen = new CardScreen();
    this.cardsData = fetch('./models/cards.json').then((r) => r.json()).catch(() => ({}));
    this.t0 = performance.now();
    this.resize();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async setCharacter(id: CharId): Promise<void> {
    // Switch generation guard: two in-flight switches (startup load + the
    // book picker, or two quick picker taps) can resolve out of order —
    // whichever finishes LAST would win the holder, not whichever was asked
    // for last. Stale loads must drop their result.
    const gen = (this._charGen = this._charGen + 1);
    const model = await loadModel(id);
    const cardData = (await this.cardsData)[id];
    if (gen !== this._charGen) return;
    this.holder.clear();

    // Normalize by TOTAL model height (cap / tassel / any headwear included) so
    // every buddy is the same overall size and no one's head reaches up into the
    // speech bubble. The bubble sits at a fixed spot, so a consistent model top
    // keeps a clean, even gap under it — TARGET_H is tuned against that bubble.
    // (Card-width normalization let Prof's graduation cap tower past the crew.)
    const TARGET_H = 1.5;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = TARGET_H / size.y;
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box2.min.y;

    this.holder.add(model);
    this.applyLighting(id);
    this.cardScreen.attach(model, cardData);
    const rig = rigParts(model, this.scene);
    this.animator.attachRig(rig);
    this.cardScreen.rigDriven = !!(rig && rig.card);
  }

  // Apply the user's pet-size setting. Scaling the holder leaves the animator
  // (which drives rootGroup) untouched, so the squash still composes on top;
  // holder.scale survives setCharacter's holder.clear(), so a buddy switch keeps
  // the chosen size. The contact shadow reads sizeScale in _tick to match.
  // Publish the factor as the --pet-scale CSS var so the DOM overlays (speech
  // bubble, thought bubble, hover chat panel) scale their gap-from-the-pet with
  // him instead of drifting — see style.css. Feet stay planted, so only the
  // above-the-base offsets scale, never the base anchor.
  setPetSize(size: PetSize): void {
    this.sizeScale = PET_SIZE_SCALE[size] ?? 1;
    this.holder.scale.setScalar(this.sizeScale);
    document.documentElement.style.setProperty('--pet-scale', String(this.sizeScale));
  }

  // merge LIGHT_BASE with the character's LIGHT_TWEAKS entry and apply
  applyLighting(id: CharId): void {
    const L: LightRig = { ...LIGHT_BASE, ...(LIGHT_TWEAKS[id] || {}) };
    this.renderer.toneMappingExposure = L.exposure;
    this.scene.environment = this.envMaps[L.envMap];
    this.scene.environmentIntensity = L.env;
    this.ambient.color.set(L.ambient.color);
    this.ambient.intensity = L.ambient.intensity;
    for (const [light, cfg] of [[this.key, L.key], [this.rim, L.rim]] as const) {
      light.color.set(cfg.color);
      light.intensity = cfg.intensity;
      light.position.set(...cfg.pos);
    }
  }

  hasRig(): boolean {
    return !!this.animator.rig;
  }

  setCardContent(content: Parameters<CardScreen['setContent']>[0]): void {
    this.cardScreen.setContent(content);
  }

  setCardPulse(v: boolean): void {
    this.cardScreen.setPulse(v);
  }

  setCardThinking(v: boolean): void {
    this.cardScreen.setThinking(v);
  }

  // what the pointer landed on: 'card' (the held white card — but only its
  // center; the rim reads as body, see CARD_DRAW_ZONE), 'body', or null (air).
  // Closest hit wins, so a card tucked behind a paw still counts as body.
  pick(clientX: number, clientY: number): PickTarget {
    const r = this.canvas.getBoundingClientRect();
    if (!this._raycaster || !this._ndc) {
      this._raycaster = new THREE.Raycaster();
      this._raycaster.firstHitOnly = true; // BVH fast path — we only read hits[0]
      this._ndc = new THREE.Vector2();
    }
    this._ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this._raycaster.intersectObject(this.holder, true);
    if (!hits.length) return null;
    const hit = hits[0];
    const cardObj = this.cardScreen.cardMesh || this.cardScreen.mesh;
    if (!cardObj || hit.object !== cardObj) return 'body';
    // Card UVs run 0..1 with (0.5, 0.5) at center (projected on part models,
    // native on the legacy quad). Only the central patch triggers a draw;
    // rim taps fall through to body play. If UVs are somehow missing, keep the
    // old whole-card behavior rather than breaking the draw entirely.
    const uv = hit.uv;
    if (!uv) return 'card';
    const onCenter =
      Math.abs(uv.x - 0.5) <= CARD_DRAW_ZONE && Math.abs(uv.y - 0.5) <= CARD_DRAW_ZONE;
    return onCenter ? 'card' : 'body';
  }

  // 05 · Card Raise — part models hand it to the rig ('present' clip drives
  // card + paws + body); legacy scans slide the text quad + root-only 'raise'
  raiseCard(): void {
    if (this.cardScreen.rigDriven) {
      this.animator.play('present');
    } else {
      this.animator.play('raise');
      this.cardScreen.raise();
    }
  }

  _tick(): void {
    const t = (performance.now() - this.t0) / 1000;
    this.animator.update();
    const o = this.animator.out;
    const spread = 1 + (o.y / 2) * 0.55;
    this.shadow.scale.set(o.sx * spread * this.sizeScale, spread * this.sizeScale, 1);
    this.shadow.material.opacity = o.ground;
    if (this.cameraSway) {
      this.camera.position.set(
        this.camBase.x + 0.12 * Math.sin((2 * Math.PI * t) / 11),
        this.camBase.y + 0.05 * Math.sin((2 * Math.PI * t) / 8.2),
        this.camBase.z
      );
    } else {
      this.camera.position.copy(this.camBase);
    }
    this.camera.lookAt(this.lookAt);
    this.cardScreen.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}
