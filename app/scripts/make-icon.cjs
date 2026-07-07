// Build the macOS app icon from design 1b「经典全身」— the crocheted potato
// holding its white heart card, real 3D render on the warm cream gradient,
// clipped to the Apple icon-grid squircle (80.5% content, baked dock shadow).
// Source design: claude-design/project/Spuddy App Icon.dc.html.
//
// The 1024 master render comes from the icon studio page (needs WebGL, so it
// runs in a browser against the dev server):
//
//   npx vite . --port 5199        # from app/, then open
//   http://localhost:5199/icon-studio.html
//
// The page renders the scene and auto-saves scripts/icon-src/icon-content.png
// through the dev-server middleware (see vite.config.js). Then:
//
//   node scripts/make-icon.cjs
//
// Outputs assets/icon.png (1024 master) and assets/icon.icns (packed iconset).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const CONTENT = path.join(__dirname, 'icon-src', 'icon-content.png');
const OUT_DIR = path.join(root, 'assets');
const MASTER = path.join(OUT_DIR, 'icon.png');
const ICNS = path.join(OUT_DIR, 'icon.icns');
const TRAY = path.join(OUT_DIR, 'trayTemplate.png');
const TRAY2X = path.join(OUT_DIR, 'trayTemplate@2x.png');

// ── icon geometry (design 1b drawIcon) ──
const S = 1024;                        // master size
const W = Math.round(S * 0.805);       // Apple icon grid: content squircle width
const X = Math.round((S - W) / 2);
const RADIUS = Math.round(W * 0.225);  // macOS 曲率圆角

// dock-style drop shadow baked into the master, per the design:
// shadowBlur S*0.028 (canvas blur ≈ 2σ), offsetY S*0.012, warm brown at 32%
const SHADOW_SIGMA = (S * 0.028) / 2;
const SHADOW_DY = S * 0.012;

const squircle = (size, r, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
  `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${fill}"/></svg>`;

const shadowSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
  `<defs><filter id="ds" x="-30%" y="-30%" width="160%" height="160%">` +
  `<feDropShadow dx="0" dy="${SHADOW_DY}" stdDeviation="${SHADOW_SIGMA}" ` +
  `flood-color="#3E3226" flood-opacity="0.32"/></filter></defs>` +
  `<rect x="${X}" y="${X}" width="${W}" height="${W}" rx="${RADIUS}" ry="${RADIUS}" ` +
  `fill="#000" filter="url(#ds)"/></svg>`;

async function buildMaster() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(CONTENT)) {
    throw new Error(
      'missing ' + path.relative(root, CONTENT) +
      ' — render it first via icon-studio.html (see header comment)'
    );
  }
  // content resized to the grid width, clipped to the squircle
  const mask = await sharp(Buffer.from(squircle(W, RADIUS, '#fff'))).png().toBuffer();
  const content = await sharp(CONTENT)
    .resize(W, W)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // transparent canvas → baked shadow → squircled content on top
  await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: Buffer.from(shadowSvg), top: 0, left: 0 },
      { input: content, top: X, left: X },
    ])
    .png()
    .toFile(MASTER);
  console.log('wrote', path.relative(root, MASTER));
}

async function buildIcns() {
  const iconset = path.join(OUT_DIR, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const targets = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [px, name] of targets) {
    await sharp(MASTER).resize(px, px).png().toFile(path.join(iconset, name));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('wrote', path.relative(root, ICNS));
}

// ── menu-bar tray icon ──
// The design's menu-bar template: an outlined card with a heart (「卡片 + 心」).
// Monochrome black shape on transparent — macOS tints it for the light/dark bar.
function traySvg(size) {
  // classic rounded heart in its own 100×100 box, centred in the card
  const heart =
    'M50 84 C24 62 9 47 9 30 C9 16 20 7 32 7 C41 7 47 12 50 19 ' +
    'C53 12 59 7 68 7 C80 7 91 16 91 30 C91 47 76 62 50 84 Z';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
      // card outline
      `<rect x="12" y="24" width="76" height="54" rx="13" fill="none" stroke="black" stroke-width="9"/>` +
      // heart, filled, centred in the card
      `<g transform="translate(33.5,35) scale(0.33)"><path d="${heart}" fill="black"/></g>` +
    `</svg>`
  );
}

async function buildTray() {
  await sharp(Buffer.from(traySvg(18))).png().toFile(TRAY);
  await sharp(Buffer.from(traySvg(36))).png().toFile(TRAY2X);
  console.log('wrote', path.relative(root, TRAY), '(+@2x)');
}

(async () => {
  await buildMaster();
  await buildIcns();
  await buildTray();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
