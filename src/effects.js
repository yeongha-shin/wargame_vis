import * as THREE from 'three';
import { createUnit } from './units.js';
import { playMuzzle, playImpact } from './audio.js';

// Without an alpha texture, SpriteMaterial renders as a hard-edged colored
// square — most visible on the dark smoke layer. We share two procedural
// radial-gradient textures across every sprite: a sharper hot disc for
// flames/tracers/embers, and a softer puff for smoke.
let _hotDisc = null;
let _smokePuff = null;

function _gradientTexture(stops) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  // Start fully transparent so anything outside the disc stays alpha=0,
  // regardless of how the gradient extrapolates beyond its outer radius.
  ctx.clearRect(0, 0, size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  // Restrict the fill to a disc — corners of the canvas remain alpha=0.
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.premultiplyAlpha = false;
  return tex;
}

function hotDisc() {
  if (!_hotDisc) {
    _hotDisc = _gradientTexture([
      [0.00, 'rgba(255,255,255,1.0)'],
      [0.30, 'rgba(255,255,255,0.85)'],
      [0.65, 'rgba(255,255,255,0.30)'],
      [1.00, 'rgba(255,255,255,0.0)'],
    ]);
  }
  return _hotDisc;
}

function smokePuff() {
  if (!_smokePuff) {
    _smokePuff = _gradientTexture([
      [0.00, 'rgba(255,255,255,0.85)'],
      [0.45, 'rgba(255,255,255,0.55)'],
      [0.85, 'rgba(255,255,255,0.10)'],
      [1.00, 'rgba(255,255,255,0.0)'],
    ]);
  }
  return _smokePuff;
}

// Combat effects driven by fire events. Each event spawns a persistent
// effect group whose visibility/animation is keyed off scenario time, so
// scrubbing forward/backward replays effects deterministically.
//
// Phases per event (scenario seconds, t = event firing time):
//   muzzle flash:     [t,        t + 0.15)
//   tracer in flight: [t,        t + FLIGHT)
//   hit flash:        [t+FLIGHT, t+FLIGHT + 0.2)
//   fireball core:    [t+FLIGHT, t+FLIGHT + BOOM)
//   shockwave ring:   [t+FLIGHT, t+FLIGHT + SHOCK)
//   flames cluster:   [t+FLIGHT, t+FLIGHT + FLAME)
//   debris (chunks):  [t+FLIGHT, t+FLIGHT + DEBRIS)
//   smoke rising:     [t+FLIGHT, t+FLIGHT + SMOKE)

const FLIGHT = 0.4;
const BOOM   = 0.7;
const SHOCK  = 0.55;
const FLAME  = 1.6;
const DEBRIS = 2.2;
const SMOKE  = 4.0;
const TOTAL_LIFE = FLIGHT + Math.max(BOOM, SHOCK, FLAME, DEBRIS, SMOKE);
const GRAVITY = 22; // m/s^2 (tuned for arcade feel, not realism)

const MUZZLE_OFFSET = {
  tank:      { fwd: 3.35, up: 1.5 },
  artillery: { fwd: 2.2,  up: 1.2 },
  drone:     { fwd: 0.5,  up: 0.0 },
  infantry:  { fwd: 0.6,  up: 1.0 },
};
const HIT_Y = { drone: 0.5, tank: 1.0, artillery: 0.8, infantry: 1.0 };

// How "loud" each weapon's impact is. Scales debris/flame/shock counts and sizes.
const CALIBER = { artillery: 1.25, tank: 1.0, drone: 0.55, infantry: 0.45 };

// First time on the track where alive flips to false. Returns null if the unit
// survives the scenario.
function findDeathTime(track) {
  for (const kf of track) if (!kf.alive) return kf.t;
  return null;
}

// Last keyframe while the unit was still alive — we use its (x, z, yaw) as
// the resting place for the wreck.
function findLastAliveKeyframe(track) {
  let last = track[0];
  for (const kf of track) {
    if (!kf.alive) break;
    last = kf;
  }
  return last;
}

