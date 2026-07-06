#!/usr/bin/env node
// Dev launcher for `wrangler dev` that lets you pick the LLM per session, so you
// can A/B chat models and swap the cron generator without editing config.
//
//   npm run dev                         plain wrangler.toml defaults
//   npm run dev -- --llm claude         chat + cron both on Claude
//   npm run dev -- --llm gpt            chat + cron on GPT
//   npm run dev -- --llm claude --gen deepseek   chat on Claude, cron on DeepSeek
//   LLM=gemini npm run dev              same as --llm gemini
//
// It just forwards `--var CN/INTL/GEN_PROVIDER:<id>` to wrangler (those override
// [vars] for this run only). Any extra args pass straight through to wrangler.
//
// Reminder: the chosen provider needs its key in .dev.vars (OPENAI_API_KEY /
// ANTHROPIC_API_KEY etc.), otherwise /chat returns null ("missing API key").
import { spawn } from 'node:child_process';

// Friendly aliases -> the ids providers.js understands. Unknown names pass through.
const ALIAS = { gpt: 'openai', claude: 'anthropic', ds: 'deepseek', google: 'gemini' };
const norm = (v) => (v ? ALIAS[v.toLowerCase()] || v.toLowerCase() : undefined);

// Pull `--flag value` out of argv so the rest can be handed to wrangler untouched.
const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args.splice(i, 2)[1];
};

const llm = norm(take('--llm') || process.env.LLM);
const gen = norm(take('--gen')) || llm; // cron generator defaults to the chat llm

const vars = [];
if (llm) vars.push('--var', `CN_PROVIDER:${llm}`, '--var', `INTL_PROVIDER:${llm}`);
if (gen) vars.push('--var', `GEN_PROVIDER:${gen}`);

if (llm || gen) console.log(`[dev] chat=${llm || '(default)'}  cron=${gen || '(default)'}`);

const child = spawn('wrangler', ['dev', ...vars, ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32', // wrangler.cmd on Windows needs a shell
});
child.on('exit', (code) => process.exit(code ?? 0));
