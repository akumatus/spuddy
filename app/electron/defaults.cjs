// Baked-in production defaults, shipped inside the build so a distributed app
// reaches the server with no local config file. Precedence (see main.cjs):
//   env (PP_SERVER_URL / PP_APP_TOKEN)  >  user config.json  >  these defaults
//
// APP_TOKEN here is a SOFT GATE, not a secret: it ships in every build and is
// extractable, so committing it doesn't weaken it. Real protection is the
// server's per-device daily quota. If this repo is public and you'd rather not
// have it in git, blank it here and inject PP_APP_TOKEN at build time instead
// (and rotate the Worker's APP_TOKEN secret).
module.exports = {
  SERVER_URL: 'https://api.cherry.surf',
  APP_TOKEN: 'c481db09487ec84589f727d260ad2dd976d642bb25aa7b9e',
};
