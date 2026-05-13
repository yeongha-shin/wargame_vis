import * as THREE from 'three';

// Load + render the DEM heightmap and vector overlays (roads, rivers,
// buildings, trenches). Returns { group, sampleHeight(x, z) } so the rest of
// the app can place objects on the ground.

export async function loadDem(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  const text = await res.text();
  return parseAsciiGrid(text);
}

export async function loadTerrainJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json();
}

// Parse ESRI ASCII grid. Returns { ncols, nrows, xll, yll, cellsize, data }
// where data[r][c] is elevation; row 0 is the SOUTH (lowest z) edge so callers
// can index by world coordinates without flipping.
function parseAsciiGrid(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = {};
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_]+)\s+(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) { dataStart = i; break; }
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  const ncols = header.ncols, nrows = header.nrows;
  const xll = header.xllcorner ?? 0, yll = header.yllcorner ?? 0;
  const cellsize = header.cellsize ?? 1;
  // ESRI grids store rows top-to-bottom (north first). Flip so data[0] = south.
  const data = new Array(nrows);
  for (let r = 0; r < nrows; r++) {
    const src = lines[dataStart + (nrows - 1 - r)].trim().split(/\s+/);
    const row = new Float32Array(ncols);
    for (let c = 0; c < ncols; c++) row[c] = parseFloat(src[c]);
    data[r] = row;
  }
  return { ncols, nrows, xll, yll, cellsize, data };
}

// Bilinear height sample at world (x, z). Out-of-grid returns 0.
export function makeHeightSampler(dem) {
  const { ncols, nrows, xll, yll, cellsize, data } = dem;
  return function sampleHeight(x, z) {
    const fc = (x - xll) / cellsize;
    const fr = (z - yll) / cellsize;
    if (fc < 0 || fc > ncols - 1 || fr < 0 || fr > nrows - 1) return 0;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, ncols - 1);
    const r1 = Math.min(r0 + 1, nrows - 1);
    const u = fc - c0, v = fr - r0;
    const h00 = data[r0][c0], h10 = data[r0][c1];
    const h01 = data[r1][c0], h11 = data[r1][c1];
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  };
}

// Build the heightmap mesh. Returns the THREE.Mesh. The mesh's vertex Ys
// come from the DEM; vertex coloring slightly varies green by elevation
// so hills look brighter and lowland looks darker.
function buildHeightmapMesh(dem) {
  const { ncols, nrows, xll, yll, cellsize, data } = dem;
  const widthX = (ncols - 1) * cellsize;
  const widthZ = (nrows - 1) * cellsize;
  const geo = new THREE.PlaneGeometry(widthX, widthZ, ncols - 1, nrows - 1);
  // PlaneGeometry is initially in the XY plane centered at origin.
  // Rotate so it lies on the XZ plane (Y = up).
  geo.rotateX(-Math.PI / 2);

  // Translate so corner (col=0, row=0) corresponds to (xll, yll) in world.
  // After rotate, vertex (i, j) of the plane sits at:
  //   x = -widthX/2 + j*cellsize
  //   z =  widthZ/2 - i*cellsize  (i grows DOWN in plane coords → -z in world)
  // We want i=0 → world z = yll + (nrows-1)*cellsize (north edge in plane top).
  // Easier: just shift the geometry so (xll, yll) lines up with (col=0, row=0).
  geo.translate(xll + widthX / 2, 0, yll + widthZ / 2);

  // Set vertex Ys from DEM. PlaneGeometry vertex order is row-major from
  // top-left after the X/-PI/2 rotation, top = north (max z) = data row index nrows-1.
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  let minH = Infinity, maxH = -Infinity;
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const h = data[nrows - 1 - r][c]; // top row of plane = north = data row nrows-1
      const idx = r * ncols + c;
      pos.setY(idx, h);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  // Vertex coloring: low → dark olive, mid → moss green, high → light grass.
  const range = Math.max(0.1, maxH - minH);
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i);
    const t = (h - minH) / range; // 0..1
    // base green tinted by t
    const r = 0.16 + t * 0.18;
    const g = 0.24 + t * 0.20;
    const b = 0.16 + t * 0.10;
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain.dem';
  return mesh;
}

