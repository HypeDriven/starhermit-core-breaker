/* Core Breaker — local session: versioned, checksummed progress document,
 * settings, achievements, best scores, replay storage. Offline-first; no
 * credentials or tokens are ever persisted here.
 *
 * The document lives under `localStorage['corebreaker.progress.v1']` as
 * {v, data, sum} (FNV-1a checksum). On the StarHermit engine that key is a
 * shim over the game's save (native/platform.ts), so the same wrapped
 * document is the device copy and the cloud save, exactly as the browser
 * build's cloud slot held it. The pure helpers (wrap, unwrap, mergeDocs,
 * gameSettingsFrom) serve the save-conflict merge, the browser build's
 * migration and the node tests.
 * UMD: classic script (globalThis.CBSession) / CommonJS. */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CBRNG;
  var api = factory(root, RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, RNG) {
  'use strict';

  var DOC_KEY = 'corebreaker.progress.v1';
  var DOC_VERSION = 1;

  var DEFAULT_SETTINGS = {
    volMusic: 40, volSfx: 80, volAmbience: 35, muted: 0,
    quality: 'auto',            // graphics preset: auto | low | balanced | high | ultra (legacy 'medium' = balanced)
    gfx: {},                    // graphics overrides: render_scale, adaptive, show_fps, per-category tiers
    reducedMotion: 0, highContrast: 0, largeText: 0, leftHanded: 0,
    holdToggle: 0,              // 0 = hold-to-dive, 1 = toggle
    timingAssist: 0,            // widens nothing in rules; shows stronger hints
    captions: 1, theme: 'void'
  };
  // The options the game itself still offers on the engine (the rest —
  // volumes, mute, graphics, reduced motion, high contrast, text size — are
  // the runtime's Options).
  var GAME_SETTING_KEYS = ['captions', 'leftHanded', 'holdToggle', 'timingAssist', 'theme'];
  var THEME_IDS = ['void', 'glacial', 'ember', 'verdant', 'solar'];

  function emptyDoc() {
    return {
      v: DOC_VERSION,
      journey: {},              // levelId -> {stars:int, best:int}
      bests: {},                // kind -> {score:int, atMs:int}
      dailies: {},              // dateStr -> {score:int, won:bool}
      tutorialDone: {},         // lessonId -> true
      achievements: {},         // key -> atMs
      totals: { breaks: 0, rounds: 0, wins: 0 },
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      lastReplay: null          // {cfg, log, hash, score, atMs}
    };
  }

  function checksum(payload) {
    return RNG.hashString(JSON.stringify(payload)) >>> 0;
  }

  /** The stored form of a document: {v, data, sum}. */
  function wrap(d) { return { v: DOC_VERSION, data: d, sum: checksum(d) }; }

  /** A wrapped document (object or JSON text) → its data with defaults filled, or null when the
   * version or checksum does not match (unknown version or corrupted: start clean). */
  function unwrap(w) {
    try {
      var o = typeof w === 'string' ? JSON.parse(w) : w;
      if (!o || typeof o !== 'object' || o.v !== DOC_VERSION || !o.data || typeof o.data !== 'object') return null;
      if (checksum(o.data) !== o.sum) return null;
      var d = JSON.parse(JSON.stringify(o.data));
      var base = emptyDoc();
      for (var k in base) if (d[k] === undefined || d[k] === null && k !== 'lastReplay') d[k] = base[k];
      if (!d.settings || typeof d.settings !== 'object') d.settings = base.settings;
      for (var s in DEFAULT_SETTINGS) if (d.settings[s] === undefined) d.settings[s] = DEFAULT_SETTINGS[s];
      if (!d.totals || typeof d.totals !== 'object') d.totals = base.totals;
      return d;
    } catch (e) { return null; }
  }

  /** `a` with `b` merged in, neither losing anything: per stage the higher stars and best, the
   * higher best per board, every daily (better score, won on either), lesson and achievement
   * (earliest unlock), the larger totals; `a`'s settings and last replay (b's when a has none). */
  function mergeDocs(a, b) {
    var out = JSON.parse(JSON.stringify(a || emptyDoc()));
    if (!b) return out;
    var k;
    for (k in b.journey || {}) {
      var x = out.journey[k], y = b.journey[k];
      if (!y) continue;
      out.journey[k] = !x ? { stars: y.stars || 0, best: y.best || 0 } : { stars: Math.max(x.stars || 0, y.stars || 0), best: Math.max(x.best || 0, y.best || 0) };
    }
    for (k in b.bests || {}) {
      if (b.bests[k] && (!out.bests[k] || b.bests[k].score > out.bests[k].score)) out.bests[k] = b.bests[k];
    }
    for (k in b.dailies || {}) {
      var p = out.dailies[k], q = b.dailies[k];
      if (!q) continue;
      out.dailies[k] = !p ? q : { score: Math.max(p.score || 0, q.score || 0), won: !!(p.won || q.won) };
    }
    for (k in b.tutorialDone || {}) if (b.tutorialDone[k]) out.tutorialDone[k] = true;
    for (k in b.achievements || {}) {
      if (!b.achievements[k]) continue;
      out.achievements[k] = out.achievements[k] ? Math.min(out.achievements[k], b.achievements[k]) : b.achievements[k];
    }
    var t = b.totals || {};
    ['breaks', 'rounds', 'wins'].forEach(function (n) { out.totals[n] = Math.max(out.totals[n] || 0, t[n] || 0); });
    if (!out.lastReplay && b.lastReplay) out.lastReplay = b.lastReplay;
    return out;
  }

  /** A game option's value when valid (booleans as 0/1, a theme id), else undefined. */
  function checkSetting(key, v) {
    if (key === 'theme') return THEME_IDS.indexOf(v) >= 0 ? v : undefined;
    if (GAME_SETTING_KEYS.indexOf(key) < 0) return undefined;
    if (v === true || v === 1) return 1;
    if (v === false || v === 0) return 0;
    return undefined;
  }
  /** The game options found in a settings object (a document's, or the account's old keys). */
  function gameSettingsFrom(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    GAME_SETTING_KEYS.forEach(function (k) {
      var v = checkSetting(k, obj[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  var doc = emptyDoc();
  function storage() { try { return root.localStorage || null; } catch (e) { return null; } }

  /** (Re)reads the document from storage; defaults when missing, of another version or corrupt. */
  function load() {
    doc = emptyDoc();
    var ls = storage();
    if (!ls) return;
    try {
      var d = unwrap(ls.getItem(DOC_KEY));
      if (d) doc = d;
    } catch (e) { /* storage unavailable or corrupt: run on defaults */ }
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(DOC_KEY, JSON.stringify(wrap(doc))); } catch (e) { /* full or unavailable */ }
  }

  // Validates a wrapped doc string ({v, data, sum}) and, when it matches the
  // current version and checksum, adopts it as the live doc. Returns true when adopted.
  function importWrapped(wrapped) {
    var d = unwrap(wrapped);
    if (!d) return false;
    doc = d;
    save();
    return true;
  }

  // Another device's (or the browser build's) document: merged into the live
  // one (mergeDocs keeps the better of both, this device's settings and last
  // replay) and saved. Returns whether the other document was valid.
  function mergeWrapped(wrapped) {
    var d = unwrap(wrapped);
    if (d) doc = mergeDocs(doc, d);
    save();
    return !!d;
  }

  load();

  // ---------- settings ----------
  function getSetting(key) { return doc.settings[key]; }
  function setSetting(key, val) { doc.settings[key] = val; save(); }

  // ---------- bests ----------
  function getBest(kind) { var b = doc.bests[kind]; return b ? b.score : null; }
  function submitBest(kind, score, atMs) {
    var prev = doc.bests[kind];
    if (!prev || prev.score < score) { doc.bests[kind] = { score: score, atMs: atMs }; save(); return true; }
    return false;
  }

  // ---------- journey ----------
  function getJourney(levelId) { return doc.journey[levelId] || null; }
  function recordJourney(levelId, won, score, parMet) {
    var j = doc.journey[levelId] || { stars: 0, best: 0 };
    if (won) j.stars = Math.max(j.stars, parMet ? 2 : 1);
    if (score > j.best) j.best = score;
    doc.journey[levelId] = j;
    save();
    return j;
  }
  function totalStars() {
    var t = 0;
    for (var k in doc.journey) t += doc.journey[k].stars;
    return t;
  }

  // ---------- dailies ----------
  function getDaily(dateStr) { return doc.dailies[dateStr] || null; }
  function recordDaily(dateStr, score, won) {
    var d = doc.dailies[dateStr] || { score: 0, won: false };
    d.score = Math.max(d.score, score);
    d.won = d.won || won;
    doc.dailies[dateStr] = d;
    save();
  }
  function dailyCount() {
    var n = 0;
    for (var k in doc.dailies) if (doc.dailies[k].won) n++;
    return n;
  }

  // ---------- tutorial ----------
  function isTutorialDone(id) { return !!doc.tutorialDone[id]; }
  function markTutorialDone(id) { doc.tutorialDone[id] = true; save(); }

  // ---------- achievements (idempotent) ----------
  function hasAchievement(key) { return !!doc.achievements[key]; }
  function unlockAchievement(key, atMs) {
    if (doc.achievements[key]) return false;
    doc.achievements[key] = atMs;
    save();
    return true;
  }

  // ---------- totals ----------
  function addTotals(breaks, won) {
    doc.totals.breaks += breaks;
    doc.totals.rounds++;
    if (won) doc.totals.wins++;
    save();
  }
  function getTotals() { return doc.totals; }

  // ---------- replay ----------
  function saveReplay(r) { doc.lastReplay = r; save(); }
  function getReplay() { return doc.lastReplay; }

  return {
    DOC_KEY: DOC_KEY, DOC_VERSION: DOC_VERSION, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    GAME_SETTING_KEYS: GAME_SETTING_KEYS, THEME_IDS: THEME_IDS,
    emptyDoc: emptyDoc, wrap: wrap, unwrap: unwrap, mergeDocs: mergeDocs,
    checkSetting: checkSetting, gameSettingsFrom: gameSettingsFrom,
    load: load, get doc() { return doc; },
    getSetting: getSetting, setSetting: setSetting,
    getBest: getBest, submitBest: submitBest,
    getJourney: getJourney, recordJourney: recordJourney, totalStars: totalStars,
    getDaily: getDaily, recordDaily: recordDaily, dailyCount: dailyCount,
    isTutorialDone: isTutorialDone, markTutorialDone: markTutorialDone,
    hasAchievement: hasAchievement, unlockAchievement: unlockAchievement,
    addTotals: addTotals, getTotals: getTotals,
    saveReplay: saveReplay, getReplay: getReplay,
    importWrapped: importWrapped, mergeWrapped: mergeWrapped
  };
});
