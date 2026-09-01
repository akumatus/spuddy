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

There are THREE kinds of content, handled differently:

1. **The daily batch** (small dare/joke normal pool + bubbles + flavor) —
   REPLACED each day; the only part you WRITE yourself.
2. **The famous-quote library** (golden-card source) — APPENDED daily with the
   HIGH-provenance finds: real lines with real attributions (§2).
3. **The internet-line pool** (normal-card ambient source) — APPENDED daily
   with the hunt's NO-SOURCE finds, gated by §3: only lines search-VERIFIED to
   actually circulate, evidence logged. Never AI-written, never a dumping
   ground for unverifiable rejects.

§2 and §3 are one daily hunt with a quality SORT: gather ~60 lines per
language, then route each by attribution — never pad either pool to hit a
number, and never route a line up to golden that only qualifies for inet.

### 1. Daily batch — per language (`en` then `zh`)

Read the **exact current prompts and persona voices** from
[`server/src/personas.ts`](../src/personas.ts) so the register never drifts:

- `buildNormalBatchPrompt(n, lang, genre)` — the shared, voice-neutral normal
  pool, now just **~42 lines total** (matches `CARDS_PER_DAY`): **one focused
  pass of ~14 lines per `CARD_GENRES` genre** — currently **dare + joke +
  sincere**, kept in the 2026-07 quality cut. Sincere runs ONE lean pass (not
  its old five): the ambient-encouragement bulk now comes from the persistent
  internet-line pool (§3), which the app mixes in on its own. The six cut skit
  genres (award/gossip/fieldnotes/stats/intel/scene) stay cut — never write
  them back into the batch.
  Sincere declares `angles`: a fresh random sample of ~12 gets planted into
  its pass's prompt — most sampled angles get ONE line, none more than 2
  (write a second line only for a genuinely different concrete situation; an
  angle is a direction to shoot from, never a sentence to restate), and the
  sample differs day to day so the pass doesn't circle the same few moves.
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

**Variety check before POSTing the normal pool:** three scans over the batch.
(1) Opening words — if any single opener (especially "You"/"你") starts more
than ~20% of the batch, rewrite the excess lines to open elsewhere: the deed,
the moment, an object, a question, a number, the potato itself. (2) Pet-word
concentration — count content-word frequencies in the batch you just wrote and
look at the top repeats, whatever they turn out to be; any distinctive word or
image anchoring more than ~3 lines gets its extra occurrences rewritten in
fresh words. Do NOT keep a blacklist of past offenders — yesterday's pet word
is a perfectly good word at normal frequency; the defect is concentration, not
the word. (3) Same-point scan — repetition of MEANING: the two passes run
independently, so a dare and a joke can deliver the identical nudge, and the
server only dedupes near-identical TEXT — paraphrases are yours to catch.
Whenever two lines are interchangeable in meaning, keep the stronger and
re-ground the other in a new concrete situation, or cut it (a slightly short
pool beats a samey one).

### 2. Famous-quote library — per language (`en` then `zh`)

The golden card is a QUOTE card: **real, verifiable famous lines from literary
masters, novels, films and series** (plus the occasional genuinely famous
speech) — NOT invented encouragement. Quality bar: the reader should feel they
discovered a line worth screenshotting — never "I've seen this on a classroom
wall". Match the curated static pools at
[`app/src/quotes.en.ts`](../../app/src/quotes.en.ts) and
[`app/src/quotes.zh.ts`](../../app/src/quotes.zh.ts).

Hard rules — each of these is a category that rotted the old pool
(cleaned 2026-07: zh 1000→304, en 1000→677):

- **Every line carries `s`** — a real, specific attribution: an author (三毛,
  Maya Angelou), a work (《小王子》, The Little Prince), or a named speech. NO
  sourceless lines. If the only honest tag would be 网络/佚名/internet/
  Anonymous, this line is an internet-pool CANDIDATE, not a golden — send it
  through §3's verification gate: verified circulating → `/admin/inet`,
  unverifiable → dropped.
- **No proverbs or folk sayings** (俗语/谚语/歇后语, "Proverb"), no bare 成语.
- **zh: no classical Chinese at all** — 古诗词 AND 文言/古籍 (论语/孟子/老子/
  庄子/荀子/增广贤文 and the whole textbook canon). Every Chinese reader saw
  these on primary-school walls; zero discovery value.
- **No schoolroom-wall slogans** even when attributed (书籍是人类进步的阶梯 /
  让暴风雨来得更猛烈些吧 tier); no political-figure quotes.
- **No adaptations/mutations** of famous quotes and no apocryphal attributions
  (哈佛图书馆训言 tier). Unsure the person/work really said it → skip it.
- One short warm/uplifting line each; reads well on a tiny card. NO song
  lyrics. Attribution by common usage, not scholarship — but common usage
  naming a real person/work, never a shrug-label.
- Formatting: zh work titles wrapped 《…》, people bare (三毛 not 《三毛》);
  en full names (Martin Luther King Jr., not MLK); `s` under ~24 chars.

**Avoid repeats and pile-ups.** First fetch the FULL libraries (both pools,
one call):

```sh
curl -sS "$PP_SERVER_URL/admin/quotes?lang=<lang>" -H "x-pp-admin: $PP_ADMIN_TOKEN"
```

