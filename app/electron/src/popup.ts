// The popup window: card / book / buddies popups live in their own frameless
// window at NORMAL level, so clicking another app stacks that app above the
// popup, and clicking the popup raises it back — while the pet window keeps
// floating above everything, always.
//
// The pet renderer stays the single owner of popup content and behavior: it
// mirrors #modal's markup here over IPC ('popup-show'), and this window sends
// clicks back as child-index paths ('popup-click') that the pet renderer
// re-dispatches on its hidden staging tree, so every existing handler keeps
// working unchanged.
import { BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getWin } from './window';

let popup: BrowserWindow | null = null;

export function getPopup(): BrowserWindow | null {
  return popup;
}

export function createPopupWindow(): void {
  popup = new BrowserWindow({
    width: 780,
    height: 700,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false, // the popup cards paint their own soft shadows
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  popup.loadFile(path.join(__dirname, '..', 'dist', 'popup.html'));
  popup.on('closed', () => { popup = null; });

  popup.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[popup:${level}]`, message);
  });
  // popup-window twins of the PP_UITEST / PP_SNAPSHOT hooks in window.ts —
  // live layout and scroll positions exist only in this window, so automated
  // checks need their own probe here. Timed after the pet-side PP_UITEST (5s)
  // so a scripted book-open has landed before the popup is inspected.
  if (process.env.PP_UITEST_POPUP) {
    const t = process.env.PP_UITEST_POPUP;
    const code = t.startsWith('js:')
      ? t.slice(3)
      : `document.getElementById(${JSON.stringify(t)}).click()`;
    setTimeout(() => {
      popup?.webContents.executeJavaScript(code)
        .catch((e) => console.log('[uitest-popup] failed', e.message));
    }, 6500);
  }
  if (process.env.PP_SNAPSHOT_POPUP) {
    setTimeout(async () => {
      try {
        if (!popup) return;
        const img = await popup.webContents.capturePage();
        fs.writeFileSync(process.env.PP_SNAPSHOT_POPUP!, img.toPNG());
        console.log('[snapshot-popup] saved', process.env.PP_SNAPSHOT_POPUP);
      } catch (e) {
        console.log('[snapshot-popup] failed', (e as Error).message);
      }
    }, 9000);
  }
}

// center the popup on the display the potato lives on
function centerOnPetDisplay(w: number, h: number): void {
  if (!popup) return;
  const anchor = getWin()?.getBounds() ?? popup.getBounds();
  const wa = screen.getDisplayMatching(anchor).workArea;
  popup.setBounds({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w,
    height: h,
  });
}

export function registerPopupIpc(): void {
  // pet renderer → popup: full markup mirror (initial open and every re-render)
  ipcMain.on('popup-show', (_e, html: string, panel: boolean, htmlClass: string) => {
    popup?.webContents.send('popup-render', html, panel, htmlClass);
  });

  ipcMain.on('popup-hide', () => {
    popup?.hide();
  });

  // popup → pet renderer: a click, as a child-index path into the markup
  ipcMain.on('popup-click', (e, clickPath: number[]) => {
    if (popup && e.sender === popup.webContents) {
      getWin()?.webContents.send('popup-click', clickPath);
    }
  });

  // popup → pet renderer: a data-page-up box scrolled to its top — the pet
  // renderer pages older content into the markup (see src/popup-shell.ts)
  ipcMain.on('popup-pageup', (e, boxPath: number[]) => {
    if (popup && e.sender === popup.webContents) {
      getWin()?.webContents.send('popup-pageup', boxPath);
    }
  });

  // popup shell measured its content: size the window to fit, center it on
  // first show (later resizes — e.g. book tab switches — keep the center)
  ipcMain.on('popup-resize', (e, w: number, h: number) => {
    if (!popup || e.sender !== popup.webContents) return;
    const width = Math.max(120, Math.round(w));
    const height = Math.max(80, Math.round(h));
    if (popup.isVisible()) {
      const b = popup.getBounds();
      popup.setBounds({
        x: Math.round(b.x + (b.width - width) / 2),
        y: Math.round(b.y + (b.height - height) / 2),
        width,
        height,
      });
    } else {
      centerOnPetDisplay(width, height);
      popup.show();
    }
  });
}

// Clicking the potato re-activates Spuddy: bring its popup along, the way
// clicking any app's window surfaces that app's other windows.
export function raisePopupWithPet(): void {
  if (popup?.isVisible()) popup.moveTop();
}

// the popup has no life of its own — when the pet window goes, it goes
export function closePopupWindow(): void {
  popup?.close();
}
