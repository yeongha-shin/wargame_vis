// CSV → scenario loader.
//
// Expected columns (header order is flexible, names are matched):
//   timestamp, team, agent_type, agent_id, x, y, z, yaw, alive, event, target
//
// `alive` accepts the new three-state form `operational` / `incapacitated`
// / `destroyed`, or the legacy 1/0 / true/false form (1/true → operational,
// 0/false → destroyed).
// `timestamp` should be in ascending order; the loader sorts defensively
// per-agent in case input is not strictly ordered.
// `event` and `target` are optional. Rows with `event === 'fire'` are
// emitted into the events array as { t, shooter, target } in addition to
// being treated as ordinary track keyframes.

const REQUIRED = ['timestamp', 'team', 'agent_type', 'agent_id', 'x', 'y', 'z', 'alive'];

function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV is empty or has no data rows');

  const header = lines[0].split(',').map(s => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  for (const col of REQUIRED) {
    if (!(col in idx)) throw new Error(`CSV missing required column: "${col}"`);
  }
  const hasYaw = 'yaw' in idx;
  const hasEvent = 'event' in idx;
  const hasTarget = 'target' in idx;

  // Three-state status with legacy boolean fallback.
  function parseStatus(raw) {
    const s = (raw ?? '').trim().toLowerCase();
    if (s === 'incapacitated') return 'incapacitated';
    if (s === 'destroyed' || s === '0' || s === 'false') return 'destroyed';
    // 'operational', '1', 'true', and unknown values all map to operational.
    return 'operational';
  }

  // CSV yaw is stored in math convention: yaw = atan2(Δz, Δx), so the unit's
  // forward vector is (cos yaw, sin yaw) with +x as reference. Our three.js
  // scene treats local +Z as the unit's forward, where mesh.rotation.y = θ
  // sends +Z to world (sin θ, cos θ). Converting once at load (π/2 − yaw_csv)
  // accounts for both the axis swap (+x↔+z) and the opposite rotation sense.
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const status = parseStatus(f[idx.alive]);
    rows[i - 1] = {
      t:      parseFloat(f[idx.timestamp]),
      team:   f[idx.team].trim(),
      type:   f[idx.agent_type].trim(),
      id:     f[idx.agent_id].trim(),
      x:      parseFloat(f[idx.x]),
      y:      parseFloat(f[idx.y]),
      z:      parseFloat(f[idx.z]),
      yaw:    hasYaw ? (Math.PI / 2 - parseFloat(f[idx.yaw])) : 0,
      status,
      // `alive` is kept for downstream code that just needs "is the unit
      // still on the battlefield" — destroyed flips it false; operational
      // and incapacitated both keep it true.
      alive:  status !== 'destroyed',
      event:  hasEvent  ? (f[idx.event]  ?? '').trim() : '',
      target: hasTarget ? (f[idx.target] ?? '').trim() : '',
    };
  }
  return rows;
}

function rowsToScenario(rows) {
  const byId = new Map();
  const events = [];
  let duration = 0;
  let minX =  Infinity, maxX = -Infinity, minZ =  Infinity, maxZ = -Infinity;

  for (const r of rows) {
    if (!byId.has(r.id)) {
      byId.set(r.id, { id: r.id, team: r.team, type: r.type, track: [] });
    }
    byId.get(r.id).track.push({ t: r.t, x: r.x, y: r.y, z: r.z, yaw: r.yaw, alive: r.alive, status: r.status });
    if (r.event === 'fire' && r.target) {
      events.push({ t: r.t, shooter: r.id, target: r.target });
    }
    if (r.t > duration) duration = r.t;
    if (r.x < minX) minX = r.x; if (r.x > maxX) maxX = r.x;
    if (r.z < minZ) minZ = r.z; if (r.z > maxZ) maxZ = r.z;
  }

  // Defensive: ensure each track is sorted by t ascending.
  const agents = [...byId.values()];
  for (const a of agents) a.track.sort((p, q) => p.t - q.t);
  events.sort((a, b) => a.t - b.t);

  return {
    duration,
    bounds: { minX, maxX, minZ, maxZ },
    agents,
    events,
  };
}

export async function loadScenarioFromCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const rows = parseCsvText(text);
  return rowsToScenario(rows);
}
