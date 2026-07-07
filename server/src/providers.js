// Model providers + geo routing. The Worker itself is the gateway: it picks a
// provider from the caller's country, then normalizes every backend to the same
// { system, messages } -> string interface.

// Live config lives in KV (config:current) so providers/models can be switched
// at runtime with one admin call — no redeploy. Missing/malformed just falls
// back to the [vars] defaults, so the Worker keeps serving if KV is empty.
export async function loadConfig(env) {
  try {
    const raw = await env.KV.get('config:current');
    const cfg = raw ? JSON.parse(raw) : {};
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

// No geo routing — every request uses the same ordered fallback chain. GPT leads
// (steadiest multilingual output); on any failure the call walks down this list.
export const PROVIDER_FALLBACK = ['openai', 'gemini', 'deepseek', 'anthropic'];

// primary first, then the default fallback with the primary removed (never tried
// twice). Accepts the friendly "claude" alias for anthropic.
function chainFrom(primary) {
  primary = (primary || 'openai').toLowerCase();
  if (primary === 'claude') primary = 'anthropic';
  return [primary, ...PROVIDER_FALLBACK.filter((p) => p !== primary)];
}

// Real-time chat/greet/golden chain. Runtime KV config (cfg.chat) or the [vars]
// default (CHAT_PROVIDER) picks the primary; the rest of the chain backs it up.
export function chatProviderChain(env, cfg = {}) {
  return chainFrom(cfg.chat || env.CHAT_PROVIDER || 'openai');
}

// Cron card/mutter generator chain — same fallback idea, its own primary.
export function genProviderChain(env, cfg = {}) {
  return chainFrom(cfg.gen || env.GEN_PROVIDER || 'openai');
}

// models: optional { provider: modelId } runtime overrides from KV config; each
// falls back to its [vars] default, then a hardcoded default.
function providerConfig(env, name, models = {}) {
  if (name === 'claude') name = 'anthropic'; // accept the friendly alias
  const model = (fallback) => models[name] || fallback;
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
        model: model(env.OPENAI_MODEL || 'gpt-4o-mini'),
      };
    case 'gemini':
      return {
        kind: 'gemini',
        key: env.GEMINI_API_KEY,
        model: model(env.GEMINI_MODEL || 'gemini-2.5-flash-lite'),
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
export async function callLLM(env, provider, { system, messages, maxTokens = 300, temperature = 0.9, json = false, timeoutMs = 25000, models = {} }) {
  const cfg = providerConfig(env, provider, models);
  if (!cfg.key) throw new Error(`missing API key for provider "${provider}"`);
  const args = { system, messages, maxTokens, temperature, json, timeoutMs };
  if (cfg.kind === 'gemini') return callGemini(cfg, args);
  if (cfg.kind === 'anthropic') return callAnthropic(cfg, args);
  return callOpenAICompat(cfg, args);
}

// Walk the provider chain until one backend actually answers. Backends with no
// configured key are skipped silently; a thrown or empty call falls through to
// the next. Returns { text, provider, model } naming whichever backend replied
// (so responses stay self-describing), or { text: '' } if the chain is exhausted
// with no error. Throws only when every keyed backend errored.
export async function callLLMChain(env, chain, args) {
  let lastErr;
  for (const name of chain) {
    let cfg;
    try {
      cfg = providerConfig(env, name, args.models);
    } catch {
      continue; // unknown provider id — skip it
    }
    if (!cfg.key) continue; // no key for this backend — try the next
    try {
      const text = await callLLM(env, name, args);
      if (text && text.trim()) return { text, provider: name, model: cfg.model };
    } catch (e) {
      lastErr = e; // network / non-2xx — fall through to the next provider
    }
  }
  if (lastErr) throw lastErr;
  return { text: '', provider: null, model: null };
}

// DeepSeek + OpenAI share the /chat/completions shape.
async function callOpenAICompat(cfg, { system, messages, maxTokens, temperature, json, timeoutMs }) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = { model: cfg.model, max_tokens: maxTokens, temperature, messages: msgs };
  if (json) body.response_format = { type: 'json_object' }; // force valid JSON
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${cfg.model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(cfg, { system, messages, maxTokens, temperature, json, timeoutMs }) {
  // Gemini requires the first turn to be role "user" and takes the system prompt
  // as a separate systemInstruction. Drop any leading model turn (the pet's
  // canned greeting) so the transcript starts on the human.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  while (contents.length && contents[0].role === 'model') contents.shift();

  const body = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature } };
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
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((pt) => pt.text).join('') || '';
}

async function callAnthropic(cfg, { system, messages, maxTokens, temperature, json, timeoutMs }) {
  // Anthropic's Messages API: system is a top-level field, the first turn must be
  // "user", and temperature is capped at 1 (the OpenAI-compat providers accept the
  // 1.3 we use for chat, so clamp here rather than at the call sites).
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  while (contents.length && contents[0].role === 'assistant') contents.shift();

  const body = { model: cfg.model, max_tokens: maxTokens, temperature: Math.min(temperature, 1), messages: contents };
  // No response_format on Anthropic — nudge JSON via the system prompt; extractJson
  // already tolerates fences/prose around the object.
  const sys = json ? `${system ? system + '\n\n' : ''}Respond with a single valid JSON object and nothing else.` : system;
  if (sys) body.system = sys;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || '').join('') || '';
}
