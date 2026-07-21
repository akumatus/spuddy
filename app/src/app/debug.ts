// ── debug switch (launch with PP_DEBUG=1) + hooks for automated UI tests ──
import * as store from '../store';
import { closeOverlay } from '../ui/overlay';
import type { CharId } from '../types';
import { ctx } from './context';
import { drawToday } from './gacha';
import { dockTo, playTapReaction, tapPet, undock } from './interactions';
import { bubble, showMutter } from './speech';

// redraw simulates the next day: fresh text each time, golden by pity-smoothed roll
export function debugRedraw(): void {
  if (ctx.weaving) return;
  closeOverlay();
  ctx.state.day += 1;
  ctx.state.drawn = false;
  ctx.state.draws = 0;
  ctx.state.rare = false;
  ctx.state.msg = '';
  ctx.state.keptToday = false;
  ctx.persist();
  ctx.updateCardScreen();
  drawToday();
}

export function debugReset(): void {
  store.reset();
  location.reload();
}

// debug hook for automated UI tests (PP_UITEST=js:...)
export function installDebugHooks(): void {
  window._pp = {
    tap: tapPet,
    tapCard: () => tapPet('card'),
    tapReact: playTapReaction,
    state: () => ctx.state,
    brain: ctx.brain,
    redraw: debugRedraw,
    reset: debugReset,
    play: (name: string) => ctx.anim().play(name),
    // edge-dock choreography, same code path as a drag-and-release on an edge
    dock: dockTo,
    undock,
    // deterministic speech triggers — tap() can land on a silent skit
    say: bubble,
    mutter: showMutter,
    setChar: (id: CharId) => ctx.scene.setCharacter(id).then(() => ctx.updateCardScreen()),
    sceneObj: ctx.scene,
    // live-tune the trim (glasses) metal: trim(0.24, 0.45) — linear gray, same
    // units as the pipeline's TRIM_SILVER_COLOR / TRIM_SILVER_ROUGH; or a
    // '#rrggbb' sRGB hex. No args = read the current values back.
    trim: (color?: string | number, rough?: number) => {
      let out: { linear: number[]; hex: string; roughness: number } | null = null;
      ctx.scene.scene.traverse((o) => {
        const mesh = o as import('three').Mesh;
        if (!(mesh as { isMesh?: boolean }).isMesh || mesh.name !== 'trim') return;
        const mat = mesh.material as import('three').MeshStandardMaterial;
        if (typeof color === 'number') mat.color.setRGB(color, color, color * 1.08);
        else if (typeof color === 'string') mat.color.set(color);
        if (rough !== undefined) mat.roughness = rough;
        out = {
          linear: mat.color.toArray().map((v) => +(v as number).toFixed(3)),
          hex: '#' + mat.color.getHexString(),
          roughness: +mat.roughness.toFixed(2),
        };
      });
      return out;
    },
    cardProbe: () => {
      const planes: { pos: number[]; parent: string | undefined }[] = [];
      ctx.scene.scene.traverse((o) => {
        const mesh = o as import('three').Mesh;
        if (mesh.isMesh && mesh.geometry && mesh.geometry.type === 'PlaneGeometry') {
          planes.push({
            pos: mesh.position.toArray().map((v) => +v.toFixed(3)),
            parent: mesh.parent?.uuid?.slice(0, 8),
          });
        }
      });
      return { planes, canvas: [ctx.scene.cardScreen.canvas.width, ctx.scene.cardScreen.canvas.height] };
    },
  };
}