function samplePosition(track, t) {
  let lo = 0;
  while (lo < track.length - 2 && track[lo + 1].t <= t) lo++;
  const a = track[lo], b = track[Math.min(lo + 1, track.length - 1)];
  if (b.t <= a.t) return new THREE.Vector3(a.x, a.y, a.z);
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return new THREE.Vector3(
    a.x + (b.x - a.x) * u,
    a.y + (b.y - a.y) * u,
    a.z + (b.z - a.z) * u,
  );
}

function sampleYaw(track, t) {
  let lo = 0;
  while (lo < track.length - 2 && track[lo + 1].t <= t) lo++;
  const a = track[lo], b = track[Math.min(lo + 1, track.length - 1)];
  if (b.t <= a.t) return a.yaw;
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return a.yaw + (b.yaw - a.yaw) * u;
}

class FireEffect {
  constructor(event, agentsById, sampleHeight) {
    this.event = event;
    this.agentsById = agentsById;
    this.sampleHeight = sampleHeight ?? (() => 0);
    this.group = new THREE.Group();
    this.group.visible = false;

    const shooter = agentsById.get(event.shooter);
    this.caliber = CALIBER[shooter?.spec.type] ?? 0.7;
    const cal = this.caliber;

    const additive = (color) => new THREE.SpriteMaterial({
      map: hotDisc(),
      color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });

    // ---- Muzzle / tracer / hit flash / fireball core (existing layers) ----
    this.muzzle = new THREE.Sprite(additive(0xffe28a));
    this.muzzle.scale.set(2.5, 2.5, 1);
    this.group.add(this.muzzle);

    this.tracer = new THREE.Sprite(additive(0xfff3a8));
    this.tracer.scale.set(0.7, 0.7, 1);
    this.group.add(this.tracer);

    this.hitFlash = new THREE.Sprite(additive(0xfff0a0));
    this.hitFlash.scale.set(6, 6, 1);
    this.group.add(this.hitFlash);

    this.boom = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff7a30, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(this.boom);

    // ---- Shockwave ring on ground ----
    this.shock = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.95, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffd28a, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    );
    this.shock.rotation.x = -Math.PI / 2;
    this.group.add(this.shock);

    // ---- Flame cluster (additive sprites flickering at impact) ----
    const flameCount = Math.max(3, Math.round(5 * cal));
    this.flames = [];
    for (let i = 0; i < flameCount; i++) {
      // Mix bright core flames with deeper orange tongues for color depth.
      const isCore = i < Math.ceil(flameCount * 0.4);
      const color = isCore ? 0xffe28a : 0xff6a20;
      const s = new THREE.Sprite(additive(color));
      s.userData = {
        offX: (Math.random() - 0.5) * 1.6 * cal,
        offZ: (Math.random() - 0.5) * 1.6 * cal,
        rise: 1.0 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random() * 0.18,
        baseScale: (isCore ? 2.6 : 3.4) * cal,
        isCore,
      };
      this.flames.push(s);
      this.group.add(s);
    }

    // ---- Debris: dark chunks + glowing embers ----
    const chunkCount = Math.max(2, Math.round(6 * cal));
    const emberCount = Math.max(2, Math.round(5 * cal));
    this.debris = [];

