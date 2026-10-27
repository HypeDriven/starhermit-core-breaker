// Core Breaker on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, string tables and progress
// document are the browser build's js/rules.js, js/content.js, js/strings.js
// and js/session.js (classic.ts); this module is what js/main.js did around
// them — the screens and overlays as a state machine (title → journey |
// practice | challenges | daily | score chase → intro → countdown → active ⇄
// pause → resolving (the 900 ms settle) → results → retry | next | title),
// the hold / release / undo commands with their ordered replay log, the 3-2-1
// countdown, lesson goals, results with progression, achievements and the
// Score Chase board, input routing (actions, the pointer or a finger on the
// shaft, the HOLD TO DIVE button) and the lifecycle — with the screens and
// HUD drawn by screens.ts (starhermit:ui) and the shaft by render.ts
// (starhermit:scene).
//
// The simulation clock is the runtime's fixed steps (60 a second, the rules'
// tick): one `wait` command a step, only while the round is active, so a
// pause, a hidden window or a slow frame never moves the shaft. The countdown
// (700 ms a numeral) and the settle before results are counted in the same
// steps, so play scripts replay exactly.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Rules, Session, type Cfg, type Command, type Lesson, type Replay, type RulesEvent, type State } from "./classic.ts";
import { T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, loadArt } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type ScreenName = "title" | "journey" | "practice" | "challenge" | "daily" | "score";
export type OverlayName = "intro" | "pause" | "results" | "settings" | "help";
export type Kind = "tutorial" | "journey" | "practice" | "challenge" | "daily" | "score";
export interface Ctx { lesson?: Lesson; levelIndex?: number; date?: string }
export interface ResultsView { s: State; won: boolean; parMet: boolean; isNewBest: boolean; replay: Replay; commands: number; next: boolean }
export type LbState = null | "posting" | { posted: boolean; rank: number | null };

const COUNT_STEP = 42;   // 700 ms a countdown numeral
const SETTLE = 54;       // 900 ms between the terminal state and the results
const SCOREBOARD_KEY = "corebreaker.scoreboard.v1";

export const app = {
  /** The menu screen (null while a round is on). */
  screen: "title" as ScreenName | null,
  stack: ["title"] as ScreenName[],
  /** The open overlay, and the ones under it (Settings and Help over Pause). */
  overlay: null as OverlayName | null,
  overlayStack: [] as OverlayName[],
  /** Frame the screen or overlay opened on (the key that opened it must not also close it). */
  openedFrame: 0,
  focusNext: false,
  toast: null as { text: () => string; until: number } | null,
  caption: null as { key: string; vars: Record<string, string | number>; until: number } | null,
  results: null as ResultsView | null,
  lb: null as LbState,
  /** Signed-in Score Chase: the platform board's rows (null: not loaded). */
  board: null as platform.BoardRow[] | null,
};
export const settings = platform.settings;

// ------------------------------------------------------------------ the round's state
export let playState: State | null = null;
export let playCfg: Cfg | null = null;
export let playKind: Kind | null = null;
export let playCtx: Ctx = {};
export let paused = false;
export let countingDown = false;
export let countdownLeft = 0;
let countTicks = 0;
let settleLeft = -1;
let inputLog: Command[] = [];
let cmdSeq = 0;
let lessonGoalCount = 0;
let timerWarned = false;
let resultsShown = false;
/** What holds the dive (hold mode): "key", "pad", "pointer", "button". */
const holds = new Set<string>();

const now = (): number => frame().time;
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg, { politeness: assertive ? "assertive" : "polite" });
}
/** A toast; `text` re-runs each frame so a visible toast follows a language change. */
export function toast(text: () => string, seconds = 2.6): void { app.toast = { text, until: now() + seconds }; }
audio.setOnCaption((key, vars) => {
  if (!settings.captions) return;
  app.caption = { key, vars, until: now() + 1.4 };
});
export const playing = (): boolean => !!playState && app.screen === null;

