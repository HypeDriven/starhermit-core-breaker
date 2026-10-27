// The browser build's DOM shell (index.html + css/style.css, built by
// js/main.js) as starhermit:ui, built every frame: the play HUD (score, best,
// depth, the containment timer, momentum and the charge pips, Undo and
// Pause, the objective line), the hint pill with the 3-2-1 countdown, the
// sound-caption line, the action tray (HOLD TO DIVE and Undo, reversed for
// the left-handed tray), the toast, the menu screens (title over the key art,
// Journey's stage grid, Practice with its theme, Challenges, Daily, Score
// Chase with its boards) and the overlays (intro, pause, results with the
// outcome art and the score breakdown, settings, how to play). The browser's
// media queries are layouts picked by the window's logical size: wide (≥ 1024
// px: wider cards, larger HUD values), compact (≤ 700 px: smaller HUD values,
// a narrower hold button) and short landscape (≤ 500 px tall: the title's
// mode buttons three across, a smaller logo, the tray at the end, no results
// art). Cards taller than the room scroll, their buttons pinned below.
// Symbols the system fonts may lack (★, the lock, ♪, ∞) are drawn.
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { createImageBitmap, OffscreenCanvas } from "starhermit:canvas";
import { requestSignIn } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Rules, Session } from "./classic.ts";
import { T, cfgName, currentLocale } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, canUndo, closeOverlay, countdownLeft, countingDown, dailyDate, doUndo, goBack, holdEnd, holdStart, holding, hudBest,
  liveScore, localBoard, nextStage, objectiveText, openIntro, openLearn, openOverlay, openPlay, pauseGame, playCfg, playCtx,
  playKind, playState, quitToTitle, reasonText, restart, resumeGame, retry, settings, showScreen, startDaily, startPlay,
  startPractice, startScoreChase,
} from "./main.ts";
import { COLORS, COLORS_HC } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; narrow: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, narrow: lw <= 700, shortLand: lw > lh && lh <= 500 };
}
const colors = (): typeof COLORS => (ui.preferences().highContrast ? COLORS_HC : COLORS);
const lastHeight = new Map<string, number>();
const fmtScore = (n: number | null | undefined): string => (n == null ? "—" : Number(n).toLocaleString("en-US"));
function fmtTime(ms: number): string {
  if (!isFinite(ms)) return "—";
  const neg = ms < 0;
  if (neg) ms = -ms;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${neg ? "-" : ""}${m}:${String(s % 60).padStart(2, "0")}`;
}

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: (string | ui.Style)[]; disabled?: boolean; act: () => void; face?: () => void; silent?: boolean }
const PLAIN = ["btn"];
const buttonWidth = (b: Btn): number => textWidth(b.text, (b.style ?? PLAIN).filter((x): x is string => typeof x === "string"), "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (b.face) opts.content = b.face;
  else if (width != null && buttonWidth(b) > width) {
    const inner = width - 40;
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner, style.includes("btn-primary") ? { weight: "600" } : {}); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) {
    if (!b.silent) audio.cue("ui");
    b.act();
  }
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "center", gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | readonly string[] | null, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? (typeof cls === "string" ? [cls] : [...cls]) : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
/** The English table text without its ★ marks (drawn as glyphs instead). */
const bare = (s: string): string => s.replace(/[★]/gu, "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ glyphs
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}
type Glyph = "star" | "lock" | "dot" | "note" | "infinity";
function drawGlyph(kind: Glyph, cx: number, cy: number, s: number, color: string): void {
  if (kind === "star") draw.polygon(starPts(cx, cy, s), color);
  else if (kind === "dot") draw.circle(cx, cy, Math.max(1, s * 0.22), color);
  else if (kind === "lock") {
    draw.strokeArc(cx, cy - s * 0.2, s * 0.42, Math.PI, 2 * Math.PI, color, Math.max(1.2, s * 0.16));
    draw.line(cx - s * 0.42, cy - s * 0.2, cx - s * 0.42, cy + s * 0.05, color, Math.max(1.2, s * 0.16));
    draw.line(cx + s * 0.42, cy - s * 0.2, cx + s * 0.42, cy + s * 0.05, color, Math.max(1.2, s * 0.16));
    draw.roundRect(cx - s * 0.65, cy, s * 1.3, s * 0.95, s * 0.15, color);
  } else if (kind === "note") {
    draw.ellipse(cx - s * 0.2, cy + s * 0.45, s * 0.32, s * 0.24, color, { rotation: -0.4 });
    draw.line(cx + s * 0.1, cy + s * 0.4, cx + s * 0.1, cy - s * 0.7, color, Math.max(1, s * 0.14));
    draw.line(cx + s * 0.1, cy - s * 0.7, cx + s * 0.55, cy - s * 0.45, color, Math.max(1, s * 0.14));
  } else {
    const w = Math.max(1.2, s * 0.16);
    draw.strokeEllipse(cx - s * 0.45, cy, s * 0.45, s * 0.32, color, w);
    draw.strokeEllipse(cx + s * 0.45, cy, s * 0.45, s * 0.32, color, w);
  }
}
/** Glyphs in a row as one decorative widget, `size` logical pixels each. */
function glyphs(kinds: Glyph[], size: number, color: string, gap = 2): void {
  if (!kinds.length) return;
  ui.widget("", {
    role: "none", size: { width: kinds.length * size + (kinds.length - 1) * gap, height: size },
    draw: (r) => {
      const k = r.height / size;
      kinds.forEach((g, i) => drawGlyph(g, r.x + (i * (size + gap) + size / 2) * k, r.y + r.height / 2, (size / 2) * k * 0.9, color));
    },
  });
}

// ------------------------------------------------------------------ art
// The authored key art (title) and the two results illustrations
// (assets/*.webp), decoded into canvases; missing art never breaks a screen
// (the browser build hid a failed image): the veil or a dark panel stands in.
const art: { key: OffscreenCanvas | null; win: OffscreenCanvas | null; lose: OffscreenCanvas | null } = { key: null, win: null, lose: null };
export function loadArt(): void {
  const load = (path: string, set: (c: OffscreenCanvas) => void): void => {
    createImageBitmap(path).then((bmp) => {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
      set(c);
    }, () => undefined);
  };
  load("assets/key-art.webp", (c) => { art.key = c; });
  load("assets/core-reached.webp", (c) => { art.win = c; });
  load("assets/dive-over.webp", (c) => { art.lose = c; });
}
/** An image drawn object-fit: cover into a rectangle. */
function cover(img: OffscreenCanvas, x: number, y: number, w: number, h: number): void {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k, sh = h / k;
  draw.image(img, x, y, w, h, { source: { x: (img.width - sw) / 2, y: (img.height - sh) / 2, width: sw, height: sh } });
}
/** Paints behind everything (a 0 × 0 placed widget draws over the whole window and takes no pointer). */
function backdrop(key: string, paint: () => void): void {
  ui.place(key, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.widget("", { role: "none", size: { width: 0, height: 0 }, draw: () => paint() });
  }, { width: 0, height: 0 });
}

// ------------------------------------------------------------------ the frame
function firstLabel(): string | null {
  switch (app.overlay) {
    case "intro": return "btn-intro-start";
    case "pause": return "btn-resume";
    case "results": return "btn-retry";
    case "settings": return "set-captions";
    case "help": return "btn-help-close";
    default: break;
  }
  switch (app.screen) {
    case "title": return "btn-play";
    case "journey": return "jstage-1";
    case "practice": return `practice-${Content.PRACTICE[0]!.id}`;
    case "challenge": return `challenge-${Content.CHALLENGES[0]!.id}`;
    case "daily": return "btn-daily-play";
    case "score": return "btn-score-play";
    default: return null;
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  // A screen or overlay that just opened focuses its first (or primary) control once its layout settled.
  if (app.focusNext && frame().frame - app.openedFrame >= 2) {
    const first = firstLabel();
    if (first) ui.setFocus(first);
    app.focusNext = false;
  }
  if (app.screen) menuScreen(L);
  else if (playState) playLayer(L);
  switch (app.overlay) {
    case "intro": introOverlay(L); break;
    case "pause": pauseOverlay(L); break;
    case "results": resultsOverlay(L); break;
    case "settings": settingsOverlay(L); break;
    case "help": helpOverlay(L); break;
    default: break;
  }
  if (app.toast) {
    const text = app.toast.text();
    const w = Math.min(L.lw - 32, 560);
    ui.place("toast", { anchor: "top", y: 64 }, () => {
      ui.column("toast-box", () => { para(text, w - 44, "toast-text", "toast-text", true); }, { style: "toast", align: "center" });
    });
  }
}

// ------------------------------------------------------------------ cards
interface CardOpts { maxW: number; overlay?: boolean; footer?: (w: number) => void; outside?: (w: number) => void; art?: (w: number) => void }
/** A card centred on a backdrop (the menu screens' radial veil, or the overlays' dim): a body taller
 * than the room scrolls while the footer's buttons stay below it; `outside` sits under the card (Back). */
function card(key: string, L: Layout, body: (w: number) => void, o: CardOpts): void {
  const compact = L.narrow || L.shortLand;
  const width = Math.max(220, Math.min(o.maxW, L.lw - 32));
  const padX = compact ? 16 : o.overlay ? 26 : 22, padY = compact ? 14 : o.overlay ? 22 : 18;
  const inner = width - padX * 2;
  const room = o.overlay ? L.lh * 0.86 : L.lh - 40;
  const outH = o.outside ? (lastHeight.get(`${key}:o`) ?? 56) + 12 : 0;
  const fH = o.footer ? (lastHeight.get(`${key}:f`) ?? 56) + 12 : 0;
  const artH = o.art ? (lastHeight.get(`${key}:a`) ?? 0) : 0;
  const bodyMax = Math.max(64, room - outH - padY * 2 - fH - artH - 2);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  const scrolls = bh > bodyMax + 1;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`${key}-card`, () => {
      if (o.art) {
        const r = ui.column(`${key}-art`, () => o.art!(inner), { width: inner });
        lastHeight.set(`${key}:a`, r.height / L.sc + 10);
      }
      const inside = (w: number): void => {
        const r = ui.column(`${key}-body`, () => body(w), { width: w, spacing: compact ? 8 : 10 });
        lastHeight.set(`${key}:b`, r.height / L.sc);
      };
      if (scrolls) ui.scrollArea(`${key}-scroll`, { width: inner, height: bodyMax }, () => inside(inner - 12));
      else inside(inner);
      if (o.footer) {
        const r = ui.column(`${key}-foot`, () => o.footer!(inner), { width: inner, spacing: 10 });
        lastHeight.set(`${key}:f`, r.height / L.sc);
      }
    }, { style: ["card", ...(compact ? ["card-compact"] : [])], width, spacing: 10, padding: { top: padY, bottom: padY, start: padX, end: padX } });
    if (o.outside) {
      const r = ui.column(`${key}-out`, () => o.outside!(width), { width, align: "center" });
      lastHeight.set(`${key}:o`, r.height / L.sc);
    }
  }, { style: o.overlay ? "overlay" : "screen", width: L.lw, height: L.lh, align: "center", justify: "center", spacing: 12 });
}
function h2(text: string, id: string): void { ui.style("h2").id(id).heading(text); }
function backButton(key: string): (w: number) => void {
  return () => { button({ id: `btn-${key}-back`, text: T("Back"), act: goBack }); };
}
/** A column of full-width buttons (`.menu-col`). */
function menuCol(key: string, list: Btn[], w: number): void {
  ui.column(key, () => { for (const b of list) button(b, w); }, { spacing: 10, width: w });
}

// ------------------------------------------------------------------ menu screens
function menuScreen(L: Layout): void {
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "journey": journeyScreen(L); break;
    case "practice": practiceScreen(L); break;
    case "challenge": challengeScreen(L); break;
    case "daily": dailyScreen(L); break;
    case "score": scoreScreen(L); break;
    default: break;
  }
}

function accountLine(): string {
  if (!platform.signedIn()) return T("Offline — progress is stored on this device.");
  const sync = platform.syncState();
  const st = sync === "synced" ? T("progress synced") : sync === "saving" ? T("saving…") : T("cloud sync unavailable");
  return `${T("Playing as {name}", { name: platform.displayName() || "…" })} · ${st}`;
}
function titleProgress(): string {
  const t = Session.getTotals();
  const stars = Session.totalStars();
  const unlocked = Content.THEMES.filter((th) => th.unlockStars <= stars).length;
  return t.rounds === 0
    ? T("New pilot — start with the Learn lessons or jump into Journey.")
    : T("Stars {stars} · Rounds {rounds} · Cores {wins} · Themes {themes}/{total}", { stars, rounds: t.rounds, wins: t.wins, themes: unlocked, total: Content.THEMES.length });
}
function titleScreen(L: Layout): void {
  const short = L.shortLand || (L.lw > L.lh && L.lh < 640);
  backdrop("title-art", () => {
    const f = frame();
    draw.rect(0, 0, f.width, f.height, "#0b0918");
    if (art.key && !ui.preferences().highContrast) cover(art.key, 0, 0, f.width, f.height);
  });
  const w = Math.min(L.lw - 32, short ? 560 : 640);
  const colW = Math.min(320, L.lw * 0.9);
  const key = "title";
  const room = L.lh - 24;
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  const build = (): void => {
    const r = ui.column("title-body", () => {
      const logoCls = ["title-logo", ...(short || L.lw < 420 ? ["title-logo-compact"] : L.lw < 700 ? ["title-logo-mid"] : [])];
      ui.style(...logoCls).id("title-logo").label("CORE BREAKER");
      para(T("Hold to smash crystal. Release before armor. Break the core."), w, "subtitle", "subtitle", true);
      const modes: Btn[] = [
        { id: "btn-play", text: T("Play"), style: ["btn", "btn-primary"], act: openPlay },
        { id: "btn-daily", text: T("Daily Challenge"), act: () => showScreen("daily") },
        { id: "btn-journey", text: T("Journey"), act: () => showScreen("journey") },
        { id: "btn-practice", text: T("Practice"), act: () => showScreen("practice") },
        { id: "btn-challenge", text: T("Challenges"), act: () => showScreen("challenge") },
        { id: "btn-score", text: T("Score Chase"), act: () => showScreen("score") },
      ];
      if (short) {
        // Phone landscape: the six mode buttons three across so the whole menu fits.
        const gw = Math.min(560, L.lw * 0.92), cw = (gw - 16) / 3;
        ui.column("title-grid", () => {
          for (let i = 0; i < modes.length; i += 3) {
            ui.row(`title-grid-${i}`, () => { for (const b of modes.slice(i, i + 3)) button(b, cw); }, { spacing: 8 });
          }
        }, { spacing: 8, width: gw });
      } else menuCol("title-modes", modes, colW);
      flow("title-row", [
        { id: "btn-learn", text: T("Learn"), act: openLearn },
        { id: "btn-settings", text: T("Settings"), act: () => openOverlay("settings") },
        { id: "btn-help", text: T("How to Play"), act: () => openOverlay("help") },
      ], w, "center", short ? 8 : 10);
      const account: Btn[] = [];
      const link = platform.inviteLink();
      if (link) {
        account.push({
          id: "btn-invite", text: T("Invite a friend"),
          act: () => {
            try { clipboard.writeText(link); app.toast = { text: () => T("Invite link copied to the clipboard."), until: frame().time + 2.6 }; }
            catch { app.toast = { text: () => T("Could not copy — invite link: {link}", { link }), until: frame().time + 6 }; }
          },
        });
      }
      if (!platform.signedIn()) account.push({ id: "btn-signin", text: T("Sign in with StarHermit"), act: () => { void requestSignIn().catch(() => undefined); } });
      if (account.length) flow("title-account", account, w, "center");
      para(titleProgress(), w, "small", "title-progress", true);
      para(accountLine(), w, "small", "account-line", true);
    }, { width: w, align: "center", spacing: short ? 8 : 12 });
    lastHeight.set(`${key}:b`, r.height / L.sc);
  };
  ui.place("scr-title", { anchor: "top-start", x: 0, y: 0 }, () => {
    if (bh > room) ui.scrollArea("title-scroll", { width: Math.min(L.lw, w + 24), height: L.lh }, build);
    else build();
  }, { style: "screen-title", width: L.lw, height: L.lh, align: "center", justify: "center" });
}

function stageLabel(i: number, locked: boolean): string {
  const lv = Content.JOURNEY[i]!;
  const stars = Session.getJourney(lv.id)?.stars ?? 0;
  return T("Stage {n}: {name}", { n: i + 1, name: T(lv.name) }) + (locked ? ` ${T("(locked)")}` : "") + (stars ? `, ${T(stars === 1 ? "{n} star" : "{n} stars", { n: stars })}` : "");
}
function journeyScreen(L: Layout): void {
  card("journey", L, (w) => {
    h2(T("Journey"), "journey-h");
    para(T("40 authored descents. Mastery stages glow gold. Earn stars to unlock themes."), w, "small", "journey-blurb");
    const gap = 8;
    const cols = Math.max(1, Math.floor((w + gap) / (64 + gap)));
    const cell = (w - gap * (cols - 1)) / cols;
    const c = colors();
    let prevDone = true; // stage 1 is always open
    const open: boolean[] = Content.JOURNEY.map((lv) => {
      const o = prevDone;
      prevDone = (Session.getJourney(lv.id)?.stars ?? 0) > 0;
      return o;
    });
    ui.column("journey-grid", () => {
      for (let i = 0; i < Content.JOURNEY.length; i += cols) {
        ui.row(`jrow-${i}`, () => {
          for (let k = i; k < Math.min(Content.JOURNEY.length, i + cols); k++) {
            const lv = Content.JOURNEY[k]!;
            const stars = Session.getJourney(lv.id)?.stars ?? 0;
            const locked = !open[k];
            const marks: Glyph[] = stars === 2 ? ["star", "star"] : stars === 1 ? ["star"] : locked ? ["lock"] : ["dot"];
            const clicked = ui.style("jstage", lv.mastery ? "jstage-mastery" : null, { width: cell, height: 52 }).id(`jstage-${k + 1}`).button(stageLabel(k, locked), {
              disabled: locked,
              content: () => {
                ui.column(`jstage-${k + 1}-face`, () => {
                  ui.style("jstage-num").label(String(k + 1));
                  glyphs(marks, 11, locked ? c.dim : c.gold);
                }, { align: "center", spacing: 2 });
              },
            });
            if (clicked) { audio.cue("ui"); openIntro(lv, "journey", { levelIndex: k }); }
          }
        }, { spacing: gap });
      }
    }, { spacing: gap, width: w });
  }, { maxW: L.wide ? 720 : 640, outside: backButton("journey") });
}

/** A choice button with a bold title and a small second line (`.choice-list button`). */
function choice(id: string, title: string, sub: string, w: number, act: () => void): void {
  button({
    id, text: title, style: ["btn", "btn-choice"], act,
    face: () => {
      ui.column(`${id}-face`, () => {
        para(title, w - 36, "choice-title");
        para(sub, w - 36, "choice-sub");
      }, { spacing: 2, align: "start" });
    },
  }, w);
}
function themeOptions(): { names: string[]; ids: string[]; locked: boolean[] } {
  const stars = Session.totalStars();
  const names: string[] = [], ids: string[] = [], locked: boolean[] = [];
  for (const th of Content.THEMES) {
    const l = th.unlockStars > stars;
    names.push(T(th.name) + (l ? ` ${T("(locked: {n} stars)", { n: th.unlockStars })}` : ""));
    ids.push(th.id);
    locked.push(l);
  }
  return { names, ids, locked };
}
function themeSelect(id: string, label: string, w: number): void {
  const o = themeOptions();
  const idx = Math.max(0, o.ids.indexOf(String(settings.theme)));
  ui.row(`${id}-row`, () => {
    para(label, Math.max(80, w - 230), "body");
    ui.spacer();
    const next = ui.style({ width: Math.min(220, w * 0.6) }).id(id).select(label, idx, o.names.map((n, i) => ({ text: n, disabled: !!o.locked[i] })));
    if (next !== idx && !o.locked[next]) platform.setSetting("theme", o.ids[next]!);
  }, { width: w, align: "center", spacing: 14 });
}
function practiceScreen(L: Layout): void {
  card("practice", L, (w) => {
    h2(T("Practice"), "practice-h");
    para(T("Unranked — a fresh random shaft each run, local best only. Undo and hints are on. Pick a difficulty and theme."), w, "small", "practice-blurb");
    ui.column("practice-list", () => {
      for (const p of Content.PRACTICE) {
        const best = Session.getBest(`practice-${p.id}`);
        const sub = T("{layers} layers · {sectors} sectors · armor {armor}%", { layers: p.layers, sectors: p.sectors, armor: Math.round(p.armorPct * 100) }) +
          (best != null ? ` · ${T("best {score}", { score: fmtScore(best) })}` : "");
        choice(`practice-${p.id}`, T(p.name), sub, w, () => startPractice(p));
      }
    }, { spacing: 10, width: w });
    themeSelect("practice-theme", T("Theme"), w);
  }, { maxW: L.wide ? 720 : 640, outside: backButton("practice") });
}
function challengeScreen(L: Layout): void {
  card("challenge", L, (w) => {
    h2(T("Challenges"), "challenge-h");
    para(T("Constrained goals: timers, no charge cell, no assists. Ranked locally."), w, "small", "challenge-blurb");
    ui.column("challenge-list", () => {
      for (const c of Content.CHALLENGES) {
        const best = Session.getBest(`challenge-${c.id}`);
        choice(`challenge-${c.id}`, T(c.name), T(c.intro ?? "") + (best != null ? ` · ${T("best {score}", { score: fmtScore(best) })}` : ""), w, () => openIntro(c, "challenge", {}));
      }
    }, { spacing: 10, width: w });
  }, { maxW: L.wide ? 720 : 640, outside: backButton("challenge") });
}
function dailyScreen(L: Layout): void {
  const dateStr = dailyDate();
  const cfg = Content.dailyConfig(dateStr);
  card("daily", L, (w) => {
    h2(T("Daily Challenge"), "daily-h");
    para(`${dateStr} · ${T("{layers} layers · armor {armor}% · rotation {rot}", { layers: cfg.layers, armor: Math.round(cfg.armorPct * 100), rot: cfg.rotSpeed })}` +
      (cfg.timeLimitSec ? ` · ${T("{n}s containment timer", { n: cfg.timeLimitSec })}` : "") + ` · ${T("par {n}s", { n: cfg.par!.timeSec })}`, w, "body", "daily-info");
    const d = Session.getDaily(dateStr);
    para(d
      ? T(d.won ? "Completed today: core reached, best {score}. You can improve your score." : "Completed today: attempt logged, best {score}. You can improve your score.", { score: fmtScore(d.score) })
      : T("Not attempted yet today. One shared seed for everyone."), w, "small", "daily-status");
    const nowMs = platform.nowMs();
    const dt = new Date(nowMs);
    const left = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + 1) - nowMs;
    const hh = Math.floor(left / 3600000), mm = Math.floor((left % 3600000) / 60000), ss = Math.floor((left % 60000) / 1000);
    para(`${T("Next daily in {h}h {m}m {s}s", { h: hh, m: mm, s: ss })} ${platform.timeTrusted() ? T("(server time)") : T("(local clock)")}`, w, "small", "daily-countdown");
    button({ id: "btn-daily-play", text: T("Dive Today’s Shaft"), style: ["btn", "btn-primary"], act: startDaily }, w);
  }, { maxW: L.wide ? 720 : 640, outside: backButton("daily") });
}
function scoreScreen(L: Layout): void {
  card("score", L, (w) => {
    h2(T("Score Chase — Endless Shaft"), "score-h");
    para(T("The shaft never bottoms out and armor thickens with depth. One dive, one score. No undo, no hints."), w, "body", "score-blurb");
    ui.row("score-best", () => {
      ui.style("small").label(T("Your best:"));
      ui.style("strong").id("score-best-val").label(fmtScore(Session.getBest("score")));
    }, { spacing: 6, align: "center" });
    ui.column("score-board", () => {
      const rows = app.board;
      if (rows && rows.length) {
        ui.style("board-head").label(T("— platform board —"));
        rows.slice(0, 10).forEach((e, i) => para(`#${i + 1} ${fmtScore(e.score)} — ${e.name}`, w, e.you ? "board-you" : "board-row", `pboard-${i}`));
        ui.style("board-head").label(T("— this device —"));
      }
      const local = localBoard();
      local.slice(0, 10).forEach((row, i) => {
        let date = "";
        try { date = new Date(row.atMs).toLocaleDateString(currentLocale(), { timeZone: "UTC" }); } catch { date = new Date(row.atMs).toISOString().slice(0, 10); }
        para(`${i + 1}. ${fmtScore(row.score)} — ${T("depth {n}", { n: row.depth })} (${date})`, w, "board-row", `lboard-${i}`);
      });
      if (!local.length && !platform.signedIn()) para(T("No dives yet. Yours will appear here; hosted boards compare with friends."), w, "board-row", "board-empty");
    }, { spacing: 2, width: w });
    button({ id: "btn-score-play", text: T("Start Endless Dive"), style: ["btn", "btn-primary"], act: startScoreChase }, w);
  }, { maxW: L.wide ? 720 : 640, outside: backButton("score") });
}

