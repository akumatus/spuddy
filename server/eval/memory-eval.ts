// Memory-extraction regression eval (plan "B").
//
// Replays a hand-verified conversation through the REAL chat pipeline — the same
// buildChatSystem prompt and provider chain the Worker uses — and scores which
// durable facts the model chose to [[remember]] against a ground-truth fixture.
// The point: turn "does memory feel worse?" into a number, so every prompt tweak
// can be measured instead of eyeballed.
//
// It calls buildChatSystem + callLLMChain directly (no Worker, no quota), using
// the keys in server/.dev.vars. Model/provider default to what production runs
// so the score reflects the live experience; override with --provider/--model.
//
// Faithful replay: at each user turn we feed the model the REAL prior transcript
// (the actual pet replies that happened) plus the memory accumulated SO FAR from
// earlier extractions — exactly what the app sends. We generate a reply only to
// harvest its trailing [[remember]] note; the real transcript drives context for
// the next turn, so reply drift never compounds. Temperature is nonzero, so pass
// --samples N to average the per-fact hit rate over N independent replays.
//
//   node eval/run.mjs                                 # new prompt, prod model, 1 sample
//   node eval/run.mjs --samples 3                     # 3 replays, averaged
//   node eval/run.mjs --provider anthropic            # test on Claude instead
//   node eval/run.mjs --fixture 2026-07-16-heavy      # pick a fixture
//   node eval/run.mjs --out eval/out/new.json         # also dump JSON for A/B diff
//
// A/B a prompt change: run once on the working tree, `git stash` the prompt file,
// run again, `git stash pop`, diff the two --out files (see eval/README.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PERSONAS, buildChatSystem, buildDistillSystem, distillTranscript, parseDistillFacts, parseTag, parseGesture, parseRemember } from '../src/personas';
import { callLLMChain } from '../src/providers';
import type { Env, ChatPayload, DistillPayload } from '../src/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── ground-truth fixture shape ──
interface ExpectFact { id: string; kind: string; desc: string; any: string[] }
interface AvoidFact { id: string; desc: string; any: string[] }
interface Fixture {
  name: string;
  note?: string;
  charId: string;
  lang: string;
  day: number;
  expect: ExpectFact[];
  avoid: AvoidFact[];
  turns: { who: string; text: string }[];
}

// One extracted fact from one replay: what the model chose to keep, and where.
interface Extraction { turn: number; kind: string; mood: string | null; fact: string }

// ── args ──
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Load server/.dev.vars (KEY=value lines) into a plain object we can pass as Env.
// Inject the [vars] model default that lives in wrangler.toml, not .dev.vars, so
// a bare --provider openai resolves the same model production would.
function loadEnv(provider: string): Env {
  const env: Record<string, string> = {};
  const raw = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  // wrangler.toml [vars] defaults the eval should mirror (not in .dev.vars)
  const varDefaults: Record<string, string> = {
    OPENAI_MODEL: 'gpt-5.6-luna',
    ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    GEMINI_MODEL: 'gemini-3.1-flash-lite',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
  };
  for (const [k, v] of Object.entries(varDefaults)) if (!env[k]) env[k] = v;
  env.CHAT_PROVIDER = provider;
  return env as unknown as Env;
}

// case-insensitive, multiline regex match of any pattern against a fact string
function matchesAny(fact: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try { return new RegExp(p, 'i').test(fact); } catch { return fact.includes(p); }
  });
}

