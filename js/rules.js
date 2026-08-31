/* Core Breaker — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.CBRules) and Node.
 *
 * Core loop: a crystal striker descends a rotating reactor shaft. HOLD to
 * smash down through safe segments, RELEASE before armored ones, build
 * momentum (score multiplier) and charge (armorshield). Fixed 60 Hz tick
 * simulation; all geometry is integer fixed-point (1 layer = 1000 fall
 * units, 1 segment = 1000 angle units), so replays are bit-exact.
 *
 * Commands: {type:'press'|'release'|'wait'|'resign', atTick?} — press/
 * release toggle the hold input at a quantized tick; 'wait' advances the
 * simulation without changing input (not written to replay logs).
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CBRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;
  var TICK_MS_NUM = 50, TICK_MS_DEN = 3; // 60 Hz: elapsedMs = floor(tick * 50 / 3)
  var LAYER_UNITS = 1000;   // fall units per layer
  var SECTOR_UNITS = 1000;  // angle units per segment

  var SEG = { SAFE: 0, ARMOR: 1, GAP: 2 };

  var BREAK_BASE = 25;        // points per safe segment × momentum
  var PASS_PT = 10;           // points per gap passed
  var OVERDRIVE_PT = 250;     // points per armored segment smashed at full charge
  var MULT_WIN_BONUS = 20;    // win bonus per best momentum reached
  var CHARGE_WIN_BONUS = 15;  // win bonus per charge pip banked
  var TIME_PT_PER_SEC = 5;    // win bonus per second under par
  var MAX_MULT = 8;
  var SPEED_MULT_BONUS = 2;   // extra fall speed (milli-layer/tick) per momentum
  var ENDLESS_LOOKAHEAD = 8;  // layers kept generated ahead of the striker
  var ENDLESS_ARMOR_RAMP = 0.004; // extra armor probability per layer of depth
  var ENDLESS_ARMOR_CAP = 0.55;
  var MAX_ADVANCE_TICKS = 60 * 60 * 10; // one command may advance ≤ 10 minutes

  var TERMINAL = {
    CORE: 'core-reached',
    ARMOR: 'armor-impact',
    TIME: 'time-up',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    ALREADY: 'already-holding',
    NOT_HOLDING: 'not-holding',
    STALE: 'stale-tick',
    TOO_FAR: 'tick-too-far',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command'
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Stable stringify: object keys sorted recursively → canonical hashing.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var copy = clone(state);
    delete copy.events;
    return RNG.hashString(stableStringify(copy));
  }

  function elapsedMsOf(tick) { return Math.floor(tick * TICK_MS_NUM / TICK_MS_DEN); }

  function fallSpeedOf(state) {
    return state.cfg.fallSpeed + state.mult * SPEED_MULT_BONUS;
  }

  // ---------- layer generation (seeded, rules stream only) ----------

  function generateLayer(rng, sectors, armorPct, gapPct) {
    var layer = [], safe = 0;
    for (var s = 0; s < sectors; s++) {
      var r = rng.next();
      var seg = r < armorPct ? SEG.ARMOR : (r < armorPct + gapPct ? SEG.GAP : SEG.SAFE);
      if (seg !== SEG.ARMOR) safe++;
      layer.push(seg);
    }
    if (safe === 0) layer[0] = SEG.SAFE; // every layer is passable: no soft locks
    return layer;
  }

  function genArmorPct(cfg, depth) {
    if (!cfg.endless) return cfg.armorPct;
    return Math.min(ENDLESS_ARMOR_CAP, cfg.armorPct + depth * ENDLESS_ARMOR_RAMP);
  }

  function ensureLayers(state, rng) {
    // Non-endless configs generate everything up front; endless configs
    // extend the shaft deterministically as the striker descends.
    var target = state.cfg.endless
      ? state.depth + ENDLESS_LOOKAHEAD
      : state.cfg.layers;
    while (state.layers.length < target) {
      state.layers.push(generateLayer(
        rng, state.cfg.sectors,
        genArmorPct(state.cfg, state.layers.length), state.cfg.gapPct));
    }
  }

  // ---------- game creation ----------

  // cfg: { id, version, kind, seed, layers, sectors, armorPct, gapPct,
  //        rotSpeed, fallSpeed, chargeMax, timeLimitSec,
  //        par:{timeSec,mult} | null, mechanics:{undo,hint}, endless,
  //        forceLayers?: [[seg…]…], startAngle?: int, theme?, name?, intro? }
  function createGame(cfg) {
    if (!cfg || !Number.isInteger(cfg.layers) || cfg.layers < 1) throw new Error('bad layers');
    if (!Number.isInteger(cfg.sectors) || cfg.sectors < 3) throw new Error('bad sectors');
    if (!(cfg.fallSpeed > 0)) throw new Error('bad fallSpeed');
    if (!(cfg.rotSpeed >= 0)) throw new Error('bad rotSpeed');
    if (cfg.forceLayers) {
      if (cfg.forceLayers.length !== cfg.layers) throw new Error('forceLayers length mismatch');
      for (var i = 0; i < cfg.forceLayers.length; i++) {
        if (cfg.forceLayers[i].length !== cfg.sectors) throw new Error('forceLayers width mismatch');
        var ok = false;
        for (var j = 0; j < cfg.sectors; j++) {
          var sg = cfg.forceLayers[i][j];
          if (sg !== SEG.SAFE && sg !== SEG.ARMOR && sg !== SEG.GAP) throw new Error('bad segment');
          if (sg !== SEG.ARMOR) ok = true;
        }
        if (!ok) throw new Error('forceLayers layer fully armored');
      }
    }
    var seed = cfg.seed >>> 0;
    var rng = RNG.derive(seed, RNG.STREAM_RULES);
    var state = {
      v: STATE_VERSION,
      cfg: clone(cfg),
      seed: seed,
      rngState: 0,
      tick: 0,
      angle: Number.isInteger(cfg.startAngle) ? (cfg.startAngle >>> 0) : 0,
      holding: false,
      depth: 0,
      fall: 0,
      mult: 0,
      bestMult: 0,
      charge: 0,
      layers: cfg.forceLayers ? clone(cfg.forceLayers) : [],
      score: { breaks: 0, breakPoints: 0, passes: 0, passPoints: 0,
               overdrives: 0, overdrivePoints: 0,
               timeBonus: 0, multBonus: 0, chargeBonus: 0, total: 0 },
      stats: { presses: 0, releases: 0, holdTicks: 0 },
      elapsedMs: 0,
      terminal: null,
      undoSnap: null, // snapshot taken at the most recent release (relaxed modes)
      events: []
    };
    if (!cfg.forceLayers) ensureLayers(state, rng);
    state.rngState = rng.state;
    return state;
  }

  // ---------- legality ----------

  function legalActions(state) {
    var out = [];
    if (!state.terminal) {
      out.push('press');
      out.push('release');
      if (state.cfg.mechanics.undo && state.undoSnap) out.push('undo');
      out.push('resign');
    }
    return out;
  }

  // Predicted next landing assuming current input continues (or, when not
  // holding, that press happens this tick). Pure: reads state only.
  function peek(state) {
    if (state.terminal) return null;
    var layer = state.layers[state.depth];
    if (!layer) return null;
    var ticksToLand = Math.ceil((LAYER_UNITS - state.fall) / fallSpeedOf(state));
    var span = state.cfg.sectors * SECTOR_UNITS;
    var angleAt = (state.angle + state.cfg.rotSpeed * ticksToLand) % span;
    var sector = Math.floor(angleAt / SECTOR_UNITS) % state.cfg.sectors;
    var segment = layer[sector];
    var chargeReady = state.cfg.chargeMax > 0 && state.charge >= state.cfg.chargeMax;
    var willCrash = segment === SEG.ARMOR && !chargeReady;
    return {
      ticksToLand: ticksToLand,
      ms: Math.ceil(ticksToLand * TICK_MS_NUM / TICK_MS_DEN),
      sector: sector,
      segment: segment,
      willCrash: willCrash,
      chargeReady: chargeReady
    };
  }

  // Hints call the same prediction/legality surface as play.
  function hint(state) {
    var p = peek(state);
    if (!p) return null;
    if (p.willCrash) {
      return state.holding
        ? { action: 'release', why: 'armor-ahead', peek: p }
        : { action: 'wait', why: 'armor-ahead-wait', peek: p };
    }
    if (p.segment === SEG.ARMOR) return { action: state.holding ? 'hold' : 'press', why: 'overdrive-ready', peek: p };
    if (p.segment === SEG.GAP) return { action: state.holding ? 'hold' : 'press', why: 'gap-ahead', peek: p };
    return { action: state.holding ? 'hold' : 'press', why: 'safe-ahead', peek: p };
  }

  // ---------- resolution ----------

  function land(s, rng) {
    s.fall -= LAYER_UNITS;
    var layer = s.layers[s.depth];
    var sector = Math.floor(s.angle / SECTOR_UNITS) % s.cfg.sectors;
    var seg = layer[sector];
    if (seg === SEG.GAP) {
      s.score.passes++;
      s.score.passPoints += PASS_PT;
      s.events.push({ type: 'pass', layer: s.depth, sector: sector, points: PASS_PT });
      s.depth++;
      return;
    }
    if (seg === SEG.ARMOR) {
      var ready = s.cfg.chargeMax > 0 && s.charge >= s.cfg.chargeMax;
      if (!ready) {
        s.terminal = { reason: TERMINAL.ARMOR, won: false };
        s.events.push({ type: 'crash', layer: s.depth, sector: sector });
        s.events.push({ type: 'lose', reason: TERMINAL.ARMOR });
        return;
      }
      // full charge: overdrive smash
      s.charge = 0;
      s.score.overdrives++;
      s.score.overdrivePoints += OVERDRIVE_PT;
      s.events.push({ type: 'overdrive', layer: s.depth, sector: sector, points: OVERDRIVE_PT });
    } else {
      s.mult = Math.min(MAX_MULT, s.mult + 1);
      if (s.mult > s.bestMult) s.bestMult = s.mult;
      var pts = BREAK_BASE * s.mult;
      s.score.breaks++;
      s.score.breakPoints += pts;
      if (s.cfg.chargeMax > 0) s.charge = Math.min(s.cfg.chargeMax, s.charge + 1);
      s.events.push({ type: 'break', layer: s.depth, sector: sector, points: pts, mult: s.mult, charge: s.charge });
    }
    s.depth++;
  }

  function checkGoal(s, rng) {
    if (s.terminal) return;
    if (s.cfg.endless) { ensureLayers(s, rng); return; }
    if (s.depth >= s.layers.length) {
      s.terminal = { reason: TERMINAL.CORE, won: true };
      s.events.push({ type: 'win', reason: TERMINAL.CORE });
    }
  }

  // Advance the tick loop; mutates the already-cloned state s.
  function simulate(s, toTick, rng) {
    var span = s.cfg.sectors * SECTOR_UNITS;
    var limitTick = s.cfg.timeLimitSec ? s.cfg.timeLimitSec * 60 : 0;
    // While released the striker climbs back: partial descent decays, so
    // dodging armor costs progress. This is the timing pressure.
    var recover = Math.max(1, s.cfg.fallSpeed >> 1);
    while (s.tick < toTick && !s.terminal) {
      s.tick++;
      s.angle = (s.angle + s.cfg.rotSpeed) % span;
      if (s.holding) {
        s.stats.holdTicks++;
        s.fall += fallSpeedOf(s);
        while (s.fall >= LAYER_UNITS && !s.terminal) {
          land(s, rng);
          checkGoal(s, rng);
        }
      } else if (s.fall > 0) {
        s.fall = Math.max(0, s.fall - recover);
      }
      if (!s.terminal && limitTick && s.tick >= limitTick) {
        s.terminal = { reason: TERMINAL.TIME, won: false };
        s.events.push({ type: 'lose', reason: TERMINAL.TIME });
      }
    }
    s.elapsedMs = elapsedMsOf(s.tick);
  }

  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
    }
    var type = cmd.type;
    if (type !== 'press' && type !== 'release' && type !== 'wait' && type !== 'resign' && type !== 'undo') {
      return { ok: false, reason: INVALID.BAD_CMD, state: state, events: [] };
    }
    if (state.terminal) return { ok: false, reason: INVALID.ENDED, state: state, events: [] };
    var atTick = state.tick;
    if (cmd.atTick != null) {
      if (!Number.isInteger(cmd.atTick) || cmd.atTick < 0) {
        return { ok: false, reason: INVALID.BAD_SHAPE, state: state, events: [] };
      }
      if (cmd.atTick < state.tick) return { ok: false, reason: INVALID.STALE, state: state, events: [] };
      if (cmd.atTick - state.tick > MAX_ADVANCE_TICKS) {
        return { ok: false, reason: INVALID.TOO_FAR, state: state, events: [] };
      }
      atTick = cmd.atTick;
    }
    if (type === 'press' && state.holding) return { ok: false, reason: INVALID.ALREADY, state: state, events: [] };
    if (type === 'release' && !state.holding) return { ok: false, reason: INVALID.NOT_HOLDING, state: state, events: [] };

    var s = clone(state);
    s.events = [];
    var rng = RNG.create(s.rngState);
    simulate(s, atTick, rng);
    if (s.terminal && type !== 'wait') {
      // Time advanced honestly to the terminal tick; the input itself lands
      // after the round ended and is rejected (never written to the log).
      s.rngState = rng.state;
      finalizeScore(s);
      return { ok: false, reason: INVALID.ENDED, state: s, events: s.events };
    }

    if (type === 'press') {
      s.holding = true;
      s.stats.presses++;
      s.events.push({ type: 'press' });
    } else if (type === 'release') {
      s.holding = false;
      s.mult = 0; // momentum is a controlled streak: releasing resets it
      s.stats.releases++;
      if (s.cfg.mechanics.undo) {
        // Bank a rewind point: the exact state at this release.
        s.undoSnap = {
          tick: s.tick, angle: s.angle, depth: s.depth, fall: s.fall,
          mult: s.mult, bestMult: s.bestMult, charge: s.charge,
          score: clone(s.score), stats: clone(s.stats), rngState: rng.state
        };
      }
      s.events.push({ type: 'release' });
    } else if (type === 'resign') {
      s.terminal = { reason: TERMINAL.RESIGN, won: false };
      s.events.push({ type: 'lose', reason: TERMINAL.RESIGN });
    } else if (type === 'undo') {
      if (!s.cfg.mechanics.undo || !s.undoSnap) {
        return { ok: false, reason: INVALID.BAD_CMD, state: state, events: [] };
      }
      // Rewind to the most recent release; score/stats restore with it.
      var u = s.undoSnap;
      s.tick = u.tick; s.angle = u.angle; s.depth = u.depth; s.fall = u.fall;
      s.mult = u.mult; s.bestMult = u.bestMult; s.charge = u.charge;
      s.score = clone(u.score); s.stats = clone(u.stats);
      s.holding = false;
      s.undoSnap = null; // one rewind per banked release
      s.elapsedMs = elapsedMsOf(s.tick);
      s.events.push({ type: 'undo' });
      s.rngState = u.rngState;
      return { ok: true, state: s, events: s.events };
    }

    s.rngState = rng.state;
    if (s.terminal) finalizeScore(s);
    return { ok: true, state: s, events: s.events };
  }

  function finalizeScore(s) {
    if (s.terminal && s.terminal.won) {
      if (s.cfg.par && s.cfg.par.timeSec) {
        var leftMs = s.cfg.par.timeSec * 1000 - s.elapsedMs;
        if (leftMs > 0) s.score.timeBonus = Math.floor(leftMs / 1000) * TIME_PT_PER_SEC;
      }
      s.score.multBonus = s.bestMult * MULT_WIN_BONUS;
      s.score.chargeBonus = s.charge * CHARGE_WIN_BONUS;
    }
    s.score.total = s.score.breakPoints + s.score.passPoints + s.score.overdrivePoints +
      s.score.timeBonus + s.score.multBonus + s.score.chargeBonus;
  }

  // ---------- validation (network / replay boundary) ----------

  function validateCommandShape(cmd, maxLen) {
    if (!cmd || typeof cmd !== 'object') return INVALID.BAD_SHAPE;
    if (JSON.stringify(cmd).length > (maxLen || 512)) return INVALID.BAD_SHAPE;
    if (cmd.type !== 'press' && cmd.type !== 'release' && cmd.type !== 'wait' && cmd.type !== 'resign' && cmd.type !== 'undo')
      return INVALID.BAD_CMD;
    if (cmd.id != null && (typeof cmd.id !== 'string' || cmd.id.length > 64)) return INVALID.BAD_SHAPE;
    if (cmd.atTick != null && (!Number.isInteger(cmd.atTick) || cmd.atTick < 0)) return INVALID.BAD_SHAPE;
    return null;
  }

  // ---------- serialization ----------

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    SEG: SEG,
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    MAX_MULT: MAX_MULT,
    LAYER_UNITS: LAYER_UNITS,
    SECTOR_UNITS: SECTOR_UNITS,
    BREAK_BASE: BREAK_BASE,
    PASS_PT: PASS_PT,
    OVERDRIVE_PT: OVERDRIVE_PT,
    elapsedMsOf: elapsedMsOf,
    fallSpeedOf: fallSpeedOf,
    createGame: createGame,
    applyCommand: applyCommand,
    legalActions: legalActions,
    peek: peek,
    hint: hint,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    validateCommandShape: validateCommandShape
  };
});
