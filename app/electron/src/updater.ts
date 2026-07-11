// Auto-update via electron-updater against the public GitHub releases.
// Quiet by design: checks 30s after launch, every 6h, and after waking from a
// long sleep; downloads silently, installs on quit — the pet never nags. The
// tray mirrors the state (see tray.ts): the menu shows the current version, a
// manual "Check for Updates" entry, and a "Restart to update" entry once a
// download is staged. Check results are spoken by the pet itself (the
// 'update-note' bubble) — macOS drops our system notifications unless the
// user grants them, so Notification is only a best-effort echo.
import { app, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string; // set while downloading / ready
  manual?: boolean; // this state came from a user-clicked check
  slow?: boolean; // transient: a manual check is taking long — reassure, don't change state
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
  // once the click got its answer ("found vX"), the rest of the download and
  // any later auto checks are background business again
  if (next.state === 'downloading' || next.state === 'ready') manualCheck = false;
  notify?.(status);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

// tray.ts registers here: rebuilds its menu and surfaces notifications
export function onUpdateStatus(cb: (s: UpdateStatus) => void): void {
  notify = cb;
}

let lastCheckAt = 0;
let checkSeq = 0; // ties the slow-note timer to its own check — a later check must not inherit it

export function checkForUpdates(manual = false): void {
  if (!app.isPackaged) return;
  // escalate only — electron-updater coalesces overlapping checks into one
  // in-flight promise, so an auto check landing mid-manual-check must not
  // demote the shared result to "silent background check"
  if (manual) manualCheck = true;
  lastCheckAt = Date.now();
  const seq = ++checkSeq;
  if (manual) {
    // the HTTP layer's timeout is a hardcoded 60s and GitHub can crawl on a
    // bad network — reassure after 12s instead of leaving the click unanswered.
    // Synthetic ping only: status itself stays 'checking'. The seq guard keeps
    // an orphaned timer from narrating some unrelated later check.
    setTimeout(() => {
      if (seq === checkSeq && status.state === 'checking') {
        notify?.({ state: 'checking', manual: true, slow: true });
      }
    }, 12_000);
  }
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
  // timers freeze while the lid is closed, so a laptop that sleeps nightly
  // could dodge the 6h cycle forever — top up after waking from a long gap.
  // Staleness is re-tested at fire time: a manual check in the 10s grace
  // window makes this a no-op instead of a duplicate.
  powerMonitor.on('resume', () => {
    setTimeout(() => {
      if (Date.now() - lastCheckAt > 60 * 60 * 1000) checkForUpdates();
    }, 10_000);
  });
}
