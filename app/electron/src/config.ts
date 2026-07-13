// ── app config + server gateway ──
// ~/.config/spuddy/config.json — { serverUrl, appToken, deviceId }
//   serverUrl : the Cloudflare Worker — all AI goes through it
//   appToken  : optional shared token sent as x-pp-app
//   deviceId  : stable anonymous id the server meters a daily budget against
// serverUrl/appToken may also come from env (PP_SERVER_URL / PP_APP_TOKEN).
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './defaults';

export interface UserConfig {
  serverUrl?: string;
  appToken?: string;
  deviceId?: string;
}

const CONFIG_DIR = path.join(app.getPath('home'), '.config', 'spuddy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// One offline cache file per batch language, so switching languages never
// serves a cached batch in the wrong one.
export function cardsCachePath(lang?: string): string {
  return path.join(CONFIG_DIR, lang === 'zh' ? 'cards-cache-zh.json' : 'cards-cache.json');
}

function readConfig(): UserConfig {
  try {
    return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as UserConfig) || {};
  } catch (e) {
    return {};
  }
}

function writeConfig(patch: UserConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch (e) {
    // best-effort — a read-only home just means no persisted device id
  }
}

export const CONFIG = readConfig();
export const SERVER_URL = (process.env.PP_SERVER_URL || CONFIG.serverUrl || DEFAULTS.SERVER_URL || '').replace(/\/+$/, '');
export const APP_TOKEN = process.env.PP_APP_TOKEN || CONFIG.appToken || DEFAULTS.APP_TOKEN || '';

function ensureDeviceId(): string {
  if (CONFIG.deviceId) return CONFIG.deviceId;
  const id = crypto.randomUUID();
  writeConfig({ deviceId: id });
  return id;
}

export const DEVICE_ID = ensureDeviceId();

export async function serverFetch(
  pathname: string,
  { method = 'GET', body, timeout = 28000 }: { method?: string; body?: unknown; timeout?: number } = {}
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (APP_TOKEN) headers['x-pp-app'] = APP_TOKEN;
  return fetch(`${SERVER_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
}
