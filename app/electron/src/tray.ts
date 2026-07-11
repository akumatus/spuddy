import { Menu, Notification, Tray, app, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import type { Lang, LangPref } from '../../src/types';
import { checkForUpdates, getUpdateStatus, onUpdateStatus, quitAndInstall, type UpdateStatus } from './updater';
import { getWin } from './window';

let tray: Tray | null = null;

// The renderer owns the language preference (it lives in AppState); the tray
// mirrors it. Until the first report arrives, guess from the OS locale so the
// menu comes up in the right language on a fresh install.
let pref: LangPref = 'auto';
let effective: Lang = 'en';

const LABELS: Record<
  Lang,
  {
    showHide: string;
    language: string;
    auto: string;
    quit: string;
    checkUpdates: string;
    checking: string;
    downloading: (v: string) => string;
    uptodate: string;
    restart: (v: string) => string;
    checkFailed: string;
    notifyUptodate: (v: string) => string;
    notifyFound: (v: string) => string;
    notifyReady: (v: string) => string;
    notifyFailed: string;
  }
> = {
  en: {
    showHide: 'Show / Hide',
    language: 'Language',
    auto: 'Auto (System)',
    quit: 'Quit Spuddy',
    checkUpdates: 'Check for Updates',
    checking: 'Checking for updates…',
    downloading: (v) => `Downloading ${v}…`,
    uptodate: 'Up to date',
    restart: (v) => `Restart to update (${v})`,
    checkFailed: 'Update check failed',
    notifyUptodate: (v) => `You're on the latest version (v${v}).`,
    notifyFound: (v) => `Found v${v} — downloading in the background.`,
    notifyReady: (v) => `v${v} is ready — restart from the menu bar to update.`,
    notifyFailed: "Couldn't reach the update server. Will retry later.",
  },
  zh: {
    showHide: '显示 / 隐藏',
    language: '语言',
    auto: '跟随系统',
    quit: '退出 Spuddy',
    checkUpdates: '检查更新',
    checking: '正在检查更新…',
    downloading: (v) => `正在下载 ${v}…`,
    uptodate: '已是最新版本',
    restart: (v) => `重启并更新到 ${v}`,
    checkFailed: '检查更新失败',
    notifyUptodate: (v) => `已是最新版本（v${v}）。`,
    notifyFound: (v) => `发现 v${v}，正在后台下载。`,
    notifyReady: (v) => `v${v} 已就绪 — 从菜单栏重启即可完成更新。`,
    notifyFailed: '暂时连不上更新服务器，稍后会自动重试。',
  },
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

// one entry that morphs with the updater state: a clickable "Check for
// Updates" at rest, progress while busy, "Restart to update" once staged
function updateItem(L: (typeof LABELS)[Lang]): Electron.MenuItemConstructorOptions {
  const u = getUpdateStatus();
  switch (u.state) {
    case 'checking':
      return { label: L.checking, enabled: false };
    case 'downloading':
      return { label: L.downloading(u.version ?? '…'), enabled: false };
    case 'ready':
      return { label: L.restart(u.version ?? ''), click: () => quitAndInstall() };
    case 'uptodate':
      return { label: L.uptodate, enabled: false };
    case 'error':
      return { label: L.checkFailed, enabled: false };
    default:
      return { label: L.checkUpdates, enabled: app.isPackaged, click: () => checkForUpdates(true) };
  }
}

// The GitHub check can take a long while on a slow network and the tray menu
// closes on click, so a manual check answers via a system notification. Auto
// checks stay silent except the one moment worth knowing: an update is staged.
let notifiedReady: string | null = null;

function maybeNotify(u: UpdateStatus): void {
  const L = LABELS[effective];
  let body: string | null = null;
  if (u.state === 'ready' && u.version && notifiedReady !== u.version) {
    notifiedReady = u.version;
    body = L.notifyReady(u.version);
  } else if (u.manual) {
    if (u.state === 'uptodate') body = L.notifyUptodate(app.getVersion());
    else if (u.state === 'downloading') body = L.notifyFound(u.version ?? '');
    else if (u.state === 'error') body = L.notifyFailed;
  }
  if (!body) return;
  try {
    new Notification({ title: 'Spuddy', body }).show();
  } catch (e) {
    // notifications are a convenience — the tray menu still tells the story
  }
}

function rebuildMenu(): void {
  if (!tray) return;
  const L = LABELS[effective];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Spuddy v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
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
      updateItem(L),
      { type: 'separator' },
      { label: L.quit, click: () => app.quit() },
    ])
  );
}

export function createTray(): void {
  effective = systemLang();
  onUpdateStatus((u) => {
    maybeNotify(u); // manual-check feedback + the one "update staged" nudge
    rebuildMenu(); // update entry morphs as the updater progresses
  });
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
