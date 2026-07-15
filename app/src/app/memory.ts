// Memory rotation — shared by the golden weave and chat so the pet doesn't
// keep referencing the same (usually newest) fact all day. Both draw from ONE
// "used today" set: a memory brought up anywhere sits out until the day's
// rotation laps, then it can come round again. Resets each calendar day.
// Chat now always sends the FULL fact list too (dedupe + consistency); this
// rotation only picks which facts to flag as "bring one up" candidates.
import { ctx } from './context';
import type { MemoryFact } from '../types';

// Return up to n memory facts not yet fed to the LLM today, marking them used.
// Once every fact has been used today the rotation resets and laps. Empty when
// there are no memories at all (callers skip the personalized call then).
export function nextMemories(n: number): MemoryFact[] {
  const state = ctx.state;
  if (!state.usedMemory || state.usedMemory.date !== state.lastDate) {
    state.usedMemory = { date: state.lastDate, used: [] };
  }
  const all = state.memory;
  if (!all.length) return [];
  let unused = all.filter((m) => !state.usedMemory.used.includes(m.fact));
  if (!unused.length) { state.usedMemory.used = []; unused = all.slice(); } // lapped → reset today's rotation
  const pick = [...unused].sort(() => Math.random() - 0.5).slice(0, n);
  for (const m of pick) state.usedMemory.used.push(m.fact);
  return pick;
}
