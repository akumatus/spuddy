// Background watchers pushed to the renderer over IPC.
import { powerMonitor, screen } from 'electron';
import { getWin } from './window';

export function startWatchers(): void {
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
    win.webContents.send('cursor', { x: p.x - wx, y: p.y - wy });
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
