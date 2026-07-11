// Auto-update via electron-updater against the public GitHub releases.
// Quiet by design: checks 30s after launch and every 6h, downloads silently,
// installs on quit — the pet never nags. The tray mirrors the state (see
// tray.ts): the menu shows the current version, a manual "Check for Updates"
// entry (whose result comes back as a system notification — the GitHub check
// can take a while from slow networks, and a closed tray menu would swallow
// the feedback), and a "Restart to update" entry once a download is staged.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string; // set while downloading / ready
  manual?: boolean; // this state came from a user-clicked check
}

let status: UpdateStatus = { state: 'idle' };
let manualCheck = false;
let notify: ((s: UpdateStatus) => void) | null = null;
let revertTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(next: UpdateStatus): void {
  status = { ...next, manual: manualCheck };
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  // terminal states are feedback, not standing claims — fade the menu entry
  // back to plain "Check for Updates" instead of pinning a stale result there
  if (next.state === 'uptodate' || next.state === 'error') {
    manualCheck = false;
    revertTimer = setTimeout(() => setStatus({ state: 'idle' }), 60_000);
  }
  notify?.(status);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

// tray.ts registers here: rebuilds its menu and surfaces notifications
export function onUpdateStatus(cb: (s: UpdateStatus) => void): void {
  notify = cb;
}

export function checkForUpdates(manual = false): void {
  if (!app.isPackaged) return;
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => setStatus({ state: 'error' }));
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
  // offline / rate-limited / mid-publish — routine for auto checks (retry next
  // cycle); manual checks surface it via the tray notification
  autoUpdater.on('error', () => setStatus({ state: 'error' }));

  // stay out of the boot path: the potato appears first, updates come later
  setTimeout(checkForUpdates, 30_000);
  setInterval(() => checkForUpdates(), CHECK_EVERY);
}
