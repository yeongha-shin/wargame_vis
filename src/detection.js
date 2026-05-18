import * as THREE from 'three';

// Live drone reconnaissance overlay (current position only — not cumulative).
//
// Each frame the disc of ground within a drone's detection radius is
// "painted" onto a coverage canvas — red for red-team drones, blue for
// blue-team drones, a blended violet where two teams' discs currently
// overlap. The previous frame's disc is wiped at the start of every frame
// (beginFrame), so the canvas only ever shows where the drones are *now*,
// never a trail of everywhere they have been.
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

    // Cumulative "ever scouted" bitmaps. Unlike rVis/bVis these are NOT
    // wiped each frame — they accumulate every cell a team's drones have
    // ever covered, for the lifetime of the replay (cleared only by
    // clear()). They drive no rendering; seenBy() queries them so callers
    // can ask "has team X's recon ever swept this spot?".
    this.rSeen = new Uint8Array(this.gw * this.gh);
    this.bSeen = new Uint8Array(this.gw * this.gh);

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
    // _prevBox: cells painted by the frame just uploaded (must be wiped at
    // the next beginFrame). _frameBox: cells painted so far this frame.
    this._prevBox = null;
    this._resetFrameBox();
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

  _resetFrameBox() {
    this._fMinX = Infinity; this._fMinY = Infinity;
    this._fMaxX = -Infinity; this._fMaxY = -Infinity;
  }

  // Grow the GPU-upload dirty rect to include [x0,x1]×[y0,y1].
  _growDirty(x0, y0, x1, y1) {
    if (x0 < this._dMinX) this._dMinX = x0;
    if (y0 < this._dMinY) this._dMinY = y0;
    if (x1 > this._dMaxX) this._dMaxX = x1;
    if (y1 > this._dMaxY) this._dMaxY = y1;
  }

  // Start a new frame: erase the disc(s) painted last frame so the overlay
  // shows only the drones' current positions, never an accumulated trail.
  // The cleared region is folded into the dirty rect so flush() uploads it.
  beginFrame() {
    const p = this._prevBox;
    if (p) {
      for (let y = p.y0; y <= p.y1; y++) {
        const row = y * this.gw;
        for (let x = p.x0; x <= p.x1; x++) {
          const i = row + x;
          this.rVis[i] = 0;
          this.bVis[i] = 0;
          this._paintPixel(i);   // vis all-zero → writes transparent
        }
      }
      this._growDirty(p.x0, p.y0, p.x1, p.y1);
      this._prevBox = null;
    }
    this._resetFrameBox();
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
    const vis  = team === 'red' ? this.rVis  : this.bVis;
    const seen = team === 'red' ? this.rSeen : this.bSeen;

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
        seen[i] = 1;                 // cumulative intel — never auto-cleared
        if (vis[i]) continue;        // already scouted by this team this frame
        vis[i] = 1;
        this._paintPixel(i);
        changed = true;
      }
    }
    if (!changed) return;
    this._growDirty(x0, y0, x1, y1);
    // Track this frame's painted bounds so beginFrame() can wipe exactly
    // this region next frame.
    if (x0 < this._fMinX) this._fMinX = x0;
    if (y0 < this._fMinY) this._fMinY = y0;
    if (x1 > this._fMaxX) this._fMaxX = x1;
    if (y1 > this._fMaxY) this._fMaxY = y1;
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
    // Remember what is painted now so the next beginFrame() can erase it.
    this._prevBox = this._fMaxX < this._fMinX ? null : {
      x0: this._fMinX, y0: this._fMinY, x1: this._fMaxX, y1: this._fMaxY,
    };
    this._resetFrameBox();
  }

  // Has `team`'s recon ever covered world point (wx, wz)? Reads the
  // cumulative bitmap, so it stays true after the drone has moved on. Uses
  // the exact world→canvas mapping stamp() uses.
  seenBy(team, wx, wz) {
    const half = this.planeSize / 2;
    const u = (wx + half) / this.planeSize;
    const v = (half - wz) / this.planeSize;
    const cx = Math.round(u * (this.gw - 1));
    const cy = Math.round(v * (this.gh - 1));
    if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) return false;
    const seen = team === 'red' ? this.rSeen : this.bSeen;
    return seen[cy * this.gw + cx] === 1;
  }

  // Wipe all coverage — live paint AND cumulative intel (replay restart).
  clear() {
    this.rVis.fill(0);
    this.bVis.fill(0);
    this.rSeen.fill(0);
    this.bSeen.fill(0);
    this.image.data.fill(0);
    this.cctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
    this._resetDirty();
    this._prevBox = null;
    this._resetFrameBox();
  }
}
