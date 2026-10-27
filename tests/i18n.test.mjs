// Localization coverage: every English key the engine client (native/*.ts)
// and the content use is translated in every locale (en-GB → en-US, es-ES →
// es-419, fr-CA → fr-FR inherit), placeholders survive, no table row is
// unused, and js/i18n.js switches locales with their fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { codeKeys, audit } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const Content = require('../js/content.js');
const { CB_STRINGS } = require('../js/strings.js');
const I18N = require('../js/i18n.js');
const ROOT = new URL('../', import.meta.url);

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    codeKeys(readFileSync(new URL(`native/${f}`, ROOT), 'utf8')).forEach((k) => keys.add(k));
  }
  // Key names and arrows from the player's bindings (screens.ts keysFor).
  for (const k of ['Space', 'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right']) keys.add(k);
  for (const th of Content.THEMES) keys.add(th.name);
  for (const l of Content.JOURNEY) { keys.add(l.name); if (l.intro) keys.add(l.intro); }
  for (const c of Content.CHALLENGES) { keys.add(c.name); keys.add(c.intro); }
  for (const p of Content.PRACTICE) keys.add(p.name);
  keys.add(Content.SCORE_CHASE.name); keys.add(Content.SCORE_CHASE.intro);
  keys.add(Content.dailyConfig('2026-10-16').intro);
  for (const l of Content.tutorialLessons()) { keys.add(l.title); keys.add(l.text); }
  for (const a of Content.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && k !== 'CORE BREAKER').sort();
}

test('every used key is translated in every locale; placeholders intact; no unused rows', () => {
  assert.deepEqual(audit(CB_STRINGS, usedKeys()), []);
});

test('js/i18n.js switches locales and falls back through the parent tables', () => {
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  assert.equal(I18N.setLocale('en-GB'), 'en-GB');
  assert.equal(I18N.T('Armor impact — dive over.'), 'Armour impact — dive over.');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  assert.equal(I18N.T('Resume'), CB_STRINGS['fr-FR'].Resume);
  I18N.setLocale('es-ES');
  assert.equal(I18N.T('Score not posted to the leaderboard.'), 'No se ha enviado la puntuación a la clasificación.');
  assert.equal(I18N.T('Stage {n}: {name}', { n: 3, name: 'x' }).includes('3'), true);
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
  assert.equal(I18N.T('Resume'), 'Resume');
});