// ------------------------------------------------------------------ overlays
function introOverlay(L: Layout): void {
  const cfg = playCfg;
  if (!cfg) { closeOverlay(); return; }
  const lesson = playCtx.lesson;
  card("intro", L, (w) => {
    h2(lesson ? T(lesson.title) : cfgName(cfg, playKind ?? ""), "intro-h");
    para(lesson ? T(lesson.text) : cfg.intro ? T(cfg.intro) : T("Reach the core at the bottom of the shaft."), w, "body", "intro-text");
    const meta = [T("{n} layers", { n: cfg.layers }), T("{n} sectors", { n: cfg.sectors })];
    if (cfg.timeLimitSec) meta.push(T("{n}s timer", { n: cfg.timeLimitSec }));
    meta.push(cfg.chargeMax ? T("charge cell ×{n}", { n: cfg.chargeMax }) : T("no charge cell"));
    meta.push(cfg.mechanics.undo ? T("undo on") : T("no undo"));
    meta.push(cfg.mechanics.hint ? T("hints on") : T("no hints"));
    meta.push(playKind === "tutorial" ? T("unranked") : playKind === "practice" ? T("local best only") : T("ranked locally"));
    para(meta.join(" · "), w, "small", "intro-meta");
  }, {
    maxW: 560, overlay: true,
    footer: (w) => menuCol("intro-actions", [
      { id: "btn-intro-start", text: T("Start"), style: ["btn", "btn-primary"], act: startPlay },
      { id: "btn-intro-cancel", text: T("Cancel"), act: closeOverlay },
    ], w),
  });
}
function pauseOverlay(L: Layout): void {
  card("pause", L, () => { h2(T("Paused"), "pause-h"); }, {
    maxW: 560, overlay: true,
    footer: (w) => menuCol("pause-actions", [
      { id: "btn-resume", text: T("Resume"), style: ["btn", "btn-primary"], act: resumeGame },
      { id: "btn-restart", text: T("Restart"), act: restart },
      { id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") },
      { id: "btn-pause-help", text: T("How to Play"), act: () => openOverlay("help") },
      { id: "btn-quit", text: T("Leave Round"), style: ["btn", "btn-danger"], act: quitToTitle },
    ], w),
  });
}
function resultsOverlay(L: Layout): void {
  const R = app.results;
  if (!R) return;
  const { s, won, parMet } = R;
  const c = colors();
  const showArt = !L.shortLand && L.lh >= 560;
  const img = won ? art.win : art.lose;
  card("results", L, (w) => {
    h2(won ? T("Core Reached!") : T("Dive Over"), "res-headline");
    if (showArt && !ui.preferences().highContrast) {
      const h = Math.min(150, Math.round(w * 0.3), L.lh < 700 ? 90 : 150);
      ui.widget("", {
        role: "none", size: { width: w, height: h }, style: "res-art",
        draw: (r) => {
          if (img) cover(img, r.x, r.y, r.width, r.height);
          else draw.roundRect(r.x, r.y, r.width, r.height, 10 * L.sc, "#141126");
        },
      });
    }
    para(`${cfgName(playCfg, playKind ?? "")} — ${reasonText(s.terminal!.reason)} · ${T("time {time}", { time: fmtTime(s.elapsedMs) })}${parMet ? ` · ${T("par beaten")}` : ""}`, w, "small", "res-reason");
    const rows: [string, string][] = [
      [T("Breaks"), `${s.score.breaks} → ${fmtScore(s.score.breakPoints)}`],
      [T("Gap passes"), `${s.score.passes} → ${fmtScore(s.score.passPoints)}`],
      [T("Overdrives"), `${s.score.overdrives} → ${fmtScore(s.score.overdrivePoints)}`],
    ];
    if (won) {
      rows.push([T("Time bonus"), fmtScore(s.score.timeBonus)]);
      rows.push([T("Momentum bonus"), `${fmtScore(s.score.multBonus)} ${T("(best ×{n})", { n: s.bestMult })}`]);
      rows.push([T("Charge bonus"), fmtScore(s.score.chargeBonus)]);
    }
    const numW = Math.max(60, ...rows.map((r) => textWidth(r[1], "res-num") + 4));
    const lblW = Math.max(60, w - numW);
    ui.grid("res-breakdown", () => {
      for (const [a, b] of rows) {
        para(a, lblW - 16, "res-td");
        ui.style("res-num").label(b);
      }
      ui.gridRow("res-total-row").style("res-total").label(T("Total"));
      ui.style("res-total", { text: { align: "end" } }).id("res-total").label(fmtScore(s.score.total));
    }, { columns: [{ width: lblW }, { fr: 1, align: "end" }], gap: 0, width: w });
    // progress line (the ★ marks of "★★ Par beaten" / "★ Stage clear" are drawn)
    const prog: string[] = [];
    if (R.isNewBest) prog.push(T("New personal best!"));
    let starsMark = 0;
    if (playKind === "journey" && won) {
      starsMark = parMet ? 2 : 1;
      prog.push(bare(parMet ? T("★★ Par beaten") : T("★ Stage clear")));
      const stars = Session.totalStars();
      const nextTheme = Content.THEMES.filter((th) => th.unlockStars > stars).sort((a, b) => a.unlockStars - b.unlockStars)[0];
      if (nextTheme) prog.push(T("{n} stars to unlock theme “{name}”", { n: nextTheme.unlockStars - stars, name: T(nextTheme.name) }));
    }
    if (playKind === "daily" && playCtx.date) prog.push(T("Daily logged for {date}", { date: playCtx.date }));
    if (prog.length) {
      ui.row("res-progress-row", () => {
        if (starsMark) glyphs(starsMark === 2 ? ["star", "star"] : ["star"], 12, c.gold);
        para(prog.join(" · "), w - (starsMark ? starsMark * 14 + 6 : 0), "small", "res-progress");
      }, { spacing: 6, align: "start", width: w });
    }
    const lb = app.lb;
    if (lb) {
      para(lb === "posting" ? T("Posting score to the leaderboard…") : !lb.posted ? T("Score not posted to the leaderboard.")
        : lb.rank ? T("Leaderboard rank: #{rank}", { rank: lb.rank }) : T("Score posted to the leaderboard."), w, "small", "res-leaderboard");
    }
    para(T("Replay hash {hash} · seed {seed} · {n} commands", { hash: R.replay.hash.toString(16), seed: R.replay.seed, n: R.commands }), w, "small", "res-replay");
  }, {
    maxW: 560, overlay: true,
    footer: (w) => {
      const list: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: ["btn", "btn-primary"], act: retry }];
      if (R.next) list.push({ id: "btn-next", text: T("Next Stage"), act: nextStage });
      list.push({ id: "btn-res-exit", text: T("Exit to Title"), act: quitToTitle });
      if (L.shortLand) flow("res-actions", list, w, "center");
      else menuCol("res-actions", list, w);
    },
  });
}

