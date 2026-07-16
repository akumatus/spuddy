// ── batch memory distillation (POST /distill) ──
// Memory extraction used to ride inside every chat reply as a [[remember]]
// note: cheap, but one fact per reply at most, and the reply-writing model
// under-extracted whenever the fact was spread over turns or the conversation
// turned heavy. Now a dedicated pass reads a whole chunk of transcript at once,
// after the conversation cools — the chat prompt sheds its extraction rules
// (AiReplyRequest.distill) and one call can return several facts.
//
// Chunking is lull-based, not fixed-N: a desk pet's chats are bursty, and the
// gap between bursts is a natural topic boundary — a fixed window would cut
// threads mid-story. Triggers:
//   · lull    — LULL_MS after the last message (scheduleDistill resets a timer)
//   · backstop — a marathon burst reaches BACKSTOP undistilled lines; the
//     CONTEXT_TAIL overlap keeps a thread readable across the forced cut
//   · boot    — quitting mid-lull leaves an undistilled tail; catch up shortly
//     after launch instead of hooking app-quit
//
// The cursor (state.distilledUpTo) counts absolute chat.jsonl lines — the
// state.chat window slides (store.ts CHAT_TAIL / loadOlderChat), absolute
// counts don't. It only advances after facts are safely stored, so a failed or
// quota-limited call simply retries at the next trigger; messages that arrive
// mid-call stay beyond the captured end and are never skipped.
import { lang } from '../locale';
import * as store from '../store';
import { ctx, pp } from './context';
import { rememberFact, updateFact } from './memory';

const LULL_MS = 10 * 60_000; // quiet gap that ends a burst
const BACKSTOP = 30; // undistilled lines that force an early pass mid-burst
const CONTEXT_TAIL = 6; // already-distilled lines sent as read-only context
const BOOT_DELAY_MS = 45_000; // let the greeting and card batch land first

let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;

// messages not yet distilled — cursor clamped so a shrunk transcript
// (clear chat, external truncation) self-heals instead of going negative
function undistilled(): number {
  const state = ctx.state;
  const total = store.chatTotal(state);
  state.distilledUpTo = Math.max(0, Math.min(state.distilledUpTo, total));
  return total - state.distilledUpTo;
}

// Call after every transcript append (user line or pet reply): restarts the
// lull timer, or runs immediately once the backstop is hit.
export function scheduleDistill(): void {
  if (undistilled() >= BACKSTOP) {
    void runDistill();
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runDistill();
  }, LULL_MS);
}

// Boot catch-up for a tail left by quitting mid-lull.
export function initDistill(): void {
  setTimeout(() => {
    if (undistilled() > 0) void runDistill();
  }, BOOT_DELAY_MS);
}

async function runDistill(): Promise<void> {
  if (busy || !pp.ai.distill) return; // older preload: no bridge, server keeps in-reply notes
  const state = ctx.state;
  if (undistilled() <= 0) return;
  const total = store.chatTotal(state); // captured end — later arrivals stay undistilled
  const base = total - state.chat.length; // absolute line number of state.chat[0]
  // Cursor below the loaded window (only after >CHAT_TAIL lines landed unseen,
  // e.g. an imported transcript): the window is all we can read — distill it
  // and let the cursor jump the gap.
  const start = Math.max(state.distilledUpTo - base, 0);
  const chunk = state.chat.slice(start);
  if (!chunk.length) {
    state.distilledUpTo = total;
    return;
  }
  busy = true;
  try {
    // Snapshot the fact cards before the call: the response's `updates` refs
    // are indices into THIS list, and chat may append (or the Book delete)
    // cards while the request is in flight.
    const memSnapshot = state.memory.slice();
    const res = await pp.ai.distill({
      day: state.day,
      lang: lang(),
      memory: memSnapshot,
      context: state.chat.slice(Math.max(start - CONTEXT_TAIL, 0), start).map((m) => ({ who: m.who, text: m.text })),
      messages: chunk.map((m) => ({ who: m.who, text: m.text })),
    }).catch(() => null);
    // failed chain / offline / over budget → keep the cursor, retry next trigger
    if (!res || res.limited || !Array.isArray(res.facts)) return;
    for (const f of res.facts) {
      // a correction rewrites its (snapshot-addressed) card; anything else is a new fact
      const target = typeof f.updates === 'number' && f.updates >= 1 && f.updates <= memSnapshot.length ? memSnapshot[f.updates - 1] : null;
      const kind = target ? updateFact(target, f.fact, f.kind, f.mood) : rememberFact(f.fact, f.kind, f.mood, 'calm');
      // stitch the "knit into Memory" tag onto the user line that revealed it.
      // Best-effort: a line already flushed to chat.jsonl keeps the tag only
      // until restart (store.ts appends finished turns and never rewrites).
      if (kind && typeof f.turn === 'number') {
        const m = state.chat[start + f.turn - 1];
        if (m && m.who === 'user') m.mem = kind;
      }
    }
    state.distilledUpTo = total;
    ctx.persist();
  } finally {
    busy = false;
  }
}
