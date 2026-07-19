// README screenshot driver — `yarn shots` (needs the vite dev server up).
//
// Loads shots.html once per shot in a real Electron window, and captures each
// through the DevTools protocol with the page's backdrop forced transparent
// (Emulation.setDefaultBackgroundColorOverride with a=0 — the same mechanism
// puppeteer's omitBackground uses). That's what makes docs/media/*.png float on
// GitHub's light AND dark themes instead of sitting in a white box.
//
// deviceScaleFactor is pinned to 2 rather than inherited from whatever display
// happens to be attached, so the output is identical on a Retina laptop and a
// CI box. Frames are then cropped to their alpha bbox, the same way
// buddy-studio crops the character portraits.
//
// Usage:
//   node_modules/.bin/vite --port 5199 --strictPort     # (or: the icon-studio launch config)
//   yarn shots                    # all of them
//   yarn shots hero chat          # just these
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.SHOT_URL || 'http://localhost:5199';
const OUT = path.join(__dirname, '..', '..', 'docs', 'media');
const SCALE = 2; // README images are 2x — see the existing docs/media/*.png
const PAD = 24; // transparent breathing room around the alpha bbox, in output px

// Keep this list in sync with SHOTS in src/shot-studio.ts.
const ALL = ['hero', 'chat', 'chat-bloom', 'daily-card', 'golden', 'cardbook', 'memory', 'buddies'];

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const shots = wanted.length ? wanted : ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// Tight-crop the transparent frame, then re-pad evenly. The shipped shots were
// hand-cropped to wildly different margins (golden.png had 209px of air on the
// left but only 9px under the card, which clipped its own shadow) — deriving the
// box from the alpha instead frames every shot the same way, and guarantees the
// soft --shadow-pop gradient is never cut mid-fade.
//
// The scan runs over Electron's own nativeImage bitmap rather than sharp: sharp
// is a native Node addon and would need an ABI rebuild to load in Electron,
// which is a lot of machinery for one bounding box.
function cropAlpha(bmp, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // BGRA on every platform we ship — alpha is the 4th byte either way
      if (bmp[(y * width + x) * 4 + 3] > 4) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('empty render — nothing opaque in the frame');
  const left = Math.max(0, minX - PAD);
  const top = Math.max(0, minY - PAD);
  return {
    x: left,
    y: top,
    width: Math.min(width - 1, maxX + PAD) - left + 1,
    height: Math.min(height - 1, maxY + PAD) - top + 1,
  };
}

// One window, navigated per shot, with the debugger attached exactly once.
// Creating a fresh BrowserWindow per shot and destroying it crashed the whole
// run (the second window's load returned ERR_FAILED and Electron then died on
// SIGTRAP) — tearing down a webContents that still has a debugger attached
// leaves the next one unusable. Reusing the window sidesteps that entirely.
let dbg = null;

async function shoot(win, name) {
  {
    // Load BEFORE attaching: a debugger attached to a blank webContents wedges
    // on the first Page-domain command and never returns. (And nothing here
    // needs Page.enable — that only turns on Page events, which we don't read.)
    await win.loadURL(`${BASE}/shots.html?shot=${encodeURIComponent(name)}`);
    if (!dbg) {
      dbg = win.webContents.debugger;
      dbg.attach('1.3');
    }

    // phase 1 — the page registers its wanted viewport but renders nothing yet
    await until(() => win.webContents.executeJavaScript('window.__booted || !!window.__error'), `${name} to boot`);
    const bootErr = await win.webContents.executeJavaScript('window.__error || null');
    if (bootErr) throw new Error(bootErr);
    const view = await win.webContents.executeJavaScript('window.__shotView');

    // phase 2 — size the viewport, THEN let it render into it
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: view.w,
      height: view.h,
      deviceScaleFactor: SCALE,
      mobile: false,
    });
    await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    await win.webContents.executeJavaScript('window.__start()');
    await until(() => win.webContents.executeJavaScript('window.__ready || !!window.__error'), `${name} to render`);
    const err = await win.webContents.executeJavaScript('window.__error || null');
    if (err) throw new Error(err);

    const full = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    // scaleFactor 1: the buffer is already SCALE'd device pixels, and we want
    // crop() to address them 1:1 rather than re-interpret them as DIPs
    const img = nativeImage.createFromBuffer(Buffer.from(full.data, 'base64'), { scaleFactor: 1 });
    const { width, height } = img.getSize();
    const box = cropAlpha(img.getBitmap(), width, height);
    const out = path.join(OUT, `${name}.png`);
    fs.writeFileSync(out, img.crop(box).toPNG());

    console.log(`  ${name.padEnd(11)} ${String(box.width).padStart(4)}×${String(box.height).padEnd(4)}  →  docs/media/${name}.png`);
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    webPreferences: {
      // frames must land even though the window never shows, or the capture
      // races an unpainted surface
      backgroundThrottling: false,
    },
  });

  let failed = 0;
  console.log(`shooting ${shots.length} from ${BASE} @${SCALE}x`);
  for (const name of shots) {
    try {
      await shoot(win, name);
    } catch (e) {
      failed++;
      console.error(`  ${name.padEnd(11)} FAILED: ${e.message}`);
    }
  }
  if (dbg) dbg.detach();
  app.exit(failed ? 1 : 0);
});
