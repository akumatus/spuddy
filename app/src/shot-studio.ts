// Media studio — dev-only page (shots.html), sibling of buddy-studio.html and
// icon-studio.html. Renders each README screenshot out of the real UI modules
// and the real PetScene, over a transparent page, so docs/media/ shows the
// shipped product rather than a mockup of it. scripts/shoot-media.cjs loads
// one shot per window (?shot=<name>), waits for __ready, and writes the
// alpha-cropped PNG.
//
// Everything below is fabricated demo data — the studio never reads the
// user's own store, so the shots are reproducible and carry no real chat.
//
// Two shot shapes:
// · popup shots build their markup through the real popup module into the
//   hidden #modal staging tree, exactly as the app does, then move the result
//   into #proot — which mirrors popup.html's shell (natural size, centered,
//   90px of shadow headroom).
// · pet shots drive a real PetScene inside the pet window's own 720×640
//   viewport (electron/src/window.ts), so the stage, hover panel and bubbles
//   land where the app puts them instead of where a reconstruction would.
import { CHARS, TXT } from './content';
import { setLangPref } from './locale';
import { PetScene } from './scene/scene';
import { defaultState } from './store';
import type { AppState, CharId } from './types';
import { showBook } from './ui/book';
import { showBuddies } from './ui/buddies';
import { showCard } from './ui/popups';

// The pet window's viewport (WIN_W/WIN_H in electron/src/window.ts). The stage
// and hover panel position themselves against it, so the pet shots have to use
// it verbatim — a different viewport would move the panel off his flank.
const PET_VIEW = { w: 720, h: 640 };
// Popup shots are cropped to their alpha bbox, so these only need to be big
// enough that nothing touches an edge (the tallest is the card book).
const DOM_VIEW = { w: 1100, h: 1000 };
// The golden shot holds a centered popup and a corner-docked pet in one frame,
// so unlike the others this viewport is load-bearing: it sets the gap between
// them. Roughly a screen's proportions, which is what the two windows are
// actually spaced against.
const BOTH_VIEW = { w: 1240, h: 780 };

interface Shot {
  mode: 'pet' | 'dom' | 'both';
  view: { w: number; h: number };
  render: () => Promise<void>;
}

const $ = (id: string) => document.getElementById(id)!;

// ── fabricated demo data ──
// Card lines, memories and chat are written to the same contracts the real
// content follows (server/src/personas.ts for the distill phrasing: third
// person, no trailing period, they/their), so the shots read as a real save.

const HERO_CARD = "You don't have to be perfect to be wonderful";
const HERO_MUTTER = 'the lamp hums. i don’t mind it.';

// Seven cards. The grid is 3-wide, so seven runs 3 · 3 · 1 and the short last
// row keeps the panel from reading as a packed catalogue — a full nine looked
// airless. Two goldens and two favorites stay in regardless: the shot has to
// show what the ✦ and the ♥ actually look like, and a golden signed by its
// source is the common case the Golden Stitch section describes.
const DEMO_CARDS: AppState['cards'] = [
  { m: 'Rest is productive. Signed, a potato.', rare: false, day: 3, by: 'Spud' },
  { m: 'Look inside yourself. You are more than what you have become.', rare: true, day: 8, by: 'Sprinkles', src: 'The Lion King' },
  { m: 'EAT THE SNACK. THE SNACK IS THE PLAN.', rare: false, day: 9, by: 'Taco' },
  { m: 'Small steps still face forward.', rare: false, day: 12, by: 'Bloom' },
  { m: 'Leap, and the net will appear.', rare: true, day: 14, by: 'Spud', src: 'John Burroughs', fav: true },
  { m: 'You have survived every single one of your worst days.', rare: false, day: 17, by: 'Leo', fav: true },
  { m: 'This little potato believes in you.', rare: false, day: 24, by: 'Spud' },
];

// Six patches — the quilt is 2-wide, so six is three clean rows. One per doodle
// (heart / rain cloud / sprout / pennant / sigh-bubbles / sparkle) and one of
// each mood, so a single still carries the whole vocabulary of the quilt.
const DEMO_MEMORY: AppState['memory'] = [
  { day: 2, fact: 'has a tabby called Biscuit who supervises every video call', kind: 'pets', mood: 'sunny' },
  { day: 6, fact: 'bakes sourdough on Saturdays and names every loaf', kind: 'likes', mood: 'sunny' },
  { day: 12, fact: 'lost their dad a few years back; keeps his shed just as it was', kind: 'people', mood: 'rainy' },
  { day: 14, fact: 'quietly worries their mum is lonely in that house alone', kind: 'feeling', mood: 'rainy' },
  { day: 17, fact: 'is growing tomatoes on the balcony for the first time', kind: 'goal', mood: 'plain' },
  { day: 21, fact: 'their sister Nell had a baby girl named Wren', kind: 'milestone', mood: 'sunny' },
];

