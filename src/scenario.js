// Dummy battlefield scenario generator.
// Produces a timeline of agent trajectories that can be played back
// by interpolating between keyframes. Replace this with real CSV/JSON
// in production — the timeline schema is stable.
//
// Schema:
//   { duration, bounds, agents: [{ id, team, type, track: [{ t, x, y, z, yaw, alive }] }] }

// Tiny seeded PRNG so the demo replays the same battle every time.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// Build a track that walks from (x0,z0) to (x1,z1) over [t0,t1], then idles, then optionally dies at tDeath.
function marchTrack({ x0, z0, x1, z1, t0, t1, duration, yawFacing, tDeath = null, jitter = 0, rng = Math.random }) {
  const track = [];
  // start
  track.push({ t: 0, x: x0, y: 0, z: z0, yaw: yawFacing, alive: true });
  if (t0 > 0) track.push({ t: t0, x: x0, y: 0, z: z0, yaw: yawFacing, alive: true });

  // marching segment with mild zigzag
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const t = lerp(t0, t1, u);
    const wob = jitter ? (rng() - 0.5) * jitter : 0;
    track.push({
      t,
      x: lerp(x0, x1, u) + wob,
      y: 0,
      z: lerp(z0, z1, u),
      yaw: yawFacing,
      alive: true,
    });
  }

  // idle/hold position to end (or until death)
  const tEnd = tDeath ?? duration;
  if (tEnd > t1) {
    track.push({ t: tEnd - 0.001, x: x1, y: 0, z: z1, yaw: yawFacing, alive: true });
  }
  if (tDeath !== null && tDeath <= duration) {
    track.push({ t: tDeath, x: x1, y: 0, z: z1, yaw: yawFacing, alive: false });
    track.push({ t: duration, x: x1, y: 0, z: z1, yaw: yawFacing, alive: false });
  } else {
    track.push({ t: duration, x: x1, y: 0, z: z1, yaw: yawFacing, alive: true });
  }
  return track;
}

// Trench occupant: starts at the trench centerline. The DEM dips at trench
// locations so world Y at (startX, startZ) is several meters below the
// surrounding ground — the soldier is hidden inside the cut. At tEmerge they
// walk forward over the parapet (clearing the trench half-width plus rim) and
// the heightmap naturally raises their world Y back to surface level — that
// transition IS the climb-out visual. Then they march to a destination.
function trenchMarchTrack({
  startX, startZ, destX, destZ,
  tEmerge, tArrive, duration, yawFacing,
  tDeath = null, jitter = 0, rng = Math.random,
}) {
  const track = [];
  const fwdX = Math.sin(yawFacing), fwdZ = Math.cos(yawFacing);
  // ~1.4m forward clears trench half-width (0.8) + ramp (0.6).
  const lipX = startX + fwdX * 1.4;
  const lipZ = startZ + fwdZ * 1.4;

  // Wait crouched in the trench (DEM dip handles the visual hiding).
  track.push({ t: 0,       x: startX, y: 0, z: startZ, yaw: yawFacing, alive: true });
  track.push({ t: tEmerge, x: startX, y: 0, z: startZ, yaw: yawFacing, alive: true });
  // Climb out over 1.5s — walking forward up the trench wall slope.
  track.push({ t: tEmerge + 1.5, x: lipX, y: 0, z: lipZ, yaw: yawFacing, alive: true });
  // Brief pause at the lip
  track.push({ t: tEmerge + 2.0, x: lipX, y: 0, z: lipZ, yaw: yawFacing, alive: true });

  // March to destination
  const tStart = tEmerge + 2.0;
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const t = lerp(tStart, tArrive, u);
    const wob = jitter ? (rng() - 0.5) * jitter : 0;
    track.push({
      t,
      x: lerp(lipX, destX, u) + wob,
      y: 0,
      z: lerp(lipZ, destZ, u),
      yaw: yawFacing, alive: true,
    });
  }

  const tEnd = tDeath ?? duration;
  if (tEnd > tArrive) {
    track.push({ t: tEnd - 0.001, x: destX, y: 0, z: destZ, yaw: yawFacing, alive: true });
  }
  if (tDeath !== null && tDeath <= duration) {
    track.push({ t: tDeath, x: destX, y: 0, z: destZ, yaw: yawFacing, alive: false });
    track.push({ t: duration, x: destX, y: 0, z: destZ, yaw: yawFacing, alive: false });
  } else {
    track.push({ t: duration, x: destX, y: 0, z: destZ, yaw: yawFacing, alive: true });
  }
  return track;
}

