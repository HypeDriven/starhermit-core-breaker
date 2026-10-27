# Core Breaker — Running Game Design Document

**Status:** running spec. Describes the shipped game as it behaves today (present tense). Anything not yet in the code is listed only under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch.** A crystal striker hangs over a rotating reactor shaft. Hold to smash down through glowing crystal, release before the dark armored plates rotate under you, and ride an unbroken streak to the golden core at the bottom.

| | |
|---|---|
| Genre | One-button timing action (hold/release), score attack |
| Players | 1, offline-capable; scores compared on device-local boards (plus the platform board when signed in) |
| Session | A round lasts 5–60 s (3-layer lessons to the 40-layer Long Core); a typical sitting is 5–15 min of retries and next-stage chaining |
| Platforms | The StarHermit engine 1.19.1 (host API 1.21): natively in the StarHermit client and in browsers through the engine's web runtime; keyboard, mouse, touch and gamepad |
| Rendering | `starhermit:scene` (three.js-like) for the shaft; every menu, the HUD and the dialogs on `starhermit:ui` (immediate mode, styled from the converted CSS) |
| Simulation | Pure deterministic rules engine, fixed 60 Hz tick (the runtime's fixed steps), integer fixed-point; replays hash-verifiable (`server.js`) |

**File map**

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.19.1`, `engine.minor=18`, capabilities `platform,storage,clipboard`, `control.*` keys, `engine.group.*`, `engine.gamepad.*` |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry: the screen/overlay state machine, the round lifecycle on fixed steps (countdown, ticks, the 900 ms settle), hold/release/undo commands with their replay log, lesson goals, results, progression, achievements, the Score Chase device board, input routing, lifecycle |
| `native/screens.ts` | Every screen, overlay, the HUD, hint pill, captions, toast and the action tray on `starhermit:ui`; layouts by window size; drawn glyphs (★, lock, ♪, ∞); the key art and results art |
| `native/render.ts` | The shaft on `starhermit:scene`: segment window pool, striker, charge pips, core, beam, wall, motes, shard bursts, camera fit/drift/shake, per-level look |
| `native/quality.ts` | The browser build's presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Sample cues on the runtime's buses, the rendered hum and pulse-music clips, caption keys |
| `native/platform.ts` | The save (the wrapped progress document) with conflict merge and foreign-save migration, the localStorage shim, game options in `settings`, legacy settings import, player, invite link, platform clock, the high-score board and posting through `score-script.js` |
| `native/classic.ts`, `native/i18n.ts`, `native/style.ts` | Loads the classic scripts with their types; the interface-language bridge and `T()`; registers `assets/ui-style.json`, the theme and the high-contrast tokens |
| `js/rng.js`, `js/rules.js`, `js/content.js` | Unchanged UMD: `CBRNG`, `CBRules`, `CBContent` (shared with `server.js` and the tests) |
| `js/session.js` | `CBSession` (UMD): the versioned, checksummed progress document over `localStorage`, with pure `wrap` / `unwrap` / `mergeDocs` / `gameSettingsFrom` |
| `js/i18n.js`, `js/strings.js` | `CBI18N` (`T`, `setLocale`, locale fallbacks) and the nine-locale tables keyed by English source strings |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`) |
| `assets/*.webp` | Key art (title), results art (win / loss) |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished Score Chase total and posts it to the `high-score` board |
| `server.js` | Local dev server plus the legacy `/api/v1` replay-validating routes used by the tests (not in the package) |
| `sfx/` | 16 Opus clips, `manifest.txt` (canonical binding list), `manifest.json`, `manifest.md` |
| `tests/` | `run_tests.js` (rules/content/server), `session.test.mjs`, `i18n.test.mjs`, `native.mjs` + `native/*.play` |
| `tools/` | `package-web.mjs`, `css.mjs` + `ui-style.css`, `plan.mjs` (rules bot), `gen-plays.mjs`, `browser-play.mjs` |
| `cover.jpg`, `coverart.png`, `icon.png` | Store cover, cover source, icon |
| `LICENSE.md` | PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

1. **One finger, two verbs.** The whole game is hold and release. Rules in: anything that makes holding longer or releasing earlier a meaningful choice (momentum, charge, hover decay). Rules out: aiming, steering, second buttons, multi-touch, combos that need more than timing.
2. **Momentum is a promise you keep.** The score comes from unbroken streaks (×1…×8) and releasing resets them to zero. Rules in: gaps that preserve the streak, overdrive that lets a full charge blast through armor without releasing. Rules out: soft penalties for releasing; the streak reset is total and visible.
3. **Hovering costs depth.** Releasing is never free: the striker climbs back while hovering (`recover` in `rules.js simulate`). Rules in: timing pressure without a health bar. Rules out: hovering as a safe idle; timers as the only pressure.
4. **The shaft is the hero.** The camera frames the rotating ring of segments; every state change (break, pass, overdrive, crash, core) happens on that ring with a burst and a sound. Rules in: readable segment colours that survive high contrast, particles that never hide the next layer. Rules out: UI chrome competing with the ring, post-processing that the design depends on.
5. **Every run is a proof.** Seeds, integer physics and an ordered command log make every round replayable; a verifier (`server.js`) accepts a score only if it can reproduce the final hash. Rules in: daily seeds shared by everyone, practice seeds that are random and therefore unranked. Rules out: client-trusted scores, hidden modifiers.

