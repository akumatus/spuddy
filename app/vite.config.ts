import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// dev-only: icon-studio.html POSTs its 1024px master render here so
// scripts/make-icon.cjs can compose the shipped icon from a real file
const iconSave: Plugin = {
  name: 'icon-save',
  configureServer(server) {
    server.middlewares.use('/__icon-save', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end('POST only');
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const out = path.join(here, 'scripts', 'icon-src', 'icon-content.png');
        fs.writeFileSync(out, Buffer.concat(chunks));
        res.end('saved');
      });
    });
  },
};

// dev-only: buddy-studio.html POSTs each buddy's cropped 3D portrait here so
// the Buddies panel / unlock popups / card-book avatar show our own renders
const charSave: Plugin = {
  name: 'char-save',
  configureServer(server) {
    server.middlewares.use('/__char-save', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end('POST only');
      }
      const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
      if (!/^[a-z]+$/.test(id)) {
        res.statusCode = 400;
        return res.end('bad id');
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const out = path.join(here, 'public', 'chars', `char-${id}.png`);
        fs.writeFileSync(out, Buffer.concat(chunks));
        res.end('saved');
      });
    });
  },
};

export default defineConfig({
  base: './',
  plugins: [iconSave, charSave],
  build: {
    outDir: 'dist',
    target: 'chrome120',
  },
});
