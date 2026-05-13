import * as THREE from 'three';

const TEAM_COLORS = {
  blue: { primary: 0x4ea0ff, dark: 0x244a78, accent: 0xb6d8ff },
  red:  { primary: 0xff5b5b, dark: 0x7a2727, accent: 0xffc1c1 },
};

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15, ...opts });

// Procedurally generate a camo texture per team. The base is the team's
// primary color (so red/blue identification stays obvious from any angle),
// over-painted with irregular black/gray blobs. Built once per team and
// shared by every unit that uses it — drawing many small overlapping
// circles is cheap, but doing it per-unit would not be.
const _camoTextureCache = {};
function camoTexture(team) {
  if (_camoTextureCache[team]) return _camoTextureCache[team];
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');

  const baseHex = '#' + TEAM_COLORS[team].primary.toString(16).padStart(6, '0');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);

  // Splotch palette: pure black, dark gray, mid gray. Each pass paints
  // ~14 organic blobs by clustering 4–7 overlapping circles per blob.
  const splotches = [
    { color: 'rgba(20,20,20,0.92)',  count: 14, rMin: 8,  rMax: 22 },
    { color: 'rgba(58,58,58,0.88)',  count: 14, rMin: 10, rMax: 22 },
    { color: 'rgba(95,95,95,0.78)',  count: 10, rMin: 8,  rMax: 18 },
  ];
  for (const sp of splotches) {
    ctx.fillStyle = sp.color;
    for (let i = 0; i < sp.count; i++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const blobs = 4 + Math.floor(Math.random() * 4);
      for (let j = 0; j < blobs; j++) {
        const dx = (Math.random() - 0.5) * 36;
        const dy = (Math.random() - 0.5) * 36;
        const r = sp.rMin + Math.random() * (sp.rMax - sp.rMin);
        // Tile-wrap by drawing at all 8 neighboring offsets where the
        // blob crosses an edge — keeps the texture seamless when repeated.
        for (const ox of [-size, 0, size]) {
          for (const oy of [-size, 0, size]) {
            ctx.beginPath();
            ctx.arc(cx + dx + ox, cy + dy + oy, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.2, 2.2);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  _camoTextureCache[team] = tex;
  return tex;
}

// Camo material: the texture already carries the team color, so the
// material's own color is white (no extra tinting).
const matCamo = (team, opts = {}) =>
  new THREE.MeshStandardMaterial({
    map: camoTexture(team),
    color: 0xffffff,
    roughness: 0.78, metalness: 0.12,
    ...opts,
  });

function makeInfantry(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  // ~1.8 m tall standing soldier in a "rifle ready" pose: feet shoulder-width
  // apart, both hands gripping a carbine across the chest with right hand at
  // the pistol grip and left hand on the handguard.
  const M = {
    uniform: matCamo(team),
    vest:    mat(c.dark, { roughness: 0.85, metalness: 0.05 }),
    accent:  mat(c.accent),
    skin:    mat(0xc8a07a, { roughness: 0.9 }),
    glove:   mat(0x1f1f1f, { roughness: 0.9 }),
    boot:    mat(0x0f0f0f, { roughness: 0.95 }),
    metal:   mat(0x2c2c2c, { metalness: 0.50, roughness: 0.45 }),
    poly:    mat(0x2a2620, { roughness: 0.8 }),  // rifle polymer furniture
    dark:    mat(0x111111),
  };

  function add(parent, geo, key, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const m = new THREE.Mesh(geo, M[key]);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  }

  // Cylinder spanning two world points; cylinder local +Y is aligned to the
  // (B - A) direction so the limb sits exactly between the joints.
  function limb(parent, key, pA, pB, radius) {
    const a = new THREE.Vector3(pA[0], pA[1], pA[2]);
    const b = new THREE.Vector3(pB[0], pB[1], pB[2]);
    const len = a.distanceTo(b);
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, len, 10),
      M[key],
    );
    cyl.position.copy(a).add(b).multiplyScalar(0.5);
    cyl.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.clone().sub(a).normalize(),
    );
    parent.add(cyl);
    return cyl;
  }

  // ─── LEGS + BOOTS ─────────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    const hip   = [sx * 0.10, 0.94, 0];
    const knee  = [sx * 0.12, 0.52, 0.02];
    const ankle = [sx * 0.10, 0.13, 0.05];
    limb(g, 'uniform', hip,  knee,  0.10);   // thigh
    limb(g, 'uniform', knee, ankle, 0.085);  // shin
    add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', knee);                     // knee pad
    add(g, new THREE.BoxGeometry(0.20, 0.13, 0.32), 'boot', [sx * 0.10, 0.07, 0.06]); // boot
  }

  // ─── HIPS / TORSO / PLATE CARRIER ─────────────────────────────────────
  add(g, new THREE.BoxGeometry(0.46, 0.10, 0.26), 'vest',    [0, 0.97, 0]);     // belt
  add(g, new THREE.BoxGeometry(0.40, 0.18, 0.22), 'uniform', [0, 1.10, 0]);     // waist
  add(g, new THREE.BoxGeometry(0.50, 0.30, 0.28), 'uniform', [0, 1.30, 0]);     // chest
  add(g, new THREE.BoxGeometry(0.42, 0.32, 0.08), 'vest',    [0, 1.30, 0.16]);  // plate carrier
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.10, 0.16, 0.07), 'vest', [sx * 0.13, 1.21, 0.21]);  // mag pouch
  }

  // ─── NECK / HEAD / HELMET ─────────────────────────────────────────────
  add(g, new THREE.CylinderGeometry(0.06, 0.07, 0.12, 8), 'skin', [0, 1.46, 0]);
  add(g, new THREE.SphereGeometry(0.13, 16, 12),          'skin', [0, 1.62, 0.01]);
  add(g, new THREE.SphereGeometry(0.18, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      'accent', [0, 1.65, -0.01]);                                        // dome
  add(g, new THREE.CylinderGeometry(0.18, 0.18, 0.04, 18), 'accent', [0, 1.61, -0.01]);  // band
  add(g, new THREE.BoxGeometry(0.08, 0.05, 0.04), 'dark', [0, 1.69, 0.16]);              // NVG mount

  // ─── ARMS + RIFLE HOLD POSE ───────────────────────────────────────────
  // Hand positions define the rifle line. Right hand grips the pistol grip;
  // left hand wraps the handguard further forward and slightly to the left,
  // putting the muzzle out and to the soldier's left like a right-shoulder
  // shooter. Both hands at the same Y keeps the rifle horizontal.
  const rShoulder = [ 0.22, 1.32, 0   ];
  const rElbow    = [ 0.25, 1.16, 0.04];
  const rHand     = [ 0.10, 1.10, 0.27];
  const lShoulder = [-0.22, 1.32, 0   ];
  const lElbow    = [-0.20, 1.20, 0.18];
  const lHand     = [-0.04, 1.10, 0.52];

  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', rShoulder);
  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', lShoulder);
  limb(g, 'uniform', rShoulder, rElbow, 0.085);
  limb(g, 'uniform', rElbow,    rHand,  0.075);
  limb(g, 'uniform', lShoulder, lElbow, 0.085);
  limb(g, 'uniform', lElbow,    lHand,  0.075);
  add(g, new THREE.BoxGeometry(0.09, 0.10, 0.10), 'glove', rHand);
  add(g, new THREE.BoxGeometry(0.09, 0.10, 0.10), 'glove', lHand);

  // Rifle local frame: origin sits at the right-hand pistol grip, +Z points
  // along the line through the left hand and out the muzzle. The whole rifle
  // group is rotated so both hands align without per-mesh trig.
  const rifle = new THREE.Group();
  const rH = new THREE.Vector3(rHand[0], rHand[1], rHand[2]);
  const lH = new THREE.Vector3(lHand[0], lHand[1], lHand[2]);
  rifle.position.copy(rH);
  rifle.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    lH.clone().sub(rH).normalize(),
  );
  g.add(rifle);

  // Pistol grip + lower receiver / mag well
  add(rifle, new THREE.BoxGeometry(0.045, 0.10, 0.05), 'poly',  [0, -0.06, -0.05]);
  add(rifle, new THREE.BoxGeometry(0.055, 0.10, 0.18), 'metal', [0,  0.02,  0.04]);
  // Magazine
  add(rifle, new THREE.BoxGeometry(0.055, 0.16, 0.07), 'dark',  [0, -0.13,  0.04]);
  // Stock: buffer tube → cheek piece → buttpad
  add(rifle, new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), 'metal',
      [0, 0.04, -0.13], [Math.PI / 2, 0, 0]);
  add(rifle, new THREE.BoxGeometry(0.055, 0.10, 0.15),  'poly', [0, 0.04, -0.27]);
  add(rifle, new THREE.BoxGeometry(0.06,  0.12, 0.025), 'dark', [0, 0.04, -0.36]);
  // Upper receiver / handguard (where left hand grips)
  add(rifle, new THREE.BoxGeometry(0.05, 0.07, 0.36), 'metal', [0, 0.08, 0.27]);
  // Optic on top rail (red dot style: mount + sight body)
  add(rifle, new THREE.BoxGeometry(0.04, 0.06, 0.06), 'metal', [0, 0.115, 0.07]);
  add(rifle, new THREE.BoxGeometry(0.03, 0.04, 0.06), 'dark',  [0, 0.16,  0.07]);
  // Barrel + flash hider
  add(rifle, new THREE.CylinderGeometry(0.016, 0.018, 0.20, 8), 'metal',
      [0, 0.08, 0.55], [Math.PI / 2, 0, 0]);
  add(rifle, new THREE.CylinderGeometry(0.024, 0.024, 0.05, 8), 'dark',
      [0, 0.08, 0.67], [Math.PI / 2, 0, 0]);

  return g;
}