## 3. Player experience

**Target player.** Someone who likes short, tense, retry-heavy arcade rounds on a phone or between tasks on desktop; no genre knowledge assumed.

**First 60 seconds.** Title → **Play**. For a brand-new pilot (`totals.rounds === 0` and lesson `t1` not done) Play opens Learn lesson 1 instead of Journey (`native/main.ts openPlay`). The intro dialog states the lesson in one paragraph and the exact meta ("3 layers · 4 sectors · no charge cell · no undo · no hints · unranked"). Start → 3-2-1 countdown in the hint pill with beeps → the hint pill reads "safe crystal · 1.1s" → the player holds and shatters three layers → "Core Reached!" with a component breakdown. Each later lesson adds one rule (armor, gaps, charge/overdrive, undo) and only completes when the player performs the action (`goal.event` in `content.js tutorialLessons`). Journey stage intros repeat the one-line teaching for a new mechanic (j03 armor, j04 gaps, j05 charge, j14 small cell, j15 timer).

**Session shape.** Chain of 10–40 s rounds: intro → countdown → dive → results → Retry / Next Stage. Journey unlocks strictly in order; Daily is one seed per UTC day; Score Chase is an endless run to the first crash.

**Emotional beat.** The held breath between "ARMOR — release!" and the safe segment rotating back under the striker, then the relief-turned-greed of holding straight through it at ×7.

## 4. Core loop and rules contract (`js/rules.js`)

**Entities.** A shaft is `cfg.layers` rings of `cfg.sectors` segments. Segment kinds (`SEG`): `SAFE=0` (breakable crystal), `ARMOR=1` (fatal unless charge is full), `GAP=2` (fall through). The striker sits at fixed angle 0; the shaft rotates by `cfg.rotSpeed` angle units per tick (1 sector = 1000 units). Descent within a layer is `fall` in 0…999 (1 layer = 1000 units).

**Commands.** `{type, atTick?, id?}` with `type ∈ press | release | wait | resign | undo`. `wait` advances time and is never logged. `atTick` must be ≥ current tick and at most 36 000 ticks (10 min) ahead. Invalid reasons: `game-ended`, `already-holding`, `not-holding`, `stale-tick`, `tick-too-far`, `unknown-command`, `malformed-command`.

**Tick (`simulate`).** 60 Hz; `elapsedMs = floor(tick·50/3)`. Each tick: rotate; if holding, `fall += fallSpeed + mult·2` (`fallSpeedOf`) and every 1000 units `land()`; if not holding and `fall > 0`, `fall -= max(1, fallSpeed >> 1)` (hover decay). If `cfg.timeLimitSec` is set and `tick ≥ limit·60`, terminal `time-up`.

**Landing (`land`).** Segment under the striker is `layers[depth][floor(angle/1000) % sectors]`.
- GAP: `passes++`, `+10` (`PASS_PT`), depth++, streak untouched.
- ARMOR with `charge ≥ chargeMax > 0`: charge → 0, `overdrives++`, `+250` (`OVERDRIVE_PT`), depth++, streak untouched.
- ARMOR otherwise: terminal `armor-impact`, lost.
- SAFE: `mult = min(8, mult+1)`, `+25·mult` (`BREAK_BASE`), `charge = min(chargeMax, charge+1)`, depth++.
Every generated layer contains at least one non-armor segment (`generateLayer`), so no layer is a soft lock.

**Release.** `mult = 0`, and in modes with `mechanics.undo` a snapshot (`undoSnap`) of tick/angle/depth/fall/mult/charge/score/stats/rng is banked.

**Undo.** Legal only when `undoSnap` exists; restores that snapshot, sets `holding=false`, clears the snapshot (one rewind per release). Undo is logged and replayed like any command.

**Terminal states (`TERMINAL`).** `core-reached` (won; `depth ≥ layers` in non-endless), `armor-impact`, `time-up`, `resigned`. Endless configs never win; `ensureLayers` keeps 8 layers generated ahead and armor probability ramps `armorPct + depth·0.004`, capped at 0.55.

**Score (`finalizeScore`).** `total = breakPoints + passPoints + overdrivePoints + timeBonus + multBonus + chargeBonus`; the three bonuses are awarded only on a win: `timeBonus = floor((par.timeSec·1000 − elapsedMs)/1000)·5` if positive, `multBonus = bestMult·20`, `chargeBonus = charge·15`. Mid-round the HUD shows only the first three components (`native/main.ts liveScore`).

