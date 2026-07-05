// Model providers + geo routing. The Worker itself is the gateway: it picks a
// provider from the caller's country, then normalizes every backend to the same
// { system, messages } -> string interface.

// CN traffic -> DeepSeek (cheap, fast, no GFW hop). Everyone else -> whatever
// INTL_PROVIDER is set to (gemini by default, or openai).
export function pickChatProvider(country, env) {
  if (country === 'CN') return 'deepseek';
  return (env.INTL_PROVIDER || 'gemini').toLowerCase();
}

function providerConfig(env, name) {
  switch (name) {
    case 'deepseek':
      return {
        kind: 'openai',
        base: 'https://api.deepseek.com',
        key: env.DEEPSEEK_API_KEY,
        model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      };
    case 'openai':
      return {
        kind: 'openai',
        base: 'https://api.openai.com/v1',
        key: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
      };
    case 'gemini':
      return {
        kind: 'gemini',
        key: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL || 'gemini-2.0-flash',
      };
    default:
      throw new Error(`unknown provider: ${name}`);
  }
}

export async function callLLM(env, provider, { system, messages, maxTokens = 300, temperature = 0.9, json = false }) {
  const cfg = providerConfig(env, provider);
  if (!cfg.key) throw new Error(`missing API key for provider "${provider}"`);
  return cfg.kind === 'gemini'
    ? callGemini(cfg, { system, messages, maxTokens, temperature, json })
    : callOpenAICompat(cfg, { system, messages, maxTokens, temperature, json });
}

// DeepSeek + OpenAI share the /chat/completions shape.
async function callOpenAICompat(cfg, { system, messages, maxTokens, temperature, json }) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = { model: cfg.model, max_tokens: maxTokens, temperature, messages: msgs };
  if (json) body.response_format = { type: 'json_object' }; // force valid JSON
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${cfg.model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(cfg, { system, messages, maxTokens, temperature, json }) {
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
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((pt) => pt.text).join('') || '';
}
