import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// dev-only: icon-studio.html POSTs its 1024px master render here so
// scripts/make-icon.cjs can compose the shipped icon from a real file
const iconSave = {
  name: 'icon-save',
  configureServer(server) {
    server.middlewares.use('/__icon-save', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end('POST only');
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const out = path.join(here, 'scripts', 'icon-src', 'icon-content.png');
        fs.writeFileSync(out, Buffer.concat(chunks));
        res.end('saved');
      });
    });
  },
};

export default defineConfig({
  base: './',
  plugins: [iconSave],
  build: {
    outDir: 'dist',
    target: 'chrome120',
  },
});
