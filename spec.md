# Core Breaker — Running Game Design Document

**Status:** running spec. Describes the shipped game as it behaves today (present tense). Anything not yet in the code is listed only under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch.** A crystal striker hangs over a rotating reactor shaft. Hold to smash down through glowing crystal, release before the dark armored plates rotate under you, and ride an unbroken streak to the golden core at the bottom.

| | |
|---|---|
| Genre | One-button timing action (hold/release), score attack |
| Players | 1, offline-capable; asynchronous score comparison through the bundled server script |
| Session | A round lasts 5–60 s (3-layer lessons to the 40-layer Long Core); a typical sitting is 5–15 min of retries and next-stage chaining |
| Platforms | Desktop and mobile browsers with WebGL; keyboard, mouse and touch |
| Rendering | Three.js (ES module in `vendor/`) WebGL canvas for the shaft; all menus, HUD and dialogs are semantic HTML layered over it |
| Simulation | Pure deterministic rules engine, fixed 60 Hz tick, integer fixed-point; replays hash-verified server-side |

**File map**

| Path | Responsibility |
|---|---|
| `index.html` | DOM shell: canvas, live regions, HUD, action tray, six screens, five overlays, script tags |
| `css/style.css` | Palette tokens, layout, safe-area padding, HUD/tray, overlays, responsive and reduced-motion rules |
| `js/rng.js` | `CBRNG`: mulberry32 PRNG, FNV-1a `hashString`, three derived streams (rules / decor / av) |
| `js/rules.js` | `CBRules`: `createGame`, `applyCommand`, `peek`, `hint`, `legalActions`, scoring, hashing, serialization |
| `js/content.js` | `CBContent`: 5 themes, 40 journey stages, 6 challenges, 3 practice presets, endless ruleset, `dailyConfig`, 5 lessons, 9 achievements |
| `js/session.js` | `CBSession`: versioned, checksummed `localStorage` progress document and settings |
| `js/audio.js` | `CBAudio`: WebAudio buses, Opus one-shots with synth fallback, ambience hum, adaptive pulse music, captions |
| `js/render.js` | `CBRender`: Three.js scene, windowed segment mesh pool, striker, charge pips, particles, camera drift/shake |
| `js/main.js` | UI shell: screens, overlays, settings, input, play lifecycle, HUD, results, achievements, server calls |
| `server.js` | Static server plus authoritative `/api/v1` script: time, daily metadata, leaderboard, replay-validated score submit |
| `starhermit.txt` | Platform manifest (`name`, `launch`, `owner`, `server=server.js`, `version`, `contentVersion`, `cover`) |
| `sfx/` | 16 Opus clips, `manifest.txt` (canonical binding list), `manifest.json` (generator input), `manifest.md` |
| `assets/` | `key-art.webp` (title backdrop), `core-reached.webp` / `dive-over.webp` (results illustrations) |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), 256 px icon, SVG favicon |
| `tests/run_tests.js`, `tests/e2e.mjs` | `npm test` rules/content/server suite; Playwright playthrough at desktop and mobile viewports |
| `tests/browser_smoke.js` | Legacy CDP smoke script (not part of `npm test`) |
| `tools/` | Dev-only; `scores.json` is written here by the server at runtime |
| `vendor/three.module.min.js` | Three.js (MIT) |
| `LICENSE.md` | PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

1. **One finger, two verbs.** The whole game is hold and release. Rules in: anything that makes holding longer or releasing earlier a meaningful choice (momentum, charge, hover decay). Rules out: aiming, steering, second buttons, multi-touch, combos that need more than timing.
2. **Momentum is a promise you keep.** The score comes from unbroken streaks (×1…×8) and releasing resets them to zero. Rules in: gaps that preserve the streak, overdrive that lets a full charge blast through armor without releasing. Rules out: soft penalties for releasing; the streak reset is total and visible.
3. **Hovering costs depth.** Releasing is never free: the striker climbs back while hovering (`recover` in `rules.js simulate`). Rules in: timing pressure without a health bar. Rules out: hovering as a safe idle; timers as the only pressure.
4. **The shaft is the hero.** The camera frames the rotating ring of segments; every state change (break, pass, overdrive, crash, core) happens on that ring with a burst and a sound. Rules in: readable segment colours that survive high contrast, particles that never hide the next layer. Rules out: UI chrome competing with the ring, post-processing that the design depends on.
5. **Every run is a proof.** Seeds, integer physics and an ordered command log make every round replayable; the server accepts a score only if it can reproduce the final hash. Rules in: daily seeds shared by everyone, practice seeds that are random and therefore unranked. Rules out: client-trusted scores, hidden modifiers.