**Worked example (Journey j01 "First Descent": 6 layers, all safe, fallSpeed 30, no charge cell, par 16 s, hold from tick 0).** Layers land after 34, 31, 30, 27, 27 and 25 ticks (speed 30→40 as momentum climbs) = 174 ticks = 2 900 ms. Breaks: 25·(1+2+3+4+5+6) = **525**. Time bonus: floor(13.1)·5 = **65**. Momentum bonus: 6·20 = **120**. Charge bonus 0. **Total 710**, par beaten (2 stars). This is exactly what `tests/native/journey-stage.play` expects (the planned dive holds from tick 1).

**Tie-breaks.** Server boards sort by score desc, then lower `durationMs`, then earlier submission (`server.js submitScore`). Local Score Chase board: score desc, then earlier time.

**RNG.** Master seed → `RNG.derive(seed, STREAM_RULES)` for layer generation; the rules stream's state is carried in `state.rngState`. Decoration/AV streams exist in `rng.js` but the renderer uses a fixed `RNG.create(12345)` for particle scatter. Daily seed = FNV-1a of `corebreaker-daily-v1-YYYY-MM-DD`. Practice and Score Chase seeds are `Math.random()` per run.

**Hints.** `peek` predicts the sector under the striker at the next landing assuming the current input; `hint` classifies it (`armor-ahead`, `armor-ahead-wait`, `overdrive-ready`, `gap-ahead`, `safe-ahead`). Hints and play share this surface; nothing else predicts.

**Determinism.** `hashState` = FNV-1a of a key-sorted JSON of the state minus `events`. Same version + seed + commands → identical hash (property test in `tests/run_tests.js`).

## 5. Modes and progression (`js/content.js`, `native/main.ts`)

| Mode | Entry | Content | Undo / hints | Ranking |
|---|---|---|---|---|
| Learn | Title **Learn**; also **Play** for new pilots | 5 forced-layout lessons `t1–t5`, each with an event goal; next unfinished lesson opens first | per lesson | unranked, never submitted |
| Journey | **Journey** grid or **Play** (first unfinished stage) | 40 authored stages `j01–j40`, 6→32 layers, 6→10 sectors, armor 0→40 %, rotSpeed 0→17, fallSpeed 30→62; mastery stages j10/j20/j30/j40 (gold border); timers on j15, j20, j25, j30, j35, j40 | on / on | local best per board `journey`; submitted to server board `journey` |
| Daily | **Daily Challenge** | `dailyConfig(date)`: layers 12–18, sectors 7–9, armor 18–30 %, 7-day rotation of parameters, timer only on `rot === 6`; countdown to next UTC day uses server offset when signed in | off / on | local `dailies[date]` |
| Practice | **Practice** | Calm / Standard / Intense presets, random seed, theme picker | on / on | local best only (`practice-<id>`); never submitted |
| Challenges | **Challenges** | c1 Blitz Shaft (42 s), c2 Plated Descent (46 % armor), c3 Raw Crystal (no charge cell), c4 Narrow Bands (5 sectors, rot 18), c5 The Long Core (40 layers, undo on), c6 Glass Gauntlet (no assists) | per challenge | local best |
| Score Chase | **Score Chase** | `SCORE_CHASE` endless ruleset, armor ramps with depth | off / off | local top-25 board (`corebreaker.scoreboard.v1`); signed in, also the platform `high-score` board |

**Stars and unlocks.** Winning a journey stage gives 1 star, beating `par.timeSec` gives 2 (`Session.recordJourney`). Stage N+1 unlocks when stage N has ≥ 1 star. Total stars unlock themes: Abyssal Violet 0, Glacial Deep 10, Ember Reactor 25, Verdant Core 45, Solar Forge 70. Themes are cosmetic (palette only) and apply to Practice via the theme picker; journey/challenge/daily stages carry their own theme.

**Achievements (local, idempotent).** `first-break`, `first-core`, `mult-8`, `overdrive`, `journey-half` (20 stages), `journey-done` (40), `daily-7`, `breaks-500` (lifetime), `score-3000`. Checked in `checkAchievements` after every results screen; unlock shows a toast, a screen-reader announcement and the achievement cue.

## 6. Controls and interaction