    const makePiece = (isEmber) => {
      // Hemispherical launch direction, biased upward, gravity pulls back down.
      const az = Math.random() * Math.PI * 2;
      const el = (0.18 + Math.random() * 0.55) * Math.PI * 0.5; // 0.28..1.15 rad
      const dir = new THREE.Vector3(
        Math.cos(az) * Math.cos(el),
        Math.sin(el),
        Math.sin(az) * Math.cos(el),
      );
      const speed = (4 + Math.random() * 8) * (0.7 + cal * 0.5);
      const piece = { dir, speed, isEmber };

      if (isEmber) {
        const m = new THREE.Sprite(additive(Math.random() < 0.5 ? 0xffb060 : 0xff7028));
        const sz = (0.25 + Math.random() * 0.25) * cal;
        m.scale.set(sz, sz, 1);
        piece.mesh = m;
        piece.size = sz;
      } else {
        const sz = (0.18 + Math.random() * 0.22) * cal;
        const tone = 0x261a10 + Math.floor(Math.random() * 0x10) * 0x010101;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(sz, sz * (0.6 + Math.random() * 0.6), sz),
          new THREE.MeshBasicMaterial({ color: tone, transparent: true }),
        );
        piece.mesh = m;
        piece.size = sz;
        piece.spinAxis = new THREE.Vector3(
          Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
        ).normalize();
        piece.spinSpeed = (Math.random() - 0.5) * 14;
      }
      return piece;
    };

    for (let i = 0; i < chunkCount; i++) this.debris.push(makePiece(false));
    for (let i = 0; i < emberCount; i++) this.debris.push(makePiece(true));
    for (const d of this.debris) this.group.add(d.mesh);

    // ---- Smoke (existing, slightly enlarged) ----
    this.smokes = [];
    const smokeCount = Math.max(2, Math.round(3 * (0.6 + cal * 0.6)));
    for (let i = 0; i < smokeCount; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokePuff(),
        color: 0x222222, transparent: true, depthWrite: false, opacity: 0.7,
      }));
      s.scale.set(2, 2, 1);
      s.userData = {
        offX: (i - (smokeCount - 1) / 2) * 0.7,
        offZ: (Math.random() - 0.5) * 0.8,
        delay: i * 0.4,
      };
      this.smokes.push(s);
      this.group.add(s);
    }

    // resolved on first activation
    this._resolved = false;
    this._muzzlePos = new THREE.Vector3();
    this._hitPos = new THREE.Vector3();
    // Sound trigger latches: each cue plays at most once per scenario pass.
    // Reset by EffectsManager when the scenario is scrubbed backward past t.
    this._playedMuzzle = false;
    this._playedImpact = false;
  }

  resetSoundLatches() {
    this._playedMuzzle = false;
    this._playedImpact = false;
  }

  _resolveAnchors() {
    const e = this.event;
    const shooter = this.agentsById.get(e.shooter);
    const target = this.agentsById.get(e.target);
    if (!shooter || !target) return false;

    const sPos = samplePosition(shooter.spec.track, e.t);
    const off = MUZZLE_OFFSET[shooter.spec.type] ?? MUZZLE_OFFSET.infantry;

    const tPos = samplePosition(target.spec.track, e.t + FLIGHT);

    // Every shooter is visually aimed at the target during the fire window
    // (tanks/artillery swing their turret; infantry/AT/drones swing their
    // whole body — see applyFrame in main.js). The muzzle has to leave from
    // wherever the weapon is now pointing, so derive the firing yaw from the
    // bearing-to-impact rather than the hull/body heading.
    const fireYaw = Math.atan2(tPos.x - sPos.x, tPos.z - sPos.z);
    const mx = sPos.x + Math.sin(fireYaw) * off.fwd;
    const mz = sPos.z + Math.cos(fireYaw) * off.fwd;
    this._muzzlePos.set(mx, this.sampleHeight(mx, mz) + sPos.y + off.up, mz);

    const dy = HIT_Y[target.spec.type] ?? 1.0;
    this._hitPos.set(tPos.x, this.sampleHeight(tPos.x, tPos.z) + tPos.y + dy, tPos.z);

    this._resolved = true;
    return true;
  }

  update(t, audioCtx) {
    const local = t - this.event.t;
    if (local < 0 || local > TOTAL_LIFE) {
      this.group.visible = false;
      return;
    }
    if (!this._resolved && !this._resolveAnchors()) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const cal = this.caliber;

    // Sound triggers — fire each cue once when local time first enters its
    // window. audioCtx.allow is false while the user is scrubbing the
    // timeline (huge jumps would otherwise dump every event at once).
    if (audioCtx && audioCtx.allow) {
      const type = audioCtx.shooterType(this.event.shooter);
      if (!this._playedMuzzle && local >= 0 && local < 0.25) {
        playMuzzle(type, this._muzzlePos, audioCtx.camera);
        this._playedMuzzle = true;
      }
      if (!this._playedImpact && local >= FLIGHT && local < FLIGHT + 0.25) {
        playImpact(type, this._hitPos, audioCtx.camera);
        this._playedImpact = true;
      }
    }

    // Muzzle flash
    if (local < 0.15) {
      const u = local / 0.15;
      this.muzzle.position.copy(this._muzzlePos);
      this.muzzle.material.opacity = 1 - u;
      const sc = (3.0 - u * 1.5) * (0.7 + cal * 0.5);
      this.muzzle.scale.set(sc, sc, 1);
      this.muzzle.visible = true;
    } else this.muzzle.visible = false;

    // Tracer in flight
    if (local < FLIGHT) {
      const u = local / FLIGHT;
      this.tracer.position.lerpVectors(this._muzzlePos, this._hitPos, u);
      this.tracer.visible = true;
    } else this.tracer.visible = false;

    const il = local - FLIGHT; // time-since-impact

    // Hit flash (brief bright pop right at impact)
    if (il >= 0 && il < 0.2) {
      const fu = il / 0.2;
      this.hitFlash.position.copy(this._hitPos);
      this.hitFlash.material.opacity = 1 - fu;
      const sc = (7 - fu * 3) * (0.7 + cal * 0.5);
      this.hitFlash.scale.set(sc, sc, 1);
      this.hitFlash.visible = true;
    } else this.hitFlash.visible = false;

    // Fireball core (expanding additive sphere)
    if (il >= 0 && il < BOOM) {
      const u = il / BOOM;
      this.boom.position.copy(this._hitPos);
      const r = (0.5 + u * 2.5) * (0.8 + cal * 0.4);
      this.boom.scale.set(r, r, r);
      this.boom.material.opacity = 1 - u;
      this.boom.visible = true;
    } else this.boom.visible = false;

    // Shockwave ring along ground
    if (il >= 0 && il < SHOCK) {
      const u = il / SHOCK;
      const r = (0.5 + u * 7.5) * (0.7 + cal * 0.6);
      this.shock.position.set(this._hitPos.x, 0.06, this._hitPos.z);
      this.shock.scale.set(r, r, r);
      this.shock.material.opacity = (1 - u) * 0.85;
      this.shock.visible = true;
    } else this.shock.visible = false;

    // Flame cluster — flickering fire that drifts up and fades
    if (il >= 0 && il < FLAME + 0.2) {
      for (const f of this.flames) {
        const lt = il - f.userData.delay;
        if (lt < 0 || lt > FLAME) { f.visible = false; continue; }
        const u = lt / FLAME;
        const flicker = 0.78 + 0.22 * Math.sin(f.userData.phase + lt * 28);
        const sc = f.userData.baseScale * (1.05 - u * 0.55) * flicker;
        f.scale.set(sc, sc, 1);
        f.position.set(
          this._hitPos.x + f.userData.offX * (1 - u * 0.3),
          this._hitPos.y + 0.4 + u * f.userData.rise,
          this._hitPos.z + f.userData.offZ * (1 - u * 0.3),
        );
        // Cores stay punchier; outer tongues fade quicker
        const fade = f.userData.isCore ? (1 - u) : Math.max(0, 1 - u * 1.2);
        f.material.opacity = fade * 0.95 * flicker;
        f.visible = true;
      }
    } else {
      for (const f of this.flames) f.visible = false;
    }

    // Debris — ballistic chunks + glowing embers, deterministic in `il`
    if (il >= 0 && il < DEBRIS) {
      for (const d of this.debris) {
        // Lazy: solve landing time once anchors are known (depends on _hitPos.y).
        if (d._landTime === undefined) {
          const vy = d.dir.y * d.speed;
          const dy0 = this._hitPos.y - d.size * 0.5;
          const disc = vy * vy + 2 * GRAVITY * dy0;
          d._landTime = disc < 0 ? Infinity : (vy + Math.sqrt(disc)) / GRAVITY;
        }
        const tt = Math.min(il, d._landTime); // freeze on ground
        const py = Math.max(
          d.size * 0.5,
          this._hitPos.y + d.dir.y * d.speed * tt - 0.5 * GRAVITY * tt * tt,
        );
        const px = this._hitPos.x + d.dir.x * d.speed * tt;
        const pz = this._hitPos.z + d.dir.z * d.speed * tt;
        d.mesh.position.set(px, py, pz);

        if (!d.isEmber) {
          const ang = d.spinSpeed * tt;
          d.mesh.rotation.set(d.spinAxis.x * ang, d.spinAxis.y * ang, d.spinAxis.z * ang);
        }
        const u = tt / DEBRIS;
        // Embers fade faster (they "burn out"); chunks linger then fade.
        const fade = d.isEmber
          ? Math.max(0, 1 - u * 1.4)
          : (u < 0.6 ? 1.0 : Math.max(0, 1 - (u - 0.6) / 0.4));
        d.mesh.material.opacity = fade;
        d.mesh.material.transparent = true;
        d.mesh.visible = fade > 0.01;
      }
    } else {
      for (const d of this.debris) d.mesh.visible = false;
    }

    // Smoke rising
    if (il >= 0 && il < SMOKE) {
      for (let i = 0; i < this.smokes.length; i++) {
        const s = this.smokes[i];
        const sli = il - s.userData.delay;
        if (sli < 0 || sli > SMOKE) { s.visible = false; continue; }
        const u = sli / SMOKE;
        s.position.set(
          this._hitPos.x + s.userData.offX,
          this._hitPos.y + 0.5 + u * 4.5,
          this._hitPos.z + s.userData.offZ,
        );
        s.material.opacity = 0.65 * (1 - u);
        const sc = (1.8 + u * 3.4) * (0.8 + cal * 0.4);
        s.scale.set(sc, sc, 1);
        s.visible = true;
      }
    } else {
      for (const s of this.smokes) s.visible = false;
    }
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse(o => {
      if (o.material) o.material.dispose?.();
      if (o.geometry) o.geometry.dispose?.();
    });
  }
}

