// Auto-update via electron-updater against the public GitHub releases.
// Quiet by design: checks in the background, downloads silently, installs on
// quit — the pet never nags. The tray mirrors the state (see tray.ts): a
// manual "Check for Updates" entry, and once a download is ready it becomes
// "Restart to update", which relaunches into the new version immediately.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate';

export interface UpdateStatus {
  state: UpdateState;
  version?: string; // set while downloading / ready
}

let status: UpdateStatus = { state: 'idle' };
let notify: (() => void) | null = null;
let revertTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  // "Up to date" is only feedback for a manual check — fade it back to the
  // plain menu entry after a minute instead of pinning a stale claim there
  if (next.state === 'uptodate') {
    revertTimer = setTimeout(() => setStatus({ state: 'idle' }), 60_000);
  }
  notify?.();
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

// tray.ts registers its menu rebuild here
export function onUpdateStatus(cb: () => void): void {
  notify = cb;
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch(() => setStatus({ state: 'idle' }));
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

const CHECK_EVERY = 6 * 60 * 60 * 1000;

export function startUpdater(): void {
  // dev runs have no app-update.yml (and nothing meaningful to update)
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // updates apply on normal quit too

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => setStatus({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'uptodate' }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }));
  // offline / rate-limited / mid-publish — routine, retry next cycle
  autoUpdater.on('error', () => setStatus({ state: 'idle' }));

  // stay out of the boot path: the potato appears first, updates come later
  setTimeout(checkForUpdates, 30_000);
  setInterval(checkForUpdates, CHECK_EVERY);
}
