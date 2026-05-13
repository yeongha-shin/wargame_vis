// Regenerate data/battle.csv from the dummy scenario.
// Usage: node scripts/dump_csv.mjs [seed] [duration]
//
// Emits position keyframe rows AND fire-event rows in one CSV. An event row
// is just a normal keyframe with `event` and `target` columns filled in; its
// position is interpolated from the shooter's track so the row stays
// consistent with the shooter's trajectory.

import { generateScenario } from '../src/scenario.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const seed = Number(process.argv[2] ?? 7);
const duration = Number(process.argv[3] ?? 60);

const scenario = generateScenario({ seed, duration });
const agentsById = new Map(scenario.agents.map(a => [a.id, a]));

function samplePosition(track, t) {
  let lo = 0;
  while (lo < track.length - 2 && track[lo + 1].t <= t) lo++;
  const a = track[lo], b = track[Math.min(lo + 1, track.length - 1)];
  if (b.t <= a.t) return { x: a.x, y: a.y, z: a.z, yaw: a.yaw, alive: a.alive };
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    yaw: a.yaw + (b.yaw - a.yaw) * u,
    alive: a.alive, // keyframe-local
  };
}

const rows = [];

// Position keyframes
for (const a of scenario.agents) {
  for (const k of a.track) {
    rows.push({
      timestamp: k.t,
      team: a.team, agent_type: a.type, agent_id: a.id,
      x: k.x, y: k.y, z: k.z, yaw: k.yaw,
      alive: k.alive ? 1 : 0,
      event: '', target: '',
    });
  }
}

// Fire-event rows (interpolated shooter pos)
for (const e of scenario.events) {
  const shooter = agentsById.get(e.shooter);
  if (!shooter) continue;
  const p = samplePosition(shooter.track, e.t);
  rows.push({
    timestamp: e.t,
    team: shooter.team, agent_type: shooter.type, agent_id: shooter.id,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    alive: 1,
    event: 'fire', target: e.target,
  });
}

rows.sort((a, b) =>
  a.timestamp - b.timestamp
  || a.agent_id.localeCompare(b.agent_id)
  || (a.event === 'fire' ? 1 : 0) - (b.event === 'fire' ? 1 : 0) // events after track row at same t
);

const fmt = (n) => Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString();

const header = 'timestamp,team,agent_type,agent_id,x,y,z,yaw,alive,event,target';
const lines = [header];
for (const r of rows) {
  lines.push([
    fmt(r.timestamp), r.team, r.agent_type, r.agent_id,
    fmt(r.x), fmt(r.y), fmt(r.z), fmt(r.yaw),
    r.alive, r.event, r.target,
  ].join(','));
}

const outPath = resolve(projectRoot, 'data/battle.csv');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n');

const fireCount = rows.filter(r => r.event === 'fire').length;
console.log(`wrote ${rows.length} rows (${scenario.agents.length} agents, ${fireCount} fire events, ${duration}s) → ${outPath}`);
