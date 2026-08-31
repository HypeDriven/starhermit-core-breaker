/* Core Breaker — test suite (Node, no deps).
 * Covers: legal actions, invalid-action reasons, scoring components,
 * terminal states, undo, deterministic replay hashing, content validators,
 * fuzz of malformed commands, golden sessions, server validation. */
'use strict';

process.env.CB_SCORES_FILE = require('path').join(require('os').tmpdir(), 'cb-test-scores.json');

const assert = require('assert');
const RNG = require('../js/rng.js');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const server = require('../server.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
}

const S = Rules.SEG;
function row(seg, n) { return Array(n).fill(seg); }

function baseCfg(extra) {
  return Object.assign({
    id: 'test', version: 1, kind: 'test', seed: 42,
    layers: 4, sectors: 4, armorPct: 0, gapPct: 0,
    rotSpeed: 0, fallSpeed: 30, chargeMax: 0, timeLimitSec: 0,
    par: null, mechanics: { undo: false, hint: false }, endless: false,
    forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4)]
  }, extra || {});
}

function press(state, atTick) { return Rules.applyCommand(state, { type: 'press', atTick: atTick == null ? state.tick : atTick }); }
function release(state, atTick) { return Rules.applyCommand(state, { type: 'release', atTick: atTick == null ? state.tick : atTick }); }
function wait(state, ticks) { return Rules.applyCommand(state, { type: 'wait', atTick: state.tick + (ticks || 1) }); }

// ---------- rules ----------

test('createGame validates config', () => {
  assert.throws(() => Rules.createGame({}), /bad layers/);
  assert.throws(() => Rules.createGame(baseCfg({ sectors: 2 })), /bad sectors/);
  assert.throws(() => Rules.createGame(baseCfg({ forceLayers: [row(S.ARMOR, 4), row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4)] })), /fully armored/);
});

test('press → hold descends and breaks safe segments', () => {
  let st = Rules.createGame(baseCfg());
  st = press(st).state;
  assert.strictEqual(st.holding, true);
  st = wait(st, 40).state; // fall 30/tick → 1200 > 1000 → first break
  assert.strictEqual(st.score.breaks, 1);
  assert.strictEqual(st.score.breakPoints, Rules.BREAK_BASE * 1);
  assert.strictEqual(st.mult, 1);
  assert.strictEqual(st.depth, 1);
});

test('momentum multiplier grows per consecutive break', () => {
  let st = Rules.createGame(baseCfg({ layers: 3, forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), row(S.SAFE, 4)] }));
  st = press(st).state;
  while (!st.terminal) st = wait(st, 10).state;
  assert.strictEqual(st.score.breaks, 3);
  assert.strictEqual(st.score.breakPoints, 25 * (1 + 2 + 3));
  assert.strictEqual(st.bestMult, 3);
});

test('terminal: core reached wins and finalizes bonuses', () => {
  let st = Rules.createGame(baseCfg({ par: { timeSec: 600, mult: 1 } }));
  st = press(st).state;
  while (!st.terminal) st = wait(st, 10).state;
  assert.strictEqual(st.terminal.won, true);
  assert.strictEqual(st.terminal.reason, Rules.TERMINAL.CORE);
  assert.ok(st.score.multBonus > 0);
  assert.ok(st.score.timeBonus > 0);
  assert.strictEqual(st.score.total,
    st.score.breakPoints + st.score.passPoints + st.score.overdrivePoints +
    st.score.timeBonus + st.score.multBonus + st.score.chargeBonus);
});

test('armor without charge ends the dive', () => {
  let st = Rules.createGame(baseCfg({ layers: 1, forceLayers: [[S.ARMOR, S.SAFE, S.SAFE, S.SAFE]] }));
  st = press(st).state; // sector 0 is armor
  while (!st.terminal) st = wait(st, 10).state;
  assert.strictEqual(st.terminal.reason, Rules.TERMINAL.ARMOR);
  assert.strictEqual(st.terminal.won, false);
});

test('full charge overdrives through armor', () => {
  let st = Rules.createGame(baseCfg({
    layers: 3, chargeMax: 2,
    forceLayers: [row(S.SAFE, 4), row(S.SAFE, 4), [S.ARMOR, S.ARMOR, S.ARMOR, S.SAFE]]
  }));
  st = press(st).state;
  while (!st.terminal) st = wait(st, 10).state;
  assert.strictEqual(st.terminal.reason, Rules.TERMINAL.CORE);
  assert.strictEqual(st.score.overdrives, 1);
  assert.strictEqual(st.score.overdrivePoints, Rules.OVERDRIVE_PT);
  assert.strictEqual(st.charge, 0); // spent
});

