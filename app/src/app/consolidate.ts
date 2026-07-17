// ── periodic memory curation (POST /consolidate) ──
// Extraction only ever ADDS cards (or corrects one at write time — see
// distill.ts `updates`); nothing else keeps the quilt honest as it ages. This
// pass runs rarely, hands the WHOLE active fact list to a curator prompt, and
// applies the operations it returns: same-entity fragments merge into one
// richer card, aged wording gets refreshed, and a state recorded long ago that
// clearly passed retires to the attic (hidden from prompts, never deleted —
// re-affirming it in chat brings it back, see memory.ts rememberFact).
//
// An LLM editing the whole memory is the most dangerous call in the app, so
// every apply is belted:
//   · ops resolve against a pre-call snapshot by IDENTITY — cards added,
//     deleted or updated mid-flight simply don't match and the op is skipped
//   · a pass that would remove (retire + merge away) more than a third of the
//     list is rejected wholesale — no single reply may gut the quilt
//   · unknown refs / junk text skip the op; the server already caps at 6 ops
//   · retiring hides, never deletes; the user's own deletions are permanent
//     and nothing here resurrects them
// Triggers: weekly-ish on boot (≥ CADENCE_DAYS since the last pass and enough
// facts to be worth a call), or urgently when the list nears the eviction cap.
// A clean no-op pass still stamps consolidatedDay — "nothing to fix" answered
// this week's question.
import { lang } from '../locale';
import * as store from '../store';
import type { ConsolidateOpDto, MemoryFact, MemoryKind, MemoryMood } from '../types';
import { MEMORY_KIND_IDS } from '../content';
import { ctx, pp } from './context';

const CADENCE_DAYS = 7; // a curation pass at most once a week…
const MIN_FACTS = 15; // …and only once there's enough quilt to curate
const URGENT_AT = 55; // near the 60-cap eviction guillotine — curate NOW, on any day
const BOOT_DELAY_MS = 90_000; // after greet (0s) and the distill catch-up (45s)
const MAX_REMOVED_FRACTION = 1 / 3; // reject a pass gutting more than this

let busy = false;

export function initConsolidate(): void {
  setTimeout(() => void maybeConsolidate(), BOOT_DELAY_MS);
}

// Also called after a distill pass lands new facts (distill.ts), so a marathon
// day that races the list toward the cap gets curated without waiting for boot.
export async function maybeConsolidate(): Promise<void> {
  const state = ctx.state;
  const active = store.activeMemory(state);
  const weekly = state.day - (state.consolidatedDay || 0) >= CADENCE_DAYS && active.length >= MIN_FACTS;
  const urgent = active.length >= URGENT_AT;
  if (weekly || urgent) await runConsolidate();
}

async function runConsolidate(): Promise<void> {
  if (busy || !pp?.ai.consolidate) return; // no bridge (browser dev / older preload)
  const state = ctx.state;
  busy = true;
  try {
    // ops resolve against this snapshot by identity (see header)
    const snapshot = store.activeMemory(state);
    const res = await pp.ai.consolidate({
      day: state.day,
      lang: lang(),
      memory: snapshot,
    }).catch(() => null);
    // failed chain / offline / over budget → try again at the next trigger
    if (!res || res.limited || !Array.isArray(res.ops)) return;
    applyOps(snapshot, res.ops);
    state.consolidatedDay = state.day; // even 0 ops — a clean bill of health counts
    ctx.persist();
  } finally {
    busy = false;
  }
}

// a snapshot ref is usable if the card still sits in memory, un-retired and
// not already consumed by an earlier op this pass
function live(state: { memory: MemoryFact[] }, card: MemoryFact | undefined, used: Set<MemoryFact>): card is MemoryFact {
  return !!card && !card.retired && !used.has(card) && state.memory.includes(card);
}

function applyOps(snapshot: MemoryFact[], ops: ConsolidateOpDto[]): void {
  const state = ctx.state;
  const at = (n: number | undefined): MemoryFact | undefined =>
    typeof n === 'number' && n >= 1 && n <= snapshot.length ? snapshot[n - 1] : undefined;

  // Belt first: count how many cards this pass wants gone (retire targets +
  // merge sources). A curator gutting the quilt is a broken reply, not taste.
  const removed = ops.reduce((sum, o) => {
    if (o.op === 'retire') return sum + 1;
    if (o.op === 'merge') return sum + (o.from?.length || 0);
    return sum;
  }, 0);
  if (removed > Math.floor(snapshot.length * MAX_REMOVED_FRACTION)) return;

  const used = new Set<MemoryFact>(); // each card takes part in at most one op
  for (const o of ops) {
    if (o.op === 'retire') {
      const t = at(o.target);
      if (!live(state, t, used)) continue;
      // states expire; identity and standing facts don't — same whitelist the
      // server enforces (personas.ts RETIRABLE_KINDS), kept here as defense
      // in depth against an older deployed server
      if (!['feeling', 'goal', 'other'].includes(t.kind)) continue;
      t.retired = true;
      used.add(t);
    } else if (o.op === 'reword') {
      const t = at(o.target);
      const f = (o.fact || '').trim();
      if (!live(state, t, used) || !f) continue;
      t.fact = f;
      used.add(t);
    } else if (o.op === 'merge') {
      const into = at(o.into);
      if (!live(state, into, used)) continue;
      const from = (o.from || []).map(at).filter((c): c is MemoryFact => live(state, c, used) && c !== into);
      if (!from.length) continue;
      const f = (o.fact || '').trim();
      if (f) into.fact = f;
      if (o.kind && MEMORY_KIND_IDS.includes(o.kind as MemoryKind)) into.kind = o.kind as MemoryKind;
      if (o.mood) into.mood = o.mood as MemoryMood;
      into.day = Math.min(into.day, ...from.map((c) => c.day)); // when he FIRST learned of it
      for (const c of from) {
        c.retired = true; // merged away = attic, recoverable like any retirement
        used.add(c);
      }
      used.add(into);
    }
  }
}
