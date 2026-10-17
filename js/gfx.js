/* Core Breaker — graphics quality model: presets, per-category overrides,
 * GPU detection, cost summary and the Graphics panel's localized strings.
 * Pure (no three.js, no DOM) so the renderer, the settings panel and the
 * node tests agree on what a setting means. UMD: window.CBGfx / require(). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBGfx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    detail: ['plain', 'detailed'],
    particles: ['low', 'medium', 'high'],
    background: ['static', 'animated']
  };
  var CATEGORY_ORDER = ['shadows', 'ao', 'bloom', 'grade', 'antialias', 'reflections', 'detail', 'particles', 'background'];

  // Each preset is a row of tiers plus a render scale (multiplies the capped device pixel ratio).
  var TABLE = {
    low: { scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
    balanced: { scale: 0.9, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'medium', background: 'animated' },
    high: { scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
    ultra: { scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' }
  };

  // Device-pixel-ratio cap per preset, so Low never renders more pixels than the game did before.
  var PIXEL_CAP = { low: 1, balanced: 1.5, high: 2, ultra: 2 };
  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
  var PARTICLE_SHARE = { low: 1 / 3, medium: 2 / 3, high: 1 };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
  // 5090; js/gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
  // Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
  var PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  function gpuApi() { return (typeof self !== 'undefined' ? self : globalThis).StarHermitGpu; }

  /** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
  function detectLevel(gpu, system) {
    var G = gpuApi();
    if (!G) return PRESET_LEVELS.balanced;
    var sys = typeof system === 'boolean' ? { mobile: system } : (system || {});
    return G.detectLevel(Object.assign({}, sys, { gpu: String(gpu || '') }));
  }
  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    var G = gpuApi();
    if (G) return G.presetForLevel(level, PRESET_LEVELS);
    return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
  }
  /** Best preset for a GPU (the hardware level already caps phones/tablets at Balanced). */
  function detectPreset(gpu, system) { return presetForLevel(detectLevel(gpu, system)); }
  /** Auto choice (legacy name): the preset for the GPU's hardware level. */
  function autoPreset(gpu, system) { return detectPreset(gpu, system); }

  /** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor). */
  function scaleCount(n, preset, level) {
    var G = gpuApi();
    var floor = PRESET_LEVELS[preset] || 0;
    return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
  }

  /*
   * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
   * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
   *   material     ring segments: 'lambert' | 'standard' | 'physical' (clear-coat crystal and armour);
   *   texture      crystal/armour canvas width in px (detailed surfaces; half as tall);
   *   bevel        rounded-segment bevel segments (detailed surfaces);
   *   wallSegments radial segments of the gridded shaft wall;
   *   motes        rising shaft motes at the floor level;
   *   shards       shard-burst pool in use at the floor level (the Particles tier also thins each burst);
   *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame.
   */
  var BUDGETS = {
    low:      { material: 'lambert',  texture: 128, bevel: 2, wallSegments: 24, motes: 60,  shards: 60,  bloomRes: 0.5, aoRes: 0.5 },
    balanced: { material: 'standard', texture: 256, bevel: 2, wallSegments: 32, motes: 100, shards: 100, bloomRes: 0.5, aoRes: 0.5 },
    high:     { material: 'physical', texture: 256, bevel: 3, wallSegments: 48, motes: 160, shards: 140, bloomRes: 0.5, aoRes: 0.5 },
    ultra:    { material: 'physical', texture: 512, bevel: 4, wallSegments: 64, motes: 240, shards: 200, bloomRes: 1, aoRes: 1 }
  };
  var MOTE_MAX = 600, SHARD_MAX = 400;

  /** A preset's concrete budget for a hardware level. */
  function budgetFor(preset, level) {
    var b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    b.motes = Math.min(MOTE_MAX, scaleCount(b.motes, preset, level));
    b.shards = Math.min(SHARD_MAX, scaleCount(b.shards, preset, level));
    return b;
  }

  /** Older saves used auto | low | medium | high. */
  function normalizePreset(p) {
    if (p === 'medium') return 'balanced';
    return PRESETS.indexOf(p) >= 0 ? p : 'auto';
  }

  /**
   * Resolve saved settings into concrete tiers.
   * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
   */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var explicit = PRESETS.indexOf(normalizePreset(s.preset)) >= 0;
    var preset = explicit ? normalizePreset(s.preset) : (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced');
    var row = TABLE[preset];
    var out = {
      preset: preset,
      auto: !explicit,
      userScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
      pixelCap: PIXEL_CAP[preset]
    };
    out.scale = row.scale * out.userScale;
    for (var i = 0; i < CATEGORY_ORDER.length; i++) {
      var cat = CATEGORY_ORDER[i];
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    }
    out.adaptive = s.adaptive !== false && s.adaptive !== 0;
    out.showFps = !!s.show_fps;
    out.shadowMap = SHADOW_MAP[out.shadows];
    out.particleShare = PARTICLE_SHARE[out.particles];
    out.level = level == null ? PRESET_LEVELS[preset] : level;
    out.budget = budgetFor(preset, out.level);
    // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** Choosing a preset clears every per-category override (scale / adaptive / fps are kept). */
  function choosePreset(saved, preset) {
    var s = saved || {};
    var out = { preset: normalizePreset(preset) };
    if (s.render_scale !== undefined) out.render_scale = s.render_scale;
    if (s.adaptive !== undefined) out.adaptive = s.adaptive;
    if (s.show_fps !== undefined) out.show_fps = s.show_fps;
    return out;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    var row = TABLE[preset];
    return row ? row[cat] : undefined;
  }

  // ---------- localized strings (the Graphics panel only; the rest of the game is English) ----------

  var EN = {
    heading: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', scale: 'Render scale',
    fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device; effects that need it are off.',
    unknownGpu: 'unknown GPU', level: 'Level {n}', fps: 'fps',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
      reflections: 'Reflections', detail: 'Surface detail', particles: 'Particles', background: 'Shaft background' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Plain', detailed: 'Detailed', 'static': 'Static', animated: 'Animated' },
    sum: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
      bloom: 'bloom', noAA: 'no anti-aliasing', reflections: 'reflections' }
  };
  function variant(base, patch) {
    var o = JSON.parse(JSON.stringify(base));
    for (var k in patch) {
      if (patch[k] && typeof patch[k] === 'object') for (var j in patch[k]) o[k][j] = patch[k][j];
      else o[k] = patch[k];
    }
    return o;
  }
  var ES = {
    heading: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderizado',
    fromPreset: 'Según el ajuste ({tier})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; los efectos que lo necesitan están desactivados.',
    unknownGpu: 'GPU desconocida', level: 'Nivel {n}', fps: 'fps',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
      reflections: 'Reflejos', detail: 'Detalle de superficies', particles: 'Partículas', background: 'Fondo del pozo' },
    tiers: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Simple', detailed: 'Detallado', 'static': 'Estático', animated: 'Animado' },
    sum: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
      bloom: 'resplandor', noAA: 'sin suavizado', reflections: 'reflejos' }
  };
  var FR = {
    heading: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})', scale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets qui en dépendent sont désactivés.',
    unknownGpu: 'GPU inconnu', level: 'Niveau {n}', fps: 'i/s',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
      reflections: 'Reflets', detail: 'Détail des surfaces', particles: 'Particules', background: 'Fond du puits' },
    tiers: { off: 'Désactivé', on: 'Activé', low: 'Faible', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Simple', detailed: 'Détaillé', 'static': 'Statique', animated: 'Animé' },
    sum: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
      bloom: 'halo', noAA: 'sans anticrénelage', reflections: 'reflets' }
  };
  var STRINGS = {
    'en-US': EN,
    'en-GB': variant(EN, { cats: { grade: 'Colour grade' } }),
    'es-419': ES,
    'es-ES': variant(ES, { showFps: 'Mostrar tasa de fotogramas', cats: { antialias: 'Antialiasing' } }),
    'fr-FR': FR,
    'fr-CA': variant(FR, { showFps: 'Afficher la fréquence d’affichage', cats: { bloom: 'Éclat lumineux' }, sum: { bloom: 'éclat' } }),
    'de-DE': {
      heading: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', scale: 'Renderskalierung',
      fromPreset: 'Aus Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
      postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte, die sie benötigen, sind aus.',
      unknownGpu: 'unbekannte GPU', level: 'Stufe {n}', fps: 'fps',
      presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
      cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
        reflections: 'Spiegelungen', detail: 'Oberflächendetails', particles: 'Partikel', background: 'Schachthintergrund' },
      tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        plain: 'Einfach', detailed: 'Detailliert', 'static': 'Statisch', animated: 'Animiert' },
      sum: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
        bloom: 'Leuchteffekt', noAA: 'keine Kantenglättung', reflections: 'Spiegelungen' }
    },
    'pt-BR': {
      heading: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderização',
      fromPreset: 'Da predefinição ({tier})', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
      postFailed: 'O pós-processamento não está disponível neste dispositivo; os efeitos que dependem dele estão desligados.',
      unknownGpu: 'GPU desconhecida', level: 'Nível {n}', fps: 'fps',
      presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
      cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
        reflections: 'Reflexos', detail: 'Detalhe das superfícies', particles: 'Partículas', background: 'Fundo do poço' },
      tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        plain: 'Simples', detailed: 'Detalhado', 'static': 'Estático', animated: 'Animado' },
      sum: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa',
        bloom: 'brilho', noAA: 'sem antisserrilhamento', reflections: 'reflexos' }
    },
    'it-IT': {
      heading: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', scale: 'Scala di rendering',
      fromPreset: 'Dal preset ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
      postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti che la richiedono sono disattivati.',
      unknownGpu: 'GPU sconosciuta', level: 'Livello {n}', fps: 'fps',
      presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
      cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
        reflections: 'Riflessi', detail: 'Dettaglio superfici', particles: 'Particelle', background: 'Sfondo del pozzo' },
      tiers: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        plain: 'Semplice', detailed: 'Dettagliato', 'static': 'Statico', animated: 'Animato' },
      sum: { noShadows: 'nessuna ombra', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
        bloom: 'bagliore', noAA: 'nessun antialiasing', reflections: 'riflessi' }
    }
  };
  var LANG_DEFAULT = { en: 'en-US', es: 'es-419', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT' };

  /** Best supported locale for a list of BCP 47 tags (navigator.languages). */
  function pickLocale(langs) {
    var list = [].concat(langs || []);
    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i] || '');
      for (var k in STRINGS) if (k.toLowerCase() === tag.toLowerCase()) return k;
      var lang = tag.split('-')[0].toLowerCase();
      if (lang === 'es' && /^es-es$/i.test(tag)) return 'es-ES';
      if (lang === 'fr' && /^fr-ca$/i.test(tag)) return 'fr-CA';
      if (lang === 'en' && /^en-(gb|ie|au|nz|za|in)$/i.test(tag)) return 'en-GB';
      if (LANG_DEFAULT[lang]) return LANG_DEFAULT[lang];
    }
    return 'en-US';
  }

  function strings(locale) { return STRINGS[locale] || EN; }

  function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] !== undefined ? vars[k] : ''; });
  }

  /** Cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · reflections · 1280×800 px". */
  function describe(r, pixels, str) {
    var t = (str || EN).sum;
    var parts = [
      r.shadows === 'off' ? t.noShadows : fmt(t.shadows, { n: SHADOW_MAP[r.shadows] }),
      r.ao === 'off' ? null : (r.ao === 'high' ? t.aoHigh : t.ao),
      r.bloom === 'on' ? t.bloom : null,
      r.antialias === 'off' ? t.noAA : r.antialias.toUpperCase(),
      r.reflections === 'on' ? t.reflections : null,
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, CATEGORY_ORDER: CATEGORY_ORDER, TABLE: TABLE,
    PIXEL_CAP: PIXEL_CAP, SHADOW_MAP: SHADOW_MAP, STRINGS: STRINGS,
    PRESET_LEVELS: PRESET_LEVELS, BUDGETS: BUDGETS, MOTE_MAX: MOTE_MAX, SHARD_MAX: SHARD_MAX,
    detectLevel: detectLevel, presetForLevel: presetForLevel, budgetFor: budgetFor,
    detectPreset: detectPreset, autoPreset: autoPreset, normalizePreset: normalizePreset,
    resolve: resolve, choosePreset: choosePreset, presetTier: presetTier,
    pickLocale: pickLocale, strings: strings, fmt: fmt, describe: describe
  };
});
