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
      Render = window.CBRender, Session = window.CBSession, RNG = window.CBRNG;

  var $ = function (id) { return document.getElementById(id); };

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
    el.textContent = '♪ ' + text;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { el.textContent = ''; }, 1400);
  }

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
    if (first) first.focus();
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
    if (first) first.focus();
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
    'set-mute': 'muted', 'set-captions': 'captions', 'set-quality': 'quality',
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
  }

  function applySettings() {
    Audio.setVolumes(
      Session.getSetting('volMusic') / 100,
      Session.getSetting('volSfx') / 100,
      Session.getSetting('volAmbience') / 100);
    Audio.setMuted(!!Session.getSetting('muted'));
    var q = Session.getSetting('quality');
    Render.setQuality(q === 'auto' ? autoQuality() : q);
    Render.setReducedMotion(!!Session.getSetting('reducedMotion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    Render.setHighContrast(!!Session.getSetting('highContrast'));
    document.body.classList.toggle('high-contrast', !!Session.getSetting('highContrast'));
    document.body.classList.toggle('large-text', !!Session.getSetting('largeText'));
    document.body.classList.toggle('left-handed', !!Session.getSetting('leftHanded'));
  }

  function autoQuality() {
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var small = Math.min(window.innerWidth, window.innerHeight) < 600;
    return (coarse || small) ? 'medium' : 'high';
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
        toast('Achievement: ' + meta.name);
        announce('Achievement unlocked: ' + meta.name + '. ' + meta.desc);
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
      ? 'New pilot — start with the Learn lessons or jump into Journey.'
      : 'Stars ' + stars + ' · Rounds ' + t.rounds + ' · Cores ' + t.wins + ' · Themes ' + unlocked + '/' + Content.THEMES.length;
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
      b.setAttribute('aria-label', 'Stage ' + (idx + 1) + ': ' + lv.name +
        (b.disabled ? ' (locked)' : '') + (stars ? ', ' + stars + ' stars' : ''));
      b.title = lv.name;
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
      b.innerHTML = '<strong>' + p.name + '</strong><span class="small">' +
        p.layers + ' layers · ' + p.sectors + ' sectors · armor ' + Math.round(p.armorPct * 100) + '%' +
        (best != null ? ' · best ' + fmtScore(best) : '') + '</span>';
      b.addEventListener('click', function () {
        var cfg = Rules.clone(p);
        cfg.theme = Session.getSetting('theme') || 'void';
        cfg.seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0; // fresh practice shaft each run
        cfg.name = 'Practice — ' + p.name;
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
      b.innerHTML = '<strong>' + c.name + '</strong><span class="small">' + c.intro +
        (best != null ? ' · best ' + fmtScore(best) : '') + '</span>';
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
    $('daily-info').textContent = dateStr + ' · ' + cfg.layers + ' layers · armor ' +
      Math.round(cfg.armorPct * 100) + '% · rotation ' + cfg.rotSpeed +
      (cfg.timeLimitSec ? ' · ' + cfg.timeLimitSec + 's containment timer' : '') +
      ' · par ' + cfg.par.timeSec + 's';
    var d = Session.getDaily(dateStr);
    $('daily-status').textContent = d
      ? 'Completed today: ' + (d.won ? 'core reached' : 'attempt logged') + ', best ' + fmtScore(d.score) + '. You can improve your score.'
      : 'Not attempted yet today. One shared seed for everyone.';
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
      $('daily-countdown').textContent = 'Next daily in ' + h + 'h ' + m + 'm ' + s + 's' +
        (serverOffsetMs == null ? ' (local clock)' : ' (server time)');
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
    local.slice(0, 10).forEach(function (row) {
      var li = document.createElement('li');
      li.textContent = fmtScore(row.score) + ' — depth ' + row.depth + ' (' + new Date(row.atMs).toLocaleDateString() + ')';
      board.appendChild(li);
    });
    if (!local.length) {
      var li = document.createElement('li');
      li.textContent = 'No dives yet. Yours will appear here; hosted boards compare with friends.';
      board.appendChild(li);
    }
  }

  // ---------- mode intro (preparing) ----------

  function openIntro(cfg, kind, ctx) {
    playCfg = cfg; playKind = kind; playCtx = ctx;
    $('intro-h').textContent = cfg.name || kind;
    $('intro-text').textContent = ctx.lesson ? ctx.lesson.text : (cfg.intro || 'Reach the core at the bottom of the shaft.');
    var meta = [cfg.layers + ' layers', cfg.sectors + ' sectors'];
    if (cfg.timeLimitSec) meta.push(cfg.timeLimitSec + 's timer');
    if (cfg.chargeMax) meta.push('charge cell ×' + cfg.chargeMax); else meta.push('no charge cell');
    meta.push(cfg.mechanics.undo ? 'undo on' : 'no undo');
    meta.push(cfg.mechanics.hint ? 'hints on' : 'no hints');
    meta.push(kind === 'tutorial' ? 'unranked'
      : kind === 'practice' ? 'local best only' : 'ranked locally');
    $('intro-meta').textContent = meta.join(' · ');
    openOverlay('overlay-intro');
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
    playName = playCfg.name || playKind;
    inputLog = [];
    cmdSeq = 0;
    resultsShown = false;
    paused = false;

    for (var i = 0; i < SCREENS.length; i++) $(SCREENS[i]).classList.add('hidden');
    screenStack = ['screen-title'];
    $('hud').classList.remove('hidden');
    $('action-tray').classList.remove('hidden');
    $('btn-hold').textContent = Session.getSetting('holdToggle') ? 'TAP TO DIVE' : 'HOLD TO DIVE';
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
    announce('Get ready', true);
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
        announce('Dive! ' + objectiveText(), true);
        startLoops();
      }
    }, 700);
  }

  function objectiveText() {
    if (!playCfg) return '';
    if (playCfg.endless) return 'Objective: descend as deep as you can. Armor ends the dive.';
    if (playCfg.timeLimitSec) return 'Objective: reach the core (' + playCfg.layers + ' layers) before containment vents in ' + playCfg.timeLimitSec + 's.';
    return 'Objective: reach the core — ' + playCfg.layers + ' layers down.';
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
        case 'overdrive': Audio.sfxOverdrive(); announce('Overdrive! Armored segment smashed.', false); break;
        case 'crash': Audio.sfxCrash(); announce('Armor impact — dive over.', true); break;
        case 'win': Audio.sfxWin(); announce('Core reached!', true); break;
        case 'lose': if (e.reason !== Rules.TERMINAL.ARMOR) { Audio.sfxLose(); announce('Dive over: ' + reasonText(e.reason), true); } break;
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
        announce('Lesson complete: ' + playCtx.lesson.title, true);
        toast('Lesson complete: ' + playCtx.lesson.title);
      }
    }
  }

  function reasonText(reason) {
    switch (reason) {
      case Rules.TERMINAL.CORE: return 'core reached';
      case Rules.TERMINAL.ARMOR: return 'armor impact';
      case Rules.TERMINAL.TIME: return 'containment vented (time up)';
      case Rules.TERMINAL.RESIGN: return 'resigned';
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
    pips.setAttribute('aria-label', 'Charge ' + s.charge + ' of ' + max);
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
    var seg = p.segment === 0 ? (Session.getSetting('highContrast') ? 'SAFE (bright)' : 'safe crystal')
      : p.segment === 1 ? (p.chargeReady ? 'armor — OVERDRIVE READY' : 'ARMOR — release!')
      : 'gap — fall through';
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
    if (!r.ok) { announce('Nothing to undo.', false); return; }
    playState = r.state;
    inputLog.push(cmd);
    Audio.sfxRelease();
    announce('Rewound to your last release.', false);
    handleEvents(r.events);
    updateHUD();
  }

  // pointer hold on canvas + hold button
  var pointerHeld = false;
  function bindHold(el) {
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      pointerHeld = true;
      if (Session.getSetting('holdToggle')) {
        if (playState && playState.holding) cmdRelease(); else cmdPress();
      } else cmdPress();
    });
    var up = function (ev) {
      if (!pointerHeld) return;
      pointerHeld = false;
      if (!Session.getSetting('holdToggle')) cmdRelease();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  bindHold($('game-canvas'));
  bindHold($('btn-hold'));
  $('game-canvas').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // keyboard
  var spaceHeld = false;
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var playing = playState && !$('hud').classList.contains('hidden');
    if (e.key === ' ' || e.code === 'Space') {
      if (!playing || anyOverlayOpen()) return;
      e.preventDefault();
      spaceHeld = true;
      if (Session.getSetting('holdToggle')) {
        if (playState.holding) cmdRelease(); else cmdPress();
      } else cmdPress();
    } else if (e.key === 'Enter' && playing && !anyOverlayOpen()) {
      e.preventDefault();
      if (playState.holding) cmdRelease(); else cmdPress();
    } else if ((e.key === 'p' || e.key === 'P') && playing) {
      if ($('overlay-pause').classList.contains('hidden')) pauseGame(); else resumeGame();
    } else if ((e.key === 'u' || e.key === 'U') && playing) {
      doUndo();
    } else if ((e.key === 'r' || e.key === 'R') && playing && !$('overlay-results').classList.contains('hidden')) {
      retry();
    } else if (e.key === 'Escape') {
      if (!$('overlay-settings').classList.contains('hidden')) closeOverlay('overlay-settings');
      else if (!$('overlay-help').classList.contains('hidden')) closeOverlay('overlay-help');
      else if (!$('overlay-results').classList.contains('hidden')) { /* stay until choice */ }
      else if (!$('overlay-pause').classList.contains('hidden')) resumeGame();
      else if (playing) pauseGame();
      else goBack();
    }
  });
  document.addEventListener('keyup', function (e) {
    if ((e.key === ' ' || e.code === 'Space') && spaceHeld) {
      spaceHeld = false;
      if (!Session.getSetting('holdToggle')) cmdRelease();
    }
  });

  // ---------- pause / resume / quit ----------

  function pauseGame() {
    if (!playState || playState.terminal) return;
    paused = true;
    openOverlay('overlay-pause');
    announce('Paused', false);
  }
  function resumeGame() {
    paused = false;
    closeOverlay('overlay-pause');
    announce('Resumed', false);
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
    submitToServer(replay, s);

    $('res-headline').textContent = won ? 'Core Reached!' : 'Dive Over';
    $('res-reason').textContent = playName + ' — ' + reasonText(t.reason) +
      ' · time ' + fmtTime(s.elapsedMs) + (parMet ? ' · par beaten' : '');

    var rows = [
      ['Breaks', s.score.breaks + ' → ' + fmtScore(s.score.breakPoints)],
      ['Gap passes', s.score.passes + ' → ' + fmtScore(s.score.passPoints)],
      ['Overdrives', s.score.overdrives + ' → ' + fmtScore(s.score.overdrivePoints)]
    ];
    if (won) {
      rows.push(['Time bonus', fmtScore(s.score.timeBonus)]);
      rows.push(['Momentum bonus', fmtScore(s.score.multBonus) + ' (best ×' + s.bestMult + ')']);
      rows.push(['Charge bonus', fmtScore(s.score.chargeBonus)]);
    }
    var html = rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }).join('');
    html += '<tr class="total"><td>Total</td><td>' + fmtScore(s.score.total) + '</td></tr>';
    $('res-breakdown').innerHTML = html;

    var prog = [];
    if (isNewBest) prog.push('New personal best!');
    if (playKind === 'journey' && won) {
      prog.push(parMet ? '★★ Par beaten' : '★ Stage clear');
      var stars = Session.totalStars();
      var nextTheme = null;
      Content.THEMES.forEach(function (th) { if (th.unlockStars > stars && (!nextTheme || th.unlockStars < nextTheme.unlockStars)) nextTheme = th; });
      if (nextTheme) prog.push((nextTheme.unlockStars - stars) + ' stars to unlock theme “' + nextTheme.name + '”');
    }
    if (playKind === 'daily') prog.push('Daily logged for ' + playCtx.date);
    $('res-progress').textContent = prog.join(' · ');
    $('res-achievements').textContent = '';
    $('res-replay').textContent = 'Replay hash ' + replay.hash.toString(16) + ' · seed ' + replay.seed +
      ' · ' + inputLog.length + ' commands';

    var nextBtn = $('btn-next');
    if (playKind === 'journey' && won && playCtx.levelIndex != null && playCtx.levelIndex + 1 < Content.JOURNEY.length) {
      nextBtn.classList.remove('hidden');
    } else if (playCtx && playCtx.lesson) {
      var lessons = Content.tutorialLessons();
      var li = lessons.indexOf(playCtx.lesson);
      nextBtn.classList.toggle('hidden', !(li >= 0 && li + 1 < lessons.length));
    } else nextBtn.classList.add('hidden');

    openOverlay('overlay-results');
    announce((won ? 'Victory. ' : 'Defeat. ') + 'Total score ' + s.score.total + '. ' + reasonText(t.reason), true);
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

  // ---------- server (optional, same-origin; fully offline-capable) ----------

  function submitToServer(replay, s) {
    if (!window.fetch || location.protocol === 'file:') return;
    // lessons are not scored, and practice shafts use a throwaway random seed:
    // neither belongs on a shared board
    if (playKind === 'tutorial' || playKind === 'practice') return;
    fetch('/api/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board: bestKey(), name: 'local pilot',
        contentVersion: replay.contentVersion, seed: replay.seed,
        cfg: replay.cfg, log: replay.log, hash: replay.hash,
        score: replay.score, durationMs: s.elapsedMs,
        assists: { undo: !!playCfg.mechanics.undo, hint: !!playCfg.mechanics.hint }
      })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.accepted) $('res-replay').textContent += ' · server validated (rank ' + res.rank + ')';
      else if (res && res.error) $('res-replay').textContent += ' · server: ' + res.error;
    }).catch(function () { /* offline: local result stands */ });
  }

  function syncServerTime() {
    if (!window.fetch || location.protocol === 'file:') return;
    var t0 = Date.now();
    fetch('/api/v1/time').then(function (r) { return r.json(); }).then(function (res) {
      var t1 = Date.now();
      if (res && typeof res.now === 'number') {
        serverOffsetMs = res.now - Math.round((t0 + t1) / 2);
      }
    }).catch(function () { /* offline: local clock */ });
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
      ['Hold to dive', 'Press and hold (mouse, touch, or Space). The striker smashes through bright crystal segments and builds momentum — each consecutive break is worth more.'],
      ['Release for armor', 'Dark spiked segments are armored. Landing on one ends the dive unless your charge cell is full. Release to hover and let a safe segment rotate in — hovering slowly bleeds descent progress.'],
      ['Gaps', 'Missing segments are gaps: you fall straight through, keep your streak, and gain a few points.'],
      ['Charge & overdrive', 'Safe breaks charge the striker. At full charge the next armored segment shatters too — an overdrive worth big points.'],
      ['Momentum', 'Releasing resets your ×multiplier. Long controlled streaks win stages and beat par.'],
      ['Undo', 'In relaxed modes each release banks a rewind point. Press U or Undo to return to your last release.']
    ];
    $('help-cards').innerHTML = cards.map(function (c) {
      return '<p><strong>' + c[0] + '.</strong> ' + c[1] + '</p>';
    }).join('');
    var ctrls = [
      'Mouse / touch: hold anywhere on the playfield (or the HOLD button) to dive; release to hover.',
      'Space: hold to dive, release to hover' + (Session.getSetting('holdToggle') ? ' (toggle mode: tap)' : '') + '.',
      'Enter: tap to toggle dive/hover.',
      'P or Escape: pause / resume. U: undo (where allowed). R: retry from results.'
    ];
    $('help-controls').innerHTML = ctrls.map(function (c) { return '<li>' + c + '</li>'; }).join('');
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
      opt.textContent = th.name + (th.unlockStars > stars ? ' (' + th.unlockStars + '★ locked)' : '');
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

  function boot() {
    var ok = false;
    try { ok = Render.init($('game-canvas')); } catch (e) { ok = false; }
    if (!ok || !Render.isAvailable()) {
      $('title-compat').textContent =
        'WebGL is unavailable in this browser, so the 3D shaft cannot render. ' +
        'Your progress and settings are safe; try a browser with WebGL enabled.';
    }
    applySettings();
    renderPracticeList();
    renderChallengeList();
    bindSettings();
    Audio.onCaption(caption);
    syncServerTime();
    showScreen('screen-title', true);
    // idle render behind menus
    rafId = requestAnimationFrame(frameLoop);
  }

  boot();
})();
