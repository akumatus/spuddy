// Background watchers pushed to the renderer over IPC.
import { ipcMain, powerMonitor, screen } from 'electron';
import { getWin } from './window';

export function startWatchers(): void {
  // seconds since the human last touched keyboard/mouse — presence-gated
  // features (night care) pull this so they can skip an empty chair
  ipcMain.handle('system-idle-seconds', () => powerMonitor.getSystemIdleTime());

  // ── cursor watch: he turns to look at your pointer (Turn 5 followCursor) ──
  // Global poll in the main process — the window is click-through, so the
  // renderer only sees the cursor while it hovers the window itself.
  let lastCursor = { x: -1, y: -1 };
  setInterval(() => {
    const win = getWin();
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    if (Math.abs(p.x - lastCursor.x) + Math.abs(p.y - lastCursor.y) < 3) return;
    lastCursor = p;
    const [wx, wy] = win.getPosition();
    // whether the cursor is on the pet's own display — while the human works on
    // another monitor the renderer parks all idle behavior (mutters, routines,
    // knocks, dozes) so the pet doesn't chatter to an empty screen
    const sameDisplay = screen.getDisplayNearestPoint(p).id === screen.getDisplayMatching(win.getBounds()).id;
    win.webContents.send('cursor', { x: p.x - wx, y: p.y - wy, sameDisplay });
  }, 90);

  // ── sedentary watch: 90 min of continuous activity → stretch reminder ──
  let activeSec = 0;
  setInterval(() => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle < 120) activeSec += 30;
    else if (idle >= 300) activeSec = 0;
    if (activeSec >= 90 * 60) {
      activeSec = 0;
      win.webContents.send('sedentary');
    }
  }, 30_000);
}
