// Shared app context — the mutable state and cross-module flags that used to
// live at the top of a monolithic main.js. Feature modules import { ctx } and
// read/write through it; construction and wiring happen once in main.ts.
import type { SpudBrain } from '../brain';
import { CHARS, type Character } from '../content';
import type { PetScene } from '../scene/scene';
import type { Animator } from '../scene/motions';
import * as store from '../store';
import type { AppState, PreloadBridge } from '../types';

export const $ = (id: string): HTMLElement => document.getElementById(id)!;

// preload bridge — present in every packaged/dev build; typed non-null so
// call sites stay clean
export const pp: PreloadBridge = window.pp!;

class AppContext {
  // set once in main.ts before any feature module runs
  state!: AppState;
  scene!: PetScene;
  brain!: SpudBrain;

  chatBusy = false;
  weaving = false;

  private afterPersist: (() => void)[] = [];

  init(state: AppState, scene: PetScene): void {
    this.state = state;
    this.scene = scene;
  }

  // the animator exists as soon as the first setCharacter resolves (before
  // main.ts hands control to any feature module)
  anim(): Animator {
    return this.scene.animator!;
  }

  activeChar(): Character {
    return CHARS.find((c) => c.id === this.state.active) || CHARS[0];
  }

  // main.ts registers what must follow every save (unlock checks, badge dots)
  onPersist(fn: () => void): void {
    this.afterPersist.push(fn);
  }

  persist(): void {
    store.save(this.state);
    for (const fn of this.afterPersist) fn();
  }

  // mini card on the model — mirrors the design's rMiniVals
  updateCardScreen(): void {
    if (this.chatBusy) {
      this.scene.setCardContent({ top: '', main: '. . .' });
    } else if (this.state.drawn && this.state.msg) {
      this.scene.setCardContent({
        top: this.state.rare ? '✦ · ✦ · ✦' : '· · ♥ · ·',
        gold: this.state.rare,
        main: this.state.msg,
        footL: `DAY ${this.state.day}`,
        footR: `— ${this.activeChar().name}`,
      });
    } else {
      this.scene.setCardContent({ top: '· ♥ ·', main: 'tap me :)' });
    }
  }
}

export const ctx = new AppContext();