// Drones loiter on a circular orbit; facing tangent to motion.
function droneTrack({ cx, cz, radius, altitude, period, phase, duration, tDeath = null }) {
  const track = [];
  const samples = 60; // 1Hz keyframes is plenty for orbit interpolation
  const tStop = tDeath ?? duration;
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * tStop;
    const a = phase + (t / period) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    const yaw = a + Math.PI / 2; // tangent
    track.push({ t, x, y: altitude, z, yaw, alive: true });
  }
  if (tDeath !== null && tDeath < duration) {
    const last = track[track.length - 1];
    // crash to ground over 1.5s
    track.push({ t: tDeath + 1.5, x: last.x, y: 0, z: last.z, yaw: last.yaw, alive: false });
    track.push({ t: duration, x: last.x, y: 0, z: last.z, yaw: last.yaw, alive: false });
  } else {
    const last = track[track.length - 1];
    track.push({ t: duration, x: last.x, y: altitude, z: last.z, yaw: last.yaw, alive: true });
  }
  return track;
}

export function generateScenario(opts = {}) {
  const duration = opts.duration ?? 60;
  const rng = mulberry32(opts.seed ?? 7);
  const agents = [];

  const bounds = { minX: -55, maxX: 55, minZ: -55, maxZ: 55 };

  // ---- Blue (south, advancing north) ----
  // Infantry squad: 8 troops along a line
  for (let i = 0; i < 8; i++) {
    const x = -28 + i * 8;
    const startZ = -40;
    const endZ   = -10 + (rng() - 0.5) * 4;
    // 4 will die between 42s and 55s
    const dies = i < 4;
    const tDeath = dies ? 42 + rng() * 13 : null;
    agents.push({
      id: `blue_inf_${i + 1}`, team: 'blue', type: 'infantry',
      track: marchTrack({
        x0: x, z0: startZ, x1: x + (rng() - 0.5) * 4, z1: endZ,
        t0: 1, t1: 28, duration, yawFacing: 0, tDeath, jitter: 0.6, rng,
      }),
    });
  }

  // 2 tanks on the flanks
  agents.push({
    id: 'blue_tank_1', team: 'blue', type: 'tank',
    track: marchTrack({ x0: -22, z0: -42, x1: -16, z1: -6, t0: 2, t1: 24, duration, yawFacing: 0, jitter: 0.2, rng }),
  });
  agents.push({
    id: 'blue_tank_2', team: 'blue', type: 'tank',
    track: marchTrack({ x0:  22, z0: -42, x1:  18, z1: -6, t0: 2, t1: 26, duration, yawFacing: 0, tDeath: 38, jitter: 0.2, rng }),
  });

  // 2 artillery in the rear, mostly stationary
  agents.push({
    id: 'blue_art_1', team: 'blue', type: 'artillery',
    track: marchTrack({ x0: -8, z0: -48, x1: -8, z1: -46, t0: 0, t1: 6, duration, yawFacing: 0, jitter: 0, rng }),
  });
  agents.push({
    id: 'blue_art_2', team: 'blue', type: 'artillery',
    track: marchTrack({ x0:  8, z0: -48, x1:  8, z1: -46, t0: 0, t1: 6, duration, yawFacing: 0, jitter: 0, rng }),
  });

  // 2 drones orbiting the front
  agents.push({
    id: 'blue_drn_1', team: 'blue', type: 'drone',
    track: droneTrack({ cx: -10, cz: -10, radius: 18, altitude: 7, period: 22, phase: 0,         duration }),
  });
  agents.push({
    id: 'blue_drn_2', team: 'blue', type: 'drone',
    track: droneTrack({ cx:  10, cz: -10, radius: 16, altitude: 8, period: 18, phase: Math.PI/3, duration, tDeath: 46 }),
  });

  // ---- Red (north, advancing south) ----
  // 4 of 8 start in defensive trenches and emerge on staggered cues; the
  // other 4 march in from the north edge as before.
  // Trench polylines are mirrored from data/terrain.json:
  //   left  trench: (-18,18) → (-3,18)
  //   right trench: ( 3,22) → (20,22)
  const trenchAssign = {
    3: { startX: -13, startZ: 18, tEmerge:  9 },
    4: { startX:  -6, startZ: 18, tEmerge: 14 },
    5: { startX:   6, startZ: 22, tEmerge:  7 },
    6: { startX:  16, startZ: 22, tEmerge: 17 },
  };

  for (let i = 0; i < 8; i++) {
    const id = `red_inf_${i + 1}`;
    const dies = i >= 4;
    const tDeath = dies ? 40 + rng() * 14 : null;
    const trench = trenchAssign[i + 1];

    if (trench) {
      agents.push({
        id, team: 'red', type: 'infantry',
        track: trenchMarchTrack({
          startX: trench.startX, startZ: trench.startZ,
          destX:  trench.startX + (rng() - 0.5) * 3,
          destZ:  10 + (rng() - 0.5) * 4,
          tEmerge: trench.tEmerge,
          tArrive: 35,
          duration, yawFacing: Math.PI,
          tDeath, jitter: 0.5, rng,
        }),
      });
    } else {
      const x = -28 + i * 8;
      agents.push({
        id, team: 'red', type: 'infantry',
        track: marchTrack({
          x0: x, z0: 40, x1: x + (rng() - 0.5) * 4, z1: 10 + (rng() - 0.5) * 4,
          t0: 1, t1: 28, duration, yawFacing: Math.PI, tDeath, jitter: 0.6, rng,
        }),
      });
    }
  }

  agents.push({
    id: 'red_tank_1', team: 'red', type: 'tank',
    track: marchTrack({ x0: -22, z0:  42, x1: -16, z1: 6, t0: 2, t1: 24, duration, yawFacing: Math.PI, tDeath: 40, jitter: 0.2, rng }),
  });
  agents.push({
    id: 'red_tank_2', team: 'red', type: 'tank',
    track: marchTrack({ x0:  22, z0:  42, x1:  18, z1: 6, t0: 2, t1: 26, duration, yawFacing: Math.PI, jitter: 0.2, rng }),
  });

  agents.push({
    id: 'red_art_1', team: 'red', type: 'artillery',
    track: marchTrack({ x0: -8, z0:  48, x1: -8, z1:  46, t0: 0, t1: 6, duration, yawFacing: Math.PI, jitter: 0, rng }),
  });
  agents.push({
    id: 'red_art_2', team: 'red', type: 'artillery',
    track: marchTrack({ x0:  8, z0:  48, x1:  8, z1:  46, t0: 0, t1: 6, duration, yawFacing: Math.PI, jitter: 0, rng }),
  });

  agents.push({
    id: 'red_drn_1', team: 'red', type: 'drone',
    track: droneTrack({ cx: -10, cz: 10, radius: 16, altitude: 8, period: 20, phase: Math.PI/2, duration, tDeath: 50 }),
  });
  agents.push({
    id: 'red_drn_2', team: 'red', type: 'drone',
    track: droneTrack({ cx:  10, cz: 10, radius: 18, altitude: 7, period: 24, phase: 0,         duration }),
  });

  const events = generateFireEvents(agents);

  return { duration, bounds, agents, events };
}

