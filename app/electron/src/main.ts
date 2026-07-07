// Electron main-process entry. Source lives in electron/src/*.ts and is
// bundled to electron/main.cjs + electron/preload.cjs by `yarn build:electron`
// (esbuild) — package.json "main" points at the bundle.
import { app, nativeImage } from 'electron';
import { registerAiIpc } from './ai';
import { createTray } from './tray';
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
startWatchers();

// one potato per desk — stacked transparent instances render ghost overlaps
if (!app.requestSingleInstanceLock()) {
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
  });
}

app.on('window-all-closed', () => app.quit());
