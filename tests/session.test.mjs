// The progress document (js/session.js) as the engine client keeps it: the
// checksummed {v, data, sum} wrap round-trips through localStorage (the
// game's save on the engine), a corrupted or foreign-version document starts
// clean, two devices' copies merge without losing anything (the save
// conflict), the browser build's cloud save (the same wrapped document, the
// JS SDK's save.json) migrates with its game options, and the account's old
// per-player settings keys yield only valid game options. Signed-in paths
// cannot run here, so their logic is covered at this level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const require = createRequire(import.meta.url);
const S = require('../js/session.js');

function browserSave(edit) {
  const d = S.emptyDoc();
  edit(d);
  return JSON.stringify(S.wrap(d));
}

test('the wrapped document round-trips through localStorage and fills defaults', () => {
  mem.clear();
  S.load();
  S.recordJourney('j01', true, 710, true);
  S.submitBest('journey', 710, 1);
  S.addTotals(6, true);
  const raw = JSON.parse(mem.get(S.DOC_KEY));
  assert.equal(raw.v, 1);
  assert.equal(raw.sum, S.wrap(raw.data).sum);
  delete raw.data.totals;
  raw.sum = S.wrap(raw.data).sum;
  mem.set(S.DOC_KEY, JSON.stringify(raw));
  S.load();
  assert.deepEqual(S.getJourney('j01'), { stars: 2, best: 710 });
  assert.deepEqual(S.getTotals(), { breaks: 0, rounds: 0, wins: 0 });
  assert.equal(S.doc.settings.captions, 1);
});

test('a corrupted or other-version document starts clean', () => {
  mem.set(S.DOC_KEY, JSON.stringify({ v: 1, data: { journey: { j01: { stars: 2, best: 9 } } }, sum: 1 }));
  S.load();
  assert.equal(S.getJourney('j01'), null);
  mem.set(S.DOC_KEY, JSON.stringify({ ...S.wrap(S.emptyDoc()), v: 2 }));
  S.load();
  assert.equal(S.totalStars(), 0);
  assert.equal(S.unwrap('not json'), null);
});

test('two devices merge: better stars, bests, dailies; earliest unlocks; larger totals; own settings', () => {
  const a = S.emptyDoc(), b = S.emptyDoc();
  a.journey.j01 = { stars: 1, best: 500 }; b.journey.j01 = { stars: 2, best: 400 }; b.journey.j02 = { stars: 1, best: 300 };
  a.bests.score = { score: 900, atMs: 5 }; b.bests.score = { score: 1200, atMs: 9 }; b.bests.daily = { score: 50, atMs: 1 };
  a.dailies['2026-10-01'] = { score: 100, won: false }; b.dailies['2026-10-01'] = { score: 80, won: true };
  a.achievements['first-break'] = 20; b.achievements['first-break'] = 10; b.achievements['mult-8'] = 30;
  b.tutorialDone.t2 = true;
  a.totals = { breaks: 10, rounds: 3, wins: 1 }; b.totals = { breaks: 7, rounds: 5, wins: 0 };
  a.settings.theme = 'ember'; b.settings.theme = 'solar';
  b.lastReplay = { v: 1, score: 1 };
  const m = S.mergeDocs(a, b);
  assert.deepEqual(m.journey, { j01: { stars: 2, best: 500 }, j02: { stars: 1, best: 300 } });
  assert.equal(m.bests.score.score, 1200);
  assert.equal(m.bests.daily.score, 50);
  assert.deepEqual(m.dailies['2026-10-01'], { score: 100, won: true });
  assert.deepEqual(m.achievements, { 'first-break': 10, 'mult-8': 30 });
  assert.equal(m.tutorialDone.t2, true);
  assert.deepEqual(m.totals, { breaks: 10, rounds: 5, wins: 1 });
  assert.equal(m.settings.theme, 'ember');
  assert.deepEqual(m.lastReplay, { v: 1, score: 1 });
  assert.deepEqual(S.mergeDocs(a, null).journey, a.journey);
});

test('the browser build\'s cloud save (save.json) merges into this device\'s progress', () => {
  mem.clear();
  S.load();
  S.recordJourney('j03', true, 300, false);
  const old = browserSave((d) => { d.journey.j01 = { stars: 2, best: 710 }; d.tutorialDone.t1 = true; d.settings.holdToggle = 1; d.settings.theme = 'glacial'; });
  assert.equal(S.mergeWrapped(old), true);
  assert.equal(S.getJourney('j01').stars, 2);
  assert.equal(S.getJourney('j03').stars, 1);
  assert.equal(S.isTutorialDone('t1'), true);
  assert.equal(S.unwrap(mem.get(S.DOC_KEY)).journey.j01.best, 710, 'the merge is saved');
  assert.deepEqual(S.gameSettingsFrom(S.unwrap(old).settings), { captions: 1, leftHanded: 0, holdToggle: 1, timingAssist: 0, theme: 'glacial' });
  assert.equal(S.mergeWrapped('{"v":1,"data":{},"sum":0}'), false);
});

test('old per-player settings keys yield only valid game options', () => {
  assert.deepEqual(S.gameSettingsFrom({ captions: 0, leftHanded: true, holdToggle: 'yes', theme: 'nope', volMusic: 40, timingAssist: 1 }),
    { captions: 0, leftHanded: 1, timingAssist: 1 });
  assert.equal(S.checkSetting('theme', 'verdant'), 'verdant');
  assert.equal(S.checkSetting('volMusic', 40), undefined);
});

test('an imported document replaces the live one only when valid', () => {
  mem.clear();
  S.load();
  assert.equal(S.importWrapped('{"v":1}'), false);
  assert.equal(S.importWrapped(browserSave((d) => { d.totals.rounds = 9; })), true);
  assert.equal(S.getTotals().rounds, 9);
});
