/* Core Breaker — Three.js scene: the crystalline reactor shaft.
 * Rendering consumes immutable rules snapshots only; it never mutates state.
 * Windowed mesh pool over layers keeps draw calls bounded for endless mode.
 * Cosmetic randomness uses the seeded AV/decoration streams, never rules.
 * Graphics quality comes from CBGfx (js/gfx.js); post-processing uses the
 * same-revision three.js addons exposed as window.CBThreeAddons. */
(function () {
  'use strict';

  var THREE = window.THREE;
  var RNG = window.CBRNG;
  var Gfx = window.CBGfx;
  var ADDONS = window.CBThreeAddons || null;

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
  var WALL_R = 11, WALL_H = 70, MOTES = 160;

  var canvas = null, renderer = null, scene = null, camera = null;
  var shaftGroup = null, striker = null, coreGlow = null, pipGroup = null;
  var keyLight = null, fillLight = null, rimLight = null, strikerLight = null, coreLight = null;
  var wall = null, beam = null, motes = null;
  var mats = null, geos = null, envTex = null;
  var pal = null, highContrast = false, reducedMotion = false;
  var segPool = {};            // "l:s" -> mesh (live window)
  var meshCache = [];          // reusable segment meshes
  var particles = [];          // {mesh, vx, vy, vz, life, spin}
  var particleIdx = 0;
  var shakeT = 0, shakeAmp = 0;
  var lastDepth = -1;
  var available = false;
  var avRng = RNG.create(12345);
  var clock = 0;

  // graphics state
  var gpu = '', detected = 'balanced', saved = {}, q = null;
  var composer = null, postKey = null, postFailed = false;
  var pixelRatio = 1, size = [0, 0], adaptiveScale = 1, frames = [], fps = 0;

  function themeById(id) {
    var T = window.CBContent.THEMES;
    for (var i = 0; i < T.length; i++) if (T[i].id === id) return T[i];
    return T[0];
  }

  // ---------- procedural textures (detailed surfaces) ----------

  function canvasTex(w, h, paint, srgb) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // Crystal: soft value noise + angular facet veins. `map` modulates the base colour,
  // the vein layer drives the emissive glow so fractures shimmer under bloom.
  function crystalTextures() {
    var r = RNG.create(771);
    var map = canvasTex(256, 128, function (g, w, h) {
      g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, w, h);
      for (var i = 0; i < 900; i++) {
        var v = 200 + Math.floor(r.next() * 55);
        g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.35)';
        g.fillRect(r.next() * w, r.next() * h, 2 + r.next() * 10, 2 + r.next() * 6);
      }
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.4;
      for (var k = 0; k < 7; k++) {
        g.beginPath();
        var x = r.next() * w, y = r.next() * h;
        g.moveTo(x, y);
        for (var s = 0; s < 4; s++) { x += (r.next() - 0.5) * 90; y += (r.next() - 0.5) * 60; g.lineTo(x, y); }
        g.stroke();
      }
    }, true);
    var r2 = RNG.create(771);
    var glow = canvasTex(256, 128, function (g, w, h) {
      g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
      for (var i = 0; i < 900; i++) { r2.next(); r2.next(); r2.next(); r2.next(); r2.next(); }
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.6; g.shadowColor = '#ffffff'; g.shadowBlur = 6;
      for (var k = 0; k < 7; k++) {
        g.beginPath();
        var x = r2.next() * w, y = r2.next() * h;
        g.moveTo(x, y);
        for (var s = 0; s < 4; s++) { x += (r2.next() - 0.5) * 90; y += (r2.next() - 0.5) * 60; g.lineTo(x, y); }
        g.stroke();
      }
    }, true);
    return { map: map, glow: glow };
  }

  // Armor: brushed plate with panel seams and rivets; a warning chevron band glows along the edge.
  function armorTextures() {
    var r = RNG.create(4242);
    var map = canvasTex(256, 128, function (g, w, h) {
      g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, w, h);
      for (var y = 0; y < h; y++) {
        var v = 150 + Math.floor(r.next() * 70);
        g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.35)';
        g.fillRect(0, y, w, 1);
      }
      g.strokeStyle = 'rgba(40,40,40,0.9)'; g.lineWidth = 3;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.beginPath(); g.moveTo(w / 2, 6); g.lineTo(w / 2, h - 6); g.stroke();
      g.fillStyle = 'rgba(60,60,60,1)';
      [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16], [w / 2 - 12, h / 2], [w / 2 + 12, h / 2]].forEach(function (p) {
        g.beginPath(); g.arc(p[0], p[1], 4, 0, Math.PI * 2); g.fill();
      });
    }, true);
    var glow = canvasTex(256, 128, function (g, w, h) {
      g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      for (var x = -20; x < w + 20; x += 24) {
        g.beginPath(); g.moveTo(x, h - 16); g.lineTo(x + 12, h - 16); g.lineTo(x + 22, h - 4); g.lineTo(x + 10, h - 4); g.closePath(); g.fill();
      }
    }, true);
    return { map: map, glow: glow };
  }

  function wallTexture() {
    var t = canvasTex(256, 256, function (g, w, h) {
      g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 2;
      for (var x = 0; x <= w; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (var y = 0; y <= h; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (var i = 0; i < 4; i++) g.fillRect(i * 64 + 26, 30, 12, 4);
    }, true);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 8);
    return t;
  }

  function dotTexture() {
    return canvasTex(32, 32, function (g) {
      var grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.4, 'rgba(255,255,255,0.5)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    }, true);
  }

  // ---------- init ----------

  function detectGpu() {
    try {
      var gl = renderer.getContext();
      var isFirefox = /firefox/i.test(navigator.userAgent || '');
      var ext = !isFirefox && gl.getSupportedExtensions().indexOf('WEBGL_debug_renderer_info') >= 0
        ? gl.getExtension('WEBGL_debug_renderer_info') : null;
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    } catch (e) { gpu = ''; }
    var mobile = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    detected = Gfx.autoPreset(gpu, mobile);
  }

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
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    detectGpu();
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
    camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
    camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);

    // key light with a shadow box fitted to the rendered window of the ring
    keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(4, 8, 6);
    keyLight.shadow.bias = -0.0006;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight); scene.add(keyLight.target);
    fitShadow();
    fillLight = new THREE.HemisphereLight(0x8888ff, 0x221133, 0.55);
    rimLight = new THREE.DirectionalLight(0x9be8ff, 0.9);
    rimLight.position.set(-5, 2, -7);
    scene.add(fillLight); scene.add(rimLight);

    // image-based lighting for PBR reflections
    if (ADDONS && ADDONS.RoomEnvironment) {
      try {
        var pmrem = new THREE.PMREMGenerator(renderer);
        envTex = pmrem.fromScene(new ADDONS.RoomEnvironment(renderer), 0.04).texture;
        pmrem.dispose();
      } catch (e) { envTex = null; }
    }

    // shared segment geometry / materials (plain + detailed variants)
    var ct = crystalTextures(), at = armorTextures();
    geos = {
      plain: new THREE.BoxGeometry(SEG_W, SEG_H, SEG_D),
      detailed: ADDONS && ADDONS.RoundedBoxGeometry
        ? new ADDONS.RoundedBoxGeometry(SEG_W, SEG_H, SEG_D, 3, 0.07) : new THREE.BoxGeometry(SEG_W, SEG_H, SEG_D)
    };
    mats = {
      plain: {
        safe: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.1, emissiveIntensity: 0.22 }),
        armor: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.55, flatShading: true, emissiveIntensity: 0.1 })
      },
      detailed: {
        safe: new THREE.MeshPhysicalMaterial({ roughness: 0.22, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.18,
          map: ct.map, emissiveMap: ct.glow, emissiveIntensity: 0.35, envMapIntensity: 0.55 }),
        armor: new THREE.MeshPhysicalMaterial({ roughness: 0.42, metalness: 0.8, clearcoat: 0.35, clearcoatRoughness: 0.3,
          map: at.map, emissiveMap: at.glow, emissiveIntensity: 0.9, envMapIntensity: 1.1 })
      }
    };

    shaftGroup = new THREE.Group();
    scene.add(shaftGroup);

    striker = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 1),
      new THREE.MeshPhysicalMaterial({ color: 0xd8f4ff, emissive: 0x9be8ff, emissiveIntensity: 0.4, roughness: 0.3,
        metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.2, flatShading: true, envMapIntensity: 0.3 }));
    striker.position.set(0, STRIKER_Y, RADIUS);
    striker.castShadow = true;
    scene.add(striker);
    // glow light sits at the striker's centre, so it lights the crystal around it but not the striker's own faces
    strikerLight = new THREE.PointLight(0x9be8ff, 1, 4, 2);
    strikerLight.position.copy(striker.position);
    scene.add(strikerLight);

    pipGroup = new THREE.Group();
    pipGroup.position.set(0, STRIKER_Y + 1.1, RADIUS);
    scene.add(pipGroup);

    coreGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(RADIUS * 0.8, RADIUS * 0.9, 0.4, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffd166, emissiveIntensity: 1.3, roughness: 0.3 }));
    shaftGroup.add(coreGlow);
    coreLight = new THREE.PointLight(0xffd166, 30, 14, 1.4);
    shaftGroup.add(coreLight);

    // shaft surround: gridded wall, central energy beam, rising motes
    wall = new THREE.Mesh(new THREE.CylinderGeometry(WALL_R, WALL_R, WALL_H, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: wallTexture(), side: THREE.BackSide, transparent: true, opacity: 0.55, depthWrite: false }));
    wall.position.y = -WALL_H / 2 + 12;
    wall.renderOrder = -1;
    scene.add(wall);
    beam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 12, 1, true),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
    shaftGroup.add(beam);
    var mg = new THREE.BufferGeometry(), mp = new Float32Array(MOTES * 3), mr = RNG.create(99);
    for (var mi = 0; mi < MOTES; mi++) {
      var ma = mr.next() * Math.PI * 2, rr = RADIUS + 1.5 + mr.next() * (WALL_R - RADIUS - 2);
      mp[mi * 3] = Math.cos(ma) * rr; mp[mi * 3 + 1] = -24 + mr.next() * 32; mp[mi * 3 + 2] = Math.sin(ma) * rr;
    }
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    motes = new THREE.Points(mg, new THREE.PointsMaterial({ size: 0.16, map: dotTexture(), transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(motes);

    // pooled particles (bounded; never raycast targets): additive crystal shards
    var pg = new THREE.OctahedronGeometry(0.1, 0);
    for (var i = 0; i < PARTICLE_POOL; i++) {
      var pm = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      pm.visible = false;
      scene.add(pm);
      particles.push({ mesh: pm, vx: 0, vy: 0, vz: 0, life: 0, spin: 0 });
    }

    setTheme('void');
    setGraphics({});
    resize();
    return true;
  }

  function isAvailable() { return available; }

  // Shadow box: the rendered window (3 layers above to 12 below, ring plus striker)
  // projected into light space, so every shadow texel lands on the play area.
  function fitShadow() {
    var target = new THREE.Vector3(0, -6, 0);
    var dir = new THREE.Vector3(4, 8, 6).normalize();
    keyLight.target.position.copy(target);
    keyLight.position.copy(target).addScaledVector(dir, 30);
    keyLight.updateMatrixWorld();
    keyLight.target.updateMatrixWorld();
    var cam = keyLight.shadow.camera;
    cam.position.copy(keyLight.position);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    var inv = cam.matrixWorldInverse, e = RADIUS + SEG_W * 0.5 + 0.2;
    var box = new THREE.Box3();
    var ys = [STRIKER_Y + WINDOW_ABOVE * LAYER_H, STRIKER_Y - WINDOW_BELOW * LAYER_H - 1];
    for (var xi = -1; xi <= 1; xi += 2) for (var yi = 0; yi < 2; yi++) for (var zi = -1; zi <= 1; zi += 2)
      box.expandByPoint(new THREE.Vector3(xi * e, ys[yi], zi * e).applyMatrix4(inv));
    cam.left = box.min.x; cam.right = box.max.x; cam.bottom = box.min.y; cam.top = box.max.y;
    cam.near = Math.max(0.1, -box.max.z - 1); cam.far = -box.min.z + 1;
    cam.updateProjectionMatrix();
  }

  // ---------- settings ----------

  /** Apply saved graphics settings ({preset, render_scale, adaptive, show_fps, <category>}). Live, no reload. */
  function setGraphics(s) {
    saved = s || {};
    q = Gfx.resolve(saved, detected);
    if (!renderer) return q;
    var sz = q.shadowMap;
    renderer.shadowMap.enabled = sz > 0;
    keyLight.castShadow = sz > 0;
    if (sz > 0 && keyLight.shadow.mapSize.x !== sz) {
      keyLight.shadow.mapSize.set(sz, sz);
      if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
    }
    scene.environment = q.reflections === 'on' ? envTex : null;
    mats.plain.armor.metalness = scene.environment ? 0.8 : 0.55;
    // swap segment surfaces on every pooled mesh
    var detailed = q.detail === 'detailed';
    var all = meshCache.slice();
    for (var k in segPool) all.push(segPool[k]);
    for (var i = 0; i < all.length; i++) {
      all[i].geometry = detailed ? geos.detailed : geos.plain;
      all[i].castShadow = all[i].receiveShadow = sz > 0;
      if (all[i].userData.seg >= 0) all[i].material = segMat(all[i].userData.seg);
    }
    // materials pick up shadow-map / environment changes on recompile
    [mats.plain.safe, mats.plain.armor, mats.detailed.safe, mats.detailed.armor, striker.material, coreGlow.material]
      .forEach(function (m) { m.needsUpdate = true; });
    applyMotion();
    adaptiveScale = 1;
    frames = [];
    postKey = null; // rebuild the post chain on the next frame
    fpsVisible(q.showFps);
    if (canvas) canvas.setAttribute('data-gfx-preset', q.preset);
    document.body.setAttribute('data-gfx-preset', q.preset);
    return q;
  }

  // Legacy entry point (auto | low | medium | high).
  function setQuality(p) {
    var s = {}; for (var k in saved) s[k] = saved[k];
    s.preset = Gfx.normalizePreset(p);
    return setGraphics(s);
  }

  function graphicsInfo() {
    return {
      gpu: gpu, detected: detected, resolved: q, saved: saved,
      pixels: [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)],
      fps: Math.round(fps), adaptiveScale: Math.round(adaptiveScale * 100) / 100,
      postFailed: postFailed, postActive: !!composer
    };
  }

  function applyMotion() {
    if (!q || !motes) return;
    var animated = q.background === 'animated';
    motes.visible = animated;
  }

  function fpsVisible(on) {
    var el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  function setReducedMotion(b) { reducedMotion = !!b; applyMotion(); }
  function setHighContrast(b) { highContrast = !!b; if (pal) applyPalette(); }

  function hdr(hex, k) { return new THREE.Color(hex).multiplyScalar(k); }

  function applyPalette() {
    scene.background = new THREE.Color(pal.bg);
    scene.fog = new THREE.Fog(pal.fog, 14, 36);
    keyLight.color.setHex(pal.light);
    fillLight.color.setHex(pal.light);
    fillLight.groundColor.setHex(pal.shaft);
    rimLight.color.setHex(pal.accent);
    striker.material.color.setHex(pal.striker);
    strikerLight.color.setHex(pal.accent);
    coreGlow.material.color.setHex(pal.core);
    coreGlow.material.emissive.setHex(pal.core);
    coreLight.color.setHex(pal.core);
    wall.material.color.copy(new THREE.Color(pal.accent).lerp(new THREE.Color(pal.shaft), 0.55)).multiplyScalar(0.5);
    beam.material.color.setHex(pal.core);
    motes.material.color.setHex(pal.accent);
    ['plain', 'detailed'].forEach(function (d) {
      var s = mats[d].safe, a = mats[d].armor;
      s.color.setHex(segColors(0)); s.emissive.setHex(segColors(0));
      a.color.setHex(segColors(1));
      a.emissive.setHex(d === 'detailed' ? (highContrast ? pal.armorHC : 0xff5a3c) : segColors(1));
    });
  }

  function setTheme(id) {
    pal = themeById(id).palette;
    if (!scene) return;
    applyPalette();
    clearWindow();
  }

  // ---------- shaft window ----------

  function segMat(seg) {
    var set = q && q.detail === 'detailed' ? mats.detailed : mats.plain;
    return seg === 1 ? set.armor : set.safe;
  }

  function makeSegMesh() {
    var m = new THREE.Mesh(q && q.detail === 'detailed' ? geos.detailed : geos.plain, mats.plain.safe);
    m.castShadow = m.receiveShadow = !!(q && q.shadowMap);
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
          mesh.material = segMat(seg);
        }
        var ang = (s * 1000 + 500) / span * Math.PI * 2;
        mesh.position.set(Math.sin(ang) * RADIUS, -li * LAYER_H, Math.cos(ang) * RADIUS);
        mesh.rotation.y = ang;
        var broken = li < state.depth;
        mesh.visible = !broken;
      }
    }
    // core glow sits below the last layer (fixed-length runs); the energy beam rises from it
    var bottom = state.cfg.endless ? (hi + 4) * LAYER_H : state.cfg.layers * LAYER_H + 0.5;
    var top = (state.depth + state.fall / 1000) * LAYER_H - 0.6; // beam ends just under the striker
    if (!state.cfg.endless) {
      coreGlow.visible = true;
      coreGlow.position.set(0, -state.cfg.layers * LAYER_H - 0.5, 0);
    } else coreGlow.visible = false;
    beam.scale.y = bottom + top * -1;
    beam.position.y = -(top + bottom) / 2;
  }

  // ---------- effects ----------

  function burst(x, y, z, colorHex, count, speed) {
    var n = Math.ceil(count * (q ? q.particleShare : 1));
    for (var i = 0; i < n; i++) {
      var p = particles[particleIdx++ % PARTICLE_POOL];
      p.mesh.visible = true;
      p.mesh.material.color.copy(hdr(colorHex, 2.2));
      p.mesh.material.opacity = 1;
      p.mesh.position.set(x, y, z);
      var a = avRng.next() * Math.PI * 2, up = avRng.next();
      p.vx = Math.cos(a) * speed * (0.4 + avRng.next());
      p.vy = (up - 0.3) * speed;
      p.vz = Math.sin(a) * speed * (0.4 + avRng.next());
      p.spin = (avRng.next() - 0.5) * 16;
      p.mesh.scale.setScalar(0.7 + avRng.next() * 0.8);
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
      burst(0, coreGlow.position.y + shaftGroup.position.y + 1, 0, pal.core, 60, 4);
    }
  }

  // ---------- post-processing ----------

  // Colour grade + vignette (display-space colours in, display-space out).
  var GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv);',
      '  vec3 c = clamp(src.rgb, 0.0, 1.0);',
      // gentle S-curve contrast, a touch more saturation, cool shadows / warm highlights
      '  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);',
      '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
      '  s = mix(vec3(l), s, 1.12);',
      '  s *= mix(vec3(0.95, 0.97, 1.06), vec3(1.04, 1.0, 0.96), smoothstep(0.2, 0.8, l));',
      '  c = mix(c, s, uAmount);',
      '  float d = length(vUv - 0.5);',
      '  c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);',
      '  gl_FragColor = vec4(c, src.a);',
      '}'
    ].join('\n')
  };

  function currentPostKey(w, h) {
    return q.post ? [q.ao, q.bloom, q.grade, q.antialias, w, h, pixelRatio].join('|') : 'none';
  }

  function buildPost(w, h) {
    if (composer) { composer.dispose(); composer = null; }
    if (!q.post) return;
    if (!ADDONS || !ADDONS.EffectComposer) { postFailed = true; return; }
    try {
      var A = ADDONS, pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
      var target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0 });
      var c = new A.EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new A.RenderPass(scene, camera));
      if (q.ao !== 'off') {
        var ao = new A.GTAOPass(scene, camera, pw, ph);
        ao.output = A.GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.7;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: q.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4, rings: 2, samples: q.ao === 'high' ? 16 : 8 });
        c.addPass(ao);
      }
      // high threshold: only the striker, core, charge pips, shard bursts and crystal veins bloom
      if (q.bloom === 'on') c.addPass(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.38, 0.35, 0.9));
      if (q.grade === 'on') c.addPass(new A.ShaderPass(GradeShader));
      c.addPass(new A.OutputPass());
      if (q.antialias === 'smaa') c.addPass(new A.SMAAPass(pw, ph));
      if (q.antialias === 'fxaa') {
        var fxaa = new A.ShaderPass(A.FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      postFailed = true;
      composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  function adapt(dt) {
    frames.push(dt);
    if (frames.length < 90) return false;
    var sum = 0;
    for (var i = 0; i < frames.length; i++) sum += frames[i];
    var avg = sum / frames.length;
    frames = [];
    fps = 1000 / avg;
    var el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
    if (!q.adaptive) return false;
    var before = adaptiveScale;
    if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
    else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
    return before !== adaptiveScale;
  }

  // ---------- per-frame ----------

  function draw(state, dtMs) {
    if (!available || !renderer) return;
    var dt = Math.min(0.1, (dtMs || 16.7) / 1000);
    var moving = !reducedMotion && q.background === 'animated';
    if (moving) clock += dt;

    var shaftY = 0;
    if (state) {
      syncWindow(state);
      var span = state.cfg.sectors * 1000;
      shaftGroup.rotation.y = -(state.angle / span) * Math.PI * 2;
      shaftY = (state.depth + state.fall / 1000) * LAYER_H + STRIKER_Y;
      shaftGroup.position.y = shaftY;
      // striker: bright when holding, dim when hovering
      var targetEm = state.holding ? 0.6 : 0.22;
      striker.material.emissiveIntensity += (targetEm - striker.material.emissiveIntensity) * Math.min(1, dt * 12);
      strikerLight.intensity = 0.3 + striker.material.emissiveIntensity;
      if (!reducedMotion) striker.rotation.y += dt * (state.holding ? 6 : 1.5);
      // charge pips
      syncPips(state);
      // camera follows a touch as depth grows (authored drift, interruptible)
      var camDrop = reducedMotion ? 0 : Math.min(1.2, state.depth * 0.05);
      camera.position.y += ((camBase.y - camDrop) - camera.position.y) * Math.min(1, dt * 2);
      camera.lookAt(CAM_LOOK.x, CAM_LOOK.y - camDrop * 0.5, CAM_LOOK.z);
    } else if (!reducedMotion) {
      striker.rotation.y += dt * 0.8;
    }

    // surround: the wall scrolls with descent; beam and motes shimmer when animated
    wall.material.map.offset.y = -shaftY / WALL_H * 8 + clock * 0.01;
    beam.material.opacity = 0.1 + (moving ? Math.sin(clock * 3) * 0.04 : 0);
    coreLight.position.copy(coreGlow.position).y += 1.2;
    coreLight.intensity = coreGlow.visible ? 30 : 0; // intensity, not visibility: light count changes recompile shaders
    coreGlow.material.emissiveIntensity = 1.3 + (moving ? Math.sin(clock * 2.2) * 0.3 : 0);
    if (motes.visible) {
      var mp = motes.geometry.attributes.position;
      if (moving) {
        for (var mi = 0; mi < MOTES; mi++) {
          var y = mp.array[mi * 3 + 1] + dt * (0.4 + (mi % 7) * 0.08);
          mp.array[mi * 3 + 1] = y > 8 ? -24 : y;
        }
        mp.needsUpdate = true;
      }
      motes.rotation.y = moving ? clock * 0.03 : 0;
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
      p.mesh.rotation.x += p.spin * dt;
      p.mesh.rotation.y += p.spin * 0.7 * dt;
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

    render(dtMs || 16.7);
  }

  function render(dtMs) {
    var rescale = adapt(dtMs);
    var w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    var ratio = Math.min(window.devicePixelRatio || 1, q.pixelCap) * q.scale * adaptiveScale;
    if (w !== size[0] || h !== size[1] || ratio !== pixelRatio || rescale) {
      size = [w, h];
      pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fitCamera(w / h);
    }
    var key = currentPostKey(w, h);
    if (key !== postKey) { postKey = key; buildPost(w, h); }
    if (composer) {
      try { composer.render(dtMs / 1000); return; } catch (e) { postFailed = true; composer.dispose(); composer = null; }
    }
    renderer.render(scene, camera);
  }

  function syncPips(state) {
    var max = state.cfg.chargeMax || 0;
    while (pipGroup.children.length < max) {
      var m = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 1), new THREE.MeshBasicMaterial({ color: pal.core }));
      pipGroup.add(m);
    }
    for (var i = 0; i < pipGroup.children.length; i++) {
      var pip = pipGroup.children[i];
      if (i >= max) { pip.visible = false; continue; }
      pip.visible = true;
      var ang = (i / Math.max(1, max)) * Math.PI * 2;
      pip.position.set(Math.cos(ang) * 0.5, 0, Math.sin(ang) * 0.5);
      if (i < state.charge) pip.material.color.copy(hdr(pal.core, 2));
      else pip.material.color.setHex(pal.shaftEdge);
    }
  }

  function resize() {
    if (!renderer || !canvas) return;
    size = [0, 0]; // next render re-reads the canvas size, pixel ratio and post chain
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || canvas.parentNode.clientHeight || window.innerHeight;
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
    setGraphics: setGraphics,
    graphicsInfo: graphicsInfo,
    setReducedMotion: setReducedMotion,
    setHighContrast: setHighContrast,
    onEvent: onEvent,
    draw: draw,
    resize: resize,
    clearWindow: clearWindow
  };
})();
