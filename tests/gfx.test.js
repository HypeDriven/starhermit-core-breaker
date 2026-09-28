/* Core Breaker — graphics quality model (js/gfx.js) unit tests: node --test. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Gfx = require('../js/gfx.js');

test('detectPreset maps GPU strings to tiers', () => {
  assert.strictEqual(Gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.strictEqual(Gfx.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.strictEqual(Gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.strictEqual(Gfx.detectPreset('Apple M2'), 'high');
  assert.strictEqual(Gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.strictEqual(Gfx.detectPreset('Adreno (TM) 650'), 'balanced');
  assert.strictEqual(Gfx.detectPreset(''), 'balanced');
});

test('autoPreset caps touch / mobile devices at balanced', () => {
  assert.strictEqual(Gfx.autoPreset('NVIDIA GeForce RTX 4090', true), 'balanced');
  assert.strictEqual(Gfx.autoPreset('NVIDIA GeForce RTX 4090', false), 'high');
  assert.strictEqual(Gfx.autoPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = Gfx.resolve({}, 'low');
  assert.strictEqual(a.preset, 'low');
  assert.strictEqual(a.auto, true);
  assert.strictEqual(a.post, false, 'Low renders without a post chain');
  assert.strictEqual(a.shadowMap, 0);
  const h = Gfx.resolve({ preset: 'high' }, 'low');
  assert.strictEqual(h.preset, 'high');
  assert.strictEqual(h.auto, false);
  assert.strictEqual(h.shadows, 'medium');
  assert.strictEqual(h.post, true);
  assert.strictEqual(Gfx.resolve({ preset: 'medium' }, 'low').preset, 'balanced', 'legacy medium maps to balanced');
});

test('resolve: overrides apply per category; invalid tiers fall back to the preset', () => {
  const r = Gfx.resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'high');
  assert.strictEqual(r.bloom, 'on');
  assert.strictEqual(r.shadows, 'off');
  assert.strictEqual(r.post, true, 'bloom override turns the post chain on');
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.strictEqual(Gfx.resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.strictEqual(Gfx.resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.strictEqual(Gfx.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.strictEqual(Gfx.resolve({ preset: 'low' }).pixelCap, 1);
});

test('choosePreset clears overrides but keeps scale / adaptive / fps', () => {
  const s = Gfx.choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'ultra');
  assert.deepStrictEqual(s, { preset: 'ultra', render_scale: 1.5, adaptive: false, show_fps: true });
  const r = Gfx.resolve(s, 'low');
  assert.strictEqual(r.ao, Gfx.presetTier('ultra', 'ao'));
  assert.strictEqual(r.adaptive, false);
  assert.strictEqual(r.showFps, true);
});

test('presetTier and describe', () => {
  assert.strictEqual(Gfx.presetTier('balanced', 'antialias'), 'fxaa');
  assert.strictEqual(Gfx.presetTier('nope', 'antialias'), undefined);
  const d = Gfx.describe(Gfx.resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
  assert.match(Gfx.describe(Gfx.resolve({ preset: 'low' })), /no shadows/);
});

test('strings exist for every locale and key', () => {
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = Gfx.strings('en-US');
  for (const l of locales) {
    const s = Gfx.STRINGS[l];
    assert.ok(s, l);
    for (const k of Object.keys(en)) {
      assert.ok(s[k] !== undefined, `${l}.${k}`);
      if (typeof en[k] === 'object') for (const j of Object.keys(en[k])) assert.ok(s[k][j], `${l}.${k}.${j}`);
    }
    for (const cat of Gfx.CATEGORY_ORDER) for (const t of Gfx.CATEGORIES[cat]) assert.ok(s.tiers[t], `${l} tier ${t}`);
  }
  assert.strictEqual(Gfx.pickLocale(['de-AT']), 'de-DE');
  assert.strictEqual(Gfx.pickLocale(['es-ES']), 'es-ES');
  assert.strictEqual(Gfx.pickLocale(['es-MX']), 'es-419');
  assert.strictEqual(Gfx.pickLocale(['fr-CA']), 'fr-CA');
  assert.strictEqual(Gfx.pickLocale(['en-GB']), 'en-GB');
  assert.strictEqual(Gfx.pickLocale(['ja-JP']), 'en-US');
});