Actions are declared in `starhermit.txt` (players rebind keys and pads in the runtime's Options › Controls; How to Play lists the current bindings via `bindings()`):

| Action | Keyboard | Gamepad | Effect |
|---|---|---|---|
| `dive` | Space (hold) | South (A), Right trigger (hold) | press on press, release on release |
| `toggle` | Enter | West (X) | flips dive / hover |
| `pause` | P | Start | pause / resume a round |
| `undo` | U | North (Y) | undo when legal, else "Nothing to undo." |
| `retry` | R | Select | retry from the results |
| `back` | Escape | East (B) | closes Settings / How to Play / the intro, resumes from pause, pauses a round, backs out of a menu screen |

**Pointer and touch.** A press of the primary button (or the first finger, which the runtime moves and presses the pointer with) anywhere on the shaft that is not a widget dives; lifting it releases. Presses are queued and decided after the frame's UI is built, so `ui.pointerOver()` knows this frame's widgets. **HOLD TO DIVE** (≥ 160 × 56 px, 130 px wide on compact windows) is a `ui.widget` button that holds while it is pressed. A second finger neither starts nor ends a dive.

**Hold ownership.** The dive is held by a set of sources (the key, the pad, the pointer, the button): the press is sent when the first source holds and the release when the last lets go, so two inputs never double-commit or cut each other's dive. Undo and the end of a round clear the set.

**Toggle mode.** Settings → "Toggle instead of hold" turns every dive input into tap-to-toggle; the tray button relabels to **TAP TO DIVE**.

**Input locking.** Presses are ignored while paused, during the countdown, while any overlay is open, or after a terminal state; releases are honoured even with an overlay open so a hold never sticks. Every press/release carries a monotonically increasing id `c<n>` and the rules reject no-op transitions. A key that opened a screen does not also close it (same-frame guard); dive keys clear UI focus so Space/Enter never activate a menu button during play.

**Feedback per input.** Press: striker emissive brightens, the hold button gains its held glow, the dive cue, caption "dive start". Release: striker dims, hover cue, caption "hover", momentum resets to ×0. Undo: rewind cue, announcement "Rewound to your last release." Menu buttons: the UI tick.

## 7. Screens and UI flow (`native/main.ts`, `native/screens.ts`)

**State machine.** `title → (journey | practice | challenge | daily | score screen) → intro overlay → countdown → active ↔ pause overlay → resolving (54 fixed steps) → results overlay → (retry | next | exit to title)`. Screens are a stack with Back buttons; overlays stack too (Settings and How to Play over Pause return to it). A screen or overlay focuses its first or primary control two frames after it opens. Hiding the window (`onSuspend`) pauses an active round (not its countdown), stops the hum and flushes the save.

**Screens.** Title (over the key art: logo, tagline, six mode buttons, Learn / Settings / How to Play, Sign in with StarHermit for guests or Invite a friend when signed in, progress line, account line). Journey (auto-fill grid of 40 stage buttons, 64 px minimum, drawn stars / lock / dot, gold border for mastery, locked stages disabled). Practice (preset list with best, theme select). Challenges (list with intro and best). Daily (date, parameters, status, countdown to the next UTC day, Dive button). Score Chase (description, best, the platform board when signed in, the device top-10, Start).

**Overlays.** Intro (name, text, meta, Start / Cancel), Pause (Resume, Restart, Settings, How to Play, Leave Round), Results (headline, outcome art, reason / time / par, breakdown, progress with drawn stars, leaderboard line, replay hash, Retry / Next Stage / Exit to Title), Settings (the game's options and a link to the runtime's Options), How to Play (six rule cards, controls from the current bindings).

**Play layout.** HUD across the top over a dark band (Score, Best, Depth — `n/∞` drawn for endless — Time when a timer exists, red under 10 s, Momentum, Charge pips), Undo and Pause at the top end (under the stats when the row has no room), the objective line below. Hint pill centred above the tray (it shows the 3-2-1 countdown numerals). Caption line between them. Action tray at the bottom: **HOLD TO DIVE** and Undo, reversed for the left-handed tray. The shaft fills the window underneath.

**Responsive rules.** Layouts by the window's logical size (after the runtime's interface scale): cards max 640 px (720 px at ≥ 1024 px wide); ≤ 700 px wide: HUD values 16 px, compact card padding, hold button 130 px; landscape ≤ 640 px tall: the title's six mode buttons three across with a smaller logo; ≤ 500 px tall: the tray at the end, the hint pill lower, the results without art and their buttons in a row. Cards scroll inside when taller than the room (overlays 86 % of the height), their buttons pinned below; everything sits inside the safe area. The interface size and text size from the runtime's Options scale everything.

## 8. Art direction

**Hero.** The rotating ring of segments at the striker's height, lit by a theme-tinted key light, a hemisphere fill, an accent rim light from behind, a point light at the striker's centre (brighter while holding) and a warm point light over the golden core; camera at (0, 4.6, 9.2) looking at (0, −1.2, 0), drifting down up to 1.2 units with depth. The core, and a faint energy beam rising from it to just under the striker, travel with the shaft.

