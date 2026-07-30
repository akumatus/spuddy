// Model providers + geo routing. The Worker itself is the gateway: it picks a
// provider from the caller's country, then normalizes every backend to the same
// { system, messages } -> string interface.

import type { ChatTurn, Env } from './types';

// Runtime provider/model config read from KV (config:current).
export interface RuntimeConfig {
  chat?: string;
  gen?: string;
  models?: Record<string, string>;
  // per-device daily budget for the real-time endpoints — hot-updatable via
  // POST /admin/config with no redeploy; absent → the CHAT_DAILY_LIMIT [vars]
  // default applies
  chatLimit?: number;
  // client-side product knobs (gacha odds, mix rates, draw limits) served to
  // the app on GET /cards — tune the feel with one admin call instead of an
  // app release users may never install. Free-form number map so new knobs
  // need no server change; the app clamps every value and falls back to its
  // built-in default when a key is absent (see app/src/remote.ts tune()).
  tuning?: Record<string, number>;
  // Invite passphrases: { "<phrase>": <daily limit> }. Said aloud to the pet in
  // chat, not typed into any settings screen — see matchCode in guard.ts. Each
  // one is single use, enforced by a Durable Object per phrase.
  codes?: Record<string, number>;
}

interface ProviderCfg {
  kind: 'openai' | 'gemini' | 'anthropic';
  base?: string;
  key?: string;
  model: string;
}

