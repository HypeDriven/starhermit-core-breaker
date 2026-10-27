// The browser build's pure game scripts, shared unchanged with the node tests
// and server.js: the seeded streams (js/rng.js), the deterministic rules
// engine (js/rules.js), the content (js/content.js: themes, Journey,
// challenges, practice presets, the daily, lessons, achievements), the
// string tables (js/strings.js, js/i18n.js) and the progress document
// (js/session.js), evaluated as classic scripts so their globals are this
// module's exports. js/session.js keeps its document in `localStorage`:
// platform.ts puts a shim there whose progress key is the game's save.
import { loadClassic } from "starhermit:script";

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/strings.js", "js/i18n.js", "js/session.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Seg = 0 | 1 | 2;
export interface Cfg {
  id: string; version: number; kind: string; index?: number; name: string; seed: number; date?: string;
  layers: number; sectors: number; armorPct: number; gapPct: number; rotSpeed: number; fallSpeed: number;
  chargeMax: number; timeLimitSec: number; par: { timeSec: number; mult: number } | null;
  mechanics: { undo: boolean; hint: boolean }; endless: boolean; theme?: string; intro?: string; mastery?: boolean;
  forceLayers?: Seg[][]; startAngle?: number;
  /** Practice: the preset's English name (shown as "Practice — <name>"). */
  practiceName?: string;
}
export interface Score {
  breaks: number; breakPoints: number; passes: number; passPoints: number; overdrives: number; overdrivePoints: number;
  timeBonus: number; multBonus: number; chargeBonus: number; total: number;
}
export interface State {
  v: number; cfg: Cfg; seed: number; tick: number; angle: number; holding: boolean; depth: number; fall: number;
  mult: number; bestMult: number; charge: number; layers: Seg[][]; score: Score;
  stats: { presses: number; releases: number; holdTicks: number }; elapsedMs: number;
  terminal: { reason: string; won: boolean } | null; undoSnap: unknown;
}
export interface RulesEvent { type: string; layer?: number; sector?: number; mult?: number; charge?: number; reason?: string }
export interface Command { type: "press" | "release" | "wait" | "resign" | "undo"; atTick?: number; id?: string }
export interface Peek { segment: Seg; ms: number; willCrash: boolean; chargeReady: boolean }
export interface Theme {
  id: string; name: string; unlockStars: number;
  palette: {
    bg: number; shaft: number; shaftEdge: number; safe: number; safeHC: number; armor: number; armorHC: number;
    core: number; light: number; accent: number; striker: number; fog: number;
  };
}
export interface Lesson { id: string; title: string; text: string; goal: { event: string; count: number }; cfg: Cfg }
export interface Replay { v: 1; contentVersion: number; cfg: Cfg; seed: number; log: Command[]; hash: number; score: number; atMs: number }
export interface Doc {
  v: number; journey: Record<string, { stars: number; best: number }>; bests: Record<string, { score: number; atMs: number }>;
  dailies: Record<string, { score: number; won: boolean }>; tutorialDone: Record<string, boolean>; achievements: Record<string, number>;
  totals: { breaks: number; rounds: number; wins: number }; settings: Record<string, unknown>; lastReplay: Replay | null;
}
export interface Wrapped { v: number; data: Doc; sum: number }

interface RulesApi {
  SEG: { SAFE: 0; ARMOR: 1; GAP: 2 };
  TERMINAL: { CORE: string; ARMOR: string; TIME: string; RESIGN: string };
  createGame(cfg: Cfg): State;
  applyCommand(s: State, cmd: Command): { ok: boolean; state: State; events: RulesEvent[]; reason?: string };
  legalActions(s: State): string[];
  hint(s: State): { action: string; why: string; peek: Peek } | null;
  hashState(s: State): number;
  clone<T>(v: T): T;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; PRACTICE: Cfg[]; SCORE_CHASE: Cfg;
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  dailyConfig(date: string): Cfg;
  utcDateString(nowMs?: number): string;
  tutorialLessons(): Lesson[];
}
interface SessionApi {
  DOC_KEY: string; GAME_SETTING_KEYS: string[]; DEFAULT_SETTINGS: Record<string, unknown>;
  emptyDoc(): Doc; wrap(d: Doc): Wrapped; unwrap(w: unknown): Doc | null; mergeDocs(a: Doc | null, b: Doc | null): Doc;
  checkSetting(key: string, v: unknown): number | string | undefined;
  gameSettingsFrom(obj: unknown): Record<string, number | string>;
  load(): void; readonly doc: Doc;
  getBest(kind: string): number | null; submitBest(kind: string, score: number, atMs: number): boolean;
  getJourney(id: string): { stars: number; best: number } | null;
  recordJourney(id: string, won: boolean, score: number, parMet: boolean): { stars: number; best: number };
  totalStars(): number;
  getDaily(date: string): { score: number; won: boolean } | null; recordDaily(date: string, score: number, won: boolean): void; dailyCount(): number;
  isTutorialDone(id: string): boolean; markTutorialDone(id: string): void;
  unlockAchievement(key: string, atMs: number): boolean;
  addTotals(breaks: number, won: boolean): void; getTotals(): { breaks: number; rounds: number; wins: number };
  saveReplay(r: Replay): void;
  mergeWrapped(w: unknown): boolean;
  importWrapped(w: unknown): boolean;
}
interface RngApi {
  create(seed: number): { next(): number; int(n: number): number };
  hashString(s: string): number;
}
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}

const g = globalThis as unknown as { CBRules: RulesApi; CBContent: ContentApi; CBSession: SessionApi; CBRNG: RngApi; CBI18N: I18nApi };
export const Rules = g.CBRules;
export const Content = g.CBContent;
export const Session = g.CBSession;
export const RNG = g.CBRNG;
export const I18n = g.CBI18N;