**Graphics.** ACES filmic tone mapping. Effects per graphics level: key-light shadows (the directional light's shadow distance covers the rendered window); image-based lighting from `new RoomEnvironment(renderer)` through `PMREMGenerator.fromScene` as `scene.environment` with the browser build's per-material `envMapIntensity` (crystal 0.55, armour 1.1, striker 0.3); detailed surfaces (bevelled `RoundedBoxGeometry` segments; crystal is a clear-coated `MeshPhysicalMaterial` with a procedural facet-noise map and glowing fracture veins as its emissive map; armour is brushed clear-coated metal with panel seams, rivets and a glowing warning-chevron band; plain surfaces are boxes, armour flat-shaded); `renderer.ao` (GTAO contact darkening); `renderer.bloom` (strength 0.38, radius 0.35, threshold 0.9: striker, core, charged pips, shard bursts, veins, chevrons); `renderer.grade` in display space (contrast 0.11, saturation 1.12, cool shadows / warm highlights, vignette 0.28); `renderer.antialias` (FXAA, SMAA or MSAA); shard bursts (additive octahedra, HDR-bright); an animated surround (a gridded cylindrical wall scrolling with descent, rising motes, a pulsing core and beam). The runtime's Options own the level (Auto from the device), render scale, adaptive resolution, the frame-rate limit and readout; the game maps `frame().quality` to the browser build's four presets and scales the mote and shard counts by `frame().levelIndex` within the tier (≤ 4×). Light intensities are three.js's divided by π. Canvas textures are drawn with `starhermit:canvas` (the veins' glow is a wider faint stroke under the bright one, as the canvas has no `shadowBlur`).

| Tier → preset | Shadows | AO | Bloom | Grade | AA | Reflections | Surfaces | Burst share | Surround |
|---|---|---|---|---|---|---|---|---|---|
| low | off | off | off | off | MSAA | off | plain | ⅓ | static |
| balanced | 1024 | off | on | on | FXAA | on | detailed | ⅔ | animated |
| high | 2048 | on | on | on | SMAA | on | detailed | all | animated |
| ultra | 4096 | high | on | on | MSAA | on | detailed | all | animated |

