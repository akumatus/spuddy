# Spuddy server

A single Cloudflare Worker that acts as the potato's model gateway:

- **Daily card factory** — a cron trigger knits one shared pool of normal cards
  (voice-neutral, every persona draws from it) plus per-persona golden and
  mutter pools, and stores them in KV. The app pulls `GET /cards` and draws from
  it locally, so ordinary gacha draws never hit an LLM (instant + offline-safe).
- **Real-time endpoints** — `POST /chat` and `POST /golden` run through an ordered
  provider fallback chain (`anthropic → openai → gemini → deepseek`; a backend with
  no key is skipped) and are metered against a per-device daily budget so nobody
  can run up your API bill.

Your API keys live only here as Worker secrets — they never ship inside the
Electron app.

## Endpoints

| Method | Path               | Notes                                             |
| ------ | ------------------ | ------------------------------------------------- |
| GET    | `/cards[?char=id]` | Today's pre-generated pool(s).                    |
| POST   | `/chat`            | Body: `{deviceId,charId,day,memory,messages}`. 429 when over quota. |
| POST   | `/golden`          | Body: `{deviceId,charId,memory}`. Same quota.     |
| POST   | `/admin/generate?lang=en\|zh` | Manual regen, one language per call. Header `x-pp-admin: <ADMIN_TOKEN>`. |
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

# 4. knit the first batches now (cron fills them going forward) — one call
#    per language: a single invocation's subrequest budget only fits one batch
curl -X POST "https://<your-worker>.workers.dev/admin/generate?lang=en" \
  -H "x-pp-admin: <ADMIN_TOKEN>"
curl -X POST "https://<your-worker>.workers.dev/admin/generate?lang=zh" \
  -H "x-pp-admin: <ADMIN_TOKEN>"
```

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in real keys
npm run dev                      # http://localhost:8787

# Pick the LLM for the session — A/B chat models, or swap the cron generator.
# Names: deepseek | openai (gpt) | gemini | anthropic (claude). Restart to switch.
npm run dev -- --llm claude               # chat + cron both on Claude
npm run dev -- --llm gpt --gen deepseek   # chat on GPT, cron on DeepSeek
# (the chosen provider needs its key in .dev.vars, else /chat returns null)

npm run gen:dev                  # generate a batch locally (uses the session's --gen)

# hit chat directly (force one backend with x-pp-provider for A/B; needs x-pp-admin):
curl -s -X POST localhost:8787/chat -H 'x-pp-admin: dev' -H 'x-pp-provider: openai' \
  -d '{"deviceId":"t","charId":"spud","day":1,"messages":[{"who":"user","text":"rough day"}]}'
```

To A/B in the actual app, point it at the local Worker
(`~/.config/spuddy/config.json` → `{ "serverUrl": "http://localhost:8787" }`),
then restart `npm run dev -- --llm <name>` between models.

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
- `CARDS_PER_DAY` — size of the shared normal pool per day; `GOLDEN_PER_DAY` —
  golden lines per persona per day.
- `CHAT_PROVIDER` / `GEN_PROVIDER` + `*_MODEL` — pick the PRIMARY provider each
  chain starts from (chat vs. cron); the rest of the fallback chain backs it up.
- Change providers/models **live** (no redeploy) via KV config:

  ```bash
  # read current
  curl https://<worker>/admin/config -H 'x-pp-admin: <ADMIN_TOKEN>'
  # switch cron generation to OpenAI, keep chat on the Claude default
  curl -XPOST https://<worker>/admin/config -H 'x-pp-admin: <ADMIN_TOKEN>' \
    -d '{"gen":"openai","models":{"anthropic":"claude-haiku-4-5"}}'
  ```

  Keys: `chat`, `gen` (primary provider per path) + optional `models` (per-provider
  model id). Missing keys fall back to the `[vars]` defaults above.
