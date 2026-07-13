# Spuddy card-pool generation playbook

This is the script a **scheduled Claude Code routine** follows to knit the daily
card pools on the maintainer's Claude membership — instead of the Worker cron
spending API tokens. Claude itself is the generator here: it writes the lines,
assembles the JSON, and POSTs it to the Worker's `/admin/put` inbox. The Worker
does no LLM work on that path, so it costs nothing against the API budget.

The Worker cron (`POST /admin/generate`, API-based) stays as a fallback for days
this routine doesn't run — so a missed run never leaves the pools empty.

## Inputs (from the routine's environment)

- `PP_SERVER_URL` — the Worker base URL, e.g. `https://api.cherry.surf`
- `PP_ADMIN_TOKEN` — the Worker's `ADMIN_TOKEN` secret (the `x-pp-admin` header)

Never hard-code the token in this file or the routine prompt — read it from the
env. If either var is missing, stop and report it; do not POST.

There are TWO kinds of content, generated and POSTed differently:

1. **The daily batch** (normal pool + mutters) — REPLACED each day.
2. **The famous-quote library** (golden-card source) — APPENDED to a growing
   server library; you add a few genuinely new lines each day.

### 1. Daily batch — per language (`en` then `zh`)

Read the **exact current prompts and persona voices** from
[`server/src/personas.ts`](../src/personas.ts) so the register never drifts:

- `buildNormalBatchPrompt(n, lang)` — the shared, voice-neutral normal pool.
  Generate **~72 lines** (matches `CARDS_PER_DAY`). Follow every rule in that
  prompt: warm neutral potato voice, no character quirks, no pet names, no
  fortune-cookie metaphors, avoid the `BANNED_PHRASES`, vary sentence shapes.
- `buildMutterPrompt(persona, n, lang)` — per-persona idle mutters, in that
  character's voice, split across the three moods `watch` / `alone` / `lonely`.
  Do this for **all six personas** (`spud, taco, donut, bloom, leo, grad` — the
  `CHAT_IDS`), **~16 lines per mood** (matches `MUTTERS_PER_DAY`).

For `zh`, write genuinely Chinese lines (not translated English) — the prompts
already carry the Chinese-language instructions; honor them.

Generate in a few focused passes rather than one giant dump — short batches keep
the variety up and stop the lines templating out toward the tail.

### 2. Famous-quote library — per language (`en` then `zh`)

These are **real famous lines** from films, series, books, speeches, and the
internet — NOT invented encouragement. Match the house rules and quality bar of
the curated static pools at
[`app/src/quotes.en.ts`](../../app/src/quotes.en.ts) and
[`app/src/quotes.zh.ts`](../../app/src/quotes.zh.ts):

- one short warm/uplifting line each; reads well on a tiny card
- `{ "q": "the line", "s": "attribution" }` — omit `s` for internet-era lines
  with no meaningful source; keep `s` under ~24 chars
- NO song lyrics; NO classical Chinese poetry (古诗词) in the zh set
- attribution by common usage, not scholarship — charm over citation accuracy

**Avoid repeats.** First `GET $PP_SERVER_URL/cards?lang=<lang>` and read its
`quotes` array — that's the current library. Generate **~30 NEW lines per
language** that are NOT already in it (the server also dedupes, but don't waste
the effort). Spread across categories (film / series / book / speech / internet)
and eras so the library stays varied as it grows.

## Assemble & POST — two calls per language

### Batch → `POST /admin/put?lang=<lang>`

```json
{
  "normal": ["…72 neutral lines…"],
  "cards": {
    "spud":  { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } },
    "taco":  { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } },
    "donut": { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } },
    "bloom": { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } },
    "leo":   { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } },
    "grad":  { "mutters": { "watch": ["…"], "alone": ["…"], "lonely": ["…"] } }
  }
}
```

Worker rules on receipt: each line 4–199 chars, near-dups collapse, empty fields
keep last run's value (never-clobber). No `golden` field.

### Quotes → `POST /admin/quotes?lang=<lang>`

```json
{ "quotes": [ { "q": "After all, tomorrow is another day.", "s": "Gone with the Wind" }, { "q": "…internet line, no source…" } ] }
```

The Worker appends these to the growing library, dropping any already present and
trimming the oldest past `QUOTES_LIB_MAX`.

### The curl calls (one set per language)

```sh
curl -sS -X POST "$PP_SERVER_URL/admin/put?lang=en" \
  -H "content-type: application/json" -H "x-pp-admin: $PP_ADMIN_TOKEN" \
  --data @/tmp/pool-en.json
curl -sS -X POST "$PP_SERVER_URL/admin/quotes?lang=en" \
  -H "content-type: application/json" -H "x-pp-admin: $PP_ADMIN_TOKEN" \
  --data @/tmp/quotes-en.json
# then the same two with ?lang=zh and the zh files
```

Successes look like `{"ok":true,"lang":"en","date":"…","counts":{…}}` (batch) and
`{"ok":true,"lang":"en","added":N,"total":M}` (quotes). Read them back and report:
per language, the normal count, per-persona mutter totals, and how many quotes
were `added` / the new `total`. If any POST returns non-200, or a count is 0 where
it shouldn't be, say so — don't fail silently.