## 3. Player experience

**Target player.** Someone who likes short, tense, retry-heavy arcade rounds on a phone or between tasks on desktop; no genre knowledge assumed.

**First 60 seconds.** Title → **Play**. For a brand-new pilot (`totals.rounds === 0` and lesson `t1` not done) Play opens Learn lesson 1 instead of Journey (`main.js btn-play`). The intro dialog states the lesson in one paragraph and the exact meta ("3 layers · 4 sectors · no charge cell · no undo · no hints · unranked"). Start → 3-2-1 countdown in the hint pill with beeps → the hint pill reads "safe crystal · 1.1s" → the player holds and shatters three layers → "Core Reached!" with a component breakdown. Each later lesson adds one rule (armor, gaps, charge/overdrive, undo) and only completes when the player performs the action (`goal.event` in `content.js tutorialLessons`). Journey stage intros repeat the one-line teaching for a new mechanic (j03 armor, j04 gaps, j05 charge, j14 small cell, j15 timer).

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

**Score (`finalizeScore`).** `total = breakPoints + passPoints + overdrivePoints + timeBonus + multBonus + chargeBonus`; the three bonuses are awarded only on a win: `timeBonus = floor((par.timeSec·1000 − elapsedMs)/1000)·5` if positive, `multBonus = bestMult·20`, `chargeBonus = charge·15`. Mid-round the HUD shows only the first three components (`main.js liveScore`).

**Worked example (Journey j01 "First Descent": 6 layers, all safe, fallSpeed 30, no charge cell, par 16 s, hold from tick 0).** Layers land after 34, 31, 30, 27, 27 and 25 ticks (speed 30→40 as momentum climbs) = 174 ticks = 2 900 ms. Breaks: 25·(1+2+3+4+5+6) = **525**. Time bonus: floor(13.1)·5 = **65**. Momentum bonus: 6·20 = **120**. Charge bonus 0. **Total 710**, par beaten (2 stars). This is exactly what the e2e run reports.

**Tie-breaks.** Server boards sort by score desc, then lower `durationMs`, then earlier submission (`server.js submitScore`). Local Score Chase board: score desc, then earlier time.

**RNG.** Master seed → `RNG.derive(seed, STREAM_RULES)` for layer generation; the rules stream's state is carried in `state.rngState`. Decoration/AV streams exist in `rng.js` but the renderer uses a fixed `RNG.create(12345)` for particle scatter. Daily seed = FNV-1a of `corebreaker-daily-v1-YYYY-MM-DD`. Practice and Score Chase seeds are `Math.random()` per run.

**Hints.** `peek` predicts the sector under the striker at the next landing assuming the current input; `hint` classifies it (`armor-ahead`, `armor-ahead-wait`, `overdrive-ready`, `gap-ahead`, `safe-ahead`). Hints and play share this surface; nothing else predicts.

**Determinism.** `hashState` = FNV-1a of a key-sorted JSON of the state minus `events`. Same version + seed + commands → identical hash (property test in `tests/run_tests.js`).

## 5. Modes and progression (`js/content.js`, `js/main.js`)

| Mode | Entry | Content | Undo / hints | Ranking |
|---|---|---|---|---|
| Learn | Title **Learn**; also **Play** for new pilots | 5 forced-layout lessons `t1–t5`, each with an event goal; next unfinished lesson opens first | per lesson | unranked, never submitted |
| Journey | **Journey** grid or **Play** (first unfinished stage) | 40 authored stages `j01–j40`, 6→32 layers, 6→10 sectors, armor 0→40 %, rotSpeed 0→17, fallSpeed 30→62; mastery stages j10/j20/j30/j40 (gold border); timers on j15, j20, j25, j30, j35, j40 | on / on | local best per board `journey`; submitted to server board `journey` |
| Daily | **Daily Challenge** | `dailyConfig(date)`: layers 12–18, sectors 7–9, armor 18–30 %, 7-day rotation of parameters, timer only on `rot === 6`; countdown to next UTC day uses server offset when reachable | off / on | local `dailies[date]`, server board `daily` |
| Practice | **Practice** | Calm / Standard / Intense presets, random seed, theme picker | on / on | local best only (`practice-<id>`); never submitted |
| Challenges | **Challenges** | c1 Blitz Shaft (42 s), c2 Plated Descent (46 % armor), c3 Raw Crystal (no charge cell), c4 Narrow Bands (5 sectors, rot 18), c5 The Long Core (40 layers, undo on), c6 Glass Gauntlet (no assists) | per challenge | local best, server board `challenge-<id>` |
| Score Chase | **Score Chase** | `SCORE_CHASE` endless ruleset, armor ramps with depth | off / off | local top-25 board (`corebreaker.scoreboard.v1`), server board `score` |