// ---- Persistent wreckage + ongoing fire after a unit dies ----
//
// One WreckageEffect per agent that dies in the scenario. After deathTime,
// its visibility/animation is purely a function of (t - deathTime), so
// scrubbing the timeline replays consistently. Charred hull stays put;
// flames are bright at first then taper into a long smoulder; smoke
// continues drifting up much longer than the flames.

// Per-type fire/smoke intensity. The wreck body itself is just the live unit
// shape, charred — see WreckageEffect constructor. `tip` rolls the body onto
// its side; only infantry tips (vehicle wrecks just blacken in place so the
// silhouette stays recognizable).
const WRECK_SPECS = {
  tank:      { flameCount: 5, smokeCount: 4, intensity: 1.0,  extent: 1.5, tip: false },
  artillery: { flameCount: 4, smokeCount: 3, intensity: 0.85, extent: 1.2, tip: false },
  drone:     { flameCount: 2, smokeCount: 1, intensity: 0.45, extent: 0.6, tip: false },
  infantry:  { flameCount: 0, smokeCount: 0, intensity: 0.0,  extent: 0.4, tip: true  },
};

class WreckageEffect {
  constructor(spec, deathTime, sampleHeight) {
    this.spec = spec;
    this.deathTime = deathTime;
    this.sampleHeight = sampleHeight ?? (() => 0);
    const w = WRECK_SPECS[spec.type] ?? WRECK_SPECS.infantry;
    this.w = w;

    this.group = new THREE.Group();
    this.group.visible = false;

    // ---- Charred body: real unit shape, single dark material, tipped over ----
    // Re-create the live unit mesh, swap every Mesh's material to one shared
    // charred standard material, then rotate ~90° around Z so it lies on its
    // side. Box3.setFromObject after rotation tells us how far below origin
    // the new lowest point is, so we lift it back to ground level.
    const body = createUnit(spec.type, spec.team);
    this.charMat = new THREE.MeshStandardMaterial({
      color: 0x0a0807, roughness: 1.0, metalness: 0.05,
      emissive: 0x331100,
      emissiveIntensity: w.intensity > 0 ? 0.4 : 0.0,
    });

    // Free the original per-mesh materials before we orphan them.
    const origMats = new Set();
    body.traverse(o => {
      if (o.isMesh) {
        if (o.material) origMats.add(o.material);
        o.material = this.charMat;
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    for (const m of origMats) m.dispose?.();

    // Tip on side: 90° around Z with small jitter, plus a bit of pitch.
    // Vehicles/drones keep their upright silhouette — they just blacken in place.
    if (w.tip) {
      const side = Math.random() < 0.5 ? 1 : -1;
      body.rotation.z = side * (Math.PI / 2 + (Math.random() - 0.5) * 0.18);
      body.rotation.x = (Math.random() - 0.5) * 0.25;
    }

    const bbox = new THREE.Box3().setFromObject(body);
    body.position.y = -bbox.min.y; // lowest point sits at y=0 (drone falls down too)
    this.body = body;
    this.bodyTopY = bbox.max.y - bbox.min.y;
    this.group.add(body);

    // ---- Persistent flames ----
    this.flames = [];
    for (let i = 0; i < w.flameCount; i++) {
      const isCore = i < Math.ceil(w.flameCount * 0.4);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: hotDisc(),
        color: isCore ? 0xffe28a : 0xff6020,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      s.userData = {
        offX: (Math.random() - 0.5) * w.extent * 1.6,
        offZ: (Math.random() - 0.5) * w.extent * 1.6,
        offY: this.bodyTopY * 0.55 + 0.25 + Math.random() * 0.4,
        baseScale: isCore ? 1.5 : 2.1,
        phase: Math.random() * Math.PI * 2,
        freq: 18 + Math.random() * 14,
        cyclePeriod: 4.5 + Math.random() * 3,
        cycleOff: Math.random() * 5,
        isCore,
      };
      this.flames.push(s);
      this.group.add(s);
    }

    // ---- Persistent smoke column ----
    this.smokes = [];
    for (let i = 0; i < w.smokeCount; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokePuff(),
        color: 0x1a1a1a, transparent: true, depthWrite: false, opacity: 0.55,
      }));
      s.userData = {
        offX: (Math.random() - 0.5) * w.extent,
        offZ: (Math.random() - 0.5) * w.extent,
        startY: this.bodyTopY + 0.2,
        period: 6 + Math.random() * 2,
        phase: i * (6 / Math.max(1, w.smokeCount)),
        baseScale: 2.0 + Math.random() * 0.8,
        driftX: (Math.random() - 0.5) * 0.5,
      };
      this.smokes.push(s);
      this.group.add(s);
    }

    this._resolved = false;
  }

