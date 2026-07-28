// Regenerate the buddy portraits — `yarn chars` (needs the vite dev server up).
//
// buddy-studio.html drives the real PetScene once per buddy and POSTs each
// alpha-cropped portrait to the vite dev-server middleware (see vite.config.ts
// __char-save), which writes public/chars/char-<id>.png. Those portraits are
// what the Buddies panel, the card-book avatars and the daily/golden card
// popups all read — so they must be re-shot whenever a .glb model changes,
// before the media shots that show them (`yarn shots buddies` etc.).
//
// This is the headless counterpart to opening buddy-studio.html in a browser:
// same page, driven in an offscreen Electron window so it can run from a script.
const { app, BrowserWindow } = require('electron');

const BASE = process.env.SHOT_URL || 'http://localhost:5199';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    // frames must land even while hidden, or the GL render races the readback
    webPreferences: { backgroundThrottling: false },
  });

  try {
    console.log(`regenerating portraits from ${BASE} …`);
    await win.loadURL(`${BASE}/buddy-studio.html`);

    // buddy-studio.ts renders every CHARS buddy, POSTs each to __char-save, then
    // sets window.__ready (or window.__error). Poll for either.
    const t0 = Date.now();
    for (;;) {
      const done = await win.webContents.executeJavaScript('window.__ready || false');
      const err = await win.webContents.executeJavaScript('window.__error || null');
      if (err) throw new Error(err);
      if (done) break;
      if (Date.now() - t0 > 120000) throw new Error('timed out waiting for portraits');
      await sleep(200);
    }

    // surface what was written, and at what size, so a bad crop is visible
    const status = await win.webContents.executeJavaScript(
      "document.getElementById('status') && document.getElementById('status').textContent"
    );
    console.log(`  ${status}`);
    app.exit(0);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    app.exit(1);
  }
});