export interface LLMArgs {
  system?: string;
  messages: ChatTurn[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
  // wall-clock budget for the WHOLE fallback walk (callLLMChain), not one call —
  // real-time endpoints set it so the walk always answers before the app hangs up
  deadlineMs?: number;
  models?: Record<string, string>;
}

type CallArgs = Required<Pick<LLMArgs, 'messages' | 'maxTokens' | 'temperature' | 'json' | 'timeoutMs'>> & { system?: string };

// Live config lives in KV (config:current) so providers/models can be switched
// at runtime with one admin call — no redeploy. Missing/malformed just falls
// back to the [vars] defaults, so the Worker keeps serving if KV is empty.
export async function loadConfig(env: Env): Promise<RuntimeConfig> {
  try {
    const raw = await env.KV.get('config:current');
    const cfg = raw ? (JSON.parse(raw) as RuntimeConfig) : {};
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

// No geo routing — every request uses the same ordered fallback chain. Claude
// leads (best voice + multilingual); on any failure the call walks down this list.
export const PROVIDER_FALLBACK: string[] = ['anthropic', 'openai', 'gemini', 'deepseek'];

// primary first, then the default fallback with the primary removed (never tried
// twice). Accepts the friendly "claude" alias for anthropic.
function chainFrom(primary: string | undefined): string[] {
  primary = (primary || 'anthropic').toLowerCase();
  if (primary === 'claude') primary = 'anthropic';
  return [primary, ...PROVIDER_FALLBACK.filter((p) => p !== primary)];
}

// Real-time chat/greet/golden chain. Runtime KV config (cfg.chat) or the [vars]
// default (CHAT_PROVIDER) picks the primary; the rest of the chain backs it up.
export function chatProviderChain(env: Env, cfg: RuntimeConfig = {}): string[] {
  return chainFrom(cfg.chat || env.CHAT_PROVIDER || 'anthropic');
}

// Cron card/mutter generator chain — same fallback idea, its own primary.
export function genProviderChain(env: Env, cfg: RuntimeConfig = {}): string[] {
  return chainFrom(cfg.gen || env.GEN_PROVIDER || 'anthropic');
}

// models: optional { provider: modelId } runtime overrides from KV config; each
// falls back to its [vars] default, then a hardcoded default.
function providerConfig(env: Env, name: string, models: Record<string, string> = {}): ProviderCfg {
  if (name === 'claude') name = 'anthropic'; // accept the friendly alias
  const model = (fallback: string) => models[name] || fallback;
  switch (name) {
    case 'deepseek':
      return {
        kind: 'openai',
        base: 'https://api.deepseek.com',
        key: env.DEEPSEEK_API_KEY,
        model: model(env.DEEPSEEK_MODEL || 'deepseek-v4-flash'),
      };
    case 'openai':
      return {
        kind: 'openai',
        base: 'https://api.openai.com/v1',
        key: env.OPENAI_API_KEY,
        model: model(env.OPENAI_MODEL || 'gpt-5.4-mini'),
      };
    case 'gemini':
      return {
        kind: 'gemini',
        key: env.GEMINI_API_KEY,
        model: model(env.GEMINI_MODEL || 'gemini-3.1-flash-lite'),
      };
    case 'anthropic':
      return {
        kind: 'anthropic',
        key: env.ANTHROPIC_API_KEY,
        model: model(env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'),
      };
    default:
      throw new Error(`unknown provider: ${name}`);
  }
}

// timeoutMs default suits real-time chat; batch generation passes a much larger
// value — 50+ lines of non-streamed JSON can take minutes on a slow provider.
export async function callLLM(env: Env, provider: string, { system, messages, maxTokens = 300, temperature = 0.9, json = false, timeoutMs = 25000, models = {} }: LLMArgs): Promise<string> {
  const cfg = providerConfig(env, provider, models);
  if (!cfg.key) throw new Error(`missing API key for provider "${provider}"`);
  const args: CallArgs = { system, messages, maxTokens, temperature, json, timeoutMs };
  if (cfg.kind === 'gemini') return callGemini(cfg, args);
  if (cfg.kind === 'anthropic') return callAnthropic(cfg, args);
  return callOpenAICompat(cfg, args);
}

// Walk the provider chain until one backend actually answers. Backends with no
// configured key are skipped silently; a thrown or empty call falls through to
// the next. `deadlineMs` is a wall-clock budget for the WHOLE walk: each hop's
// timeout is clamped to the time left, and when under ~2s remains the walk
// stops and returns empty — for a real-time caller an in-time "no reply" beats
// a reply the app already gave up waiting for. `failed` names the backends that
// errored on this walk (fuel for the caller's circuit breaker). Returns
// { text, provider, model, failed } naming whichever backend replied (so
// responses stay self-describing), or { text: '' } if the chain is exhausted
// with no error. Throws only when the full chain was walked (no deadline cut)
// and every keyed backend errored.
export async function callLLMChain(
  env: Env,
  chain: string[],
  args: LLMArgs
): Promise<{ text: string; provider: string | null; model: string | null; failed: string[] }> {
  const t0 = Date.now();
  const failed: string[] = [];
  let lastErr: unknown;
  let outOfTime = false;
  for (const name of chain) {
    let cfg: ProviderCfg;
    try {
      cfg = providerConfig(env, name, args.models);
    } catch {
      continue; // unknown provider id — skip it
    }
    if (!cfg.key) continue; // no key for this backend — try the next
    const left = args.deadlineMs ? args.deadlineMs - (Date.now() - t0) : Infinity;
    if (left < 2000) {
      outOfTime = true; // no backend can answer in under ~2s — don't even ask
      break;
    }
    try {
      const text = await callLLM(env, name, { ...args, timeoutMs: Math.min(args.timeoutMs ?? 25000, left) });
      if (text && text.trim()) return { text, provider: name, model: cfg.model, failed };
    } catch (e) {
      lastErr = e; // network / non-2xx / timeout — fall through to the next provider
      failed.push(name);
    }
  }
  if (lastErr && !outOfTime) throw lastErr;
  return { text: '', provider: null, model: null, failed };
}

// DeepSeek + OpenAI share the /chat/completions shape.
async function callOpenAICompat(cfg: ProviderCfg, { system, messages, maxTokens, temperature, json, timeoutMs }: CallArgs): Promise<string> {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  // GPT-5-family reasoning models reject max_tokens (want max_completion_tokens)
  // and any non-default temperature. Reasoning tokens bill out of the same
  // completion budget, so add headroom and cap effort — otherwise a 300-token
  // chat budget gets eaten by reasoning and content comes back empty.
  const gpt5 = cfg.model.startsWith('gpt-5');
  const body: Record<string, unknown> = gpt5
    ? { model: cfg.model, max_completion_tokens: maxTokens + 1024, reasoning_effort: 'low', messages: msgs }
    : { model: cfg.model, max_tokens: maxTokens, temperature, messages: msgs };
  if (json) body.response_format = { type: 'json_object' }; // force valid JSON
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${cfg.model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(cfg: ProviderCfg, { system, messages, maxTokens, temperature, json, timeoutMs }: CallArgs): Promise<string> {
  // Gemini requires the first turn to be role "user" and takes the system prompt
  // as a separate systemInstruction. Drop any leading model turn (the pet's
  // canned greeting) so the transcript starts on the human.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  while (contents.length && contents[0].role === 'model') contents.shift();

  const body: {
    contents: typeof contents;
    generationConfig: Record<string, unknown>;
    systemInstruction?: { parts: { text: string }[] };
  } = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature } };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.map((pt) => pt.text).join('') || '';
}

async function callAnthropic(cfg: ProviderCfg, { system, messages, maxTokens, temperature, json, timeoutMs }: CallArgs): Promise<string> {
  // Anthropic's Messages API: system is a top-level field, the first turn must be
  // "user", and temperature is capped at 1 (the OpenAI-compat providers accept the
  // 1.3 we use for chat, so clamp here rather than at the call sites).
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  while (contents.length && contents[0].role === 'assistant') contents.shift();

  const body: Record<string, unknown> = { model: cfg.model, max_tokens: maxTokens, temperature: Math.min(temperature, 1), messages: contents };
  // No response_format on Anthropic — nudge JSON via the system prompt; extractJson
  // already tolerates fences/prose around the object.
  const sys = json ? `${system ? system + '\n\n' : ''}Respond with a single valid JSON object and nothing else.` : system;
  if (sys) body.system = sys;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.key!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.map((b) => b.text || '').join('') || '';
}
