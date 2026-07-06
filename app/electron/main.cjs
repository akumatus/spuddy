const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');

// name used by Electron APIs (userData path, notifications, menu). The dock
// tooltip / menu-bar label additionally need the bundle plist — see
// scripts/set-dev-name.cjs (dev) and the electron-builder config (packaged).
app.setName('Spuddy');

const WIN_W = 680;
const WIN_H = 640;

// app icon — design 4b "rising from the bottom edge", rebuilt by scripts/make-icon.cjs
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

let win = null;
let tray = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 8,
    y: workArea.y + workArea.height - WIN_H,
    icon: ICON_PATH,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Null out the reference once the native window is gone, so the cursor /
  // sedentary timers below stop poking a destroyed object ("Object has been
  // destroyed" on quit).
  win.on('closed', () => { win = null; });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}]`, message);
  });
  if (process.env.PP_UITEST) {
    const t = process.env.PP_UITEST;
    const code = t.startsWith('js:')
      ? t.slice(3)
      : `document.getElementById(${JSON.stringify(t)}).click()`;
    setTimeout(() => {
      win.webContents.executeJavaScript(code)
        .catch((e) => console.log('[uitest] failed', e.message));
    }, 5000);
  }
  if (process.env.PP_SNAPSHOT) {
    setTimeout(async () => {
      try {
        const probe = await win.webContents.executeJavaScript(`({
          bubble: { cls: document.getElementById('bubble').className, text: document.getElementById('bubble').textContent },
          panel: document.getElementById('hoverpanel').className,
          hasPP: typeof window.pp,
          store: localStorage.getItem('pp_ritual_v1'),
        })`);
        console.log('[probe]', JSON.stringify(probe));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.PP_SNAPSHOT, img.toPNG());
        console.log('[snapshot] saved', process.env.PP_SNAPSHOT);
      } catch (e) {
        console.log('[snapshot] failed', e.message);
      }
    }, 8000);
  }
}

function createTray() {
  try {
    // monochrome template — macOS tints it for the light/dark menu bar
    const img = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'trayTemplate.png')
    );
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Spuddy');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show / Hide',
          click: () => (win.isVisible() ? win.hide() : win.show()),
        },
        { type: 'separator' },
        { label: 'Quit Spuddy', click: () => app.quit() },
      ])
    );
  } catch (e) {
    // tray is a convenience — the app works without it
  }
}

// ── IPC: window control ──
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// Returns how many pixels the window fell short of the requested vertical move —
// macOS pins a window's top under the menu bar, so a drag toward the top edge
// stalls there. The renderer uses the shortfall to slide the potato up *within*
// the window so he can still be dragged to the very top of the screen.
ipcMain.handle('move-by', (_e, dx, dy) => {
  if (!win) return 0;
  const [x, y] = win.getPosition();
  const targetY = Math.round(y + dy);
  win.setPosition(Math.round(x + dx), targetY);
  reportEdge();
  const [, actualY] = win.getPosition();
  return actualY - targetY; // > 0 ⇒ clamped below where we asked (couldn't rise)
});

// ── modal mode: while an overlay is open, blow the (normally small, bottom-
// right) window up to fill the screen so the popup can center on the whole
// display. Restore the pet's little window when it closes. ──
let savedBounds = null;

// gap between the window's right/bottom edges and the work area's — the
// renderer offsets the pet stage by this much while the window is expanded,
// so the potato holds its exact on-screen spot instead of flashing/hiding
ipcMain.handle('modal-geometry', () => {
  if (!win) return null;
  const b = savedBounds || win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    dx: wa.x + wa.width - (b.x + b.width),
    dy: wa.y + wa.height - (b.y + b.height),
  };
});

ipcMain.on('set-modal', (_e, on) => {
  if (!win) return;
  if (on) {
    if (savedBounds) return; // already expanded
    savedBounds = win.getBounds();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setResizable(true);
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    win.setResizable(false);
    lastEdge = null; // window jumped — drop any stale edge-dock state
  } else {
    if (!savedBounds) return;
    win.setResizable(true);
    win.setBounds(savedBounds);
    win.setResizable(false);
    savedBounds = null;
  }
});

// ── edge dock: report which screen edge the potato is pushed against ──
// The potato renders in the bottom-right of the transparent window (CSS stage:
// right:16 bottom:0, 300x400), so its on-screen anchor sits at this offset
// inside the window. We only dock on the sides / top — the bottom is his
// resting spot, so docking there would put him to sleep the moment he boots.
const ANCHOR_X = 514; // WIN_W - 16 - 150 → stage horizontal center
const ANCHOR_Y = 490; // roughly the potato's body center
const DOCK = 95; // how close the anchor must get to count as "at the edge"
let lastEdge = null;

function reportEdge() {
  if (!win) return;
  const [x, y] = win.getPosition();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const ax = x + ANCHOR_X;
  const ay = y + ANCHOR_Y;
  let side = null;
  if (ax >= wa.x + wa.width - DOCK) side = 'right';
  else if (ax <= wa.x + DOCK) side = 'left';
  else if (ay <= wa.y + DOCK) side = 'top';
  if (side !== lastEdge) {
    lastEdge = side;
    win.webContents.send('edge', side);
  }
}

// ── app config + server gateway ──
// ~/.config/spuddy/config.json — { serverUrl, appToken, deviceId, apiKey }
//   serverUrl : the Cloudflare Worker (below) — when set, all AI goes through it
//   appToken  : optional shared token sent as x-pp-app
//   deviceId  : stable anonymous id the server meters a daily budget against
//   apiKey    : local DeepSeek key, used only when no serverUrl is set (dev)
// serverUrl/appToken may also come from env (PP_SERVER_URL / PP_APP_TOKEN).
const fs = require('fs');
const CONFIG_DIR = path.join(app.getPath('home'), '.config', 'spuddy');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CARDS_CACHE = path.join(CONFIG_DIR, 'cards-cache.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}
function writeConfig(patch) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch (e) {
    // best-effort — a read-only home just means no persisted device id
  }
}

// Baked-in production defaults (shipped in the build) so a distributed app
// reaches the server with no local config. Env and user config still win.
const DEFAULTS = (() => { try { return require('./defaults.cjs'); } catch (e) { return {}; } })();

const CONFIG = readConfig();
const SERVER_URL = (process.env.PP_SERVER_URL || CONFIG.serverUrl || DEFAULTS.SERVER_URL || '').replace(/\/+$/, '');
const APP_TOKEN = process.env.PP_APP_TOKEN || CONFIG.appToken || DEFAULTS.APP_TOKEN || '';

let DEVICE_ID = CONFIG.deviceId;
if (!DEVICE_ID) {
  DEVICE_ID = require('crypto').randomUUID();
  writeConfig({ deviceId: DEVICE_ID });
}

async function serverFetch(pathname, { method = 'GET', body, timeout = 28000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (APP_TOKEN) headers['x-pp-app'] = APP_TOKEN;
  return fetch(`${SERVER_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
}

