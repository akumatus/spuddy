import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Animator } from './motions.js';
import { CardScreen } from './cardscreen.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./draco/');
loader.setDRACOLoader(draco);

const cache = new Map();

// Only the card's center answers as functional UI (the gacha draw). Taps near
// the rim — bare paper with no text, the part the hands grip — read as body
// pokes instead, so you can still play with him around the edges of the card.
// UV half-extent from center (0.5, 0.5); 0.3 ⇒ a central 60%×60% draw zone.
const CARD_DRAW_ZONE = 0.3;

async function loadModel(id) {
  if (cache.has(id)) return cache.get(id).clone(true);
  const gltf = await loader.loadAsync(`./models/${id}.glb`);
  const scene = gltf.scene;
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      // legacy single-mesh scans are a baked emissive texture (black base
      // color, lights don't touch them) — skip tone mapping so they keep the
      // exact pre-PBR look
      if (o.material && o.material.emissiveMap && !o.material.map) o.material.toneMapped = false;
    }
  });
  cache.set(id, scene);
  return scene.clone(true);
}

/* ──────────── part rigging: pivot groups from named nodes ────────────
   Ported from the design prototype's lib/spud-scene2.js — hands hinge at
   the shoulder, eyes at their own center, card at its bottom edge. Models
   without named parts (legacy single-mesh scans) return null. */
function rigParts(model, sceneRoot) {
  sceneRoot.updateMatrixWorld(true);
  const names = ['body', 'card', 'handL', 'handR', 'eyeL', 'eyeR'];
  const nodes = {}, box = {}, ctr = {}, size = {};
  let found = 0;
  for (const n of names) {
    const node = model.getObjectByName(n);
    if (!node) continue;
    nodes[n] = node; found++;
    box[n] = new THREE.Box3().setFromObject(node);
    ctr[n] = box[n].getCenter(new THREE.Vector3());
    size[n] = box[n].getSize(new THREE.Vector3());
  }
  if (found < 4 || !nodes.card) return null;

  const wrap = (part, worldPivot) => {
    const parent = part.parent;
    const lp = parent.worldToLocal(worldPivot.clone());
    const g = new THREE.Group();
    g.position.copy(lp);
    const keep = part.position.clone();
    parent.add(g);
    g.add(part);
    part.position.copy(keep.sub(lp));
    const ps = new THREE.Vector3();
    parent.getWorldScale(ps);
    return { g, home: g.position.clone(), unit: 1 / ps.x };
  };

  const rig = {};
  for (const side of ['L', 'R']) {
    const hn = 'hand' + side, en = 'eye' + side;
    if (nodes[hn]) {
      const b = box[hn], c = ctr[hn];
      const sign = c.x >= 0 ? 1 : -1;
      // Rodin paws point FORWARD (z-extent ≈ 2× width) to hold the card, so a
      // 'raise' spin around Z is nearly parallel to the arm — it reads as the
      // palm twisting on the spot. Forward paws instead hinge around X at the
      // arm root (top-back edge, inside the body): the paw sweeps up and the
      // palm turns to face the camera. Side-mounted paws (wider than deep)
      // keep the original Z hinge at the top-inner corner.
      const forward = size[hn].z > size[hn].x;
      const pivot = forward
        ? new THREE.Vector3(c.x, b.max.y - size[hn].y * 0.12, b.min.z + size[hn].z * 0.06)
        : new THREE.Vector3(sign > 0 ? b.min.x : b.max.x, b.max.y - size[hn].y * 0.12, c.z);
      const r = wrap(nodes[hn], pivot);
      r.sign = sign;
      r.liftAxis = forward ? 'x' : 'z';
      r.shyVec = new THREE.Vector3(0, 0, 0);
      if (nodes[en]) {
        r.shyVec.set(
          ctr[en].x - c.x,
          ctr[en].y - c.y - size[en].y * 0.1,
          ctr[en].z - c.z + size[en].z / 2 + size[hn].z / 2 + 0.015
        );
      }
      rig[hn] = r;
    }
    if (nodes[en]) {
      const r = wrap(nodes[en], ctr[en].clone());
      r.w = size[en].x;
      rig[en] = r;
    }
  }
  if (nodes.card) {
    const b = box.card, c = ctr.card;
    rig.card = wrap(nodes.card, new THREE.Vector3(c.x, b.min.y, c.z));
  }
  return rig;
}

// contact shadow — scales & fades as the pet leaves the ground (Turn 5)
function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  rg.addColorStop(0, 'rgba(70,48,22,0.42)');
  rg.addColorStop(0.55, 'rgba(70,48,22,0.20)');
  rg.addColorStop(1, 'rgba(70,48,22,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class PetScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    // pulled back + aimed a touch lower than the head so he reads smaller (more
    // "little pet") and his contact shadow keeps footroom inside the canvas
    this.camBase = new THREE.Vector3(0, 1.62, 7.4);
    this.lookAt = new THREE.Vector3(0, 1.16, 0);
    this.cameraSway = true; // camera breathing sway, 11s/8.2s dual cycle (Turn 5)

    // The PBR part-rigged model gets its texture from real-time lighting: IBL
    // provides soft omnidirectional fill, a warm key light shapes it, rim light
    // traces the outline. The legacy baked model is unaffected by lighting.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.scene.add(new THREE.AmbientLight(0xffedd0, 0.22));
    const key = new THREE.DirectionalLight(0xffeccf, 1.35);
    key.position.set(2, 4, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe8c8, 0.5);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);

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

    this.animator = null;
    this.cardScreen = new CardScreen();
    this.cardsData = fetch('./models/cards.json').then((r) => r.json()).catch(() => ({}));
    this.t0 = performance.now();
    this.resize();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async setCharacter(id) {
    const model = await loadModel(id);
    const cardData = (await this.cardsData)[id];
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
    this.cardScreen.attach(model, cardData);
    if (!this.animator) this.animator = new Animator(this.rootGroup, 2);
    const rig = rigParts(model, this.scene);
    this.animator.attachRig(rig);
    this.cardScreen.rigDriven = !!(rig && rig.card);
  }

  hasRig() {
    return !!(this.animator && this.animator.rig);
  }

  setCardContent(content) {
    this.cardScreen.setContent(content);
  }

  setCardPulse(v) {
    this.cardScreen.setPulse(v);
  }

  // what the pointer landed on: 'card' (the held white card — but only its
  // center; the rim reads as body, see CARD_DRAW_ZONE), 'body', or null (air).
  // Closest hit wins, so a card tucked behind a paw still counts as body.
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!this._raycaster) {
      this._raycaster = new THREE.Raycaster();
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
  raiseCard() {
    if (this.cardScreen.rigDriven) {
      this.animator.play('present');
    } else {
      this.animator.play('raise');
      this.cardScreen.raise();
    }
  }

  _tick() {
    const t = (performance.now() - this.t0) / 1000;
    if (this.animator) {
      this.animator.update();
      const o = this.animator.out;
      const spread = 1 + (o.y / 2) * 0.55;
      this.shadow.scale.set(o.sx * spread, spread, 1);
      this.shadow.material.opacity = o.ground;
    }
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
