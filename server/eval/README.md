# Memory-extraction eval

Turns "does the pet's memory feel worse?" into a number. Replays a hand-verified
conversation through the **real** chat pipeline — the same `buildChatSystem`
prompt and provider chain the Worker uses — and scores which durable facts the
model chose to `[[remember]]` against a ground-truth fixture.

Use it to check any prompt change before shipping: if recall drops or junk
extractions appear, you see it here instead of in users' memory quilts.

## Run

```bash
npm run eval                              # chat mode, prod model (openai/gpt-5.6-luna), 1 sample
npm run eval -- --mode distill            # batch /distill path instead of in-reply notes
npm run eval -- --samples 3               # 3 replays, per-fact hit-rate averaged (temp is nonzero)
npm run eval -- --provider anthropic      # score on Claude instead
npm run eval -- --fixture 2026-07-16-heavy --out eval/out/new.json
```

Modes mirror the two extraction paths: `chat` replays turn by turn and parses
the reply's `[[remember]]` note (what pre-distill app builds get); `distill`
replays in backstop-sized chunks through `buildDistillSystem` (the batch path —
worst-case chunking, since lull boundaries can't be simulated without
timestamps). A distill sample is ~3 calls instead of ~33.

Needs `server/.dev.vars` (the same keys `wrangler dev` uses). Calls the LLM
directly — **no Worker, no per-device quota** — but it does spend real API
tokens on the chosen provider's key: ~1 call per user turn per sample (the
`2026-07-16-heavy` fixture is 33 user turns, so `--samples 3` ≈ 99 calls).

Provider/model default to what production runs (read from `wrangler.toml`
`[vars]`), so the score reflects the live experience. `run.mjs` is a build
artifact (git-ignored); `npm run eval` rebuilds it from `memory-eval.ts`.

## A/B a prompt change (old vs new)

The harness scores whatever prompt is currently in `src/personas.ts`. To compare
your working-tree change against what's committed:

```bash
npm run eval -- --out eval/out/new.json               # 1) your change
git stash push -- src/personas.ts                     # 2) revert to HEAD
npm run eval -- --out eval/out/old.json               # 3) baseline
git stash pop                                          # 4) restore your change
# eyeball the two reports, or diff the JSON recall/perExpect fields
```

Hold `--provider`/`--samples` fixed across both runs — an eval only means
something with the model held constant.

## Reading the report

- **RECALL** — fraction of expected facts caught at least once. The headline.
- **per-fact hit-rate** — across samples; `~ flaky` means the model catches it
  some runs but not others (raise `--samples` to see how often).
- **PRECISION** — extractions matching an `avoid` pattern (transient moods,
  small talk, general-knowledge Q&A) that should have been skipped.
- **NOVEL** — extractions matching no expected id: either a real fact the
  fixture forgot, or a mis-record. Always eyeball these.
- **verbatim dump** — every extraction, so the regex scorer can't silently
  mis-credit. Trust this over the bars when they disagree.

## Fixtures

`fixtures/` is **git-ignored** — fixtures are built from real conversations and
stay on your machine only. The harness ships without them; create your own to
run it (the baseline below was measured against a private one).

`fixtures/<name>.json`:

- `turns` — the exact transcript (`{who: user|pet, text}`), replayed in order.
- `expect[]` — facts a good extractor should end up with. `any` is a list of
  regexes; an extraction credits the fact if any pattern matches (case-insensitive).
- `avoid[]` — things it should NOT record. Checked only against extractions that
  matched no `expect` id, so shared tokens (e.g. 空调) don't double-count.

Replay is faithful: at each user turn the model sees the **real** prior transcript
plus the memory accumulated from earlier extractions this run (the app's
"already known" list), then generates a reply we parse for its `[[remember]]`
note. Real pet replies drive context for later turns, so reply drift never
compounds.

To add a fixture, curate a real or synthetic conversation, hand-label `expect`
and `avoid`, and drop it in `fixtures/`. Keep a heavy one (safety-mode replies,
facts buried in small talk) — that's where extraction is hardest.

## Baseline (2026-07-16)

`2026-07-16-heavy`, openai/gpt-5.6-luna, 1 sample each:

| path | recall | precision | notes |
|---|---|---|---|
| in-reply, pre-discipline-fix | 45% (5/11) | clean | missed the whole heavy stretch + the milestone |
| in-reply, widened rules | 91% (10/11) | clean | "new AC" flaky; held at 91% after the shared-rules refactor |
| batch /distill | **100% (11/11)** | clean | 9 tight cards — related details merge (gecko name+age, milestone+name) |

The batch path also sheds ~760 prompt tokens from every chat call (the reply
prompt drops its extraction rules when the app sends `distill: true`), and it
reads whole chunks at once — reply-writing pressure, safety-mode replies, and
the one-note-per-reply cap no longer suppress extraction.