**Stars and unlocks.** Winning a journey stage gives 1 star, beating `par.timeSec` gives 2 (`Session.recordJourney`). Stage N+1 unlocks when stage N has ≥ 1 star. Total stars unlock themes: Abyssal Violet 0, Glacial Deep 10, Ember Reactor 25, Verdant Core 45, Solar Forge 70. Themes are cosmetic (palette only) and apply to Practice via the theme picker; journey/challenge/daily stages carry their own theme.

**Achievements (local, idempotent).** `first-break`, `first-core`, `mult-8`, `overdrive`, `journey-half` (20 stages), `journey-done` (40), `daily-7`, `breaks-500` (lifetime), `score-3000`. Checked in `checkAchievements` after every results screen; unlock shows a toast, a live announcement and `sfxAchievement`.

## 6. Controls and interaction

| Input | Action | Where bound |
|---|---|---|
| Pointer down / up on the canvas or **HOLD TO DIVE** | press / release (pointer capture; `pointercancel` and `lostpointercapture` release) | `main.js bindHold` |
| Space (hold) | press on keydown, release on keyup; `e.repeat` ignored | `keydown` / `keyup` |
| Enter | toggles hold/hover | `keydown` |
| P, Escape | pause / resume (Escape also closes Settings/Help, backs out of screens) | `keydown` |
| U, **Undo** (HUD and tray) | undo when legal; otherwise announces "Nothing to undo." | `doUndo` |
| R | retry while results are open | `keydown` |
| Tab / Shift+Tab | standard focus order; first button of each screen/overlay is focused on open | `showScreen`, `openOverlay` |

**Toggle mode.** Settings → "Toggle instead of hold" turns pointer and Space into tap-to-toggle; the tray button relabels to **TAP TO DIVE**.

**Input locking.** Presses are ignored while `paused`, during the countdown, while any overlay is open, or after a terminal state; releases are honoured even with an overlay open so a hold never sticks. Every press/release carries a monotonically increasing id `c<n>` and the engine rejects no-op transitions, so double commits cannot happen.

**Feedback per input.** Press: striker emissive brightens, tray button gains `.held` glow, `sfxPress`, caption "dive start". Release: striker dims, `sfxRelease`, caption "hover", momentum resets to ×0 in the HUD. Undo: `sfxUndo`, announcement "Rewound to your last release." Menu buttons: `sfxUi`.

## 7. Screens and UI flow (`js/main.js`)

**State machine.** `title → (journey | practice | challenge | daily | score screen) → overlay-intro → countdown → active ↔ overlay-pause → resolving (900 ms settle) → overlay-results → (retry | next | exit-to-title)`. Screens are a stack (`screenStack`) with Back buttons; overlays restore focus to the element that opened them. Backgrounding the tab pauses an active round and stops ambience.

**Screens.** Title (logo, tagline, six mode buttons, Learn/Settings/How to Play, progress line, WebGL compatibility note). Journey (8-column auto-fill grid of 40 stage buttons with star glyphs, lock icon, gold border for mastery). Practice (preset list with best, theme select). Challenges (list with intro and best). Daily (date, parameters, status, countdown, Dive button). Score Chase (best, top-10 local board, Start button).

**Overlays.** Intro (name, text, meta, Start/Cancel), Pause (Resume, Restart, Settings, How to Play, Leave Round), Results (headline, illustration, reason/time/par, breakdown table, progress, replay hash, Retry / Next Stage / Exit), Settings, Help (six rule cards, control list generated from the current toggle setting).

**Play layout.** HUD across the top (Score, Best, Depth, Time when a timer exists, Momentum, Charge pips, Undo, Pause, objective line). Hint pill centred above the tray. Caption line above that. Action tray at the bottom with **HOLD TO DIVE** (≥160×56 px) and Undo; `body.left-handed` reverses the tray. The canvas fills the viewport underneath.

