// The encouragement text renders on a CanvasTexture, applied one of two ways:
// - part-separated models (a mesh named "card"): planar-project UVs onto the
//   card mesh and swap its material — text sits on the actual yarn card, so
//   the hands grip it from the front like the physical product;
// - legacy single-mesh scans: a clean quad placed over the scanned card
//   (per-character transform from scripts/detect_cards.py → cards.json).
// Golden weave pulses the emissive (design 08: card emissive pulse · 1.6s);
// card raise per design 05.
import * as THREE from 'three';

const COVER = 1.05; // fully hide the scanned card (its color/edges vary per scan)
const CONTENT_ASPECT = 1.5; // fixed layout box — identical typography on every buddy
const D2R = Math.PI / 180;

// per-character card placement from scripts/detect_cards.py → cards.json
export interface CardPlacement {
  center: [number, number, number];
  normal: [number, number, number];
  up: [number, number, number];
  width: number;
  height: number;
  offset?: number;
}

export interface CardContent {
  top?: string;
  gold?: boolean;
  main?: string;
  footL?: string;
  footR?: string;
}

function hasCJK(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

// CJK punctuation that must not start a line (避头尾) — when a break would
// strand one of these at a line head, it rides along with the previous char.
const NO_LINE_START = /[，。、；：？！）】》”’…—]/;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const tokens = hasCJK(text) ? Array.from(text) : text.split(' ');
  const glue = hasCJK(text) ? '' : ' ';
  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    const probe = line ? line + glue + t : t;
    if (ctx.measureText(probe).width > maxW && line && !NO_LINE_START.test(t)) {
      lines.push(line);
      line = t;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export class CardScreen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture | null;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Mesh | null;
  cardMesh: THREE.Mesh | null; // part-separated models: the model's own card mesh
  rigDriven: boolean; // rig owns the card transform ('present' clip etc.)
  upLocal: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  basePos: THREE.Vector3;
  height: number;
  pulse: boolean;
  thinking: boolean; // chat: animate three dots while the AI writes
  raiseStart: number;
  content: CardContent;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = null;
    this.material = new THREE.MeshStandardMaterial({
      transparent: true,
      roughness: 0.85,
      metalness: 0,
      // emissiveMap keeps the paper bright under the warm scene light;
      // the golden-weave pulse re-tints it gold
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0.35,
    });
    this._rebuildTexture();
    this.mesh = null;
    this.cardMesh = null;
    this.rigDriven = false;
    this.upLocal = new THREE.Vector3(0, 1, 0);
    this.baseQuat = new THREE.Quaternion();
    this.basePos = new THREE.Vector3();
    this.height = 1;
    this.pulse = false;
    this.thinking = false;
    this.raiseStart = 0;
    this.content = { top: '· ♥ ·', main: 'tap me :)', footL: '', footR: '' };

    document.fonts.ready.then(() => this.redraw());
  }

  // A resized canvas must get a fresh GPU texture: re-uploading through the
  // same CanvasTexture takes the partial-update path against the old storage
  // and leaves a stale strip of the previous character's card.
  _rebuildTexture(): void {
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this.material.emissiveMap = this.texture;
    this.material.needsUpdate = true;
  }

  attach(model: THREE.Object3D, data?: CardPlacement): void {
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh = null;
    this.cardMesh = null;
    this.rigDriven = false;
    if (!data) return;
    const normal = new THREE.Vector3(...data.normal).normalize();
    const up = new THREE.Vector3(...data.up).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    let w = data.width * COVER;
    let h = data.height * COVER;

    const cardMesh = model.getObjectByName('card') as THREE.Mesh | undefined;
    if (cardMesh) {
      w = data.width;
      h = data.height;
      this._projectUVs(cardMesh.geometry, data, right, up);
      cardMesh.material = this.material;
      this.cardMesh = cardMesh;
      this.basePos.copy(cardMesh.position);
    } else {
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.material);
      this.basePos
        .set(...data.center)
        .addScaledVector(normal, data.offset ?? 0.015);
      this.baseQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
      this.mesh.position.copy(this.basePos);
      this.mesh.quaternion.copy(this.baseQuat);
      model.add(this.mesh);
    }
    this.upLocal = up;
    this.height = h;

    const newH = Math.round((512 * h) / w);
    if (this.canvas.width !== 512 || this.canvas.height !== newH) {
      this.canvas.width = 512;
      this.canvas.height = newH;
      this._rebuildTexture();
    }
    this.redraw();
  }

  // Planar-project UVs onto the card mesh in the card-plane basis so the
  // canvas maps straight onto its front face (clamped edges catch the rim).
  // Geometry is shared across model clones; the projection is idempotent,
  // so flag it and skip on repeat visits.
  _projectUVs(geometry: THREE.BufferGeometry, data: CardPlacement, right: THREE.Vector3, up: THREE.Vector3): void {
    if (geometry.userData.cardUV) return;
    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const c = data.center;
    const d = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.set(pos.getX(i) - c[0], pos.getY(i) - c[1], pos.getZ(i) - c[2]);
      uv.setXY(i, d.dot(right) / data.width + 0.5, d.dot(up) / data.height + 0.5);
    }
    uv.needsUpdate = true;
    geometry.userData.cardUV = true;
  }

  setContent(content: CardContent): void {
    this.content = content;
    this.redraw();
  }

  redraw(): void {
    const { canvas, ctx } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return;
    const c = this.content;

    ctx.clearRect(0, 0, W, H);
    if (this.cardMesh) {
      // texture drapes over the yarn card itself — its geometry provides the
      // silhouette, so the paper bleeds to the edges with no drawn border
      ctx.fillStyle = '#FFFDF6';
      ctx.fillRect(0, 0, W, H);
    } else {
      // uniform paper face, covering the whole scanned card
      const r = Math.min(W, H) * 0.09;
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, W - 1, H - 1, r);
      ctx.fillStyle = '#FFFDF6';
      ctx.fill();
      ctx.strokeStyle = 'rgba(90, 73, 52, 0.14)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // soft inner shadow at the bottom so the flat quad reads as a card
      const sh = ctx.createLinearGradient(0, H * 0.82, 0, H);
      sh.addColorStop(0, 'rgba(70, 50, 25, 0)');
      sh.addColorStop(1, 'rgba(70, 50, 25, 0.07)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, W - 1, H - 1, r);
      ctx.fill();
    }

    // chat "thinking" — three dots that bounce in a staggered wave while the
    // AI writes, redrawn every frame from update(). Drawn straight on the card
    // (its soul), not a bubble, and centered like the message it replaces.
    if (this.thinking) {
      const now = performance.now();
      const r = Math.min(W, H) * 0.05;
      const gap = r * 3.4;
      ctx.fillStyle = '#8A7455';
      for (let i = 0; i < 3; i++) {
        const w = 0.5 + 0.5 * Math.sin(now / 175 - i * 1.1); // ~1.1s loop, each dot trails
        ctx.globalAlpha = 0.34 + 0.56 * w;
        ctx.beginPath();
        ctx.arc(W / 2 + (i - 1) * gap, H / 2 - r * 1.15 * w, r * (0.72 + 0.42 * w), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      this.texture!.needsUpdate = true;
      return;
    }

    // fixed-aspect content box, centered — quad aspects vary per scan,
    // but the layout inside stays identical across the crew.
    // Text is sized for readability over hand clearance: it fills nearly the
    // whole card and the gripping hands may clip the lower corners — that's fine.
    let cw = W * (this.cardMesh ? 0.9 : 0.94);
    let ch = cw / CONTENT_ASPECT;
    if (ch > H * 0.92) {
      ch = H * 0.92;
      cw = ch * CONTENT_ASPECT;
    }
    const top = (H - ch) / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (c.top) {
      ctx.fillStyle = c.gold ? '#C9A227' : '#C9A96F';
      ctx.font = `800 ${Math.round(ch * 0.085)}px Nunito, sans-serif`;
      ctx.fillText(c.top, W / 2, top + ch * 0.12);
    }

    // main text: auto-fit handwriting, wrapped — sized to fill the card so it
    // stays legible at desktop-pet scale (hands may clip the edges of long ones).
    // CJK falls through Caveat to a system handwriting face, mirroring --hand.
    const HAND = `Caveat, 'HanziPen SC', 'Hannotate SC', 'Xingkai SC', 'STXingkai', cursive`;
    // hanzi fill the em box where Caveat leaves air: Latin's tight 1.08 leading
    // glues Chinese lines together, so CJK cards start a notch smaller and
    // breathe more between lines (mirrors the html.zh trims in style.css).
    // CJK also gets a narrower measure — hanzi lines pack solid ink right up to
    // the wrap limit, and at 0.98 they visibly touch the card's edge.
    const cjk = /[㐀-鿿]/.test(c.main || '');
    const lead = cjk ? 1.38 : 1.08;
    const maxW = cw * (cjk ? 0.86 : 0.98);
    const maxH = ch * (c.footL || c.footR ? 0.7 : 0.76);
    let size = Math.round(ch * (cjk ? 0.3 : 0.34));
    let lines: string[] = [];
    while (size > 10) {
      ctx.font = `700 ${size}px ${HAND}`;
      lines = wrapText(ctx, c.main || '', maxW);
      if (lines.length * size * lead <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
      size -= 2;
    }
    ctx.fillStyle = '#4A3B28';
    const lh = size * lead;
    const y0 = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));

    if (c.footL) {
      ctx.fillStyle = '#B9A57E';
      ctx.font = `900 ${Math.round(ch * 0.065)}px Nunito, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(c.footL, W / 2 - cw / 2 + cw * 0.04, top + ch * 0.9);
    }
    if (c.footR) {
      ctx.fillStyle = '#8A7455';
      ctx.font = `600 ${Math.round(ch * 0.095)}px ${HAND}`;
      ctx.textAlign = 'right';
      ctx.fillText(c.footR, W / 2 + cw / 2 - cw * 0.04, top + ch * 0.9);
    }

    this.texture!.needsUpdate = true;
  }

  setPulse(v: boolean): void {
    this.pulse = v;
  }

  setThinking(v: boolean): void {
    this.thinking = v;
    this.redraw(); // start/stop the dots on this frame instead of waiting a tick
  }

  raise(): void {
    this.raiseStart = performance.now();
  }

  update(): void {
    if (!this.mesh && !this.cardMesh) return;
    const now = performance.now();

    // 08 · Golden Weave — card emissive pulse · 1.6s
    if (this.pulse) {
      this.material.emissive.set('#C9A227');
      this.material.emissiveIntensity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin((2 * Math.PI * now) / 1600));
    } else {
      this.material.emissive.set('#ffffff');
      this.material.emissiveIntensity = 0.35;
    }

    // keep the thinking dots moving — redraw the card texture each frame
    if (this.thinking) this.redraw();

    // Rigged card: the Animator's card track ('present' lift/tilt/wiggle,
    // idle-life drift) owns the transform — only the texture/pulse live here.
    if (this.rigDriven) return;

    // 05 · Card Raise — 600ms spring · card +10% Y · rotX 8° to camera, hold, ease back
    let k = 0;
    if (this.raiseStart) {
      const t = now - this.raiseStart;
      if (t < 600) k = easeOutBack(t / 600);
      else if (t < 1800) k = 1;
      else if (t < 2200) k = 1 - (t - 1800) / 400;
      else this.raiseStart = 0;
    }
    if (this.cardMesh) {
      // raise slides the real card up out of the hands; no tilt — the mesh
      // node's origin is the model origin, so rotation would swing it away
      this.cardMesh.position.copy(this.basePos).addScaledVector(this.upLocal, 0.1 * this.height * k);
      return;
    }
    this.mesh!.position.copy(this.basePos).addScaledVector(this.upLocal, 0.1 * this.height * k);
    this.mesh!.quaternion.copy(this.baseQuat);
    if (k > 0) {
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -8 * D2R * k);
      this.mesh!.quaternion.multiply(tilt);
    }
  }
}
