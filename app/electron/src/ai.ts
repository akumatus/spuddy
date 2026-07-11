// AI IPC handlers: the server gateway (Cloudflare Worker) with a local
// DeepSeek fallback for development. The key never enters the renderer.
import { ipcMain } from 'electron';
import fs from 'node:fs';
import type {
  AiGoldenRequest,
  AiGreetRequest,
  AiReplyRequest,
  AiReplyResult,
  CardsBatch,
  MemoryMood,
  RememberNote,
} from '../../src/types';
import { CONFIG, DEVICE_ID, SERVER_URL, cardsCachePath, serverFetch } from './config';

// Language rider for the local greet/golden prompts (the server builds its
// own — see server/src/personas.ts; keep the wording in sync). Chat replies
// need no rider (the prompt already mirrors whatever language the human writes
// in), but the [[remember:]] fact does — see zhRememberRider below.
function zhRider(lang: string | undefined, kind: 'card' | 'greeting'): string {
  if (lang !== 'zh') return '';
  return kind === 'card'
    ? ' Write the card in natural, conversational Simplified Chinese — never translated-sounding; the word limit becomes a 40-Chinese-character limit.'
    : ' Speak in natural, conversational Simplified Chinese — never translated-sounding; the word limit becomes a 30-Chinese-character limit.';
}

// Language rider for the [[remember:]] fact. The Memory quilt renders facts in
// the app language, not the conversation language — without this, the English
// examples pull models toward English facts even in a Chinese app. Category and
// mood words must stay English: the parser matches them literally. Mirrors
// zhRememberLine in server/src/personas.ts — keep the wording in sync.
function zhRememberRider(lang: string | undefined): string {
  return lang === 'zh'
    ? ` Write the <fact> itself in natural Simplified Chinese whatever language the conversation is in — only the category and mood words stay English, e.g. [[remember: work | plain | 在做一款叫 spuddy 的桌宠应用]].`
    : '';
}

// ── local AI fallback (used only when no serverUrl is configured) ──
// Talks to DeepSeek's OpenAI-compatible /chat/completions endpoint — the same
// provider the Worker uses for CN traffic.
const LOCAL_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const LOCAL_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TAG_RE = /^\s*\[(comfort|cheer|proud|calm)\]\s*/i;
// Optional [gesture] tag after the emotion tag — the renderer maps it to an
// animation clip. Kept in sync with GESTURE_CLIP in app/src/app/chat.ts.
const GESTURE_RE = /^\s*\[(wave|hug|dance|spin|cheer|hop|sing|stretch|shy|peek|sulk|sneeze|present)\]\s*/i;
// Optional trailing [[remember: <kind> | <mood> | <fact>]] — a durable fact the
// pet keeps about the human, mood-stamped by the model itself (sunny/rainy/plain)
// so the Memory quilt colors patches right. Double brackets so it never collides
// with the single-bracket tags. Kinds mirror MEMORY_KINDS in app/src/content.ts
// and the parsing mirrors server/src/personas.ts — keep all three in sync.
const REMEMBER_RE = /\[\[\s*remember:\s*([^\]]+?)\s*\]\]/i;
const MEMORY_KINDS = ['work', 'goal', 'people', 'pets', 'likes', 'milestone', 'feeling', 'other'];
// canonical moods + the synonyms models drift toward
const MOODS: Record<string, MemoryMood> = {
  sunny: 'sunny', happy: 'sunny', warm: 'sunny',
  rainy: 'rainy', sad: 'rainy', heavy: 'rainy', hard: 'rainy',
  plain: 'plain', neutral: 'plain', normal: 'plain', calm: 'plain',
};

function splitRemember(raw: string): RememberNote {
  const parts = raw.split('|');
  if (parts.length >= 2) {
    const kind = parts[0].trim().toLowerCase();
    // second slot is the mood when it parses as one; tolerate the older
    // two-part <kind> | <fact> shape (and models that skip the mood)
    const mood = MOODS[parts[1].trim().toLowerCase()] || null;
    const fact = parts.slice(mood ? 2 : 1).join('|').trim();
    if (fact) return { fact, kind: MEMORY_KINDS.includes(kind) ? kind : 'other', mood };
  }
  return { fact: raw.trim(), kind: 'other', mood: null };
}

function localApiKey(): string | null {
  return process.env.DEEPSEEK_API_KEY || CONFIG.apiKey || null;
}