**Responsive rules.** Cards max 640 px (720 px at ≥1024 px). Under 700 px the HUD values shrink to 16 px and the hold button to 130 px min. Landscape phones (≤500 px tall) pull the hint pill down and right-align the tray. All fixed bars pad by `env(safe-area-inset-*)`. Overlay cards scroll internally (`max-height: 86vh`) so Results with its illustration and seven rows fits a 390×844 portrait phone; the toast is `pointer-events: none` so it never blocks the HUD pause button. Never cut off: the HOLD button, the hint pill, the results Retry button.

## 8. Art direction

**Hero.** The rotating ring of segments at the striker's height, lit by one warm key light and a violet hemisphere fill; camera at (0, 4.6, 9.2) looking at (0, −1.2, 0), drifting down up to 1.2 units with depth.

**DOM palette (`css/style.css`).** Background `#0b0918`; panel `rgba(20,17,38,.92)` with border `#4a3f8f`; text `#f2eefc`; dim `#b8b0d8`; accent `#9be8ff` (title, focus ring, hint text); gold `#ffd166` (charge pips, toast, stars); danger `#ff6b7a`; buttons `#241f45` → hover `#322a5e`; primary `#2d6a8f` → hover `#3a86b0`. High contrast swaps to black panels, white borders/text, `#00e5ff`, `#ffe600`, `#ff4757`.

**Scene themes (`content.js THEMES`).** Each theme defines `bg/fog`, `shaft`, `shaftEdge`, `safe`, `safeHC`, `armor`, `armorHC`, `core`, `light`, `accent`, `striker`:
- Abyssal Violet: bg `#141126`, safe `#63d0e8`, armor `#9c4a5a`, core `#ffd166`, light `#b0a8ff`
- Glacial Deep: bg `#0e1c26`, safe `#7fe0d4`, armor `#b0643c`, core `#ffe08a`
- Ember Reactor: bg `#221016`, safe `#ffb066`, armor `#5a6a7a`, core `#ffe066`
- Verdant Core: bg `#101f16`, safe `#9fe080`, armor `#8a5a6e`, core `#fff3a0`
- Solar Forge: bg `#241c10`, safe `#ffd98a`, armor `#6a5a8a`, core `#ffffff`
High-contrast variants (`safeHC`/`armorHC`) are saturated Open-Color hues so safe vs armor never relies on brightness alone; armor is additionally flat-shaded and more metallic (`makeSegMesh`).

**Shape language.** Chunky 2.6×0.5×1.1 boxes for segments, a 0.62-radius icosahedron striker with emissive glow, a golden cylinder core under the last layer, small spheres for charge pips orbiting above the striker. Segments already broken are hidden rather than animated away.

**Typography.** System sans (`Segoe UI`, system-ui, Arial). Title `clamp(34px, 7vw, 60px)` with 0.06 em tracking and a cyan glow; HUD labels 11 px uppercase, values 20–24 px tabular numerals.

**Motion.** Shaft rotation and descent come straight from the rules snapshot; striker spin and emissive follow with a damped lerp; particle bursts (pool of 140, count scaled by quality) on break/overdrive/crash/win; tiered camera shake 0.06–0.22. With reduced motion (setting or media query): no striker spin, no camera drift, no shake, no toast fade; particles still play.

**Visual assets the design calls for.** Title backdrop key art (shipped), results illustration for win and loss (shipped), store cover (shipped), icon and favicon (shipped). The striker and segments stay procedural on purpose; no GLTF model is used.

## 9. Audio direction (`js/audio.js`)

**Mix.** Three WebAudio buses (music 40 %, sfx 80 %, ambience 35 % by default) under one master; mute-all flag. Ambience is a 54 Hz sine + 108.5 Hz triangle reactor hum at gain 0.05, stopped when the tab hides. Music is a sparse 300 ms pentatonic pulse (`SCALE`) on a triangle that switches to sawtooth above ×4 momentum and gains a sub-bass pulse from ×3 (`setMusicIntensity(mult)`); it starts with each round and stops at results/quit. Every clip is fetched lazily on first use and decoded once; until it is ready, or if it fails, a procedural synth cue plays instead, so the game is never silent because of a missing file. Captions mirror meaningful cues to `#caption-bar` when "Sound captions" is on.

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

Shipped language: **English (en-US)** only. Strings live as literals in `index.html` (static labels) and `js/main.js` (dynamic HUD, results, hints, help, announcements) and `js/content.js` (stage names, intros, lesson text, achievement names). There is no language selector and no locale detection; `toLocaleString('en-US')` formats scores and `toLocaleDateString()` formats board dates. Layout allowances that already exist for longer strings: buttons wrap in `.menu-row`, cards scroll, HUD stats wrap onto a second row. See "Design intent not yet implemented" for the required nine-locale set.

