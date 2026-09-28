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
    balanced: { scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'medium', background: 'animated' },
    high: { scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
    ultra: { scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' }
  };

  // Device-pixel-ratio cap per preset, so Low never renders more pixels than the game did before.
  var PIXEL_CAP = { low: 1, balanced: 1.5, high: 2, ultra: 2 };
  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
  var PARTICLE_SHARE = { low: 1 / 3, medium: 2 / 3, high: 1 };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
  function detectPreset(gpu) {
    var g = String(gpu || '').toLowerCase();
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 'low';
    if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) return 'high';
    return 'balanced';
  }

  /** Auto choice: the detected tier, capped at Balanced on touch / mobile devices. */
  function autoPreset(gpu, mobile) {
    var p = detectPreset(gpu);
    if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
    return p;
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
  function resolve(saved, detected) {
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
    unknownGpu: 'unknown GPU', fps: 'fps',
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
    unknownGpu: 'GPU desconocida', fps: 'fps',
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
    unknownGpu: 'GPU inconnu', fps: 'i/s',
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
      unknownGpu: 'unbekannte GPU', fps: 'fps',
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
      unknownGpu: 'GPU desconhecida', fps: 'fps',
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
      unknownGpu: 'GPU sconosciuta', fps: 'fps',
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
    detectPreset: detectPreset, autoPreset: autoPreset, normalizePreset: normalizePreset,
    resolve: resolve, choosePreset: choosePreset, presetTier: presetTier,
    pickLocale: pickLocale, strings: strings, fmt: fmt, describe: describe
  };
});