  _resolveAnchor() {
    // For ground/tank/artillery the last keyframe (death keyframe) is also
    // the resting place. For drones the track ends with the post-fall
    // ground position, so the very last keyframe is what we want too.
    const tr = this.spec.track;
    const rest = tr[tr.length - 1];
    this.group.position.set(rest.x, this.sampleHeight(rest.x, rest.z), rest.z);
    this.group.rotation.y = rest.yaw ?? 0;
    this._resolved = true;
  }

  update(t) {
    const local = t - this.deathTime;
    if (local < 0) {
      this.group.visible = false;
      return;
    }
    if (!this._resolved) this._resolveAnchor();
    this.group.visible = true;

    if (this.w.intensity <= 0) return; // infantry: hull only, no fire/smoke

    // Flame intensity decays from peak quickly, then smoulders. exp(-t/12)
    // gives ~0.43 at 10s, ~0.19 at 20s; floor of 0.15 keeps embers alive.
    const flameI = this.w.intensity * (0.15 + 0.85 * Math.exp(-local / 12));

    for (const f of this.flames) {
      const flicker = 0.7 + 0.3 * Math.sin(f.userData.phase + local * f.userData.freq);
      const pc = ((local + f.userData.cycleOff) % f.userData.cyclePeriod) / f.userData.cyclePeriod;
      const puff = 0.7 + 0.3 * Math.sin(pc * Math.PI * 2);
      const sc = f.userData.baseScale * flameI * flicker * puff;
      f.scale.set(sc, sc, 1);
      f.position.set(
        f.userData.offX,
        f.userData.offY + flameI * 0.3,
        f.userData.offZ,
      );
      f.material.opacity = flameI * flicker * puff * 0.95;
      f.visible = f.material.opacity > 0.03;
    }

    // Smoke decays slower than flame — wreck still smokes long after fire dies.
    const smokeI = this.w.intensity * (0.35 + 0.65 * Math.exp(-local / 35));
    for (const s of this.smokes) {
      const u = ((local + s.userData.phase) % s.userData.period) / s.userData.period;
      s.position.set(
        s.userData.offX + s.userData.driftX * u * 2,
        s.userData.startY + u * 6.5,
        s.userData.offZ,
      );
      const sc = s.userData.baseScale * (1 + u * 1.6);
      s.scale.set(sc, sc, 1);
      // Triangular fade-in/hold/fade-out per puff
      let alpha;
      if (u < 0.15) alpha = u / 0.15;
      else if (u > 0.7) alpha = (1 - u) / 0.3;
      else alpha = 1;
      s.material.opacity = 0.55 * alpha * smokeI;
      s.visible = s.material.opacity > 0.02;
    }
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    const seenMat = new Set();
    const seenGeo = new Set();
    this.group.traverse(o => {
      if (o.material && !seenMat.has(o.material)) {
        seenMat.add(o.material);
        o.material.dispose?.();
      }
      if (o.geometry && !seenGeo.has(o.geometry)) {
        seenGeo.add(o.geometry);
        o.geometry.dispose?.();
      }
    });
  }
}