// Build a flat strip Mesh along a 2D polyline at given Y. Used for roads,
// rivers, trench markings.
function buildStripGeometry(points, width, y, sampleHeight = null) {
  const half = width / 2;
  const N = points.length;
  const verts = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const [x, z] = points[i];
    let dx, dz;
    if (i === 0) {
      dx = points[1][0] - x; dz = points[1][1] - z;
    } else if (i === N - 1) {
      dx = x - points[N - 2][0]; dz = z - points[N - 2][1];
    } else {
      dx = points[i + 1][0] - points[i - 1][0];
      dz = points[i + 1][1] - points[i - 1][1];
    }
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    // Optionally hug the heightmap so the strip doesn't float.
    const baseLeft = sampleHeight ? sampleHeight(x + nx * half, z + nz * half) : 0;
    const baseRight = sampleHeight ? sampleHeight(x - nx * half, z - nz * half) : 0;
    verts[i * 6 + 0] = x + nx * half; verts[i * 6 + 1] = baseLeft + y;  verts[i * 6 + 2] = z + nz * half;
    verts[i * 6 + 3] = x - nx * half; verts[i * 6 + 4] = baseRight + y; verts[i * 6 + 5] = z - nz * half;
  }
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = 2 * i, b = 2 * i + 1, c = 2 * (i + 1), d = 2 * (i + 1) + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildTerrain(scene, dem, terrain) {
  const root = new THREE.Group();
  root.name = 'terrain';

  const heightMesh = buildHeightmapMesh(dem);
  root.add(heightMesh);
  const sampleHeight = makeHeightSampler(dem);

  // ---- River (translucent blue, draped on terrain) ----
  if (terrain?.rivers?.length) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x254766, roughness: 0.18, metalness: 0.55,
      transparent: true, opacity: 0.86,
    });
    for (const r of terrain.rivers) {
      const geo = buildStripGeometry(r.points, r.width, 0.05, sampleHeight);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      root.add(m);
    }
  }

  // ---- Roads (slightly above river so crossings look like bridges) ----
  if (terrain?.roads?.length) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a3530, roughness: 0.95, metalness: 0,
    });
    for (const r of terrain.roads) {
      const geo = buildStripGeometry(r.points, r.width, 0.12, sampleHeight);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      root.add(m);
    }
  }

  // ---- Trench surface marker (dark earth strip down inside the dip) ----
  if (terrain?.trenches?.length) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a1208, roughness: 1.0, metalness: 0,
    });
    for (const t of terrain.trenches) {
      // Sit just above the trench bottom so the player sees a dark slot.
      const y = -((t.depth ?? 1.2) - 0.1);
      const geo = buildStripGeometry(t.points, t.width * 0.85, y);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      root.add(m);
    }
  }

  // ---- Buildings (boxes with simple roofs) ----
  if (terrain?.buildings?.length) {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb8a890, roughness: 0.85, metalness: 0 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9, metalness: 0 });
    for (const b of terrain.buildings) {
      const bg = new THREE.Group();
      const wall = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wallMat);
      wall.position.y = b.h / 2;
      wall.castShadow = true;
      wall.receiveShadow = true;
      bg.add(wall);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.4, 0.3, b.d + 0.4), roofMat);
      roof.position.y = b.h + 0.15;
      roof.castShadow = true;
      bg.add(roof);
      bg.position.set(b.x, sampleHeight(b.x, b.z), b.z);
      bg.rotation.y = b.yaw ?? 0;
      root.add(bg);
    }
  }

  scene.add(root);
  return { group: root, sampleHeight };
}
