/* Core Breaker — local session: versioned, checksummed progress document,
 * settings, achievements, best scores, replay storage. Offline-first; no
 * credentials or tokens are ever persisted here. */
(function () {
  'use strict';

  var RNG = window.CBRNG;
  var DOC_KEY = 'corebreaker.progress.v1';
  var DOC_VERSION = 1;

  var DEFAULT_SETTINGS = {
    volMusic: 40, volSfx: 80, volAmbience: 35, muted: 0,
    quality: 'auto',            // graphics preset: auto | low | balanced | high | ultra (legacy 'medium' = balanced)
    gfx: {},                    // graphics overrides: render_scale, adaptive, show_fps, per-category tiers (js/gfx.js)
    reducedMotion: 0, highContrast: 0, largeText: 0, leftHanded: 0,
    holdToggle: 0,              // 0 = hold-to-dive, 1 = toggle
    timingAssist: 0,            // widens nothing in rules; shows stronger hints
    captions: 1, theme: 'void'
  };

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

  var doc = null;

  function checksum(payload) {
    return RNG.hashString(JSON.stringify(payload)) >>> 0;
  }

  function load() {
    doc = emptyDoc();
    try {
      var raw = localStorage.getItem(DOC_KEY);
      if (!raw) return;
      var wrap = JSON.parse(raw);
      if (!wrap || wrap.v !== DOC_VERSION) return; // unknown version: start clean
      if (checksum(wrap.data) !== wrap.sum) return; // corrupted: start clean
      var d = wrap.data;
      for (var k in doc) if (d[k] === undefined) d[k] = doc[k];
      for (var s in DEFAULT_SETTINGS) if (d.settings[s] === undefined) d.settings[s] = DEFAULT_SETTINGS[s];
      doc = d;
    } catch (e) { /* storage unavailable or corrupt: run on defaults */ }
  }

  function save() {
    var wrapped = null;
    try {
      wrapped = JSON.stringify({ v: DOC_VERSION, data: doc, sum: checksum(doc) });
      localStorage.setItem(DOC_KEY, wrapped);
    } catch (e) {}
    if (window.CBPlatform && typeof window.CBPlatform.onLocalSave === 'function' && wrapped)
      window.CBPlatform.onLocalSave(wrapped); // host adapter mirrors to the cloud slot
  }

  // Validates a wrapped doc string ({v, data, sum}) and, when it matches the
  // current version and checksum, adopts it as the live doc (remote-preferred
  // cloud load goes through here). Returns true when adopted.
  function importWrapped(wrapped) {
    try {
      var wrap = JSON.parse(wrapped);
      if (!wrap || wrap.v !== DOC_VERSION) return false;
      if (checksum(wrap.data) !== wrap.sum) return false;
      var d = wrap.data;
      for (var k in doc) if (d[k] === undefined) d[k] = doc[k];
      for (var s in DEFAULT_SETTINGS) if (d.settings[s] === undefined) d.settings[s] = DEFAULT_SETTINGS[s];
      doc = d;
      save(); // local cache mirrors the remote doc
      return true;
    } catch (e) { return false; }
  }

  // Cloud-save conflict (another device saved first): merge the newer cloud doc
  // into the live one so neither device loses anything — per stage the higher
  // stars and best, the higher best per board, every daily (better score, won on
  // either), lesson and achievement (earliest unlock), the larger totals; this
  // device's settings and last replay. Saves the merge (mirrored to the cloud).
  function mergeWrapped(wrapped) {
    var d = null;
    try {
      var wrap = wrapped ? JSON.parse(wrapped) : null;
      if (wrap && wrap.v === DOC_VERSION && checksum(wrap.data) === wrap.sum) d = wrap.data;
    } catch (e) { d = null; }
    if (d) {
      var k;
      for (k in d.journey || {}) {
        var a = doc.journey[k], b = d.journey[k];
        doc.journey[k] = !a ? b : { stars: Math.max(a.stars || 0, b.stars || 0), best: Math.max(a.best || 0, b.best || 0) };
      }
      for (k in d.bests || {}) {
        if (!doc.bests[k] || (d.bests[k] && d.bests[k].score > doc.bests[k].score)) doc.bests[k] = d.bests[k];
      }
      for (k in d.dailies || {}) {
        var x = doc.dailies[k], y = d.dailies[k];
        doc.dailies[k] = !x ? y : { score: Math.max(x.score || 0, y.score || 0), won: !!(x.won || y.won) };
      }
      for (k in d.tutorialDone || {}) if (d.tutorialDone[k]) doc.tutorialDone[k] = true;
      for (k in d.achievements || {}) {
        doc.achievements[k] = doc.achievements[k] ? Math.min(doc.achievements[k], d.achievements[k]) : d.achievements[k];
      }
      var t = d.totals || {};
      ['breaks', 'rounds', 'wins'].forEach(function (n) { doc.totals[n] = Math.max(doc.totals[n] || 0, t[n] || 0); });
      if (!doc.lastReplay && d.lastReplay) doc.lastReplay = d.lastReplay;
    }
    save();
    return !!d;
  }

  load();

  // ---------- settings ----------
  function getSetting(key) { return doc.settings[key]; }
  function setSetting(key, val) {
    doc.settings[key] = val; save();
    var P = window.CBPlatform, o = {};
    if (P && P.hosted && typeof P.patchSettings === 'function') { o[key] = val; P.patchSettings(o); } // settings KV mirror
  }
  // Platform settings KV → local doc (known keys only; platform value wins).
  function applyRemoteSettings(obj) {
    var changed = false;
    for (var k in DEFAULT_SETTINGS) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null &&
          typeof obj[k] === typeof DEFAULT_SETTINGS[k]) { doc.settings[k] = obj[k]; changed = true; }
    }
    if (changed) save();
    return changed;
  }

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

  window.CBSession = {
    getSetting: getSetting, setSetting: setSetting, applyRemoteSettings: applyRemoteSettings,
    getBest: getBest, submitBest: submitBest,
    getJourney: getJourney, recordJourney: recordJourney, totalStars: totalStars,
    getDaily: getDaily, recordDaily: recordDaily, dailyCount: dailyCount,
    isTutorialDone: isTutorialDone, markTutorialDone: markTutorialDone,
    hasAchievement: hasAchievement, unlockAchievement: unlockAchievement,
    addTotals: addTotals, getTotals: getTotals,
    saveReplay: saveReplay, getReplay: getReplay,
    importWrapped: importWrapped, mergeWrapped: mergeWrapped
  };
})();
