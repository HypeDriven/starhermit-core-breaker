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
    quality: 'auto',            // auto | low | medium | high
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
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify({ v: DOC_VERSION, data: doc, sum: checksum(doc) }));
    } catch (e) {}
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

  window.CBSession = {
    getSetting: getSetting, setSetting: setSetting,
    getBest: getBest, submitBest: submitBest,
    getJourney: getJourney, recordJourney: recordJourney, totalStars: totalStars,
    getDaily: getDaily, recordDaily: recordDaily, dailyCount: dailyCount,
    isTutorialDone: isTutorialDone, markTutorialDone: markTutorialDone,
    hasAchievement: hasAchievement, unlockAchievement: unlockAchievement,
    addTotals: addTotals, getTotals: getTotals,
    saveReplay: saveReplay, getReplay: getReplay
  };
})();
