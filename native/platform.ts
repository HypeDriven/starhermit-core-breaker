// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey stars and bests, best per board, dailies, lessons,
//   achievements, lifetime totals, the last replay) is js/session.js's
//   checksummed document {v, data, sum}, unchanged: it is the game's save
//   (starhermit:storage `saves`) on the device and in the player's cloud slot,
//   two devices' copies merged on a conflict (CBSession.mergeDocs). The slot
//   the browser build wrote (the JS SDK's zipped save.json, the same wrapped
//   document) shows as foreign and is merged in and replaced once;
// - js/session.js keeps reading and writing `localStorage`: here a shim
//   whose progress key is that save and whose other keys (the Score Chase
//   board of this device) are the device's starhermit:storage, as the
//   browser build kept them;
// - the game's own options (sound captions, left-handed tray, toggle
//   instead of hold, timing assist, practice theme) are `settings`
//   (game.<key>, synced with the account); the browser build's settings (its
//   document's and the account's per-player keys) are migrated, then the old
//   keys removed. Volumes, mute, graphics, language, reduced motion, high
//   contrast and text size are the runtime's Options;
// - the player (signed in or a guest), the invite link, the platform's
//   clock for the daily, the high-score board's rows for Score Chase, and
//   posting a finished Score Chase dive through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank on that board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { Session, type Wrapped } from "./classic.ts";

// --- the save and the localStorage shim ----------------------------------------------
let current: Wrapped | null = null;
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function persist(): void {
  if (!current) return;
  try { saves.save(current as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
const shim = {
  getItem(key: string): string | null {
    if (key === Session.DOC_KEY) return current ? JSON.stringify(current) : null;
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (key === Session.DOC_KEY) {
      try { current = JSON.parse(value) as Wrapped; } catch { return; }
      persist();
      return;
    }
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    if (key === Session.DOC_KEY) return;
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

/** Merges another copy of the document into the live one (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const d = Session.unwrap(other);
  if (!d) return false;
  const next = Session.mergeDocs(Session.doc, d);
  if (JSON.stringify(next) === JSON.stringify(Session.doc)) return false;
  Session.importWrapped(Session.wrap(next));
  return true;
}

saves.onConflict((local, remote) => ({
  merged: Session.wrap(Session.mergeDocs(Session.unwrap(local?.data), Session.unwrap(remote.data))) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});

/** The browser build's cloud save: merged with this device's progress, its game options kept, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let wrapped: unknown = null;
  try { wrapped = old.text ? JSON.parse(old.text) : null; } catch { wrapped = null; }
  const changed = adopt(wrapped);
  const d = Session.unwrap(wrapped);
  if (d) for (const [k, v] of Object.entries(Session.gameSettingsFrom(d.settings))) adoptSetting(k, v);
  if (!current) current = Session.wrap(Session.doc);
  try { saves.save(current as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options ---------------------------------------------------------------
export interface Settings { captions: number; leftHanded: number; holdToggle: number; timingAssist: number; theme: string; [key: string]: unknown }
export const settings: Settings = { captions: 1, leftHanded: 0, holdToggle: 0, timingAssist: 0, theme: "void" };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Session.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = Session.checkSetting(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v);
    settings[key] = v;
    settingsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setSetting(key: "captions" | "leftHanded" | "holdToggle" | "timingAssist" | "theme", value: number | string): void {
  if (settings[key] === value) return;
  (settings as Record<string, unknown>)[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings (each document setting under its
// own key, and ui.language): the game's options among them carry over
// (unless this game set them since), then all are removed.
const BROWSER_KEYS = [...Object.keys(Session.DEFAULT_SETTINGS), "ui.language"];
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const old: Record<string, unknown> = {};
  for (const key of keys) if (Session.GAME_SETTING_KEYS.includes(key)) old[key] = store.legacy(key);
  for (const [k, v] of Object.entries(Session.gameSettingsFrom(old))) adoptSetting(k, v);
  for (const key of keys) if (BROWSER_KEYS.includes(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  current = Session.unwrap(cur?.data) ? (cur!.data as unknown as Wrapped) : null;
  Session.load();
  for (const k of Session.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!Session.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Whether nowMs() follows the platform's clock. */
export function timeTrusted(): boolean { try { return serverNow() !== null; } catch { return false; } }

// --- the StarHermit high-score board ---------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { name: string; score: number; you: boolean }
/** Signed in: the high-score board's first rows (names from the players' profiles, the
 * player's own "You (name)"), or null when unavailable. */
export async function fetchLeaderboard(youLabel: (name: string) => string): Promise<BoardRow[] | null> {
  const me = player();
  if (!me) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const page = await leaderboards.entries(b.id, { pageSize: 20 });
    return await Promise.all(page.items.slice(0, 10).map(async (e) => {
      let name = e.username || "Player " + e.userId.slice(0, 6);
      if (e.userId === me.userId) name = me.displayName;
      else { try { name = (await profile(e.userId)).displayName; } catch { /* the username */ } }
      const you = e.userId === me.userId;
      return { name: you ? youLabel(name) : name, score: Math.floor(Number(e.score) || 0), you };
    }));
  } catch { return null; }
}

/** Signed in only: post a finished Score Chase dive's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
