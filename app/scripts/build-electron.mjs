#!/usr/bin/env node
// Bundle the Electron main + preload to CJS, injecting the shared app token at
// build time.
//
// The token is NOT in the repo any more. It reaches a shipped build only
// through PP_APP_TOKEN in the build environment (a GitHub Actions secret in
// .github/workflows/release-mac.yml), and esbuild bakes it in as a literal via
// `define`. It is still extractable from the packaged app — `npx asar extract`
// is all it takes — so this is not a secret in any strong sense; it just keeps
// the value out of a public repo, where automated scanners and casual readers
// would find it for free.
//
// For local development, put the token in app/.dev.vars (git-ignored, same
// shape and spirit as server/.dev.vars):
//
//     PP_APP_TOKEN=...
//
// Without it the constant is '' and a local build simply cannot reach the
// production server — every request comes back 401.
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

// env wins (that is how CI injects it), then the local file.
function localToken() {
  try {
    const file = fs.readFileSync(path.join(process.cwd(), '.dev.vars'), 'utf8');
    return /^\s*PP_APP_TOKEN\s*=\s*(.*)$/m.exec(file)?.[1].trim().replace(/^["']|["']$/g, '') || '';
  } catch {
    return ''; // no file is the normal case in CI
  }
}

const token = process.env.PP_APP_TOKEN || localToken();

await esbuild.build({
  entryPoints: ['electron/src/main.ts', 'electron/src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outdir: 'electron',
  outExtension: { '.js': '.cjs' },
  define: { __PP_APP_TOKEN__: JSON.stringify(token) },
});

console.log(token ? '  app token: injected' : '  app token: none — create app/.dev.vars with PP_APP_TOKEN=... to reach the server');
