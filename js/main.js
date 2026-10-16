/* Core Breaker — UI shell, input, play lifecycle, persistence glue.
 * UI state and simulation state are strictly separate: all rules mutations
 * go through Rules.applyCommand; rendering reads snapshots only.
 *
 * Game-state model:
 *   title → mode-select → intro(preparing) → countdown → active ↔ paused
 *   → resolving → results → progression
 */
(function () {
  'use strict';

  var Rules = window.CBRules, Content = window.CBContent, Audio = window.CBAudio,
      Render = window.CBRender, Session = window.CBSession, RNG = window.CBRNG, Gfx = window.CBGfx;

  var $ = function (id) { return document.getElementById(id); };

  // ---------- localization (js/i18n.js: window.CBI18N) ----------
  // English source strings are the keys. T() translates now; N() only marks a
  // string for translation at display time. Content data stays English.
  function T(key, vars) {
    if (window.CBI18N) return window.CBI18N.T(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? String(vars[k]) : m; });
  }
  function N(key) { return key; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function curLangs() { return window.CBI18N && window.CBI18N.lang ? [window.CBI18N.lang] : (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]); }
  // Display name of a round configuration in the current language.
  function cfgName(cfg, kind) {
    if (!cfg) return '';
    if (cfg.kind === 'daily' && cfg.date) return T('Daily {date}', { date: cfg.date });
    if (cfg.practiceName) return T('Practice — {name}', { name: T(cfg.practiceName) });
    return cfg.name ? T(cfg.name) : (kind || '');
  }

  // ---------- formatting ----------

  function fmtTime(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var neg = ms < 0; if (neg) ms = -ms;
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return (neg ? '-' : '') + m + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtScore(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }

  // ---------- module state ----------

  var playState = null;       // rules snapshot (null when not playing)
  var playCfg = null, playKind = null, playName = '';
  var playCtx = null;         // {lesson?, levelIndex?, date?, challenge?}
  var tickTimer = null, rafId = null, lastFrameTs = 0;
  var countdownTimer = null, resultsTimer = null;
  var paused = false, countingDown = false, resultsShown = false;
  var inputLog = [];          // replay envelope: ordered validated commands
  var cmdSeq = 0;
  var serverOffsetMs = null;  // round-trip-adjusted server time offset
  var screenStack = ['screen-title'];
  var countdownLeft = 0;
  var timerWarned = false;    // one containment warning per round

  // ---------- live announcements ----------

  var liveTimer = null;
  function announce(msg, assertive) {
    var el = assertive ? $('live-alert') : $('live-region');
    el.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { el.textContent = msg; }, 30);
  }

  var captionTimer = null;
  function caption(text) {
    if (!Session.getSetting('captions')) return;
    var el = $('caption-bar');
    var m = /^crystal break ×(\d+)$/.exec(text);
    el.textContent = '♪ ' + (m ? T('crystal break ×{n}', { n: m[1] }) : T(text));
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { el.textContent = ''; }, 1400);
  }

  var PT = {
    'en-US': { offline: 'Offline — progress is stored on this device.', playing: 'Playing as {name}', synced: 'progress synced', saving: 'saving…', nosync: 'cloud sync unavailable', signIn: 'Sign in with StarHermit', invite: 'Invite a friend', copied: 'Invite link copied to the clipboard.', copyFail: 'Could not copy — invite link: {link}', lbPosting: 'Posting score to the leaderboard…', lbRank: 'Leaderboard rank: #{rank}', lbPosted: 'Score posted to the leaderboard.', lbNotPosted: 'Score not posted to the leaderboard.' },
    'en-GB': { offline: 'Offline — progress is stored on this device.', playing: 'Playing as {name}', synced: 'progress synced', saving: 'saving…', nosync: 'cloud sync unavailable', signIn: 'Sign in with StarHermit', invite: 'Invite a friend', copied: 'Invite link copied to the clipboard.', copyFail: 'Could not copy — invite link: {link}', lbPosting: 'Posting score to the leaderboard…', lbRank: 'Leaderboard rank: #{rank}', lbPosted: 'Score posted to the leaderboard.', lbNotPosted: 'Score not posted to the leaderboard.' },
    'es-419': { offline: 'Sin conexión: el progreso se guarda en este dispositivo.', playing: 'Jugando como {name}', synced: 'progreso sincronizado', saving: 'guardando…', nosync: 'sincronización en la nube no disponible', signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo', copied: 'Enlace de invitación copiado al portapapeles.', copyFail: 'No se pudo copiar. Enlace de invitación: {link}', lbPosting: 'Enviando la puntuación a la clasificación…', lbRank: 'Puesto en la clasificación: #{rank}', lbPosted: 'Puntuación enviada a la clasificación.', lbNotPosted: 'No se envió la puntuación a la clasificación.' },
    'es-ES': { offline: 'Sin conexión: el progreso se guarda en este dispositivo.', playing: 'Jugando como {name}', synced: 'progreso sincronizado', saving: 'guardando…', nosync: 'sincronización en la nube no disponible', signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo', copied: 'Enlace de invitación copiado al portapapeles.', copyFail: 'No se ha podido copiar. Enlace de invitación: {link}', lbPosting: 'Enviando la puntuación a la clasificación…', lbRank: 'Puesto en la clasificación: #{rank}', lbPosted: 'Puntuación enviada a la clasificación.', lbNotPosted: 'No se ha enviado la puntuación a la clasificación.' },
    'de-DE': { offline: 'Offline – der Fortschritt wird auf diesem Gerät gespeichert.', playing: 'Du spielst als {name}', synced: 'Fortschritt synchronisiert', saving: 'wird gespeichert…', nosync: 'Cloud-Synchronisierung nicht verfügbar', signIn: 'Mit StarHermit anmelden', invite: 'Freund einladen', copied: 'Einladungslink in die Zwischenablage kopiert.', copyFail: 'Kopieren fehlgeschlagen – Einladungslink: {link}', lbPosting: 'Punktzahl wird an die Bestenliste gesendet …', lbRank: 'Platz in der Bestenliste: #{rank}', lbPosted: 'Punktzahl an die Bestenliste gesendet.', lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.' },
    'fr-FR': { offline: 'Hors ligne : la progression est enregistrée sur cet appareil.', playing: 'Vous jouez en tant que {name}', synced: 'progression synchronisée', saving: 'enregistrement…', nosync: 'synchronisation cloud indisponible', signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami', copied: 'Lien d’invitation copié dans le presse-papiers.', copyFail: 'Copie impossible — lien d’invitation : {link}', lbPosting: 'Envoi du score au classement…', lbRank: 'Rang au classement : #{rank}', lbPosted: 'Score envoyé au classement.', lbNotPosted: 'Score non envoyé au classement.' },
    'fr-CA': { offline: 'Hors ligne : la progression est enregistrée sur cet appareil.', playing: 'Vous jouez en tant que {name}', synced: 'progression synchronisée', saving: 'enregistrement…', nosync: 'synchronisation infonuagique non disponible', signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami', copied: 'Lien d’invitation copié dans le presse-papiers.', copyFail: 'Copie impossible — lien d’invitation : {link}', lbPosting: 'Envoi du pointage au classement…', lbRank: 'Rang au classement : #{rank}', lbPosted: 'Pointage envoyé au classement.', lbNotPosted: 'Pointage non envoyé au classement.' },
    'pt-BR': { offline: 'Offline — o progresso fica salvo neste dispositivo.', playing: 'Jogando como {name}', synced: 'progresso sincronizado', saving: 'salvando…', nosync: 'sincronização na nuvem indisponível', signIn: 'Entrar com StarHermit', invite: 'Convidar um amigo', copied: 'Link de convite copiado para a área de transferência.', copyFail: 'Não foi possível copiar — link de convite: {link}', lbPosting: 'Enviando a pontuação para o ranking…', lbRank: 'Posição no ranking: #{rank}', lbPosted: 'Pontuação enviada para o ranking.', lbNotPosted: 'A pontuação não foi enviada para o ranking.' },
    'it-IT': { offline: 'Offline: i progressi sono salvati su questo dispositivo.', playing: 'Giochi come {name}', synced: 'progressi sincronizzati', saving: 'salvataggio…', nosync: 'sincronizzazione cloud non disponibile', signIn: 'Accedi con StarHermit', invite: 'Invita un amico', copied: 'Link di invito copiato negli appunti.', copyFail: 'Impossibile copiare. Link di invito: {link}', lbPosting: 'Invio del punteggio alla classifica…', lbRank: 'Posizione in classifica: #{rank}', lbPosted: 'Punteggio inviato alla classifica.', lbNotPosted: 'Punteggio non inviato alla classifica.' }
  };
  var P_STR = PT[Gfx.pickLocale(curLangs())] || PT['en-US']; // follows the game language

  // ---------- key bindings (platform overrides via StarHermit controls) ----------
  var DEFAULT_KEYS = { dive: ['Space'], toggle: ['Enter'], pause: ['KeyP'], undo: ['KeyU'], retry: ['KeyR'], back: ['Escape'] };
  var bindings = DEFAULT_KEYS, keyAction = {};
  function setBindings(b) {
    bindings = b; keyAction = {};
    Object.keys(b).forEach(function (a) { (b[a] || []).forEach(function (code) { keyAction[code] = a; }); });
  }
  setBindings(DEFAULT_KEYS);
  function keyName(code) {
    var arrow = /^Arrow(.*)$/.exec(code);
    if (arrow) return T('{dir} arrow', { dir: T({ Up: N('Up'), Down: N('Down'), Left: N('Left'), Right: N('Right') }[arrow[1]] || arrow[1]) });
    if (code === 'Space') return T('Space');
    if (code === 'Enter') return T('Enter');
    if (code === 'Escape') return T('Escape');
    return String(code).replace(/^Key/, '').replace(/^Digit/, '');
  }
  function keysFor(action) { return (bindings[action] || []).map(keyName).join(' / '); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.opacity = '0';
      // re-hide once faded so it never lingers over the HUD
      toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 500);
    }, 2600);
  }

  // ---------- screens ----------

  var SCREENS = ['screen-title', 'screen-journey', 'screen-practice', 'screen-challenge', 'screen-daily', 'screen-score'];

  function showScreen(id, replace) {
    for (var i = 0; i < SCREENS.length; i++) $(SCREENS[i]).classList.toggle('hidden', SCREENS[i] !== id);
    if (replace) screenStack = [id];
    else if (screenStack[screenStack.length - 1] !== id) screenStack.push(id);
    var first = $(id).querySelector('button');
    if (first) first.focus({ preventScroll: true });
    resetScroll($(id));
    if (id === 'screen-journey') renderJourneyGrid();
    if (id === 'screen-daily') renderDailyScreen();
    if (id === 'screen-score') renderScoreScreen();
    if (id === 'screen-title') renderTitleProgress();
  }

  function goBack() {
    if (screenStack.length > 1) {
      screenStack.pop();
      showScreen(screenStack[screenStack.length - 1], true);
      if (screenStack.length === 0) screenStack = ['screen-title'];
    } else showScreen('screen-title', true);
  }

  // ---------- overlays ----------

  var OVERLAYS = ['overlay-intro', 'overlay-pause', 'overlay-results', 'overlay-settings', 'overlay-help'];
  var overlayReturnFocus = null;

  function openOverlay(id) {
    overlayReturnFocus = document.activeElement;
    $(id).classList.remove('hidden');
    var first = $(id).querySelector('button.primary') || $(id).querySelector('button');
    if (first) first.focus({ preventScroll: true });
    resetScroll($(id));
  }
  // Screens and dialogs open at their top (heading visible), even when the
  // focused button (often Done at the bottom) is below the fold.
  function resetScroll(root) {
    root.scrollTop = 0;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) if (all[i].scrollTop) all[i].scrollTop = 0;
  }
  function closeOverlay(id) {
    $(id).classList.add('hidden');
    if (overlayReturnFocus && overlayReturnFocus.focus) overlayReturnFocus.focus();
    overlayReturnFocus = null;
  }
  function anyOverlayOpen() {
    for (var i = 0; i < OVERLAYS.length; i++) if (!$(OVERLAYS[i]).classList.contains('hidden')) return true;
    return false;
  }

  // ---------- settings ----------

  var SETTING_IDS = {
    'set-music': 'volMusic', 'set-sfx': 'volSfx', 'set-amb': 'volAmbience',
    'set-mute': 'muted', 'set-captions': 'captions',
    'set-motion': 'reducedMotion', 'set-contrast': 'highContrast',
    'set-large-text': 'largeText', 'set-lefty': 'leftHanded',
    'set-toggle': 'holdToggle', 'set-assist': 'timingAssist', 'set-theme': 'theme'
  };

  function loadSettingsUI() {
    for (var elId in SETTING_IDS) {
      var el = $(elId), key = SETTING_IDS[elId], val = Session.getSetting(key);
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    }
    loadGfxUI();
  }

  function applySettings() {
    Audio.setVolumes(
      Session.getSetting('volMusic') / 100,
      Session.getSetting('volSfx') / 100,
      Session.getSetting('volAmbience') / 100);
    Audio.setMuted(!!Session.getSetting('muted'));
    Render.setGraphics(savedGfx());
    Render.setReducedMotion(!!Session.getSetting('reducedMotion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    Render.setHighContrast(!!Session.getSetting('highContrast'));
    document.body.classList.toggle('high-contrast', !!Session.getSetting('highContrast'));
    document.body.classList.toggle('large-text', !!Session.getSetting('largeText'));
    document.body.classList.toggle('left-handed', !!Session.getSetting('leftHanded'));
  }

  // ---------- graphics settings (quality model in js/gfx.js) ----------

  var gfxStr = Gfx.strings(Gfx.pickLocale(curLangs()));

  // Saved graphics = the `quality` preset plus the `gfx` overrides object in the settings doc.
  function savedGfx() {
    var o = {}, g = Session.getSetting('gfx') || {};
    for (var k in g) o[k] = g[k];
    o.preset = Gfx.normalizePreset(Session.getSetting('quality'));
    return o;
  }
  function storeGfx(o) {
    var g = {};
    for (var k in o) if (k !== 'preset') g[k] = o[k];
    Session.setSetting('quality', o.preset || 'auto');
    Session.setSetting('gfx', g);
    Render.setGraphics(savedGfx());
    loadGfxUI();
    setTimeout(refreshGfxSummary, 250); // post chain rebuilds on the next frame
  }

  function buildGfxUI() {
    var host = $('gfx-cats');
    Gfx.CATEGORY_ORDER.forEach(function (cat) {
      var row = document.createElement('div');
      row.className = 'settings-row';
      var label = document.createElement('label');
      label.setAttribute('for', 'set-gfx-' + cat);
      label.textContent = gfxStr.cats[cat];
      var sel = document.createElement('select');
      sel.id = 'set-gfx-' + cat;
      sel.setAttribute('data-gfx-cat', cat);
      sel.appendChild(new Option('', 'preset'));
      Gfx.CATEGORIES[cat].forEach(function (t) { sel.appendChild(new Option(gfxStr.tiers[t] || t, t)); });
      sel.addEventListener('change', function () {
        var o = savedGfx();
        if (sel.value === 'preset') delete o[cat]; else o[cat] = sel.value;
        storeGfx(o);
      });
      row.appendChild(label); row.appendChild(sel);
      host.appendChild(row);
    });
    var texts = document.querySelectorAll('[data-gfx-text]');
    for (var i = 0; i < texts.length; i++) texts[i].textContent = gfxStr[texts[i].getAttribute('data-gfx-text')];
    $('set-quality').addEventListener('change', function () {
      storeGfx(Gfx.choosePreset(savedGfx(), $('set-quality').value)); // a preset clears overrides
    });
    $('set-gfx-scale').addEventListener('input', function () {
      var o = savedGfx();
      o.render_scale = Number($('set-gfx-scale').value) / 100;
      $('gfx-scale-val').textContent = $('set-gfx-scale').value + '%';
      storeGfx(o);
    });
    ['adaptive', 'show_fps'].forEach(function (key) {
      var el = $(key === 'adaptive' ? 'set-gfx-adaptive' : 'set-gfx-fps');
      el.addEventListener('change', function () { var o = savedGfx(); o[key] = el.checked; storeGfx(o); });
    });
  }

  function loadGfxUI() {
    var info = Render.graphicsInfo ? Render.graphicsInfo() : null;
    var s = savedGfx(), detected = info ? info.detected : 'balanced';
    var r = Gfx.resolve(s, detected);
    var qs = $('set-quality');
    for (var i = 0; i < qs.options.length; i++) {
      var v = qs.options[i].value;
      qs.options[i].textContent = v === 'auto'
        ? Gfx.fmt(gfxStr.auto, { tier: gfxStr.presets[detected] }) : gfxStr.presets[v];
    }
    qs.value = s.preset;
    var pct = Math.round(r.userScale * 100);
    $('set-gfx-scale').value = pct;
    $('gfx-scale-val').textContent = pct + '%';
    Gfx.CATEGORY_ORDER.forEach(function (cat) {
      var sel = $('set-gfx-' + cat);
      var tier = Gfx.presetTier(r.preset, cat);
      sel.options[0].textContent = Gfx.fmt(gfxStr.fromPreset, { tier: gfxStr.tiers[tier] || tier });
      sel.value = Gfx.CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : 'preset';
    });
    $('set-gfx-adaptive').checked = r.adaptive;
    $('set-gfx-fps').checked = r.showFps;
    refreshGfxSummary();
  }

  function refreshGfxSummary() {
    var info = Render.graphicsInfo ? Render.graphicsInfo() : null;
    if (!info || !info.resolved) { $('gfx-summary').textContent = ''; return; }
    $('gfx-summary').textContent = [info.gpu || gfxStr.unknownGpu,
      Gfx.describe(info.resolved, info.pixels[0] ? info.pixels : null, gfxStr)].join(' · ');
    $('gfx-summary').setAttribute('data-gfx-preset', info.resolved.preset);
    var note = $('gfx-post-note');
    note.textContent = gfxStr.postFailed;
    note.classList.toggle('hidden', !(info.postFailed && info.resolved.post));
  }

  function bindSettings() {
    for (var elId in SETTING_IDS) {
      (function (elId) {
        var el = $(elId), key = SETTING_IDS[elId];
        el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function () {
          var val = (el.type === 'checkbox') ? (el.checked ? 1 : 0)
            : (el.tagName === 'SELECT' ? el.value : Number(el.value));
          Session.setSetting(key, val);
          applySettings();
        });
      })(elId);
    }
  }

  // ---------- achievements ----------

  function tryUnlock(key) {
    if (Session.unlockAchievement(key, Date.now())) {
      var meta = null;
      for (var i = 0; i < Content.ACHIEVEMENTS.length; i++)
        if (Content.ACHIEVEMENTS[i].key === key) meta = Content.ACHIEVEMENTS[i];
      if (meta) {
        toast(T('Achievement: {name}', { name: T(meta.name) }));
        announce(T('Achievement unlocked: {name}. {desc}', { name: T(meta.name), desc: T(meta.desc) }));
        Audio.sfxAchievement();
      }
    }
  }

  function checkAchievements(s, won) {
    if (s.score.breaks > 0) tryUnlock('first-break');
    if (s.score.overdrives > 0) tryUnlock('overdrive');
    if (s.bestMult >= 8) tryUnlock('mult-8');
    if (won) tryUnlock('first-core');
    if (s.score.total >= 3000) tryUnlock('score-3000');
    var t = Session.getTotals();
    if (t.breaks >= 500) tryUnlock('breaks-500');
    var jwins = 0;
    for (var i = 0; i < Content.JOURNEY.length; i++) {
      var j = Session.getJourney(Content.JOURNEY[i].id);
      if (j && j.stars > 0) jwins++;
    }
    if (jwins >= 20) tryUnlock('journey-half');
    if (jwins >= 40) tryUnlock('journey-done');
    if (Session.dailyCount() >= 7) tryUnlock('daily-7');
  }

  // ---------- title / menus ----------

  function renderTitleProgress() {
    var t = Session.getTotals();
    var stars = Session.totalStars();
    var unlocked = Content.THEMES.filter(function (th) { return th.unlockStars <= stars; }).length;
    $('title-progress').textContent = t.rounds === 0
      ? T('New pilot — start with the Learn lessons or jump into Journey.')
      : T('Stars {stars} · Rounds {rounds} · Cores {wins} · Themes {themes}/{total}', { stars: stars, rounds: t.rounds, wins: t.wins, themes: unlocked, total: Content.THEMES.length });
  }

  function renderJourneyGrid() {
    var grid = $('journey-grid');
    grid.innerHTML = '';
    var prevDone = true; // level 1 always unlocked
    Content.JOURNEY.forEach(function (lv, idx) {
      var rec = Session.getJourney(lv.id);
      var b = document.createElement('button');
      b.type = 'button';
      b.disabled = !prevDone;
      b.className = (rec && rec.stars ? '' : (prevDone ? '' : 'locked')) + (lv.mastery ? ' mastery' : '');
      var stars = rec ? rec.stars : 0;
      b.innerHTML = '<span>' + (idx + 1) + '</span><span class="stars">' +
        (stars === 2 ? '★★' : stars === 1 ? '★' : (prevDone ? '·' : '🔒')) + '</span>';
      b.setAttribute('aria-label', T('Stage {n}: {name}', { n: idx + 1, name: T(lv.name) }) +
        (b.disabled ? ' ' + T('(locked)') : '') + (stars ? ', ' + T(stars === 1 ? '{n} star' : '{n} stars', { n: stars }) : ''));
      b.title = T(lv.name);
      b.addEventListener('click', function () { openIntro(lv, 'journey', { levelIndex: idx }); });
      grid.appendChild(b);
      prevDone = !!(rec && rec.stars > 0);
    });
  }

  function renderPracticeList() {
    var list = $('practice-list');
    list.innerHTML = '';
    Content.PRACTICE.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      var best = Session.getBest('practice-' + p.id);
      b.innerHTML = '<strong>' + esc(T(p.name)) + '</strong><span class="small">' +
        esc(T('{layers} layers · {sectors} sectors · armor {armor}%', { layers: p.layers, sectors: p.sectors, armor: Math.round(p.armorPct * 100) }) +
        (best != null ? ' · ' + T('best {score}', { score: fmtScore(best) }) : '')) + '</span>';
      b.addEventListener('click', function () {
        var cfg = Rules.clone(p);
        cfg.theme = Session.getSetting('theme') || 'void';
        cfg.seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0; // fresh practice shaft each run
        cfg.name = 'Practice — ' + p.name;
        cfg.practiceName = p.name; // display: T('Practice — {name}')
        openIntro(cfg, 'practice', {});
      });
      list.appendChild(b);
    });
  }

  function renderChallengeList() {
    var list = $('challenge-list');
    list.innerHTML = '';
    Content.CHALLENGES.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      var best = Session.getBest('challenge-' + c.id);
      b.innerHTML = '<strong>' + esc(T(c.name)) + '</strong><span class="small">' + esc(T(c.intro) +
        (best != null ? ' · ' + T('best {score}', { score: fmtScore(best) }) : '')) + '</span>';
      b.addEventListener('click', function () { openIntro(c, 'challenge', {}); });
      list.appendChild(b);
    });
  }

  function dailyNow() {
    return serverOffsetMs != null ? Date.now() + serverOffsetMs : Date.now();
  }

  function renderDailyScreen() {
    var dateStr = Content.utcDateString(dailyNow());
    var cfg = Content.dailyConfig(dateStr);
    $('daily-info').textContent = dateStr + ' · ' + T('{layers} layers · armor {armor}% · rotation {rot}', { layers: cfg.layers, armor: Math.round(cfg.armorPct * 100), rot: cfg.rotSpeed }) +
      (cfg.timeLimitSec ? ' · ' + T('{n}s containment timer', { n: cfg.timeLimitSec }) : '') +
      ' · ' + T('par {n}s', { n: cfg.par.timeSec });
    var d = Session.getDaily(dateStr);
    $('daily-status').textContent = d
      ? T(d.won ? 'Completed today: core reached, best {score}. You can improve your score.' : 'Completed today: attempt logged, best {score}. You can improve your score.', { score: fmtScore(d.score) })
      : T('Not attempted yet today. One shared seed for everyone.');
    updateDailyCountdown();
  }

  var dailyCdTimer = null;
  function updateDailyCountdown() {
    clearInterval(dailyCdTimer);
    var tick = function () {
      var now = dailyNow();
      var d = new Date(now);
      var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      var left = next - now;
      var h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000), s = Math.floor(left % 60000 / 1000);
      $('daily-countdown').textContent = T('Next daily in {h}h {m}m {s}s', { h: h, m: m, s: s }) + ' ' +
        (serverOffsetMs == null ? T('(local clock)') : T('(server time)'));
    };
    tick();
    dailyCdTimer = setInterval(tick, 1000);
  }

  function renderScoreScreen() {
    var best = Session.getBest('score');
    $('score-best').textContent = best != null ? fmtScore(best) : '—';
    var board = $('score-board');
    board.innerHTML = '';
    var local = JSON.parse(localStorage.getItem('corebreaker.scoreboard.v1') || '[]');
    var P = window.CBPlatform;
    if (P && P.hosted) {
      // Platform leaderboard (read-only): nicknames resolved, own row marked.
      P.fetchLeaderboard().then(function (entries) {
        if (!entries || !entries.length) return;
        var h = document.createElement('li');
        h.textContent = T('— platform board —');
        h.className = 'small';
        board.appendChild(h);
        entries.slice(0, 10).forEach(function (e, i) {
          var li = document.createElement('li');
          li.textContent = '#' + (i + 1) + ' ' + fmtScore(e.score) + ' — ' + e.name;
          board.appendChild(li);
        });
        var sep = document.createElement('li');
        sep.textContent = T('— this device —');
        sep.className = 'small';
        board.appendChild(sep);
      }).catch(function () {});
    }
    local.slice(0, 10).forEach(function (row) {
      var li = document.createElement('li');
      li.textContent = fmtScore(row.score) + ' — ' + T('depth {n}', { n: row.depth }) + ' (' + new Date(row.atMs).toLocaleDateString(window.CBI18N ? window.CBI18N.lang : undefined) + ')';
      board.appendChild(li);
    });
    if (!local.length && !(P && P.hosted)) {
      var li = document.createElement('li');
      li.textContent = T('No dives yet. Yours will appear here; hosted boards compare with friends.');
      board.appendChild(li);
    }
  }

  // ---------- mode intro (preparing) ----------

  function openIntro(cfg, kind, ctx) {
    playCfg = cfg; playKind = kind; playCtx = ctx;
    renderIntro();
    openOverlay('overlay-intro');
  }
  // Intro dialog text for the pending round (re-run on a language change).
  function renderIntro() {
    var cfg = playCfg, kind = playKind, ctx = playCtx || {};
    if (!cfg) return;
    $('intro-h').textContent = ctx.lesson ? T(ctx.lesson.title) : cfgName(cfg, kind);
    $('intro-text').textContent = ctx.lesson ? T(ctx.lesson.text) : (cfg.intro ? T(cfg.intro) : T('Reach the core at the bottom of the shaft.'));
    var meta = [T('{n} layers', { n: cfg.layers }), T('{n} sectors', { n: cfg.sectors })];
    if (cfg.timeLimitSec) meta.push(T('{n}s timer', { n: cfg.timeLimitSec }));
    if (cfg.chargeMax) meta.push(T('charge cell ×{n}', { n: cfg.chargeMax })); else meta.push(T('no charge cell'));
    meta.push(cfg.mechanics.undo ? T('undo on') : T('no undo'));
    meta.push(cfg.mechanics.hint ? T('hints on') : T('no hints'));
    meta.push(kind === 'tutorial' ? T('unranked')
      : kind === 'practice' ? T('local best only') : T('ranked locally'));
    $('intro-meta').textContent = meta.join(' · ');
  }

  // ---------- play lifecycle ----------

  function startPlay() {
    closeOverlay('overlay-intro');
    // a restart may arrive mid-countdown or mid-round: cancel every pending
    // timer from the previous attempt before building the new one
    stopLoops();
    clearInterval(countdownTimer); countdownTimer = null;
    clearTimeout(resultsTimer); resultsTimer = null;
    playState = Rules.createGame(playCfg);
    playName = playCfg.name || playKind; // English (replays); shown via cfgName()
    inputLog = [];
    cmdSeq = 0;
    resultsShown = false;
    paused = false;
    timerWarned = false;

    for (var i = 0; i < SCREENS.length; i++) $(SCREENS[i]).classList.add('hidden');
    screenStack = ['screen-title'];
    $('hud').classList.remove('hidden');
    $('action-tray').classList.remove('hidden');
    $('btn-hold').textContent = Session.getSetting('holdToggle') ? T('TAP TO DIVE') : T('HOLD TO DIVE');
    $('hud-objective').textContent = objectiveText();
    $('hud-timer-wrap').style.display = playCfg.timeLimitSec ? '' : 'none';

    Render.setTheme(playCfg.theme || 'void');
    Render.clearWindow();
    Audio.resume();
    Audio.startAmbience();
    Audio.startMusic();

    // countdown → active
    countingDown = true;
    countdownLeft = 3;
    announce(T('Get ready'), true);
    $('hintbar').textContent = '3';
    Audio.sfxCountdown();
    countdownTimer = setInterval(function () {
      if (paused) return; // a pause during the countdown holds it, too
      countdownLeft--;
      if (countdownLeft > 0) {
        $('hintbar').textContent = String(countdownLeft);
        Audio.sfxCountdown();
      } else {
        clearInterval(countdownTimer); countdownTimer = null;
        countingDown = false;
        $('hintbar').textContent = '';
        announce(T('Dive!') + ' ' + objectiveText(), true);
        startLoops();
      }
    }, 700);
  }

  function objectiveText() {
    if (!playCfg) return '';
    if (playCfg.endless) return T('Objective: descend as deep as you can. Armor ends the dive.');
    if (playCfg.timeLimitSec) return T('Objective: reach the core ({layers} layers) before containment vents in {n}s.', { layers: playCfg.layers, n: playCfg.timeLimitSec });
    return T('Objective: reach the core — {layers} layers down.', { layers: playCfg.layers });
  }

  function startLoops() {
    stopLoops();
    tickTimer = setInterval(tickStep, 1000 / 60);
    lastFrameTs = 0;
    rafId = requestAnimationFrame(frameLoop);
  }
  function stopLoops() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function tickStep() {
    if (!playState || paused || countingDown || playState.terminal) return;
    var r = Rules.applyCommand(playState, { type: 'wait', atTick: playState.tick + 1 });
    playState = r.state;
    handleEvents(r.events);
    updateHUD();
    if (playState.terminal) onTerminal();
  }

  function frameLoop(ts) {
    rafId = requestAnimationFrame(frameLoop);
    var dt = lastFrameTs ? ts - lastFrameTs : 16.7;
    lastFrameTs = ts;
    Render.draw(playState, dt);
  }

  function handleEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      Render.onEvent(e, playState);
      switch (e.type) {
        case 'break':
          Audio.sfxBreak(e.mult);
          Audio.setMusicIntensity(e.mult);
          if (playState && playState.charge === playCfg.chargeMax && e.charge === playCfg.chargeMax) Audio.sfxCharge();
          break;
        case 'pass': Audio.sfxPass(); break;
        case 'overdrive': Audio.sfxOverdrive(); announce(T('Overdrive! Armored segment smashed.'), false); break;
        case 'crash': Audio.sfxCrash(); announce(T('Armor impact — dive over.'), true); break;
        case 'win': Audio.sfxWin(); announce(T('Core reached!'), true); break;
        case 'lose': if (e.reason !== Rules.TERMINAL.ARMOR) { Audio.sfxLose(); announce(T('Dive over: {reason}', { reason: reasonText(e.reason) }), true); } break;
      }
      // tutorial lesson goal tracking
      if (playCtx && playCtx.lesson) checkLessonGoal(e);
    }
  }

  var lessonGoalCount = 0;
  function checkLessonGoal(e) {
    var goal = playCtx.lesson.goal;
    if (e.type === goal.event) {
      lessonGoalCount++;
      if (lessonGoalCount >= goal.count) {
        Session.markTutorialDone(playCtx.lesson.id);
        announce(T('Lesson complete: {title}', { title: T(playCtx.lesson.title) }), true);
        toast(T('Lesson complete: {title}', { title: T(playCtx.lesson.title) }));
        Audio.sfxLesson();
      }
    }
  }

  function reasonText(reason) {
    switch (reason) {
      case Rules.TERMINAL.CORE: return T('core reached');
      case Rules.TERMINAL.ARMOR: return T('armor impact');
      case Rules.TERMINAL.TIME: return T('containment vented (time up)');
      case Rules.TERMINAL.RESIGN: return T('resigned');
      default: return reason;
    }
  }

  // ---------- HUD ----------

  function updateHUD() {
    var s = playState;
    if (!s) return;
    $('hud-score').textContent = fmtScore(liveScore(s));
    $('hud-best').textContent = fmtScore(Session.getBest(bestKey()));
    var totalLayers = playCfg.endless ? '∞' : s.layers.length;
    $('hud-depth').textContent = s.depth + '/' + totalLayers;
    if (playCfg.timeLimitSec) {
      var left = playCfg.timeLimitSec * 1000 - s.elapsedMs;
      $('hud-timer').textContent = fmtTime(Math.max(0, left));
      $('hud-timer').style.color = left < 10000 ? 'var(--danger)' : '';
      if (left < 10000 && left > 0 && !timerWarned && !s.terminal) { timerWarned = true; Audio.sfxTimerWarn(); announce(T('Containment vents in 10 seconds.'), false); }
    }
    $('hud-mult').textContent = '×' + s.mult;
    var pips = $('charge-pips');
    var max = playCfg.chargeMax || 0;
    while (pips.children.length < max) {
      var d = document.createElement('span');
      d.className = 'pip';
      pips.appendChild(d);
    }
    for (var i = 0; i < pips.children.length; i++) {
      pips.children[i].style.display = i < max ? '' : 'none';
      pips.children[i].classList.toggle('on', i < s.charge);
    }
    pips.setAttribute('aria-label', T('Charge {n} of {max}', { n: s.charge, max: max }));
    var canUndo = Rules.legalActions(s).indexOf('undo') >= 0;
    $('btn-hud-undo').disabled = !canUndo;
    $('btn-tray-undo').disabled = !canUndo;
    updateHint();
  }

  // mid-round HUD shows live component sum; bonuses finalize at terminal
  function liveScore(s) {
    return s.score.breakPoints + s.score.passPoints + s.score.overdrivePoints;
  }

  function updateHint() {
    var s = playState, bar = $('hintbar');
    if (!s || s.terminal || !playCfg.mechanics.hint || countingDown) { if (!countingDown) bar.textContent = ''; return; }
    var h = Rules.hint(s);
    if (!h) { bar.textContent = ''; return; }
    var p = h.peek;
    var seg = p.segment === 0 ? (Session.getSetting('highContrast') ? T('SAFE (bright)') : T('safe crystal'))
      : p.segment === 1 ? (p.chargeReady ? T('armor — OVERDRIVE READY') : T('ARMOR — release!'))
      : T('gap — fall through');
    var assist = Session.getSetting('timingAssist');
    var ms = assist ? Math.max(0, p.ms - 100) : p.ms;
    bar.textContent = seg + ' · ' + (ms < 500 ? '<0.5s' : (ms / 1000).toFixed(1) + 's');
    bar.style.borderColor = p.willCrash ? 'var(--danger)' : (p.segment === 1 ? 'var(--accent-2)' : 'var(--panel-border)');
  }

  // ---------- input ----------
  // Double-commit protection: press/release carry a monotonically increasing
  // command id; the rules engine additionally rejects no-op transitions.

  function cmdPress() {
    if (!playState || paused || countingDown || anyOverlayOpen() || playState.terminal) return;
    if (playState.holding) return;
    var cmd = { type: 'press', atTick: playState.tick, id: 'c' + (++cmdSeq) };
    var r = Rules.applyCommand(playState, cmd);
    if (!r.ok) return;
    playState = r.state;
    inputLog.push(cmd);
    Audio.resume();
    Audio.sfxPress();
    $('btn-hold').classList.add('held');
    handleEvents(r.events);
    updateHUD();
    if (playState.terminal) onTerminal();
  }

  function cmdRelease() {
    if (!playState || paused || countingDown || playState.terminal) return;
    if (!playState.holding) return;
    var cmd = { type: 'release', atTick: playState.tick, id: 'c' + (++cmdSeq) };
    var r = Rules.applyCommand(playState, cmd);
    if (!r.ok) return;
    playState = r.state;
    inputLog.push(cmd);
    Audio.sfxRelease();
    Audio.setMusicIntensity(0);
    $('btn-hold').classList.remove('held');
    handleEvents(r.events);
    updateHUD();
  }

  function doUndo() {
    if (!playState || paused || countingDown || anyOverlayOpen()) return;
    var cmd = { type: 'undo', atTick: playState.tick, id: 'c' + (++cmdSeq) };
    var r = Rules.applyCommand(playState, cmd);
    if (!r.ok) { announce(T('Nothing to undo.'), false); return; }
    playState = r.state;
    inputLog.push(cmd);
    Audio.sfxUndo();
    announce(T('Rewound to your last release.'), false);
    handleEvents(r.events);
    updateHUD();
  }

  // pointer hold on canvas + hold button. The hold belongs to the pointer
  // that started it (id + type): a second finger, or a tap elsewhere that
  // steals capture, must not end a dive the first pointer is still holding.
  var holdPointer = null;
  function isHoldPointer(ev) {
    return !!holdPointer && ev.pointerId === holdPointer.id && ev.pointerType === holdPointer.type;
  }
  function bindHold(el) {
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      if (holdPointer && !isHoldPointer(ev)) return; // another pointer already owns the hold
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      holdPointer = { id: ev.pointerId, type: ev.pointerType };
      if (Session.getSetting('holdToggle')) {
        if (playState && playState.holding) cmdRelease(); else cmdPress();
      } else cmdPress();
    });
    el.addEventListener('pointerup', holdUp);
    el.addEventListener('pointercancel', holdUp);
    el.addEventListener('lostpointercapture', holdUp);
  }
  function holdUp(ev) {
    if (!isHoldPointer(ev)) return;
    holdPointer = null;
    if (!Session.getSetting('holdToggle')) cmdRelease();
  }
  // safety net if capture was refused and the pointer lifts elsewhere
  document.addEventListener('pointerup', holdUp);
  document.addEventListener('pointercancel', holdUp);
  bindHold($('game-canvas'));
  bindHold($('btn-hold'));
  $('game-canvas').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // keyboard
  var spaceHeld = false;
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var action = keyAction[e.code];
    if (!action) return;
    var playing = playState && !$('hud').classList.contains('hidden');
    if (action === 'dive') {
      if (!playing || anyOverlayOpen()) return;
      e.preventDefault();
      spaceHeld = e.code;
      if (Session.getSetting('holdToggle')) {
        if (playState.holding) cmdRelease(); else cmdPress();
      } else cmdPress();
    } else if (action === 'toggle' && playing && !anyOverlayOpen()) {
      e.preventDefault();
      if (playState.holding) cmdRelease(); else cmdPress();
    } else if (action === 'pause' && playing) {
      if ($('overlay-pause').classList.contains('hidden')) pauseGame(); else resumeGame();
    } else if (action === 'undo' && playing) {
      doUndo();
    } else if (action === 'retry' && playing && !$('overlay-results').classList.contains('hidden')) {
      retry();
    } else if (action === 'back') {
      if (!$('overlay-settings').classList.contains('hidden')) closeOverlay('overlay-settings');
      else if (!$('overlay-help').classList.contains('hidden')) closeOverlay('overlay-help');
      else if (!$('overlay-results').classList.contains('hidden')) { /* stay until choice */ }
      else if (!$('overlay-pause').classList.contains('hidden')) resumeGame();
      else if (playing) pauseGame();
      else goBack();
    }
  });
  document.addEventListener('keyup', function (e) {
    if (spaceHeld && e.code === spaceHeld) {
      spaceHeld = false;
      if (!Session.getSetting('holdToggle')) cmdRelease();
    }
  });

  // ---------- pause / resume / quit ----------

  function pauseGame() {
    if (!playState || playState.terminal) return;
    paused = true;
    openOverlay('overlay-pause');
    announce(T('Paused'), false);
  }
  function resumeGame() {
    paused = false;
    closeOverlay('overlay-pause');
    announce(T('Resumed'), false);
  }
  function quitToTitle() {
    stopLoops();
    clearInterval(countdownTimer); countdownTimer = null;
    clearTimeout(resultsTimer); resultsTimer = null;
    countingDown = false;
    paused = false;
    playState = null;
    Audio.stopMusic();
    $('hud').classList.add('hidden');
    $('action-tray').classList.add('hidden');
    $('hintbar').textContent = '';
    closeOverlay('overlay-pause');
    if (!$('overlay-results').classList.contains('hidden')) closeOverlay('overlay-results');
    showScreen('screen-title', true);
    // resume the idle shaft render behind the menus
    lastFrameTs = 0;
    rafId = requestAnimationFrame(frameLoop);
  }

  // backgrounding pauses solo simulation
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (playState && !playState.terminal && !paused && !countingDown) pauseGame();
      Audio.stopAmbience();
    } else {
      Audio.startAmbience();
      Render.resize();
    }
  });
  window.addEventListener('resize', function () { Render.resize(); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { Render.resize(); }, 60); });

  // ---------- terminal / results ----------

  function bestKey() {
    if (playKind === 'tutorial') return 'tutorial'; // lessons never touch ranked boards
    if (playKind === 'practice') return 'practice-' + (playCtx.presetId || playCfg.id);
    if (playKind === 'challenge') return 'challenge-' + playCfg.id;
    if (playKind === 'score') return 'score';
    if (playKind === 'daily') return 'daily';
    return 'journey';
  }

  function onTerminal() {
    if (resultsShown) return;
    resultsShown = true;
    stopLoops();
    // settle render for a beat, then show results
    rafId = requestAnimationFrame(frameLoop);
    resultsTimer = setTimeout(showResults, 900);
  }

  function showResults() {
    resultsTimer = null;
    if (!playState || !playState.terminal) return; // round was abandoned mid-settle
    var s = playState, t = s.terminal;
    cancelAnimationFrame(rafId); rafId = null;
    Audio.stopMusic();

    var won = t.won;
    var parMet = !!(playCfg.par && playCfg.par.timeSec && s.elapsedMs <= playCfg.par.timeSec * 1000);

    // persistence + progression
    Session.addTotals(s.score.breaks, won);
    var isNewBest = false;
    if (playKind !== 'tutorial') isNewBest = Session.submitBest(bestKey(), s.score.total, Date.now());
    if (playKind === 'journey' && playCtx.levelIndex != null) {
      Session.recordJourney(playCfg.id, won, s.score.total, parMet);
    }
    if (playKind === 'daily' && playCtx.date) Session.recordDaily(playCtx.date, s.score.total, won);
    if (playKind === 'score') recordLocalBoard(s);
    checkAchievements(s, won);

    // replay envelope (schema v1)
    var replay = {
      v: 1, contentVersion: playCfg.version, cfg: playCfg,
      seed: playCfg.seed, log: inputLog,
      hash: Rules.hashState(s), score: s.score.total, atMs: Date.now()
    };
    Session.saveReplay(replay);

    if (isNewBest && playKind !== 'tutorial') Audio.sfxNewBest();
    lastResults = { s: s, won: won, parMet: parMet, isNewBest: isNewBest, replay: replay, commands: inputLog.length };
    renderResults();

    var nextBtn = $('btn-next');
    if (playKind === 'journey' && won && playCtx.levelIndex != null && playCtx.levelIndex + 1 < Content.JOURNEY.length) {
      nextBtn.classList.remove('hidden');
    } else if (playCtx && playCtx.lesson) {
      var lessons = Content.tutorialLessons();
      var li = lessons.indexOf(playCtx.lesson);
      nextBtn.classList.toggle('hidden', !(li >= 0 && li + 1 < lessons.length));
    } else nextBtn.classList.add('hidden');

    postToLeaderboard(s.score.total);
    openOverlay('overlay-results');
    announce((won ? T('Victory.') : T('Defeat.')) + ' ' + T('Total score {n}.', { n: s.score.total }) + ' ' + reasonText(t.reason), true);
  }

  // Results card from the stored round result (re-run on a language change).
  var lastResults = null;
  function renderResults() {
    var R = lastResults;
    if (!R) return;
    var s = R.s, won = R.won, parMet = R.parMet;
    $('res-headline').textContent = won ? T('Core Reached!') : T('Dive Over');
    $('res-reason').textContent = cfgName(playCfg, playKind) + ' — ' + reasonText(s.terminal.reason) +
      ' · ' + T('time {time}', { time: fmtTime(s.elapsedMs) }) + (parMet ? ' · ' + T('par beaten') : '');

    var rows = [
      [T('Breaks'), s.score.breaks + ' → ' + fmtScore(s.score.breakPoints)],
      [T('Gap passes'), s.score.passes + ' → ' + fmtScore(s.score.passPoints)],
      [T('Overdrives'), s.score.overdrives + ' → ' + fmtScore(s.score.overdrivePoints)]
    ];
    if (won) {
      rows.push([T('Time bonus'), fmtScore(s.score.timeBonus)]);
      rows.push([T('Momentum bonus'), fmtScore(s.score.multBonus) + ' ' + T('(best ×{n})', { n: s.bestMult })]);
      rows.push([T('Charge bonus'), fmtScore(s.score.chargeBonus)]);
    }
    var html = rows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('');
    html += '<tr class="total"><td>' + esc(T('Total')) + '</td><td>' + fmtScore(s.score.total) + '</td></tr>';
    $('res-breakdown').innerHTML = html;

    // results illustration: authored key art per outcome, hidden if it fails to load
    var art = $('res-art');
    var src = won ? './assets/core-reached.webp' : './assets/dive-over.webp';
    if (art.getAttribute('src') !== src) { art.classList.remove('hidden'); art.src = src; }

    var prog = [];
    if (R.isNewBest) prog.push(T('New personal best!'));
    if (playKind === 'journey' && won) {
      prog.push(parMet ? T('★★ Par beaten') : T('★ Stage clear'));
      var stars = Session.totalStars();
      var nextTheme = null;
      Content.THEMES.forEach(function (th) { if (th.unlockStars > stars && (!nextTheme || th.unlockStars < nextTheme.unlockStars)) nextTheme = th; });
      if (nextTheme) prog.push(T('{n} stars to unlock theme “{name}”', { n: nextTheme.unlockStars - stars, name: T(nextTheme.name) }));
    }
    if (playKind === 'daily') prog.push(T('Daily logged for {date}', { date: playCtx.date }));
    $('res-progress').textContent = prog.join(' · ');
    $('res-achievements').textContent = '';
    $('res-replay').textContent = T('Replay hash {hash} · seed {seed} · {n} commands', { hash: R.replay.hash.toString(16), seed: R.replay.seed, n: R.commands });
    renderLbLine();
  }

  // Signed in only: a finished Score Chase dive posts its total to the
  // platform high-score board and the results card shows the player's rank.
  var lbState = null; // null | 'posting' | { posted, rank }
  function postToLeaderboard(total) {
    var line = $('res-leaderboard'), P = window.CBPlatform;
    if (!line) return;
    if (playKind !== 'score' || !P || !P.hosted) { lbState = null; line.textContent = ''; line.classList.add('hidden'); return; }
    line.classList.remove('hidden');
    lbState = 'posting';
    renderLbLine();
    P.submitScore(total).then(function (r) { lbState = r; renderLbLine(); });
  }
  function renderLbLine() {
    var line = $('res-leaderboard'), r = lbState;
    if (!line || !r) return;
    line.textContent = r === 'posting' ? P_STR.lbPosting : !r.posted ? P_STR.lbNotPosted
      : r.rank ? P_STR.lbRank.replace('{rank}', r.rank) : P_STR.lbPosted;
  }

  function recordLocalBoard(s) {
    try {
      var key = 'corebreaker.scoreboard.v1';
      var rows = JSON.parse(localStorage.getItem(key) || '[]');
      rows.push({ score: s.score.total, depth: s.depth, atMs: Date.now() });
      rows.sort(function (a, b) { return b.score - a.score || a.atMs - b.atMs; });
      localStorage.setItem(key, JSON.stringify(rows.slice(0, 25)));
    } catch (e) {}
  }

  // ---------- server time (signed in only; standalone uses the local clock) ----------

  function syncServerTime() {
    var P = window.CBPlatform;
    if (!window.fetch || !P || !P.hosted) return; // no own-server request without a launch token
    var t0 = Date.now();
    fetch('/api/v1/time', { headers: P.headers() }).then(function (r) { return r.json(); }).then(function (res) {
      var t1 = Date.now();
      if (res && typeof res.now === 'number') {
        serverOffsetMs = res.now - Math.round((t0 + t1) / 2);
      }
    }).catch(function () { /* keep the local clock */ });
  }

  // ---------- retry / next ----------

  function retry() {
    closeOverlay('overlay-results');
    lessonGoalCount = 0;
    startPlay();
  }

  function nextStage() {
    closeOverlay('overlay-results');
    if (playKind === 'journey' && playCtx.levelIndex != null) {
      var nxt = Content.JOURNEY[playCtx.levelIndex + 1];
      openIntro(nxt, 'journey', { levelIndex: playCtx.levelIndex + 1 });
    } else if (playCtx && playCtx.lesson) {
      var lessons = Content.tutorialLessons();
      var li = lessons.indexOf(playCtx.lesson);
      if (li >= 0 && li + 1 < lessons.length) startLesson(lessons[li + 1]);
    }
  }

  // ---------- learn (tutorial) ----------

  function startLesson(lesson) {
    lessonGoalCount = 0;
    var cfg = Rules.clone(lesson.cfg);
    cfg.theme = 'void';
    cfg.name = lesson.title;
    openIntro(cfg, 'tutorial', { lesson: lesson });
  }

  function openLearnMenu() {
    var lessons = Content.tutorialLessons();
    var next = lessons.filter(function (l) { return !Session.isTutorialDone(l.id); })[0];
    startLesson(next || lessons[0]);
  }

  // ---------- help ----------

  function renderHelp() {
    var cards = [
      [T('Hold to dive'), T('Press and hold (mouse, touch, or Space). The striker smashes through bright crystal segments and builds momentum — each consecutive break is worth more.')],
      [T('Release for armor'), T('Dark spiked segments are armored. Landing on one ends the dive unless your charge cell is full. Release to hover and let a safe segment rotate in — hovering slowly bleeds descent progress.')],
      [T('Gaps'), T('Missing segments are gaps: you fall straight through, keep your streak, and gain a few points.')],
      [T('Charge & overdrive'), T('Safe breaks charge the striker. At full charge the next armored segment shatters too — an overdrive worth big points.')],
      [T('Momentum'), T('Releasing resets your ×multiplier. Long controlled streaks win stages and beat par.')],
      [T('Undo'), T('In relaxed modes each release banks a rewind point. Press U or Undo to return to your last release.')]
    ];
    $('help-cards').innerHTML = cards.map(function (c) {
      return '<p><strong>' + esc(c[0]) + '.</strong> ' + esc(c[1]) + '</p>';
    }).join('');
    var ctrls = [
      T('Mouse / touch: hold anywhere on the playfield (or the HOLD button) to dive; release to hover.'),
      T(Session.getSetting('holdToggle') ? '{keys}: hold to dive, release to hover (toggle mode: tap).' : '{keys}: hold to dive, release to hover.', { keys: keysFor('dive') }),
      T('{keys}: tap to toggle dive/hover.', { keys: keysFor('toggle') }),
      T('{pause} or {back}: pause / resume. {undo}: undo (where allowed). {retry}: retry from results.', { pause: keysFor('pause'), back: keysFor('back'), undo: keysFor('undo'), retry: keysFor('retry') })
    ];
    $('help-controls').innerHTML = ctrls.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
  }

  // ---------- wire up ----------

  function bind(id, fn) { $(id).addEventListener('click', function () { Audio.resume(); Audio.sfxUi(); fn(); }); }

  bind('btn-play', function () {
    // short path: continue journey at first unfinished stage, or Learn if new
    var t = Session.getTotals();
    if (t.rounds === 0 && !Session.isTutorialDone('t1')) { openLearnMenu(); return; }
    var idx = 0;
    for (var i = 0; i < Content.JOURNEY.length; i++) {
      var rec = Session.getJourney(Content.JOURNEY[i].id);
      if (rec && rec.stars > 0) idx = i + 1; else break;
    }
    idx = Math.min(idx, Content.JOURNEY.length - 1);
    openIntro(Content.JOURNEY[idx], 'journey', { levelIndex: idx });
  });
  bind('btn-learn', openLearnMenu);
  bind('btn-daily', function () { showScreen('screen-daily'); });
  bind('btn-journey', function () { showScreen('screen-journey'); });
  bind('btn-practice', function () { showScreen('screen-practice'); });
  bind('btn-challenge', function () { showScreen('screen-challenge'); });
  bind('btn-score', function () { showScreen('screen-score'); });
  bind('btn-settings', function () { loadSettingsUI(); openOverlay('overlay-settings'); });
  bind('btn-help', function () { renderHelp(); openOverlay('overlay-help'); });

  bind('btn-daily-play', function () {
    var dateStr = Content.utcDateString(dailyNow());
    openIntro(Content.dailyConfig(dateStr), 'daily', { date: dateStr });
  });
  bind('btn-score-play', function () {
    var cfg = Rules.clone(Content.SCORE_CHASE);
    cfg.seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
    openIntro(cfg, 'score', {});
  });

  bind('btn-intro-start', startPlay);
  bind('btn-intro-cancel', function () { closeOverlay('overlay-intro'); });

  bind('btn-hud-pause', pauseGame);
  bind('btn-hud-undo', doUndo);
  bind('btn-tray-undo', doUndo);
  bind('btn-resume', resumeGame);
  bind('btn-restart', function () { closeOverlay('overlay-pause'); lessonGoalCount = 0; startPlay(); });
  bind('btn-pause-settings', function () { loadSettingsUI(); openOverlay('overlay-settings'); });
  bind('btn-pause-help', function () { renderHelp(); openOverlay('overlay-help'); });
  bind('btn-quit', quitToTitle);

  bind('btn-retry', retry);
  bind('btn-next', nextStage);
  bind('btn-res-exit', quitToTitle);

  bind('btn-settings-close', function () { closeOverlay('overlay-settings'); });
  bind('btn-help-close', function () { closeOverlay('overlay-help'); });

  Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) {
    b.addEventListener('click', function () { Audio.sfxUi(); goBack(); });
  });

  // theme selects
  function fillThemeSelect(sel) {
    sel.innerHTML = '';
    var stars = Session.totalStars();
    Content.THEMES.forEach(function (th) {
      var opt = document.createElement('option');
      opt.value = th.id;
      opt.textContent = T(th.name) + (th.unlockStars > stars ? ' ' + T('({n}★ locked)', { n: th.unlockStars }) : '');
      opt.disabled = th.unlockStars > stars;
      sel.appendChild(opt);
    });
    sel.value = Session.getSetting('theme') || 'void';
  }
  var practiceTheme = $('practice-theme'), setTheme = $('set-theme');
  fillThemeSelect(practiceTheme);
  fillThemeSelect(setTheme);
  practiceTheme.addEventListener('change', function () { Session.setSetting('theme', practiceTheme.value); setTheme.value = practiceTheme.value; });

  // ---------- boot ----------

  // Account + cloud-sync status line on the title screen. Offline keeps the
  // identical local-only behaviour; hosted shows the account nickname.
  function renderAccountLine() {
    var el = $('account-line'), P = window.CBPlatform;
    if (!el || !P) return;
    $('btn-signin').classList.toggle('hidden', !P.canSignIn());
    $('btn-invite').classList.toggle('hidden', !(P.hosted && P.inviteLink()));
    $('platform-row').classList.toggle('hidden', !P.canSignIn() && !(P.hosted && P.inviteLink()));
    if (!P.hosted) { el.textContent = P_STR.offline; return; }
    var name = P.profile ? P.profile.name : '…';
    var syncTxt = P.sync === 'synced' ? P_STR.synced : P.sync === 'saving' ? P_STR.saving : P_STR.nosync;
    el.textContent = P_STR.playing.replace('{name}', name) + ' · ' + syncTxt;
  }

  function inviteFriend() {
    var link = window.CBPlatform.inviteLink();
    if (!link) return;
    var done = function () { toast(P_STR.copied); }, fail = function () { toast(P_STR.copyFail.replace('{link}', link)); };
    try { navigator.clipboard.writeText(link).then(done, fail); } catch (e) { fail(); }
  }

  // Signed-in boot work: profile, remote save (wins), settings KV, bindings.
  function syncFromPlatform() {
    var P = window.CBPlatform;
    if (!P.hosted) return;
    P.fetchProfile().then(renderAccountLine).catch(function () {});
    P.loadCloud().then(function (remoteRaw) {
      if (remoteRaw && Session.importWrapped(remoteRaw)) {
        applySettings();
        renderTitleProgress();
        renderPracticeList();
        renderChallengeList();
      }
      return P.getSettings();
    }).then(function (remote) {
      if (remote && Session.applyRemoteSettings(remote)) { applySettings(); loadSettingsUI(); }
      renderAccountLine();
    }).catch(function () {});
    P.loadBindings(DEFAULT_KEYS).then(function (b) { setBindings(b); renderHelp(); }).catch(function () {});
  }

  var webglMissing = false;

  // Game language changed (Settings → Language, or the account preference
  // arrived): js/i18n.js re-applied the static markup; re-render every string
  // built in code in place. The round, its clock and the shaft are untouched.
  function onLanguage() {
    P_STR = PT[Gfx.pickLocale(curLangs())] || PT['en-US'];
    gfxStr = Gfx.strings(Gfx.pickLocale(curLangs()));
    var texts = document.querySelectorAll('[data-gfx-text]');
    for (var i = 0; i < texts.length; i++) texts[i].textContent = gfxStr[texts[i].getAttribute('data-gfx-text')];
    Gfx.CATEGORY_ORDER.forEach(function (cat) {
      var sel = $('set-gfx-' + cat);
      if (!sel) return;
      var label = document.querySelector('label[for="set-gfx-' + cat + '"]');
      if (label) label.textContent = gfxStr.cats[cat];
      for (var j = 1; j < sel.options.length; j++) sel.options[j].textContent = gfxStr.tiers[sel.options[j].value] || sel.options[j].value;
    });
    loadGfxUI();
    $('btn-signin').textContent = P_STR.signIn;
    $('btn-invite').textContent = P_STR.invite;
    if (webglMissing) $('title-compat').textContent = T('WebGL is unavailable in this browser, so the 3D shaft cannot render. Your progress and settings are safe; try a browser with WebGL enabled.');
    renderAccountLine();
    renderTitleProgress();
    renderPracticeList();
    renderChallengeList();
    fillThemeSelect(practiceTheme);
    fillThemeSelect(setTheme);
    renderHelp();
    if (!$('screen-journey').classList.contains('hidden')) renderJourneyGrid();
    if (!$('screen-daily').classList.contains('hidden')) renderDailyScreen();
    if (!$('screen-score').classList.contains('hidden')) renderScoreScreen();
    if (!$('overlay-intro').classList.contains('hidden')) renderIntro();
    if (playState) {
      $('btn-hold').textContent = Session.getSetting('holdToggle') ? T('TAP TO DIVE') : T('HOLD TO DIVE');
      $('hud-objective').textContent = objectiveText();
      if (!countingDown) updateHUD();
    }
    if (!$('overlay-results').classList.contains('hidden')) renderResults();
  }
  document.addEventListener('cb-language', onLanguage);

  function boot() {
    // Platform handshake: StarHermit.init() reads the launch token.
    var P = window.CBPlatform;
    try { P.init(); } catch (e) { /* offline */ }
    P.onSync(renderAccountLine);
    P.onAuth(function () { renderAccountLine(); syncFromPlatform(); });
    // Save conflict: merge the newer cloud doc into this device's and save the
    // merge (Session.mergeWrapped keeps the better of both).
    P.onConflict(function (raw) {
      Session.mergeWrapped(raw);
      renderTitleProgress();
      renderPracticeList();
      renderChallengeList();
    });
    $('btn-signin').textContent = P_STR.signIn;
    $('btn-invite').textContent = P_STR.invite;
    $('btn-signin').addEventListener('click', function () { Audio.sfxUi(); P.signIn(); });
    $('btn-invite').addEventListener('click', function () { Audio.resume(); Audio.sfxUi(); inviteFriend(); });
    syncFromPlatform();
    var ok = false;
    try { ok = Render.init($('game-canvas')); } catch (e) { ok = false; }
    if (!ok || !Render.isAvailable()) {
      webglMissing = true;
      $('title-compat').textContent = T('WebGL is unavailable in this browser, so the 3D shaft cannot render. Your progress and settings are safe; try a browser with WebGL enabled.');
    }
    applySettings();
    renderPracticeList();
    renderChallengeList();
    bindSettings();
    buildGfxUI();
    Audio.onCaption(caption);
    $('res-art').addEventListener('error', function () { $('res-art').classList.add('hidden'); });
    syncServerTime();
    renderAccountLine();
    showScreen('screen-title', true);
    // idle render behind menus
    rafId = requestAnimationFrame(frameLoop);
  }

  boot();
})();
