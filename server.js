/* Core Breaker — authoritative script + static server (no external deps).
 *
 * Serves the distribution and a small same-origin API:
 *   GET  /api/v1/time            platform time for countdown/daily sync
 *   GET  /api/v1/daily           today's immutable daily config (metadata)
 *   GET  /api/v1/leaderboard?board=X
 *   POST /api/v1/score           validated submission: replays the ordered
 *                                input log against the deterministic rules
 *                                engine and accepts only matching hashes.
 *
 * Scores persist to tools/scores.json (append-only JSON lines would be
 * overkill; a single JSON document is enough at this scale).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Rules = require('./js/rules.js');
const Content = require('./js/content.js');
const RNG = require('./js/rng.js');

const ROOT = __dirname;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SCORES_FILE = process.env.CB_SCORES_FILE || path.join(ROOT, 'tools', 'scores.json');
const MAX_BODY = 256 * 1024;
const MAX_LOG = 20000;
const MAX_RUN_TICKS = 60 * 60 * 15; // 15 minutes of simulated play per replay

// Generous bounds around every shipped ruleset. A submission is replayed
// server-side, so an unbounded config (e.g. layers: 1e9) would otherwise let
// one request generate arbitrarily much work before the hash check runs.
const CFG_LIMITS = {
  layers: [1, 500], sectors: [3, 32], rotSpeed: [0, 500], fallSpeed: [1, 1000],
  chargeMax: [0, 64], timeLimitSec: [0, 3600]
};

function checkConfigBounds(cfg) {
  for (const key in CFG_LIMITS) {
    const v = cfg[key] === undefined || cfg[key] === null ? 0 : cfg[key];
    if (!Number.isInteger(v) || v < CFG_LIMITS[key][0] || v > CFG_LIMITS[key][1]) return 'bad-config:' + key;
  }
  for (const key of ['armorPct', 'gapPct']) {
    const v = cfg[key] === undefined ? 0 : cfg[key];
    if (typeof v !== 'number' || !(v >= 0) || v > 1) return 'bad-config:' + key;
  }
  if (cfg.forceLayers && (!Array.isArray(cfg.forceLayers) || cfg.forceLayers.length > CFG_LIMITS.layers[1])) {
    return 'bad-config:forceLayers';
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.opus': 'audio/ogg; codecs=opus',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------- score store ----------

let boards = {};
try { boards = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); } catch (e) { boards = {}; }

function saveBoards() {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(boards)); } catch (e) {}
}

// ---------- replay validation ----------

// Replays the submitted log through the deterministic engine. Returns
// { ok, score, hash, error } — the client hash/score must match exactly.
function validateSubmission(body) {
  if (!body || typeof body !== 'object') return { error: 'malformed-body' };
  if (typeof body.board !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.board)) return { error: 'bad-board' };
  if (!body.cfg || typeof body.cfg !== 'object') return { error: 'missing-config' };
  if (body.cfg.version !== Content.CONTENT_VERSION) return { error: 'stale-version' };
  if (!Number.isInteger(body.score) || body.score < 0 || body.score > 1e7) return { error: 'implausible-score' };
  if (!Array.isArray(body.log) || body.log.length > MAX_LOG) return { error: 'bad-log' };
  if (!Number.isInteger(body.hash)) return { error: 'missing-hash' };
  const boundsErr = checkConfigBounds(body.cfg);
  if (boundsErr) return { error: boundsErr };

  let state;
  try { state = Rules.createGame(body.cfg); } catch (e) { return { error: 'bad-config' }; }

  for (let i = 0; i < body.log.length; i++) {
    const cmd = body.log[i];
    const shapeErr = Rules.validateCommandShape(cmd);
    if (shapeErr) return { error: 'bad-command:' + shapeErr };
    if (cmd.type === 'wait') return { error: 'wait-not-loggable' };
    const r = Rules.applyCommand(state, cmd);
    if (!r.ok) return { error: 'illegal-command:' + r.reason };
    state = r.state;
    if (state.tick > MAX_RUN_TICKS) return { error: 'run-too-long' };
  }

  // settle: advance to terminal (or a bounded horizon for endless runs)
  let guard = 0;
  while (!state.terminal && guard++ < 600) {
    const r = Rules.applyCommand(state, { type: 'wait', atTick: state.tick + 600 });
    if (!r.ok) break;
    state = r.state;
    if (state.tick > MAX_RUN_TICKS) break;
  }

  const hash = Rules.hashState(state);
  if (hash !== body.hash) return { error: 'hash-mismatch' };
  if (state.score.total !== body.score) return { error: 'score-mismatch' };
  return { ok: true, score: state.score.total, hash, won: !!(state.terminal && state.terminal.won), durationMs: state.elapsedMs };
}

function submitScore(body) {
  const v = validateSubmission(body);
  if (v.error) return { status: 422, json: { error: v.error } };
  const name = (typeof body.name === 'string' ? body.name.slice(0, 24) : 'pilot') || 'pilot';
  const board = boards[body.board] || (boards[body.board] = []);
  const entry = {
    name, score: v.score, atMs: Date.now(),
    durationMs: v.durationMs | 0, won: !!v.won,
    seed: body.seed >>> 0, contentVersion: body.cfg.version,
    assists: { undo: !!(body.assists && body.assists.undo), hint: !!(body.assists && body.assists.hint) }
  };
  // idempotent-ish: ignore exact duplicate submissions
  const dup = board.some(e => e.name === entry.name && e.score === entry.score &&
    e.seed === entry.seed && e.durationMs === entry.durationMs);
  if (!dup) {
    board.push(entry);
    // tie order: score desc, then lower duration, then earlier submission
    board.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs || a.atMs - b.atMs);
    boards[body.board] = board.slice(0, 50);
    saveBoards();
  }
  const rank = boards[body.board].indexOf(entry) + 1 || boards[body.board].findIndex(
    e => e.name === entry.name && e.score === entry.score && e.seed === entry.seed) + 1;
  return { status: 200, json: { accepted: true, validated: true, rank } };
}

// ---------- routing ----------

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const p = u.pathname;

  if (p === '/api/v1/time') {
    return json(res, 200, { now: Date.now() });
  }
  if (p === '/api/v1/daily') {
    const date = u.searchParams.get('date') || Content.utcDateString(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'bad-date' });
    const cfg = Content.dailyConfig(date);
    return json(res, 200, {
      date, version: cfg.version, seed: cfg.seed, layers: cfg.layers, sectors: cfg.sectors,
      armorPct: cfg.armorPct, gapPct: cfg.gapPct, rotSpeed: cfg.rotSpeed, fallSpeed: cfg.fallSpeed,
      timeLimitSec: cfg.timeLimitSec, par: cfg.par, theme: cfg.theme
    });
  }
  if (p === '/api/v1/leaderboard') {
    const board = u.searchParams.get('board') || 'score';
    return json(res, 200, { board, validated: true, entries: boards[board] || [] });
  }
  if (p === '/api/v1/score' && req.method === 'POST') {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); res.end('{"error":"too-large"}'); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return json(res, 400, { error: 'bad-json' }); }
      const r = submitScore(body);
      json(res, r.status, r.json);
    });
    return;
  }
  if (p.startsWith('/api/')) return json(res, 404, { error: 'not-found' });

  // static files (distribution root only; no traversal)
  let rel;
  try { rel = decodeURIComponent(p); }       // malformed %-escapes must not throw
  catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT + path.sep) || filePath.includes('..') ||
      /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(filePath.slice(ROOT.length))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Core Breaker server listening on http://localhost:' + PORT);
  });
}

module.exports = { server, validateSubmission, submitScore };