## 11. Accessibility

- **Keyboard-only path.** Every screen and overlay is reachable by Tab/Enter; Space holds, Enter toggles, P/Escape pause, U undoes, R retries. Focus moves to the first button on screen change and returns on overlay close. Focus ring: 3 px `--accent` outline.
- **Live regions.** `#live-region` (polite) for hints, pause/resume, undo; `#live-alert` (assertive) for "Get ready", "Dive!", overdrive, crash, core, results totals, lesson completion. Charge pips carry `aria-label="Charge n of max"`; journey buttons have full `aria-label`s including lock and star state.
- **Captions.** Every meaningful cue writes a caption (`♪ …`) for 1.4 s when Sound captions is on (default on).
- **Contrast and colour.** High-contrast toggle swaps both the DOM tokens and the scene's safe/armor hues; the hint pill names the segment kind in words ("SAFE (bright)", "ARMOR — release!") so colour is never the only channel.
- **Reduced motion.** Setting or `prefers-reduced-motion` removes spin, drift and shake (the toast fade is disabled by the media query only); timings are unchanged.
- **Other options.** Larger text (120 %), left-handed tray, toggle instead of hold, timing assist (shows the hint 100 ms earlier; rules unchanged), three volume sliders plus mute.
- **Targets.** All buttons ≥ 44×44 px; the hold button ≥ 160×56 px (e2e asserts ≥ 44).

## 12. StarHermit integration

Manifest: `starhermit.txt` declares `name=Core Breaker`, `launch=index.html`, `owner`, `server=server.js`, `version=1.0.0`, `contentVersion=1`, `cover=coverart.png` per the packaging conventions on https://wiki.starhermit.com/.

| Platform feature | Status |
|---|---|
| Game script (`server=server.js`) | Used. Serves the distribution; `GET /api/v1/time` (clock sync), `GET /api/v1/daily?date=` (immutable daily metadata), `GET /api/v1/leaderboard?board=`, `POST /api/v1/score` (replays the command log through `rules.js`, rejects stale content version, out-of-bounds configs, illegal commands, hash or score mismatch; boards capped at 50 entries in `tools/scores.json`) |
| Server time | Used. `syncServerTime` computes a round-trip-adjusted offset; the daily countdown says "(server time)" or "(local clock)" |
| Identity / profile | Not used. Submissions carry the fixed name `local pilot` |
| Presence, activity, sessions, rooms, chat, voice | Not used (solo game) |
| Leaderboards | Server boards are written and validated; the client displays only its local board |
| Achievements | Local only (`localStorage`), not delivered to the platform |
| Cloud save | Not used; progress is the local checksummed document `corebreaker.progress.v1` |

The game is fully playable with the server unreachable or from `file:` (all fetches are guarded and failures are silent).

## 13. Technical architecture

- **Module boundaries.** `rules.js` and `content.js` are UMD and shared verbatim by browser, tests and `server.js`. `main.js` mutates game state only through `Rules.applyCommand`; `render.js` reads snapshots and never writes them; `audio.js` and `session.js` are side-effect sinks.
- **Loop.** `setInterval(1000/60)` issues `{type:'wait', atTick: tick+1}` per tick (`tickStep`); `requestAnimationFrame` draws the latest snapshot (`frameLoop`). Input commands are applied at the current tick, so the log is exact and replayable.
- **Replay envelope.** `{v:1, contentVersion, cfg, seed, log, hash, score, atMs}` saved as `lastReplay` and POSTed to the server (except Learn and Practice). The results screen prints hash, seed and command count, then appends "server validated (rank n)" or the server's error.
- **Persistence.** `localStorage` key `corebreaker.progress.v1` = `{v, data, sum}` with FNV-1a checksum; unknown version or bad checksum starts clean. Fields: journey stars/best, bests per board, dailies, tutorialDone, achievements, totals, settings, lastReplay. Score Chase keeps a separate `corebreaker.scoreboard.v1` list.
- **Rendering budget.** Windowed mesh pool: 3 layers above and 12 below the striker, at most 15 × sectors segment meshes (≤ 150 at 10 sectors) plus 140 pooled particle spheres; quality tiers cap DPR at 1 / 1.5 / 2, enable shadows only on high, and cut particle counts to 1/3 and 2/3 on low/medium. `auto` picks medium on coarse pointers or viewports under 600 px.
- **Server hardening.** 256 KB body cap, 20 000 command cap, 15-minute simulated-time cap, config bounds (`CFG_LIMITS`), path traversal and `.git`/`node_modules` refusal.
- **E2E driving.** `tests/e2e.mjs` starts `server.js` on an ephemeral port with `CB_SCORES_FILE` redirected, launches system Chrome with SwiftShader, and plays through the visible UI only: clicks real buttons, holds Space (desktop) or the on-screen HOLD button (mobile, `hasTouch`), reads the hint pill text to decide when to release, and checks localStorage progress.

