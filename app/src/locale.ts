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
}

export function langPref(): LangPref {
  return pref;
}

// The resolved language every piece of text renders in right now.
export function lang(): Lang {
  return pref === 'auto' ? systemLang() : pref;
}
