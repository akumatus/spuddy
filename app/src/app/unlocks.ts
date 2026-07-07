// ── unlocks (2a rules) ──
import { CHARS, UNLOCK } from '../content';
import { sfx } from '../sfx';
import * as store from '../store';
import { confettiBurst } from '../ui/effects';
import { $, ctx } from './context';
import { bubble } from './speech';

export function checkUnlocks(): void {
  const state = ctx.state;
  const cts = store.counts(state);
  const newly = CHARS.filter((ch) => {
    const d = UNLOCK[ch.id];
    return d && !state.unlockedIds.includes(ch.id) && cts[d.key] >= d.n;
  });
  if (!newly.length) return;
  state.unlockedIds = state.unlockedIds.concat(newly.map((c) => c.id));
  state.buddyNew = true;
  sfx.chime();
  ctx.anim().playCheer();
  confettiBurst();
  bubble(`Unlocked: ${newly.map((c) => c.name).join(' & ')}! Say hi in Buddies.`, { hold: 4200 });
  store.save(state);
  $('buddiesDot').classList.remove('hidden');
}
