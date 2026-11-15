// Colour scales and the grid → map overlay renderer.

// Diverging temperature scale: navy → blue → pale → yellow → orange → red → plum.
// The warm half walks through several hues (not just ever-darker red), so +0,5 °C
// and +2 °C stay distinguishable when most of the planet is warmer than the baseline.
// Lightness falls monotonically away from the neutral midpoint on both sides.
const RDBU = ["#1b2b66", "#234f95", "#3577bb", "#62a6d6", "#9fcde8", "#d6ebf5", "#f4f2ea",
  "#fde3a1", "#fdbe63", "#f78f3f", "#e04f2e", "#b31f2c", "#6d0f3a"];
// Diverging brown–white–green (ColorBrewer BrBG): brown = drier, green = wetter.
const BRBG = ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f2f2f2",
  "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"];
// Sequential single-hue ramp for magnitudes (dark → bright orange on a dark map).
const SEQ = ["#1d1410", "#3d2014", "#64301a", "#8c401d", "#b4521f", "#d86a25", "#f08a3c", "#fbb06b", "#fdd3a5"];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildLut(stops, size = 256) {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
  }
  return lut;
}

export const SCALES = {
  diverging: { lut: buildLut(RDBU), stops: RDBU, symmetric: true },
  drywet: { lut: buildLut(BRBG), stops: BRBG, symmetric: true },
  sequential: { lut: buildLut(SEQ), stops: SEQ, symmetric: false },
};

/** Map value → [r,g,b] with a scale {kind, min, max}. */
export function colorFor(value, scale) {
  const s = SCALES[scale.kind];
  let t = (value - scale.min) / (scale.max - scale.min);
  t = Math.max(0, Math.min(1, t));
  const i = Math.round(t * 255) * 3;
  return [s.lut[i], s.lut[i + 1], s.lut[i + 2]];
}

export function cssColor(value, scale) {
  if (value == null || !Number.isFinite(value)) return "transparent";
  const [r, g, b] = colorFor(value, scale);
  return `rgb(${r},${g},${b})`;
}

/** A "nice" rounded number ≥ x (1, 2, 2.5, 5 × 10^n). */
export function niceCeil(x) {
  if (!(x > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= x - 1e-12) return m * e;
  return 10 * e;
}

export const MERC_MAX_LAT = 85.051129;

/**
 * Render a lat/lon grid into a canvas laid out in Web-Mercator rows, ready for a
 * MapLibre canvas source spanning ±180° / ±85.05°.
 *
 * Grid: Float32Array (NaN = no data), rows south→north starting at lat0, columns
 * west→east starting at lon0, both with constant steps.
 * smooth=true → bilinear interpolation between cell centres (no extrapolation
 * beyond the valid neighbours); smooth=false → each cell as a flat block.
 * mask (optional Uint8Array): cells with mask=0 get a stipple dot.
 */
export function renderGrid(canvas, grid, geom, scale, { smooth = true, mask = null } = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const { nlat, nlon, lat0, lon0, dlat, dlon } = geom;
  const lut = SCALES[scale.kind].lut;
  const inv = 1 / (scale.max - scale.min);
  const smin = scale.min;

  // Pre-compute the fractional grid column for every pixel column.
  const colF = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const lon = -180 + ((x + 0.5) / W) * 360;
    colF[x] = (lon - lon0) / dlon;
  }
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERC_MAX_LAT * Math.PI) / 360));

  for (let y = 0; y < H; y++) {
    const my = yMax - ((y + 0.5) / H) * 2 * yMax;
    const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180 / Math.PI;
    const rf = (lat - lat0) / dlat;
    let r0 = Math.floor(rf), fr = rf - r0;
    let r1 = r0 + 1;
    if (r0 < 0) { r0 = 0; r1 = 0; fr = 0; }
    if (r1 > nlat - 1) { r1 = nlat - 1; if (r0 > nlat - 1) r0 = nlat - 1; }
    const rowNear = Math.min(nlat - 1, Math.max(0, Math.round(rf)));
    let p = y * W * 4;
    for (let x = 0; x < W; x++, p += 4) {
      let v;
      if (smooth) {
        const cf = colF[x];
        let c0 = Math.floor(cf);
        const fc = cf - c0;
        c0 = ((c0 % nlon) + nlon) % nlon;
        const c1 = (c0 + 1) % nlon;
        const a = grid[r0 * nlon + c0], b = grid[r0 * nlon + c1];
        const c = grid[r1 * nlon + c0], d = grid[r1 * nlon + c1];
        const wa = (1 - fr) * (1 - fc), wb = (1 - fr) * fc, wc = fr * (1 - fc), wd = fr * fc;
        let s = 0, w = 0;
        if (a === a) { s += a * wa; w += wa; }
        if (b === b) { s += b * wb; w += wb; }
        if (c === c) { s += c * wc; w += wc; }
        if (d === d) { s += d * wd; w += wd; }
        // Only interpolate where the nearer neighbours carry data (no extrapolation).
        v = w > 0.45 ? s / w : NaN;
      } else {
        const col = ((Math.round(colF[x]) % nlon) + nlon) % nlon;
        v = grid[rowNear * nlon + col];
      }
      if (v !== v) { data[p + 3] = 0; continue; }
      let t = (v - smin) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = ((t * 255 + 0.5) | 0) * 3;
      data[p] = lut[i]; data[p + 1] = lut[i + 1]; data[p + 2] = lut[i + 2]; data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  if (mask) {
    // Stipple: a fine dark dot in the centre of each cell without a significant trend.
    ctx.fillStyle = "rgba(10,14,20,0.32)";
    const rad = Math.max(0.7, W / nlon / 11);
    for (let r = 0; r < nlat; r++) {
      const lat = lat0 + r * dlat;
      if (Math.abs(lat) > MERC_MAX_LAT) continue;
      const my = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const py = ((yMax - my) / (2 * yMax)) * H;
      for (let c = 0; c < nlon; c++) {
        const k = r * nlon + c;
        if (mask[k] || grid[k] !== grid[k]) continue;
        const px = ((lon0 + c * dlon + 180) / 360) * W;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Draw a horizontal colour bar. */
export function drawColorbar(canvas, scale) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  for (let x = 0; x < W; x++) {
    const v = scale.min + ((x + 0.5) / W) * (scale.max - scale.min);
    const [r, g, b] = colorFor(v, scale);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, H);
  }
}
