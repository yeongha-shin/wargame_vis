// money.csv → per-team cumulative cost timeline.
//
// Expected columns (header order is flexible, names are matched):
//   timestamp, team, fire_cost, damage_cost, total
//
// Each row is the running total for one team at one timestamp. Values are
// cumulative (monotonically non-decreasing), so the renderer reads them with
// a step-hold lookup — at any t, the displayed cost is the most recent row
// with t' ≤ t. Timestamps before the first row default to zero; timestamps
// past the last row hold the final value (covers the case where the cost
// stream is shorter than the scenario track).

const REQUIRED = ['timestamp', 'team', 'fire_cost', 'damage_cost', 'total'];

export async function loadMoneyFromCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error(`${url}: empty or no data rows`);

  const header = lines[0].split(',').map(s => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of REQUIRED) {
    if (!(col in idx)) throw new Error(`${url} missing required column: "${col}"`);
  }

  // Group rows by team, sorted by timestamp. Unknown teams (anything but
  // 'red'/'blue') are dropped silently so a future neutral column wouldn't
  // crash the loader.
  const series = { blue: [], red: [] };
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const team = (f[idx.team] ?? '').trim();
    if (!(team in series)) continue;
    series[team].push({
      t:      parseFloat(f[idx.timestamp]),
      fire:   parseFloat(f[idx.fire_cost]),
      damage: parseFloat(f[idx.damage_cost]),
      total:  parseFloat(f[idx.total]),
    });
  }
  for (const team of Object.keys(series)) {
    series[team].sort((a, b) => a.t - b.t);
  }
  return series;
}

// Step-hold lookup: returns the row whose t' is the largest ≤ t. Cursor is
// the previous call's return value — advanced forward on play, rewound on
// scrub, so the lookup is O(1) amortized along monotonic playback.
export function sampleMoney(series, t, cursor = 0) {
  if (series.length === 0) return { fire: 0, damage: 0, total: 0, cursor: 0 };
  let c = Math.max(0, Math.min(cursor, series.length - 1));
  while (c < series.length - 1 && series[c + 1].t <= t) c++;
  while (c > 0 && series[c].t > t) c--;
  // Before the first sample — show zeros so the UI doesn't flash the first
  // row's value at t = 0 if it happens to be non-zero.
  if (series[c].t > t) return { fire: 0, damage: 0, total: 0, cursor: c };
  return {
    fire:   series[c].fire,
    damage: series[c].damage,
    total:  series[c].total,
    cursor: c,
  };
}
