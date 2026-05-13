import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createUnit } from './units.js';
import { loadScenarioFromCsv } from './csvLoader.js';
import { CinematicDirector, loadCameraSchedule } from './cinematic.js';
import { EffectsManager, attachDamageEffect, createStatusRing } from './effects.js';

const TEAM_PRIMARY_HEX = { blue: 0x4ea0ff, red: 0xff5b5b };
const INCAP_RING_HEX   = 0xffd166;
const INCAP_DARKEN     = 0.45; // multiply original material color by this
// Status-ring Y offset above the sampled terrain height. The ring is a
// flat horizontal disc, so on a slope its outer edge can dip below the
// surrounding terrain; lifting it well above the local sample keeps the
// whole ring visible without making it look detached from the ground.
const STATUS_RING_Y = 0.7;
import { unlockAudio, setMuted, isMuted } from './audio.js';

const CSV_URL = './data/kaist_simulation.csv';
const CAMERAS_URL = './data/cameras.json';
const TERRAIN_TEXTURE_URL = './outputs/vuhledar_terrain_overlay.png';
const HEIGHT_GRID_URL = './data/vuhledar_height_grid.png';

// Ground plane covers the existing scenario world (±60 m). Both PNGs share the
// same 613×636 pixel grid (one pixel = one 50 m AOI cell), and both have PNG
// row 0 = north. We disable Three's default flipY so UV(0, 0) maps to the
// north-west corner of both textures, matching the rotated plane orientation.
const PLANE_SIZE = 120;
const HEIGHT_SCALE = 6.0;     // max world-Y displacement (slope luminance ∈ [0, 1])
const PLANE_SEGMENTS = 200;   // mesh density

// ---------- Scene setup ----------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1116);
scene.fog = new THREE.Fog(0x0b1116, 80, 220);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(60, 55, 75);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 15;
controls.maxDistance = 200;

// ---------- Lights ----------
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 0.55));

const sun = new THREE.DirectionalLight(0xfff1d6, 1.4);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 250;
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.bias = -0.0003;
scene.add(sun);

// ---------- Terrain backstop ----------
// A wide flat skirt under the heightmap so the camera doesn't see "void"
// when looking past the DEM edges. The DEM mesh sits on top with its own
// elevation; this just paints the horizon dark green.
const skirt = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x1c2a1c, roughness: 1.0, metalness: 0 }),
);
skirt.rotation.x = -Math.PI / 2;
skirt.position.y = -0.05;
skirt.receiveShadow = true;
scene.add(skirt);

// Center marker (objective)
const obj = new THREE.Mesh(
  new THREE.CylinderGeometry(2.0, 2.0, 0.1, 24),
  new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x442b00, roughness: 0.4 }),
);
obj.position.y = 0.06;
scene.add(obj);
const objRing = new THREE.Mesh(
  new THREE.RingGeometry(2.4, 2.7, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
);
objRing.rotation.x = -Math.PI / 2; objRing.position.y = 0.07;
scene.add(objRing);

// ---------- Loading overlay ----------
const loadingEl = document.createElement('div');
loadingEl.className = 'panel';
loadingEl.style.cssText = 'top:50%;left:50%;transform:translate(-50%,-50%);font-size:13px;';
loadingEl.textContent = `Loading ${CSV_URL} …`;
document.body.appendChild(loadingEl);

function showFatal(msg) {
  loadingEl.style.borderColor = '#ff5b5b';
  loadingEl.style.color = '#ffb1b1';
  loadingEl.innerHTML = `<b>Failed to load scenario</b><br><span style="font-size:12px;color:#8b9aa8;">${msg}</span>`;
}

start().catch(err => {
  console.error(err);
  showFatal(String(err.message || err));
});

async function start() {

// ---------- Terrain (elevation-displaced plane with terrain_type color overlay) ----------
// Color: outputs/vuhledar_terrain_overlay.png (urban/forest/water/etc. classes).
// Height: data/vuhledar_height_grid.png — grayscale elevation_m normalized to
// [0, 1] over the AOI's actual elevation range. Elevation is the raw DEM (not
// a derivative), so it's intrinsically smooth at the 50 m grid scale; the
// dump script also pre-smooths it to anti-alias against the heavy 31 km → 120 m
// horizontal compression before per-vertex bilinear sampling.
let sampleHeight = () => 0;
try {
  const [colorTex, heightGrid] = await Promise.all([
    loadTextureAsync(TERRAIN_TEXTURE_URL),
    loadGrayscaleGrid(HEIGHT_GRID_URL),
  ]);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.flipY = false;
  colorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_SEGMENTS, PLANE_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const h = sampleGridBilinear(heightGrid, uv.getX(i), uv.getY(i)) * HEIGHT_SCALE;
    pos.setY(i, h);
  }
  geo.computeVertexNormals();

  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: colorTex, roughness: 0.95, metalness: 0 }),
  );
  ground.receiveShadow = true;
  ground.name = 'terrain.ground';
  scene.add(ground);

  // World (x, z) → UV with the same convention as the plane:
  //   UV(0, 0) sits at the world NW corner (x=-60, z=+60).
  sampleHeight = (x, z) => {
    const u = (x + PLANE_SIZE / 2) / PLANE_SIZE;
    const v = (PLANE_SIZE / 2 - z) / PLANE_SIZE;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return sampleGridBilinear(heightGrid, u, v) * HEIGHT_SCALE;
  };
} catch (err) {
  console.warn('terrain not loaded — falling back to flat ground:', err.message);
}

