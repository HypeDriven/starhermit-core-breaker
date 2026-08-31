/* Core Breaker — WebAudio: authored sfx/*.opus one-shots with procedural fallback.
 * Buses: music, sfx, ambience. Volumes 0..1 applied per bus.
 * Every meaningful sound can be mirrored as a text caption via onCaption. */
(function () {
  'use strict';

  var ctx = null;
  var masterGain = null;
  var busMusic = null, busSfx = null, busAmb = null;
  var volMusic = 0.4, volSfx = 0.8, volAmbience = 0.35;
  var muted = false;
  var ambNodes = null;
  var musicTimer = null, musicStep = 0, musicIntensity = 0;
  var captionCb = null;

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    masterGain = ctx.createGain();
    busMusic = ctx.createGain();
    busSfx = ctx.createGain();
    busAmb = ctx.createGain();
    busMusic.connect(masterGain);
    busSfx.connect(masterGain);
    busAmb.connect(masterGain);
    masterGain.connect(ctx.destination);
    applyVolumes();
    return true;
  }

  function resume() { if (ensure() && ctx.state === 'suspended') ctx.resume(); }

  function applyVolumes() {
    if (!ctx) return;
    busMusic.gain.value = muted ? 0 : volMusic;
    busSfx.gain.value = muted ? 0 : volSfx;
    busAmb.gain.value = muted ? 0 : volAmbience;
  }

  function setVolumes(m, s, a) {
    volMusic = m; volSfx = s; volAmbience = a;
    applyVolumes();
  }
  function setMuted(m) { muted = !!m; applyVolumes(); }

  function caption(text) { if (captionCb) captionCb(text); }

  // ---------- authored sample one-shots (sfx/*.opus, see sfx/manifest.json) ----------
  // Lazy-fetch/decode/cache per name. Events prefer the sample; the
  // procedural synthesis below stays as the fallback while a clip is
  // still loading or if it cannot be fetched/decoded.
  var SFX_SAMPLES = {
    press: 'dive-start',
    release: 'hover-release',
    break: 'crystal-break',
    pass: 'gap-pass',
    overdrive: 'overdrive-surge',
    charge: 'charge-pip',
    crash: 'armor-crash',
    win: 'core-reached',
    lose: 'run-ended',
    ui: 'ui-tick',
    achievement: 'achievement-unlock',
    countdown: 'countdown-beep'
  };
  var sampleState = {};   // name -> 'loading' | 'ready' | 'failed'
  var sampleBuffers = {}; // name -> AudioBuffer

  function loadSample(name) {
    sampleState[name] = 'loading';
    fetch('sfx/' + name + '.opus')
      .then(function (r) {
        if (!r.ok) throw new Error('sfx http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) { sampleBuffers[name] = buf; sampleState[name] = 'ready'; })
      .catch(function () { sampleState[name] = 'failed'; });
  }

  // Returns true when a cached sample was played through the sfx bus.
  function trySample(key) {
    var name = SFX_SAMPLES[key];
    if (!name || !ctx) return false;
    var st = sampleState[name];
    if (st === 'ready') {
      var src = ctx.createBufferSource();
      src.buffer = sampleBuffers[name];
      src.connect(busSfx);
      src.start();
      return true;
    }
    if (st === undefined) loadSample(name);
    return false;
  }

  function blip(freq, dur, gain, type, slideTo) {
    if (!ensure()) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(busSfx);
    o.start(); o.stop(ctx.currentTime + dur + 0.02);
  }

  function noise(dur, gain, lowFreq) {
    if (!ensure()) return;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(), g = ctx.createGain();
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lowFreq || 4000;
    src.buffer = buf;
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(busSfx);
    src.start(); src.stop(ctx.currentTime + dur + 0.02);
  }

  // ---------- ambience: quiet reactor hum, pauses when hidden ----------
  function startAmbience() {
    if (!ensure() || ambNodes) return;
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o1.type = 'sine'; o1.frequency.value = 54;
    o2.type = 'triangle'; o2.frequency.value = 108.5;
    g.gain.value = 0.05;
    o1.connect(g); o2.connect(g); g.connect(busAmb);
    o1.start(); o2.start();
    ambNodes = { o1: o1, o2: o2, g: g };
  }
  function stopAmbience() {
    if (!ambNodes) return;
    try { ambNodes.o1.stop(); ambNodes.o2.stop(); } catch (e) {}
    ambNodes.g.disconnect();
    ambNodes = null;
  }

  // ---------- adaptive music: sparse pulse, more layers with momentum ----------
  var SCALE = [0, 3, 5, 7, 10];
  function startMusic() {
    if (!ensure() || musicTimer) return;
    musicStep = 0;
    musicTimer = setInterval(function () {
      if (!ctx || document.hidden) return;
      var root = 110;
      var step = musicStep++;
      var semis = SCALE[step % SCALE.length] + 12 * (Math.floor(step / SCALE.length) % 2);
      var f = root * Math.pow(2, semis / 12);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = musicIntensity > 4 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      var dur = 0.22, vol = 0.05 + Math.min(0.05, musicIntensity * 0.008);
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.connect(g); g.connect(busMusic);
      o.start(); o.stop(ctx.currentTime + dur + 0.02);
      if (musicIntensity >= 3 && step % 2 === 0) { // bass pulse joins at higher momentum
        var b = ctx.createOscillator(), bg = ctx.createGain();
        b.type = 'sine'; b.frequency.value = root / 2;
        bg.gain.setValueAtTime(0.08, ctx.currentTime);
        bg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        b.connect(bg); bg.connect(busMusic);
        b.start(); b.stop(ctx.currentTime + 0.32);
      }
    }, 300);
  }
  function stopMusic() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }
  function setMusicIntensity(mult) { musicIntensity = mult | 0; }

  window.CBAudio = {
    resume: resume,
    setVolumes: setVolumes,
    setMuted: setMuted,
    onCaption: function (cb) { captionCb = cb; },
    startAmbience: startAmbience,
    stopAmbience: stopAmbience,
    startMusic: startMusic,
    stopMusic: stopMusic,
    setMusicIntensity: setMusicIntensity,
    sfxPress: function () { if (!trySample('press')) blip(240, 0.14, 0.5, 'triangle', 320); caption('dive start'); },
    sfxRelease: function () { if (!trySample('release')) blip(360, 0.12, 0.4, 'triangle', 260); caption('hover'); },
    sfxBreak: function (mult) {
      if (!trySample('break')) { noise(0.2, 0.5, 3000); blip(90 + (mult || 1) * 40, 0.25, 0.5, 'square'); }
      caption('crystal break ×' + (mult || 1));
    },
    sfxPass: function () { if (!trySample('pass')) blip(660, 0.18, 0.3, 'sine', 880); caption('gap pass'); },
    sfxOverdrive: function () {
      if (!trySample('overdrive')) { noise(0.45, 0.7, 5000); blip(220, 0.45, 0.6, 'sawtooth', 880); }
      caption('overdrive');
    },
    sfxCharge: function () { if (!trySample('charge')) blip(520, 0.1, 0.3, 'sine', 640); },
    sfxCrash: function () {
      if (!trySample('crash')) { noise(0.6, 0.8, 2000); blip(70, 0.6, 0.7, 'sawtooth', 40); }
      caption('armor impact');
    },
    sfxWin: function () {
      if (!trySample('win')) {
        blip(523, 0.3, 0.5); setTimeout(function () { blip(659, 0.3, 0.5); }, 130);
        setTimeout(function () { blip(784, 0.5, 0.5); }, 260);
      }
      caption('core reached');
    },
    sfxLose: function () { if (!trySample('lose')) blip(160, 0.4, 0.5, 'triangle', 90); caption('run ended'); },
    sfxUi: function () { if (!trySample('ui')) blip(440, 0.06, 0.25, 'sine'); },
    sfxAchievement: function () {
      if (!trySample('achievement')) {
        blip(880, 0.2, 0.4); setTimeout(function () { blip(1174, 0.3, 0.4); }, 140);
      }
      caption('achievement unlocked');
    },
    sfxCountdown: function () { if (!trySample('countdown')) blip(600, 0.1, 0.35, 'sine'); }
  };
})();
