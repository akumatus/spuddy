#!/usr/bin/env bash
#
# One command to refresh every product screenshot from the current 3D models.
# Regenerates the buddy portraits, re-shoots the media that shows a buddy, and
# propagates both to the README (docs/media) AND the marketing site
# (web/assets) — then STOPS with a git status so you can review the diff. It
# commits/pushes/deploys only when you ask.
#
#   yarn refresh-media                # regenerate + propagate, then stop for review
#   yarn refresh-media --push         # ...and commit + push the asset changes
#   yarn refresh-media --deploy       # ...and deploy the site to spud.cherry.surf
#   yarn refresh-media --push --deploy
#
# Rendering is Electron + real WebGL, so this must run on a machine with a GPU
# (your Mac) — it can't run in a headless/cloud sandbox. Update the .glb models,
# run this, review, then re-run with --push --deploy (or commit/deploy by hand).
#
# Scope: this handles model updates to the EXISTING roster. Adding, removing, or
# renaming a buddy (e.g. the Leo -> Mochi recast) also needs the roster edited in
# src/content.ts and any now-stale docs/media/char-<old>.png removed by hand.
set -euo pipefail

PUSH=0
DEPLOY=0
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    --deploy) DEPLOY=1 ;;
    *) echo "refresh-media: unknown flag '$a' (use --push and/or --deploy)"; exit 2 ;;
  esac
done

APP="$(cd "$(dirname "$0")/.." && pwd)"   # app/
ROOT="$(cd "$APP/.." && pwd)"             # repo root
PORT=5233
URL="http://localhost:$PORT"
cd "$APP"

# ── dev server ──
# The studios POST each rendered portrait to the vite dev server's __char-save
# middleware (vite.config.ts), which only exists in dev mode — so a real `vite`
# server is required, not a static preview.
echo "▸ starting vite on :$PORT …"
node_modules/.bin/vite --port "$PORT" --strictPort >/tmp/refresh-media-vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$URL/buddy-studio.html"; then break; fi
  if [ "$i" = 60 ]; then echo "vite did not come up:"; cat /tmp/refresh-media-vite.log; exit 1; fi
  sleep 0.5
done

# ── 1. portraits from the models (public/chars/char-*.png) ──
echo "▸ regenerating buddy portraits …"
SHOT_URL="$URL" node_modules/.bin/electron scripts/shoot-chars.cjs

# ── 2. every media shot ──
# Deliberately ALL of them, not just the buddy-bearing ones. Scoping this to
# "shots with a buddy in them" once left docs/media/cardbook.png stale after the
# demo card lines changed — the shots share fixtures (DEMO_CARDS, DEMO_MEMORY),
# so anything can go out of date for reasons that have nothing to do with a
# model. Re-shooting everything is a few extra seconds and removes the footgun.
echo "▸ re-shooting media …"
SHOT_URL="$URL" node_modules/.bin/electron scripts/shoot-media.cjs

kill "$VITE_PID" 2>/dev/null || true
trap - EXIT

# ── 3. propagate portraits → README footer / docs, and the site roster ──
# The site uses display names for two buddies (donut is Sprinkles, grad is
# Prof); keep this mapping in step with src/content.ts CHARS + web/index.html.
echo "▸ propagating portraits …"
for id in spud taco donut bloom mochi grad; do
  cp "$APP/public/chars/char-$id.png" "$ROOT/docs/media/char-$id.png"
done
cp "$APP/public/chars/char-spud.png"  "$ROOT/web/assets/char/spud.png"
cp "$APP/public/chars/char-taco.png"  "$ROOT/web/assets/char/taco.png"
cp "$APP/public/chars/char-bloom.png" "$ROOT/web/assets/char/bloom.png"
cp "$APP/public/chars/char-mochi.png" "$ROOT/web/assets/char/mochi.png"
cp "$APP/public/chars/char-donut.png" "$ROOT/web/assets/char/sprinkles.png"
cp "$APP/public/chars/char-grad.png"  "$ROOT/web/assets/char/prof.png"

# ── 4. propagate the two shots the site embeds ──
cp "$ROOT/docs/media/golden.png"     "$ROOT/web/assets/golden.png"
cp "$ROOT/docs/media/chat-bloom.png" "$ROOT/web/assets/chat-bloom.png"

# ── review / act ──
cd "$ROOT"
echo
echo "── regenerated (review before committing) ──"
git status --short -- app/public/chars docs/media web/assets
echo

if [ "$PUSH" = 0 ] && [ "$DEPLOY" = 0 ]; then
  echo "Looks good? Land it with:"
  echo "  yarn --cwd app refresh-media --push --deploy"
  exit 0
fi

if [ "$PUSH" = 1 ]; then
  echo "▸ committing + pushing asset changes …"
  # scoped to the asset dirs on purpose — never web/index.html or other work
  git add app/public/chars docs/media web/assets
  git commit -m "Regenerate product screenshots from the updated 3D models"
  git push
fi

if [ "$DEPLOY" = 1 ]; then
  echo "▸ deploying site to spud.cherry.surf …"
  (cd web && ../server/node_modules/.bin/wrangler deploy)
fi

echo "▸ done."