// ---- Incapacitated state: lighter than wreckage, parented to the live mesh ----
//
// When a unit is `incapacitated` it's still visibly on the field but
// damaged. We layer a faint smoke wisp (and a small flame for vehicles)
// onto the mesh; main.js toggles visibility per frame based on the
// agent's current status. Animation phase is driven by absolute scenario
// time so scrubbing stays deterministic.
const DAMAGE_SPECS = {
  tank:         { flameCount: 1, smokeCount: 2, extent: 1.0, topY: 1.8 },
  artillery:    { flameCount: 1, smokeCount: 2, extent: 1.1, topY: 1.8 },
  drone:        { flameCount: 1, smokeCount: 1, extent: 0.35, topY: 0.1 },
  antitank:     { flameCount: 0, smokeCount: 1, extent: 0.4, topY: 1.6 },
  infantry:     { flameCount: 0, smokeCount: 1, extent: 0.35, topY: 1.5 },
  command_post: { flameCount: 1, smokeCount: 2, extent: 1.4, topY: 2.0 },
};

export function attachDamageEffect(hostMesh, type) {
  const d = DAMAGE_SPECS[type] ?? DAMAGE_SPECS.infantry;
  const group = new THREE.Group();
  group.visible = false;
  hostMesh.add(group);

  const flames = [];
  for (let i = 0; i < d.flameCount; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: hotDisc(), color: 0xff8030,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    s.userData = {
      offX: (Math.random() - 0.5) * d.extent,
      offZ: (Math.random() - 0.5) * d.extent,
      offY: d.topY * 0.6,
      baseScale: 0.7 + Math.random() * 0.2,
      phase: Math.random() * Math.PI * 2,
      freq: 14 + Math.random() * 10,
    };
    flames.push(s);
    group.add(s);
  }

  const smokes = [];
  for (let i = 0; i < d.smokeCount; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: smokePuff(), color: 0x252525, transparent: true, depthWrite: false, opacity: 0.4,
    }));
    s.userData = {
      offX: (Math.random() - 0.5) * d.extent * 0.7,
      offZ: (Math.random() - 0.5) * d.extent * 0.7,
      startY: d.topY,
      period: 4 + Math.random() * 1.5,
      phase: i * 1.7 + Math.random() * 0.8,
      baseScale: 1.0 + Math.random() * 0.3,
    };
    smokes.push(s);
    group.add(s);
  }

  return {
    setVisible(v) { group.visible = !!v; },
    update(t) {
      if (!group.visible) return;
      for (const f of flames) {
        const flicker = 0.7 + 0.3 * Math.sin(f.userData.phase + t * f.userData.freq);
        const sc = f.userData.baseScale * flicker;
        f.scale.set(sc, sc, 1);
        f.position.set(f.userData.offX, f.userData.offY, f.userData.offZ);
        f.material.opacity = 0.85 * flicker;
      }
      for (const s of smokes) {
        const u = ((t + s.userData.phase) % s.userData.period) / s.userData.period;
        s.position.set(s.userData.offX, s.userData.startY + u * 2.6, s.userData.offZ);
        const sc = s.userData.baseScale * (0.7 + u * 1.2);
        s.scale.set(sc, sc, 1);
        s.material.opacity = 0.45 * (1 - u);
      }
    },
  };
}