function loadTextureAsync(url) {
  return new Promise((res, rej) =>
    new THREE.TextureLoader().load(url, res, undefined, rej)
  );
}

async function loadGrayscaleGrid(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error(`failed to load ${url}`));
    img.src = url;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  const grid = new Float32Array(w * h);
  // Red channel of grayscale PNG — matches L-mode source.
  for (let i = 0; i < w * h; i++) grid[i] = data[i * 4] / 255;
  return { w, h, grid };
}

function sampleGridBilinear(g, u, v) {
  const fx = u * (g.w - 1);
  const fy = v * (g.h - 1);
  const x0 = Math.max(0, Math.min(g.w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(g.h - 1, Math.floor(fy)));
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const a = fx - x0;
  const b = fy - y0;
  const p00 = g.grid[y0 * g.w + x0];
  const p10 = g.grid[y0 * g.w + x1];
  const p01 = g.grid[y1 * g.w + x0];
  const p11 = g.grid[y1 * g.w + x1];
  return (1 - a) * ((1 - b) * p00 + b * p01) + a * ((1 - b) * p10 + b * p11);
}

// ---------- Scenario / Agents ----------
const scenario = await loadScenarioFromCsv(CSV_URL);
loadingEl.remove();

// kaist_simulation.csv stores real-world meters (x,z span thousands; y is
// absolute elevation), while the demo world is a ±60 m square. Recenter the
// action at the origin and scale uniformly to fit ~100 m, then shift y so the
// lowest sample sits at 0 — `sampleHeight + y` then renders ground units near
// the terrain surface and drones at proportional AGL.
{
  const FIT_EXTENT = 100;
  const { minX, maxX, minZ, maxZ } = scenario.bounds;
  let minY = Infinity;
  for (const a of scenario.agents) for (const k of a.track) if (k.y < minY) minY = k.y;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const scale = FIT_EXTENT / Math.max(maxX - minX, maxZ - minZ);
  for (const a of scenario.agents) {
    for (const k of a.track) {
      k.x = (k.x - cx) * scale;
      k.z = (k.z - cz) * scale;
      k.y = (k.y - minY) * scale;
    }
  }
  scenario.bounds = {
    minX: (minX - cx) * scale, maxX: (maxX - cx) * scale,
    minZ: (minZ - cz) * scale, maxZ: (maxZ - cz) * scale,
  };
}

// ---------- Default initial facing ----------
// The source CSV leaves yaw at 0 for any keyframe where the unit hasn't
// started moving (dug-in artillery, ATGM teams, pre-engagement tanks).
// After the loader's yaw-convention conversion, those keyframes all face
// world +X — so units on the +X side point away from their enemy until
// they actually start turning. For every unit, find the initial run of
// keyframes whose yaw never deviates from yaw[0], and override that
// prefix to face the opposing team's centroid. As soon as the CSV starts
// varying yaw, the unit reverts to its data-driven heading; the linear
// interpolation between the last prefix frame and the first varied frame
// gives a natural one-step swing into motion.
{
  const sums = new Map();
  for (const a of scenario.agents) {
    if (!a.track.length) continue;
    const k = a.track[0];
    const s = sums.get(a.team) ?? { team: a.team, x: 0, z: 0, n: 0 };
    s.x += k.x; s.z += k.z; s.n += 1;
    sums.set(a.team, s);
  }
  for (const s of sums.values()) { s.x /= s.n; s.z /= s.n; }

  for (const a of scenario.agents) {
    if (a.track.length === 0) continue;

    let enemy = null;
    for (const s of sums.values()) {
      if (s.team !== a.team && s.n > 0) { enemy = s; break; }
    }
    if (!enemy) continue;

    const y0 = a.track[0].yaw;
    let prefixEnd = a.track.length;
    for (let i = 1; i < a.track.length; i++) {
      if (Math.abs(a.track[i].yaw - y0) > 1e-3) { prefixEnd = i; break; }
    }
    if (prefixEnd === 0) continue;

    const k0 = a.track[0];
    const dx = enemy.x - k0.x;
    const dz = enemy.z - k0.z;
    if (Math.hypot(dx, dz) < 1e-3) continue;
    // three.js convention here: forward = (sin yaw, cos yaw)
    const aimYaw = Math.atan2(dx, dz);
    for (let i = 0; i < prefixEnd; i++) a.track[i].yaw = aimYaw;
  }
}

// Last keyframe before the unit is destroyed — used as the resting place
// of the team-colored status ring. Returns null if the unit never dies.
function findDeathPos(track) {
  let last = null;
  for (const kf of track) {
    if (kf.status === 'destroyed') return last;
    last = kf;
  }
  return null;
}

const agents = scenario.agents.map(a => {
  const mesh = createUnit(a.type, a.team);
  mesh.visible = false; // shown once we apply first frame
  scene.add(mesh);
  // Attach an incapacitated-state damage effect only for agents whose
  // track ever enters that status — saves nodes for the common case.
  const hasIncap = a.track.some(kf => kf.status === 'incapacitated');
  const damage = hasIncap ? attachDamageEffect(mesh, a.type) : null;

  // Snapshot original material colors so the incapacitated darken can be
  // undone if the unit returns to operational (or proceeds to destroyed).
  // Materials are per-unit (not shared across agents), so mutating them
  // doesn't bleed into other units.
  const originalColors = new Map();
  mesh.traverse(o => {
    if (o.material && o.material.color && !originalColors.has(o.material)) {
      originalColors.set(o.material, o.material.color.clone());
    }
  });

  // Status ring: yellow when incapacitated, team color when destroyed.
  const ring = createStatusRing(a.type);
  scene.add(ring);

  return {
    spec: a,
    mesh,
    cursor: 0,           // last keyframe index used (for fast linear interpolation)
    aliveLast: true,
    damage,
    originalColors,
    ring,
    deathPos: findDeathPos(a.track),
    statusApplied: 'operational',
  };
});

const agentsById = new Map(agents.map(a => [a.spec.id, a]));

// Drone rotor spin animation: collect rotor meshes
const rotorMeshes = [];
agents.forEach(a => a.mesh.traverse(o => { if (o.userData?.spin) rotorMeshes.push(o); }));

// ---------- Combat effects ----------
const effects = new EffectsManager({ scene, agentsById, sampleHeight, camera });
effects.setEvents(scenario.events ?? []);
effects.setAgents(agents);

// ---------- Turret aiming ----------
// Pre-index fire events by shooter so applyFrame can swing each turreted unit
// to face its current/imminent target. AIM_LEAD seconds before fire, the
// turret begins traversing from hull-aligned (yaw 0) toward target; it stays
// locked for AIM_HOLD seconds after fire, then snaps back.
const AIM_LEAD = 1.5;
const AIM_HOLD = 1.0;
const TURRET_FLIGHT = 0.4; // mirrors FLIGHT in effects.js — keep in sync
const eventsByShooter = new Map();
for (const e of scenario.events ?? []) {
  if (!eventsByShooter.has(e.shooter)) eventsByShooter.set(e.shooter, []);
  eventsByShooter.get(e.shooter).push(e);
}
for (const arr of eventsByShooter.values()) arr.sort((a, b) => a.t - b.t);

function activeFireEvent(shooterId, t) {
  const arr = eventsByShooter.get(shooterId);
  if (!arr) return null;
  let best = null, bestDist = Infinity;
  for (const e of arr) {
    if (t < e.t - AIM_LEAD) break;
    if (t > e.t + AIM_HOLD) continue;
    const d = Math.abs(t - e.t);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

function wrapPi(a) {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

// ---------- Cinematic camera ----------
const director = new CinematicDirector({
  camera, controls, agentsById, domElement: renderer.domElement,
});
const $viewerLabel = document.getElementById('viewer-label');

// Pretty-print an agent ID. "blue_drn_1" → "Blue Drone 1".
function formatAgentLabel(agentId) {
  const agent = agentsById.get(agentId);
  if (!agent) return agentId;
  const team = agent.spec.team;
  const teamName = team[0].toUpperCase() + team.slice(1);
  const typeName = TYPE_LABELS[agent.spec.type] ?? agent.spec.type;
  const m = agentId.match(/_(\d+)$/);
  const idx = m ? ` ${m[1]}` : '';
  return `${teamName} ${typeName}${idx} View`;
}

director.onShotChange = (shot) => {
  // Only label shots tied to a specific agent (follow/pov/orbit). For
  // static / free / agentless shots, hide the overlay.
  $viewerLabel.classList.remove('blue', 'red', 'visible');
  if (!shot || !shot.agent) {
    $viewerLabel.textContent = '';
    return;
  }
  $viewerLabel.textContent = formatAgentLabel(shot.agent);
  const agent = agentsById.get(shot.agent);
  if (agent) $viewerLabel.classList.add(agent.spec.team);
  $viewerLabel.classList.add('visible');
};

try {
  const shots = await loadCameraSchedule(CAMERAS_URL);
  director.setShots(shots);
  director.setEnabled(true);
} catch (err) {
  console.warn('cameras.json not loaded — cinematic disabled:', err.message);
}

const $btnCinema = document.getElementById('btn-cinema');
function refreshCinemaButton() {
  $btnCinema.textContent = director.enabled ? '📽 Cinema: ON' : '📽 Cinema: OFF';
}
refreshCinemaButton();
$btnCinema.addEventListener('click', () => {
  director.setEnabled(!director.enabled);
  refreshCinemaButton();
});

// ---------- Timeline interpolation ----------
function sampleAt(track, t, cursor) {
  // advance cursor forward
  while (cursor < track.length - 2 && track[cursor + 1].t <= t) cursor++;
  // rewind if seeked backwards
  while (cursor > 0 && track[cursor].t > t) cursor--;
  const a = track[cursor];
  const b = track[Math.min(cursor + 1, track.length - 1)];
  if (b.t <= a.t) return { ...a, cursor };
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    yaw: a.yaw + (b.yaw - a.yaw) * u,
    // alive / status switch at the *next* keyframe — transitions are instantaneous
    alive: u >= 1 ? b.alive : a.alive,
    status: u >= 1 ? b.status : a.status,
    cursor,
  };
}

// Apply per-status visuals: darken or restore material colors and update
// the status ring's color/visibility. Idempotent — guarded by statusApplied
// in applyFrame so the work only happens on transitions.
function applyStatusVisuals(ag, status) {
  if (status === 'incapacitated') {
    for (const [m, c] of ag.originalColors) m.color.copy(c).multiplyScalar(INCAP_DARKEN);
    ag.ring.material.color.setHex(INCAP_RING_HEX);
    ag.ring.visible = true;
  } else {
    // Both 'operational' and 'destroyed' want the underlying mesh colors
    // restored — destroyed hides the mesh, but if we scrub back through
    // incap and out the other side we don't want stacked multiplications.
    for (const [m, c] of ag.originalColors) m.color.copy(c);
    if (status === 'destroyed') {
      const hex = TEAM_PRIMARY_HEX[ag.spec.team] ?? 0xffffff;
      ag.ring.material.color.setHex(hex);
      ag.ring.visible = true;
    } else {
      ag.ring.visible = false;
    }
  }
}

function makeCounts() {
  const c = { op: { blue: {}, red: {} }, incap: { blue: {}, red: {} } };
  for (const bucket of [c.op, c.incap]) {
    for (const team of Object.keys(bucket)) {
      for (const type of TYPE_ORDER) bucket[team][type] = 0;
    }
  }
  return c;
}

function applyFrame(t) {
  const counts = makeCounts();
  for (const ag of agents) {
    const s = sampleAt(ag.spec.track, t, ag.cursor);
    ag.cursor = s.cursor;

    if (s.status !== ag.statusApplied) {
      applyStatusVisuals(ag, s.status);
      ag.statusApplied = s.status;
    }

    if (s.status !== 'destroyed') {
      ag.mesh.visible = true;
      // CSV y is treated as AGL — ground units use 0, drones store altitude,
      // trench occupants use negative values to sit below the surface.
      ag.mesh.position.set(s.x, sampleHeight(s.x, s.z) + s.y, s.z);
      ag.mesh.rotation.y = s.yaw;

      const turret = ag.mesh.userData.turret;
      // Incapacitated units stop aiming — they're still on the field but
      // out of action. Only operational units track targets.
      const ev = s.status === 'operational' ? activeFireEvent(ag.spec.id, t) : null;
      let aim = null;
      if (ev) {
        const targetAgent = agentsById.get(ev.target);
        if (targetAgent) {
          const tSample = sampleAt(targetAgent.spec.track, ev.t + TURRET_FLIGHT, 0);
          const worldYaw = Math.atan2(tSample.x - s.x, tSample.z - s.z);
          // Ease in over AIM_LEAD, hold at full lock through AIM_HOLD.
          const u = t < ev.t
            ? Math.max(0, Math.min(1, (t - (ev.t - AIM_LEAD)) / AIM_LEAD))
            : 1;
          aim = { worldYaw, u };
        }
      }

      if (turret) {
        // Turreted units (tank, artillery) — swing only the turret, leave the
        // hull at its CSV-driven motion heading.
        if (aim) {
          const localYaw = wrapPi(aim.worldYaw - s.yaw);
          turret.rotation.y = localYaw * aim.u;
        } else {
          turret.rotation.y = 0;
        }
      } else if (aim) {
        // Non-turreted shooters (infantry, antitank, drone) — rotate the
        // whole body to face the target during the aim window. Blend from
        // motion heading (s.yaw) toward the bearing-to-target.
        const delta = wrapPi(aim.worldYaw - s.yaw);
        ag.mesh.rotation.y = s.yaw + delta * aim.u;
      }

      if (ag.damage) {
        ag.damage.setVisible(s.status === 'incapacitated');
        ag.damage.update(t);
      }

      // Status ring follows the live unit while it's incapacitated.
      if (s.status === 'incapacitated') {
        ag.ring.position.set(s.x, sampleHeight(s.x, s.z) + STATUS_RING_Y, s.z);
      }

      // Stats: track operational and incapacitated separately. Both count
      // as "still on the field" for the numeric tally; the bar splits them
      // into two colored segments so the damaged fraction is visible.
      const bucketKey = s.status === 'incapacitated' ? 'incap'
                      : s.status === 'operational'   ? 'op'
                      : null;
      if (bucketKey) {
        const bucket = counts[bucketKey][ag.spec.team];
        if (bucket && (ag.spec.type in bucket)) bucket[ag.spec.type] += 1;
      }
    } else {
      ag.mesh.visible = false;
      if (ag.damage) ag.damage.setVisible(false);
      // Team-colored ring stays at the death site alongside the wreckage.
      if (ag.deathPos) {
        const dp = ag.deathPos;
        ag.ring.position.set(dp.x, sampleHeight(dp.x, dp.z) + STATUS_RING_Y, dp.z);
      }
      // wreckage at the death site is rendered by EffectsManager's
      // WreckageEffect — keyed off scenario time so it appears/disappears
      // correctly when scrubbing.
    }
    ag.aliveLast = s.alive;
  }
  return counts;
}

// ---------- UI ----------
const $play = document.getElementById('btn-play');
const $restart = document.getElementById('btn-restart');
const $scrub = document.getElementById('scrub');
const $time = document.getElementById('time');
const $speed = document.getElementById('speed');
const $statTime = document.getElementById('stat-time');

// ---------- Casualty breakdown panel ----------
// Each scenario row spawns exactly one unit, so the team/type totals are
// fixed at load. Build the DOM once with placeholders for the live "alive"
// counts; the tick loop just rewrites the numeric spans afterwards.
const TYPE_LABELS = {
  infantry:     'Infantry',
  tank:         'Tank',
  artillery:    'Artillery',
  antitank:     'Antitank',
  drone:        'Drone',
  command_post: 'Command',
};
const TYPE_ORDER = ['infantry', 'tank', 'artillery', 'antitank', 'drone', 'command_post'];
const TEAM_ORDER = ['blue', 'red'];

const totals = { blue: {}, red: {} };
for (const team of TEAM_ORDER) for (const type of TYPE_ORDER) totals[team][type] = 0;
for (const a of scenario.agents) {
  if (totals[a.team] && (a.type in totals[a.team])) totals[a.team][a.type] += 1;
}

function teamTotal(team) {
  let n = 0;
  for (const type of TYPE_ORDER) n += totals[team][type];
  return n;
}

const statRefs = { blue: { teamAlive: null, teamLost: null, types: {} },
                   red:  { teamAlive: null, teamLost: null, types: {} } };

function makeBar($bd, team, isSub) {
  const bar = document.createElement('div');
  bar.className = `bar team-${team}${isSub ? ' sub' : ''}`;
  const fillOp = document.createElement('div');
  fillOp.className = 'bar-fill op';
  const fillIncap = document.createElement('div');
  fillIncap.className = 'bar-fill incap';
  bar.appendChild(fillOp);
  bar.appendChild(fillIncap);
  $bd.appendChild(bar);
  return { bar, fillOp, fillIncap };
}

(function buildBreakdownDOM() {
  const $bd = document.getElementById('stat-breakdown');
  for (const team of TEAM_ORDER) {
    const tTotal = teamTotal(team);
    if (tTotal === 0) continue;

    const head = document.createElement('div');
    head.className = `row team-head team-${team}`;
    const teamLabel = team[0].toUpperCase() + team.slice(1);
    head.innerHTML =
      `<span class="label team-name">${teamLabel}</span>` +
      `<span><span class="alive">${tTotal}</span>` +
      `<span class="total"> / ${tTotal}</span>` +
      `<span class="lost zero"></span></span>`;
    $bd.appendChild(head);
    statRefs[team].teamAlive = head.querySelector('.alive');
    statRefs[team].teamLost  = head.querySelector('.lost');
    const teamBar = makeBar($bd, team, false);
    statRefs[team].teamFillOp    = teamBar.fillOp;
    statRefs[team].teamFillIncap = teamBar.fillIncap;

    for (const type of TYPE_ORDER) {
      const typeTotal = totals[team][type];
      if (typeTotal === 0) continue;
      const row = document.createElement('div');
      row.className = 'row sub';
      row.innerHTML =
        `<span class="label">${TYPE_LABELS[type] ?? type}</span>` +
        `<span><span class="alive">${typeTotal}</span>` +
        `<span class="total"> / ${typeTotal}</span></span>`;
      $bd.appendChild(row);
      const { bar, fillOp, fillIncap } = makeBar($bd, team, true);
      statRefs[team].types[type] = {
        row, alive: row.querySelector('.alive'), bar, fillOp, fillIncap,
      };
    }
  }
})();

let currentTime = 0;
let playing = true;
let speed = 1.0;
let scrubbing = false;

function setPlaying(v) {
  playing = v;
  $play.textContent = playing ? '❚❚ Pause' : '▶ Play';
}

$play.addEventListener('click', () => { unlockAudio(); setPlaying(!playing); });
$restart.addEventListener('click', () => { unlockAudio(); currentTime = 0; setPlaying(true); });
$speed.addEventListener('change', e => { speed = parseFloat(e.target.value); });

const $btnSound = document.getElementById('btn-sound');
setMuted(false);
function refreshSoundButton() {
  $btnSound.textContent = isMuted() ? '🔇 Sound: OFF' : '🔊 Sound: ON';
}
refreshSoundButton();
$btnSound.addEventListener('click', () => {
  unlockAudio();
  setMuted(!isMuted());
  refreshSoundButton();
});

$scrub.addEventListener('input', e => {
  scrubbing = true;
  currentTime = (parseFloat(e.target.value) / 1000) * scenario.duration;
});
$scrub.addEventListener('change', () => { scrubbing = false; });

window.addEventListener('keydown', e => {
  unlockAudio();
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  else if (e.code === 'ArrowLeft')  { currentTime = Math.max(0, currentTime - 2); }
  else if (e.code === 'ArrowRight') { currentTime = Math.min(scenario.duration, currentTime + 2); }
  else if (e.code === 'KeyC')       { director.setEnabled(!director.enabled); refreshCinemaButton(); }
});

// ---------- Animation loop ----------
const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();

  if (playing && !scrubbing) {
    currentTime += dt * speed;
    if (currentTime >= scenario.duration) {
      currentTime = scenario.duration;
      setPlaying(false);
    }
  }

  const stats = applyFrame(currentTime);
  effects.update(currentTime);

  // spin drone rotors
  for (const r of rotorMeshes) r.rotation.y += dt * 40;

  // pulse objective ring
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.003);
  objRing.material.opacity = 0.35 + pulse * 0.4;

  // HUD
  if (!scrubbing) {
    $scrub.value = String(Math.round((currentTime / scenario.duration) * 1000));
  }
  const timeLabel = `${currentTime.toFixed(1)}s / ${scenario.duration.toFixed(1)}s`;
  $time.textContent = timeLabel;
  $statTime.textContent = timeLabel;

  for (const team of TEAM_ORDER) {
    const refs = statRefs[team];
    if (!refs.teamAlive) continue;
    let teamOp = 0;
    let teamIncap = 0;
    for (const type of TYPE_ORDER) {
      const ref = refs.types[type];
      if (!ref) continue;
      const op = stats.op[team][type]    | 0;
      const ic = stats.incap[team][type] | 0;
      const tot = totals[team][type];
      const onField = op + ic;
      ref.alive.textContent = String(onField);
      const depleted = onField === 0 && tot > 0;
      ref.row.classList.toggle('depleted', depleted);
      ref.bar.classList.toggle('depleted', depleted);
      ref.fillOp.style.width    = `${(op / tot) * 100}%`;
      ref.fillIncap.style.width = `${(ic / tot) * 100}%`;
      teamOp += op;
      teamIncap += ic;
    }
    const teamOnField = teamOp + teamIncap;
    const teamTot = teamTotal(team);
    refs.teamAlive.textContent = String(teamOnField);
    const lost = teamTot - teamOnField;
    refs.teamLost.textContent = lost > 0 ? `−${lost}` : '';
    refs.teamLost.classList.toggle('zero', lost === 0);
    refs.teamFillOp.style.width    = `${(teamOp    / teamTot) * 100}%`;
    refs.teamFillIncap.style.width = `${(teamIncap / teamTot) * 100}%`;
  }

  if (director.shouldOverride(currentTime)) {
    controls.enabled = false;
    director.update(currentTime);
  } else {
    controls.enabled = true;
    director.update(currentTime); // keeps _lastT in sync; no-op when not overriding
    controls.update();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

} // end start()

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
