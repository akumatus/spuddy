import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Animator } from './motions.js';
import { CardScreen } from './cardscreen.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./draco/');
loader.setDRACOLoader(draco);

const cache = new Map();

async function loadModel(id) {
  if (cache.has(id)) return cache.get(id).clone(true);
  const gltf = await loader.loadAsync(`./models/${id}.glb`);
  const scene = gltf.scene;
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
    }
  });
  cache.set(id, scene);
  return scene.clone(true);
}

export class PetScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 1.55, 5.6);
    this.camera.lookAt(0, 1.3, 0);

    this.scene.add(new THREE.AmbientLight(0xfff4e0, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe8c8, 0.5);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);

    this.holder = new THREE.Group(); // scaled/positioned per model
    this.rootGroup = new THREE.Group(); // animated by Animator, origin at contact point
    this.rootGroup.add(this.holder);
    this.scene.add(this.rootGroup);

    this.animator = null;
    this.cardScreen = new CardScreen();
    this.cardsData = fetch('./models/cards.json').then((r) => r.json()).catch(() => ({}));
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

    // normalize by CARD width, not body height — the little cards are the same
    // physical product across the crew, so equal cards read as one family while
    // body sizes stay naturally varied. Clamp so unusual scans still fit the frame.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    let scale = 2 / size.y;
    if (cardData) {
      scale = 0.93 / cardData.width;
      scale = Math.min(scale, 2.55 / size.y);
      scale = Math.max(scale, 1.4 / size.y);
    }
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box2.min.y;

    this.holder.add(model);
    this.cardScreen.attach(model, cardData);
    if (!this.animator) this.animator = new Animator(this.rootGroup, 2);
  }

  setCardContent(content) {
    this.cardScreen.setContent(content);
  }

  setCardPulse(v) {
    this.cardScreen.setPulse(v);
  }

  raiseCard() {
    this.cardScreen.raise();
  }

  _tick() {
    if (this.animator) this.animator.update();
    this.cardScreen.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}
