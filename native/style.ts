// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, selects, scroll bars) fall
// back to. The browser build's body.high-contrast palette is a token set
// here, applied while the runtime's high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  panel: "#000000f2", "panel-border": "#ffffff", text: "#ffffff", dim: "#e8e8e8",
  accent: "#00e5ff", "accent-2": "#ffe600", danger: "#ff4757",
};
export const COLORS = { text: "#f2eefc", dim: "#b8b0d8", accent: "#9be8ff", gold: "#ffd166", danger: "#ff6b7a", border: "#4a3f8f" };
export const COLORS_HC = { text: "#ffffff", dim: "#e8e8e8", accent: "#00e5ff", gold: "#ffe600", danger: "#ff4757", border: "#ffffff" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: "#f2eefc", muted: "#b8b0d8", panel: "#141126", control: "#241f45", hovered: "#322a5e",
    pressed: "#3a86b0", field: "#241f45", accent: "#9be8ff", focus: "#9be8ff", outline: "#4a3f8f",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    checkbox: {
      text: { color: "$text" }, minHeight: 40,
      parts: { box: { background: "#241f45", border: { width: 1, color: "$panel-border" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$text" }, background: "#241f45", border: { width: 1, color: "$panel-border" }, radius: 8, minHeight: 40 },
    scrollArea: { parts: { bar: { background: "$panel-border", radius: 4 } } },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
