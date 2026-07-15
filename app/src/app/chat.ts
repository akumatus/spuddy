// ── chat (heart-to-heart): send/reply loop, gesture acting, distilled memory ──
import { MEMORY_KIND_IDS, PERS, chatFallback, limitReply } from '../content';
import { hasHan, lang } from '../locale';
import { sfx, type SfxName } from '../sfx';
import * as store from '../store';
import type { MemoryKind, MemoryMood } from '../types';
import { $, ctx, pp } from './context';
import { nextMemories } from './memory';
import { bubble, hideBubble } from './speech';

// notes fired while he's mid-reply — answered next, never dropped
const chatPending: string[] = [];

// How many facts are flagged as fresh "bring one up" candidates per reply.
// The model always sees the FULL memory list (dedupe + a consistent picture of
// who the human is); this rotated subset (see nextMemories) only nudges which
// facts he references, so he doesn't circle the same one all day.
const CHAT_MEMORY_FEED = 6;

// the Book's "clear chat" wipes the queue along with the transcript
export function clearChatQueue(): void {
  chatPending.length = 0;
}

// ── emotion tags drive the body (trigger map) ──
export function reactEmotion(tag: string): void {
  if (tag === 'cheer') { sfx.chime(); ctx.anim().playCheer(); }
  else if (tag === 'proud') { sfx.chime(); ctx.anim().play('bigSquish'); }
  else if (tag === 'comfort') { sfx.low(); ctx.anim().play('comfort'); }
  else { sfx.pop(); ctx.anim().play('squish'); }
}

// ── chat gestures: a named action → the clip that acts it out (kept in sync
// with GESTURES in server/src/personas.ts and GESTURE_RE in electron/src/ai.ts) ──
const GESTURE_CLIP: Record<string, string> = {
  wave: 'wave', hug: 'hug', dance: 'pirouette', spin: 'spin', cheer: 'cheer',
  hop: 'hop', sing: 'sing', stretch: 'stretch', shy: 'shy', peek: 'peek',
  sulk: 'sulk', sneeze: 'sneeze', present: 'present',
};
// which sfx suits a gesture (upbeat ones chime, a hug is soft, the rest pop)
const GESTURE_SFX: Record<string, SfxName> = {
  sing: 'chime', dance: 'chime', cheer: 'chime', hop: 'chime', hug: 'low', sulk: 'low',
};

// Client-side safety net so "sing me a song" (or 「唱首歌」) still moves him
// when the LLM is offline / over budget and returned no gesture of its own.
// Keyword-matched against what the human just said, in both languages —
// keyed on the words, not the UI language, so either works anytime.
export function detectGesture(text: string): string | null {
  const t = (text || '').toLowerCase();
  if (/\b(sing|song|serenade|a tune)\b/.test(t) || /唱[首个支]?歌|唱一?[首个支]/.test(t)) return 'sing';
  if (/\b(hug|cuddle|hold me|squeeze|embrace)\b/.test(t) || /抱抱|抱一?下|拥抱|抱我/.test(t)) return 'hug';
  if (/\b(dance|boogie|twirl|pirouette)\b/.test(t) || /跳[个支段]?舞/.test(t)) return 'dance';
  if (/\b(spin|turn around)\b/.test(t) || /转[个一]?圈|转一?下/.test(t)) return 'spin';
  if (/\b(wave|say hi|greet)\b/.test(t) || /挥[挥个]?手|打个?招呼/.test(t)) return 'wave';
  if (/\b(jump|hop|bounce)\b/.test(t) || /跳一?[下跳]|蹦[一个]?[下个]?/.test(t)) return 'hop';
  if (/\b(stretch|yawn)\b/.test(t) || /伸个?懒腰|拉伸/.test(t)) return 'stretch';
  if (/\b(cheer|celebrate|hooray|hurray|yay|woohoo|party)\b/.test(t) || /庆祝|欢呼|干杯|耶[!！]?/.test(t)) return 'cheer';
  if (/\b(hide|be shy|peekaboo|peek-?a-?boo)\b/.test(t) || /躲起来|藏起来|捉迷藏|害羞/.test(t)) return 'shy';
  return null;
}

// Play a chat reply's body: a specific gesture if one fits, else the emotion clip.
export function reactToReply(tag: string, gesture: string | null): void {
  const clip = gesture && GESTURE_CLIP[gesture];
  if (!clip) { reactEmotion(tag); return; }
  const s = GESTURE_SFX[gesture!] || 'pop';
  sfx[s]();
  ctx.anim().play(clip);
}

// Sending never blocks: whatever you type goes straight into the transcript and
// a pending queue. If he's already writing, it folds into his next turn instead
// of being dropped — so you can fire off several lines in a row.
export function chatSend(): void {
  const input = $('chatInput') as HTMLInputElement;
  const note = (input.value || '').trim();
  if (!note) return;
  sfx.pop();
  ctx.brain.interrupt();
  input.value = '';
  input.classList.remove('zh', 'latin'); // programmatic clear fires no input event
  const saidEl = $('said');
  saidEl.textContent = `“${note}”`;
  saidEl.classList.toggle('zh', hasHan(note)); // the quote is whatever you typed, any language
  saidEl.classList.remove('hidden');
  hideBubble();

  ctx.state.chat.push({ who: 'user', text: note, day: ctx.state.day, date: store.todayStr() });
  chatPending.push(note);

  if (ctx.chatBusy) return; // a reply is already brewing — he'll pick this up next
  runChat();
}

