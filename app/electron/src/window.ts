// Pet window: creation, click-through, drag moves, and edge-dock reporting.
// It floats above everything, always; popups live in their own normal-level
// window (see popup.ts) so they stack with other apps like ordinary windows.
import { BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { closePopupWindow, raisePopupWithPet } from './popup';

// The stage (300px wide) sits at the window's horizontal center (CSS: right:
// calc(50% - 150px)), leaving equal room on both sides of the potato so the
// hover panel can hang off either flank — near the left screen edge it mirrors
// to his right instead of clipping offscreen (see 'panel-side' below).
const WIN_W = 720;
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
    // spawn with the potato tucked into the bottom-right corner (stage center
    // ~174px from the screen edge); the window's empty right half hangs off
    // the screen — it's transparent and click-through, so nothing shows
    x: workArea.x + workArea.width - ANCHOR_X - 174,
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
  win.on('closed', () => { win = null; closePopupWindow(); });

  // clicking the potato re-activates Spuddy — surface its popup along with it
  win.on('focus', raisePopupWithPet);

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
  if (process.env.PP_TEST_UPDATE_NOTE) {
    // exercises the update-note path end to end (main → preload → bubble);
    // fires before the PP_SNAPSHOT probe so the bubble shows up in it
    const note = process.env.PP_TEST_UPDATE_NOTE;
    setTimeout(() => win?.webContents.send('update-note', note), 6000);
  }
  if (process.env.PP_SNAPSHOT) {
    setTimeout(async () => {
      try {
        if (!win) return;
        const probe = await win.webContents.executeJavaScript(`({
          bubble: { cls: document.getElementById('bubble').className, text: document.getElementById('bubble').textContent },
          panel: document.getElementById('hoverpanel').className,
          hasPP: typeof window.pp,
          store: window.pp?.store?.load() ?? localStorage.getItem('pp_ritual_v1'),
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

// ── edge dock: report which screen edge the potato is pushed against ──
// The potato renders at the horizontal center of the transparent window (CSS
// stage: right: calc(50% - 150px), bottom:0, 300x400), so its on-screen anchor
// sits at this offset inside the window. We only dock on the sides / top — the
// bottom is his resting spot, so docking there would put him to sleep the
// moment he boots.
const ANCHOR_X = WIN_W / 2; // stage horizontal center
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

// ── hover panel side ──
// The panel (chat box + icon row) hangs off the potato's left flank by
// default. Its far edge reaches ~336px left of the stage center, so once the
// potato parks closer than that (plus a little margin) to the left screen
// edge, the panel would clip — the renderer asks after each drag ends and
// mirrors it to his right instead.
const PANEL_ROOM = 350;

// ── IPC: window control ──
export function registerWindowIpc(): void {
  ipcMain.on('set-ignore-mouse', (_e, ignore: boolean) => {
    if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle('panel-side', () => {
    if (!win) return 'left';
    const [x] = win.getPosition();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    return x + ANCHOR_X - wa.x < PANEL_ROOM ? 'right' : 'left';
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
}
