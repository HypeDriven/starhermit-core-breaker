/** Core Breaker — StarHermit adapter unit tests (node --test).
 * Loads starhermit-sdk.js + js/platform.js into a vm sandbox with a stubbed
 * fetch and launch hash. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'core-breaker';
const J = (o) => JSON.parse(JSON.stringify(o));
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-12345678', game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

function boot(hash) {
  const calls = [];
  const store = { save: null, settings: {} };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/v1/users/u-12345678/profile')) return json({ nickname: 'Pip' });
    if (url.includes('/api/v1/me/cloud-saves/') && url.endsWith('/info')) {
      return json(store.save ? { exists: true, etag: '"v' + calls.length + '"' } : { exists: false });
    }
    if (url.includes('/api/v1/me/cloud-saves/')) {
      // refuseNextPut: the next write loses to "another device" (conditional write refused).
      if (method === 'PUT' && store.refuseNextPut) { store.refuseNextPut = false; return json({ error: 'precondition-failed' }, 412); }
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return json({ etag: '"v' + calls.length + '"' }); }
      return store.save ? new Response(store.save, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/settings`)) {
      if (method === 'PATCH') { Object.assign(store.settings, JSON.parse(init.body).settings); return json({ settings: store.settings }); }
      return json({ settings: store.settings });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/leaderboards`)) return json([{ id: 'lb1', key: 'score' }]);
    if (url.includes('/api/v1/leaderboards/lb1/entries')) return json({ items: [{ userId: 'u-12345678', score: 900, rank: 1 }], total: 1 });
    if (url.endsWith(`/api/v1/games/${SLUG}/controls`)) return json({ actions: [{ action: 'serve', codes: ['KeyX'] }] });
    return new Response('', { status: 404 });
  };
  const listeners = {};
  const location = { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' };
  const win = {
    location,
    history: { state: null, replaceState(_s, _t, url) { const i = url.indexOf('#'); location.hash = i >= 0 ? url.slice(i) : ''; } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    document: { hidden: false, addEventListener() {} },
    fetch, Response, Blob, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Uint8Array, DataView, Map, Promise, JSON,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 20)); t.unref(); return t; },
    clearTimeout,
  };
  win.window = win; win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(path.join(ROOT, 'starhermit-sdk.js'), 'utf8'), win);
  vm.runInContext(readFileSync(path.join(ROOT, 'js', 'platform.js'), 'utf8'), win);
  return { win, P: win.CBPlatform, calls, store, listeners };
}

test('launch token: read from the fragment, fragment stripped, slug from claims', async () => {
  const { P, win } = boot('#game_token=' + JWT + '&session_id=abc');
  assert.equal(P.init(), true);
  assert.equal(P.hosted, true);
  assert.equal(P.slug, SLUG);
  assert.equal(P.userId, 'u-12345678');
  assert.equal(win.location.hash, '');
  assert.equal(P.headers().Authorization, 'Bearer ' + JWT);
});

test('profile name comes from the profile nickname', async () => {
  const { P } = boot('#game_token=' + JWT);
  P.init();
  const prof = await P.fetchProfile();
  assert.equal(prof.name, 'Pip');
});

test('cloud save round-trips through /api/v1/me/cloud-saves/game:<slug>', async () => {
  const { P, calls } = boot('#game_token=' + JWT);
  P.init();
  const wrapped = JSON.stringify({ sum: 'abc', payload: '{"v":1}' });
  P.onLocalSave(wrapped);
  assert.equal(P.sync, 'saving');
  assert.equal(await P.flushSave(true), true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG)), put.url);
  assert.equal(put.init.keepalive, true);
  assert.equal(P.sync, 'synced');
  assert.equal(await P.loadCloud(), wrapped);
});

test('settings patch and bindings use the game routes', async () => {
  const { P, calls, store } = boot('#game_token=' + JWT);
  P.init();
  await P.patchSettings({ graphics: { preset: 'high' } }); // debounced
  assert.deepEqual(J(store.settings.graphics), { preset: 'high' });
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith(`/api/v1/games/${SLUG}/settings`)));
  assert.deepEqual(J((await P.getSettings()).graphics), { preset: 'high' });
  const b = await P.loadBindings({ serve: ['KeyS'], hint: ['KeyH'] });
  assert.deepEqual(J(b), { serve: ['KeyX'], hint: ['KeyH'] });
  assert.match(P.inviteLink(), /game-invite\/u-12345678\/core-breaker$/);
});

test('platform leaderboard resolves nicknames and marks own row', async () => {
  const { P } = boot('#game_token=' + JWT);
  P.init();
  const rows = J(await P.fetchLeaderboard());
  assert.deepEqual(rows, [{ name: 'You (Pip)', score: 900 }]);
});

test('standalone: no token means no fetch at all', async () => {
  const { P, calls } = boot('');
  assert.equal(P.init(), false);
  assert.equal(P.hosted, false);
  assert.equal(P.canSignIn(), false);
  assert.equal(P.inviteLink(), null);
  assert.equal(await P.fetchProfile(), null);
  assert.equal(await P.fetchLeaderboard(), null);
  assert.equal(await P.loadCloud(), null);
  P.onLocalSave(JSON.stringify({ sum: 'x', payload: '{}' }));
  await P.flushSave(true);
  await P.patchSettings({ a: 1 });
  assert.deepEqual(J(await P.getSettings()), {});
  assert.deepEqual(J(await P.loadBindings({ hint: ['KeyH'] })), { hint: ['KeyH'] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0);
});

// Browser-only session module in a vm sandbox with an in-memory localStorage.
function loadSession() {
  const mem = new Map();
  const ctx = {
    localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
    JSON, Math, Date,
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js', 'rng.js'), 'utf8'), ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'js', 'session.js'), 'utf8'), ctx);
  return { S: ctx.CBSession, raw: () => mem.get('corebreaker.progress.v1') };
}

test('save-conflict merge keeps the better of both devices', () => {
  const other = loadSession();
  other.S.recordJourney('j01', true, 900, true);
  other.S.recordJourney('j02', true, 300, false);
  other.S.recordDaily('2026-10-02', 500, true);
  other.S.unlockAchievement('first-core', 100);
  other.S.addTotals(40, true);
  other.S.addTotals(10, false);
  const mine = loadSession();
  mine.S.recordJourney('j01', true, 1200, false);
  mine.S.recordDaily('2026-10-01', 200, false);
  mine.S.markTutorialDone('t1');
  mine.S.unlockAchievement('first-core', 500);
  mine.S.addTotals(5, false);
  assert.equal(mine.S.mergeWrapped(other.raw()), true);
  assert.equal(mine.S.getJourney('j01').stars, 2, 'higher stars');
  assert.equal(mine.S.getJourney('j01').best, 1200, 'higher best');
  assert.ok(mine.S.getJourney('j02'), 'remote stage kept');
  assert.ok(mine.S.getDaily('2026-10-01') && mine.S.getDaily('2026-10-02').won, 'dailies from both');
  assert.ok(mine.S.isTutorialDone('t1'));
  assert.equal(mine.S.getTotals().rounds, 2, 'larger round count');
  assert.equal(mine.S.getTotals().breaks, 50);
  assert.equal(mine.S.mergeWrapped('not json'), false, 'invalid doc ignored');
});

test('a refused cloud write reloads the newer copy for the game to merge', async () => {
  const { P, store } = boot('#game_token=' + JWT);
  P.init();
  assert.equal(await P.loadCloud(), null);
  const other = JSON.stringify({ v: 1, data: { from: 'other' }, sum: 1 });
  P.onLocalSave(other);
  assert.equal(await P.flushSave(true), true, 'other device saved first');
  const reloaded = new Promise((resolve) => P.onConflict(resolve));
  store.refuseNextPut = true;
  P.onLocalSave(JSON.stringify({ v: 1, data: { from: 'mine' }, sum: 2 }));
  assert.equal(await P.flushSave(true), false, 'stale write refused');
  assert.equal(await reloaded, other);
  P.onLocalSave(JSON.stringify({ v: 1, data: { from: 'merged' }, sum: 3 }));
  assert.equal(await P.flushSave(true), true, 'merged doc saved');
});
