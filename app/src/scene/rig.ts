import * as THREE from 'three';

/* ──────────── part rigging: pivot groups from named nodes ────────────
   Ported from the design prototype's lib/spud-scene2.js — hands hinge at
   the shoulder, eyes at their own center, card at its bottom edge. Models
   without named parts (legacy single-mesh scans) return null. */

export interface RigPart {
  g: THREE.Group; // the pivot group the animator rotates/moves
  home: THREE.Vector3; // the pivot's rest position
  unit: number; // world → parent-local scale factor
}

export interface HandRigPart extends RigPart {
  sign: number; // +1 right side, −1 left
  liftAxis: 'x' | 'z'; // forward paws hinge around X, side paws around Z
  shyVec: THREE.Vector3; // travel to the same-side eye (for "shy")
}

export interface EyeRigPart extends RigPart {
  w: number; // eye width — the unit for dx/dy travel
}

export interface Rig {
  handL?: HandRigPart;
  handR?: HandRigPart;
  eyeL?: EyeRigPart;
  eyeR?: EyeRigPart;
  card?: RigPart;
}

export function rigParts(model: THREE.Object3D, sceneRoot: THREE.Object3D): Rig | null {
  sceneRoot.updateMatrixWorld(true);
  const names = ['body', 'card', 'handL', 'handR', 'eyeL', 'eyeR'] as const;
  const nodes: Partial<Record<(typeof names)[number], THREE.Object3D>> = {};
  const box: Record<string, THREE.Box3> = {};
  const ctr: Record<string, THREE.Vector3> = {};
  const size: Record<string, THREE.Vector3> = {};
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

  const wrap = (part: THREE.Object3D, worldPivot: THREE.Vector3): RigPart => {
    const parent = part.parent!;
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

  const rig: Rig = {};
  for (const side of ['L', 'R'] as const) {
    const hn = `hand${side}` as const, en = `eye${side}` as const;
    const hand = nodes[hn];
    if (hand) {
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
      const r: HandRigPart = {
        ...wrap(hand, pivot),
        sign,
        liftAxis: forward ? 'x' : 'z',
        shyVec: new THREE.Vector3(0, 0, 0),
      };
      if (nodes[en]) {
        r.shyVec.set(
          ctr[en].x - c.x,
          ctr[en].y - c.y - size[en].y * 0.1,
          ctr[en].z - c.z + size[en].z / 2 + size[hn].z / 2 + 0.015
        );
      }
      rig[hn] = r;
    }
    const eye = nodes[en];
    if (eye) {
      rig[en] = { ...wrap(eye, ctr[en].clone()), w: size[en].x };
    }
  }
  if (nodes.card) {
    const b = box.card, c = ctr.card;
    rig.card = wrap(nodes.card, new THREE.Vector3(c.x, b.min.y, c.z));
  }
  return rig;
}