const DEMO_CHAT: AppState['chat'] = [
  { who: 'user', text: 'my sister had her baby! her name is Wren', day: 21, date: '2026-07-07', mem: 'milestone' },
  { who: 'pet', text: 'a Wren! small, loud, and already flying. congratulations — you’re somebody’s aunt now.', day: 21, date: '2026-07-07', char: 'bloom' },
  { who: 'user', text: 'I keep meaning to drive up and meet her', day: 21, date: '2026-07-07' },
  { who: 'pet', text: 'the meaning-to is already love. pick a Saturday and let the rest be easy.', day: 21, date: '2026-07-07', char: 'bloom' },
  { who: 'user', text: 'today was a lot', day: 24, date: '2026-07-10' },
  { who: 'pet', text: 'the soil rests after a long rain. would you like to rest beside it for a bit?', day: 24, date: '2026-07-10', char: 'bloom' },
  { who: 'user', text: 'the tomatoes are actually growing though', day: 24, date: '2026-07-10', mem: 'goal' },
  { who: 'pet', text: 'of course they are. you kept showing up with the watering can — that’s the whole secret.', day: 24, date: '2026-07-10', char: 'bloom' },
];

function demoState(over: Partial<AppState> = {}): AppState {
  return {
    ...defaultState(),
    day: 24,
    streak: 6,
    cards: DEMO_CARDS,
    memory: DEMO_MEMORY,
    chat: DEMO_CHAT,
    // every buddy earned — the roster shot is about the finished crew, and the
    // book's avatars need whoever spoke to be a real character
    unlockedIds: CHARS.map((c) => c.id),
    active: 'spud',
    ...over,
  };
}

// popup handlers — the shots are still frames, nothing is clickable
const NOOP_BOOK = {
  onClose: () => {}, onTab: () => {}, onFilter: () => {}, onApply: () => {},
  onFav: () => {}, onDel: () => {}, onDelMem: () => {}, onClearMem: () => {},
  onClearChat: () => {}, onClearCards: () => {}, onOlderChat: () => 0,
  chatHasMore: false,
};

// Move what the popup module just staged in #modal over to #proot, where
// popup.html's shell rules give it its natural size and shadow headroom.
function stageToRoot(): void {
  const built = $('modal').firstElementChild;
  if (!built) throw new Error('popup rendered nothing into #modal');
  $('proot').appendChild(built);
}

// ── pet shots ──

// Mirrors hugText() in app/speech.ts: both head cards are width:max-content
// under a max-width clamp, so once the text wraps the box sticks at the clamp
// while the last line can land well short of it. Re-measure the laid-out lines
// and hug the widest. (speech.ts's own copy is bound to the live app context,
// which the studio deliberately doesn't boot.)
function hugText(el: HTMLElement): void {
  el.style.width = '';
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = Array.from(range.getClientRects());
  if (lines.length < 2) return;
  const text = Math.max(...lines.map((r) => r.width));
  const cs = getComputedStyle(el);
  const chrome =
    parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  el.style.width = `${Math.ceil(text + chrome) + 1}px`;
}

function show(id: string, text: string): void {
  const el = $(id);
  el.textContent = text;
  el.classList.remove('hidden');
  hugText(el);
}

