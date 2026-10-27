// Prints the play-script lines that dive a round to the core: a bot over the
// unchanged rules (js/rules.js) that holds while the next landing is safe and
// releases while it would be armour (peek), with a margin: it presses only
// when a press a tick early or late is also safe, and releases when the
// landing a tick or two on would crash. The plan is checked with every
// command a tick early and a tick late too (the same outcome), so a script
// replays it exactly. Ticks count from the round's first fixed step after the
// countdown (the script waits for the "1" numeral, then OFFSET frames); a
// `hold` / `release` line takes one frame and acts on the next frame's tick,
// `frames N` takes N + 1 frames: two commands Δ ticks apart have `frames Δ-2`
// between them.
//   node tools/plan.mjs <content id> [--seed N] [--undo]
// Content ids: journey (j01…), challenges (c1…), practice presets (calm…,
// with --seed), lessons (t1…). --undo plans lesson t5's rewind.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');

export const OFFSET = 43; // frames from the "1" numeral to the round's tick 0

const lessons = Content.tutorialLessons();
const ALL = [...Content.JOURNEY, ...Content.CHALLENGES, ...Content.PRACTICE, ...lessons.map((l) => l.cfg)];
let cfg = null;
let undoAfter = null;

const apply = (s, cmd) => Rules.applyCommand(s, cmd).state;
const wait = (s, n = 1) => (n > 0 ? apply(s, { type: 'wait', atTick: s.tick + n }) : s);
const crashAhead = (s) => { const p = Rules.peek(s); return !!(p && p.willCrash); };
function safePressAt(s, d) {
  const t = wait(s, d);
  if (t.terminal) return false;
  const p = apply(t, { type: 'press', atTick: t.tick });
  // safe now, and no release needed for the next few ticks (a script cannot press and release a frame apart)
  return [0, 1, 2, 3, 4, 5].every((k) => !crashAhead(wait(p, k)));
}

// Plan: [tick, 'press' | 'release' | 'undo'].
function plan() {
  let s = Rules.createGame(cfg);
  const cmds = [];
  for (let guard = 0; !s.terminal && guard < 60 * 300; guard++) {
    if (s.holding) {
      if ([0, 1, 2, 3].some((d) => crashAhead(wait(s, d)))) {
        s = apply(s, { type: 'release', atTick: s.tick }); cmds.push([s.tick, 'release']);
      }
    } else if ([0, 1, 2, 3].every((d) => safePressAt(s, d)) && (cmds.length === 0 || s.tick - cmds[cmds.length - 1][0] >= 4)) {
      s = wait(s, 1);
      s = apply(s, { type: 'press', atTick: s.tick }); cmds.push([s.tick, 'press']);
    }
    if (!s.terminal) s = wait(s, 1);
  }
  return cmds;
}
// For lesson t5: hold one layer, release, rewind (the undo puts the rules'
// clock back to the release, so plans count frames, not ticks), then dive.
function lessonUndo() {
  let s = Rules.createGame(cfg);
  let f = 0;
  const step = (n) => { s = wait(s, n); f += n; };
  const cmds = [];
  step(1); s = apply(s, { type: 'press', atTick: s.tick }); cmds.push([f, 'press']);
  while (s.depth < 1) step(1);
  step(3); s = apply(s, { type: 'release', atTick: s.tick }); cmds.push([f, 'release']);
  step(30); s = apply(s, { type: 'undo', atTick: s.tick }); cmds.push([f, 'undo']);
  step(20); s = apply(s, { type: 'press', atTick: s.tick }); cmds.push([f, 'press']);
  return cmds;
}
/** Replays a plan (frames → commands), every command `shift` frames off. */
function run(cmds, shift) {
  let s = Rules.createGame(cfg);
  const list = cmds.map(([t, c]) => [Math.max(0, t + shift), c]);
  for (let f = 0; !s.terminal && f < 60 * 300; f++) {
    for (const [t, c] of list) if (t === f) s = apply(s, { type: c, atTick: s.tick });
    if (!s.terminal) s = wait(s, 1);
  }
  return s;
}

/** The plan for a content id: { head (a comment line), lines (the script's steps), score, reason, stable }. */
export function planRound(id, { seed = null, undo = false } = {}) {
  const base = ALL.find((c) => c.id === id);
  if (!base) throw new Error(`no content ${id}`);
  cfg = Rules.clone(base);
  if (seed != null) cfg.seed = seed;
  undoAfter = undo;
  const cmds = undoAfter ? lessonUndo() : plan();
  const outcomes = [-1, 0, 1].map((d) => run(cmds, d));
  const [early, exact, late] = outcomes;
  const same = outcomes.every((o) => o.terminal && o.terminal.reason === exact.terminal.reason);
  const head = (`# ${id} (seed ${cfg.seed}): ${exact.terminal ? exact.terminal.reason : 'running'} at tick ${exact.tick}, ${cmds.length} commands, score ${exact.score.total}` +
    ` (a tick early ${early.score.total} ${early.terminal?.reason}, late ${late.score.total} ${late.terminal?.reason})${same ? '' : '  UNSTABLE'}`);
  const KEY = { press: 'hold Space', release: 'release Space', undo: 'key KeyU 1' };
  let last = -1;
  const lines = [`frames 5`, `until 300 =1`, `frames ${OFFSET + (cmds[0][0])}`];
  for (const [t, c] of cmds) {
    if (last >= 0) lines.push(`frames ${Math.max(0, t - last - 2)}`);
    lines.push(KEY[c]);
    last = t;
  }
  return { head, lines, score: exact.score.total, reason: exact.terminal ? exact.terminal.reason : null, stable: same };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : null; };
  const r = planRound(args[0] || 'j01', { seed: opt('--seed'), undo: args.includes('--undo') });
  console.log(r.head);
  console.log(r.lines.join('\n'));
}
