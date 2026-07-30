// Baked-in production defaults, shipped inside the build so a distributed app
// reaches the server with no local config file. Precedence (see config.ts):
//   env (PP_SERVER_URL / PP_APP_TOKEN)  >  user config.json  >  build-time
//   injection (__PP_APP_TOKEN__)  >  these defaults
//
// APP_TOKEN is deliberately EMPTY here and must stay that way. This repo is
// public, and a token sitting in it is found for free by anyone reading the
// source or by an automated secret scanner. The real value is injected at
// build time from the PP_APP_TOKEN environment variable — see
// scripts/build-electron.mjs and the release workflow.
//
// It was never a strong secret either way: it ships inside every build and
// `npx asar extract` recovers it. The server's per-device quota, per-IP rate
// limit and input caps are the actual defense; this only keeps the endpoint
// away from drive-by callers.
export const DEFAULTS = {
  SERVER_URL: 'https://api.cherry.surf',
  APP_TOKEN: '',
};