// Replay the whole conversation once, returning every fact the model extracted.
// Mirrors the app: memory accumulates and is fed back into later turns as the
// "already known" list, so the model sees the same de-dupe context it sees live.
async function replay(env: Env, chain: string[], fx: Fixture): Promise<Extraction[]> {
  const persona = PERSONAS[fx.charId] || PERSONAS.spud;
  const memory: { fact: string; day: number }[] = [];
  const extracted: Extraction[] = [];
  let userTurn = 0;

  for (let i = 0; i < fx.turns.length; i++) {
    if (fx.turns[i].who !== 'user') continue; // extraction fires on the pet's reply to a user line
    userTurn++;
    // context = real transcript up to and including this user line, last 12 (app window)
    const history = fx.turns.slice(0, i + 1).slice(-12);
    const messages = history.map((t) => ({ role: t.who === 'user' ? 'user' : 'assistant', content: t.text }));
    const payload: ChatPayload = { charId: fx.charId, day: fx.day, lang: fx.lang, memory: memory.slice(), messages: history };
    const system = buildChatSystem(persona, payload, []);
    let raw = '';
    try {
      const r = await callLLMChain(env, chain, { system, messages, maxTokens: 300, temperature: 1.0, models: {} });
      raw = r.text || '';
    } catch (e) {
      process.stderr.write(`  turn ${userTurn}: LLM error ${(e as Error).message}\n`);
      continue;
    }
    if (!raw.trim()) continue;
    // same parse the Worker runs: strip [emotion]/[gesture], pull the [[remember]]
    const { body } = parseTag(raw);
    const { body: afterGesture } = parseGesture(body);
    const { remember } = parseRemember(afterGesture);
    if (remember && remember.fact && remember.fact.trim()) {
      const fact = remember.fact.trim();
      extracted.push({ turn: userTurn, kind: remember.kind, mood: remember.mood, fact });
      // feed it forward as "already known" so later turns don't re-extract it
      if (!memory.some((m) => m.fact === fact)) memory.push({ fact, day: fx.day });
    }
  }
  return extracted;
}

// Replay via the batch /distill path instead: chunks of BACKSTOP messages with
// a CONTEXT_TAIL overlap — the client's forced-cut behavior (app/src/app/
// distill.ts). Lull boundaries can't be simulated (the fixture has no
// timestamps), so this scores the WORST chunking the app would ever produce;
// live lull-aligned chunks only give the model cleaner topic edges. Memory
// accumulates across chunks exactly as on-device.
const DISTILL_BACKSTOP = 30;
const DISTILL_CONTEXT = 6;
async function distillReplay(env: Env, chain: string[], fx: Fixture): Promise<Extraction[]> {
  const memory: { fact: string; day: number }[] = [];
  const extracted: Extraction[] = [];
  let cursor = 0;
  while (cursor < fx.turns.length) {
    const chunk = fx.turns.slice(cursor, cursor + DISTILL_BACKSTOP);
    const payload: DistillPayload = {
      day: fx.day,
      lang: fx.lang,
      memory: memory.slice(),
      context: fx.turns.slice(Math.max(cursor - DISTILL_CONTEXT, 0), cursor),
      messages: chunk,
    };
    let raw = '';
    try {
      // mirror the /distill route: low temperature, JSON mode
      const r = await callLLMChain(env, chain, {
        system: buildDistillSystem(payload),
        messages: [{ role: 'user', content: distillTranscript(payload) }],
        maxTokens: 700, temperature: 0.2, json: true, models: {},
      });
      raw = r.text || '';
    } catch (e) {
      process.stderr.write(`  chunk @${cursor}: LLM error ${(e as Error).message}\n`);
      cursor += chunk.length;
      continue;
    }
    for (const f of parseDistillFacts(raw, chunk.length)) {
      // report `turn` as the absolute transcript line for readability
      extracted.push({ turn: f.turn ? cursor + f.turn : 0, kind: f.kind, mood: f.mood, fact: f.fact });
      if (!memory.some((m) => m.fact === f.fact)) memory.push({ fact: f.fact, day: fx.day });
    }
    cursor += chunk.length;
  }
  return extracted;
}

interface Scored {
  recall: number;                                    // fraction of expected facts hit at least once across samples
  perExpect: { id: string; desc: string; hitRate: number }[]; // hitRate = samples-with-a-hit / samples
  avoidHits: { id: string; desc: string; fact: string; sample: number }[];
  novel: { fact: string; kind: string; sample: number }[]; // matched no expected id — needs a human look
}

// Score N replays against the fixture. An expected fact is "hit" in a sample if
// ANY extraction that sample matched its patterns. avoid/novel are judged only on
// extractions that matched no expected id, so overlapping tokens (空调) don't
// double-count.
function score(fx: Fixture, samples: Extraction[][]): Scored {
  const perExpect = fx.expect.map((e) => {
    let hits = 0;
    for (const s of samples) if (s.some((x) => matchesAny(x.fact, e.any))) hits++;
    return { id: e.id, desc: e.desc, hitRate: hits / samples.length };
  });
  const avoidHits: Scored['avoidHits'] = [];
  const novel: Scored['novel'] = [];
  samples.forEach((s, si) => {
    for (const x of s) {
      const hitExpected = fx.expect.some((e) => matchesAny(x.fact, e.any));
      if (hitExpected) continue;
      const av = fx.avoid.find((a) => matchesAny(x.fact, a.any));
      if (av) avoidHits.push({ id: av.id, desc: av.desc, fact: x.fact, sample: si + 1 });
      else novel.push({ fact: x.fact, kind: x.kind, sample: si + 1 });
    }
  });
  const recall = perExpect.filter((p) => p.hitRate > 0).length / fx.expect.length;
  return { recall, perExpect, avoidHits, novel };
}