// ── IPC: local AI fallback (key never enters the renderer) ──
// Used only when no serverUrl is configured (local dev). Otherwise the Worker
// holds the keys and picks the provider. Talks to DeepSeek's OpenAI-compatible
// /chat/completions endpoint — the same provider the Worker uses for CN traffic.
const LOCAL_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const LOCAL_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TAG_RE = /^\s*\[(comfort|cheer|proud|calm)\]\s*/i;
// Optional [gesture] tag after the emotion tag — the renderer maps it to an
// animation clip. Kept in sync with GESTURE_CLIP in app/src/main.js.
const GESTURE_RE = /^\s*\[(wave|hug|dance|spin|cheer|hop|sing|stretch|shy|peek|sulk|sneeze|present)\]\s*/i;

function localApiKey() {
  return process.env.DEEPSEEK_API_KEY || CONFIG.apiKey || null;
}

function clean(out) {
  return (out || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
}

// One-shot DeepSeek chat completion. Returns the reply text, or null on any
// failure (no key, network, non-2xx) so callers fall back to built-in lines.
async function localChat({ system, messages, maxTokens = 300, temperature = 0.9 }) {
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
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null;
  }
}

// Chat reply — persona system prompt + emotion tag, from the design prototype.
ipcMain.handle('ai-reply', async (_e, p) => {
  if (SERVER_URL) {
    try {
      const res = await serverFetch('/chat', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
      if (res.status === 429) return { limited: true }; // daily budget spent
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.text ? { tag: data.tag || 'calm', gesture: data.gesture || null, text: data.text } : null;
    } catch (e) {
      return null; // offline / server down → renderer uses its in-voice fallback
    }
  }
  try {
    const mem = (p.memory || [])
      .map((m) => `day ${m.day}: they said "${m.note || ''}"`)
      .join('\n');
    const system =
      `You are ${p.charName}, a tiny hand-crocheted spuddy desktop pet who lives on your human's desk holding a little card. ` +
      p.voice +
      ` Today is day ${p.day} together. Reply with ONE warm line (max 25 words), in character, plain text — no emojis, no quotation marks, no lists, no roleplay asterisks. ` +
      `Remember and gently reference what they told you before when it helps. A soft follow-up question is welcome. ` +
      `You are not a therapist: if they seem in real distress, warmly suggest also talking to a human they trust. ` +
      `Begin your reply with exactly one emotion tag in square brackets — [comfort] if they seem down, [cheer] if celebrating with them, [proud] if they did something good, [calm] otherwise — then the line itself.` +
      ` When their message calls for a physical action — they ask you to sing, dance, hug, wave, spin, jump, stretch, hide, peek, sneeze, sulk, or show your card, or acting one out would clearly land the moment — add ONE gesture tag immediately AFTER the emotion tag, chosen from EXACTLY this list: [wave] [hug] [dance] [spin] [cheer] [hop] [sing] [stretch] [shy] [peek] [sulk] [sneeze] [present]. Use it only when it truly fits; most replies have no gesture tag. Never invent gesture words outside that list. Example: "[cheer][dance] you got it — watch this."` +
      (mem ? `\nLong-term memory of them:\n${mem}` : '');
    const messages = (p.messages || []).map((m) => ({
      role: m.who === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
    const raw = clean(await localChat({ system, messages, maxTokens: 300 }));
    if (!raw) return null;
    const m = raw.match(TAG_RE);
    const body = raw.replace(TAG_RE, '');
    const g = body.match(GESTURE_RE);
    return {
      tag: m ? m[1].toLowerCase() : 'calm',
      gesture: g ? g[1].toLowerCase() : null,
      text: body.replace(GESTURE_RE, '').slice(0, 220),
    };
  } catch (e) {
    return null;
  }
});

// Golden card — AI-knit from what he remembers.
ipcMain.handle('ai-golden', async (_e, p) => {
  if (SERVER_URL) {
    try {
      const res = await serverFetch('/golden', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
      if (!res.ok) return null; // incl. 429 → renderer falls back to a pool line
      const data = await res.json();
      return data && data.text ? data.text : null;
    } catch (e) {
      return null;
    }
  }
  try {
    const j = p.memory || [];
    const ctx = j.length
      ? j.map((m) => `day ${m.day}: they said "${m.note || ''}"`).join('\n')
      : '(no chats yet — keep it universal)';
    const prompt =
      `You are ${p.charName}, a tiny hand-crocheted spuddy desk companion. ` +
      p.voice +
      ` Write ONE short encouragement card for your human. Their recent week:\n${ctx}\n` +
      `Rules: HARD LIMIT 22 words — count them and stay under; warm and specific — reference one concrete thing they said if any, ` +
      `fully in your voice, no emojis, no quotation marks, no emotion tag, no preamble. Output only the card text.`;
    const out = clean(await localChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 200 }));
    return out && out.length > 4 && out.length < 220 ? out : null;
  } catch (e) {
    return null;
  }
});

// Personalized greeting — a fresh hello knit from memory + time of day, spoken
// when the app opens. Returns null on any failure so the renderer speaks its
// built-in daypart greeting instead.
ipcMain.handle('ai-greet', async (_e, p) => {
  if (SERVER_URL) {
    try {
      const res = await serverFetch('/greet', { method: 'POST', body: { deviceId: DEVICE_ID, ...p } });
      if (!res.ok) return null; // incl. 429 → renderer falls back to a built-in line
      const data = await res.json();
      return data && data.text ? data.text : null;
    } catch (e) {
      return null;
    }
  }
  try {
    const when = ['morning', 'afternoon', 'evening', 'night'].includes(p.daypart) ? p.daypart : 'day';
    const j = p.memory || [];
    const ctx = j.length ? j.map((m) => `day ${m.day}: they said "${m.note || ''}"`).join('\n') : '';
    const prompt =
      `You are ${p.charName}, a tiny hand-crocheted spuddy desktop pet who lives on your human's desk holding a little card. ` +
      p.voice +
      ` It is ${when} where they are, day ${p.day || 1} together. They just opened you on their desk. ` +
      `Greet them: ONE short spoken hello in your voice, fit to the ${when}, and gently nudge them to tap you for today's card. ` +
      (ctx
        ? `Their recent notes:\n${ctx}\nLightly reference one concrete thing they mentioned if it fits naturally; otherwise keep it warm and general. `
        : 'Keep it warm and general. ') +
      `Rules: HARD LIMIT 20 words; sound spontaneous and a little different every time; plain text, ` +
      `no emojis, no quotation marks, no emotion tag, no preamble. Output only the greeting.`;
    const out = clean(await localChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 120 }));
    return out && out.length > 2 && out.length < 200 ? out : null;
  } catch (e) {
    return null;
  }
});

// Daily card batch — pulled from the server (cron pre-generates it), cached to
// disk so draws still work offline. Returns null with no server configured, so
// the renderer falls back to its built-in DAILY pool.
ipcMain.handle('cards-today', async () => {
  if (!SERVER_URL) return null;
  try {
    const res = await serverFetch('/cards', { method: 'GET', timeout: 12000 });
    if (res.ok) {
      const data = await res.json();
      if (data && data.cards && Object.keys(data.cards).length) {
        try { fs.writeFileSync(CARDS_CACHE, JSON.stringify(data)); } catch (e) {}
        return data;
      }
    }
  } catch (e) {
    // fall through to the last cached batch
  }
  try { return JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf8')); } catch (e) { return null; }
});

// ── cursor watch: he turns to look at your pointer (Turn 5 followCursor) ──
// Global poll in the main process — the window is click-through, so the
// renderer only sees the cursor while it hovers the window itself.
let lastCursor = { x: -1, y: -1 };
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  if (Math.abs(p.x - lastCursor.x) + Math.abs(p.y - lastCursor.y) < 3) return;
  lastCursor = p;
  const [wx, wy] = win.getPosition();
  win.webContents.send('cursor', { x: p.x - wx, y: p.y - wy });
}, 90);

// ── sedentary watch: 90 min of continuous activity → stretch reminder ──
let activeSec = 0;
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const idle = powerMonitor.getSystemIdleTime();
  if (idle < 120) activeSec += 30;
  else if (idle >= 300) activeSec = 0;
  if (activeSec >= 90 * 60) {
    activeSec = 0;
    win.webContents.send('sedentary');
  }
}, 30_000);

// one potato per desk — stacked transparent instances render ghost overlaps
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.show();
  });
  app.whenReady().then(() => {
    // dock icon on macOS (BrowserWindow.icon doesn't cover the dock there)
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
      } catch (e) {
        // non-fatal — just leaves the default Electron dock icon
      }
    }
    createWindow();
    createTray();
  });
}

app.on('window-all-closed', () => app.quit());
