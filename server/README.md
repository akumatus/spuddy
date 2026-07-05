# Spuddy server

A single Cloudflare Worker that acts as the potato's model gateway:

- **Daily card factory** — a cron trigger knits a fresh pool of cards per persona
  and stores it in KV. The app pulls `GET /cards` and draws from it locally, so
  ordinary gacha draws never hit an LLM (instant + offline-safe).
- **Real-time endpoints** — `POST /chat` and `POST /golden` are geo-routed
  (CN → DeepSeek, elsewhere → Gemini/GPT via `INTL_PROVIDER`) and metered against
  a per-device daily budget so nobody can run up your API bill.

Your API keys live only here as Worker secrets — they never ship inside the
Electron app.

## Endpoints

| Method | Path               | Notes                                             |
| ------ | ------------------ | ------------------------------------------------- |
| GET    | `/cards[?char=id]` | Today's pre-generated pool(s).                    |
| POST   | `/chat`            | Body: `{deviceId,charId,day,memory,messages}`. 429 when over quota. |
| POST   | `/golden`          | Body: `{deviceId,charId,memory}`. Same quota.     |
| POST   | `/admin/generate`  | Manual regen. Header `x-pp-admin: <ADMIN_TOKEN>`. |
| GET    | `/health`          | Liveness.                                         |

## First deploy

```bash
cd server
npm install

# 1. create the KV namespace, paste the printed id into wrangler.toml
npx wrangler kv namespace create SPUDDY_KV

# 2. set secrets (only the providers you actually use)
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put APP_TOKEN        # optional soft gate
npx wrangler secret put ADMIN_TOKEN      # protects /admin/generate

# 3. ship it
npx wrangler deploy

# 4. knit the first batch now (cron fills it going forward)
curl -X POST https://<your-worker>.workers.dev/admin/generate \
  -H "x-pp-admin: <ADMIN_TOKEN>"
```

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in real keys
npm run dev                      # http://localhost:8787
npm run gen:dev                  # generate a batch locally

# test geo routing without leaving your desk:
curl -s -X POST localhost:8787/chat -H 'x-pp-geo: CN' \
  -d '{"deviceId":"t","charId":"spud","day":1,"messages":[{"who":"user","text":"rough day"}]}'
```

## Point the app at it

In the Electron app, set the server URL + token (env or the app config file
`~/.config/spuddy/config.json`):

```jsonc
{ "serverUrl": "https://<your-worker>.workers.dev", "appToken": "<APP_TOKEN>" }
```

Or via env: `PP_SERVER_URL=... PP_APP_TOKEN=...`. With no `serverUrl` set the app
falls back to its built-in offline content (and, if present, a local Anthropic
key) — so dev builds keep working without the server.

## Cost / knobs

- `CHAT_DAILY_LIMIT` — real-time calls per device per day (chat + golden).
- `CARDS_PER_DAY` / `GOLDEN_PER_DAY` — pool sizes per persona per day.
- `INTL_PROVIDER` / `GEN_PROVIDER` + `*_MODEL` — swap providers/models without
  touching the app.