function clean(out: string | null | undefined): string {
  return (out || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
}

interface LocalChatArgs {
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
}

// One-shot DeepSeek chat completion. Returns the reply text, or null on any
// failure (no key, network, non-2xx) so callers fall back to built-in lines.
async function localChat({ system, messages, maxTokens = 300, temperature = 0.9 }: LocalChatArgs): Promise<string | null> {
  const key = localApiKey();
  if (!key) return null;
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  try {
    const res = await fetch(`${LOCAL_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: LOCAL_MODEL, max_tokens: maxTokens, temperature, messages: msgs }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null;
  }
}

export function registerAiIpc(): void {
  // Chat reply — persona system prompt + emotion tag, from the design prototype.
  ipcMain.handle('ai-reply', async (_e, p: AiReplyRequest): Promise<AiReplyResult | null> => {
    if (SERVER_URL) {
      try {
        const res = await serverFetch('/chat', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
        if (res.status === 429) return { limited: true }; // daily budget spent
        if (!res.ok) return null;
        const data = (await res.json()) as AiReplyResult | null;
        return data && data.text
          ? { tag: data.tag || 'calm', gesture: data.gesture || null, remember: data.remember || null, text: data.text }
          : null;
      } catch (e) {
        return null; // offline / server down → renderer uses its in-voice fallback
      }
    }
    try {
      const mem = (p.memory || [])
        .map((m) => `- ${m.fact || ''} (day ${m.day})`)
        .join('\n');
      const system =
        `You are ${p.charName}, a tiny hand-crocheted spuddy desktop pet who lives on your human's desk holding a little card. ` +
        p.voice +
        ` Today is day ${p.day} together. Reply with ONE warm line (max 25 words), in character, plain text — no emojis, no quotation marks, no lists, no roleplay asterisks. ` +
        `Always reply in the same language the human is using this turn — Chinese if they wrote Chinese, English if English. ` +
        `Remember and gently reference what they told you before when it helps. A soft follow-up question is welcome. ` +
        `You are not a therapist: if they seem in real distress, warmly suggest also talking to a human they trust. ` +
        `Begin your reply with exactly one emotion tag in square brackets — [comfort] if they seem down, [cheer] if celebrating with them, [proud] if they did something good, [calm] otherwise — then the line itself.` +
        ` When their message calls for a physical action — they ask you to sing, dance, hug, wave, spin, jump, stretch, hide, peek, sneeze, sulk, or show your card, or acting one out would clearly land the moment — add ONE gesture tag immediately AFTER the emotion tag, chosen from EXACTLY this list: [wave] [hug] [dance] [spin] [cheer] [hop] [sing] [stretch] [shy] [peek] [sulk] [sneeze] [present]. Use it only when it truly fits; most replies have no gesture tag. Never invent gesture words outside that list. Example: "[cheer][dance] you got it — watch this."` +
        ` After your reply, only if this exchange revealed a durable fact worth remembering about them long-term, append it as the very last thing on its own, tagged with one category and one mood: [[remember: <category> | <mood> | <one concise third-person fact>]]. Categories: work (job, projects, studies), goal (plans, things they're working toward), people (relationships, family, friends), pets (their animals), likes (tastes, preferences, hobbies), milestone (something they achieved or a big life event), feeling (a lasting worry, fear, or what they deeply care about), other. Mood is the emotional color of the fact itself: sunny (a happy, warm, or proud thing), rainy (a sad, painful, or heavy thing — a loss, a conflict, a fear), plain (neutral everyday information). Examples: [[remember: work | plain | is building a desktop-pet app called spuddy]] · [[remember: people | rainy | lost her mother years ago]] · [[remember: milestone | sunny | just ran her first 10k]].` +
        zhRememberRider(p.lang) +
        ` Most replies reveal nothing new — then add nothing. Never restate something already in your long-term memory below, and at most one per reply.` +
        (mem ? `\nLong-term memory of them (already known — don't re-remember these):\n${mem}` : '');
      const messages = (p.messages || []).map((m) => ({
        role: m.who === 'user' ? 'user' : 'assistant',
        content: m.text,
      }));
      const raw = clean(await localChat({ system, messages, maxTokens: 300 }));
      if (!raw) return null;
      const m = raw.match(TAG_RE);
      const body = raw.replace(TAG_RE, '');
      const g = body.match(GESTURE_RE);
      const afterGesture = body.replace(GESTURE_RE, '');
      const r = afterGesture.match(REMEMBER_RE);
      return {
        tag: m ? m[1].toLowerCase() : 'calm',
        gesture: g ? g[1].toLowerCase() : null,
        remember: r ? splitRemember(r[1]) : null,
        text: afterGesture.replace(REMEMBER_RE, '').trim().slice(0, 220),
      };
    } catch (e) {
      return null;
    }
  });

  // Golden card — AI-knit from what he remembers.
  ipcMain.handle('ai-golden', async (_e, p: AiGoldenRequest): Promise<string | null> => {
    if (SERVER_URL) {
      try {
        const res = await serverFetch('/golden', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
        if (!res.ok) return null; // incl. 429 → renderer falls back to a pool line
        const data = (await res.json()) as { text?: string | null } | null;
        return data && data.text ? data.text : null;
      } catch (e) {
        return null;
      }
    }
    try {
      const j = p.memory || [];
      const ctx = j.length
        ? j.map((m) => `- ${m.fact || ''} (day ${m.day})`).join('\n')
        : '(nothing remembered yet — keep it universal)';
      const prompt =
        `You are ${p.charName}, a tiny hand-crocheted spuddy desk companion. ` +
        p.voice +
        ` Write ONE short encouragement card for your human. What you know about them:\n${ctx}\n` +
        `Rules: HARD LIMIT 22 words — count them and stay under; warm and specific — reference one concrete thing you know about them if any, ` +
        `fully in your voice, no emojis, no quotation marks, no emotion tag, no preamble. Output only the card text.` +
        zhRider(p.lang, 'card');
      const out = clean(await localChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 200 }));
      return out && out.length > 4 && out.length < 220 ? out : null;
    } catch (e) {
      return null;
    }
  });

  // Personalized greeting — a fresh hello knit from memory + time of day, spoken
  // when the app opens. Returns null on any failure so the renderer speaks its
  // built-in daypart greeting instead.
  ipcMain.handle('ai-greet', async (_e, p: AiGreetRequest): Promise<string | null> => {
    if (SERVER_URL) {
      try {
        const res = await serverFetch('/greet', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
        if (!res.ok) return null; // incl. 429 → renderer falls back to a built-in line
        const data = (await res.json()) as { text?: string | null } | null;
        return data && data.text ? data.text : null;
      } catch (e) {
        return null;
      }
    }
    try {
      const when = ['morning', 'afternoon', 'evening', 'night'].includes(p.daypart) ? p.daypart : 'day';
      const j = p.memory || [];
      const ctx = j.length ? j.map((m) => `- ${m.fact || ''} (day ${m.day})`).join('\n') : '';
      const prompt =
        `You are ${p.charName}, a tiny hand-crocheted spuddy desktop pet who lives on your human's desk holding a little card. ` +
        p.voice +
        ` It is ${when} where they are, day ${p.day || 1} together. They just opened you on their desk. ` +
        `Greet them: ONE short spoken hello in your voice, fit to the ${when}, and gently nudge them to tap you for today's card. ` +
        (ctx
          ? `What you know about them:\n${ctx}\nLightly reference one concrete thing if it fits naturally; otherwise keep it warm and general. `
          : 'Keep it warm and general. ') +
        `Rules: HARD LIMIT 20 words; sound spontaneous and a little different every time; plain text, ` +
        `no emojis, no quotation marks, no emotion tag, no preamble. Output only the greeting.` +
        zhRider(p.lang, 'greeting');
      const out = clean(await localChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 120 }));
      return out && out.length > 2 && out.length < 200 ? out : null;
    } catch (e) {
      return null;
    }
  });

  // Daily card batch — pulled from the server (cron pre-generates one per
  // language), cached to disk per language so draws still work offline.
  // Returns null with no server configured, so the renderer falls back to its
  // built-in daily pool.
  ipcMain.handle('cards-today', async (_e, lang?: string): Promise<CardsBatch | null> => {
    if (!SERVER_URL) return null;
    const cache = cardsCachePath(lang);
    try {
      const res = await serverFetch(`/cards${lang === 'zh' ? '?lang=zh' : ''}`, { method: 'GET', timeout: 12000 });
      if (res.ok) {
        const data = (await res.json()) as CardsBatch | null;
        if (data && data.cards && Object.keys(data.cards).length) {
          try { fs.writeFileSync(cache, JSON.stringify(data)); } catch (e) {}
          return data;
        }
      }
    } catch (e) {
      // fall through to the last cached batch
    }
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch (e) { return null; }
  });
}