function makeTank(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  // Forward (+Z) is the gun-facing direction. The tank silhouette is loosely
  // modelled on a modern Russian/Ukrainian MBT (T-72/T-90 family) — slab-cast
  // turret with reactive armour bricks, fume-extractor barrel, NSV anti-air
  // MG on the commander cupola.
  const M = {
    hull:    matCamo(team),
    detail:  mat(c.dark),
    accent:  mat(c.accent),
    track:   mat(0x141414, { roughness: 0.95 }),
    wheel:   mat(0x1d1d1d, { roughness: 0.85 }),
    metal:   mat(0x2c2c2c, { metalness: 0.45, roughness: 0.5 }),
    barrel:  mat(0x333333, { metalness: 0.55, roughness: 0.4 }),
    sleeve:  mat(0x6c6a58, { roughness: 0.85 }),    // canvas thermal sleeve
    era:     mat(c.dark, { roughness: 0.55, metalness: 0.18 }),
    dark:    mat(0x111111),
    light:   mat(0xfff0c8, { emissive: 0x554020, emissiveIntensity: 0.25, roughness: 0.3 }),
  };
  const add = (parent, geo, key, pos = [0, 0, 0], rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, M[key]);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  };

  // ─── LOWER HULL ────────────────────────────────────────────────────────
  add(g, new THREE.BoxGeometry(2.0, 0.5, 3.0), 'detail', [0, 0.42, 0]);
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.18, 0.55, 2.85), 'detail', [sx * 1.10, 0.50, 0]);
  }

  // ─── GLACIS (sloped front upper hull) ──────────────────────────────────
  // A child group rotated to the glacis plane; ERA bricks, headlights and tow
  // hooks are then placed in the group's local frame so they sit flush on the
  // sloped surface without trig per-mesh.
  // Plate is laid flat (thin axis = +Y). Positive rotation about X tilts the
  // local +Y toward +Z, so the surface ends up facing up-and-forward and the
  // plate slopes from front-low to back-high — the canonical glacis pose.
  const glacisAngle = Math.PI / 3.2;
  const glacis = new THREE.Group();
  glacis.position.set(0, 0.85, 1.45);
  glacis.rotation.x = glacisAngle;
  g.add(glacis);
  add(glacis, new THREE.BoxGeometry(2.0, 0.06, 1.0), 'hull');
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 4; cc++) {
      add(glacis,
        new THREE.BoxGeometry(0.42, 0.06, 0.22),
        'era',
        [-0.75 + cc * 0.50, 0.06, -0.30 + r * 0.30],
      );
    }
  }
  for (const sx of [-1, 1]) {
    add(glacis, new THREE.SphereGeometry(0.07, 10, 8), 'light', [sx * 0.85, 0.07, 0.45]);
    add(glacis, new THREE.BoxGeometry(0.10, 0.10, 0.14), 'metal', [sx * 0.55, 0.04, -0.46]);
  }

  // ─── UPPER DECK + REAR PLATE ───────────────────────────────────────────
  add(g, new THREE.BoxGeometry(1.92, 0.16, 1.6), 'hull', [0, 1.00, -0.20]);
  const rear = new THREE.Group();
  rear.position.set(0, 0.70, -1.55);
  rear.rotation.x = -0.18;
  g.add(rear);
  add(rear, new THREE.BoxGeometry(2.0, 0.7, 0.06), 'hull');
  add(rear, new THREE.BoxGeometry(1.30, 0.40, 0.04), 'dark', [0, 0, 0.04]);  // engine grille

  // ─── TRACK ASSEMBLIES (per side) ───────────────────────────────────────
  for (const sx of [-1, 1]) {
    const tr = new THREE.Group();
    tr.position.set(sx * 1.05, 0, 0);
    g.add(tr);

    // Top + bottom runs of the track (closed loop with the idler/sprocket)
    add(tr, new THREE.BoxGeometry(0.46, 0.08, 2.85), 'track', [0, 0.62, 0]);
    add(tr, new THREE.BoxGeometry(0.46, 0.08, 2.85), 'track', [0, 0.06, 0]);
    // Front idler + rear drive sprocket
    add(tr, new THREE.CylinderGeometry(0.34, 0.34, 0.42, 18), 'metal',
        [0, 0.34,  1.43], [0, 0, Math.PI / 2]);
    add(tr, new THREE.CylinderGeometry(0.36, 0.36, 0.42, 18), 'metal',
        [0, 0.34, -1.43], [0, 0, Math.PI / 2]);
    // Road wheels with darker rim caps
    for (let i = 0; i < 5; i++) {
      const z = -1.10 + i * 0.55;
      add(tr, new THREE.CylinderGeometry(0.30, 0.30, 0.22, 16), 'wheel', [0, 0.32, z], [0, 0, Math.PI / 2]);
      add(tr, new THREE.CylinderGeometry(0.18, 0.18, 0.24, 12), 'metal', [0, 0.32, z], [0, 0, Math.PI / 2]);
    }
    // Return rollers (small wheels above main wheels)
    for (let i = 0; i < 2; i++) {
      add(tr, new THREE.CylinderGeometry(0.12, 0.12, 0.18, 10), 'wheel',
          [0, 0.62, -0.55 + i * 1.10], [0, 0, Math.PI / 2]);
    }
    // Track shoe ribs (top + bottom faces) — gives the loop a segmented look
    for (let i = 0; i < 9; i++) {
      const z = -1.30 + i * 0.32;
      add(tr, new THREE.BoxGeometry(0.50, 0.02, 0.25), 'dark', [0, 0.66, z]);
      add(tr, new THREE.BoxGeometry(0.50, 0.02, 0.25), 'dark', [0, 0.02, z]);
    }
  }

  // ─── FENDERS / MUDGUARDS ──────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.55, 0.04, 3.05), 'hull', [sx * 1.05, 0.92, 0]);
  }
  // Spare track links stacked on the hull side
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      add(g, new THREE.BoxGeometry(0.08, 0.10, 0.14), 'metal',
          [sx * 1.10, 0.97, 0.4 + i * 0.18]);
    }
  }

  // ─── TURRET ASSEMBLY ───────────────────────────────────────────────────
  // Local frame: origin sits on top of the upper deck, +Z = forward (gun).
  const turret = new THREE.Group();
  turret.position.set(0, 1.10, -0.10);
  g.add(turret);

  // Turret ring
  add(turret, new THREE.CylinderGeometry(1.05, 1.05, 0.10, 20), 'detail', [0, 0.05, 0.10]);
  // Main turret body (slightly tapered visually with side cheeks below)
  add(turret, new THREE.BoxGeometry(1.65, 0.45, 1.50), 'hull', [0, 0.35, 0]);
  // Sloped front armour with ERA tiles
  const front = new THREE.Group();
  front.position.set(0, 0.34, 0.78);
  front.rotation.x = 0.50;
  turret.add(front);
  add(front, new THREE.BoxGeometry(1.55, 0.08, 0.45), 'hull');
  for (let i = 0; i < 4; i++) {
    add(front, new THREE.BoxGeometry(0.32, 0.07, 0.18), 'era', [-0.55 + i * 0.37, 0.08, 0.04]);
  }
  // Side cheeks with ERA bricks (tilted outward at the top)
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Group();
    cheek.position.set(sx * 0.84, 0.34, 0);
    cheek.rotation.z = sx * 0.15;
    turret.add(cheek);
    for (let r = 0; r < 2; r++) {
      for (let cc = 0; cc < 3; cc++) {
        add(cheek, new THREE.BoxGeometry(0.06, 0.16, 0.32), 'era',
            [sx * 0.04, -0.16 + r * 0.18, -0.42 + cc * 0.42]);
      }
    }
  }
  // Top deck + rear bustle (storage rack)
  add(turret, new THREE.BoxGeometry(1.55, 0.06, 1.45), 'hull', [0, 0.61, 0]);
  const bustle = new THREE.Group();
  bustle.position.set(0, 0.32, -0.92);
  turret.add(bustle);
  add(bustle, new THREE.BoxGeometry(1.45, 0.48, 0.42), 'detail');
  add(bustle, new THREE.BoxGeometry(1.36, 0.42, 0.38), 'dark', [0, 0, 0.02]);  // recessed mesh look
  for (const sx of [-0.42, 0.42]) {
    add(bustle, new THREE.BoxGeometry(0.55, 0.18, 0.32), 'detail', [sx, 0.34, 0]);
  }
  // Snorkel tube strapped on the bustle
  add(bustle, new THREE.CylinderGeometry(0.08, 0.08, 1.3, 12), 'detail', [0, 0.12, -0.30], [0, 0, Math.PI / 2]);

  // ─── MANTLET + GUN (thermal sleeve, fume extractor, muzzle brake) ──────
  add(turret, new THREE.BoxGeometry(0.92, 0.46, 0.30), 'detail', [0, 0.40, 0.94]);
  add(turret, new THREE.CylinderGeometry(0.14, 0.14, 1.70, 16), 'sleeve',
      [0, 0.42, 1.70], [Math.PI / 2, 0, 0]);
  add(turret, new THREE.CylinderGeometry(0.18, 0.18, 0.34, 16), 'sleeve',
      [0, 0.42, 2.10], [Math.PI / 2, 0, 0]);  // fume extractor bulge
  add(turret, new THREE.CylinderGeometry(0.09, 0.09, 1.10, 14), 'barrel',
      [0, 0.42, 2.85], [Math.PI / 2, 0, 0]);
  add(turret, new THREE.CylinderGeometry(0.16, 0.16, 0.30, 14), 'metal',
      [0, 0.42, 3.40], [Math.PI / 2, 0, 0]);  // muzzle brake outer
  add(turret, new THREE.CylinderGeometry(0.10, 0.10, 0.34, 12), 'dark',
      [0, 0.42, 3.40], [Math.PI / 2, 0, 0]);  // muzzle brake bore

  // ─── COMMANDER CUPOLA + AA MG (NSV-12.7 style) ─────────────────────────
  const cupola = new THREE.Group();
  cupola.position.set(0.50, 0.74, -0.32);
  turret.add(cupola);
  add(cupola, new THREE.CylinderGeometry(0.32, 0.32, 0.20, 18), 'detail');
  add(cupola, new THREE.CylinderGeometry(0.28, 0.28, 0.06, 18), 'accent', [0, 0.13, 0]);
  // Periscopes ringing the cupola
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    add(cupola, new THREE.BoxGeometry(0.10, 0.05, 0.08), 'dark',
        [Math.cos(ang) * 0.32, 0.05, Math.sin(ang) * 0.32], [0, -ang, 0]);
  }
  // Pintle + receiver + barrel + ammo can
  add(cupola, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 8), 'metal', [0, 0.27, 0.05]);
  add(cupola, new THREE.BoxGeometry(0.10, 0.12, 0.42), 'metal', [0, 0.42, 0.10]);
  add(cupola, new THREE.CylinderGeometry(0.025, 0.025, 0.65, 10), 'dark',
      [0, 0.42, 0.55], [Math.PI / 2, 0, 0]);
  add(cupola, new THREE.BoxGeometry(0.16, 0.10, 0.16), 'detail', [0.10, 0.38, 0.00]);

  // ─── COAXIAL MG (small gun barrel beside main gun) ────────────────────
  add(turret, new THREE.CylinderGeometry(0.04, 0.04, 0.55, 10), 'dark',
      [0.30, 0.32, 1.10], [Math.PI / 2, 0, 0]);

  // ─── SMOKE LAUNCHERS (banks of 4 per side, angled forward) ────────────
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const row = Math.floor(i / 2), col = i % 2;
      add(turret,
          new THREE.CylinderGeometry(0.06, 0.06, 0.22, 10),
          'metal',
          [sx * (0.78 + row * 0.14), 0.62, 0.45 + col * 0.14],
          [-0.35, 0, 0]);
    }
  }

  // ─── ANTENNA ──────────────────────────────────────────────────────────
  add(turret, new THREE.CylinderGeometry(0.012, 0.008, 1.40, 6), 'dark',
      [-0.78, 1.30, -0.70], [0, 0, 0.10]);

  // Expose turret group so the timeline can swing it toward the target
  // independently of the hull yaw. Pivot is at (0, 0) in turret-local space,
  // which sits on the turret ring — i.e. rotates about the vertical hull axis.
  g.userData.turret = turret;
  g.userData.turretPivot = new THREE.Vector3(0, turret.position.y, turret.position.z);

  return g;
}

