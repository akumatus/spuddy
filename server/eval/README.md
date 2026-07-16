# Memory-extraction eval

Turns "does the pet's memory feel worse?" into a number. Replays a hand-verified
conversation through the **real** chat pipeline — the same `buildChatSystem`
prompt and provider chain the Worker uses — and scores which durable facts the
model chose to `[[remember]]` against a ground-truth fixture.

Use it to check any prompt change before shipping: if recall drops or junk
extractions appear, you see it here instead of in users' memory quilts.

## Run

```bash
npm run eval                              # new prompt, prod model (openai/gpt-5.6-luna), 1 sample
npm run eval -- --samples 3               # 3 replays, per-fact hit-rate averaged (temp is nonzero)
npm run eval -- --provider anthropic      # score on Claude instead
npm run eval -- --fixture 2026-07-16-heavy --out eval/out/new.json
```

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

`2026-07-16-heavy`, openai/gpt-5.6-luna, 1 sample — the change that widened
extraction discipline (a fact buried in small talk / a heavy conversation still
counts; a family member's milestone counts):

| prompt | recall | precision |
|---|---|---|
| deployed (HEAD) | 45% (5/11) | clean |
| this change | 91% (10/11) | clean |

The deployed prompt missed the entire heavy stretch (postpartum, in-laws, the
dialect barrier, the husband-as-relay) and the daughter's milestone; the change
catches all of them with no new junk. The lone remaining miss ("got a new AC")
is flaky on both — a genuinely trivial fact.

## Extending to the batch extractor (plan A)

When memory extraction moves out of the chat reply into its own call, keep this
fixture and scorer; swap only the "how facts are produced" step in
`memory-eval.ts` (`replay()`) for a call to the new endpoint. The ground truth
and the numbers stay comparable across the architecture change.