function settingsOverlay(L: Layout): void {
  card("settings", L, (w) => {
    h2(T("Settings"), "settings-h");
    const check = (key: "captions" | "leftHanded" | "holdToggle" | "timingAssist", label: string): void => {
      const cur = !!settings[key];
      const next = ui.id(`set-${key}`).checkbox(label, cur);
      if (next !== cur) { audio.cue("ui"); platform.setSetting(key, next ? 1 : 0); }
    };
    ui.style("h3").label(T("Audio"));
    check("captions", T("Sound captions"));
    ui.style("h3").label(T("Accessibility & controls"));
    check("leftHanded", T("Left-handed tray"));
    check("holdToggle", T("Toggle instead of hold"));
    check("timingAssist", T("Timing assist (stronger hints)"));
    ui.style("h3").label(T("Theme"));
    themeSelect("set-theme", T("Practice theme"), w);
    // Volumes, mute, graphics, language, key bindings, text size, contrast and reduced motion are the runtime's Options.
    para(T("Sound, graphics, language, controls, text size, high contrast and reduced motion are in the StarHermit Options."), w, "small", "options-note");
    button({ id: "btn-options", text: T("Open Options"), act: () => openMenu() }, Math.min(w, buttonWidth({ id: "", text: T("Open Options"), act: () => undefined })));
  }, {
    maxW: 560, overlay: true,
    footer: (w) => menuCol("settings-actions", [{ id: "btn-settings-close", text: T("Done"), style: ["btn", "btn-primary"], act: closeOverlay }], w),
  });
}

