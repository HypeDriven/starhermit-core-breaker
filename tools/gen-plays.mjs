// Writes the play scripts in tests/native/ that dive rounds by the rules
// bot's plans (tools/plan.mjs), so each round's results show the planned
// score: the five Learn lessons in a row (Play → lesson 1, then Next Stage),
// Journey stage 1 with its stars and Next Stage, and the Blitz Shaft
// challenge against its containment timer. The menu tour (tests/native/
// screens.play) is written by hand. Run after changing the rules, the
// content or the round's timing (the countdown), then `npm run test:native`.
//   node tools/gen-plays.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { planRound } from './plan.mjs';

const require = createRequire(import.meta.url);
const Content = require('../js/content.js');
const fmt = (n) => Number(n).toLocaleString('en-US');
const lessons = Content.tutorialLessons();

function round(id, opts = {}) {
  const r = planRound(id, opts);
  if (r.reason !== 'core-reached') throw new Error(`${id}: the plan does not reach the core (${r.head})`);
  return r;
}
const write = (name, lines) => writeFileSync(new URL(`../tests/native/${name}`, import.meta.url), lines.join('\n') + '\n');

// --- Learn: the five lessons, chained by Next Stage --------------------------------------
{
  const out = [
    '# Learn: a new pilot\'s Play opens lesson 1; each lesson is dived by the rules',
    '# bot\'s plan (node tools/gen-plays.mjs) to its results with the planned total,',
    '# then Next Stage opens the next lesson. Lesson 5 rewinds with U once.',
    'until 300 Play',
    'frames 60',
    'click =Play',
  ];
  lessons.forEach((l, i) => {
    const r = round(l.cfg.id, { undo: l.id === 't5' });
    out.push(`until 120 ${l.title}`, 'frames 10', `save lesson-${i + 1}-intro`, 'click Start', `# ${r.head.slice(2)}`, ...r.lines);
    out.push('until 400 Core Reached!', 'release Space', 'frames 10', `expect ${fmt(r.score)}`);
    if (i === 1) out.push('frames 40', 'save lesson-2-results');
    out.push('frames 30');
    if (i + 1 < lessons.length) out.push('click Next Stage');
  });
  out.push('click Exit to Title', 'until 120 Daily Challenge', 'frames 10', 'save title-after-lessons');
  write('learn-lessons.play', out);
}

// --- Journey stage 1: two stars, its grid, Next Stage ----------------------------------
{
  const r = round('j01');
  const out = [
    '# Journey: stage 1 from the grid, dived by the plan to the core under par',
    '# (two stars), Retry, then Pause → Leave Round, the grid shows the stars and',
    '# opens stage 2; its intro offers Next Stage\'s stage and Cancel returns.',
    'until 300 Play',
    'frames 60',
    'click Journey',
    'until 60 40 authored descents',
    'frames 20',
    'click =1',
    'until 60 First Descent',
    'frames 10',
    'save journey-intro',
    'click Start',
    `# ${r.head.slice(2)}`,
    ...r.lines,
    'frames 60',
    'save journey-diving',
    'until 400 Core Reached!',
    'release Space',
    'frames 10',
    `expect ${fmt(r.score)}`,
    'expect par beaten',
    'expect Par beaten',
    'frames 40',
    'save journey-results',
    'click Retry',
    'until 300 =1',
    'frames 60',
    'key Escape 1',
    'until 30 Leave Round',
    'frames 10',
    'save journey-paused',
    'click Leave Round',
    'until 60 Daily Challenge',
    'frames 10',
    'click Journey',
    'until 60 40 authored descents',
    'frames 20',
    'save journey-grid-stars',
    'click =2',
    'until 60 Crystal Veins',
    'frames 10',
    'click Cancel',
    'frames 10',
    'key Escape 1',
    'until 60 Daily Challenge',
  ];
  write('journey-stage.play', out);
}

// --- Challenge c1: Blitz Shaft against its 42 s timer ---------------------------------------
{
  const r = round('c1');
  const out = [
    '# Challenges: Blitz Shaft (42 s containment timer, no undo) dived by the plan',
    '# to the core; the results show the planned total.',
    'until 300 Play',
    'frames 60',
    'click Challenges',
    'until 60 Blitz Shaft',
    'frames 20',
    'click Blitz Shaft',
    'until 60 Containment vents in 42 seconds',
    'frames 10',
    'click Start',
    `# ${r.head.slice(2)}`,
    ...r.lines,
    'frames 30',
    'save challenge-diving',
    'until 600 Core Reached!',
    'release Space',
    'frames 10',
    `expect ${fmt(r.score)}`,
    'expect Time bonus',
    'frames 40',
    'save challenge-results',
  ];
  write('challenge-timer.play', out);
}
console.log('wrote tests/native/learn-lessons.play, journey-stage.play, challenge-timer.play');
