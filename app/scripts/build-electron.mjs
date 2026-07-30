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
// Building with no PP_APP_TOKEN set is fine and normal for local development:
// the constant becomes '' and config.ts falls back to the env var or
// ~/.config/spuddy/config.json. A LOCAL build therefore cannot talk to the
// production server unless you supply the token one of those ways.
import esbuild from 'esbuild';

const token = process.env.PP_APP_TOKEN || '';

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

console.log(token ? '  app token: injected from PP_APP_TOKEN' : '  app token: none (local build — set PP_APP_TOKEN or ~/.config/spuddy/config.json)');
