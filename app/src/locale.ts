// Active UI/content language. The preference ('auto' | 'en' | 'zh') persists
// in AppState; 'auto' resolves against the system locale on every read, so an
// OS language change is picked up on the next launch without a stored value.
import type { Lang, LangPref } from './types';

let pref: LangPref = 'auto';

export function systemLang(): Lang {
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
}

export function setLangPref(p: LangPref): void {
  pref = p === 'en' || p === 'zh' ? p : 'auto';
  // Reflect the resolved language on the root element so CSS can size Chinese
  // handwriting down (see the html.zh rules in style.css) — CJK renders heavier
  // than Caveat at the same px. This is the one call boot and every switch flow
  // through, so the class always tracks the active language.
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('zh', lang() === 'zh');
  }
}

export function langPref(): LangPref {
  return pref;
}

// The resolved language every piece of text renders in right now.
export function lang(): Lang {
  return pref === 'auto' ? systemLang() : pref;
}

// Content-language check for the CJK handwriting trims. Stored text (cards,
// chat, memory) survives locale switches and the live reply follows whatever
// language the user typed, so anything that RENDERS such content sizes by the
// text itself — stamp zhClass() on the element — while pure UI copy keys off
// the root html.zh hook set above.
export function hasHan(s: string): boolean {
  return /[㐀-鿿]/.test(s);
}

export function zhClass(s: string): string {
  return hasHan(s) ? 'zh' : '';
}
