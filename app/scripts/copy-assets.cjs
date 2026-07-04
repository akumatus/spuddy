const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dracoSrc = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco');
const dracoDst = path.join(root, 'public', 'draco');

fs.mkdirSync(dracoDst, { recursive: true });
for (const f of fs.readdirSync(dracoSrc)) {
  const src = path.join(dracoSrc, f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dracoDst, f));
}
console.log('copied draco decoders to public/draco');
