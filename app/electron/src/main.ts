// Electron main-process entry. Source lives in electron/src/*.ts and is
// bundled to electron/main.cjs + electron/preload.cjs by `yarn build:electron`
// (esbuild) — package.json "main" points at the bundle.
import { app, nativeImage } from 'electron';
import { registerAiIpc } from './ai';
import { registerStoreIpc } from './store';
import { createTray } from './tray';
import { startUpdater } from './updater';
import { startWatchers } from './watchers';
import { ICON_PATH, createWindow, getWin, registerWindowIpc } from './window';

// name used by Electron APIs (userData path, notifications, menu). The dock
// tooltip / menu-bar label additionally need the bundle plist — see
// scripts/set-dev-name.cjs (dev) and the electron-builder config (packaged).
app.setName('Spuddy');

// test hook (PP_UITEST / PP_SNAPSHOT runs): an isolated userData dir sidesteps
// the single-instance lock, so automated checks can boot next to a live potato
if (process.env.PP_USERDATA) app.setPath('userData', process.env.PP_USERDATA);

registerWindowIpc();
registerAiIpc();
registerStoreIpc();
startWatchers();

// one potato per desk — stacked transparent instances render ghost overlaps
if (!app.requestSingleInstanceLock()) {
  // When Squirrel relaunches us right after an update, the dying instance can
  // still hold the lock for a beat — bounce once instead of silently giving
  // up (the marker keeps a genuine second potato from bouncing forever).
  if (!process.argv.includes('--lock-retried')) {
    app.relaunch({ args: process.argv.slice(1).concat('--lock-retried') });
  }
  app.quit();
} else {
  app.on('second-instance', () => {
    getWin()?.show();
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
    startUpdater();
  });
}

app.on('window-all-closed', () => app.quit());
