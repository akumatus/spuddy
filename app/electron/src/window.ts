// Pet window: creation, click-through, drag moves, the modal expand/restore
// dance, and edge-dock reporting.
import { BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const WIN_W = 680;
const WIN_H = 640;

// app icon — design 1b "classic full-body with heart card", rebuilt by scripts/make-icon.cjs
export const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

let win: BrowserWindow | null = null;

// other modules (tray, watchers) reach the window through this — it goes null
// once the native window is destroyed
export function getWin(): BrowserWindow | null {
  return win;
}

export function createWindow(): void {
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
  // sedentary timers stop poking a destroyed object ("Object has been
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
      win?.webContents.executeJavaScript(code)
        .catch((e) => console.log('[uitest] failed', e.message));
    }, 5000);
  }
  if (process.env.PP_SNAPSHOT) {
    setTimeout(async () => {
      try {
        if (!win) return;
        const probe = await win.webContents.executeJavaScript(`({
          bubble: { cls: document.getElementById('bubble').className, text: document.getElementById('bubble').textContent },
          panel: document.getElementById('hoverpanel').className,
          hasPP: typeof window.pp,
          store: localStorage.getItem('pp_ritual_v1'),
        })`);
        console.log('[probe]', JSON.stringify(probe));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.PP_SNAPSHOT!, img.toPNG());
        console.log('[snapshot] saved', process.env.PP_SNAPSHOT);
      } catch (e) {
        console.log('[snapshot] failed', (e as Error).message);
      }
    }, 8000);
  }
}

// ── modal mode: while an overlay is open, blow the (normally small, bottom-
// right) window up to fill the screen so the popup can center on the whole
// display. Restore the pet's little window when it closes. ──
let savedBounds: Electron.Rectangle | null = null;

// ── edge dock: report which screen edge the potato is pushed against ──
// The potato renders in the bottom-right of the transparent window (CSS stage:
// right:16 bottom:0, 300x400), so its on-screen anchor sits at this offset
// inside the window. We only dock on the sides / top — the bottom is his
// resting spot, so docking there would put him to sleep the moment he boots.
const ANCHOR_X = 514; // WIN_W - 16 - 150 → stage horizontal center
const ANCHOR_Y = 490; // roughly the potato's body center
const DOCK = 95; // how close the anchor must get to count as "at the edge"
let lastEdge: string | null = null;

function reportEdge(): void {
  if (!win) return;
  const [x, y] = win.getPosition();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const ax = x + ANCHOR_X;
  const ay = y + ANCHOR_Y;
  let side: string | null = null;
  if (ax >= wa.x + wa.width - DOCK) side = 'right';
  else if (ax <= wa.x + DOCK) side = 'left';
  else if (ay <= wa.y + DOCK) side = 'top';
  if (side !== lastEdge) {
    lastEdge = side;
    win.webContents.send('edge', side);
  }
}

// ── IPC: window control ──
export function registerWindowIpc(): void {
  ipcMain.on('set-ignore-mouse', (_e, ignore: boolean) => {
    if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // Returns how many pixels the window fell short of the requested vertical move —
  // macOS pins a window's top under the menu bar, so a drag toward the top edge
  // stalls there. The renderer uses the shortfall to slide the potato up *within*
  // the window so he can still be dragged to the very top of the screen.
  ipcMain.handle('move-by', (_e, dx: number, dy: number) => {
    if (!win) return 0;
    const [x, y] = win.getPosition();
    const targetY = Math.round(y + dy);
    win.setPosition(Math.round(x + dx), targetY);
    reportEdge();
    const [, actualY] = win.getPosition();
    return actualY - targetY; // > 0 ⇒ clamped below where we asked (couldn't rise)
  });

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

  ipcMain.on('set-modal', (_e, on: boolean) => {
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
}