## 14. Testing and acceptance criteria

`npm test` (`tests/run_tests.js`, 29 tests): config validation; hold descends and breaks; momentum growth; win bonuses; armor crash; overdrive; gap pass; release resets and decays; invalid-action reasons; time limit; resign; undo restore; peek/hint; serialization and version rejection; same seed + commands → same hash; different seeds differ; malformed-command fuzz; endless ramp without soft locks; all shipped configs legal and passable; daily immutability; lessons completable; achievement key format; golden greedy-policy wins for easy/mid/hard and every journey stage; interrupted/resumed replay equality; server accepts genuine and rejects forged replays; server ranking.

`tests/e2e.mjs` (desktop 1280×800 keyboard, mobile 390×844 touch): title loads without the WebGL compat note; settings apply high contrast/reduced motion/high quality; help shows ≥ 3 cards; Learn opens lesson 1; journey grid has 40 stages with 1 unlocked; stage 1 is won with a 7-row breakdown and "server validated"; stars persist; stage 2 undo rewinds depth exactly, pause → settings → resume → win; Practice Calm reaches results by hint-driven dodging; Daily and Score screens render; hold button ≥ 44 px; zero console/page errors.

**QA bar as checkable statements.** A new player sees instructions (lesson text, hint pill, stage intros) before needing them. Every feature in the UI is reachable in the browser by click/tap and by keyboard. No console errors or warnings during the playthrough. Text and controls are visible and not cut off at 1280×800 and 390×844 in both orientations. The game stays playable when the server, audio or an image is unavailable.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 108 KB) | Title screen backdrop under a dark veil | FLUX.2 klein, seed 4601, 1536×864, 28 steps | generated in this pass |
| `assets/core-reached.webp` (1024×576, 46 KB) | Results illustration on a win | FLUX.2 klein, seed 4602 | generated in this pass |
| `assets/dive-over.webp` (1024×576, 34 KB) | Results illustration on a loss | FLUX.2 klein, seed 4603 | generated in this pass |
| `coverart.png` (1200×675, 424 KB) | Store cover | key art + ffmpeg drawtext title/tagline, 256-colour PNG | generated in this pass (replaced a generic placeholder) |
| `icon.png`, `favicon.svg` | Icon and favicon | authored SVG/PNG | shipped |
| `sfx/*.opus` × 12 (dive-start … countdown-beep) | Core cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/undo-rewind.opus`, `lesson-complete.opus`, `timer-warning.opus`, `new-best.opus` | New cues, see §9 | MOSS-SoundEffect v2.0, 100 steps | generated in this pass |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical binding list / generator input / table | authored | updated in this pass |
| 3D model / character animation | none | — | not called for: striker and segments are procedural; no humanoid |

## 16. Known limitations

- English only; no locale switching (see intent below).
- The client never reads `GET /api/v1/leaderboard`; Score Chase shows the local board, and the copy "hosted boards compare with friends" describes the server side only.
- All submissions are named `local pilot`, so server boards cannot tell players apart; duplicates are collapsed by name + score + seed + duration.
- The `daily` and `journey` server boards mix every date / stage into one list; the HUD "Best" in Journey is the best across all stages, not the current stage.
- Achievements never leave the device.
- Backgrounding during the 3-2-1 countdown does not pause; the round starts and ticks slowly in the background until the tab returns.
- Particle bursts are not suppressed by reduced motion.
- The achievement toast can briefly overlap the results headline (2.6 s, non-blocking).
- `tests/browser_smoke.js` is a legacy CDP script with hard-coded ports and is not run by `npm test`.

## Design intent not yet implemented

- Localization for en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT with a string table and language selection from the platform locale.
- Fetching and showing the server-validated leaderboards (global and friends-filtered) on the Score Chase, Daily and Challenge screens, with the player's platform display name on submissions.
- Delivering achievements and cloud-saving the progress document through the platform.
- Per-stage HUD best in Journey and per-date daily boards.
- Suppressing particle bursts under reduced motion.
