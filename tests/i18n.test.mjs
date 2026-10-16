// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const Content = require('../js/content.js');
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  codeKeys(read('js/main.js')).forEach((k) => keys.add(k));
  codeKeys(read('js/platform.js'), ['tr']).forEach((k) => keys.add(k));
  for (const m of read('js/audio.js').matchAll(/caption\('([^']+)'\)/g)) keys.add(m[1]);
  keys.delete('crystal break ×'); // composed with the multiplier: 'crystal break ×{n}'
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

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CB_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CBI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Armor impact — dive over.'), 'Armour impact — dive over.');
});
