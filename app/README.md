# Spuddy 🥔

A hand-crocheted potato that lives in the bottom-right corner of your desktop,
holding a little card and handing you encouragement. Built from the Claude
Design "Spuddy desktop-pet prototype".

## Run

```bash
cd app
npm install
npm start
```

There's a small potato tray icon in the menu bar: Show / Hide, Quit.

> Dev note: `npm start` / `npm run dev` run `scripts/set-dev-name.cjs` first so the
> dock tooltip and menu-bar name read "Spuddy" instead of "Electron" (the dev
> bundle's default). Packaged builds get the name from the `build` config.

## What it does

- **Poke him (the body)** — a random reaction each time: squash / hop / wobble /
  peek / spin / sneeze / jump-twist… (part-rigged characters also roll their
  eyes, flip the card, wave), with a small chance of a full skit (chasing his
  tail, humming, reading the card, a card-flip routine, wave practice — with
  mutters and sound). The last two actions never repeat, and rapid pokes don't
  stack while a reaction is playing — no popups. Dozing off and tapping on the
  glass to say hi are triggered only by his own state.
- **Tap the white card in his hands** — the only way to open the card popup: if
  you haven't drawn today, it draws the daily card (which reads `tap me :)`);
  otherwise it re-shows today's card. Tap `Keep it ♥` to file it into the book.
- **Move the mouse** — he turns to follow your cursor (eyes lead, head follows);
  when idle he blinks and glances around on his own.
- **Days 3, 8, 13…** — a Golden Stitch card: the AI knits one by hand from the
  things you've talked about.
- **Hover the potato** — a chat box and icons appear on the left; tell him what's
  on your mind and he'll remember (delete anything anytime in the Memory tab).
- **Card book (♥ icon)** — three tabs: Cards / Buddies / Memory. Collecting cards
  unlocks 5 new buddies (Taco, Sprinkles, Bloom, Leo, Prof); once unlocked you
  can switch who's on duty.
- **z z icon** — tuck him away for a nap; tap his little head to wake him.
- **Drag** — drag the whole potato anywhere on screen; a horizontal fling sets
  him spinning and he settles back with an underdamped spring.
- Working 90 minutes straight prompts a stretch; after 11pm he nudges you to
  sleep.
- **He lives his own life (7a personality engine)** — three needs (energy /
  boredom / missing-you) rise and fall over time: bored, he entertains himself
  (chasing his tail, flipping the card, reading it to himself, wave practice,
  humming); sleepy, he dozes (nods off and jerks upright, a poke startles him
  awake); missing you too much, he taps the glass to get your attention —
  responding (a poke) makes him cheer, being ignored just wilts him for 3s and
  doubles his back-off so he never nags; coming back after 30s+ away earns a
  welcome. He mutters in dashed hand-drawn bubbles throughout, and only uses a
  solid bubble when he actually speaks.

## AI (chat + Golden Stitch)

The app never holds a provider key. Chat and Golden Stitch go through the
Cloudflare Worker gateway in `server/`, which keeps the key server-side and
routes to a provider (CN → DeepSeek). Point the app at a gateway in
`~/.config/spuddy/config.json`:

```json
{ "serverUrl": "http://localhost:8787" }
```

…or via the `PP_SERVER_URL` env var. Run the gateway locally with
`cd server && cp .dev.vars.example .dev.vars` (add `DEEPSEEK_API_KEY=...`) then
`npm run dev`. See [`../server/README.md`](../server/README.md).

With no gateway reachable it falls back to built-in lines automatically —
everything still works.

## App icon

The app icon is design 4b「从底边升起」(rising from the bottom edge): the potato
rises from the bottom of a soft-blue squircle, holding its own white card with a
red heart. Rebuild all icon assets with:

```bash
npm run icon
```

`scripts/make-icon.cjs` composes the art from `public/chars/char-spud.png` and
writes:

- `assets/icon.png` — 1024px master, and `assets/icon.icns` (16→1024 iconset)
  for the dock / packaged app.
- `assets/trayTemplate.png` (+`@2x`) — a monochrome menu-bar template (macOS
  tints it for the light/dark bar).

## Project layout

- `electron/main.cjs` — transparent always-on-top window, tray, dock icon,
  AI gateway calls (keys stay server-side), sedentary detection,
  global cursor polling.
- `src/motions.js` — the eased-keyframe motion system from prototype Turn 6/7
  (ported from `claude-design/project/lib/spud-scene2.js`): segmented easing,
  part tracks (claws / eyes / card), idle life, cursor follow, fling spring,
  doze/hum idle modes.
- `src/brain.js` — the 7a personality engine (ported from
  `claude-design/project/lib/spud-brain.js`): need-driven autonomous behavior
  (0.2s decision tick), four personality axes (curious / clingy / dramatic /
  sleepy, default 65/60/55/35, stored in `state.personality`); presence comes
  from whether the global cursor is moving.
- `src/content.js` — all copy, personas, and unlock rules from the design.
- `src/cardscreen.js` — the live text on the card in the model's hands
  (CanvasTexture) plus the Golden Stitch glow pulse; part-rigged models get their
  card displacement from the motion system.
- `src/scene.js` — the three.js scene: part hinges (claw = shoulder point · eye =
  own center · card = bottom edge), contact shadow, camera breathing, PBR
  lighting (RoomEnvironment IBL + ACES tone mapping + warm key/rim; legacy baked
  materials keep tone mapping off to stay as-is).
- `src/store.js` · `src/ui.js` · `src/sfx.js` · `src/remote.js` — persistence,
  DOM UI (bubbles / panel / book), sound, and the server gateway client.
- `public/models/*.glb` — the whole crew (spud, donut, taco, grad, bloom, leo) is
  part-rigged, exported by Rodin **PBR export** (`base_basic_pbr.glb`) and
  processed by `scripts/process_rodin_pbr.mjs`: part detection (body / card / two
  side hands / the two smallest eyes; extra trim like taco's lettuce shell, the
  grad cap, or bloom's bouquet + pot and leo's mane is named `trim`, has no rig
  slot, and rides the body statically for squash/displace/rotate), albedo
  deep-cavity diffusion fill (eyes and trim are protected along with their UVs —
  their near-black is intentional, don't wipe out the black cap or the bead
  eyes), atlas edge padding, simplify + Draco, keeping the
  baseColor/normal/metallicRoughness maps for real-time lighting — the PBR export
  carries no baked lighting layer, so occlusion black / contact shadow / seam
  creases simply don't exist to begin with. When an export bakes the bead eyes
  into the body instead of leaving them as separate meshes (bloom, leo), no eye
  mesh is rigged and the painted-on eyes stay fixed — no blink/dart, same as the
  legacy single-mesh look.
- `public/models/cards.json` — per-character card-plane calibration: part-rigged
  characters are emitted by `process_rodin_pbr.mjs`, single-mesh characters by
  `scripts/detect_cards.py`.

## Card-plane calibration (when adding a character)

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/detect_cards.py -- \
  public/models/<id>.glb /tmp/<id>.json /tmp/<id>
```

The script picks card faces by "high brightness + low saturation + forward
normal + lower body", fits a plane with RANSAC, and outputs the center / normal /
width-height / forward offset (compensating for the card's outward bulge), plus
`-front/-side/-tex` verification renders (the red calibration block should line
up with the white card in the texture reference). Once it checks out, merge the
JSON into `public/models/cards.json`.