**Per-preset budgets** (`native/quality.ts`, the browser build's `BUDGETS`). A level change rebuilds the segment materials, textures, bevels and the wall in place.

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Segment materials | Lambert | Standard | Physical (clear-coat crystal and armour) | Physical |
| Crystal / armour textures (detailed) | 128×64 | 256×128 | 256×128 | 512×256 |
| Rounded-segment bevel segments (detailed) | 2 | 2 | 3 | 4 |
| Shaft-wall radial segments | 24 | 32 | 48 | 64 |
| Rising motes at the tier's first level (≤ 600) | 60 | 100 | 160 | 240 |
| Shard pool at the tier's first level (≤ 400, created as needed) | 60 | 100 | 140 | 200 |
| Bloom / GTAO resolution | ½ / ½ | ½ / ½ | ½ / ½ | full / full |

**UI palette (`tools/ui-style.css` → `assets/ui-style.json`).** Background `#0b0918`; panel `rgba(20,17,38,.92)` with border `#4a3f8f`; text `#f2eefc`; dim `#b8b0d8`; accent `#9be8ff` (title, focus ring, hint text); gold `#ffd166` (charge pips, toast, stars); danger `#ff6b7a`; buttons `#241f45` → hover `#322a5e`; primary `#2d6a8f` → hover `#3a86b0`. With the runtime's high contrast on, `native/style.ts` swaps the tokens to black panels, white borders/text, `#00e5ff`, `#ffe600`, `#ff4757`, and the scene uses each theme's saturated `safeHC` / `armorHC`.

**Scene themes (`content.js THEMES`).** Each theme defines `bg/fog`, `shaft`, `shaftEdge`, `safe`, `safeHC`, `armor`, `armorHC`, `core`, `light`, `accent`, `striker`:
- Abyssal Violet: bg `#141126`, safe `#63d0e8`, armor `#9c4a5a`, core `#ffd166`, light `#b0a8ff`
- Glacial Deep: bg `#0e1c26`, safe `#7fe0d4`, armor `#b0643c`, core `#ffe08a`
- Ember Reactor: bg `#221016`, safe `#ffb066`, armor `#5a6a7a`, core `#ffe066`
- Verdant Core: bg `#101f16`, safe `#9fe080`, armor `#8a5a6e`, core `#fff3a0`
- Solar Forge: bg `#241c10`, safe `#ffd98a`, armor `#6a5a8a`, core `#ffffff`
High-contrast variants (`safeHC`/`armorHC`) are saturated Open-Color hues so safe vs armor never relies on brightness alone; armor is additionally flat-shaded and more metallic (`makeSegMesh`).

**Shape language.** Chunky 2.6×0.5×1.1 segments (bevelled when detailed), a 0.62-radius flat-shaded icosahedron striker with emissive glow, a golden cylinder core under the last layer, small octahedral charge pips orbiting above the striker (glowing when charged). Segments already broken are hidden rather than animated away.

**Typography.** The engine's system sans. Title 60 px (46 px under 700 px wide, 34 px on phones and short landscape) with 0.06 em tracking and a cyan glow; HUD labels 11 px uppercase, values 16–24 px. Symbols the system fonts may lack (★, the lock, ♪, ∞) are drawn as glyphs.

**Motion.** Shaft rotation and descent come straight from the rules snapshot; striker spin and emissive follow with a damped lerp (the striker idles slowly behind menus); spinning shard bursts (pool per preset budget, count scaled by the Particles tier) on break/overdrive/crash/win; tiered camera shake 0.06–0.22; with an animated surround, motes rise and the core and beam pulse. With the runtime's reduced motion: no striker spin, no camera drift, no shake, no mote/pulse animation; particles still play.

**Visual assets the design calls for.** Title backdrop key art (shipped), results illustration for win and loss (shipped), store cover (shipped), icon and favicon (shipped). The striker and segments stay procedural on purpose; no GLTF model is used.

## 9. Audio direction (`native/audio.ts`)

**Mix.** The runtime's buses (Options › Audio owns volumes, mute and the voice limit): music → `music`, effects and the hum → `effects`, the menu tick and countdown beeps → `interface`; the browser build's default bus levels (music 40 %, effects 80 %, ambience 35 %) are folded into each sound's gain. The reactor hum (54 Hz sine + 108.5 Hz triangle, gain 0.05) is rendered once into a seamless 2 s loop clip and plays under a round, stopped while the window is hidden. The music is a 300 ms pentatonic pulse on a triangle that switches to sawtooth above ×4 momentum, with a sub-bass pulse every other step from ×3; its notes are rendered into clips with the old envelopes and stepped by mixer time; it starts with each round and stops at results / quit. Clips load once the mixer runs (natively at once, in a browser after the first press), one at a time; the old procedural stand-ins while a clip decoded are not ported (a live synthesis graph disturbs clip loading on the web runtime), so a missing clip is silent. Captions (`♪` drawn) show meaningful cues for 1.4 s when "Sound captions" is on.

**SFX event table** (this table is the source of `sfx/manifest.txt`)

| Event id | File | Sound | Usage |
|---|---|---|---|
| `sfxPress` | `sfx/dive-start.opus` | Short punchy pneumatic whoosh, downward sweep | every press |
| `sfxRelease` | `sfx/hover-release.opus` | Soft airy brake hiss with rising flutter | every release |
| `sfxBreak` | `sfx/crystal-break.opus` | Sharp glassy shatter with fragment tinkle | each `break` event |
| `sfxPass` | `sfx/gap-pass.opus` | Fast clean whoosh with light whistle | each `pass` event |
| `sfxOverdrive` | `sfx/overdrive-surge.opus` | Armor plate punched through, electric surge | `overdrive` event |
| `sfxCharge` | `sfx/charge-pip.opus` | Tiny mechanical click-blip | the break that fills the charge cell |
| `sfxCrash` | `sfx/armor-crash.opus` | Metal-on-metal collision, rumble decay | `crash` event |
| `sfxWin` | `sfx/core-reached.opus` | Three rising crystalline bells | `win` event |
| `sfxLose` | `sfx/run-ended.opus` | Mournful power-down | `lose` for time-up / resign |
| `sfxUi` | `sfx/ui-tick.opus` | Dry plastic UI tick | every menu button |
| `sfxAchievement` | `sfx/achievement-unlock.opus` | Two-note badge jingle | first unlock of an achievement |
| `sfxCountdown` | `sfx/countdown-beep.opus` | Single console beep | each 3-2-1 step |
| `sfxUndo` | `sfx/undo-rewind.opus` | Reversed whoosh, tape flutter, snap | accepted undo |
| `sfxLesson` | `sfx/lesson-complete.opus` | Warm glassy confirmation chime | Learn goal met |
| `sfxTimerWarn` | `sfx/timer-warning.opus` | Two muffled klaxon pulses | once when a timer drops under 10 s |
| `sfxNewBest` | `sfx/new-best.opus` | Ascending three-note crystal arpeggio | results with a new personal best |

## 10. Localization

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings.** English source strings are the keys; `js/strings.js` holds the tables (es-419, de-DE, fr-FR, pt-BR, it-IT in full; en-GB derived with British spelling — armour, colour; es-ES and fr-CA list only their differences, e.g. fr-CA *pointage*). Every client string is built through `T()` each frame (title, lists, HUD, hint pill, hold button, announcements, toasts, results, help, settings, captions, the account and leaderboard lines). Content stays English and is translated at display time (stage names and intros, challenges, presets, the endless shaft, lessons, themes, achievements). "Core Breaker" and "StarHermit" stay as they are; scores keep `toLocaleString('en-US')` digits; the device board's dates follow the locale (UTC).
- **Language.** The runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the account's preferred language, else the device's) mapped to the nearest shipped locale (es-MX → es-419, en-AU → en-GB, fr → fr-FR); a change applies on the next frame without touching a round. The runtime's Options replaced the game's own language selector.
- **Expansion.** Labels too wide wrap into paragraphs; the hold button wraps to two lines when needed; button rows wrap.

