/* Core Breaker — versioned content: themes, journey, challenges, practice
 * presets, daily ruleset generator, tutorial lessons, achievements.
 * Shared browser (window.CBContent) / Node. Content is data-only; all
 * randomness enters through the config seed.
 *
 * Units (see rules.js): rotSpeed = milli-segments/tick, fallSpeed =
 * milli-layers/tick, both at a fixed 60 Hz tick. armorPct/gapPct are
 * per-segment generation weights for the seeded rules stream.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CBRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- themes (cosmetic only: materials, light, ambience) ----------
  var THEMES = [
    { id: 'void',    name: 'Abyssal Violet', unlockStars: 0,
      palette: { bg: 0x141126, shaft: 0x2a2350, shaftEdge: 0x4a3f8f, safe: 0x63d0e8, safeHC: 0x22b8cf,
                 armor: 0x9c4a5a, armorHC: 0xe03131, core: 0xffd166, light: 0xb0a8ff, accent: 0x9be8ff,
                 striker: 0xd8f4ff, fog: 0x141126 } },
    { id: 'glacial', name: 'Glacial Deep',   unlockStars: 10,
      palette: { bg: 0x0e1c26, shaft: 0x1c3442, shaftEdge: 0x35607a, safe: 0x7fe0d4, safeHC: 0x2ec4b6,
                 armor: 0xb0643c, armorHC: 0xef6c00, core: 0xffe08a, light: 0xbfe8ff, accent: 0x8fd6ff,
                 striker: 0xeafcff, fog: 0x0e1c26 } },
    { id: 'ember',   name: 'Ember Reactor',  unlockStars: 25,
      palette: { bg: 0x221016, shaft: 0x3d1c22, shaftEdge: 0x6b3038, safe: 0xffb066, safeHC: 0xff922b,
                 armor: 0x5a6a7a, armorHC: 0x868e96, core: 0xffe066, light: 0xffc98a, accent: 0xff8a5c,
                 striker: 0xfff0dd, fog: 0x221016 } },
    { id: 'verdant', name: 'Verdant Core',   unlockStars: 45,
      palette: { bg: 0x101f16, shaft: 0x1e3a28, shaftEdge: 0x376048, safe: 0x9fe080, safeHC: 0x69db7c,
                 armor: 0x8a5a6e, armorHC: 0xd6336c, core: 0xfff3a0, light: 0xd8ffb0, accent: 0xb0ff9f,
                 striker: 0xf0ffe0, fog: 0x101f16 } },
    { id: 'solar',   name: 'Solar Forge',    unlockStars: 70,
      palette: { bg: 0x241c10, shaft: 0x453620, shaftEdge: 0x77603a, safe: 0xffd98a, safeHC: 0xfcc419,
                 armor: 0x6a5a8a, armorHC: 0x9775fa, core: 0xffffff, light: 0xfff2dd, accent: 0xffd166,
                 striker: 0xfffbe8, fog: 0x241c10 } }
  ];

  // ---------- journey ----------
  // Compact authored rows:
  // [id, name, seed, layers, sectors, armorPct, gapPct, rotSpeed, fallSpeed,
  //  chargeMax, timeLimitSec, parTimeSec, parMult, themeIdx, intro]
  var J = [
    ['j01','First Descent',   101, 6, 6, 0,    0,    0, 30, 0,  0, 16, 3, 0,'Hold anywhere (or hold Space) to smash down to the core.'],
    ['j02','Crystal Veins',   102, 7, 6, 0,    0,    6, 30, 0,  0, 20, 3, 0,'The shaft rotates now. Safe crystal breaks under the striker.'],
    ['j03','First Armor',     103, 7, 6, 0.14, 0,    6, 32, 5,  0, 24, 3, 0,'Dark spiked segments are armored — release before you land on one, wait, then hold again.'],
    ['j04','Open Seams',      104, 8, 6, 0.12, 0.15, 6, 32, 5,  0, 26, 3, 0,'Missing segments are gaps: you fall straight through and keep your streak.'],
    ['j05','Charge Up',       105, 8, 6, 0.18, 0.10, 7, 34, 4,  0, 26, 4, 0,'Every safe break builds charge. A full charge lets you smash one armored segment.'],
    ['j06','Steady Rotation', 106, 9, 6, 0.16, 0.12, 8, 34, 5,  0, 28, 4, 0,''],
    ['j07','Quick Drop',      107, 9, 6, 0.16, 0.12, 8, 38, 5,  0, 26, 4, 0,'The striker falls faster — momentum makes it faster still.'],
    ['j08','Broken Ring',     108, 10, 6, 0.20, 0.18, 8, 38, 5, 0, 28, 4, 0,''],
    ['j09','Deep Plates',     109, 10, 7, 0.24, 0.10, 9, 40, 5, 0, 28, 4, 0,''],
    ['j10','First Mastery',   110, 12, 7, 0.26, 0.14, 9, 42, 5, 0, 30, 5, 1,'MASTERY: everything so far — armor, gaps, charge — at speed.'],
    ['j11','Twin Seams',      111, 12, 7, 0.22, 0.20, 10, 42, 5, 0, 30, 5, 1,''],
    ['j12','Heavy Lattice',   112, 13, 7, 0.28, 0.10, 10, 44, 5, 0, 32, 5, 1,''],
    ['j13','Swift Current',   113, 13, 7, 0.24, 0.14, 11, 46, 5, 0, 30, 5, 1,''],
    ['j14','Narrow Windows',  114, 14, 7, 0.30, 0.08, 11, 46, 4, 0, 34, 5, 1,'A smaller charge cell: only 4 pips. Spend it wisely.'],
    ['j15','Reactor Clock',   115, 14, 7, 0.24, 0.14, 10, 46, 5, 60, 40, 5, 2,'New: a containment timer. Reach the core before it vents.'],
    ['j16','Cold Shaft',      116, 15, 8, 0.26, 0.14, 10, 46, 5, 0, 38, 5, 2,''],
    ['j17','Plated Bands',    117, 15, 8, 0.32, 0.10, 11, 48, 6, 0, 38, 6, 2,''],
    ['j18','Freefall Lines',  118, 16, 8, 0.24, 0.22, 12, 48, 5, 0, 38, 6, 2,''],
    ['j19','Surge Pressure',  119, 16, 8, 0.30, 0.12, 12, 50, 5, 0, 36, 6, 2,''],
    ['j20','Second Mastery',  120, 18, 8, 0.30, 0.16, 12, 50, 5, 90, 42, 6, 2,'MASTERY: a long shaft and a ticking clock.'],
    ['j21','Dark Glass',      121, 18, 8, 0.34, 0.14, 12, 50, 5, 0, 42, 6, 3,''],
    ['j22','Rapid Cycle',     122, 18, 8, 0.28, 0.16, 14, 50, 5, 0, 40, 6, 3,''],
    ['j23','Thin Ice',        123, 18, 8, 0.30, 0.24, 13, 52, 4, 0, 40, 6, 3,''],
    ['j24','Dense Coreward',  124, 20, 9, 0.34, 0.12, 13, 52, 5, 0, 44, 6, 3,''],
    ['j25','Vent Sequence',   125, 20, 9, 0.30, 0.16, 13, 52, 5, 80, 46, 6, 3,''],
    ['j26','Armor Weave',     126, 20, 9, 0.36, 0.10, 14, 52, 6, 0, 46, 6, 3,''],
    ['j27','Shattered Path',  127, 22, 9, 0.30, 0.22, 14, 54, 5, 0, 46, 6, 3,''],
    ['j28','Overcharge Lane', 128, 22, 9, 0.38, 0.10, 13, 54, 6, 0, 48, 6, 3,''],
    ['j29','Pressure Spiral', 129, 22, 9, 0.32, 0.16, 15, 54, 5, 0, 46, 7, 3,''],
    ['j30','Third Mastery',   130, 24, 9, 0.34, 0.16, 14, 56, 5, 95, 48, 7, 4,'MASTERY: fast rotation, long fall, hard timer.'],
    ['j31','Deep Nine',       131, 24, 10, 0.34, 0.14, 14, 56, 5, 0, 50, 7, 4,''],
    ['j32','Knife Edge',      132, 24, 10, 0.38, 0.10, 15, 56, 4, 0, 52, 7, 4,''],
    ['j33','Golden Hour',     133, 24, 10, 0.32, 0.18, 15, 58, 5, 0, 48, 7, 4,''],
    ['j34','Seam Stress',     134, 26, 10, 0.36, 0.14, 15, 58, 5, 0, 52, 7, 4,''],
    ['j35','Vent Rush',       135, 26, 10, 0.34, 0.16, 15, 58, 5, 85, 52, 7, 4,''],
    ['j36','Heavy Water',     136, 26, 10, 0.38, 0.12, 16, 58, 6, 0, 54, 7, 4,''],
    ['j37','Shard Storm',     137, 28, 10, 0.36, 0.20, 16, 60, 5, 0, 54, 7, 4,''],
    ['j38','Last Lattice',    138, 28, 10, 0.40, 0.12, 16, 60, 6, 0, 56, 7, 4,''],
    ['j39','Event Horizon',   139, 30, 10, 0.38, 0.16, 17, 60, 5, 0, 56, 8, 4,''],
    ['j40','The Core',        140, 32, 10, 0.40, 0.16, 17, 62, 6, 110, 60, 8, 0,'MASTERY: the definitive descent. Break the core.']
  ];

  function expandLevel(row, idx) {
    return {
      id: row[0], version: CONTENT_VERSION, kind: 'journey', index: idx,
      name: row[1], seed: row[2],
      layers: row[3], sectors: row[4],
      armorPct: row[5], gapPct: row[6],
      rotSpeed: row[7], fallSpeed: row[8], chargeMax: row[9],
      timeLimitSec: row[10] || 0,
      par: { timeSec: row[11], mult: row[12] },
      mechanics: { undo: true, hint: true },
      endless: false,
      theme: THEMES[row[13]].id,
      intro: row[14] || '',
      mastery: /MASTERY/.test(row[14] || '')
    };
  }

  var JOURNEY = J.map(expandLevel);

  // ---------- challenges ----------
  var CHALLENGES = [
    { id: 'c1', name: 'Blitz Shaft', seed: 501, kind: 'challenge',
      layers: 14, sectors: 7, armorPct: 0.20, gapPct: 0.12, rotSpeed: 12, fallSpeed: 50,
      chargeMax: 5, timeLimitSec: 42, par: { timeSec: 32, mult: 6 },
      mechanics: { undo: false, hint: true }, endless: false, theme: 'ember',
      intro: 'Containment vents in 42 seconds. No undo — commit.' },
    { id: 'c2', name: 'Plated Descent', seed: 502, kind: 'challenge',
      layers: 18, sectors: 8, armorPct: 0.46, gapPct: 0.06, rotSpeed: 10, fallSpeed: 42,
      chargeMax: 6, timeLimitSec: 0, par: { timeSec: 55, mult: 5 },
      mechanics: { undo: false, hint: true }, endless: false, theme: 'void',
      intro: 'Nearly half the shaft is armored. Your charge cell is your lifeline.' },
    { id: 'c3', name: 'Raw Crystal', seed: 503, kind: 'challenge',
      layers: 16, sectors: 8, armorPct: 0.30, gapPct: 0.14, rotSpeed: 12, fallSpeed: 46,
      chargeMax: 0, timeLimitSec: 0, par: { timeSec: 40, mult: 6 },
      mechanics: { undo: false, hint: true }, endless: false, theme: 'glacial',
      intro: 'No charge cell fitted. Every armored segment is fatal — pure timing.' },
    { id: 'c4', name: 'Narrow Bands', seed: 504, kind: 'challenge',
      layers: 16, sectors: 5, armorPct: 0.32, gapPct: 0.10, rotSpeed: 18, fallSpeed: 48,
      chargeMax: 5, timeLimitSec: 0, par: { timeSec: 42, mult: 6 },
      mechanics: { undo: false, hint: true }, endless: false, theme: 'verdant',
      intro: 'Five wide segments spinning fast. Read the band early.' },
    { id: 'c5', name: 'The Long Core', seed: 505, kind: 'challenge',
      layers: 40, sectors: 8, armorPct: 0.28, gapPct: 0.16, rotSpeed: 14, fallSpeed: 50,
      chargeMax: 5, timeLimitSec: 0, par: { timeSec: 90, mult: 7 },
      mechanics: { undo: true, hint: true }, endless: false, theme: 'solar',
      intro: 'Forty layers down. Pace yourself; momentum is everything.' },
    { id: 'c6', name: 'Glass Gauntlet', seed: 506, kind: 'challenge',
      layers: 20, sectors: 9, armorPct: 0.38, gapPct: 0.30, rotSpeed: 16, fallSpeed: 52,
      chargeMax: 4, timeLimitSec: 60, par: { timeSec: 46, mult: 7 },
      mechanics: { undo: false, hint: false }, endless: false, theme: 'ember',
      intro: 'Thin safe paths, big gaps, hard timer, no assists.' }
  ].map(function (c) { c.version = CONTENT_VERSION; return c; });

  // ---------- practice presets ----------
  var PRACTICE = [
    { id: 'calm', name: 'Calm',
      layers: 8, sectors: 6, armorPct: 0.12, gapPct: 0.10, rotSpeed: 6, fallSpeed: 30,
      chargeMax: 5, timeLimitSec: 0, par: { timeSec: 30, mult: 4 },
      mechanics: { undo: true, hint: true }, endless: false },
    { id: 'standard', name: 'Standard',
      layers: 14, sectors: 7, armorPct: 0.22, gapPct: 0.12, rotSpeed: 10, fallSpeed: 40,
      chargeMax: 5, timeLimitSec: 0, par: { timeSec: 38, mult: 5 },
      mechanics: { undo: true, hint: true }, endless: false },
    { id: 'intense', name: 'Intense',
      layers: 22, sectors: 9, armorPct: 0.34, gapPct: 0.15, rotSpeed: 15, fallSpeed: 52,
      chargeMax: 5, timeLimitSec: 0, par: { timeSec: 50, mult: 7 },
      mechanics: { undo: true, hint: true }, endless: false }
  ].map(function (p) { p.version = CONTENT_VERSION; p.kind = 'practice'; return p; });

  // ---------- score chase ruleset (endless) ----------
  var SCORE_CHASE = {
    id: 'score-std', version: CONTENT_VERSION, kind: 'score', name: 'Endless Shaft',
    layers: 12, sectors: 8, armorPct: 0.18, gapPct: 0.12, rotSpeed: 10, fallSpeed: 42,
    chargeMax: 5, timeLimitSec: 0, par: null,
    mechanics: { undo: false, hint: false }, endless: true, theme: 'void',
    intro: 'The shaft never bottoms out — armor thickens with depth. Play until you crash.'
  };

  // ---------- daily ----------
  // One immutable ruleset per UTC day, derived purely from the date string.
  function dailyConfig(dateStr) {
    var seed = RNG.hashString('corebreaker-daily-v' + CONTENT_VERSION + '-' + dateStr);
    var day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
    var rot = ((day % 7) + 7) % 7;
    var layers = 12 + rot;
    var fallSpeed = 36 + rot * 2;
    var par = Math.round(layers * (1000 / fallSpeed) / 60 * 1.9 + 8);
    return {
      id: 'daily-' + dateStr, version: CONTENT_VERSION, kind: 'daily',
      name: 'Daily ' + dateStr, seed: seed, date: dateStr,
      layers: layers, sectors: 7 + (rot % 3),
      armorPct: Math.round((0.18 + rot * 0.02) * 100) / 100,
      gapPct: Math.round((0.10 + (rot % 2) * 0.05) * 100) / 100,
      rotSpeed: 8 + rot, fallSpeed: fallSpeed, chargeMax: 5,
      timeLimitSec: rot === 6 ? par + 20 : 0,
      par: { timeSec: par, mult: 4 + (rot % 4) },
      mechanics: { undo: false, hint: true }, endless: false,
      theme: THEMES[rot % THEMES.length].id,
      intro: 'One shared seed for everyone, today only.'
    };
  }

  function utcDateString(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ---------- tutorial (Learn) ----------
  var S = { SAFE: 0, ARMOR: 1, GAP: 2 };
  function row(seg, n) { var a = []; for (var i = 0; i < n; i++) a.push(seg); return a; }

  function tutorialLessons() {
    return [
      { id: 't1', title: 'Hold to smash',
        text: 'Press and hold anywhere (or hold Space) to dive. The striker smashes through bright crystal. Break all three layers to reach the core.',
        goal: { event: 'win', count: 1 },
        cfg: { id: 't1', version: CONTENT_VERSION, kind: 'tutorial', seed: 9001,
          layers: 3, sectors: 4, armorPct: 0, gapPct: 0, rotSpeed: 0, fallSpeed: 30,
          chargeMax: 0, timeLimitSec: 0, par: null, mechanics: { undo: false, hint: false }, endless: false,
          forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4)] } },
      { id: 't2', title: 'Release for armor',
        text: 'Dark spiked segments are armored — landing on one ends the dive. Release to hover, let a safe segment rotate under the striker, then hold again. Releasing slowly costs your descent progress.',
        goal: { event: 'win', count: 1 },
        cfg: { id: 't2', version: CONTENT_VERSION, kind: 'tutorial', seed: 9002,
          layers: 3, sectors: 4, armorPct: 0, gapPct: 0, rotSpeed: 10, fallSpeed: 30,
          chargeMax: 0, timeLimitSec: 0, par: null, mechanics: { undo: false, hint: true }, endless: false,
          forceLayers: [row(S.SAFE, 4), [S.ARMOR, S.SAFE, S.SAFE, S.SAFE], row(S.SAFE, 4)] } },
      { id: 't3', title: 'Gaps keep your streak',
        text: 'A missing segment is a gap: you fall straight through without breaking anything, and your momentum streak survives. Hold through the hollow layer ahead.',
        goal: { event: 'pass', count: 1 },
        cfg: { id: 't3', version: CONTENT_VERSION, kind: 'tutorial', seed: 9003,
          layers: 3, sectors: 4, armorPct: 0, gapPct: 0, rotSpeed: 0, fallSpeed: 32,
          chargeMax: 0, timeLimitSec: 0, par: null, mechanics: { undo: false, hint: false }, endless: false,
          forceLayers: [row(S.SAFE, 4), row(S.GAP, 4), row(S.SAFE, 4)] } },
      { id: 't4', title: 'Charge and overdrive',
        text: 'Every safe break charges the striker. At full charge, one armored segment shatters too — that is an overdrive. Hold all the way down and smash the armored cap.',
        goal: { event: 'overdrive', count: 1 },
        cfg: { id: 't4', version: CONTENT_VERSION, kind: 'tutorial', seed: 9004,
          layers: 3, sectors: 4, armorPct: 0, gapPct: 0, rotSpeed: 0, fallSpeed: 32,
          chargeMax: 2, timeLimitSec: 0, par: null, mechanics: { undo: false, hint: false }, endless: false,
          forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), [S.ARMOR, S.ARMOR, S.ARMOR, S.SAFE]] } },
      { id: 't5', title: 'Second chances',
        text: 'In relaxed modes every release banks a retry point. Hold to break a layer, release, then press U (or the Undo button) to rewind to your last release.',
        goal: { event: 'undo', count: 1 },
        cfg: { id: 't5', version: CONTENT_VERSION, kind: 'tutorial', seed: 9005,
          layers: 4, sectors: 4, armorPct: 0, gapPct: 0, rotSpeed: 0, fallSpeed: 35,
          chargeMax: 0, timeLimitSec: 0, par: null, mechanics: { undo: true, hint: true }, endless: false,
          forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4)] } }
    ];
  }

  // ---------- achievements (stable lowercase keys, idempotent) ----------
  var ACHIEVEMENTS = [
    { key: 'first-break',  name: 'First Fracture',   desc: 'Break your first crystal segment.' },
    { key: 'first-core',   name: 'Core Reached',     desc: 'Reach the core and win a stage.' },
    { key: 'mult-8',       name: 'Terminal Velocity', desc: 'Reach ×8 momentum in one streak.' },
    { key: 'overdrive',    name: 'Overdrive',        desc: 'Smash an armored segment at full charge.' },
    { key: 'journey-half', name: 'Halfway Down',     desc: 'Finish 20 journey stages.' },
    { key: 'journey-done', name: 'Core Breaker',     desc: 'Finish all 40 journey stages.' },
    { key: 'daily-7',      name: 'Daily Diver',      desc: 'Finish 7 daily challenges.' },
    { key: 'breaks-500',   name: 'Shatterstorm',     desc: 'Break 500 segments across all play.' },
    { key: 'score-3000',   name: 'Reactor Hero',     desc: 'Score 3000+ in a single round.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE: PRACTICE,
    SCORE_CHASE: SCORE_CHASE,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dailyConfig: dailyConfig,
    utcDateString: utcDateString,
    tutorialLessons: tutorialLessons
  };
});
