/* Core Breaker — localization.
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables
 * (en-GB, es-ES and fr-CA carry only their differences from en-US, es-419
 * and fr-FR). On the StarHermit engine the locale is the runtime's interface
 * language (native/i18n.ts calls setLocale with preferences().language: the
 * player's choice in Options › Language, else the account's preferred
 * language or the device's); the screens are drawn every frame, so a
 * language change shows at once.
 * UMD: classic script (globalThis.CBI18N, after js/strings.js) / CommonJS.
 */
(function (root, factory) {
  var tables = root.CB_STRINGS || ((typeof module === 'object' && module.exports) ? require('./strings.js').CB_STRINGS : {});
  var api = factory(tables);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBI18N = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TABLES) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var lang = 'en-US';
  var hasOwn = Object.prototype.hasOwnProperty;

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders filled from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  /** Switch to a shipped locale (anything else falls back to en-US); the locale in use. */
  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    return lang;
  }

  return {
    T: T,
    setLocale: setLocale,
    get lang() { return lang; },
    locales: LOCALES,
    tables: TABLES
  };
});