// ---- Status ring on the ground ----
//
// A flat annulus painted under the unit's footprint that signals its
// state at a glance: yellow when incapacitated, team color after the
// unit is destroyed. The ring lives in world space (not parented to
// the mesh) so it can stay at the death position after the live mesh
// is hidden.
const RING_RADII = {
  infantry:     { outer: 0.85, inner: 0.66 },
  antitank:     { outer: 0.85, inner: 0.66 },
  tank:         { outer: 3.2,  inner: 2.55 },
  artillery:    { outer: 3.8,  inner: 3.05 },
  drone:        { outer: 1.3,  inner: 1.02 },
  command_post: { outer: 3.6,  inner: 2.85 },
};

export function createStatusRing(type) {
  const r = RING_RADII[type] ?? RING_RADII.infantry;
  const geo = new THREE.RingGeometry(r.inner, r.outer, 48, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2; // lay flat on XZ
  mesh.visible = false;
  return mesh;
}

export class EffectsManager {
  constructor({ scene, agentsById, sampleHeight = () => 0, camera = null }) {
    this.scene = scene;
    this.agentsById = agentsById;
    this.sampleHeight = sampleHeight;
    this.camera = camera;
    this.fireEffects = [];
    this.wreckages = [];
    this._prevT = null;
  }

  setEvents(events) {
    for (const fx of this.fireEffects) fx.dispose();
    this.fireEffects = events.map(e => new FireEffect(e, this.agentsById, this.sampleHeight));
    for (const fx of this.fireEffects) this.scene.add(fx.group);
  }

  setAgents(agents) {
    for (const w of this.wreckages) w.dispose();
    this.wreckages = [];
    for (const ag of agents) {
      const dt = findDeathTime(ag.spec.track);
      if (dt === null) continue;
      const w = new WreckageEffect(ag.spec, dt, this.sampleHeight);
      this.wreckages.push(w);
      this.scene.add(w.group);
    }
  }

  update(t) {
    // Detect timeline jumps: only allow audio cues during normal forward
    // playback. Backward jumps reset the per-event sound latches so cues
    // can play again on re-pass.
    let allow = true;
    if (this._prevT === null) {
      allow = false; // skip very first frame
    } else if (t < this._prevT) {
      allow = false;
      for (const fx of this.fireEffects) fx.resetSoundLatches();
    } else if (t - this._prevT > 0.25) {
      allow = false; // scrub-forward jump
    }
    this._prevT = t;

    const audioCtx = {
      allow,
      camera: this.camera,
      shooterType: (id) => this.agentsById.get(id)?.spec?.type ?? 'infantry',
    };

    for (const fx of this.fireEffects) fx.update(t, audioCtx);
    for (const w of this.wreckages) w.update(t);
  }
}