/** An action's keys as How to Play names them, from the player's bindings. */
function keysFor(action: string): string {
  const names = bindings(action).filter((b) => b.device === "keyboard").map((b) => {
    const arrow = /^Arrow ?(Up|Down|Left|Right)$/.exec(b.label);
    if (arrow) return T("{dir} arrow", { dir: T(arrow[1]!) });
    return b.label === "Space" || b.label === "Enter" || b.label === "Escape" ? T(b.label) : b.label;
  });
  return names.join(" / ") || "—";
}
function padFor(action: string): string { return bindings(action).filter((b) => b.device === "gamepad").map((b) => b.label).join(" / ") || "—"; }
function helpOverlay(L: Layout): void {
  card("help", L, (w) => {
    h2(T("How to Play"), "help-h");
    const cards: [string, string][] = [
      [T("Hold to dive"), T("Press and hold (mouse, touch, or Space). The striker smashes through bright crystal segments and builds momentum — each consecutive break is worth more.")],
      [T("Release for armor"), T("Dark spiked segments are armored. Landing on one ends the dive unless your charge cell is full. Release to hover and let a safe segment rotate in — hovering slowly bleeds descent progress.")],
      [T("Gaps"), T("Missing segments are gaps: you fall straight through, keep your streak, and gain a few points.")],
      [T("Charge & overdrive"), T("Safe breaks charge the striker. At full charge the next armored segment shatters too — an overdrive worth big points.")],
      [T("Momentum"), T("Releasing resets your ×multiplier. Long controlled streaks win stages and beat par.")],
      [T("Undo"), T("In relaxed modes each release banks a rewind point. Press U or Undo to return to your last release.")],
    ];
    cards.forEach(([h, p], i) => {
      ui.column(`help-card-${i}`, () => {
        ui.style("strong").label(`${h}.`);
        para(p, w, "body");
      }, { spacing: 2, width: w });
    });
    ui.style("h3").label(T("Controls"));
    const ctrls = [
      T("Mouse / touch: hold anywhere on the playfield (or the HOLD button) to dive; release to hover."),
      T(settings.holdToggle ? "{keys}: hold to dive, release to hover (toggle mode: tap)." : "{keys}: hold to dive, release to hover.", { keys: keysFor("dive") }),
      T("{keys}: tap to toggle dive/hover.", { keys: keysFor("toggle") }),
      T("{pause} or {back}: pause / resume. {undo}: undo (where allowed). {retry}: retry from results.", { pause: keysFor("pause"), back: keysFor("back"), undo: keysFor("undo"), retry: keysFor("retry") }),
      T("Gamepad: {dive} dives, {toggle} toggles, {pause} pauses, {undo} undoes, {back} backs out.", { dive: padFor("dive"), toggle: padFor("toggle"), pause: padFor("pause"), undo: padFor("undo"), back: padFor("back") }),
    ];
    ctrls.forEach((c, i) => para(`• ${c}`, w, "body", `help-ctrl-${i}`));
  }, {
    maxW: 560, overlay: true,
    footer: (w) => menuCol("help-actions", [{ id: "btn-help-close", text: T("Close"), style: ["btn", "btn-primary"], act: closeOverlay }], w),
  });
}