// ---- Fire-event derivation ---------------------------------------------------
// For every death keyframe, pick the closest opposing unit that's alive at
// t_fire (= t_death - flight_time) as the shooter. Tanks/artillery are weighted
// as preferred shooters. Returns events [{ t, shooter, target }] sorted by t.

const FLIGHT_TIME = 0.4; // seconds the shell is in flight before impact
const TYPE_WEIGHT = { tank: 0.5, artillery: 0.6, drone: 0.8, infantry: 1.0 };

function samplePosition(track, t) {
  let lo = 0;
  while (lo < track.length - 2 && track[lo + 1].t <= t) lo++;
  const a = track[lo], b = track[Math.min(lo + 1, track.length - 1)];
  if (b.t <= a.t) return { x: a.x, y: a.y, z: a.z };
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
  };
}

function isAliveAt(track, t) {
  let alive = true;
  for (const k of track) {
    if (k.t <= t) alive = k.alive;
    else break;
  }
  return alive;
}

function generateFireEvents(agents) {
  const events = [];
  for (const victim of agents) {
    const death = victim.track.find(k => !k.alive);
    if (!death) continue;
    const tFire = Math.max(0, death.t - FLIGHT_TIME);

    let best = null, bestScore = Infinity;
    const vp = samplePosition(victim.track, tFire);
    for (const other of agents) {
      if (other.team === victim.team) continue;
      if (!isAliveAt(other.track, tFire)) continue;
      const op = samplePosition(other.track, tFire);
      const dist = Math.hypot(op.x - vp.x, op.z - vp.z);
      const score = dist * (TYPE_WEIGHT[other.type] ?? 1.0);
      if (score < bestScore) { bestScore = score; best = other; }
    }
    if (best) events.push({ t: tFire, shooter: best.id, target: victim.id });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

