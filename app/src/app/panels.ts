// ── the Card Book, the Buddies panel, and care cards (scheduler / OS events) ──
import { CHARS, TXT, UNLOCK, greet } from '../content';
import { sfx } from '../sfx';
import { showBook, type BookFilter, type BookTab } from '../ui/book';
import { showBuddies } from '../ui/buddies';
import { closeOverlay, isOverlayOpen } from '../ui/overlay';
import { showCareCard } from '../ui/popups';
import * as store from '../store';
import { clearChatQueue } from './chat';
import { $, ctx } from './context';
import { bubble } from './speech';

// how many older transcript lines each scroll-up page pulls in from chat.jsonl
const CHAT_PAGE = 60;

let bookTab: BookTab = 'cards';
let bookFilter: BookFilter = 'all';

// ── Card Book ──
export function openBook(tab?: BookTab): void {
  ctx.brain.interrupt();
  bookTab = tab || bookTab;
  renderBook();
}

function renderBook(): void {
  const state = ctx.state;
  showBook(state, bookTab, bookFilter, {
    onClose: () => { sfx.pop(); closeOverlay(); },
    onTab: (t) => { bookTab = t; renderBook(); },
    onFilter: (f) => { bookFilter = f; renderBook(); },
    onApply: (i) => {
      const c = state.cards[i];
      if (!c) return;
      sfx.pop();
      // hold this card in his hands — persists until the next daily draw,
      // and survives chat / switching buddies (updateCardScreen reads state.msg)
      state.msg = c.m;
      state.msgSrc = c.src || '';
      state.rare = !!c.rare;
      state.drawn = true;
      ctx.persist();
      ctx.updateCardScreen();
      closeOverlay();
      ctx.scene.raiseCard();
      bubble(TXT().ui.holding);
    },
    onFav: (i) => {
      sfx.pop();
      state.cards[i].fav = !state.cards[i].fav;
      ctx.persist();
      renderBook();
    },
    onDel: (i) => {
      sfx.pop();
      state.cards.splice(i, 1);
      ctx.persist();
      renderBook();
    },
    onDelMem: (i) => {
      sfx.pop();
      state.memory.splice(i, 1);
      ctx.persist();
      renderBook();
    },
    onClearMem: () => {
      sfx.pop();
      state.memory = [];
      ctx.persist();
      renderBook();
    },
    // Chat and memory clear independently now that each has its own tab: this
    // wipes only the running conversation (the context he replies from) back to
    // empty; his distilled memory stays put, and his next hello is a spoken one.
    onClearChat: () => {
      sfx.pop();
      state.chat = [];
      clearChatQueue();
      ctx.persist();
      renderBook();
    },
    onClearCards: () => {
      sfx.pop();
      state.cards = [];
      ctx.persist();
      renderBook();
    },
    onOlderChat: () => {
      const n = store.loadOlderChat(state, CHAT_PAGE);
      if (n) renderBook();
      return n;
    },
    chatHasMore: store.hasOlderChat(),
  });
}

// ── Buddies (standalone panel) ──
export function openBuddies(): void {
  ctx.brain.interrupt();
  if (ctx.state.buddyNew) {
    ctx.state.buddyNew = false;
    ctx.persist();
  }
  renderBuddies();
}

function renderBuddies(): void {
  const state = ctx.state;
  showBuddies(state, {
    onClose: () => { sfx.pop(); closeOverlay(); },
    onPick: async (id) => {
      const ch = CHARS.find((c) => c.id === id)!;
      const d = UNLOCK[id];
      if (d && !state.unlockedIds.includes(id)) {
        sfx.low();
        closeOverlay();
        bubble(TXT().ui.joinsWhen(ch.name, TXT().unlock[id]?.how || ''), { hold: 3600 });
        return;
      }
      sfx.pop();
      ctx.brain.interrupt();
      state.active = id;
      ctx.persist();
      closeOverlay();
      await ctx.scene.setCharacter(id);
      ctx.updateCardScreen();
      ctx.anim().play(ctx.scene.hasRig() ? 'wave' : 'hop'); // reporting for duty
      bubble(greet(id), { hold: 3600 }); // his hello is spoken, not written to the record
      ($('chatInput') as HTMLInputElement).placeholder = TXT().ui.placeholder(ctx.activeChar().name);
    },
  });
}

// ── care cards (scheduler / OS events) ──
export function presentCare(tag: string, msg: string): void {
  if (isOverlayOpen() || ctx.anim().tucked) return;
  ctx.brain.interrupt();
  sfx.chime();
  ctx.scene.raiseCard();
  showCareCard(ctx.state, tag, msg, () => {
    sfx.pop();
    closeOverlay();
  });
}
