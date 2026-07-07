// ── debug switch (launch with PP_DEBUG=1) + hooks for automated UI tests ──
import * as store from '../store';
import { closeOverlay } from '../ui/overlay';
import type { CharId } from '../types';
import { ctx } from './context';
import { drawToday } from './gacha';
import { playTapReaction, tapPet } from './interactions';

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
    setChar: (id: CharId) => ctx.scene.setCharacter(id).then(() => ctx.updateCardScreen()),
    sceneObj: ctx.scene,
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