// ------------------------------------------------------------------ the play layer
let holdBtnDown = false;
function playLayer(L: Layout): void {
  const s = playState!;
  const cfg = playCfg!;
  const c = colors();
  const left = !!settings.leftHanded;
  // The HUD's dark top band (pointer-transparent).
  backdrop("hud-band", () => {
    const f = frame();
    const h = (L.narrow ? 150 : 110) * L.sc;
    for (let i = 0; i < 12; i++) draw.rect(0, (h * i) / 12, f.width, h / 12 + 1, `rgba(11,9,24,${(0.85 * (1 - i / 12)).toFixed(3)})`);
  });
  const valCls = ["stat-val", ...(L.wide ? ["stat-val-wide"] : L.narrow ? ["stat-val-compact"] : [])];
  const stat = (id: string, lbl: string, val: string, extra?: string | null): void => {
    ui.column(`stat-${id}`, () => {
      ui.style("stat-lbl").label(lbl);
      ui.style(...valCls, extra ?? null).id(`hud-${id}`).label(val);
    }, { spacing: 0 });
  };
  // Score, Best, Depth, Time, Momentum, Charge.
  const statsR = ui.place("hud-stats", { anchor: "top-start", x: 12, y: 8 }, () => {
    ui.row("hud-stats-row", () => {
      stat("score", T("Score"), fmtScore(liveScore(s)));
      stat("best", T("Best"), fmtScore(hudBest()));
      ui.column("stat-depth", () => {
        ui.style("stat-lbl").label(T("Depth"));
        ui.row("hud-depth-row", () => {
          ui.style(...valCls).id("hud-depth").label(cfg.endless ? `${s.depth}/` : `${s.depth}/${s.layers.length}`);
          if (cfg.endless) glyphs(["infinity"], L.narrow ? 14 : 18, c.text);
        }, { spacing: 2, align: "center" });
      }, { spacing: 0 });
      if (cfg.timeLimitSec) {
        const leftMs = cfg.timeLimitSec * 1000 - s.elapsedMs;
        stat("timer", T("Time"), fmtTime(Math.max(0, leftMs)), leftMs < 10000 ? "stat-danger" : null);
      }
      stat("mult", T("Momentum"), `×${s.mult}`);
      const max = cfg.chargeMax || 0;
      ui.column("stat-charge", () => {
        ui.style("stat-lbl").label(T("Charge"));
        ui.widget(T("Charge {n} of {max}", { n: s.charge, max }), {
          role: "image", size: { width: Math.max(14, max * 18 - 4), height: L.wide ? 28 : 22 },
          draw: (r) => {
            const k = L.sc;
            for (let i = 0; i < max; i++) {
              const cx = r.x + (7 + i * 18) * k, cy = r.y + r.height / 2;
              if (i < s.charge) { draw.circle(cx, cy, 9 * k, "rgba(255,209,102,0.35)"); draw.circle(cx, cy, 7 * k, c.gold); }
              else draw.strokeCircle(cx, cy, 6 * k, c.gold, 2 * k);
            }
          },
        });
      }, { spacing: 0 });
    }, { spacing: L.narrow ? 10 : 14, align: "end" });
  });
  const statsW = statsR.width / L.sc;
  // Undo and Pause at the end; under the stats when the row has no room.
  const btnsW = textWidth(T("Undo"), "btn", "button") + textWidth(T("Pause"), "btn", "button") + 20;
  const stacked = statsW + btnsW + 36 > L.lw;
  const statsH = statsR.height / L.sc;
  const btnY = stacked ? 8 + statsH + 8 : 8;
  const btnR = ui.place("hud-buttons", stacked ? { anchor: "top-start", x: 12, y: btnY } : { anchor: "top-end", x: 12, y: 8 }, () => {
    ui.row("hud-buttons-row", () => {
      button({ id: "btn-hud-undo", text: T("Undo"), disabled: !canUndo(), act: () => { doUndo(); ui.setFocus(null); } });
      button({ id: "btn-hud-pause", text: T("Pause"), act: pauseGame });
    }, { spacing: 8 });
  });
  const objY = (stacked ? btnY + btnR.height / L.sc : Math.max(statsH, btnR.height / L.sc) + 8) + 6;
  ui.place("hud-objective", { anchor: "top-start", x: 12, y: objY }, () => {
    para(objectiveText(), L.lw - 24, "hud-objective", "hud-objective");
  });

  // The hint pill (and the countdown numerals in it).
  const hint = hintText();
  const trayH = 56 + 18;
  const hintY = L.shortLand ? 70 : trayH + 30;
  if (hint) {
    const cls = ["hintbar", ...(hint.cls ? [hint.cls] : [])];
    ui.place("hintbar", L.shortLand ? { anchor: "bottom", x: 0, y: hintY } : { anchor: "bottom", y: hintY }, () => {
      ui.column("hintbar-box", () => {
        ui.style(hint.countdown ? "countdown-text" : "hintbar-text").id("hint-text").label(hint.text);
      }, { style: cls, align: "center" });
    });
  }
  if (app.caption) {
    const text = T(app.caption.key, app.caption.vars);
    ui.place("caption", { anchor: "bottom", y: L.shortLand ? 12 : trayH + 4 }, () => {
      ui.row("caption-row", () => {
        glyphs(["note"], 12, c.dim);
        ui.style("caption").id("caption-text").label(text);
      }, { spacing: 4, align: "center" });
    });
  }

  // The action tray: HOLD TO DIVE and Undo (reversed for the left-handed tray; at the end on short landscape).
  const holdLabel = settings.holdToggle ? T("TAP TO DIVE") : T("HOLD TO DIVE");
  const holdW = Math.max(L.narrow ? 130 : 160, Math.min(L.lw * 0.6, textWidth(holdLabel, "btn-hold") + 40));
  const trayAnchor = L.shortLand ? (left ? "bottom-start" : "bottom-end") : "bottom";
  ui.place("tray", { anchor: trayAnchor, x: L.shortLand ? 12 : 0, y: 10 }, () => {
    ui.row("tray-row", () => {
      const undoBtn = (): void => button({ id: "btn-tray-undo", text: T("Undo"), style: ["btn", { minWidth: 88 }], disabled: !canUndo(), act: () => { doUndo(); ui.setFocus(null); } });
      if (left) undoBtn();
      const held = holding();
      const res = ui.widget(holdLabel, {
        role: "button", size: { width: holdW, height: 56 }, style: ["btn-hold", ...(held ? ["btn-hold-held"] : [])],
        draw: (r) => {
          const k = L.sc;
          const fs = 17 * k * ui.preferences().textScale;
          const lines = wrapHold(holdLabel, r.width - 16 * k, fs);
          lines.forEach((ln, i) => draw.text(ln, r.x + r.width / 2, r.y + r.height / 2 - (lines.length * fs * 1.15) / 2 + i * fs * 1.15, { size: fs, weight: "700", color: c.text, align: "center" }));
        },
      });
      // The button holds while pressed (pointer or finger); Enter / Space on it act as the dive keys do.
      if (res.pressed && !holdBtnDown) { holdBtnDown = true; holdStart("button"); }
      else if (!res.pressed && holdBtnDown) { holdBtnDown = false; holdEnd("button"); }
      if (!left) undoBtn();
    }, { spacing: 12, align: "center" });
  });
}
function wrapHold(text: string, maxW: number, size: number): string[] {
  if (draw.measureText(text, { size, weight: "700" }).width <= maxW) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const wd of words) {
    const t = cur ? `${cur} ${wd}` : wd;
    if (cur && draw.measureText(t, { size, weight: "700" }).width > maxW) { lines.push(cur); cur = wd; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** The hint pill: the countdown numeral, else the next landing's segment and time (assists permitting). */
function hintText(): { text: string; cls: string | null; countdown?: boolean } | null {
  const s = playState;
  if (!s || !playCfg) return null;
  if (countingDown) return { text: String(countdownLeft), cls: null, countdown: true };
  if (s.terminal || !playCfg.mechanics.hint) return null;
  const h = Rules.hint(s);
  if (!h) return null;
  const p = h.peek;
  const seg = p.segment === 0 ? (ui.preferences().highContrast ? T("SAFE (bright)") : T("safe crystal"))
    : p.segment === 1 ? (p.chargeReady ? T("armor — OVERDRIVE READY") : T("ARMOR — release!"))
    : T("gap — fall through");
  const ms = settings.timingAssist ? Math.max(0, p.ms - 100) : p.ms;
  return { text: `${seg} · ${ms < 500 ? "<0.5s" : `${(ms / 1000).toFixed(1)}s`}`, cls: p.willCrash ? "hintbar-danger" : p.segment === 1 ? "hintbar-armor" : null };
}
