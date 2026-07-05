<div align="center">

<img src="docs/media/icon.png" width="132" alt="Spuddy" />

# Spuddy

**A hand-crocheted potato who lives in the corner of your screen — and hands you a little card of encouragement, one day at a time.**

He's a *real* crocheted doll, 3D-scanned and brought to life on your desktop. He follows your cursor, mutters to himself, remembers what you tell him, and knits you a golden card when you least expect it.

<br />

![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-2B2E3A?style=flat-square&logo=electron&logoColor=9FEAF9)
![three.js](https://img.shields.io/badge/three.js-000000?style=flat-square&logo=three.js&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=anthropic&logoColor=white)

</div>

<br />

<div align="center">
  <img src="docs/media/hero.png" width="760" alt="Spuddy sitting in the corner of the desktop, holding a card that reads 'You don't have to be perfect to be wonderful', muttering 'the lamp hums. i don't mind it.'" />
</div>

<br />

> He doesn't take up a window. He doesn't ping you. He just sits in the bottom-right corner of your day, glancing over when you move your mouse, holding out something kind.

---

## 🥔 A card a day

<div align="center">
  <img src="docs/media/daily-card.png" width="300" alt="Today's card popup: 'This little potato believes in you.' — Spud" />
</div>

Tap the little white card in his hands and he hands you today's line — something warm, something dry, something you needed to hear.

- **Tap the card** to draw. Like it? **`Keep it ♥`** and it goes into your book.
- Draws are an unlimited little gacha — *"the good ones don't run out. tap the card again, go on."*
- Every card renders **on the physical card in his hands** — not a speech bubble. The card is the whole point.
- Works fully offline: a hand-written pool ships in the app, so he's never speechless.

---

## ✨ Golden Stitch

<img src="docs/media/golden.png" width="820" alt="A rare Golden Stitch card, hand-woven by the AI, signed by Sprinkles — and the pet holding that very same card in the corner" />

Every so often he goes quiet, takes his time, and **knits a golden card by hand** — woven live by Claude from the things you've actually talked about, and signed by whoever's on duty.

The card in the popup is the same one he's holding out to you in the corner. Rare on purpose. Kept forever.

---

## 💬 He listens — and he remembers

<div align="center">
  <img src="docs/media/chat.png" width="640" alt="Chat: the user says 'today was a lot', and Bloom replies 'the soil rests after a long rain. would you like to rest beside it for a bit?'" />
</div>

Hover over him and a little chat box slides out. Tell him what's on your mind.

- He replies **in character** — powered by Claude, grounded in whoever's currently on duty.
- He **remembers**. Everything you share lives in a Memory tab you fully control (delete anything, anytime).
- Each buddy has a genuinely different voice: the gardener above answers a hard day with *soil and rain*; the taco would answer it with snacks and all-caps.

---

## 🧵 Meet the crew

<div align="center">
  <img src="docs/media/buddies.png" width="720" alt="The Buddies collection: Spud, Taco, Sprinkles, Bloom, Leo, Prof — 6 of 6 friends" />
</div>

Six little souls, each a different kind of comfort. You don't buy them — you **earn** them, through six different kinds of care. Once a friend, always a friend; tap **Set active** to put anyone on duty.

---

## 🌱 He lives his own life

Spuddy isn't a screensaver — he has needs and moods, and they drift over time (a small personality engine ticks in the background).

- **Bored?** He entertains himself — chases his tail, hums, flips his card over to re-read it, practices his wave.
- **Sleepy?** He nods off, jerks upright, and a poke startles him awake.
- **Missing you?** He taps the glass to get your attention. Respond and he cheers; ignore him and he just wilts for a moment and quietly backs off — he'll never nag.
- Been away a while? He gives you a little welcome-back.

He mutters through it all in soft dashed thought-bubbles (*"the lamp hums. i don't mind it."*) and only speaks in a solid bubble when he's actually talking **to you**.

And the small stuff: 90 minutes glued to your chair and he'll ask you to stretch. Past 11pm and he'll nudge you toward bed.

---

## 🪡 What makes it special

This isn't a sprite. Under the hood:

- **It's a real crocheted doll.** Every buddy started as a physical hand-crocheted amigurumi, photographed, **AI-3D-scanned** (Rodin), then retopologized in Blender + `gltf-transform` down to ~0.5 MB PBR `.glb` files — real yarn fibers, real stitches, lit in real time with image-based lighting and ACES tone mapping in **three.js**.
- **The encouragement lives on the card in his hands** — a live canvas texture painted onto the doll's own held card, not an overlay. The card is the soul of the potato.
- **His eyes and head follow your cursor** across the whole screen (eyes lead, head trails); left alone, he blinks and glances around on his own.
- **Grab him and fling him** anywhere — a horizontal throw sets him spinning, and he settles back with an underdamped spring.
- **He's part-rigged** — independent claws, eyes, and card, driven by an eased-keyframe motion system, so he can wave, present, roll his eyes, and flip his card.
- **He stays out of your way** — a transparent, always-on-top, click-through window docked in the corner. Clicks pass straight through to whatever's behind him.

---

## 🚀 Run it

```bash
cd app
npm install
npm start
```

A little potato appears in the bottom-right corner, and a matching one lands in your menu bar (**Show / Hide**, **Quit**).

---

## 🔑 Claude API (optional)

Chat and Golden Stitch use Claude. Pick any one — none of these ever enter the repo:

```jsonc
// ~/.config/spuddy/config.json
{ "apiKey": "sk-ant-..." }
```

…or set `ANTHROPIC_API_KEY`, or sign in with the `ant` CLI. **With no key at all, he falls back to built-in lines** — everything still works, he just can't answer you in the moment.

> For real deployments there's an optional **Cloudflare Worker gateway** (`server/`) that keeps the API key server-side, geo-routes to a provider, meters a per-device daily budget, and pre-generates each day's card pools on a cron — so a shared key can safely carry a lot of little potatoes.

---

## 🧶 Under the hood

```
app/
├─ electron/main.cjs   transparent always-on-top window · tray · global cursor
│                      polling · Claude calls (the key never leaves main)
└─ src/
   ├─ scene.js         three.js scene — part hinges, PBR + IBL lighting, shadow
   ├─ motions.js       eased-keyframe motion system (part tracks, idle life, fling)
   ├─ brain.js         the personality engine — needs, moods, autonomous behavior
   ├─ cardscreen.js    the live text painted onto the card in his hands
   ├─ content.js       every line, persona, and unlock rule
   └─ ui.js · store.js · sfx.js · remote.js
server/                optional Cloudflare Worker gateway (key vault · budget · cron)
```

The 3D pipeline (real doll → scan → Blender + `gltf-transform` → Draco/WEBP `.glb`) and per-character card-plane calibration are documented in [`app/README.md`](app/README.md).

---

<div align="center">
<br />
<img src="docs/media/char-spud.png" height="72" alt="" />
<br /><br />
<sub><i>“Rest is productive. Signed, a potato.”</i></sub>
<br /><br />
<sub>Made with yarn, three.js, and a lot of encouragement.</sub>
</div>
