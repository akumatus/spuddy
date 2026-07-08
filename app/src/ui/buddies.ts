// Buddies — the standalone character-picker panel.
import { CHARS, TXT, UNLOCK } from '../content';
import { counts } from '../store';
import type { AppState, CharId } from '../types';
import { esc, modal, openOverlay } from './overlay';

export interface BuddiesHandlers {
  onClose: () => void;
  onPick: (id: CharId) => void | Promise<void>;
}

export function showBuddies(state: AppState, handlers: BuddiesHandlers): void {
  const t = TXT();
  const ui = t.ui;
  const cts = counts(state);
  const unlocked = (id: CharId) => !UNLOCK[id] || state.unlockedIds.includes(id);
  const unlockedCount = CHARS.filter((c) => unlocked(c.id)).length;

  openOverlay(`
    <div id="book" class="buddiespanel">
      <div class="head">
        <span class="title">${ui.buddiesTitle}</span>
        <span class="subcount">${ui.friendsCount(unlockedCount, CHARS.length)}</span>
        <button class="close" id="buddiesClose">×</button>
      </div>
      <div class="buddies">
        ${CHARS.map((ch) => {
          const un = unlocked(ch.id);
          const act = state.active === ch.id;
          const d = UNLOCK[ch.id];
          const dt = t.unlock[ch.id];
          const btn = act ? ui.onDuty : un ? ui.setActive : `${Math.min(cts[d!.key], d!.n)}/${d!.n} · ${dt!.verb}`;
          return `
          <div class="buddy ${un ? '' : 'locked'} ${act ? 'active' : ''}">
            <div class="pic" style="background-image:url('./chars/char-${ch.id}.png')"></div>
            <div class="nm">${ch.name}</div>
            <div class="ps">${un ? t.pers[ch.id].p : esc(dt!.how)}</div>
            <button data-pick="${ch.id}">${btn}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="hint">${ui.buddiesHint}</div>
    </div>`);

  document.getElementById('buddiesClose')!.onclick = handlers.onClose;
  modal().querySelectorAll<HTMLElement>('[data-pick]').forEach((b) => (b.onclick = () => handlers.onPick(b.dataset.pick as CharId)));
}
