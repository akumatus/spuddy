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

- `buildNormalBatchPrompt(n, lang, genre)` — the shared, voice-neutral normal
  pool, **~180 lines total** (matches `CARDS_PER_DAY`), generated as a GENRE
  MIX: iterate `CARD_GENRES` in `personas.ts` and run **one focused pass of
  ~14 lines per genre pass**, honoring each genre's `weight` (currently
  sincere is `weight: 5` → five passes, ~40% of the pool; everything else
  one) — thirteen passes total across award / gossip / fieldnotes / stats /
  intel / dare / joke / scene / sincere. Distinct card forms are what make
  each tap feel like a
  fresh gacha pull — never collapse them into one long same-register dump.
  A genre that declares `angles` (currently sincere) additionally gets a
  fresh random sample of ~12 of them planted into each pass's prompt: most
  sampled angles get ONE line, none more than 2 (write a second line only
  when you have a genuinely different concrete situation for it — an angle
  is a direction to shoot from, never a sentence to restate), and draw a
  DIFFERENT sample per pass so the sincere passes don't circle the same few
  moves.
  Each genre's example lines are flavor anchors: match their craft, NEVER
  copy, translate, or lightly rephrase them into the pool, in either language
  — a line that reuses an anchor's image or skeleton is a reject (the server
  drops exact echoes, but near-copies are on you to catch). Follow every
  other rule in the prompt: opener quota, warm neutral potato voice, no
  fortune-cookie metaphors, avoid the `BANNED_PHRASES`. `/admin/put` dedupes
  and caps at `CARDS_PER_DAY`, so a little overshoot is fine.
- `buildBubblesPrompt(part, lang)` — the shared daily bubble pools, ONE
  voice-neutral set every persona serves (this REPLACED the old per-persona
  mutters — do not generate those anymore). Run it twice per language:
  `part = 'voice'` (idle mutters for all six moods + the ten routine step
  pools) and `part = 'social'` (speak greet/knock/delight, `hi` daypart
  greetings, poke/retap reactions, draw/weave lines, and the cardHint /
  sedentary / nightMsg / landing care lines). Follow the counts and moment descriptions
  spelled out in each prompt; the two JSON objects merge into one `bubbles`
  field.
- `buildFlavorPrompt(lang)` — per-persona FLAVOR lines, one small call covering
  all six personas: **4 mutters + 4 greetings each, in that persona's voice**.
  These ride in the POST body as `cards.<id>.flavor = { mutter, greet }`; the
  app mixes them into the shared pools at a low rate so buddies keep their
  accent.

For `zh`, write genuinely Chinese lines (not translated English) — the prompts
already carry the Chinese-language instructions; honor them. The two languages
are SEPARATE creative jobs: never translate or mirror the `en` batch into `zh`
(or vice versa), even loosely — with the other language's lines in context the
pull is strong, so draw fresh seeds and start each `zh` pass from a blank page.

Generate in a few focused passes rather than one giant dump — short batches keep
the variety up and stop the lines templating out toward the tail.

**Variety check before POSTing the normal pool:** three scans over the full
batch. (1) Opening words — if any single opener (especially "You"/"你") starts
more than ~20% of the batch, rewrite the excess lines to open elsewhere: the
deed, the moment, an object, a question, a number, the potato itself. (2)
Pet-word concentration — count content-word frequencies in the batch you just
wrote and look at the top repeats, whatever they turn out to be; any
distinctive word or image anchoring more than ~4 lines gets its extra
occurrences rewritten in fresh words. Do NOT keep a blacklist of past
offenders — yesterday's pet word is a perfectly good word at normal frequency;
the defect is concentration, not the word, and banning words outright just
deletes good vocabulary. (3) Same-point scan — this is the one users actually
feel: repetition of MEANING. The genre passes run independently, so the same
point can arrive wearing three different costumes (a dare, a field note, and a
stat can all deliver the identical self-care nudge), and the server only
dedupes near-identical TEXT — paraphrases are yours to catch. Read the batch
as one deck: whenever two lines are interchangeable in meaning, keep the
strongest and re-ground the others in different concrete situations, or cut
them (a slightly short pool beats a samey one).

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
`quotes` array — that's the current library. Generate **~60 NEW lines per
language** that are NOT already in it (the server also dedupes, but don't waste
the effort). Spread across categories (film / series / book / speech / internet)
and eras so the library stays varied as it grows. Genuinely-famous lines are a
finite well: if a run struggles to find that many that are both real and new,
add fewer rather than inventing or stretching — quality bar over hitting 60.

## Assemble & POST — two calls per language

### Batch → `POST /admin/put?lang=<lang>`

```json
{
  "normal": ["…180 neutral lines…"],
  "bubbles": {
    "mutter":   { "watch": ["…20…"], "alone": ["…20…"], "lonely": ["…20…"], "sleepy": ["…4…"], "ignored": ["…4…"], "wake": ["…4…"] },
    "routines": { "chaseStart": ["…10…"], "chaseEnd": ["…10…"], "juggleEnd": ["…10…"], "studyStart": ["…10…"], "studyEnd": ["…10…"], "practiceStart": ["…10…"], "practiceEnd": ["…10…"], "humEnd": ["…10…"], "stretchEnd": ["…10…"], "sneezeEnd": ["…10…"] },
    "speak":    { "greet": ["…12…"], "knock": ["…8…"], "delight": ["…4…"] },
    "hi":       { "morning": ["…2…"], "afternoon": ["…2…"], "evening": ["…2…"], "night": ["…2…"] },
    "poke": ["…8…"], "retap": ["…8…"], "drawLines": ["…8…"], "weaveLines": ["…4…"],
    "cardHint": ["…4…"], "sedentary": ["…4…"], "nightMsg": ["…2…"], "landing": ["…4…"]
  },
  "cards": {
    "spud":  { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } },
    "taco":  { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } },
    "donut": { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } },
    "bloom": { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } },
    "mochi":   { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } },
    "grad":  { "flavor": { "mutter": ["…4…"], "greet": ["…4…"] } }
  }
}
```

Worker rules on receipt: each line 4–199 chars, near-dups collapse, empty fields
keep last run's value (never-clobber, per bubbles group too). No `golden` field;
a legacy `cards.<id>.mutters` field is still accepted but no longer needed.

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