function makeDrone(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), matCamo(team));
  body.scale.set(1.2, 0.6, 1.4); body.castShadow = true;
  g.add(body);

  // 4 arms with rotors
  const armMat = mat(c.dark);
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.55 });
  for (const [dx, dz] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.9), armMat);
    arm.position.set(dx * 0.45, 0.0, dz * 0.45);
    arm.lookAt(new THREE.Vector3(dx, 0, dz));
    g.add(arm);

    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 16), rotorMat);
    rotor.position.set(dx * 0.85, 0.1, dz * 0.85);
    rotor.userData.spin = true;
    g.add(rotor);
  }

  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), mat(0x111111));
  cam.position.set(0, -0.18, 0.32);
  g.add(cam);

  // Drone hovers — give it a small Y offset baseline
  g.userData.hoverBase = 6.0;
  return g;
}

function makeArtillery(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  // Self-propelled howitzer (K9/M109/Msta-S inspired): tracked chassis,
  // longer and wider than the MBT, with a large boxy turret housing a long
  // 155 mm howitzer (multi-baffle muzzle brake + bore evacuator + recoil
  // cylinders) and a deep rear ammo bustle.
  const M = {
    hull:    matCamo(team),
    detail:  mat(c.dark),
    accent:  mat(c.accent),
    track:   mat(0x141414, { roughness: 0.95 }),
    wheel:   mat(0x1d1d1d, { roughness: 0.85 }),
    metal:   mat(0x2c2c2c, { metalness: 0.45, roughness: 0.5 }),
    barrel:  mat(0x333333, { metalness: 0.55, roughness: 0.4 }),
    dark:    mat(0x111111),
    light:   mat(0xfff0c8, { emissive: 0x554020, emissiveIntensity: 0.25, roughness: 0.3 }),
  };
  const add = (parent, geo, key, pos = [0, 0, 0], rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, M[key]);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  };

  // ─── LOWER HULL (longer than MBT) ─────────────────────────────────────
  add(g, new THREE.BoxGeometry(2.4, 0.65, 4.0), 'detail', [0, 0.45, 0]);
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.20, 0.70, 3.85), 'detail', [sx * 1.30, 0.50, 0]);
  }

  // ─── GLACIS ───────────────────────────────────────────────────────────
  const glacisAngle = Math.PI / 4;
  const glacis = new THREE.Group();
  glacis.position.set(0, 0.95, 1.55);
  glacis.rotation.x = glacisAngle;
  g.add(glacis);
  add(glacis, new THREE.BoxGeometry(2.4, 0.06, 0.85), 'hull');
  // Driver's hatch (raised dome)
  add(glacis, new THREE.CylinderGeometry(0.20, 0.20, 0.06, 16), 'detail', [0.55, 0.07, 0]);
  // Headlight clusters
  for (const sx of [-1, 1]) {
    add(glacis, new THREE.BoxGeometry(0.20, 0.10, 0.14), 'metal', [sx * 0.95, 0.06, 0.20]);
    add(glacis, new THREE.SphereGeometry(0.07, 10, 8), 'light',   [sx * 0.95, 0.10, 0.30]);
  }
  // Tow hooks
  for (const sx of [-1, 1]) {
    add(glacis, new THREE.BoxGeometry(0.10, 0.10, 0.14), 'metal', [sx * 0.50, 0.04, -0.38]);
  }

  // ─── HULL DECK + ENGINE GRILLE (in front of turret) ───────────────────
  add(g, new THREE.BoxGeometry(2.3, 0.16, 1.4), 'hull', [0, 0.85, 0.55]);
  // Engine air intake grilles (3 rectangular grilles, rear of engine deck)
  add(g, new THREE.BoxGeometry(2.0, 0.08, 0.50), 'dark', [0, 0.94, 0.55]);
  for (let i = 0; i < 3; i++) {
    add(g, new THREE.BoxGeometry(0.50, 0.02, 0.40), 'metal', [-0.7 + i * 0.7, 0.985, 0.55]);
  }

  // ─── REAR PLATE + LOADING HATCH + RECOIL SPADES ───────────────────────
  const rear = new THREE.Group();
  rear.position.set(0, 0.55, -2.05);
  rear.rotation.x = -0.10;
  g.add(rear);
  add(rear, new THREE.BoxGeometry(2.4, 0.85, 0.06), 'hull');
  add(rear, new THREE.BoxGeometry(1.5, 0.55, 0.04), 'detail', [0, -0.05, 0.04]);  // big rear loading door
  // Door handle
  add(rear, new THREE.BoxGeometry(0.30, 0.04, 0.04), 'metal', [0, -0.05, 0.07]);
  // Recoil spades (folded against rear hull, deploy down to brace when firing)
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.14, 0.55, 0.10), 'metal', [sx * 0.85, 0.50, -2.13]);
    add(g, new THREE.BoxGeometry(0.30, 0.10, 0.10), 'metal', [sx * 0.85, 0.20, -2.13]);  // ground pad
  }

  // ─── TRACK ASSEMBLIES (per side, 7 road wheels) ───────────────────────
  for (const sx of [-1, 1]) {
    const tr = new THREE.Group();
    tr.position.set(sx * 1.25, 0, 0);
    g.add(tr);

    // Top + bottom runs (longer than MBT)
    add(tr, new THREE.BoxGeometry(0.50, 0.10, 3.85), 'track', [0, 0.72, 0]);
    add(tr, new THREE.BoxGeometry(0.50, 0.10, 3.85), 'track', [0, 0.07, 0]);
    // Front idler + rear drive sprocket (bigger than MBT's)
    add(tr, new THREE.CylinderGeometry(0.38, 0.38, 0.46, 18), 'metal',
        [0, 0.40,  1.93], [0, 0, Math.PI / 2]);
    add(tr, new THREE.CylinderGeometry(0.40, 0.40, 0.46, 18), 'metal',
        [0, 0.40, -1.93], [0, 0, Math.PI / 2]);
    // 7 road wheels
    for (let i = 0; i < 7; i++) {
      const z = -1.50 + i * 0.50;
      add(tr, new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16), 'wheel', [0, 0.36, z], [0, 0, Math.PI / 2]);
      add(tr, new THREE.CylinderGeometry(0.20, 0.20, 0.26, 12), 'metal', [0, 0.36, z], [0, 0, Math.PI / 2]);
    }
    // 3 return rollers
    for (let i = 0; i < 3; i++) {
      add(tr, new THREE.CylinderGeometry(0.13, 0.13, 0.20, 10), 'wheel',
          [0, 0.72, -1.0 + i * 1.0], [0, 0, Math.PI / 2]);
    }
    // Track shoe ribs (12 along the loop)
    for (let i = 0; i < 12; i++) {
      const z = -1.80 + i * 0.33;
      add(tr, new THREE.BoxGeometry(0.54, 0.02, 0.28), 'dark', [0, 0.77, z]);
      add(tr, new THREE.BoxGeometry(0.54, 0.02, 0.28), 'dark', [0, 0.02, z]);
    }
  }

  // ─── FENDERS ──────────────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.60, 0.05, 4.0), 'hull', [sx * 1.25, 1.02, 0]);
  }

  // ─── TURRET (large, boxy, slab-armoured) ──────────────────────────────
  const turret = new THREE.Group();
  turret.position.set(0, 1.05, -0.50);
  g.add(turret);

  // Turret ring on hull deck
  add(turret, new THREE.CylinderGeometry(1.30, 1.30, 0.10, 22), 'detail', [0, 0.05, 0]);
  // Main turret body (much bigger than MBT)
  add(turret, new THREE.BoxGeometry(2.2, 0.65, 2.4), 'hull', [0, 0.45, 0]);
  // Sloped front armour
  const front = new THREE.Group();
  front.position.set(0, 0.43, 1.30);
  front.rotation.x = 0.40;
  turret.add(front);
  add(front, new THREE.BoxGeometry(2.0, 0.10, 0.55), 'hull');
  // Rear bustle (deep — holds 155 mm shells)
  const bustle = new THREE.Group();
  bustle.position.set(0, 0.40, -1.45);
  turret.add(bustle);
  add(bustle, new THREE.BoxGeometry(2.0, 0.55, 0.55), 'hull');
  // Loading hatch on top of bustle
  add(bustle, new THREE.BoxGeometry(0.80, 0.04, 0.50), 'detail', [0, 0.30, 0]);
  // Stowage bins on bustle sides
  for (const sx of [-1, 1]) {
    add(bustle, new THREE.BoxGeometry(0.16, 0.40, 0.45), 'detail', [sx * 1.05, 0.05, 0]);
  }
  // Top deck
  add(turret, new THREE.BoxGeometry(2.0, 0.05, 2.3), 'hull', [0, 0.78, 0]);
  // Side stowage racks (artillery don't carry ERA — instead long external bins)
  for (const sx of [-1, 1]) {
    add(turret, new THREE.BoxGeometry(0.12, 0.30, 1.6), 'detail', [sx * 1.13, 0.40, 0]);
    // Rack divider ribs
    for (let i = 0; i < 4; i++) {
      add(turret, new THREE.BoxGeometry(0.16, 0.04, 0.04), 'dark',
          [sx * 1.13, 0.40, -0.7 + i * 0.45]);
    }
  }

  // ─── MANTLET + 155 mm HOWITZER ────────────────────────────────────────
  // Barrel assembly is pivoted at the mantlet/trunnion and elevated ~10° so
  // the SPH silhouette is visually distinct from the MBT (indirect-fire pose).
  const barrelAssy = new THREE.Group();
  barrelAssy.position.set(0, 0.43, 1.55);
  barrelAssy.rotation.x = -0.26;
  turret.add(barrelAssy);

  // Mantlet (large gun shield) — moves with the gun
  add(barrelAssy, new THREE.BoxGeometry(1.20, 0.65, 0.40), 'detail', [0, 0, 0]);
  // Recoil cylinders above the barrel (twin hydraulic units)
  for (const sx of [-0.22, 0.22]) {
    add(barrelAssy, new THREE.CylinderGeometry(0.09, 0.09, 0.85, 12), 'metal',
        [sx, 0.22, 0.50], [Math.PI / 2, 0, 0]);
    // Cylinder end caps
    add(barrelAssy, new THREE.CylinderGeometry(0.10, 0.10, 0.04, 12), 'dark',
        [sx, 0.22, 0.90], [Math.PI / 2, 0, 0]);
  }
  // Main barrel (long, slight taper toward muzzle)
  add(barrelAssy, new THREE.CylinderGeometry(0.13, 0.15, 3.6, 18), 'barrel',
      [0, 0, 2.00], [Math.PI / 2, 0, 0]);
  // Bore evacuator (fume extractor bulge ~⅔ along barrel)
  add(barrelAssy, new THREE.CylinderGeometry(0.20, 0.20, 0.42, 16), 'metal',
      [0, 0, 2.75], [Math.PI / 2, 0, 0]);
  // Multi-baffle muzzle brake — main body
  add(barrelAssy, new THREE.CylinderGeometry(0.22, 0.22, 0.50, 18), 'metal',
      [0, 0, 3.95], [Math.PI / 2, 0, 0]);
  // Three baffle slots (dark rings cutting into the brake)
  for (let i = 0; i < 3; i++) {
    add(barrelAssy, new THREE.CylinderGeometry(0.23, 0.23, 0.04, 18), 'dark',
        [0, 0, 3.81 + i * 0.14], [Math.PI / 2, 0, 0]);
  }
  // Muzzle bore opening
  add(barrelAssy, new THREE.CylinderGeometry(0.10, 0.10, 0.06, 14), 'dark',
      [0, 0, 4.23], [Math.PI / 2, 0, 0]);

  // ─── COMMANDER CUPOLA + 12.7 mm AA MG ─────────────────────────────────
  const cupola = new THREE.Group();
  cupola.position.set(0.55, 0.83, -0.35);
  turret.add(cupola);
  add(cupola, new THREE.CylinderGeometry(0.34, 0.34, 0.22, 18), 'detail');
  add(cupola, new THREE.CylinderGeometry(0.30, 0.30, 0.06, 18), 'accent', [0, 0.14, 0]);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    add(cupola, new THREE.BoxGeometry(0.10, 0.05, 0.08), 'dark',
        [Math.cos(ang) * 0.34, 0.05, Math.sin(ang) * 0.34], [0, -ang, 0]);
  }
  add(cupola, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 8), 'metal', [0, 0.27, 0.05]);
  add(cupola, new THREE.BoxGeometry(0.10, 0.12, 0.42), 'metal',         [0, 0.42, 0.10]);
  add(cupola, new THREE.CylinderGeometry(0.025, 0.025, 0.65, 10), 'dark',
      [0, 0.42, 0.55], [Math.PI / 2, 0, 0]);
  add(cupola, new THREE.BoxGeometry(0.16, 0.10, 0.16), 'detail',        [0.10, 0.38, 0.00]);

  // Loader hatch (left side of turret top)
  add(turret, new THREE.CylinderGeometry(0.30, 0.30, 0.08, 18), 'detail',
      [-0.55, 0.83, -0.35]);

  // ─── SMOKE LAUNCHERS + ANTENNAS ───────────────────────────────────────
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const row = Math.floor(i / 2), col = i % 2;
      add(turret, new THREE.CylinderGeometry(0.06, 0.06, 0.22, 10), 'metal',
          [sx * (0.95 + row * 0.14), 0.82, 0.85 + col * 0.14], [-0.35, 0, 0]);
    }
  }
  // Twin radio antennas on the bustle
  add(turret, new THREE.CylinderGeometry(0.012, 0.008, 1.6, 6), 'dark',
      [-0.95, 1.30, -1.20], [0, 0,  0.10]);
  add(turret, new THREE.CylinderGeometry(0.012, 0.008, 1.4, 6), 'dark',
      [ 0.95, 1.20, -1.20], [0, 0, -0.10]);

  // Expose turret group so the timeline can swing it toward the target.
  // Pivot is offset back (z=-0.50) from hull origin — the turret traverses
  // about its own ring, not the hull centerline.
  g.userData.turret = turret;
  g.userData.turretPivot = new THREE.Vector3(0, turret.position.y, turret.position.z);

  return g;
}

