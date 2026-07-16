// Memory rotation — shared by the golden weave and chat so the pet doesn't
// keep referencing the same (usually newest) fact all day. Both draw from ONE
// "used today" set: a memory brought up anywhere sits out until the day's
// rotation laps, then it can come round again. Resets each calendar day.
// Chat now always sends the FULL fact list too (dedupe + consistency); this
// rotation only picks which facts to flag as "bring one up" candidates.
import { MEMORY_KIND_IDS } from '../content';
import * as store from '../store';
import { ctx } from './context';
import type { MemoryFact, MemoryKind, MemoryMood } from '../types';

// Return up to n memory facts not yet fed to the LLM today, marking them used.
// Once every fact has been used today the rotation resets and laps. Empty when
// there are no memories at all (callers skip the personalized call then).
export function nextMemories(n: number): MemoryFact[] {
  const state = ctx.state;
  if (!state.usedMemory || state.usedMemory.date !== state.lastDate) {
    state.usedMemory = { date: state.lastDate, used: [] };
  }
  const all = store.activeMemory(state); // attic cards never rotate back up
  if (!all.length) return [];
  let unused = all.filter((m) => !state.usedMemory.used.includes(m.fact));
  if (!unused.length) { state.usedMemory.used = []; unused = all.slice(); } // lapped → reset today's rotation
  const pick = [...unused].sort(() => Math.random() - 0.5).slice(0, n);
  for (const m of pick) state.usedMemory.used.push(m.fact);
  return pick;
}

// ── storing a distilled fact ──
// Shared by both extraction paths: the batch /distill pass (distill.ts) and
// the legacy in-reply [[remember]] note (chat.ts, kept for old servers). Store
// once, skipping near-duplicates: models re-surface the same fact across
// conversations, often re-told with extra detail or reworded, so dedupe is by
// store.factTwin (containment + bigram paraphrase match) rather than equality.
//
// Returns the category the fact was filed under (or null when skipped as
// junk / a near-duplicate), so the caller can tag the message that revealed
// it. Mood (sunny/rainy/plain — the quilt's patch color) is the model's own
// stamp; when it skipped one, `fallbackTag` colors it from the reply's emotion
// tag: [comfort] means they were down → rainy, a celebrating [cheer]/[proud]
// reads sunny, and a [calm] reply keeps the patch plain.
// Junk guard, script-aware: dense CJK facts are legitimately tiny ("养了狗",
// "怀孕了" — the zh prompt omits subjects), so only empty/single-char
// fragments are junk there; Latin under 4 chars ("ok") always is. Silently
// dropping a real memory costs more than letting an odd card through.
function junkFact(f: string): boolean {
  const latin = (f.match(/[a-z]/gi) || []).length > f.length / 2;
  return f.length < (latin ? 4 : 2);
}

export function rememberFact(fact: string, kind: string | undefined, mood: MemoryMood | null | undefined, fallbackTag: string): MemoryKind | null {
  const state = ctx.state;
  const f = (fact || '').trim();
  if (junkFact(f)) return null;
  const k: MemoryKind = MEMORY_KIND_IDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'other';
  const md = mood || (fallbackTag === 'comfort' ? 'rainy' : fallbackTag === 'cheer' || fallbackTag === 'proud' ? 'sunny' : 'plain');
  const twin = state.memory.find((m) => store.factTwin(m.fact, f));
  if (twin) {
    // saying a retired fact again brings it down from the attic — they
    // re-affirmed it, so consolidation's "long passed" call no longer holds
    if (twin.retired) {
      twin.retired = false;
      twin.fact = store.normFact(f).length > store.normFact(twin.fact).length ? f : twin.fact;
      return twin.kind;
    }
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

// Apply a /distill "updates" correction: the chunk showed an existing card is
// outdated (a pet passed away, a job changed) — rewrite that card in place so
// no stale twin lingers beside the truth. day stays: it marks when he first
// learned OF the thing, not its latest state. kind/mood keep the card's own
// values unless the correction supplies valid ones. `target` is the card from
// the pre-call snapshot; if the user deleted it mid-flight (Book), the
// correction is stored as a plain new fact instead.
export function updateFact(target: MemoryFact, fact: string, kind: string | undefined, mood: MemoryMood | null | undefined): MemoryKind | null {
  const state = ctx.state;
  if (!state.memory.includes(target)) return rememberFact(fact, kind, mood, 'calm');
  const f = (fact || '').trim();
  if (junkFact(f)) return null;
  const k: MemoryKind = MEMORY_KIND_IDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : target.kind;
  target.fact = f;
  target.kind = k;
  target.mood = mood || target.mood;
  return k;
}
