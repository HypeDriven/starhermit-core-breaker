// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, textures, bevels, wall segments, reflections,
// motion) is the browser build's four presets and budgets (js/gfx.js TABLE /
// BUDGETS) keyed by the level's quality tier, with the mote and shard counts
// scaled within the tier by the level's particle budget against the tier's
// anchor level (quantum, molecular, terrestrial, galactic), at most 4×. The
// runtime owns the rest of what the old Graphics panel did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution and
// the frame-rate limit and readout. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Ring segment materials: Lambert, standard PBR or clear-coated physical crystal and armour. */
  material: "lambert" | "standard" | "physical";
  /** Crystal / armour canvas width in px (detailed surfaces; half as tall), within the level's largest texture. */
  texture: number;
  /** Rounded-segment bevel segments (detailed surfaces). */
  bevel: number;
  /** Radial segments of the gridded shaft wall. */
  wallSegments: number;
  /** Rising shaft motes. */
  motes: number;
  /** Shard-burst pool in use. */
  shards: number;
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "detailed" | "particleShare" | "animated">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, detailed: false, particleShare: 1 / 3, animated: false },
  balanced: { reflections: true, detailed: true, particleShare: 2 / 3, animated: true },
  high: { reflections: true, detailed: true, particleShare: 1, animated: true },
  ultra: { reflections: true, detailed: true, particleShare: 1, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", texture: 128, bevel: 2, wallSegments: 24, motes: 60, shards: 60 },
  balanced: { material: "standard", texture: 256, bevel: 2, wallSegments: 32, motes: 100, shards: 100 },
  high: { material: "physical", texture: 256, bevel: 3, wallSegments: 48, motes: 160, shards: 140 },
  ultra: { material: "physical", texture: 512, bevel: 4, wallSegments: 64, motes: 240, shards: 200 },
};
export const MOTE_MAX = 600;
export const SHARD_MAX = 400;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // Motes and shards grow with the level's particle budget above the tier's anchor, at most 4× the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: {
      ...b, texture: Math.min(b.texture, s.maxTextureSize),
      motes: Math.min(MOTE_MAX, Math.round(b.motes * k)),
      shards: Math.min(SHARD_MAX, Math.round(b.shards * k)),
    },
  };
}
