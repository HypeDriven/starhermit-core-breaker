// Localization: the browser build's string tables (js/strings.js, English
// source strings as keys, the nine StarHermit locales; the account lines that
// js/main.js kept apart are rows there now) in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's own Language selector (sh-language.js).
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, type Cfg } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = I18n.locales.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-(es)$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  I18n.setLocale(locale);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }

type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;

/** A round configuration's display name in the player's language. */
export function cfgName(cfg: Cfg | null, kind = ""): string {
  if (!cfg) return "";
  if (cfg.kind === "daily" && cfg.date) return T("Daily {date}", { date: cfg.date });
  if (cfg.practiceName) return T("Practice — {name}", { name: T(cfg.practiceName) });
  return cfg.name ? T(cfg.name) : kind;
}