(`GET /cards` won't do — it serves only a small daily window of each pool.)
Then, against the `quotes` array:

- skip any line already there — **including paraphrases**: the server dedupes
  exact text only, so a reworded variant of a stored line is a reject on you;
- count lines per source: a source already holding **8+** lines is closed for
  today — pick someone else. Spread new lines across sources and eras.

**The daily hunt gathers ~60 lines per language** — FOUND lines (web search is
your friend), spread across film / series / book / speech / internet-era. Then
SORT each line by provenance:

- real, specific attribution + passes every hard rule above → **golden**
  (`/admin/quotes`). Whatever count genuinely qualifies is the right count —
  often 10–20; never stretch a line's attribution to promote it.
- no meaningful attribution, but **search-VERIFIED actually circulating** on
  the internet per §3's rules (seen quoted by real people; evidence logged) →
  **the internet-line pool** (`/admin/inet`, §3), posted as plain lines
  WITHOUT any source label.
- everything else → **dropped**. The line between inet and the bin is
  VERIFICATION, never how good a line reads: a line you cannot show exists
  outside your own output is dropped, along with rule-breakers (proverbs,
  classical, slogans, mutations of attributed quotes). "Reads well, demote it"
  is exactly the rule that rotted the pool in 2026-08 — it stays dead.

### 3. Internet-line pool — SEARCH-VERIFIED internet finds only

> **MAINTAINER-LOCKED RULES.** The verification gate in this section (and
> §2's verification-gated sort) exists because this pool has rotted before —
> most recently via commit fd47f2a, where a working session "helpfully"
> loosened the sort to "demote golden rejects instead of dropping" and the
> pool filled with model-written filler within a month. No session may weaken,
> reinterpret, or add exceptions to these rules without an explicit, quoted
> instruction from the maintainer. When in doubt: drop the line.

The persistent pool behind the normal card's ambient encouragement (`inet:zh` /
`inet:en` in KV, served as `inet` on `GET /cards`; capped `INET_LIB_MAX`).
These are QUOTE-GRADE lines, golden's equal in quality — the only difference
is provenance: they circulate on social media (微博/豆瓣/小红书/网易云,
Tumblr/Instagram/X …) with no one author to credit. They are **collected from
the internet, never authored by you**. Seeded from
[`server/scripts/internet-lines.zh.txt`](internet-lines.zh.txt) /
[`internet-lines.en.txt`](internet-lines.en.txt); the maintainer can hand-add
or prune anytime.

Hard rules — this pool rotted once (2026-08: a month of daily quota-hunting
filled it with model-written filler and the old cap rolled the human-curated
seed out entirely; these rules are the fix):

- **Search-verified or nothing.** A line may be POSTed ONLY if you actually
  found it TODAY via web search (WebSearch/WebFetch) and saw it genuinely
  circulating — quoted by real people in real posts, not conjured by one
  AI-written listicle. Recalling a line "from memory" does NOT count; memory
  is exactly how the filler got in.
- **Log the evidence.** Every added line goes into the daily report with
  where you saw it (platform + page). An add without a citation is a bug.
- **No quota, either direction.** The day's count is however many lines
  genuinely passed verification — typically a handful, often zero, and an
  empty day is healthy: skip the `/admin/inet` call entirely rather than pad.
  Equally, never trim a day that verified more; verification IS the cap.
- Same bans as golden: no 俗语/谚语/proverbs, no classical Chinese, no
  schoolroom slogans — and NO mutations of attributed famous quotes: golden's
  attribution-rejects are dropped in §2's sort, never laundered into here.
- Dedupe first: check the full `inet` array from the same `GET /admin/quotes`
  answer (§2) and skip anything already present, paraphrases included.

POST as plain lines without any source label:
`POST /admin/inet?lang=<lang>` with `{ "lines": ["…", …] }`.

## Assemble & POST — three calls per language

### Batch → `POST /admin/put?lang=<lang>`

```json
{
  "normal": ["…~42 lines: one pass each of dare, joke, sincere…"],
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
{ "quotes": [ { "q": "After all, tomorrow is another day.", "s": "Gone with the Wind" }, { "q": "家人闲坐，灯火可亲。", "s": "汪曾祺" } ] }
```

The Worker appends these to the growing library, dropping any already present,
rejecting sourceless lines and junk labels (网络/俗语/Proverb/Anonymous …), and
trimming the oldest past `QUOTES_LIB_MAX`.

### Internet lines → `POST /admin/inet?lang=<lang>`

```json
{ "lines": [ "先吃饭，天大的事，吃完再说。", "进度条卡住的时候，其实也在加载。" ] }
```

Plain strings, no attributions. The Worker appends, dedupes against the pool,
and trims the oldest past `INET_LIB_MAX`.

### The curl calls (one set per language)

```sh
curl -sS -X POST "$PP_SERVER_URL/admin/put?lang=en" \
  -H "content-type: application/json" -H "x-pp-admin: $PP_ADMIN_TOKEN" \
  --data @/tmp/pool-en.json
curl -sS -X POST "$PP_SERVER_URL/admin/quotes?lang=en" \
  -H "content-type: application/json" -H "x-pp-admin: $PP_ADMIN_TOKEN" \
  --data @/tmp/quotes-en.json
curl -sS -X POST "$PP_SERVER_URL/admin/inet?lang=en" \
  -H "content-type: application/json" -H "x-pp-admin: $PP_ADMIN_TOKEN" \
  --data @/tmp/inet-en.json
# then the same three with ?lang=zh and the zh files
```

Successes look like `{"ok":true,"lang":"en","date":"…","counts":{…}}` (batch) and
`{"ok":true,"lang":"en","added":N,"total":M}` (quotes and inet). Read them back
and report: per language, the normal count, per-persona mutter totals, and the
`added` / new `total` for BOTH quotes and inet. If any POST returns non-200, or
a count is 0 where it shouldn't be, say so — don't fail silently.
