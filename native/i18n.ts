// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's: English source strings as keys, the nine StarHermit
// locales; en-GB, es-ES and fr-CA hold their differences, the chain reads the
// rest) in the interface language the runtime reports (the player's choice in
// Options › Language, else the account's preferred language or the device's).
// The runtime's Options replaced the game's own Language selector
// (sh-language.js). The account lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Cfg } from "./classic.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }

type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;

/** A round configuration's display name in the player's language. */
export function cfgName(cfg: Cfg | null, kind = ""): string {
  if (!cfg) return "";
  if (cfg.kind === "daily" && cfg.date) return T("Daily {date}", { date: cfg.date });
  if (cfg.practiceName) return T("Practice — {name}", { name: T(cfg.practiceName) });
  return cfg.name ? T(cfg.name) : kind;
}
