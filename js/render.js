/* Core Breaker — Three.js scene: the crystalline reactor shaft.
 * Rendering consumes immutable rules snapshots only; it never mutates state.
 * Windowed mesh pool over layers keeps draw calls bounded for endless mode.
 * Cosmetic randomness uses the seeded AV/decoration streams, never rules. */
(function () {
  'use strict';

  var THREE = window.THREE;
  var RNG = window.CBRNG;

  // ---- authored framing constants (no magic offsets) ----
  var RADIUS = 3.2;            // shaft ring radius
  var LAYER_H = 1.5;           // world units per layer
  var SEG_W = 2.6, SEG_H = 0.5, SEG_D = 1.1;
  var STRIKER_Y = 0;           // striker rests at world origin height
  var CAM_POS = { x: 0, y: 4.6, z: 9.2 };
  var CAM_LOOK = { x: 0, y: -1.2, z: 0 };
  var camBase = { x: CAM_POS.x, y: CAM_POS.y, z: CAM_POS.z }; // fitted per aspect (see fitCamera)
  var WINDOW_ABOVE = 3, WINDOW_BELOW = 12; // rendered layers around depth
  var PARTICLE_POOL = 140;

  var canvas = null, renderer = null, scene = null, camera = null;
  var shaftGroup = null, striker = null, coreGlow = null, pipGroup = null;
  var keyLight = null, fillLight = null;
  var pal = null, highContrast = false, reducedMotion = false, quality = 'high';
  var segPool = {};            // "l:s" -> mesh (live window)
  var meshCache = [];          // reusable meshes {mesh, matSafe, matArmor}
  var particles = [];          // {mesh, vx, vy, vz, life}
  var particleIdx = 0;
  var shakeT = 0, shakeAmp = 0;
  var builtFor = null;         // state object identity the window tracks
  var lastDepth = -1;
  var available = false;
  var avRng = RNG.create(12345);

  function themeById(id) {
    var T = window.CBContent.THEMES;
    for (var i = 0; i < T.length; i++) if (T[i].id === id) return T[i];
    return T[0];
  }

  // ---------- init ----------

  function init(cv) {
    canvas = cv;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      available = false;
      return false;
    }
    available = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
    camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
    camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);

    keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(4, 8, 6);
    fillLight = new THREE.HemisphereLight(0x8888ff, 0x221133, 0.7);
    scene.add(keyLight); scene.add(fillLight);

    shaftGroup = new THREE.Group();
    scene.add(shaftGroup);

    striker = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 1),
      new THREE.MeshStandardMaterial({ color: 0xd8f4ff, emissive: 0x9be8ff, emissiveIntensity: 0.7, roughness: 0.25, metalness: 0.1 }));
    striker.position.set(0, STRIKER_Y, RADIUS);
    scene.add(striker);

    pipGroup = new THREE.Group();
    pipGroup.position.set(0, STRIKER_Y + 1.1, RADIUS);
    scene.add(pipGroup);

    coreGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(RADIUS * 0.8, RADIUS * 0.9, 0.4, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    scene.add(coreGlow);

    // pooled particles (bounded; never raycast targets)
    var pg = new THREE.SphereGeometry(0.09, 6, 6);
    for (var i = 0; i < PARTICLE_POOL; i++) {
      var pm = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
      pm.visible = false;
      scene.add(pm);
      particles.push({ mesh: pm, vx: 0, vy: 0, vz: 0, life: 0 });
    }

    applyQuality();
    setTheme('void');
    resize();
    return true;
  }

  function isAvailable() { return available; }

  // ---------- settings ----------

  function applyQuality() {
    if (!renderer) return;
    var dpr = window.devicePixelRatio || 1;
    var cap = quality === 'low' ? 1 : (quality === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));
    renderer.setPixelRatio(cap);
    renderer.shadowMap.enabled = quality === 'high';
    keyLight.castShadow = quality === 'high';
    resize();
  }
  function setQuality(q) { quality = q; applyQuality(); }
  function setReducedMotion(b) { reducedMotion = !!b; }
  function setHighContrast(b) { highContrast = !!b; if (pal) applyPalette(); }

  function applyPalette() {
    scene.background = new THREE.Color(pal.bg);
    scene.fog = new THREE.Fog(pal.fog, 14, 34);
    keyLight.color.setHex(pal.light);
    striker.material.color.setHex(pal.striker);
    coreGlow.material.color.setHex(pal.core);
  }

  function setTheme(id) {
    pal = themeById(id).palette;
    if (!scene) return;
    applyPalette();
    clearWindow();
  }

  // ---------- shaft window ----------

  function makeSegMesh() {
    var geo = new THREE.BoxGeometry(SEG_W, SEG_H, SEG_D);
    var mats = {
      safe: new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15 }),
      armor: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.55, flatShading: true }),
      gap: null
    };
    var m = new THREE.Mesh(geo, mats.safe);
    m.userData.mats = mats;
    return m;
  }

  function segColors(seg) {
    if (seg === 1) return highContrast ? pal.armorHC : pal.armor;
    return highContrast ? pal.safeHC : pal.safe;
  }

  function clearWindow() {
    for (var k in segPool) {
      var m = segPool[k];
      shaftGroup.remove(m);
      meshCache.push(m);
    }
    segPool = {};
    builtFor = null;
    lastDepth = -1;
  }

  function syncWindow(state) {
    var lo = Math.max(0, state.depth - WINDOW_ABOVE);
    var hi = Math.min(state.layers.length - 1, state.depth + WINDOW_BELOW);
    var sectors = state.cfg.sectors;
    var span = sectors * 1000;
    // drop out-of-window meshes
    for (var k in segPool) {
      var parts = k.split(':'), l = +parts[0];
      if (l < lo || l > hi) {
        shaftGroup.remove(segPool[k]);
        meshCache.push(segPool[k]);
        delete segPool[k];
      }
    }
    for (var li = lo; li <= hi; li++) {
      var layer = state.layers[li];
      for (var s = 0; s < sectors; s++) {
        var key = li + ':' + s;
        var seg = layer[s];
        var mesh = segPool[key];
        if (seg === 2) { // gap: no mesh
          if (mesh) { shaftGroup.remove(mesh); meshCache.push(mesh); delete segPool[key]; }
          continue;
        }
        if (!mesh) {
          mesh = meshCache.pop() || makeSegMesh();
          mesh.userData.seg = -1;
          shaftGroup.add(mesh);
          segPool[key] = mesh;
        }
        if (mesh.userData.seg !== seg) {
          mesh.userData.seg = seg;
          mesh.material = seg === 1 ? mesh.userData.mats.armor : mesh.userData.mats.safe;
          mesh.material.color.setHex(segColors(seg));
          mesh.material.emissive.setHex(segColors(seg));
          mesh.material.emissiveIntensity = seg === 1 ? 0.12 : 0.3;
        }
        var ang = (s * 1000 + 500) / span * Math.PI * 2;
        mesh.position.set(Math.sin(ang) * RADIUS, -li * LAYER_H, Math.cos(ang) * RADIUS);
        mesh.rotation.y = ang;
        var broken = li < state.depth;
        mesh.visible = !broken;
      }
    }
    // core glow sits below the last layer (fixed-length runs)
    if (!state.cfg.endless) {
      coreGlow.visible = true;
      coreGlow.position.set(0, -state.cfg.layers * LAYER_H - 0.5, 0);
    } else coreGlow.visible = false;
  }

  // ---------- effects ----------

  function burst(x, y, z, colorHex, count, speed) {
    var n = quality === 'low' ? Math.ceil(count / 3) : (quality === 'medium' ? Math.ceil(count / 1.5) : count);
    for (var i = 0; i < n; i++) {
      var p = particles[particleIdx++ % PARTICLE_POOL];
      p.mesh.visible = true;
      p.mesh.material.color.setHex(colorHex);
      p.mesh.material.opacity = 1;
      p.mesh.position.set(x, y, z);
      var a = avRng.next() * Math.PI * 2, up = avRng.next();
      p.vx = Math.cos(a) * speed * (0.4 + avRng.next());
      p.vy = (up - 0.3) * speed;
      p.vz = Math.sin(a) * speed * (0.4 + avRng.next());
      p.life = 1;
    }
  }

  function shake(amp) {
    if (reducedMotion) return;
    shakeAmp = Math.min(0.25, amp); shakeT = 1;
  }

  // World position of the segment under the striker at a given layer.
  function segWorldPos(state, layer, sector) {
    var span = state.cfg.sectors * 1000;
    var ang = ((sector * 1000 + 500 - state.angle) % span + span) % span / span * Math.PI * 2;
    return {
      x: Math.sin(ang) * RADIUS,
      y: STRIKER_Y - (layer - state.depth - state.fall / 1000) * LAYER_H,
      z: Math.cos(ang) * RADIUS
    };
  }

  function onEvent(e, state) {
    if (!available || !state) return;
    if (e.type === 'break') {
      var p = segWorldPos(state, e.layer, e.sector);
      burst(p.x, p.y, p.z, segColors(0), 22, 3.2);
      shake(0.06 + e.mult * 0.01);
    } else if (e.type === 'overdrive') {
      var p2 = segWorldPos(state, e.layer, e.sector);
      burst(p2.x, p2.y, p2.z, segColors(1), 34, 4.5);
      burst(p2.x, p2.y, p2.z, pal.core, 16, 2.5);
      shake(0.16);
    } else if (e.type === 'crash') {
      var p3 = segWorldPos(state, e.layer, e.sector);
      burst(p3.x, p3.y, p3.z, segColors(1), 40, 3.5);
      shake(0.22);
    } else if (e.type === 'win') {
      burst(0, coreGlow.position.y + 1, 0, pal.core, 60, 4);
    }
  }

  // ---------- per-frame ----------

  function draw(state, dtMs) {
    if (!available || !renderer) return;
    var dt = Math.min(0.1, (dtMs || 16.7) / 1000);

    if (state) {
      if (builtFor !== state) { builtFor = state; }
      syncWindow(state);
      var span = state.cfg.sectors * 1000;
      shaftGroup.rotation.y = -(state.angle / span) * Math.PI * 2;
      shaftGroup.position.y = (state.depth + state.fall / 1000) * LAYER_H + STRIKER_Y;
      // striker: bright when holding, dim when hovering
      var targetEm = state.holding ? 1.4 : 0.5;
      striker.material.emissiveIntensity += (targetEm - striker.material.emissiveIntensity) * Math.min(1, dt * 12);
      if (!reducedMotion) striker.rotation.y += dt * (state.holding ? 6 : 1.5);
      // charge pips
      syncPips(state);
      // camera follows a touch as depth grows (authored drift, interruptible)
      var camDrop = reducedMotion ? 0 : Math.min(1.2, state.depth * 0.05);
      camera.position.y += ((camBase.y - camDrop) - camera.position.y) * Math.min(1, dt * 2);
      camera.lookAt(CAM_LOOK.x, CAM_LOOK.y - camDrop * 0.5, CAM_LOOK.z);
    }

    // particles
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.life <= 0) continue;
      p.life -= dt * 1.6;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.vy -= 6 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.material.opacity = p.life;
    }

    // camera shake (never changes raycast truth — we do no raycasting)
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt * 3);
      var a = shakeAmp * shakeT;
      camera.position.x = (avRng.next() - 0.5) * 2 * a;
      camera.position.z = camBase.z + (avRng.next() - 0.5) * 2 * a;
    } else {
      camera.position.x = 0; camera.position.z = camBase.z;
    }

    renderer.render(scene, camera);
  }

  function syncPips(state) {
    var max = state.cfg.chargeMax || 0;
    while (pipGroup.children.length < max) {
      var m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8),
        new THREE.MeshBasicMaterial({ color: pal.core }));
      pipGroup.add(m);
    }
    for (var i = 0; i < pipGroup.children.length; i++) {
      var pip = pipGroup.children[i];
      if (i >= max) { pip.visible = false; continue; }
      pip.visible = true;
      var ang = (i / Math.max(1, max)) * Math.PI * 2;
      pip.position.set(Math.cos(ang) * 0.5, 0, Math.sin(ang) * 0.5);
      pip.material.color.setHex(i < state.charge ? pal.core : pal.shaftEdge);
    }
  }

  function resize() {
    if (!renderer || !canvas) return;
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || canvas.parentNode.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitCamera(w / h);
  }

  // Narrow aspect ratios pull the camera back along its authored line of sight
  // until the whole ring (plus striker) fits horizontally with a margin, leaving
  // the top/bottom HUD bands clear.
  function fitCamera(aspect) {
    if (!camera) return;
    var dir = new THREE.Vector3(CAM_POS.x - CAM_LOOK.x, CAM_POS.y - CAM_LOOK.y, CAM_POS.z - CAM_LOOK.z);
    var baseDist = dir.length();
    dir.normalize();
    var halfFov = camera.fov * Math.PI / 360;
    var needHalfW = (RADIUS + 1.4);
    var freeW = aspect < 1 ? 0.84 : 0.95;
    var distW = needHalfW / (Math.tan(halfFov) * aspect * freeW);
    var dist = Math.max(baseDist, distW);
    camBase = { x: CAM_LOOK.x + dir.x * dist, y: CAM_LOOK.y + dir.y * dist, z: CAM_LOOK.z + dir.z * dist };
    camera.position.set(camBase.x, camBase.y, camBase.z);
    camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);
  }

  window.CBRender = {
    init: init,
    isAvailable: isAvailable,
    setTheme: setTheme,
    setQuality: setQuality,
    setReducedMotion: setReducedMotion,
    setHighContrast: setHighContrast,
    onEvent: onEvent,
    draw: draw,
    resize: resize,
    clearWindow: clearWindow
  };
})();
