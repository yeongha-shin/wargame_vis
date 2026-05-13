// Generate a dummy DEM (digital elevation model) for the demo battlefield.
// Output: data/terrain.dem in ESRI ASCII grid format.
//
// Usage: node scripts/dump_dem.mjs [seed]
//
// Layout (matches scenario coordinates):
//   x: -60 .. 60   (cols)
//   z: -60 .. 60   (rows)   ← in world coordinates this is the depth axis
//   cellsize: 1.0
//
// The grid is mostly gentle rolling hills so units can walk across without
// dramatic climbs, with a few named features:
//   - lowland strip near z=0 (river bed)
//   - hill in NW (-35, -35)
//   - hill in SE (30, 25)
//   - shallow trench dips at the locations declared in terrain.json so
//     the heightmap visibly matches the trench overlays.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const seed = Number(process.argv[2] ?? 7);

const NCOLS = 121;       // 121 cells = 120m at 1m resolution
const NROWS = 121;
const CELLSIZE = 1.0;
const XLL = -60;         // world-x of column 0
const YLL = -60;         // world-z of row 0  (grid rows go in +z)
const NODATA = -9999;

// Tiny seeded PRNG so output is deterministic per seed
function mulberry32(s) {
  s = s >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);

// Trench dips: read from terrain.json so DEM stays consistent with overlays.
let trenches = [];
try {
  const tj = JSON.parse(readFileSync(resolve(projectRoot, 'data/terrain.json'), 'utf8'));
  trenches = tj.trenches ?? [];
} catch {
  // terrain.json not yet authored — fine, just no trench dips.
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - ax, pz - az);
  let u = ((px - ax) * dx + (pz - az) * dz) / len2;
  u = Math.max(0, Math.min(1, u));
  const cx = ax + u * dx, cz = az + u * dz;
  return Math.hypot(px - cx, pz - cz);
}

function distToPolyline(px, pz, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(px, pz, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

function elevation(x, z) {
  // Gentle rolling base
  let h = 0.55 * Math.sin(x * 0.045) * Math.cos(z * 0.055);
  h += 0.35 * Math.sin((x + z) * 0.032);
  h += 0.20 * Math.cos(x * 0.08 - z * 0.06);

  // NW hill — broad but moderate
  {
    const dx = x + 35, dz = z + 35;
    h += 3.5 * Math.exp(-(dx * dx + dz * dz) / 380);
  }
  // SE hill
  {
    const dx = x - 30, dz = z - 25;
    h += 2.6 * Math.exp(-(dx * dx + dz * dz) / 260);
  }
  // River lowland near z = 0  (very wide, shallow trough)
  h -= 0.9 * Math.exp(-(z * z) / 18);

  // Trench dips: ~1.4m deep, half-width = trench.width/2 + a small ramp
  for (const t of trenches) {
    if (!t.points || t.points.length < 2) continue;
    const d = distToPolyline(x, z, t.points);
    const half = (t.width ?? 1.5) / 2;
    if (d < half + 0.6) {
      // smoothstep-ish falloff on the rim
      const ramp = d <= half ? 1 : (1 - (d - half) / 0.6);
      h -= (t.depth ?? 1.2) * ramp * ramp;
    }
  }

  // Tiny noise so the lit surface doesn't look too uniform
  h += (rng() - 0.5) * 0.05;
  return h;
}

const lines = [];
lines.push(`ncols ${NCOLS}`);
lines.push(`nrows ${NROWS}`);
lines.push(`xllcorner ${XLL}`);
lines.push(`yllcorner ${YLL}`);
lines.push(`cellsize ${CELLSIZE}`);
lines.push(`NODATA_value ${NODATA}`);

// ESRI ASCII grids store rows top-to-bottom, i.e. the FIRST data row is the
// NORTHernmost (highest world-z), so we iterate rows from row=NROWS-1 down to 0.
for (let r = NROWS - 1; r >= 0; r--) {
  const z = YLL + r * CELLSIZE;
  const row = new Array(NCOLS);
  for (let c = 0; c < NCOLS; c++) {
    const x = XLL + c * CELLSIZE;
    row[c] = elevation(x, z).toFixed(3);
  }
  lines.push(row.join(' '));
}

const outPath = resolve(projectRoot, 'data/terrain.dem');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`wrote ${NCOLS}×${NROWS} DEM (${(NCOLS - 1) * CELLSIZE}m × ${(NROWS - 1) * CELLSIZE}m, seed=${seed}) → ${outPath}`);
