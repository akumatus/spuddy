import { Menu, Tray, app, nativeImage } from 'electron';
import path from 'node:path';
import { getWin } from './window';

let tray: Tray | null = null;

export function createTray(): void {
  try {
    // monochrome template — macOS tints it for the light/dark menu bar
    const img = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'trayTemplate.png')
    );
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Spuddy');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show / Hide',
          click: () => {
            const win = getWin();
            if (win) win.isVisible() ? win.hide() : win.show();
          },
        },
        { type: 'separator' },
        { label: 'Quit Spuddy', click: () => app.quit() },
      ])
    );
  } catch (e) {
    // tray is a convenience — the app works without it
  }
}
