// The crystalline reactor shaft on starhermit:scene, as the browser build's
// js/render.js drew it under its DOM layer: a windowed pool of ring segments
// (3 layers above to 12 below the striker) on the rotating shaft, the
// flat-shaded icosahedron striker with its glow light, the charge pips
// orbiting above it, the golden core under the last layer with its light,
// the faint energy beam rising from it, the gridded shaft wall scrolling with
// descent, rising dust motes, additive shard bursts on breaks, overdrives,
// crashes and the core, and the tiered camera shake and depth drift. It reads
// rules snapshots only and never changes them. The content theme sets the
// palette (high contrast swaps in its saturated safe / armour hues); the
// graphics level sets the look (quality.ts): segment materials and texture
// sizes, bevels, shadows, reflections, AO, bloom, the grade, anti-aliasing,
// shard and mote budgets and the animated surround. Reduced motion freezes
// the striker spin, camera drift and shake, motes and pulses.
//
// From three.js r160: the page's light intensities and shadow box (engine
// minor 28); the post chain (GTAO, UnrealBloom, the grade shader, SMAA/FXAA)
// is renderer.ao / bloom / grade / antialias; per-material envMaps stand for
// r160's envMapIntensity on scene.environment; the procedural canvas textures are
// OffscreenCanvas from starhermit:canvas (without the vein glow's canvas
// shadowBlur, drawn as a wider faint stroke under the bright one).
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  CylinderGeometry, DirectionalLight, Fog, Group, HemisphereLight, IcosahedronGeometry, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry, PMREMGenerator, PerspectiveCamera,
  PointLight, Points, PointsMaterial, RepeatWrapping, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, Vector3,
  renderer, scene, type OrthographicCamera, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, RNG, type RulesEvent, type State, type Theme } from "./classic.ts";
import { MOTE_MAX, SHARD_MAX, type Look } from "./quality.ts";

// ---- authored framing constants ----
const RADIUS = 3.2;            // shaft ring radius
const LAYER_H = 1.5;           // world units per layer
const SEG_W = 2.6, SEG_H = 0.5, SEG_D = 1.1;
const STRIKER_Y = 0;
const CAM_POS = { x: 0, y: 4.6, z: 9.2 };
const CAM_LOOK = { x: 0, y: -1.2, z: 0 };
const WINDOW_ABOVE = 3, WINDOW_BELOW = 12;
const WALL_R = 11, WALL_H = 70;
const PI = Math.PI;
/** three.js's physically based intensities in the engine's units. */

type Palette = Theme["palette"];

const camera = new PerspectiveCamera(46, 16 / 9, 0.1, 120);
camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);
renderer.camera = camera;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
let camBase = { x: CAM_POS.x, y: CAM_POS.y, z: CAM_POS.z };
let aspect = 0;

let look: Look | null = null;
let pal: Palette = Content.THEMES[0]!.palette;
let themeId = "";
let highContrast = false;
let reducedMotion = false;
let clock = 0;
const avRng = RNG.create(12345);

// ---------------------------------------------------------------- lights and fixtures
const keyLight = new DirectionalLight(0xffffff, 1.8);
const KEY_TARGET = new Vector3(0, -6, 0);
keyLight.target.position.copy(KEY_TARGET);
keyLight.position.copy(KEY_TARGET).addScaledVector(new Vector3(4, 8, 6).normalize(), 30);
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.02;
fitShadow();
scene.add(keyLight);
scene.add(keyLight.target);
const fillLight = new HemisphereLight(0x8888ff, 0x221133, 0.55);
const rimLight = new DirectionalLight(0x9be8ff, 0.9);
rimLight.position.set(-5, 2, -7);
scene.add(fillLight);
scene.add(rimLight);
scene.fog = new Fog(pal.fog, 14, 36);

const shaftGroup = new Group();
scene.add(shaftGroup);