// Boot a real PetScene on #pet and hold it at a still, repeatable frame.
async function petScene(id: CharId, card: Parameters<PetScene['setCardContent']>[0]): Promise<void> {
  const scene = new PetScene($('pet') as HTMLCanvasElement);
  // the camera breathes on an 11s/8.2s cycle in-app — a shot has to be the
  // same frame every run, so park it at camBase
  scene.cameraSway = false;
  scene.setPetSize('md'); // the shipped default (store.ts), --pet-scale and all
  await scene.setCharacter(id);
  scene.setCardContent(card);
  // attach() may have first painted the card before the webfonts resolved
  await document.fonts.ready;
  scene.cardScreen.redraw();
  // no motion is playing, so the animator rests at identity and every frame
  // from here is identical — one more tick just lets the fresh card texture and
  // the loaded model land in the framebuffer
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ── the shots ──

const SHOTS: Record<string, Shot> = {
  // He sits in the corner, holding the day's card, thinking to himself, with
  // the hover panel out — the one frame that says what the whole app is.
  hero: {
    mode: 'pet',
    view: PET_VIEW,
    async render() {
      const state = demoState();
      await petScene('spud', {
        top: '· · ♥ · ·',
        main: HERO_CARD,
        footL: TXT().ui.dayShort(state.day),
        footR: `— Spud`,
      });
      show('mutter', HERO_MUTTER);
      ($('chatInput') as HTMLInputElement).placeholder = TXT().ui.placeholder('Spud');
    },
  },

  // The live chat: his reply in a solid bubble, with the chat box open under it.
  // Bloom is on duty — the README's point is that the gardener answers a hard
  // day with soil and rain, so the shot has to actually be the gardener.
  //
  // #said (the echo of what you just typed) is deliberately left out. It's bare
  // text — #6b5537 with only a soft white glow behind it — which is fine over
  // the light desktop it was designed for, but on a transparent PNG it lands on
  // whatever the reader's theme is, and on GitHub's dark one it degrades into an
  // unreadable smudge. The bubble and the placeholder carry the exchange; the
  // README prose supplies the line the human said.
  chat: {
    mode: 'pet',
    view: PET_VIEW,
    async render() {
      const state = demoState({ active: 'bloom' });
      await petScene('bloom', {
        top: '· · ♥ · ·',
        main: 'Small steps still face forward.',
        footL: TXT().ui.dayShort(state.day),
        footR: `— Bloom`,
      });
      show('bubble', 'the soil rests after a long rain. would you like to rest beside it for a bit?');
      ($('chatInput') as HTMLInputElement).placeholder = TXT().ui.placeholder('Bloom');
    },
  },

  // Today's draw, mid-offer.
  'daily-card': {
    mode: 'dom',
    view: DOM_VIEW,
    async render() {
      const state = demoState();
      showCard(state, { msg: 'This little potato believes in you.', rare: false, keptToday: false },
        { onKeep: () => {}, onLater: () => {} });
      stageToRoot();
    },
  },

  // The rare one, hand-woven and signed by whoever was on duty — shown as both
  // windows at once, because the point of the section is that the card in the
  // popup is the very one he's holding out to you in the corner. Same string
  // feeds the popup and the card texture on the doll, so they cannot drift.
  golden: {
    mode: 'both',
    view: BOTH_VIEW,
    async render() {
      const state = demoState({ active: 'donut', day: 24 });
      const msg = 'You are not behind. You are exactly here, and here is where the good stuff starts.';
      // the doll's held card, exactly as updateCardScreen() dresses it for a
      // drawn golden (see app/context.ts)
      await petScene('donut', {
        top: '✦ · ✦ · ✦',
        gold: true,
        main: msg,
        footL: TXT().ui.dayShort(state.day),
        footR: `— Sprinkles`,
      });
      showCard(state, { msg, rare: true, keptToday: false }, { onKeep: () => {}, onLater: () => {} });
      stageToRoot();
    },
  },

  // The book you keep them in.
  cardbook: {
    mode: 'dom',
    view: DOM_VIEW,
    async render() {
      showBook(demoState(), 'cards', 'all', NOOP_BOOK);
      stageToRoot();
    },
  },

  // The quilt he's making of you.
  memory: {
    mode: 'dom',
    view: DOM_VIEW,
    async render() {
      showBook(demoState(), 'mem', 'all', NOOP_BOOK);
      stageToRoot();
    },
  },

  // The crew, all six earned.
  buddies: {
    mode: 'dom',
    view: DOM_VIEW,
    async render() {
      showBuddies(demoState(), { onClose: () => {}, onPick: () => {} });
      stageToRoot();
    },
  },
};

// The driver's half of the handshake (scripts/shoot-media.cjs).
declare global {
  interface Window {
    __booted?: boolean;
    __ready?: boolean;
    __error?: string;
    __shotView?: { w: number; h: number };
    __start?: () => void;
  }
}

function main(): void {
  const name = new URLSearchParams(location.search).get('shot') || '';
  const shot = SHOTS[name];
  if (!shot) throw new Error(`unknown shot "${name}" — have: ${Object.keys(SHOTS).join(', ')}`);

  // The shots are the English README's; the studio never follows the machine
  // locale, or a Chinese dev box would quietly rewrite every card.
  setLangPref('en');
  document.body.dataset.mode = shot.mode;
  window.__shotView = shot.view;

  // Two-phase on purpose: the pet shots position the stage and hover panel
  // against the viewport, so nothing may render until the driver has resized
  // it to __shotView. It reads that, resizes, then calls __start().
  window.__start = () => {
    void (async () => {
      try {
        await shot.render();
        // card text must never rasterize in a fallback face
        await document.fonts.ready;
        // let the final layout (webfont metrics, the hugged bubbles) paint
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        window.__ready = true;
      } catch (e) {
        window.__error = e instanceof Error ? e.stack || e.message : String(e);
      }
    })();
  };
  window.__booted = true;
}

try {
  main();
} catch (e) {
  window.__error = e instanceof Error ? e.stack || e.message : String(e);
}