function makeAntitank(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  // Kneeling AT gunner with shouldered ATGM launcher (Javelin-style: launch
  // tube + CLU command launch unit on top + tapered warhead at the muzzle).
  // Right knee on ground, left knee up forward — classic firing stance.
  const M = {
    uniform: matCamo(team),
    vest:    mat(c.dark, { roughness: 0.85, metalness: 0.05 }),
    accent:  mat(c.accent),
    skin:    mat(0xc8a07a, { roughness: 0.9 }),
    glove:   mat(0x1f1f1f, { roughness: 0.9 }),
    boot:    mat(0x0f0f0f, { roughness: 0.95 }),
    metal:   mat(0x2c2c2c, { metalness: 0.45, roughness: 0.5 }),
    poly:    mat(0x2a2620, { roughness: 0.8 }),
    tube:    mat(0x4d4938, { roughness: 0.7 }),  // launch tube olive drab
    warhead: mat(0x2a2a2a, { metalness: 0.4, roughness: 0.5 }),
    glass:   mat(0x202428, { metalness: 0.3, roughness: 0.2 }),
    dark:    mat(0x111111),
  };

  function add(parent, geo, key, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const m = new THREE.Mesh(geo, M[key]);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  }

  function limb(parent, key, pA, pB, radius) {
    const a = new THREE.Vector3(pA[0], pA[1], pA[2]);
    const b = new THREE.Vector3(pB[0], pB[1], pB[2]);
    const len = a.distanceTo(b);
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, len, 10),
      M[key],
    );
    cyl.position.copy(a).add(b).multiplyScalar(0.5);
    cyl.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.clone().sub(a).normalize(),
    );
    parent.add(cyl);
    return cyl;
  }

  // ─── KNEELING LEGS (right knee down, left knee up forward) ────────────
  const rHip   = [ 0.13, 0.55, -0.10];
  const rKnee  = [ 0.16, 0.12, -0.05];
  const rAnkle = [ 0.18, 0.08, -0.45];
  limb(g, 'uniform', rHip,  rKnee,  0.10);
  limb(g, 'uniform', rKnee, rAnkle, 0.085);
  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', rKnee);
  add(g, new THREE.BoxGeometry(0.20, 0.13, 0.28), 'boot', [0.18, 0.07, -0.50]);

  const lHip   = [-0.13, 0.55, -0.05];
  const lKnee  = [-0.20, 0.50,  0.25];
  const lAnkle = [-0.18, 0.08,  0.30];
  limb(g, 'uniform', lHip,  lKnee,  0.10);
  limb(g, 'uniform', lKnee, lAnkle, 0.085);
  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', lKnee);
  add(g, new THREE.BoxGeometry(0.20, 0.13, 0.32), 'boot', [-0.18, 0.07, 0.35]);

  // ─── HIPS / TORSO / PLATE CARRIER ─────────────────────────────────────
  add(g, new THREE.BoxGeometry(0.46, 0.10, 0.26), 'vest',    [0.00, 0.58, -0.08]);
  add(g, new THREE.BoxGeometry(0.40, 0.18, 0.22), 'uniform', [0.02, 0.72, -0.05]);
  add(g, new THREE.BoxGeometry(0.50, 0.30, 0.26), 'uniform', [0.05, 0.95, -0.02]);
  add(g, new THREE.BoxGeometry(0.42, 0.32, 0.08), 'vest',    [0.07, 0.95,  0.13]);
  for (const sx of [-1, 1]) {
    add(g, new THREE.BoxGeometry(0.10, 0.16, 0.07), 'vest',
        [0.07 + sx * 0.13, 0.86, 0.18]);
  }

  // ─── NECK / HEAD / HELMET ─────────────────────────────────────────────
  add(g, new THREE.CylinderGeometry(0.06, 0.07, 0.10, 8), 'skin', [0.07, 1.10, 0.02]);
  add(g, new THREE.SphereGeometry(0.13, 16, 12),          'skin', [0.08, 1.24, 0.06]);
  add(g, new THREE.SphereGeometry(0.18, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      'accent', [0.08, 1.27, 0.05]);
  add(g, new THREE.CylinderGeometry(0.18, 0.18, 0.04, 18), 'accent', [0.08, 1.23, 0.05]);
  add(g, new THREE.BoxGeometry(0.08, 0.05, 0.04), 'dark', [0.08, 1.31, 0.20]);

  // ─── ARMS + LAUNCHER HOLD POSE ────────────────────────────────────────
  // Right hand at pistol grip (rear, tucked close to right shoulder pocket).
  // Left hand reaches forward to grip the front of the tube. Both hands at the
  // same Y so the tube sits horizontal.
  const rShoulder = [ 0.27, 1.05, 0.05];
  const rElbow    = [ 0.30, 0.92, 0.05];
  const rHand     = [ 0.18, 0.92, 0.20];
  const lShoulder = [-0.17, 1.05, 0.05];
  const lElbow    = [-0.05, 0.95, 0.30];
  const lHand     = [ 0.10, 0.92, 0.60];

  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', rShoulder);
  add(g, new THREE.SphereGeometry(0.10, 10, 8), 'vest', lShoulder);
  limb(g, 'uniform', rShoulder, rElbow, 0.085);
  limb(g, 'uniform', rElbow,    rHand,  0.075);
  limb(g, 'uniform', lShoulder, lElbow, 0.085);
  limb(g, 'uniform', lElbow,    lHand,  0.075);
  add(g, new THREE.BoxGeometry(0.09, 0.10, 0.10), 'glove', rHand);
  add(g, new THREE.BoxGeometry(0.09, 0.10, 0.10), 'glove', lHand);

  // ─── LAUNCHER (Javelin-style ATGM) ────────────────────────────────────
  // Local +Z = muzzle direction. Origin sits ~10 cm above the right hand so
  // the tube rides above the grip; the whole group is rotated so its +Z runs
  // from right hand → left hand → out the warhead.
  const launcher = new THREE.Group();
  const rH = new THREE.Vector3(rHand[0], rHand[1], rHand[2]);
  const lH = new THREE.Vector3(lHand[0], lHand[1], lHand[2]);
  launcher.position.copy(rH).add(new THREE.Vector3(0, 0.10, 0));
  launcher.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    lH.clone().sub(rH).normalize(),
  );
  g.add(launcher);

  // Launch tube (main body)
  add(launcher, new THREE.CylinderGeometry(0.10, 0.10, 1.10, 16), 'tube',
      [0, 0, 0.10], [Math.PI / 2, 0, 0]);
  // Tube ridge bands (segmented look)
  for (let i = 0; i < 4; i++) {
    add(launcher, new THREE.CylinderGeometry(0.105, 0.105, 0.02, 16), 'dark',
        [0, 0, -0.20 + i * 0.20], [Math.PI / 2, 0, 0]);
  }
  // Rear blast cap (slightly wider than tube)
  add(launcher, new THREE.CylinderGeometry(0.11, 0.11, 0.08, 16), 'dark',
      [0, 0, -0.45], [Math.PI / 2, 0, 0]);
  // Warhead — tapered cone at the muzzle (wide base joins tube, tip forward)
  add(launcher, new THREE.CylinderGeometry(0.10, 0.04, 0.20, 14), 'warhead',
      [0, 0, 0.75], [-Math.PI / 2, 0, 0]);

  // Pistol grip + trigger guard (right hand wraps around this)
  add(launcher, new THREE.BoxGeometry(0.05, 0.18, 0.06), 'poly',  [0, -0.13, 0.00]);
  add(launcher, new THREE.BoxGeometry(0.04, 0.04, 0.10), 'metal', [0, -0.06, 0.04]);
  // Front grip (left hand wraps around this)
  add(launcher, new THREE.BoxGeometry(0.05, 0.16, 0.05), 'poly', [0, -0.12, 0.40]);

  // CLU (Command Launch Unit) on top of the tube — eyepiece points back
  // toward the gunner's face, objective lens points forward.
  const clu = new THREE.Group();
  clu.position.set(0, 0.18, -0.05);
  launcher.add(clu);
  add(clu, new THREE.BoxGeometry(0.16, 0.18, 0.30), 'metal');
  add(clu, new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12), 'dark',
      [0, 0, -0.17], [Math.PI / 2, 0, 0]);                              // eyepiece cup
  add(clu, new THREE.CylinderGeometry(0.06, 0.06, 0.04, 14), 'glass',
      [0, 0, 0.17], [Math.PI / 2, 0, 0]);                               // objective lens
  add(clu, new THREE.BoxGeometry(0.04, 0.05, 0.04), 'dark', [ 0.05, 0.12, -0.05]);
  add(clu, new THREE.BoxGeometry(0.04, 0.05, 0.04), 'dark', [-0.05, 0.12, -0.05]);

  return g;
}

