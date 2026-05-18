import * as THREE from 'three';

// Accumulating drone reconnaissance overlay.
//
// As each drone flies, the disc of ground within its detection radius is
// "painted" onto a coverage canvas — red for red-team drones, blue for
// blue-team drones, a blended violet where the two teams' coverage overlaps.
// Cells stay painted forever (until an explicit clear()), so the canvas is a
// cumulative map of everywhere either side has scouted.
//
// The canvas is drawn onto a clone of the displaced terrain geometry, so the
// translucent paint hugs hills and valleys instead of floating on a flat
// plane. World↔canvas mapping mirrors terrain.ground exactly (flipY=false,
// UV(0,0) = north-west corner), so coverage lands precisely under the drone.

// Per-team paint, matching the UI theme (--red / --blue). Overlap uses the
// channel-wise average so a scouted-by-both cell reads as a distinct violet
// rather than whichever team happened to fly over last.
const RED  = [255, 91, 91];
const BLUE = [78, 160, 255];
const BOTH = [
  Math.round((RED[0] + BLUE[0]) / 2),
  Math.round((RED[1] + BLUE[1]) / 2),
  Math.round((RED[2] + BLUE[2]) / 2),
];
const SINGLE_ALPHA  = 96;   // one team has scouted this cell
const OVERLAP_ALPHA = 132;  // both teams — slightly more opaque to stand out

export class DetectionOverlay {
  // geometry: the displaced terrain BufferGeometry (cloned here so the
  // overlay shares the terrain's exact shape + UVs without coupling).
  // planeSize: world extent the geometry spans (±planeSize/2 in x and z).
  constructor({ scene, geometry, planeSize, gridSize = 512 }) {
    this.planeSize = planeSize;
    this.gw = gridSize;
    this.gh = gridSize;

    // Per-team visited bitmaps (1 = scouted). Kept separate from the pixel
    // buffer so overlap can be recomputed correctly when either team adds a
    // cell, regardless of paint order.
    this.rVis = new Uint8Array(this.gw * this.gh);
    this.bVis = new Uint8Array(this.gw * this.gh);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.gw;
    this.canvas.height = this.gh;
    this.cctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.image = this.cctx.createImageData(this.gw, this.gh); // all zero = transparent

    const tex = new THREE.CanvasTexture(this.canvas);
    tex.flipY = false;                 // match terrain.ground UV convention
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.texture = tex;

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,           // never occlude units/effects behind it
      polygonOffset: true,         // bias toward camera to beat z-fighting
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.mesh = new THREE.Mesh(geometry.clone(), mat);
    this.mesh.position.y = 0.08;    // small lift so it never dips into terrain
    this.mesh.renderOrder = 2;      // draw after opaque terrain
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'detection.overlay';
    this.mesh.visible = true;
    scene.add(this.mesh);

    this.enabled = true;
    this._resetDirty();
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.mesh.visible = this.enabled;
  }

  isEnabled() { return this.enabled; }

  _resetDirty() {
    this._dMinX = Infinity; this._dMinY = Infinity;
    this._dMaxX = -Infinity; this._dMaxY = -Infinity;
  }

  // Recompute one pixel's RGBA from the two visited bitmaps.
  _paintPixel(i) {
    const r = this.rVis[i], b = this.bVis[i];
    const o = i * 4;
    const d = this.image.data;
    if (r && b) {
      d[o] = BOTH[0]; d[o + 1] = BOTH[1]; d[o + 2] = BOTH[2]; d[o + 3] = OVERLAP_ALPHA;
    } else if (r) {
      d[o] = RED[0];  d[o + 1] = RED[1];  d[o + 2] = RED[2];  d[o + 3] = SINGLE_ALPHA;
    } else if (b) {
      d[o] = BLUE[0]; d[o + 1] = BLUE[1]; d[o + 2] = BLUE[2]; d[o + 3] = SINGLE_ALPHA;
    } else {
      d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
    }
  }

  // Mark the ground disc centred at world (wx, wz) with the given world-space
  // radius as scouted by `team`. Only newly-covered cells are repainted, and
  // a dirty rect is grown so flush() uploads just the touched region.
  stamp(team, wx, wz, worldRadius) {
    const vis = team === 'red' ? this.rVis : this.bVis;

    // World → canvas, mirroring terrain.ground / sampleHeight:
    //   u = (x + half) / size      (west→east)
    //   v = (half - z) / size      (north→south, row 0 = north)
    const half = this.planeSize / 2;
    const u = (wx + half) / this.planeSize;
    const v = (half - wz) / this.planeSize;
    const cx = u * (this.gw - 1);
    const cy = v * (this.gh - 1);
    const rad = (worldRadius / this.planeSize) * (this.gw - 1);
    if (rad <= 0) return;

    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(this.gw - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(this.gh - 1, Math.ceil(cy + rad));
    if (x0 > x1 || y0 > y1) return; // wholly off-map

    const r2 = rad * rad;
    let changed = false;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.gw;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy > r2) continue;
        const i = row + x;
        if (vis[i]) continue;        // already scouted by this team
        vis[i] = 1;
        this._paintPixel(i);
        changed = true;
      }
    }
    if (!changed) return;
    if (x0 < this._dMinX) this._dMinX = x0;
    if (y0 < this._dMinY) this._dMinY = y0;
    if (x1 > this._dMaxX) this._dMaxX = x1;
    if (y1 > this._dMaxY) this._dMaxY = y1;
  }

  // Upload any pending changes to the GPU. Cheap no-op when nothing changed.
  flush() {
    if (this._dMaxX < this._dMinX) return;
    const dw = this._dMaxX - this._dMinX + 1;
    const dh = this._dMaxY - this._dMinY + 1;
    // Full ImageData, but only the dirty sub-rect is blitted to the canvas.
    this.cctx.putImageData(this.image, 0, 0, this._dMinX, this._dMinY, dw, dh);
    this.texture.needsUpdate = true;
    this._resetDirty();
  }

  // Wipe all accumulated coverage (used on replay restart).
  clear() {
    this.rVis.fill(0);
    this.bVis.fill(0);
    this.image.data.fill(0);
    this.cctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
    this._resetDirty();
  }
}
