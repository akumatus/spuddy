// AI IPC handlers — thin proxies to the server gateway (Cloudflare Worker).
// The Worker holds the API keys and runs the provider fallback chain; the app
// never talks to a model provider directly. On any server failure the handlers
// return null and the renderer speaks its built-in, in-voice fallback lines.
import { ipcMain } from 'electron';
import fs from 'node:fs';
import type {
  AiGoldenRequest,
  AiGreetRequest,
  AiReplyRequest,
  AiReplyResult,
  CardsBatch,
} from '../../src/types';
import { DEVICE_ID, cardsCachePath, serverFetch } from './config';

export function registerAiIpc(): void {
  // Chat reply — persona system prompt + emotion tag, built server-side.
  ipcMain.handle('ai-reply', async (_e, p: AiReplyRequest): Promise<AiReplyResult | null> => {
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
  });

  // Golden card — AI-knit server-side from what he remembers.
  ipcMain.handle('ai-golden', async (_e, p: AiGoldenRequest): Promise<string | null> => {
    try {
      const res = await serverFetch('/golden', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
      if (!res.ok) return null; // incl. 429 → renderer falls back to a pool line
      const data = (await res.json()) as { text?: string | null } | null;
      return data && data.text ? data.text : null;
    } catch (e) {
      return null;
    }
  });

  // Personalized greeting — knit server-side from memory + time of day, spoken
  // when the app opens. Returns null on any failure so the renderer speaks its
  // built-in daypart greeting instead.
  ipcMain.handle('ai-greet', async (_e, p: AiGreetRequest): Promise<string | null> => {
    try {
      const res = await serverFetch('/greet', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
      if (!res.ok) return null; // incl. 429 → renderer falls back to a built-in line
      const data = (await res.json()) as { text?: string | null } | null;
      return data && data.text ? data.text : null;
    } catch (e) {
      return null;
    }
  });

  // Daily card batch — pulled from the server (cron pre-generates one per
  // language), cached to disk per language so draws still work offline. On a
  // server miss it falls back to the last cached batch, then to null (renderer
  // uses its built-in daily pool).
  ipcMain.handle('cards-today', async (_e, lang?: string): Promise<CardsBatch | null> => {
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