function makeCommandPost(team) {
  const c = TEAM_COLORS[team];
  const g = new THREE.Group();

  // Sandbag emplacement ring.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.4, 18), mat(0x6b5a3a, { roughness: 0.95 }));
  base.position.y = 0.2; base.castShadow = true;
  g.add(base);

  // Tent body + peaked roof.
  const tent = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 3.2), mat(c.dark));
  tent.position.y = 1.10; tent.castShadow = true;
  g.add(tent);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 0.9, 4), matCamo(team));
  roof.position.y = 2.25; roof.rotation.y = Math.PI / 4;
  g.add(roof);

  // Antenna mast with pennant — marks the command node from above.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.0, 8), mat(0x222222));
  mast.position.set(1.0, 2.5, -1.0);
  g.add(mast);

  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.02), mat(c.accent));
  flag.position.set(1.32, 3.6, -1.0);
  g.add(flag);

  return g;
}

const FACTORIES = {
  infantry: makeInfantry,
  tank: makeTank,
  drone: makeDrone,
  artillery: makeArtillery,
  antitank: makeAntitank,
  command_post: makeCommandPost,
};

export function createUnit(type, team) {
  const factory = FACTORIES[type];
  if (!factory) throw new Error(`unknown unit type: ${type}`);
  const obj = factory(team);
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  obj.userData.type = type;
  obj.userData.team = team;
  return obj;
}

// Death ring marker — a flat red/white "X" disc placed on the ground at last position.
export function createDeathMarker() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 0.95, 24),
    new THREE.MeshBasicMaterial({ color: 0xaa0000, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  return g;
}