const strikerMat = new MeshPhysicalMaterial({
  color: 0xd8f4ff, emissive: 0x9be8ff, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.1,
  clearcoat: 0.6, clearcoatRoughness: 0.2, flatShading: true, envMapIntensity: 0.3,
});
const striker = new Mesh(new IcosahedronGeometry(0.62, 1), strikerMat);
striker.position.set(0, STRIKER_Y, RADIUS);
striker.castShadow = true;
scene.add(striker);
// The glow light sits at the striker's centre: it lights the crystal around it, not the striker's own faces.
const strikerLight = new PointLight(0x9be8ff, 1, 4, 2);
strikerLight.position.copy(striker.position);
scene.add(strikerLight);

const pipGroup = new Group();
pipGroup.position.set(0, STRIKER_Y + 1.1, RADIUS);
scene.add(pipGroup);
const pipGeo = new OctahedronGeometry(0.12, 1);
const pips: { mesh: Mesh; mat: MeshBasicMaterial }[] = [];

const coreMat = new MeshStandardMaterial({ color: 0xffd166, emissive: 0xffd166, emissiveIntensity: 1.3, roughness: 0.3 });
const coreGlow = new Mesh(new CylinderGeometry(RADIUS * 0.8, RADIUS * 0.9, 0.4, 32), coreMat);
shaftGroup.add(coreGlow);
const coreLight = new PointLight(0xffd166, 30, 14, 1.4);
shaftGroup.add(coreLight);

/** js/render.js fitShadow: the rendered window (3 layers above to 12 below, ring plus striker) in light space. */
function fitShadow(): void {
  const pos = keyLight.position, z = pos.clone().sub(KEY_TARGET).normalize();
  const x = new Vector3(0, 1, 0).cross(z).normalize(), y = z.clone().cross(x);
  const e = RADIUS + SEG_W * 0.5 + 0.2, ys = [STRIKER_Y + WINDOW_ABOVE * LAYER_H, STRIKER_Y - WINDOW_BELOW * LAYER_H - 1];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const xi of [-1, 1]) for (const yv of ys) for (const zi of [-1, 1]) {
    const v = new Vector3(xi * e, yv, zi * e).sub(pos);
    const c = [v.dot(x), v.dot(y), v.dot(z)];
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, c[i]!); hi[i] = Math.max(hi[i]!, c[i]!); }
  }
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.left = lo[0]!; cam.right = hi[0]!; cam.bottom = lo[1]!; cam.top = hi[1]!;
  cam.near = Math.max(0.1, -hi[2]! - 1); cam.far = -lo[2]! + 1;
  cam.updateProjectionMatrix();
}

/** r160 scaled scene.environment by each material's envMapIntensity: give every lit material its own envMap. */
function applyEnvMaps(): void {
  const env = look && look.reflections ? envTex : null;
  const list: unknown[] = [strikerMat, coreMat];
  if (mats) for (const d of [mats.plain, mats.detailed]) list.push(d.safe, d.armor);
  for (const m of list) if (m instanceof MeshStandardMaterial || m instanceof MeshPhysicalMaterial) m.envMap = env;
}