// ------------------------------------------------------------------ screens and overlays
function opened(): void {
  app.openedFrame = frame().frame;
  app.focusNext = true;
}
export function showScreen(id: ScreenName, replace = false): void {
  app.screen = id;
  if (replace) app.stack = [id];
  else if (app.stack[app.stack.length - 1] !== id) app.stack.push(id);
  if (id === "score") loadBoard();
  opened();
}
export function goBack(): void {
  if (app.stack.length > 1) {
    app.stack.pop();
    showScreen(app.stack[app.stack.length - 1]!, true);
  } else showScreen("title", true);
}
export function openOverlay(id: OverlayName): void {
  if (app.overlay && app.overlay !== id) app.overlayStack.push(app.overlay);
  app.overlay = id;
  opened();
}
export function closeOverlay(): void {
  app.overlay = app.overlayStack.pop() ?? null;
  if (app.overlay || app.screen) opened();
  else ui.setFocus(null);
}
const overlayOpen = (): boolean => app.overlay !== null;

function loadBoard(): void {
  app.board = null;
  if (!platform.signedIn()) return;
  void platform.fetchLeaderboard((name) => T("You ({name})", { name })).then((rows) => { app.board = rows; });
}
/** js/session.js's localStorage (platform.ts's shim: the device's storage for this key). */
const store = (): { getItem(k: string): string | null; setItem(k: string, v: string): void } =>
  (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
export interface LocalRow { score: number; depth: number; atMs: number }
export function localBoard(): LocalRow[] {
  try {
    const v = JSON.parse(store().getItem(SCOREBOARD_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as LocalRow[]) : [];
  } catch { return []; }
}
function recordLocalBoard(s: State): void {
  const rows = localBoard();
  rows.push({ score: s.score.total, depth: s.depth, atMs: Date.now() });
  rows.sort((a, b) => b.score - a.score || a.atMs - b.atMs);
  try { store().setItem(SCOREBOARD_KEY, JSON.stringify(rows.slice(0, 25))); } catch { /* full */ }
}

// ------------------------------------------------------------------ mode entry
export function openIntro(cfg: Cfg, kind: Kind, ctx: Ctx): void {
  playCfg = cfg; playKind = kind; playCtx = ctx;
  openOverlay("intro");
}
export function startLesson(lesson: Lesson): void {
  lessonGoalCount = 0;
  const cfg = Rules.clone(lesson.cfg);
  cfg.theme = "void";
  cfg.name = lesson.title;
  openIntro(cfg, "tutorial", { lesson });
}
export function openLearn(): void {
  const lessons = Content.tutorialLessons();
  startLesson(lessons.find((l) => !Session.isTutorialDone(l.id)) ?? lessons[0]!);
}
export function openPlay(): void {
  // Short path: a brand-new pilot starts with lesson 1, everyone else at the first unfinished stage.
  const t = Session.getTotals();
  if (t.rounds === 0 && !Session.isTutorialDone("t1")) { openLearn(); return; }
  let idx = 0;
  for (let i = 0; i < Content.JOURNEY.length; i++) {
    const rec = Session.getJourney(Content.JOURNEY[i]!.id);
    if (rec && rec.stars > 0) idx = i + 1; else break;
  }
  idx = Math.min(idx, Content.JOURNEY.length - 1);
  openIntro(Content.JOURNEY[idx]!, "journey", { levelIndex: idx });
}
export function startPractice(p: Cfg): void {
  const cfg = Rules.clone(p);
  cfg.theme = settings.theme || "void";
  cfg.seed = Math.floor(Math.random() * 0xffffffff) >>> 0; // a fresh practice shaft each run
  cfg.name = "Practice — " + p.name;
  cfg.practiceName = p.name;
  openIntro(cfg, "practice", {});
}
export function dailyDate(): string { return Content.utcDateString(platform.nowMs()); }
export function startDaily(): void {
  const d = dailyDate();
  openIntro(Content.dailyConfig(d), "daily", { date: d });
}
export function startScoreChase(): void {
  const cfg = Rules.clone(Content.SCORE_CHASE);
  cfg.seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  openIntro(cfg, "score", {});
}

// ------------------------------------------------------------------ play lifecycle
export function objectiveText(): string {
  if (!playCfg) return "";
  if (playCfg.endless) return T("Objective: descend as deep as you can. Armor ends the dive.");
  if (playCfg.timeLimitSec) return T("Objective: reach the core ({layers} layers) before containment vents in {n}s.", { layers: playCfg.layers, n: playCfg.timeLimitSec });
  return T("Objective: reach the core — {layers} layers down.", { layers: playCfg.layers });
}

export function startPlay(): void {
  if (!playCfg) return;
  app.overlay = null; app.overlayStack = [];
  playState = Rules.createGame(playCfg);
  inputLog = [];
  cmdSeq = 0;
  resultsShown = false;
  paused = false;
  timerWarned = false;
  settleLeft = -1;
  holds.clear();
  app.results = null;
  app.lb = null;
  app.screen = null;
  app.stack = ["title"];
  ui.setFocus(null);
  render.setTheme(playCfg.theme || "void");
  render.clearWindow();
  audio.startAmbience();
  audio.startMusic();
  audio.setMusicIntensity(0);
  // countdown → active
  countingDown = true;
  countdownLeft = 3;
  countTicks = COUNT_STEP;
  announce(T("Get ready"), true);
  audio.cue("countdown");
}
function countdownTick(): void {
  if (--countTicks > 0) return;
  countdownLeft--;
  if (countdownLeft > 0) {
    countTicks = COUNT_STEP;
    audio.cue("countdown");
  } else {
    countingDown = false;
    announce(`${T("Dive!")} ${objectiveText()}`, true);
  }
}
function tickStep(): void {
  if (!playState || paused || countingDown || playState.terminal) return;
  const r = Rules.applyCommand(playState, { type: "wait", atTick: playState.tick + 1 });
  playState = r.state;
  handleEvents(r.events);
  checkTimer();
  if (playState.terminal) onTerminal();
}
function checkTimer(): void {
  const s = playState;
  if (!s || !playCfg || !playCfg.timeLimitSec || timerWarned || s.terminal) return;
  const left = playCfg.timeLimitSec * 1000 - s.elapsedMs;
  if (left < 10000 && left > 0) {
    timerWarned = true;
    audio.cue("timerWarn");
    announce(T("Containment vents in 10 seconds."));
  }
}

function handleEvents(events: RulesEvent[]): void {
  const s = playState!;
  for (const e of events) {
    render.onEvent(e, s);
    switch (e.type) {
      case "break":
        audio.cue("break", e.mult ?? 1);
        audio.setMusicIntensity(e.mult ?? 0);
        if (playCfg!.chargeMax > 0 && s.charge === playCfg!.chargeMax && e.charge === playCfg!.chargeMax) audio.cue("charge");
        break;
      case "pass": audio.cue("pass"); break;
      case "overdrive": audio.cue("overdrive"); announce(T("Overdrive! Armored segment smashed.")); break;
      case "crash": audio.cue("crash"); announce(T("Armor impact — dive over."), true); break;
      case "win": audio.cue("win"); announce(T("Core reached!"), true); break;
      case "lose":
        if (e.reason !== Rules.TERMINAL.ARMOR) { audio.cue("lose"); announce(T("Dive over: {reason}", { reason: reasonText(e.reason ?? "") }), true); }
        break;
      default: break;
    }
    if (playCtx.lesson) checkLessonGoal(e);
  }
}
function checkLessonGoal(e: RulesEvent): void {
  const lesson = playCtx.lesson!;
  if (e.type !== lesson.goal.event) return;
  lessonGoalCount++;
  if (lessonGoalCount === lesson.goal.count) {
    Session.markTutorialDone(lesson.id);
    const msg = (): string => T("Lesson complete: {title}", { title: T(lesson.title) });
    announce(msg(), true);
    toast(msg);
    audio.cue("lesson");
  }
}
export function reasonText(reason: string): string {
  switch (reason) {
    case Rules.TERMINAL.CORE: return T("core reached");
    case Rules.TERMINAL.ARMOR: return T("armor impact");
    case Rules.TERMINAL.TIME: return T("containment vented (time up)");
    case Rules.TERMINAL.RESIGN: return T("resigned");
    default: return reason;
  }
}
/** Mid-round the HUD shows the live component sum; the bonuses come at the end. */
export function liveScore(s: State): number { return s.score.breakPoints + s.score.passPoints + s.score.overdrivePoints; }

// ------------------------------------------------------------------ input commands
// Double-commit protection: press/release carry a monotonically increasing
// command id; the rules engine also rejects no-op transitions.
function canAct(): boolean { return !!playState && !paused && !countingDown && !overlayOpen() && !playState.terminal; }
function cmdPress(): boolean {
  if (!canAct() || playState!.holding) return false;
  const cmd: Command = { type: "press", atTick: playState!.tick, id: `c${++cmdSeq}` };
  const r = Rules.applyCommand(playState!, cmd);
  if (!r.ok) return false;
  playState = r.state;
  inputLog.push(cmd);
  audio.cue("press");
  handleEvents(r.events);
  if (playState.terminal) onTerminal();
  return true;
}
function cmdRelease(): void {
  if (!playState || paused || countingDown || playState.terminal || !playState.holding) return;
  const cmd: Command = { type: "release", atTick: playState.tick, id: `c${++cmdSeq}` };
  const r = Rules.applyCommand(playState, cmd);
  if (!r.ok) return;
  playState = r.state;
  inputLog.push(cmd);
  audio.cue("release");
  audio.setMusicIntensity(0);
  handleEvents(r.events);
}
export function doUndo(): void {
  if (!playState || paused || countingDown || overlayOpen()) return;
  const cmd: Command = { type: "undo", atTick: playState.tick, id: `c${++cmdSeq}` };
  const r = Rules.applyCommand(playState, cmd);
  if (!r.ok) { announce(T("Nothing to undo.")); return; }
  playState = r.state;
  inputLog.push(cmd);
  holds.clear();
  audio.cue("undo");
  announce(T("Rewound to your last release."));
  handleEvents(r.events);
}
export function canUndo(): boolean { return !!playState && Rules.legalActions(playState).includes("undo"); }
function toggleDive(): void {
  if (!playState) return;
  if (playState.holding) cmdRelease(); else cmdPress();
}
/** A hold starts from `src` (a key, a pad, the pointer, the HOLD button); toggle mode flips instead. */
export function holdStart(src: string): void {
  if (!playState) return;
  if (settings.holdToggle) { if (canAct()) toggleDive(); return; }
  if (holds.has(src)) return;
  if (holds.size) { if (playState.holding) holds.add(src); return; }
  if (cmdPress()) holds.add(src);
}
/** That hold ends: the dive releases when nothing holds it any more. Releases go through even with an overlay open. */
export function holdEnd(src: string): void {
  if (settings.holdToggle || !holds.delete(src)) return;
  if (!holds.size) cmdRelease();
}
export function holding(): boolean { return !!playState && playState.holding; }

// ------------------------------------------------------------------ pause / quit
export function pauseGame(): void {
  if (!playState || playState.terminal || paused) return;
  paused = true;
  openOverlay("pause");
  announce(T("Paused"));
}
export function resumeGame(): void {
  if (!paused) return;
  paused = false;
  app.overlay = null; app.overlayStack = [];
  ui.setFocus(null);
  announce(T("Resumed"));
}
export function restart(): void {
  app.overlay = null; app.overlayStack = [];
  if (playCtx.lesson) lessonGoalCount = 0;
  startPlay();
}
export function quitToTitle(): void {
  countingDown = false;
  paused = false;
  playState = null;
  settleLeft = -1;
  holds.clear();
  audio.stopMusic();
  audio.stopAmbience();
  app.overlay = null; app.overlayStack = [];
  app.results = null;
  showScreen("title", true);
}

// ------------------------------------------------------------------ terminal / results
function bestKey(): string {
  if (playKind === "tutorial") return "tutorial"; // lessons never touch ranked boards
  if (playKind === "practice") return `practice-${playCfg!.id}`;
  if (playKind === "challenge") return `challenge-${playCfg!.id}`;
  if (playKind === "score") return "score";
  if (playKind === "daily") return "daily";
  return "journey";
}
export function hudBest(): number | null { return playKind ? Session.getBest(bestKey()) : null; }
function onTerminal(): void {
  if (resultsShown) return;
  resultsShown = true;
  holds.clear();
  settleLeft = SETTLE; // let the burst play for a beat, then the results
}
function tryUnlock(key: string): void {
  if (!Session.unlockAchievement(key, Date.now())) return;
  const meta = Content.ACHIEVEMENTS.find((a) => a.key === key);
  if (!meta) return;
  toast(() => T("Achievement: {name}", { name: T(meta.name) }));
  announce(T("Achievement unlocked: {name}. {desc}", { name: T(meta.name), desc: T(meta.desc) }));
  audio.cue("achievement");
}
function checkAchievements(s: State, won: boolean): void {
  if (s.score.breaks > 0) tryUnlock("first-break");
  if (s.score.overdrives > 0) tryUnlock("overdrive");
  if (s.bestMult >= 8) tryUnlock("mult-8");
  if (won) tryUnlock("first-core");
  if (s.score.total >= 3000) tryUnlock("score-3000");
  if (Session.getTotals().breaks >= 500) tryUnlock("breaks-500");
  const jwins = Content.JOURNEY.filter((j) => (Session.getJourney(j.id)?.stars ?? 0) > 0).length;
  if (jwins >= 20) tryUnlock("journey-half");
  if (jwins >= 40) tryUnlock("journey-done");
  if (Session.dailyCount() >= 7) tryUnlock("daily-7");
}
function showResults(): void {
  const s = playState;
  const cfg = playCfg;
  if (!s || !s.terminal || !cfg) return;
  audio.stopMusic();
  const won = s.terminal.won;
  const parMet = !!(cfg.par && cfg.par.timeSec && s.elapsedMs <= cfg.par.timeSec * 1000);
  // persistence + progression
  Session.addTotals(s.score.breaks, won);
  let isNewBest = false;
  if (playKind !== "tutorial") isNewBest = Session.submitBest(bestKey(), s.score.total, Date.now());
  if (playKind === "journey" && playCtx.levelIndex != null) Session.recordJourney(cfg.id, won, s.score.total, parMet);
  if (playKind === "daily" && playCtx.date) Session.recordDaily(playCtx.date, s.score.total, won);
  if (playKind === "score") recordLocalBoard(s);
  checkAchievements(s, won);
  // replay envelope (schema v1)
  const replay: Replay = { v: 1, contentVersion: cfg.version, cfg, seed: cfg.seed, log: inputLog, hash: Rules.hashState(s), score: s.score.total, atMs: Date.now() };
  Session.saveReplay(replay);
  if (isNewBest && playKind !== "tutorial") audio.cue("newBest");
  let next = false;
  if (playKind === "journey" && won && playCtx.levelIndex != null) next = playCtx.levelIndex + 1 < Content.JOURNEY.length;
  else if (playCtx.lesson) {
    const lessons = Content.tutorialLessons();
    const li = lessons.findIndex((l) => l.id === playCtx.lesson!.id);
    next = li >= 0 && li + 1 < lessons.length;
  }
  app.results = { s, won, parMet, isNewBest, replay, commands: inputLog.length, next };
  // Signed in only: a finished Score Chase dive posts its total to the high-score board.
  app.lb = null;
  if (playKind === "score" && platform.signedIn()) {
    app.lb = "posting";
    void platform.postLeaderboard(s.score.total).then((r) => { app.lb = r; });
  }
  openOverlay("results");
  announce(`${won ? T("Victory.") : T("Defeat.")} ${T("Total score {n}.", { n: s.score.total })} ${reasonText(s.terminal.reason)}`, true);
  platform.flush();
}
export function retry(): void {
  app.overlay = null; app.overlayStack = [];
  lessonGoalCount = 0;
  startPlay();
}
export function nextStage(): void {
  app.overlay = null; app.overlayStack = [];
  if (playKind === "journey" && playCtx.levelIndex != null) {
    const i = playCtx.levelIndex + 1;
    playState = null;
    audio.stopAmbience();
    app.screen = "title"; app.stack = ["title"];
    openIntro(Content.JOURNEY[i]!, "journey", { levelIndex: i });
  } else if (playCtx.lesson) {
    const lessons = Content.tutorialLessons();
    const li = lessons.findIndex((l) => l.id === playCtx.lesson!.id);
    playState = null;
    audio.stopAmbience();
    app.screen = "title"; app.stack = ["title"];
    if (li >= 0 && li + 1 < lessons.length) startLesson(lessons[li + 1]!);
  }
}

// ------------------------------------------------------------------ actions
onAction((e) => {
  if (ui.capturingKeys()) return;
  const keyish = e.source === "gamepad" ? "pad" : e.source === "keyboard" ? "key" : e.source;
  if (e.action === "dive") {
    if (e.pressed) { if (playing() && !overlayOpen()) { ui.setFocus(null); holdStart(`${keyish}:dive`); } }
    else holdEnd(`${keyish}:dive`);
    return;
  }
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  switch (e.action) {
    case "toggle":
      if (playing() && !overlayOpen()) { ui.setFocus(null); if (canAct()) toggleDive(); }
      break;
    case "pause":
      if (!playing() || !fresh) break;
      if (app.overlay === "pause") resumeGame();
      else if (!overlayOpen()) pauseGame();
      break;
    case "undo":
      if (playing()) doUndo();
      break;
    case "retry":
      if (playing() && app.overlay === "results") retry();
      break;
    case "back":
      if (!fresh) break;
      if (app.overlay === "settings" || app.overlay === "help") closeOverlay();
      else if (app.overlay === "intro") closeOverlay();
      else if (app.overlay === "results") { /* stay until a choice */ }
      else if (app.overlay === "pause") resumeGame();
      else if (playing()) pauseGame();
      else goBack();
      break;
  }
});
// The pointer (and the first finger, which moves and presses it) dives
// anywhere on the shaft that is not a widget: presses are queued and decided
// after the frame's UI is built, when ui.pointerOver() knows this frame's
// widgets (the HOLD TO DIVE button holds by itself, screens.ts).
const pointerQueue: boolean[] = [];
onPointerButton((e) => { if (e.button === 0) pointerQueue.push(e.pressed); });
function pointerInput(): void {
  for (const pressed of pointerQueue.splice(0)) {
    if (pressed) { if (playing() && !overlayOpen() && !ui.pointerOver()) holdStart("pointer"); }
    else holdEnd("pointer");
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyPrefs(): void {
  const p = preferences();
  applyContrast(p.highContrast);
  render.setHighContrast(p.highContrast);
  render.setReducedMotion(p.reducedMotion);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  applyPrefs();
  audio.loadSfx();
  applyLook();
  render.setTheme("void");
  loadArt();
  showScreen("title", true);
});
onPreferencesChange(() => applyPrefs());
platform.onProgressMerged(() => undefined);
onSessionEnded(() => { toast(() => T("Signed out of StarHermit — progress stays on this device."), 4); });
onSuspend(() => {
  // Backgrounding pauses an active round (not its countdown) and stops the hum.
  if (playState && !playState.terminal && !paused && !countingDown) pauseGame();
  audio.setPaused(true);
  platform.flush();
});
onResume(() => audio.setPaused(false));
onQuit(() => platform.flush());

onFixedUpdate(() => {
  if (!playState) return;
  if (countingDown) { if (!paused) countdownTick(); return; }
  tickStep();
  if (settleLeft > 0 && --settleLeft === 0) { settleLeft = -1; showResults(); }
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t = now();
  if (app.toast && t > app.toast.until) app.toast = null;
  if (app.caption && t > app.caption.until) app.caption = null;
});
onRender(() => {
  const f = frame();
  drawScreens();
  pointerInput();
  render.render(playState, frameDt, f.width, f.height);
});