## 11. Accessibility

- **Keyboard and gamepad.** Every screen and overlay is reachable by Tab / arrows / D-pad and Enter / South; Space or A holds, Enter or X toggles, P / Start pause, Escape / B back, U / Y undo, R / Select retry. The first or primary control is focused when a screen opens.
- **Screen readers.** Widgets carry their labels (journey stages: "Stage n: name (locked), n stars"; the charge pips: "Charge n of max"); `ui.announce` speaks hints of state: get ready / dive, pause / resume, undo, overdrive, crash, core, results totals, lesson completion, achievements.
- **Captions.** Every meaningful cue shows a caption for 1.4 s when Sound captions is on (default on).
- **Contrast and colour.** The runtime's high contrast swaps the UI tokens and the scene's safe / armour hues; the hint pill names the segment kind in words ("SAFE (bright)", "ARMOR — release!") so colour is never the only channel.
- **Reduced motion, text and interface size** come from the runtime's Options; timings are unchanged.
- **Game options** (Settings): Sound captions, Left-handed tray, Toggle instead of hold, Timing assist (shows the hint 100 ms earlier; rules unchanged), Practice theme; "Open Options" opens the runtime's Options (sound, graphics, language, controls, text size, high contrast, reduced motion).
- **Targets.** Buttons ≥ 44 × 44 px; the hold button ≥ 130 × 56 px.

## 12. StarHermit integration (`native/platform.ts`)