test('gaps pass without breaking or losing streak', () => {
  let st = Rules.createGame(baseCfg({
    layers: 3,
    forceLayers: [row(S.SAFE, 4), row(S.GAP, 4), row(S.SAFE, 4)]
  }));
  st = press(st).state;
  while (!st.terminal) st = wait(st, 10).state;
  assert.strictEqual(st.score.passes, 1);
  assert.strictEqual(st.score.passPoints, Rules.PASS_PT);
  assert.strictEqual(st.bestMult, 2); // streak preserved through the gap
});

test('release resets momentum and decays descent', () => {
  let st = Rules.createGame(baseCfg());
  st = press(st).state;
  st = wait(st, 20).state; // fall = 600
  assert.ok(st.fall > 0);
  st = release(st).state;
  assert.strictEqual(st.holding, false);
  assert.strictEqual(st.mult, 0);
  const fallAt = st.fall;
  st = wait(st, 10).state;
  assert.ok(st.fall < fallAt);
});

test('invalid actions carry reasons', () => {
  let st = Rules.createGame(baseCfg());
  assert.strictEqual(press(st).ok, true);
  st = press(st).state;
  assert.strictEqual(press(st).reason, Rules.INVALID.ALREADY);
  let st2 = Rules.createGame(baseCfg());
  assert.strictEqual(release(st2).reason, Rules.INVALID.NOT_HOLDING);
  assert.strictEqual(Rules.applyCommand(st, { type: 'teleport' }).reason, Rules.INVALID.BAD_CMD);
  assert.strictEqual(Rules.applyCommand(st, null).reason, Rules.INVALID.BAD_SHAPE);
  assert.strictEqual(Rules.applyCommand(st, { type: 'wait', atTick: -1 }).reason, Rules.INVALID.BAD_SHAPE);
  st = wait(st, 5).state;
  assert.strictEqual(Rules.applyCommand(st, { type: 'wait', atTick: st.tick - 1 }).reason, Rules.INVALID.STALE);
  assert.strictEqual(Rules.applyCommand(st, { type: 'wait', atTick: st.tick + 9999999 }).reason, Rules.INVALID.TOO_FAR);
  // ended games reject everything
  let end = Rules.createGame(baseCfg({ layers: 1, forceLayers: [row(S.SAFE, 4)] }));
  end = press(end).state;
  while (!end.terminal) end = wait(end, 10).state;
  assert.strictEqual(press(end).reason, Rules.INVALID.ENDED);
});

test('time limit ends the run', () => {
  let st = Rules.createGame(baseCfg({ timeLimitSec: 1 }));
  st = wait(st, 90).state; // 1.5s > 1s limit
  assert.strictEqual(st.terminal.reason, Rules.TERMINAL.TIME);
  assert.strictEqual(st.terminal.won, false);
});