// ---------------------------------------------------------------- procedural textures
function canvasTex(w: number, h: number, paint: (g: OffscreenCanvasRenderingContext2D, w: number, h: number) => void, k = 1): Texture {
  const c = new OffscreenCanvas(Math.round(w * k), Math.round(h * k));
  const g = c.getContext("2d");
  g.scale(k, k);
  paint(g, w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
type Rng = { next(): number };
function veins(g: OffscreenCanvasRenderingContext2D, r: Rng, w: number, h: number): void {
  for (let k = 0; k < 7; k++) {
    g.beginPath();
    let x = r.next() * w, y = r.next() * h;
    g.moveTo(x, y);
    for (let s = 0; s < 4; s++) { x += (r.next() - 0.5) * 90; y += (r.next() - 0.5) * 60; g.lineTo(x, y); }
    g.stroke();
  }
}
/** Crystal: soft value noise + angular facet veins; the vein layer drives the emissive glow. */
function crystalTextures(k: number): { map: Texture; glow: Texture } {
  const r = RNG.create(771);
  const map = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#e6e6e6"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = 200 + Math.floor(r.next() * 55);
      g.fillStyle = `rgba(${v},${v},${v},0.35)`;
      g.fillRect(r.next() * w, r.next() * h, 2 + r.next() * 10, 2 + r.next() * 6);
    }
    g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 1.4;
    veins(g, r, w, h);
  }, k);
  const glow = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#2a2a2a"; g.fillRect(0, 0, w, h);
    // the same veins as the map (the same stream after the noise)
    const halo = RNG.create(771), core = RNG.create(771);
    for (let i = 0; i < 900 * 5; i++) { halo.next(); core.next(); }
    g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 6;
    veins(g, halo, w, h);
    g.strokeStyle = "#ffffff"; g.lineWidth = 1.6;
    veins(g, core, w, h);
  }, k);
  return { map, glow };
}
/** Armour: brushed plate with panel seams and rivets; a warning chevron band glows along the edge. */
function armorTextures(k: number): { map: Texture; glow: Texture } {
  const r = RNG.create(4242);
  const map = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#b4b4b4"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      const v = 150 + Math.floor(r.next() * 70);
      g.fillStyle = `rgba(${v},${v},${v},0.35)`;
      g.fillRect(0, y, w, 1);
    }
    g.strokeStyle = "rgba(40,40,40,0.9)"; g.lineWidth = 3;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.beginPath(); g.moveTo(w / 2, 6); g.lineTo(w / 2, h - 6); g.stroke();
    g.fillStyle = "rgba(60,60,60,1)";
    for (const [px, py] of [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16], [w / 2 - 12, h / 2], [w / 2 + 12, h / 2]] as [number, number][]) {
      g.beginPath(); g.arc(px, py, 4, 0, PI * 2); g.fill();
    }
  }, k);
  const glow = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = "#000000"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#ffffff";
    for (let x = -20; x < w + 20; x += 24) {
      g.beginPath(); g.moveTo(x, h - 16); g.lineTo(x + 12, h - 16); g.lineTo(x + 22, h - 4); g.lineTo(x + 10, h - 4); g.closePath(); g.fill();
    }
  }, k);
  return { map, glow };
}
function wallTexture(): Texture {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#000000"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(255,255,255,0.45)"; g.lineWidth = 2;
    for (let x = 0; x <= w; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.fillStyle = "rgba(255,255,255,0.8)";
    for (let i = 0; i < 4; i++) g.fillRect(i * 64 + 26, 30, 12, 4);
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(10, 8);
  return t;
}
function dotTexture(): Texture {
  return canvasTex(32, 32, (g) => {
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.4, "rgba(255,255,255,0.5)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  });
}

// ---------------------------------------------------------------- the surround
const wallMat = new MeshBasicMaterial({ map: wallTexture(), side: BackSide, transparent: true, opacity: 0.55, depthWrite: false });
const wall = new Mesh(new CylinderGeometry(WALL_R, WALL_R, WALL_H, 48, 1, true), wallMat);
wall.position.y = -WALL_H / 2 + 12;
wall.renderOrder = -1;
scene.add(wall);
const beamMat = new MeshBasicMaterial({ transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false });
const beam = new Mesh(new CylinderGeometry(0.16, 0.16, 1, 12, 1, true), beamMat);
shaftGroup.add(beam);
const motePos = new Float32Array(MOTE_MAX * 3);
{
  const mr = RNG.create(99);
  for (let i = 0; i < MOTE_MAX; i++) {
    const a = mr.next() * PI * 2, rr = RADIUS + 1.5 + mr.next() * (WALL_R - RADIUS - 2);
    motePos[i * 3] = Math.cos(a) * rr; motePos[i * 3 + 1] = -24 + mr.next() * 32; motePos[i * 3 + 2] = Math.sin(a) * rr;
  }
}
const moteGeo = new BufferGeometry();
const moteAttr = new BufferAttribute(motePos, 3);
moteGeo.setAttribute("position", moteAttr);
const moteMat = new PointsMaterial({ size: 0.16, map: dotTexture(), transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false });
const motes = new Points(moteGeo, moteMat);
scene.add(motes);

// ---------------------------------------------------------------- shards (pooled, created up to the budget)
const shardGeo = new OctahedronGeometry(0.1, 0);
interface Shard { mesh: Mesh; mat: MeshBasicMaterial; vx: number; vy: number; vz: number; life: number; spin: number }
const shards: Shard[] = [];
let shardIdx = 0;
function shard(i: number): Shard {
  while (shards.length <= i) {
    const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });
    const mesh = new Mesh(shardGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    shards.push({ mesh, mat, vx: 0, vy: 0, vz: 0, life: 0, spin: 0 });
  }
  return shards[i]!;
}

// ---------------------------------------------------------------- segment materials and geometry
type SegSet = { safe: MeshStandardMaterial | MeshLambertMaterial | MeshPhysicalMaterial; armor: MeshStandardMaterial | MeshLambertMaterial | MeshPhysicalMaterial };
let mats: { plain: SegSet; detailed: SegSet } | null = null;
let segTex: { ct: { map: Texture; glow: Texture }; at: { map: Texture; glow: Texture } } | null = null;
let texKey = "";
const plainGeo = new BoxGeometry(SEG_W, SEG_H, SEG_D);
let detailedGeo: BufferGeometry = plainGeo;
let bevelKey = -1;
let wallKey = 48;
let envTex: Texture | null = null;

interface SegParams {
  roughness: number; metalness: number; emissiveIntensity: number; flatShading?: boolean;
  clearcoat?: number; clearcoatRoughness?: number; map?: Texture; emissiveMap?: Texture; envMapIntensity?: number;
}
function mk(kind: Look["budget"]["material"], physical: boolean, p: SegParams): SegSet["safe"] {
  if (kind === "lambert") {
    return new MeshLambertMaterial({ emissiveIntensity: p.emissiveIntensity, flatShading: !!p.flatShading, ...(p.map ? { map: p.map } : {}), ...(p.emissiveMap ? { emissiveMap: p.emissiveMap } : {}) });
  }
  const { clearcoat, clearcoatRoughness, ...rest } = p;
  if (kind === "physical" && physical) return new MeshPhysicalMaterial({ ...rest, clearcoat: clearcoat ?? 0, clearcoatRoughness: clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(rest);
}
/** Segment materials in the budget's class: Lambert on Low, Standard on Balanced, Physical (clear coat on the
 * detailed crystal and armour) on High / Ultra; detailed textures at the budget's size. */
function buildMats(l: Look): void {
  const b = l.budget;
  const key = `${b.material}:${b.texture}`;
  if (key === texKey && mats) return;
  texKey = key;
  if (segTex) for (const t of [segTex.ct.map, segTex.ct.glow, segTex.at.map, segTex.at.glow]) t.dispose();
  segTex = { ct: crystalTextures(b.texture / 256), at: armorTextures(b.texture / 256) };
  const old = mats;
  mats = {
    plain: {
      safe: mk(b.material, false, { roughness: 0.3, metalness: 0.1, emissiveIntensity: 0.22 }),
      armor: mk(b.material, false, { roughness: 0.5, metalness: 0.55, flatShading: true, emissiveIntensity: 0.1 }),
    },
    detailed: {
      safe: mk(b.material, true, { roughness: 0.22, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.18, map: segTex.ct.map, emissiveMap: segTex.ct.glow, emissiveIntensity: 0.35, envMapIntensity: 0.55 }),
      armor: mk(b.material, true, { roughness: 0.42, metalness: 0.8, clearcoat: 0.35, clearcoatRoughness: 0.3, map: segTex.at.map, emissiveMap: segTex.at.glow, emissiveIntensity: 0.9, envMapIntensity: 1.1 }),
    },
  };
  if (old) for (const d of [old.plain, old.detailed]) { d.safe.dispose(); d.armor.dispose(); }
}
function segColors(seg: number): number {
  if (seg === 1) return highContrast ? pal.armorHC : pal.armor;
  return highContrast ? pal.safeHC : pal.safe;
}
function segMat(seg: number): SegSet["safe"] {
  const set = look?.detailed ? mats!.detailed : mats!.plain;
  return seg === 1 ? set.armor : set.safe;
}

// ---------------------------------------------------------------- palette
function hdr(hex: number, k: number): Color { return new Color(hex).multiplyScalar(k); }
function applyPalette(): void {
  scene.background = new Color(pal.bg);
  (scene.fog as Fog).color.setHex(pal.fog);
  keyLight.color.setHex(pal.light);
  fillLight.color.setHex(pal.light);
  fillLight.groundColor.setHex(pal.shaft);
  rimLight.color.setHex(pal.accent);
  strikerMat.color.setHex(pal.striker);
  strikerLight.color.setHex(pal.accent);
  coreMat.color.setHex(pal.core);
  coreMat.emissive.setHex(pal.core);
  coreLight.color.setHex(pal.core);
  wallMat.color.copy(new Color(pal.accent).lerp(new Color(pal.shaft), 0.55)).multiplyScalar(0.5);
  beamMat.color.setHex(pal.core);
  moteMat.color.setHex(pal.accent);
  if (!mats) return;
  for (const d of ["plain", "detailed"] as const) {
    const s = mats[d].safe, a = mats[d].armor;
    s.color.setHex(segColors(0)); s.emissive.setHex(segColors(0));
    a.color.setHex(segColors(1));
    a.emissive.setHex(d === "detailed" ? (highContrast ? pal.armorHC : 0xff5a3c) : segColors(1));
  }
  for (const p of pips) p.mat.userData.charged = -1;
}

/** A content theme by id (journey, challenge and daily stages carry their own; Practice the player's pick). */
export function setTheme(id: string): void {
  if (id === themeId) return;
  themeId = id;
  pal = (Content.THEMES.find((t) => t.id === id) ?? Content.THEMES[0]!).palette;
  applyPalette();
  clearWindow();
}
export function setHighContrast(on: boolean): void {
  if (on === highContrast) return;
  highContrast = on;
  applyPalette();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }

// ---------------------------------------------------------------- the graphics level
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  buildMats(next);
  if (b.bevel !== bevelKey) {
    const old = detailedGeo;
    detailedGeo = new RoundedBoxGeometry(SEG_W, SEG_H, SEG_D, b.bevel, 0.07);
    if (old !== plainGeo) old.dispose();
    bevelKey = b.bevel;
  }
  if (b.wallSegments !== wallKey) {
    wall.geometry.dispose();
    wall.geometry = new CylinderGeometry(WALL_R, WALL_R, WALL_H, b.wallSegments, 1, true);
    wallKey = b.wallSegments;
  }
  moteGeo.setDrawRange(0, b.motes);
  motes.visible = next.animated;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  if (next.reflections) {
    if (!envTex) {
      try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
    scene.environment = envTex;
  } else scene.environment = null;
  applyEnvMaps();
  (mats!.plain.armor as MeshStandardMaterial).metalness = scene.environment ? 0.8 : 0.55;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the striker, core, charged pips, shard bursts, crystal veins and chevrons bloom.
  // r160 page: its UnrealBloomPass(0.38, 0.35, 0.9) exactly (model "r160", strength as written).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.38, radius: 0.35, threshold: 0.9, resolution: b.bloomRes } : null;
  // The browser build's grade pass (before OutputPass, so on clamped linear light): a gentle S-curve, +12 % saturation,
  // cool shadows / warm highlights, the 0.28 vignette.
  renderer.grade = next.grade ? {
    space: "linear", contrastCurve: "s", contrast: 0.22, saturation: 1.12,
    shadows: [0.95, 0.97, 1.06], highlights: [1.04, 1.0, 0.96], split: [0.2, 0.8],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9 },
  } : null;
  renderer.antialias = next.antialias;
  // Swap the surfaces on every pooled segment.
  for (const m of [...meshCache, ...segPool.values()]) {
    m.geometry = next.detailed ? detailedGeo : plainGeo;
    m.castShadow = m.receiveShadow = shadows;
    const seg = m.userData.seg as number;
    if (seg >= 0) m.material = segMat(seg);
  }
  applyPalette();
}

// ---------------------------------------------------------------- the shaft window
const segPool = new Map<string, Mesh>();
const meshCache: Mesh[] = [];
function makeSegMesh(): Mesh {
  const m = new Mesh(look?.detailed ? detailedGeo : plainGeo, segMat(0));
  m.castShadow = m.receiveShadow = !!(look && look.shadows);
  return m;
}
/** Drops the shown segments (a new round). */
export function clearWindow(): void {
  for (const m of segPool.values()) { shaftGroup.remove(m); meshCache.push(m); }
  segPool.clear();
}
function syncWindow(state: State): void {
  const lo = Math.max(0, state.depth - WINDOW_ABOVE);
  const hi = Math.min(state.layers.length - 1, state.depth + WINDOW_BELOW);
  const sectors = state.cfg.sectors;
  const span = sectors * 1000;
  for (const [k, m] of segPool) {
    const l = +k.split(":")[0]!;
    if (l < lo || l > hi) { shaftGroup.remove(m); meshCache.push(m); segPool.delete(k); }
  }
  for (let li = lo; li <= hi; li++) {
    const layer = state.layers[li]!;
    for (let s = 0; s < sectors; s++) {
      const key = `${li}:${s}`;
      const seg = layer[s]!;
      let mesh = segPool.get(key);
      if (seg === 2) { // gap: no mesh
        if (mesh) { shaftGroup.remove(mesh); meshCache.push(mesh); segPool.delete(key); }
        continue;
      }
      if (!mesh) {
        mesh = meshCache.pop() ?? makeSegMesh();
        mesh.userData.seg = -1;
        shaftGroup.add(mesh);
        segPool.set(key, mesh);
      }
      if (mesh.userData.seg !== seg) { mesh.userData.seg = seg; mesh.material = segMat(seg); }
      const ang = (s * 1000 + 500) / span * PI * 2;
      mesh.position.set(Math.sin(ang) * RADIUS, -li * LAYER_H, Math.cos(ang) * RADIUS);
      mesh.rotation.y = ang;
      mesh.visible = li >= state.depth; // broken segments are hidden, not animated away
    }
  }
  // The core sits below the last layer (fixed-length runs); the energy beam rises from it to just under the striker.
  const bottom = state.cfg.endless ? (hi + 4) * LAYER_H : state.cfg.layers * LAYER_H + 0.5;
  const top = (state.depth + state.fall / 1000) * LAYER_H - 0.6;
  coreGlow.visible = !state.cfg.endless;
  if (!state.cfg.endless) coreGlow.position.set(0, -state.cfg.layers * LAYER_H - 0.5, 0);
  beam.scale.y = Math.max(0.01, bottom - top);
  beam.position.y = -(top + bottom) / 2;
}

function syncPips(state: State): void {
  const max = state.cfg.chargeMax || 0;
  while (pips.length < max) {
    const mat = new MeshBasicMaterial({ color: pal.core });
    const mesh = new Mesh(pipGeo, mat);
    pipGroup.add(mesh);
    pips.push({ mesh, mat });
  }
  pips.forEach((p, i) => {
    if (i >= max) { p.mesh.visible = false; return; }
    p.mesh.visible = true;
    const ang = (i / Math.max(1, max)) * PI * 2;
    p.mesh.position.set(Math.cos(ang) * 0.5, 0, Math.sin(ang) * 0.5);
    const charged = i < state.charge ? 1 : 0;
    if (p.mat.userData.charged === charged) return;
    p.mat.userData.charged = charged;
    if (charged) p.mat.color.copy(hdr(pal.core, 2));
    else p.mat.color.setHex(pal.shaftEdge);
  });
}

// ---------------------------------------------------------------- effects
let shakeT = 0, shakeAmp = 0;
function burst(x: number, y: number, z: number, colorHex: number, count: number, speed: number): void {
  const n = Math.ceil(count * (look ? look.particleShare : 1));
  const pool = Math.min(SHARD_MAX, look ? look.budget.shards : 100);
  const c = hdr(colorHex, 2.2);
  for (let i = 0; i < n; i++) {
    const p = shard(shardIdx++ % pool);
    p.mesh.visible = true;
    p.mat.color.copy(c);
    p.mat.opacity = 1;
    p.mesh.position.set(x, y, z);
    const a = avRng.next() * PI * 2, up = avRng.next();
    p.vx = Math.cos(a) * speed * (0.4 + avRng.next());
    p.vy = (up - 0.3) * speed;
    p.vz = Math.sin(a) * speed * (0.4 + avRng.next());
    p.spin = (avRng.next() - 0.5) * 16;
    p.mesh.scale.setScalar(0.7 + avRng.next() * 0.8);
    p.life = 1;
  }
}
function shake(amp: number): void {
  if (reducedMotion) return;
  shakeAmp = Math.min(0.25, amp); shakeT = 1;
}
/** World position of a segment at a layer, as the shaft stands now. */
function segWorldPos(state: State, layer: number, sector: number): { x: number; y: number; z: number } {
  const span = state.cfg.sectors * 1000;
  const ang = (((sector * 1000 + 500 - state.angle) % span) + span) % span / span * PI * 2;
  return { x: Math.sin(ang) * RADIUS, y: STRIKER_Y - (layer - state.depth - state.fall / 1000) * LAYER_H, z: Math.cos(ang) * RADIUS };
}
/** A rules event's burst and shake (main.ts passes each event with the state after it). */
export function onEvent(e: RulesEvent, state: State): void {
  if (e.type === "break") {
    const p = segWorldPos(state, e.layer!, e.sector!);
    burst(p.x, p.y, p.z, segColors(0), 22, 3.2);
    shake(0.06 + (e.mult ?? 1) * 0.01);
  } else if (e.type === "overdrive") {
    const p = segWorldPos(state, e.layer!, e.sector!);
    burst(p.x, p.y, p.z, segColors(1), 34, 4.5);
    burst(p.x, p.y, p.z, pal.core, 16, 2.5);
    shake(0.16);
  } else if (e.type === "crash") {
    const p = segWorldPos(state, e.layer!, e.sector!);
    burst(p.x, p.y, p.z, segColors(1), 40, 3.5);
    shake(0.22);
  } else if (e.type === "win") {
    burst(0, coreGlow.position.y + shaftGroup.position.y + 1, 0, pal.core, 60, 4);
  }
}

// ---------------------------------------------------------------- the camera
/** Narrow windows pull the camera back along its line of sight until the whole ring (and striker) fits across. */
function fitCamera(a: number): void {
  const dir = new Vector3(CAM_POS.x - CAM_LOOK.x, CAM_POS.y - CAM_LOOK.y, CAM_POS.z - CAM_LOOK.z);
  const baseDist = dir.length();
  dir.normalize();
  const halfFov = camera.fov * PI / 360;
  const freeW = a < 1 ? 0.84 : 0.95;
  const distW = (RADIUS + 1.4) / (Math.tan(halfFov) * a * freeW);
  const dist = Math.max(baseDist, distW);
  camBase = { x: CAM_LOOK.x + dir.x * dist, y: CAM_LOOK.y + dir.y * dist, z: CAM_LOOK.z + dir.z * dist };
  camera.position.set(camBase.x, camBase.y, camBase.z);
  camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);
}

// ---------------------------------------------------------------- per frame
/** Draws the snapshot (null: the idle shaft behind the menus); dt in seconds. */
export function render(state: State | null, dt: number, width: number, height: number): void {
  if (!look) return;
  const a = width / Math.max(1, height);
  if (width > 0 && height > 0 && Math.abs(a - aspect) > 1e-4) {
    aspect = a;
    camera.aspect = a;
    camera.updateProjectionMatrix();
    fitCamera(a);
  }
  dt = Math.min(0.1, Math.max(0, dt));
  const moving = !reducedMotion && look.animated;
  if (moving) clock += dt;

  let shaftY = 0;
  if (state) {
    syncWindow(state);
    const span = state.cfg.sectors * 1000;
    shaftGroup.rotation.y = -(state.angle / span) * PI * 2;
    shaftY = (state.depth + state.fall / 1000) * LAYER_H + STRIKER_Y;
    shaftGroup.position.y = shaftY;
    // striker: bright while holding, dim while hovering
    const targetEm = state.holding ? 0.6 : 0.22;
    strikerMat.emissiveIntensity += (targetEm - strikerMat.emissiveIntensity) * Math.min(1, dt * 12);
    strikerLight.intensity = (0.3 + strikerMat.emissiveIntensity);
    if (!reducedMotion) striker.rotation.y += dt * (state.holding ? 6 : 1.5);
    syncPips(state);
    // the camera follows a touch as depth grows
    const camDrop = reducedMotion ? 0 : Math.min(1.2, state.depth * 0.05);
    camera.position.y += ((camBase.y - camDrop) - camera.position.y) * Math.min(1, dt * 2);
    camera.lookAt(CAM_LOOK.x, CAM_LOOK.y - camDrop * 0.5, CAM_LOOK.z);
  } else {
    for (const m of segPool.values()) m.visible = false;
    coreGlow.visible = false;
    for (const p of pips) p.mesh.visible = false;
    shaftGroup.position.y = 0;
    beam.scale.y = 0.01;
    if (!reducedMotion) striker.rotation.y += dt * 0.8;
  }

  // surround: the wall scrolls with descent; beam and motes shimmer when animated
  wallMat.map!.offset.y = -shaftY / WALL_H * 8 + clock * 0.01;
  beamMat.opacity = 0.1 + (moving ? Math.sin(clock * 3) * 0.04 : 0);
  coreLight.position.copy(coreGlow.position);
  coreLight.position.y += 1.2;
  coreLight.intensity = (coreGlow.visible ? 30 : 0); // intensity, not visibility: the light count stays fixed
  coreMat.emissiveIntensity = 1.3 + (moving ? Math.sin(clock * 2.2) * 0.3 : 0);
  if (motes.visible && moving) {
    const n = look.budget.motes;
    for (let i = 0; i < n; i++) {
      const y = motePos[i * 3 + 1]! + dt * (0.4 + (i % 7) * 0.08);
      motePos[i * 3 + 1] = y > 8 ? -24 : y;
    }
    moteAttr.needsUpdate = true;
    motes.rotation.y = clock * 0.03;
  }

  for (const p of shards) {
    if (p.life <= 0) continue;
    p.life -= dt * 1.6;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.vy -= 6 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.rotation.x += p.spin * dt;
    p.mesh.rotation.y += p.spin * 0.7 * dt;
    p.mat.opacity = p.life;
  }

  if (shakeT > 0) {
    shakeT = Math.max(0, shakeT - dt * 3);
    const amp = shakeAmp * shakeT;
    camera.position.x = (avRng.next() - 0.5) * 2 * amp;
    camera.position.z = camBase.z + (avRng.next() - 0.5) * 2 * amp;
  } else {
    camera.position.x = 0;
    camera.position.z = camBase.z;
  }
}
