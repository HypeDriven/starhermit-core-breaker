/* Core Breaker — StarHermit platform adapter (browser global: window.CBPlatform).
 * Launch-token lifecycle (fragment read + strip, Bearer, 45-min refresh),
 * profile nickname, cloud-save mirror for the checksummed session doc, and
 * the read-only platform leaderboard. The game's own-server validated score
 * submit/time routes are its backend (declared server=server.js) and are
 * called from main.js with these headers. Offline play is unchanged: no
 * token → localStorage only and zero hosted calls. Tokens are memory only.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
  var RETRY_MS = 60 * 1000;
  var SAVE_DEBOUNCE_MS = 2000;

  var token = null, userId = null, slug = null;
  var hosted = false;
  var profile = null;          // { name } for the signed-in player
  var sync = 'offline';        // offline | saving | synced (cloud mirror)
  var refreshTimer = null, retryTimer = null;
  var saveTimer = null, pendingSave = null;
  var profileNames = {};       // userId -> Promise<string>
  var syncListeners = [];

  function decodeJwt(t) {
    try {
      var seg = String(t).split('.')[1];
      if (!seg) return null;
      var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  // Fragment first (platform contract); query forms are local-dev only.
  function readLaunchToken() {
    try {
      var h = new URLSearchParams(String(root.location.hash || '').replace(/^#/, ''));
      var t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        var rest = h.toString();
        root.history.replaceState(null, '',
          root.location.pathname + root.location.search + (rest ? '#' + rest : ''));
        return t;
      }
      var q = new URLSearchParams(root.location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch (e) { return null; }
  }

  function headers(extra) {
    var h = extra || {};
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  function setSync(state) {
    if (sync === state) return;
    sync = state;
    for (var i = 0; i < syncListeners.length; i++) {
      try { syncListeners[i](state); } catch (e) { /* listener errors never break */ }
    }
  }

  // Minimal ZIP writer/reader (stored entries only, no compression).
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    var enc = new TextEncoder();
    var nameB = enc.encode(name);
    var crc = crc32(dataBytes);
    var out = [];
    var u16 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff); };
    var u32 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    var head = new Uint8Array(out);
    var cd = [];
    var c16 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff); };
    var c32 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
    var cdHead = new Uint8Array(cd);
    var cdOff = head.length + nameB.length + dataBytes.length;
    var parts = [head, nameB, dataBytes, cdHead, nameB];
    var eocd = [];
    var e32 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    var e16 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff); };
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    var total = 0, o = 0;
    for (var pi = 0; pi < parts.length; pi++) total += parts[pi].length;
    var buf = new Uint8Array(total);
    for (var pj = 0; pj < parts.length; pj++) { buf.set(parts[pj], o); o += parts[pj].length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    var dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    var off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      var method = dv.getUint16(off + 8, true);
      var size = dv.getUint32(off + 18, true);
      var nameLen = dv.getUint16(off + 26, true);
      var extraLen = dv.getUint16(off + 28, true);
      var dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Token refresh: scoped tokens may re-mint via the game's launch-token
  // route. Retry a failed re-mint after ~60 s.
  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshToken, REFRESH_MS);
  }
  function refreshToken() {
    if (!token || !slug) return Promise.resolve(false);
    return fetch('/api/v1/games/' + encodeURIComponent(slug) + '/launch-token', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}'
    }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
      if (j && typeof j.token === 'string' && j.token) {
        token = j.token; // memory only
        var claims = decodeJwt(token);
        if (claims && claims.sub) userId = claims.sub;
        if (claims && claims.game_scope) slug = claims.game_scope;
        return true;
      }
      retryRefresh();
      return false;
    }).catch(function () { retryRefresh(); return false; });
  }
  function retryRefresh() {
    if (retryTimer || !token) return;
    retryTimer = setTimeout(function () { retryTimer = null; refreshToken(); }, RETRY_MS);
  }

  // Nickname via GET /api/v1/users/{id}/profile — the only profile read a
  // game-scoped token may make. Never /api/v1/me, never usernames.
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    if (profileNames[pid]) return profileNames[pid];
    var p = fetch('/api/v1/users/' + encodeURIComponent(pid) + '/profile', { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null;
        return n || ('Player ' + pid.slice(0, 8));
      })
      .catch(function () { return 'Player ' + pid.slice(0, 8); });
    profileNames[pid] = p;
    return p;
  }
  function fetchProfile() {
    if (!userId) return Promise.resolve(null);
    return profileFor(userId).then(function (n) {
      profile = { name: n.slice(0, 40) };
      return profile;
    });
  }

  /* Cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug} holding
   * the wrapped session doc string. Remote wins on boot (validated by
   * CBSession.importWrapped); saves debounce ~2 s and flush on pagehide/
   * hidden with keepalive; localStorage stays the offline cache. */
  function loadCloud() {
    if (!hosted || !slug) return Promise.resolve(null);
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(slug), { headers: headers() })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('http-' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!buf || !buf.byteLength) return null;
        return new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf)));
      })
      .catch(function () { return null; });
  }
  function onLocalSave(wrapped) {
    if (!hosted || !slug) return;
    pendingSave = wrapped;
    setSync('saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!hosted || !slug || pendingSave == null) return Promise.resolve(false);
    var wrapped = pendingSave;
    pendingSave = null;
    var body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(wrapped))) };
    } catch (e) { return Promise.resolve(false); }
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      keepalive: true
    }).then(function (res) {
      if (res.ok) { setSync('synced'); return true; }
      pendingSave = pendingSave == null ? wrapped : pendingSave;
      setSync('offline');
      return false;
    }).catch(function () {
      pendingSave = pendingSave == null ? wrapped : pendingSave;
      setSync('offline');
      return false;
    });
  }

  /* Platform leaderboard (read-only; clients never submit): the game record
   * yields leaderboardId, entries resolve to nicknames. */
  function fetchLeaderboard() {
    if (!hosted || !slug) return Promise.resolve(null);
    return fetch('/api/v1/games/' + encodeURIComponent(slug), { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (g) {
        if (!g || !g.leaderboardId) return null;
        return fetch('/api/v1/leaderboards/' + encodeURIComponent(g.leaderboardId) +
          '/entries?page=1&pageSize=20', { headers: headers() });
      })
      .then(function (r) { return r ? (r.ok ? r.json() : null) : null; })
      .then(function (j) {
        if (!j) return null;
        var raw = (j.entries || j.items) || [];
        return Promise.all(raw.slice(0, 20).map(function (e) {
          var uid = e.userId != null ? e.userId : e.playerId;
          return profileFor(String(uid || '')).then(function (name) {
            return {
              name: String(uid || '') === userId ? 'You (' + name + ')' : name,
              score: e.score != null ? e.score : e.value,
            };
          });
        }));
      })
      .catch(function () { return null; });
  }

  function init() {
    token = readLaunchToken();
    if (token) {
      var claims = decodeJwt(token);
      if (!claims) token = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) slug = claims.game_scope;
        if (!userId || !slug) token = null; // not a usable launch token
      }
    }
    hosted = !!token;
    if (hosted) {
      scheduleRefresh();
      try {
        root.addEventListener('pagehide', flushSave);
        root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) flushSave(); });
      } catch (e) { /* no window events available */ }
      fetchProfile().catch(function () {});
    }
    return hosted;
  }

  return {
    init: init,
    headers: headers,
    profileFor: profileFor,
    fetchProfile: fetchProfile,
    refreshToken: refreshToken,
    loadCloud: loadCloud,
    onLocalSave: onLocalSave,
    flushSave: flushSave,
    fetchLeaderboard: fetchLeaderboard,
    onSync: function (fn) { if (typeof fn === 'function') syncListeners.push(fn); },
    get hosted() { return hosted; },
    get profile() { return profile; },
    get sync() { return sync; },
    get userId() { return userId; },
    get slug() { return slug; }
  };
});
