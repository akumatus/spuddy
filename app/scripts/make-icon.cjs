// Build the macOS app icon from design 4b「从底边升起」— the whole potato rises
// from the bottom edge, holding its own white card with a red heart, on a soft
// blue squircle. Source art is public/chars/char-spud.png (the glasses potato,
// whose card area is transparent — we fill it with the white card behind him).
//
//   node scripts/make-icon.cjs
//
// Outputs assets/icon.png (1024 master) and assets/icon.icns (packed iconset).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'public', 'chars', 'char-spud.png');
const OUT_DIR = path.join(root, 'assets');
const MASTER = path.join(OUT_DIR, 'icon.png');
const ICNS = path.join(OUT_DIR, 'icon.icns');
const TRAY = path.join(OUT_DIR, 'trayTemplate.png');
const TRAY2X = path.join(OUT_DIR, 'trayTemplate@2x.png');

// ── palette (from the app: --red #b9543f) ──
const BLUE = '#aac5cc';       // soft dusty-blue squircle background
const CARD = '#fefdfb';       // warm white card
const HEART = '#b9543f';      // brick red, matches the app's --red
const HEART_LINE = '#8f3b2c'; // darker hand-drawn heart outline

const S = 1024;                       // master size
const RADIUS = Math.round(S * 0.2235); // Apple continuous-corner squircle radius

// ── potato placement (tuned visually against the 4b mock) ──
const SPUD_W = 381, SPUD_H = 484;      // source dimensions
const CONTENT_TOP = 6;                 // first opaque row (head crown)
const CARD_CX = 184, CARD_CY = 336;    // centre of the transparent card hole
const scale = (S * 0.82) / SPUD_W;     // potato spans ~82% of the icon width
const topMargin = S * 0.05;            // blue breathing room above the head
const imgW = Math.round(SPUD_W * scale);
const imgH = Math.round(SPUD_H * scale);
const imgLeft = Math.round((S - imgW) / 2);
const imgTop = Math.round(topMargin - CONTENT_TOP * scale);

// where the card hole lands in the final canvas
const cardCx = imgLeft + Math.round(CARD_CX * scale);
const cardCy = imgTop + Math.round(CARD_CY * scale);

const squircle = (size, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
  `<rect x="0" y="0" width="${size}" height="${size}" rx="${size * 0.2235}" ry="${size * 0.2235}" fill="${fill}"/></svg>`;

// white card + red heart, drawn where the potato's hands hold it
function cardLayer() {
  const cw = Math.round(240 * scale);   // card slightly wider than the visible gap
  const ch = Math.round(150 * scale);
  const cx = cardCx - cw / 2;
  const cy = cardCy - ch * 0.5;
  const hs = Math.round(cw * 0.46);     // heart size — leaves white margin all round
  const hx = cardCx - hs / 2;
  const hy = cardCy - hs * 0.46;        // nudge up: the heart's mass sits high
  // classic rounded heart in a 100×100 box
  const heartPath =
    'M50 87 C22 63 6 47 6 30 C6 15 18 6 31 6 C40 6 47 11 50 18 ' +
    'C53 11 60 6 69 6 C82 6 94 15 94 30 C94 47 78 63 50 87 Z';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
      `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="${18 * scale}" ry="${18 * scale}" ` +
      `fill="${CARD}" stroke="#e7ddc8" stroke-width="${2 * scale}"/>` +
      `<g transform="translate(${hx},${hy}) scale(${hs / 100})">` +
      `<path d="${heartPath}" fill="${HEART}" stroke="${HEART_LINE}" stroke-width="6" ` +
      `stroke-linejoin="round" stroke-linecap="round"/></g>` +
    `</svg>`
  );
}

async function buildMaster() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // crop off whatever runs past the icon's bottom edge — that overflow is the
  // "rising from the bottom" cut, and sharp can't composite an oversized layer
  const visibleH = Math.min(imgH, S - imgTop);
  const potato = await sharp(SRC)
    .resize(imgW, imgH)
    .extract({ left: 0, top: 0, width: imgW, height: visibleH })
    .toBuffer();

  // base blue squircle → card behind → potato on top
  const composed = await sharp(Buffer.from(squircle(S, BLUE)))
    .composite([
      { input: cardLayer(), top: 0, left: 0 },
      { input: potato, top: imgTop, left: imgLeft },
    ])
    .png()
    .toBuffer();

  // clip everything to the squircle so the potato's cropped bottom keeps the
  // straight bottom edge and rounded corners
  const mask = await sharp(Buffer.from(squircle(S, '#fff'))).png().toBuffer();
  await sharp(composed)
    .composite([{ input: mask, blend: 'dest-in' }])
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
