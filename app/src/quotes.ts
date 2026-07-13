// The famous-quote pool the golden card draws from. Prefer the server's growing
// library (today's batch, daily-refreshed via /admin/quotes); fall back to the
// static pool bundled with the app (quotes.en.ts / quotes.zh.ts) when offline or
// before the first batch lands. Either way it's picked by the active language.
import { lang } from './locale';
import { QUOTES_EN } from './quotes.en';
import { QUOTES_ZH } from './quotes.zh';
import { serverQuotes } from './remote';
import type { Quote } from './types';

export function quotesPool(): Quote[] {
  return serverQuotes() || (lang() === 'zh' ? QUOTES_ZH : QUOTES_EN);
}

