import * as THREE from 'three';

// Director that drives the camera from a timestamp-keyed shot schedule.
//
// Shot schema:
//   { t: number, mode: 'follow' | 'pov' | 'orbit' | 'static' | 'free',
//     agent?: string, offset?: [x,y,z], distance?: number, height?: number, speed?: number,
//     position?: [x,y,z], target?: [x,y,z], back?: number, up?: number, look?: number }
//
// `static` is agent-less and parks the camera at `position` looking at
// `target` — handy for overhead map views, fixed landmarks, etc.
//
// `pov` is a third-person chase view: the camera sits `back` metres behind
// and `up` metres above the agent so the unit is visible in the foreground,
// pointed `look` metres ahead along the agent's heading. Defaults work for
// drones; tweak per-shot for other unit scales.
//
// Transitions between shots blend in real time (not scenario time) so they
// feel cinematic regardless of playback speed. User pointer/wheel input on
// the canvas drops the director out of cinematic mode and hands the camera
// back to OrbitControls.

const TRANSITION_REAL_SECONDS = 1.0;

const smoothstep = u => u * u * (3 - 2 * u);

export class CinematicDirector {
  constructor({ camera, controls, agentsById, domElement }) {
    this.camera = camera;
    this.controls = controls;
    this.agentsById = agentsById;
    this.shots = [];
    this.enabled = false;
    this.currentShot = null;
    this._transStartReal = null;
    this._fromPos = new THREE.Vector3();
    this._fromTarget = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._desiredTarget = new THREE.Vector3();
    this.onShotChange = null;

    // Capture-phase pointer/wheel handler runs before OrbitControls' bubble
    // handler — so we can flip enabled=true synchronously and let the same
    // gesture continue into a real drag.
    const handover = () => {
      if (this.shouldOverride(this._lastT ?? 0)) {
        this.setEnabled(false);
        this.controls.enabled = true;
      }
    };
    domElement.addEventListener('pointerdown', handover, true);
    domElement.addEventListener('wheel', handover, { capture: true, passive: true });
  }

  setShots(shots) {
    this.shots = [...shots].sort((a, b) => a.t - b.t);
    this.currentShot = null; // re-evaluate on next update
  }

  setEnabled(v) {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) {
      this.currentShot = null;
      if (this.onShotChange) this.onShotChange(null);
    } else {
      // Force re-pick of current shot and a fresh transition.
      this.currentShot = null;
      this._transStartReal = null;
    }
  }

  findShot(t) {
    let active = null;
    for (const s of this.shots) {
      if (s.t <= t) active = s;
      else break;
    }
    return active;
  }

  shouldOverride(t) {
    if (!this.enabled) return false;
    const s = this.findShot(t);
    return !!(s && s.mode !== 'free');
  }

  _computeDesired(shot, t, outPos, outTarget) {
    if (shot.mode === 'static') {
      const p = shot.position, tg = shot.target;
      if (!p || !tg) return false;
      outPos.set(p[0], p[1], p[2]);
      outTarget.set(tg[0], tg[1], tg[2]);
      return true;
    }

    const agent = shot.agent ? this.agentsById.get(shot.agent) : null;
    if (!agent || !agent.mesh) return false;

    const ap = agent.mesh.position;
    const ay = agent.mesh.rotation.y;
    const sin = Math.sin(ay), cos = Math.cos(ay);

    if (shot.mode === 'follow') {
      const off = shot.offset || [0, 4, -10];
      // rotate local-frame offset by agent yaw (yaw=0 → local +Z is world +Z)
      const rx = off[0] * cos + off[2] * sin;
      const rz = -off[0] * sin + off[2] * cos;
      outPos.set(ap.x + rx, ap.y + off[1], ap.z + rz);
      outTarget.set(ap.x, ap.y + 1.5, ap.z);
      return true;
    }
    if (shot.mode === 'pov') {
      // Third-person chase: camera behind+above the agent so the unit reads
      // in the foreground, looking forward along the agent's heading.
      const back = shot.back ?? 7;
      const up   = shot.up   ?? 2.2;
      const look = shot.look ?? 50;
      outPos.set(ap.x - sin * back, ap.y + up, ap.z - cos * back);
      outTarget.set(ap.x + sin * look, ap.y + up * 0.4, ap.z + cos * look);
      return true;
    }
    if (shot.mode === 'orbit') {
      const dist = shot.distance ?? 12;
      const h = shot.height ?? 5;
      const spd = shot.speed ?? 0.35;
      const phase = (shot.phase ?? 0) + (t - shot.t) * spd;
      outPos.set(ap.x + Math.cos(phase) * dist, ap.y + h, ap.z + Math.sin(phase) * dist);
      outTarget.set(ap.x, ap.y + 1, ap.z);
      return true;
    }
    return false;
  }

  update(t) {
    this._lastT = t;
    if (!this.enabled) return;

    const shot = this.findShot(t);
    if (!shot) return;

    if (shot !== this.currentShot) {
      this._fromPos.copy(this.camera.position);
      this._fromTarget.copy(this.controls.target);
      this._transStartReal = performance.now() / 1000;
      this.currentShot = shot;
      if (this.onShotChange) this.onShotChange(shot);
    }

    if (shot.mode === 'free') return;

    if (!this._computeDesired(shot, t, this._desiredPos, this._desiredTarget)) return;

    const elapsed = performance.now() / 1000 - (this._transStartReal ?? performance.now() / 1000);
    const u = Math.min(1, elapsed / TRANSITION_REAL_SECONDS);
    const eased = smoothstep(u);

    if (u < 1) {
      this.camera.position.lerpVectors(this._fromPos, this._desiredPos, eased);
      this.controls.target.lerpVectors(this._fromTarget, this._desiredTarget, eased);
    } else {
      this.camera.position.copy(this._desiredPos);
      this.controls.target.copy(this._desiredTarget);
    }
    this.camera.lookAt(this.controls.target);
  }
}

export async function loadCameraSchedule(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json();
}