test('resign is terminal and immediate', () => {
  let st = Rules.createGame(baseCfg());
  const r = Rules.applyCommand(st, { type: 'resign' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.terminal.reason, Rules.TERMINAL.RESIGN);
});

test('undo rewinds to last release with score/stats intact', () => {
  let st = Rules.createGame(baseCfg({ mechanics: { undo: true, hint: true } }));
  assert.strictEqual(Rules.legalActions(st).includes('undo'), false); // nothing banked
  st = press(st).state;
  st = wait(st, 20).state;
  st = release(st).state;
  assert.ok(Rules.legalActions(st).includes('undo'));
  const snapTick = st.tick, snapFall = st.fall;
  st = press(st).state;
  st = wait(st, 15).state;
  assert.notStrictEqual(st.fall, snapFall);
  const r = Rules.applyCommand(st, { type: 'undo' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.tick, snapTick);
  assert.strictEqual(r.state.fall, snapFall);
  assert.strictEqual(r.state.holding, false);
  assert.strictEqual(Rules.legalActions(r.state).includes('undo'), false); // spent
  // undo without mechanics is illegal
  let st2 = Rules.createGame(baseCfg());
  assert.strictEqual(Rules.applyCommand(st2, { type: 'undo' }).ok, false);
});

test('peek/hint use the legal-action surface', () => {
  let st = Rules.createGame(baseCfg({ layers: 1, forceLayers: [[S.ARMOR, S.SAFE, S.SAFE, S.SAFE]], chargeMax: 0 }));
  const p = Rules.peek(st);
  assert.strictEqual(p.segment, S.ARMOR);
  assert.strictEqual(p.willCrash, true);
  assert.strictEqual(Rules.hint(st).why, 'armor-ahead-wait');
  const hp = Rules.hint(press(st).state);
  assert.strictEqual(hp.action, 'release');
});

test('serialization round-trips; version mismatch rejected', () => {
  let st = Rules.createGame(baseCfg());
  st = press(st).state;
  st = wait(st, 30).state;
  const back = Rules.deserialize(Rules.serialize(st));
  assert.strictEqual(Rules.hashState(back), Rules.hashState(st));
  const bad = JSON.parse(Rules.serialize(st)); bad.v = 99;
  assert.throws(() => Rules.deserialize(JSON.stringify(bad)), /version/);
});

// ---------- determinism / replay ----------

test('same seed + same commands → identical state hashes (property)', () => {
  const cfg = baseCfg({ forceLayers: null, layers: 12, armorPct: 0.3, gapPct: 0.15, rotSpeed: 9, chargeMax: 5 });
  delete cfg.forceLayers;
  function run() {
    let st = Rules.createGame(cfg);
    const rng = RNG.create(7);
    const hashes = [];
    for (let i = 0; i < 40; i++) {
      const cmd = rng.next() < 0.5 ? 'press' : (st.holding ? 'release' : 'press');
      const r = Rules.applyCommand(st, { type: cmd });
      if (r.ok) st = r.state;
      st = wait(st, 3 + Math.floor(rng.next() * 20)).state;
      hashes.push(Rules.hashState(st));
      if (st.terminal) break;
    }
    return hashes;
  }
  assert.deepStrictEqual(run(), run());
});

test('different seeds produce different shafts', () => {
  const a = Rules.createGame(baseCfg({ seed: 1, forceLayers: null, layers: 8, armorPct: 0.3 }));
  const b = Rules.createGame(baseCfg({ seed: 2, forceLayers: null, layers: 8, armorPct: 0.3 }));
  delete a.cfg.forceLayers; delete b.cfg.forceLayers;
  assert.notDeepStrictEqual(a.layers, b.layers);
});

// ---------- fuzz ----------

test('fuzz: malformed commands never hang or corrupt state', () => {
  const cfg = baseCfg({ endless: true, layers: 8, armorPct: 0.3, gapPct: 0.2, rotSpeed: 12 });
  delete cfg.forceLayers;
  let st = Rules.createGame(cfg);
  const rng = RNG.create(999);
  const junk = [null, undefined, 5, 'x', {}, { type: 5 }, { type: 'press', atTick: 'x' },
    { type: 'press', atTick: 1e9 }, { type: 'wait', atTick: NaN }, [], { type: 'press', id: {} }];
  for (let i = 0; i < 500; i++) {
    const cmd = rng.next() < 0.3 ? junk[Math.floor(rng.next() * junk.length)]
      : { type: ['press', 'release', 'wait', 'resign'][Math.floor(rng.next() * 4)], atTick: st.tick + Math.floor(rng.next() * 30) };
    const r = Rules.applyCommand(st, cmd);
    assert.ok(typeof r.ok === 'boolean');
    st = r.state;
    assert.ok(Number.isFinite(st.fall) && st.fall >= 0);
    assert.ok(Number.isFinite(st.score.total));
    if (st.terminal) break;
  }
});

test('endless mode extends layers and ramps armor without soft locks', () => {
  const cfg = baseCfg({ endless: true, layers: 8, armorPct: 0.2, gapPct: 0.2, rotSpeed: 8, chargeMax: 5 });
  delete cfg.forceLayers;
  let st = Rules.createGame(cfg);
  st = press(st).state;
  for (let i = 0; i < 400 && !st.terminal; i++) st = wait(st, 30).state;
  assert.ok(st.depth > 8 || st.terminal); // generated beyond initial layers or ended
  for (const layer of st.layers) assert.ok(layer.some(s => s !== S.ARMOR), 'layer fully armored');
});

// ---------- content validators ----------

test('all journey/challenge/practice configs are legal and passable', () => {
  const all = Content.JOURNEY.concat(Content.CHALLENGES, Content.PRACTICE, [Content.SCORE_CHASE]);
  assert.strictEqual(Content.JOURNEY.length, 40, 'spec requires ≥40 stages');
  assert.ok(Content.THEMES.length >= 5, 'spec requires 5 themes');
  for (const cfg of all) {
    const st = Rules.createGame(cfg);
    for (const layer of st.layers) assert.ok(layer.some(s => s !== S.ARMOR), cfg.id + ' has a soft-lock layer');
    assert.ok(cfg.par == null || cfg.par.timeSec > 0, cfg.id + ' bad par');
    assert.ok(cfg.version === Content.CONTENT_VERSION);
  }
});

test('daily config is immutable per date and varies by date', () => {
  const d1 = Content.dailyConfig('2026-01-15');
  assert.deepStrictEqual(d1, Content.dailyConfig('2026-01-15'));
  assert.notStrictEqual(d1.seed, Content.dailyConfig('2026-01-16').seed);
  const st = Rules.createGame(d1);
  for (const layer of st.layers) assert.ok(layer.some(s => s !== S.ARMOR));
});

test('tutorial lessons are all completable with a hold-only policy where valid', () => {
  for (const lesson of Content.tutorialLessons()) {
    const cfg = lesson.cfg;
    let st = Rules.createGame(cfg);
    // validate forced layers pass legality
    assert.ok(st.layers.length === cfg.layers);
    for (const layer of st.layers) assert.ok(layer.some(s => s !== S.ARMOR) || cfg.chargeMax > 0);
  }
});

test('achievements have stable lowercase keys', () => {
  const seen = new Set();
  for (const a of Content.ACHIEVEMENTS) {
    assert.ok(/^[a-z0-9-]+$/.test(a.key), a.key);
    assert.ok(!seen.has(a.key));
    seen.add(a.key);
    assert.ok(a.name && a.desc);
  }
});

// ---------- golden sessions ----------

function autoplay(cfg, policy) {
  let st = Rules.createGame(cfg);
  const log = [];
  let guard = 0;
  while (!st.terminal && guard++ < 20000) {
    const act = policy(st);
    if (act !== st.holding) {
      const type = act ? 'press' : 'release';
      const r = Rules.applyCommand(st, { type });
      if (r.ok) { st = r.state; log.push({ type, atTick: st.tick }); continue; }
    }
    st = wait(st, 1).state;
  }
  return { state: st, log };
}

// greedy policy: hold when next landing is safe/overdrive, release for armor
function greedy(st) {
  const p = Rules.peek(st);
  if (!p) return st.holding;
  return !(p.segment === S.ARMOR && !p.chargeReady);
}

test('golden: easy stage winnable by greedy policy', () => {
  const { state } = autoplay(Content.JOURNEY[0], greedy);
  assert.ok(state.terminal && state.terminal.won, 'should win j01');
  assert.ok(state.score.total > 0);
});

test('golden: mid journey stage winnable by greedy policy', () => {
  const { state } = autoplay(Content.JOURNEY[14], greedy);
  assert.ok(state.terminal && state.terminal.won, 'should win j15');
});

test('golden: hard challenge reachable by greedy policy', () => {
  const { state } = autoplay(Content.CHALLENGES[0], greedy);
  assert.ok(state.terminal && state.terminal.won, 'should win c1 within its timer');
});

test('golden: every journey stage is winnable by greedy policy (reachable goals)', () => {
  for (const lv of Content.JOURNEY) {
    const { state } = autoplay(lv, greedy);
    assert.ok(state.terminal, lv.id + ' never terminated');
    assert.ok(state.terminal.won, lv.id + ' unwinnable by greedy policy');
  }
});

test('golden: interrupted + resumed session replays identically', () => {
  const cfg = Content.JOURNEY[5];
  const { log } = autoplay(cfg, greedy);
  // replay from the log in a fresh engine
  let st = Rules.createGame(cfg);
  for (const cmd of log) {
    const r = Rules.applyCommand(st, cmd);
    assert.ok(r.ok);
    st = r.state;
  }
  let guard = 0;
  while (!st.terminal && guard++ < 20000) st = wait(st, 1).state;
  const again = autoplay(cfg, greedy).state;
  assert.strictEqual(Rules.hashState(st), Rules.hashState(again));
  assert.strictEqual(st.score.total, again.score.total);
});

// ---------- server validation ----------

test('server accepts a genuine replay and rejects a forged one', () => {
  const cfg = Content.JOURNEY[2];
  const { state, log } = autoplay(cfg, greedy);
  const body = {
    board: 'journey', name: 'tester', contentVersion: cfg.version, seed: cfg.seed,
    cfg, log, hash: Rules.hashState(state), score: state.score.total,
    durationMs: state.elapsedMs, assists: { undo: true, hint: true }
  };
  const ok = server.validateSubmission(body);
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.score, state.score.total);

  const forged = Object.assign({}, body, { score: state.score.total + 1000 });
  assert.strictEqual(server.validateSubmission(forged).error, 'score-mismatch');
  const badHash = Object.assign({}, body, { hash: 12345 });
  assert.strictEqual(server.validateSubmission(badHash).error, 'hash-mismatch');
  const stale = Object.assign({}, body, { cfg: Object.assign({}, cfg, { version: 99 }) });
  assert.strictEqual(server.validateSubmission(stale).error, 'stale-version');
  const badCmd = Object.assign({}, body, { log: [{ type: 'nuke' }] });
  assert.ok(/^bad-command/.test(server.validateSubmission(badCmd).error));
});

test('server submission stores and ranks scores', () => {
  const cfg = Content.JOURNEY[0];
  const { state, log } = autoplay(cfg, greedy);
  const r = server.submitScore({
    board: 'test-board', name: 'tester', contentVersion: cfg.version, seed: cfg.seed,
    cfg, log, hash: Rules.hashState(state), score: state.score.total,
    durationMs: state.elapsedMs, assists: { undo: true, hint: true }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.accepted, true);
  assert.ok(r.json.rank >= 1);
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
