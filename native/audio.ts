// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.txt) per game event, the reactor hum under a
// round (a 54 Hz sine and a 108.5 Hz triangle at gain 0.05), and the sparse
// adaptive pulse music (a 300 ms pentatonic step on a triangle that turns to
// a sawtooth above ×4 momentum, with a sub-bass pulse every other step from
// ×3). Each captioned cue also reports its caption key (main.ts shows it
// when Sound captions is on).
//
// The browser build's three buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// the hum → "effects", the menu tick and the countdown beeps → "interface";
// the old default bus levels (music 40 %, effects 80 %, ambience 35 %) are
// folded into each sound's gain. The hum and the music's notes are rendered
// once into clips (createClip) with the old oscillators' shapes and
// envelopes; the procedural stand-ins the browser build played while a clip
// decoded are not ported (a live synthesis graph makes clip loads fail on the
// engine's web runtime; the arrow-exodus port's finding), so a missing clip
// is silent. Clips load once the mixer runs (natively at once, in a browser
// after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

/** Marks an English caption key (translated where it is shown). */
const N = (s: string): string => s;
const LEVEL = { music: 0.4, effects: 0.8, ambience: 0.35 };
export type Cue =
  | "press" | "release" | "break" | "pass" | "overdrive" | "charge" | "crash" | "win" | "lose" | "ui"
  | "achievement" | "countdown" | "undo" | "lesson" | "timerWarn" | "newBest";
const SAMPLES: Record<Cue, string> = {
  press: "dive-start", release: "hover-release", break: "crystal-break", pass: "gap-pass", overdrive: "overdrive-surge",
  charge: "charge-pip", crash: "armor-crash", win: "core-reached", lose: "run-ended", ui: "ui-tick",
  achievement: "achievement-unlock", countdown: "countdown-beep", undo: "undo-rewind", lesson: "lesson-complete",
  timerWarn: "timer-warning", newBest: "new-best",
};
const CAPTIONS: Partial<Record<Cue, string>> = {
  press: N("dive start"), release: N("hover"), pass: N("gap pass"), overdrive: N("overdrive"), crash: N("armor impact"),
  win: N("core reached"), lose: N("run ended"), achievement: N("achievement unlocked"), undo: N("rewind"),
  lesson: N("lesson complete"), timerWarn: N("containment warning"), newBest: N("new personal best"),
};
const INTERFACE = new Set<Cue>(["ui", "countdown"]);

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let onCaption: ((key: string, vars: Record<string, string | number>) => void) | null = null;

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** cb(captionKey, vars) for each captioned cue (an English key; "crystal break ×{n}" carries n). */
export function setOnCaption(cb: (key: string, vars: Record<string, string | number>) => void): void { onCaption = cb; }

/** Plays a cue's sample (once loaded) and reports its caption. */
export function cue(name: Cue, mult = 1): void {
  if (onCaption) {
    if (name === "break") onCaption(N("crystal break ×{n}"), { n: mult || 1 });
    else if (CAPTIONS[name]) onCaption(CAPTIONS[name]!, {});
  }
  const file = SAMPLES[name];
  const clip = clips.get(file);
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

// -- rendered tones ----------------------------------------------------------------------
const RATE = 22050;
type Wave = "sine" | "triangle" | "sawtooth";
function wave(type: Wave, ph: number): number {
  if (type === "sine") return Math.sin(2 * Math.PI * ph);
  const f = ph - Math.floor(ph);
  return type === "triangle" ? 4 * Math.abs(f - 0.5) - 1 : 2 * f - 1;
}
/** An oscillator note with js/audio.js's envelope: peak 1 at once, exponential to 0.001 over `dur`. */
function noteClip(freq: number, type: Wave, dur: number): AudioClip {
  const n = Math.round((dur + 0.02) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = t < dur ? Math.pow(0.001, t / dur) : 0;
    out[i] = wave(type, freq * t) * env * (type === "sawtooth" ? 0.6 : 1);
  }
  return createClip([out], RATE);
}
/** The reactor hum: 2 s that loop seamlessly (108 and 217 whole cycles). */
function humClip(): AudioClip {
  const n = 2 * RATE;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = (wave("sine", 54 * t) + wave("triangle", 108.5 * t)) * 0.5;
  }
  return createClip([out], RATE);
}

// -- the pulse music ---------------------------------------------------------------------
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 110;
const notes = new Map<string, AudioClip>();
const NOTE_LIST: [string, number, Wave, number][] = [
  ["bass", ROOT / 2, "sine", 0.3],
  ...SCALE.flatMap((d) => [0, 12].flatMap((o) => (["triangle", "sawtooth"] as Wave[]).map((w) =>
    [`${w}${d + o}`, ROOT * Math.pow(2, (d + o) / 12), w, 0.22] as [string, number, Wave, number]))),
];
let hum: AudioClip | null = null;
let humSound: Sound | null = null;
let wantHum = false;
let musicOn = false;
let intensity = 0;
let step = 0;
let nextStep = 0;
let nextRender = 0;
let paused = false;

export function startMusic(): void { if (!musicOn) { musicOn = true; step = 0; nextStep = 0; } }
export function stopMusic(): void { musicOn = false; }
export function setMusicIntensity(mult: number): void { intensity = mult | 0; }
/** The hum under a round (stopped while the window is hidden). */
export function startAmbience(): void { wantHum = true; }
export function stopAmbience(): void {
  wantHum = false;
  if (humSound) { try { humSound.stop(); } catch { /* gone */ } }
  humSound = null;
}
/** Hidden window: music holds and the hum stops (as the browser build did). */
export function setPaused(on: boolean): void { paused = on; }

/** Each frame: the clips once the mixer runs (one at a time), the rendered
 * notes one each half second after them, the hum, then the music's steps by
 * mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of Object.values(SAMPLES)) load(name);
    return;
  }
  pump();
  if (loading || queue.length) return;
  try {
    if (context.currentTime >= nextRender) {
      if (!hum) { hum = humClip(); nextRender = context.currentTime + 0.5; return; }
      for (const [k, f, type, d] of NOTE_LIST) {
        if (!notes.has(k)) { notes.set(k, noteClip(f, type, d)); nextRender = context.currentTime + 0.5; return; }
      }
    }
    const humOn = wantHum && !paused;
    if (humOn && hum && !humSound) humSound = playClip(hum, { bus: "effects", gain: 0.05 * 2 * LEVEL.ambience, loop: true });
    else if (!humOn && humSound) { try { humSound.stop(); } catch { /* gone */ } humSound = null; }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!musicOn || paused) return;
  const now = context.currentTime;
  if (now < nextStep) return;
  nextStep = Math.max(now, nextStep) + 0.3;
  const s = step++;
  const semis = SCALE[s % SCALE.length]! + 12 * (Math.floor(s / SCALE.length) % 2);
  const clip = notes.get(`${intensity > 4 ? "sawtooth" : "triangle"}${semis}`);
  const vol = 0.05 + Math.min(0.05, intensity * 0.008);
  try {
    if (clip) playClip(clip, { bus: "music", gain: vol * LEVEL.music });
    const bass = notes.get("bass");
    if (intensity >= 3 && s % 2 === 0 && bass) playClip(bass, { bus: "music", gain: 0.08 * LEVEL.music });
  } catch { /* the mixer is full */ }
}
