// In dev we launch the prebuilt Electron.app straight from node_modules, so the
// dock tooltip and menu-bar app name come from THAT bundle's Info.plist —
// which reads "Electron". app.setName() can't change those OS-level labels, so
// we patch the dev bundle's plist to the productName. Packaged builds bake the
// real name in via electron-builder, so this is a macOS dev-only convenience.
//
// Idempotent, best-effort: wired into `npm start` / `npm run dev`. node_modules
// is gitignored and reinstall resets the bundle, so we just re-apply each run.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const NAME = require('../package.json').productName || 'Spuddy';
const plist = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
);

if (!fs.existsSync(plist)) process.exit(0);

const appBundle = path.dirname(path.dirname(plist)); // …/Electron.app

try {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    // Set if present, otherwise Add — either way ends up as NAME.
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${NAME}`, plist]);
    } catch (e) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${NAME}`, plist]);
    }
  }
  // LaunchServices caches the bundle's name by path, so the dock tooltip keeps
  // showing the old name until we force a re-register of the patched bundle.
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
    'LaunchServices.framework/Support/lsregister';
  try {
    execFileSync(lsregister, ['-f', appBundle]);
  } catch (e) {
    // older macOS may not ship lsregister at this path — the plist is still patched
  }
  console.log(`dev bundle name → ${NAME}`);
} catch (e) {
  // non-fatal — dev just shows "Electron" in the dock tooltip
}
