// ── language switching, shared by the ⚙ settings panel and the tray menu ──
// Persists the preference, re-renders everything static, and lets registered
// listeners (chrome titles, the settings panel itself) refresh in place.
import { greet } from '../content';
import { lang, langPref, setLangPref } from '../locale';
import * as remote from '../remote';
import * as store from '../store';
import type { LangPref } from '../types';
import { closeOverlay, isOverlayOpen } from '../ui/overlay';
import { ctx, pp } from './context';
import { bubble } from './speech';

const listeners: (() => void)[] = [];

// Register a refresher that runs after every language change (and once you
// call it yourself at boot — applyLangPref only fires on actual switches).
export function onLangChange(fn: () => void): void {
  listeners.push(fn);
}

export function applyLangPref(pref: LangPref): void {
  if (pref === langPref()) return; // no-op guard: tray echo / re-click of the active pill
  ctx.state.lang = pref;
  setLangPref(pref);
  store.save(ctx.state);
  if (isOverlayOpen()) closeOverlay(); // popups re-render in the new language on next open
  ctx.updateCardScreen();
  remote.refresh(); // re-pull the daily pool in the new language
  for (const fn of listeners) fn();
  pp?.lang?.report(pref, lang()); // tray checkmark + localized tray labels
  // the design has him speak along with the switch — his hello, in the new language
  bubble(greet(ctx.state.active), { hold: 3600 });
}
