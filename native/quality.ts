// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the mote and shard counts scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 4×, never below the tier's floor). The runtime owns the rest
// of what the old Graphics panel did: Auto and the level choice, render scale
// and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout, and the shadow-map size and MSAA samples it holds to the level.
// The per-category overrides of the old panel are not offered (the runtime's
// Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Ring segment materials: Lambert, standard PBR or clear-coated physical crystal and armour. */
  material: "lambert" | "standard" | "physical";
  /** Crystal / armour canvas width in px (detailed surfaces; half as tall). */
  texture: number;
  /** Rounded-segment bevel segments (detailed surfaces). */
  bevel: number;
  /** Radial segments of the gridded shaft wall. */
  wallSegments: number;
  /** Rising shaft motes. */
  motes: number;
  /** Shard-burst pool in use. */
  shards: number;
  /** Bloom and GTAO resolution as a fraction of the frame. */
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting (crystal and armour reflections). */
  reflections: boolean;
  /** Bevelled, textured, clear-coated segments. */
  detailed: boolean;
  /** Share of each shard burst (low ⅓, medium ⅔, high all). */
  particleShare: number;
  /** Animated surround: rising motes, pulsing core and beam. */
  animated: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particleShare: 1 / 3, animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particleShare: 2 / 3, animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particleShare: 1, animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particleShare: 1, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", texture: 128, bevel: 2, wallSegments: 24, motes: 60, shards: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, bevel: 2, wallSegments: 32, motes: 100, shards: 100, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, bevel: 3, wallSegments: 48, motes: 160, shards: 140, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, bevel: 4, wallSegments: 64, motes: 240, shards: 200, bloomRes: 1, aoRes: 1 },
};
export const MOTE_MAX = 600;
export const SHARD_MAX = 400;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: motes and shards grow
  // with the level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.shards = Math.min(SHARD_MAX, Math.round(b.shards * k));
  return { preset, ...TABLE[preset], budget: b };
}
