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
      // UI-test instances boot next to (often exactly underneath) the live
      // potato — macOS reports them occluded and Chromium pauses rAF, freezing
      // the scene mid-test. Production keeps throttling: a covered pet may
      // as well sleep.
      backgroundThrottling: !process.env.PP_UITEST,
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
// sits at this offset inside the window. The renderer's `lift` (stage slid up
// within the window during a drag toward the top) shifts the effective anchor —
// without it a top dock could never trigger, since macOS pins the window's top
// under the menu bar and the raw anchor never gets within reach of wa.y.
const ANCHOR_X = WIN_W / 2; // stage horizontal center
const ANCHOR_Y = 490; // roughly the potato's body center
// Per-edge snap thresholds — how close the (lift-adjusted) anchor must get.
// Sides want most of the body already hanging out; the bottom needs him
// dragged ~55px below his normal resting spot (at rest the anchor sits 150px
// above the work-area bottom, so a plain drop along the ground never snaps).
const SNAP_X = 60;
const SNAP_TOP = 140;
const SNAP_BOTTOM = 95;
let lastEdge = { side: null as string | null, ex: 0, ey: 0 };

function reportEdge(lift = 0): void {
  if (!win) return;
  const [x, y] = win.getPosition();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const ax = x + ANCHOR_X;
  const ay = y + ANCHOR_Y - lift;
  // corners resolve to the nearest qualifying edge
  const cand: [string, number][] = [];
  if (ax - wa.x <= SNAP_X) cand.push(['left', ax - wa.x]);
  if (wa.x + wa.width - ax <= SNAP_X) cand.push(['right', wa.x + wa.width - ax]);
  if (ay - wa.y <= SNAP_TOP) cand.push(['top', ay - wa.y]);
  if (wa.y + wa.height - ay <= SNAP_BOTTOM) cand.push(['bottom', wa.y + wa.height - ay]);
  cand.sort((a, b) => a[1] - b[1]);
  const side = cand.length ? cand[0][0] : null;
  // where the screen edge's line sits in window coords, for the snap highlight
  const info = {
    side,
    ex: side === 'right' ? wa.x + wa.width - x : wa.x - x,
    ey: side === 'bottom' ? wa.y + wa.height - y : wa.y - y,
  };
  if (info.side !== lastEdge.side || info.ex !== lastEdge.ex || info.ey !== lastEdge.ey) {
    lastEdge = info;
    win.webContents.send('edge', info);
  }
}

// ── dock snap: tween the window flush against the chosen edge ──
// Final geometry is deterministic so the renderer can pose the model against
// the canvas boundary: the stage's matching edge lands exactly on the work-area
// line (for 'top' the renderer additionally lifts the stage 240px so the canvas
// top meets the window top). The coordinate along the edge keeps the drop spot,
// clamped so the peeking strip stays comfortably on screen.
const STAGE_L = ANCHOR_X - 150; // stage box within the window: x 210..510, y 240..640
const STAGE_R = ANCHOR_X + 150;
let dockTween: ReturnType<typeof setInterval> | null = null;

function dockTarget(side: string): [number, number] | null {
  if (!win) return null;
  const [x, y] = win.getPosition();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const alongX = Math.max(wa.x + 10 - STAGE_L, Math.min(x, wa.x + wa.width - 10 - STAGE_R));
  const alongY = Math.min(y, wa.y + wa.height - WIN_H);
  switch (side) {
    case 'left': return [wa.x - STAGE_L, alongY];
    case 'right': return [wa.x + wa.width - STAGE_R, alongY];
    case 'top': return [alongX, wa.y];
    case 'bottom': return [alongX, wa.y + wa.height - WIN_H];
    default: return null;
  }
}

function dockSnap(side: string): Promise<void> {
  const target = dockTarget(side);
  if (!win || !target) return Promise.resolve();
  if (dockTween) { clearInterval(dockTween); dockTween = null; }
  const [x0, y0] = win.getPosition();
  const [x1, y1] = target;
  const t0 = Date.now();
  const DUR = 240;
  return new Promise((resolve) => {
    dockTween = setInterval(() => {
      if (!win) { if (dockTween) clearInterval(dockTween); dockTween = null; resolve(); return; }
      const k = Math.min(1, (Date.now() - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3); // outCubic
      win.setPosition(Math.round(x0 + (x1 - x0) * e), Math.round(y0 + (y1 - y0) * e));
      if (k >= 1) {
        if (dockTween) clearInterval(dockTween);
        dockTween = null;
        reportEdge();
        resolve();
      }
    }, 16);
  });
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
  ipcMain.handle('move-by', (_e, dx: number, dy: number, lift?: number) => {
    if (!win) return 0;
    const [x, y] = win.getPosition();
    const targetX = Math.round(x + dx);
    const targetY = Math.round(y + dy);
    // Floor clamp: macOS lets setPosition place the window below the work area
    // but then asynchronously shoves the whole frame back up — fighting it made
    // downward drags rubber-band. Clamp to the floor of whatever display the
    // target lands on (so vertically stacked displays stay reachable) and
    // report the deficit as negative shortfall; the renderer sinks the stage
    // within the window instead, mirroring the lift trick at the top.
    const twa = screen.getDisplayMatching({ x: targetX, y: targetY, width: WIN_W, height: WIN_H }).workArea;
    const clampedY = Math.min(targetY, twa.y + twa.height - WIN_H);
    win.setPosition(targetX, clampedY);
    reportEdge(typeof lift === 'number' ? lift : 0);
    const [, actualY] = win.getPosition();
    // > 0 ⇒ pinned under the menu bar (couldn't rise); < 0 ⇒ held at the work-
    // area floor (couldn't sink)
    return actualY - targetY;
  });

  ipcMain.handle('dock-snap', (_e, side: string) => dockSnap(side));
}