function bar(rate: number): string {
  const n = Math.round(rate * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

async function main() {
  const provider = (arg('provider') || 'openai').toLowerCase();
  const samples = parseInt(arg('samples', '1')!, 10);
  const fixtureName = arg('fixture', '2026-07-16-heavy')!;
  const mode = arg('mode', 'chat')!; // chat = in-reply [[remember]]; distill = batch /distill path
  const outPath = arg('out');
  const env = loadEnv(provider);
  const chain = [provider]; // force ONE backend — an eval must hold the model fixed, no fallback
  const model = (env as unknown as Record<string, string>)[`${provider.toUpperCase()}_MODEL`] || '(default)';
  const fx: Fixture = JSON.parse(readFileSync(join(ROOT, 'eval/fixtures', `${fixtureName}.json`), 'utf8'));

  process.stderr.write(`\nfixture: ${fx.name}  ·  mode: ${mode}  ·  provider: ${provider} (${model})  ·  samples: ${samples}\n`);
  process.stderr.write(`${fx.turns.filter((t) => t.who === 'user').length} user turns · ${fx.expect.length} expected facts\n\n`);

  const runs: Extraction[][] = [];
  for (let s = 0; s < samples; s++) {
    process.stderr.write(`replay ${s + 1}/${samples} …\n`);
    runs.push(mode === 'distill' ? await distillReplay(env, chain, fx) : await replay(env, chain, fx));
  }
  const sc = score(fx, runs);

  // ── report ──
  const lines: string[] = [];
  lines.push(`\n═══ memory-extraction eval · ${fx.name} · ${mode} · ${provider}/${model} · ${samples} sample(s) ═══\n`);
  lines.push(`RECALL: ${(sc.recall * 100).toFixed(0)}%  (${sc.perExpect.filter((p) => p.hitRate > 0).length}/${fx.expect.length} expected facts caught at least once)\n`);
  lines.push('per expected fact  (hit-rate across samples):');
  for (const p of sc.perExpect) {
    const flag = p.hitRate === 0 ? ' ✗ MISS' : p.hitRate < 1 ? ' ~ flaky' : '';
    lines.push(`  ${bar(p.hitRate)} ${(p.hitRate * 100).toFixed(0).padStart(3)}%  ${p.desc}${flag}`);
  }
  lines.push('');
  if (sc.avoidHits.length) {
    lines.push(`PRECISION ⚠  ${sc.avoidHits.length} junk extraction(s) that should have been skipped:`);
    for (const a of sc.avoidHits) lines.push(`  · [${a.desc}] "${a.fact}"  (sample ${a.sample})`);
  } else {
    lines.push('PRECISION ✓  no transient/smalltalk/general-knowledge facts recorded');
  }
  lines.push('');
  if (sc.novel.length) {
    lines.push(`NOVEL — extractions matching no expected id (eyeball these; a real new fact, or a mis-record):`);
    for (const n of sc.novel) lines.push(`  · [${n.kind}] "${n.fact}"  (sample ${n.sample})`);
    lines.push('');
  }
  // full verbatim dump so scoring can never silently mis-credit
  lines.push('all extractions, verbatim:');
  runs.forEach((r, si) => {
    lines.push(`  sample ${si + 1}: ${r.length} fact(s)`);
    for (const x of r) lines.push(`     t${x.turn} [${x.kind}|${x.mood ?? '-'}] ${x.fact}`);
  });
  const report = lines.join('\n');
  process.stdout.write(report + '\n');

  if (outPath) {
    const payload = { fixture: fx.name, mode, provider, model, samples, recall: sc.recall, perExpect: sc.perExpect, avoidHits: sc.avoidHits, novel: sc.novel, runs };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(ROOT, outPath), JSON.stringify(payload, null, 2));
    process.stderr.write(`\nwrote ${outPath}\n`);
  }
}

main().catch((e) => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(1); });