| Platform feature | Status |
|---|---|
| Engine package | `starhermit.txt` engine lines; `npm run package` writes the web loader and file index; the StarHermit client plays it natively |
| Save | The checksummed progress document `{v, data, sum}` is the game's save (`saves.save`, schema 1): on the device at once and in the player's cloud slot (debounced by the runtime). js/session.js reads and writes it through a `localStorage` shim (`corebreaker.progress.v1`); the Score Chase board (`corebreaker.scoreboard.v1`) stays on the device's storage |
| Conflicts | `saves.onConflict` merges both copies with `CBSession.mergeDocs` (higher stars and best per stage, higher best per board, every daily with the better score, every lesson and achievement at its earliest unlock, the larger totals; this device's settings and last replay); a newer account copy found later is merged in the same way |
| Migration from the browser build | Its cloud slot (the JS SDK's zipped `save.json`, the same wrapped document under `game:<slug>`) shows as foreign: it is merged in, its game options adopted unless set since, and saved over with `replaceForeign`. The account's old per-player settings keys are read through `settings.legacyKeys()`; the game options among them are kept, then all of the old keys (volumes, graphics, `ui.language`, …) removed. Guests' old browser localStorage progress cannot migrate |
| Game options | `settings` (synced with the account): `captions`, `leftHanded`, `holdToggle`, `timingAssist`, `theme` |
| Player | `player()`: the title's account line "Playing as <name> · progress synced / saving… / cloud sync unavailable", or the offline line for guests; guests get "Sign in with StarHermit" (`requestSignIn`) |
| Invite link | Signed in: "Invite a friend" copies `inviteLink()` to the clipboard with a toast (shows the link when copying fails) |
| Clock | The daily's date and countdown follow `serverNow()` once `serverTime()` answered ("(server time)"), else the device clock ("(local clock)") |
| Leaderboard | Signed in, every finished Score Chase dive posts its total through `score-script.js` (a practice session whose socket carries `{type:'result', scores:{'high-score': total}}`, answered by `result-ack`); the results show "Posting score to the leaderboard…", then "Leaderboard rank: #N" / "Score posted…" / "Score not posted…". The Score Chase screen shows the board's top 10 (names from profiles, the player's own "You (name)") above the device board. Other modes post nothing |
| Reports, crash capture, graphics, sound, language, controls | The runtime's own (Options, F1) |
| Achievements | Local only (part of the saved document) |

## 13. Technical architecture

- **Module boundaries.** `rules.js`, `content.js` and `rng.js` are unchanged UMD shared with the tests and `server.js`, loaded by `loadClassic` with `strings.js`, `i18n.js` and `session.js`. `native/main.ts` changes game state only through `Rules.applyCommand`; `render.ts` reads snapshots and never writes them.
- **Loop.** `setFixedRate(60)`; each fixed step of an active, unpaused round applies `{type:'wait', atTick: tick+1}`; the countdown (42 steps a numeral) and the settle (54 steps) count steps too, so play scripts replay exactly. Input commands are applied at the current tick, so the log is exact and replayable. `onRender` builds the UI, decides queued pointer presses, then draws the scene.
- **Replay envelope.** `{v:1, contentVersion, cfg, seed, log, hash, score, atMs}` saved as `lastReplay`; the results print hash, seed and command count.
- **Rendering budget.** Windowed mesh pool (3 layers above, 12 below; ≤ 150 segment meshes), a shard pool created up to the level's budget (≤ 400), one wall, beam and mote cloud; light counts never change (the core light dims instead).

## 14. Testing and acceptance criteria

`npm test` = `test:unit` + `test:native`:

- `tests/run_tests.js` (29 tests): config validation, holds, momentum, bonuses, armour, overdrive, gaps, release decay, invalid reasons, timers, resign, undo, peek/hint, serialization, deterministic hashes, fuzz, endless ramp, all shipped configs passable, daily immutability, lessons, golden greedy wins for every stage, interrupted replays, server replay validation and ranking.
- `tests/session.test.mjs` (node --test): the wrapped document's round trip and defaults, corrupt / other-version documents, the two-device merge rules, the browser build's cloud save migrating with its options, old settings keys, imports.
- `tests/i18n.test.mjs`: every key `native/*.ts` and the content use is in every locale with intact placeholders and no unused rows; locale fallbacks.
- `tests/native.mjs`: the web index matches the files (`npm run package` ran last), `tsc` with the engine's `starhermit.d.ts`, `starhermit check .` with no warnings, and every `tests/native/*.play` as a guest `--render-check`: `learn-lessons.play` (Play opens lesson 1; all five lessons dived by the rules bot's plans to their exact totals, Next Stage between them, the undo in lesson 5), `journey-stage.play` (stage 1 to 710 with par beaten, Retry, pause, Leave Round, two stars on the grid, stage 2's intro), `challenge-timer.play` (Blitz Shaft to its planned total under the timer), `screens.play` (How to Play, Settings, Daily, Practice started / paused / restarted / left, Challenges, a Score Chase dive to the armour and the device board). `tools/gen-plays.mjs` writes the planned scripts from `tools/plan.mjs` (a hold/release bot over the rules, checked for the same outcome with every command a tick early or late).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU (`~/games/tools/gpu-chrome.mjs`) at 1366 × 768, a 390 × 844 phone and an 844 × 390 phone landscape: it starts, Play opens lesson 1, Space (desktop) or the HOLD TO DIVE button (phones) dives it to the results, Pause and Escape work; no console errors or warnings.

**QA bar as checkable statements.** A new player sees instructions (lesson text, hint pill, stage intros) before needing them. Every feature is reachable by pointer, touch, keyboard and gamepad. No console errors or warnings. Text and controls are not cut off at 960 × 540, 1366 × 768, 390 × 844 and 844 × 390. The game stays playable offline and when audio or an image is unavailable.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/ui-style.json` | The UI styles (`tools/ui-style.css` through `starhermit css`) | generated | shipped |
| `assets/key-art.webp` (1280×720, 108 KB) | Title screen backdrop under a dark veil | FLUX.2 klein, seed 4601, 1536×864, 28 steps | generated in this pass |
| `assets/core-reached.webp` (1024×576, 46 KB) | Results illustration on a win | FLUX.2 klein, seed 4602 | generated in this pass |
| `assets/dive-over.webp` (1024×576, 34 KB) | Results illustration on a loss | FLUX.2 klein, seed 4603 | generated in this pass |
| `coverart.png` (1200×675, 424 KB) | Store cover | key art + ffmpeg drawtext title/tagline, 256-colour PNG | generated in this pass (replaced a generic placeholder) |
| `icon.png` | Icon | authored PNG | shipped |
| `sfx/*.opus` × 12 (dive-start … countdown-beep) | Core cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/undo-rewind.opus`, `lesson-complete.opus`, `timer-warning.opus`, `new-best.opus` | New cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | generated in this pass |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding list / generator input / table | authored | updated in this pass |
| 3D model / character animation | none | — | not called for: striker and segments are procedural; no humanoid |

## 16. Known limitations

- Own-server leaderboards are not used; the signed-in Score Chase posts to and shows the platform leaderboard.
- The HUD "Best" in Journey is the best across all stages, not the current stage.
- Achievements never leave the device.
- Hiding the window during the 3-2-1 countdown does not open the pause overlay.
- Particle bursts are not suppressed by reduced motion.
- The achievement or lesson toast can briefly overlap the results headline (2.6 s, non-blocking; a newer toast replaces an older one).
- The graphics panel's per-category overrides and render-scale slider are not offered: the runtime's Options choose a graphics level.
- Guests' progress kept in the old browser build's localStorage does not carry over (cloud saves do).

## Design intent not yet implemented

- Shared cross-player leaderboards (global and friends-filtered) on the Daily and Challenge screens, beyond the Score Chase board.
- Delivering achievements through the platform.
- Per-stage HUD best in Journey and per-date daily boards.
- Suppressing particle bursts under reduced motion.
