const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');

const WIN_W = 680;
const WIN_H = 640;

let win = null;
let tray = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 8,
    y: workArea.y + workArea.height - WIN_H,
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
    const img = nativeImage
      .createFromPath(path.join(__dirname, '..', 'public', 'chars', 'char-spud.png'))
      .resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Positive Potato');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show / Hide',
          click: () => (win.isVisible() ? win.hide() : win.show()),
        },
        { type: 'separator' },
        { label: 'Quit Positive Potato', click: () => app.quit() },
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

ipcMain.on('move-by', (_e, dx, dy) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// ── IPC: Claude API (key never enters the renderer) ──
let anthropic = null;
let anthropicFailed = false;

function readLocalConfigKey() {
  // ~/.config/positive-potato/config.json — {"apiKey": "sk-ant-..."}
  // Lives outside the repo so the key is never committed.
  try {
    const p = path.join(app.getPath('home'), '.config', 'positive-potato', 'config.json');
    const cfg = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    return cfg.apiKey || null;
  } catch (e) {
    return null;
  }
}

function getClient() {
  if (anthropic || anthropicFailed) return anthropic;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    const opts = { timeout: 30_000, maxRetries: 1 };
    // env / `ant auth login` profile resolve inside the SDK; the config file is the app-local fallback
    const localKey = !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN ? readLocalConfigKey() : null;
    anthropic = localKey ? new Ctor({ ...opts, apiKey: localKey }) : new Ctor(opts);
  } catch (e) {
    anthropicFailed = true;
    anthropic = null;
  }
  return anthropic;
}

const MODEL = 'claude-opus-4-8';
const TAG_RE = /^\s*\[(comfort|cheer|proud|calm)\]\s*/i;

function clean(out) {
  return (out || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
}

function textOf(response) {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// Chat reply — persona system prompt + emotion tag, from the design prototype.
ipcMain.handle('ai-reply', async (_e, p) => {
  const client = getClient();
  if (!client) return null;
  try {
    const mem = (p.memory || [])
      .map((m) => `day ${m.day}: they said "${m.note || ''}"`)
      .join('\n');
    const system =
      `You are ${p.charName}, a tiny hand-crocheted positive potato desktop pet who lives on your human's desk holding a little card. ` +
      p.voice +
      ` Today is day ${p.day} together. Reply with ONE warm line (max 25 words), in character, plain text — no emojis, no quotation marks, no lists, no roleplay asterisks. ` +
      `Remember and gently reference what they told you before when it helps. A soft follow-up question is welcome. ` +
      `You are not a therapist: if they seem in real distress, warmly suggest also talking to a human they trust. ` +
      `Begin your reply with exactly one emotion tag in square brackets — [comfort] if they seem down, [cheer] if celebrating with them, [proud] if they did something good, [calm] otherwise — then the line itself.` +
      (mem ? `\nLong-term memory of them:\n${mem}` : '');
    const messages = (p.messages || []).map((m) => ({
      role: m.who === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system,
      messages,
    });
    const raw = clean(textOf(response));
    if (!raw) return null;
    const m = raw.match(TAG_RE);
    return {
      tag: m ? m[1].toLowerCase() : 'calm',
      text: raw.replace(TAG_RE, '').slice(0, 220),
    };
  } catch (e) {
    return null;
  }
});

// Golden card — AI-knit from what he remembers.
ipcMain.handle('ai-golden', async (_e, p) => {
  const client = getClient();
  if (!client) return null;
  try {
    const j = p.memory || [];
    const ctx = j.length
      ? j.map((m) => `day ${m.day}: they said "${m.note || ''}"`).join('\n')
      : '(no chats yet — keep it universal)';
    const prompt =
      `You are ${p.charName}, a tiny hand-crocheted positive potato desk companion. ` +
      p.voice +
      ` Write ONE short encouragement card for your human. Their recent week:\n${ctx}\n` +
      `Rules: HARD LIMIT 22 words — count them and stay under; warm and specific — reference one concrete thing they said if any, ` +
      `fully in your voice, no emojis, no quotation marks, no emotion tag, no preamble. Output only the card text.`;
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const out = clean(textOf(response));
    return out && out.length > 4 && out.length < 220 ? out : null;
  } catch (e) {
    return null;
  }
});

// ── sedentary watch: 90 min of continuous activity → stretch reminder ──
let activeSec = 0;
setInterval(() => {
  if (!win) return;
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
    createWindow();
    createTray();
  });
}

app.on('window-all-closed', () => app.quit());