// Long-term memory is now the pet's own distillation, not a filter over raw
// chat: the reply carries an optional `remember` — a durable fact he chose to
// keep about the human, tagged with a category. Store it once, skipping
// near-duplicates: models re-surface the same fact across a conversation,
// often re-told with extra detail or reworded, so dedupe is by store.factTwin
// (containment + bigram paraphrase match) rather than equality.

// Stores the fact and returns the category it was filed under (or null when
// skipped as too-short / a near-duplicate), so the caller can tag the message
// that revealed it. Mood (sunny/rainy/plain — the quilt's patch color) is the
// model's own stamp on the [[remember]] note; if it skipped one, fall back to
// the reply's emotion tag: [comfort] means they were down → rainy, a celebrating
// [cheer]/[proud] reads sunny, and a [calm] reply keeps the patch plain.
function rememberFact(fact: string, kind: string | undefined, mood: MemoryMood | null | undefined, tag: string): MemoryKind | null {
  const state = ctx.state;
  const f = (fact || '').trim();
  if (f.length < 4) return null;
  const k: MemoryKind = MEMORY_KIND_IDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'other';
  const md = mood || (tag === 'comfort' ? 'rainy' : tag === 'cheer' || tag === 'proud' ? 'sunny' : 'plain');
  const twin = state.memory.find((m) => store.factTwin(m.fact, f));
  if (twin) {
    // the old telling already says this (in equal or richer detail) → skip
    if (store.normFact(f).length <= store.normFact(twin.fact).length) return null;
    // a re-telling that adds detail upgrades the old card instead of adding a
    // twin; day stays — that's when he first learned it
    twin.fact = f;
    twin.kind = k;
    twin.mood = md;
    return k;
  }
  state.memory.push({ day: state.day, fact: f, kind: k, mood: md });
  return k;
}

export async function runChat(): Promise<void> {
  const state = ctx.state;
  ctx.chatBusy = true;
  ctx.anim().setMode('rock'); // 08 · Golden Weave — while AI writes
  ctx.scene.setCardPulse(true);
  ctx.scene.setCardThinking(true); // animated three dots on the card while he thinks
  ctx.updateCardScreen();

  // Answer everything queued so far; anything typed mid-reply loops back around.
  while (chatPending.length) {
    const covered = chatPending.slice(); // the notes this reply speaks to
    const ch = ctx.activeChar();
    const res = await pp.ai.reply({
      charId: ch.id,
      charName: ch.name,
      voice: PERS[ch.id].voice,
      day: state.day,
      memory: state.memory, // the FULL list — dedupe + a consistent picture of them
      fresh: nextMemories(CHAT_MEMORY_FEED).map((m) => m.fact), // rotated "bring one up" candidates
      messages: state.chat.slice(-12),
      lang: lang(), // picks the matching daily-batch musings server-side
    }).catch(() => null); // dropped connection → fall back instead of hanging chatBusy
    chatPending.splice(0, covered.length); // clear what he just answered; keep mid-flight arrivals

    let tag = 'calm';
    let gesture: string | null = null;
    let reply = chatFallback(ch.id);
    if (res && res.limited) {
      // daily real-time budget spent — warm "let's pick this up tomorrow" line
      reply = limitReply(ch.id);
    } else if (res && res.text) {
      tag = res.tag || 'calm';
      gesture = res.gesture || null;
      reply = res.text;
    }
    // let the LLM lead; fall back to a keyword read of what they asked for so
    // "sing me a song" still lands even offline / over budget
    if (!gesture) gesture = detectGesture(covered.join(' '));
    reactToReply(tag, gesture);
    state.chat.push({ who: 'pet', text: reply, day: state.day, date: store.todayStr(), char: ch.id });
    if (res && res.remember && res.remember.fact) {
      const kind = rememberFact(res.remember.fact, res.remember.kind, res.remember.mood, tag);
      // mark the human's line that revealed it, so the transcript shows the stitch
      if (kind) {
        for (let j = state.chat.length - 1; j >= 0; j--) {
          if (state.chat[j].who === 'user') { state.chat[j].mem = kind; break; }
        }
      }
    }
    ctx.persist();
    bubble(reply, { hold: 9000, type: true });
    setTimeout(() => $('said').classList.add('hidden'), 4200);

    // let the reply land before he turns to whatever you said meanwhile
    if (chatPending.length) await new Promise((r) => setTimeout(r, 1200));
  }

  ctx.chatBusy = false;
  ctx.anim().setMode('idle');
  ctx.scene.setCardPulse(false);
  ctx.scene.setCardThinking(false);
  ctx.updateCardScreen();
}
