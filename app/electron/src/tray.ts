import { Menu, Tray, app, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import type { Lang, LangPref } from '../../src/types';
import { getWin } from './window';

let tray: Tray | null = null;

// The renderer owns the language preference (it lives in AppState); the tray
// mirrors it. Until the first report arrives, guess from the OS locale so the
// menu comes up in the right language on a fresh install.
let pref: LangPref = 'auto';
let effective: Lang = 'en';

const LABELS: Record<Lang, { showHide: string; language: string; auto: string; quit: string }> = {
  en: { showHide: 'Show / Hide', language: 'Language', auto: 'Auto (System)', quit: 'Quit Spuddy' },
  zh: { showHide: '显示 / 隐藏', language: '语言', auto: '跟随系统', quit: '退出 Spuddy' },
};

function pickLang(p: LangPref): void {
  // optimistic local update so the menu reflects the pick immediately; the
  // renderer persists it and reports back (a no-op rebuild when it agrees)
  pref = p;
  effective = p === 'auto' ? systemLang() : p;
  rebuildMenu();
  getWin()?.webContents.send('set-lang', p);
}

function systemLang(): Lang {
  return /^zh/i.test(app.getLocale() || '') ? 'zh' : 'en';
}

function rebuildMenu(): void {
  if (!tray) return;
  const L = LABELS[effective];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: L.showHide,
        click: () => {
          const win = getWin();
          if (win) win.isVisible() ? win.hide() : win.show();
        },
      },
      {
        label: L.language,
        submenu: [
          { label: L.auto, type: 'radio', checked: pref === 'auto', click: () => pickLang('auto') },
          { label: 'English', type: 'radio', checked: pref === 'en', click: () => pickLang('en') },
          { label: '中文', type: 'radio', checked: pref === 'zh', click: () => pickLang('zh') },
        ],
      },
      { type: 'separator' },
      { label: L.quit, click: () => app.quit() },
    ])
  );
}

export function createTray(): void {
  effective = systemLang();
  // renderer boot (and every language change) reports the persisted preference
  ipcMain.on('lang-changed', (_e, data: { pref?: LangPref; effective?: Lang }) => {
    if (data && (data.pref === 'auto' || data.pref === 'en' || data.pref === 'zh')) pref = data.pref;
    if (data && (data.effective === 'en' || data.effective === 'zh')) effective = data.effective;
    rebuildMenu();
  });
  try {
    // monochrome template — macOS tints it for the light/dark menu bar
    const img = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'trayTemplate.png')
    );
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Spuddy');
    rebuildMenu();
  } catch (e) {
    // tray is a convenience — the app works without it
  }
}
