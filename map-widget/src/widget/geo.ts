import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type { BBox } from "./types";

const EARTH_RADIUS_M = 6378137;
const COORD_PRECISION = 6; // ~0.1 m

const round = (n: number, p = COORD_PRECISION) => {
  const f = 10 ** p;
  return Math.round(n * f) / f;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Wraps a longitude into [-180, 180]. 180 stays 180. */
export function wrapLng(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

function isClosed(ring: Position[]): boolean {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return ring.length > 1 && a[0] === b[0] && a[1] === b[1];
}

/** Shoelace area in degree space. Positive = counter-clockwise. */
function signedPlanarArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/** Geodesic area of a closed ring in km² (spherical approximation, good to ~0.5 %). */
export function geodesicAreaKm2(ring: Position[]): number {
  const n = ring.length;
  if (n < 4) return 0;
  const rad = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < n - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % (n - 1)];
    const p3 = ring[(i + 2) % (n - 1)];
    area += (p3[0] * rad - p1[0] * rad) * Math.sin(p2[1] * rad);
  }
  return Math.abs((area * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / 1e6;
}

export interface NormalizedRing {
  ring: Position[];
  bbox: BBox;
  crossesAntimeridian: boolean;
}

/**
 * Normalizes a drawn ring for export:
 * rounded, closed, latitudes clamped to ±90, counter-clockwise (RFC 7946),
 * shifted by a multiple of 360° so its centre lies within [-180, 180].
 * A ring that crosses the antimeridian stays continuous (some |lng| > 180).
 */
export function normalizeRing(input: Position[]): NormalizedRing {
  let ring = input.map((p) => [round(p[0]), round(clamp(p[1], -90, 90))]);
  if (!isClosed(ring)) ring.push([...ring[0]]);

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (maxLng - minLng >= 360) {
    // Covers every longitude: clamp to one world.
    ring = ring.map(([lng, lat]) => [clamp(lng, -180, 180), lat]);
    minLng = -180;
    maxLng = 180;
  } else {
    const center = (minLng + maxLng) / 2;
    const k = center >= -180 && center <= 180 ? 0 : Math.floor((center + 180) / 360);
    if (k !== 0) {
      const shift = k * 360;
      ring = ring.map(([lng, lat]) => [round(lng - shift), lat]);
      minLng -= shift;
      maxLng -= shift;
    }
  }

  if (signedPlanarArea(ring) < 0) ring.reverse();

  const crossesAntimeridian = minLng < -180 || maxLng > 180;
  const bbox: BBox = crossesAntimeridian
    ? [round(wrapLng(minLng)), minLat, round(wrapLng(maxLng)), maxLat]
    : [minLng, minLat, maxLng, maxLat];

  return { ring, bbox, crossesAntimeridian };
}

/** True if the ring is an axis-aligned lng/lat rectangle (4 corners + closing point). */
export function isAxisAlignedRectangle(ring: Position[]): boolean {
  const pts = isClosed(ring) ? ring.slice(0, -1) : ring;
  if (pts.length !== 4) return false;
  const lngs = new Set(pts.map((p) => p[0]));
  const lats = new Set(pts.map((p) => p[1]));
  return lngs.size === 2 && lats.size === 2;
}

/** Sutherland–Hodgman clip of a closed ring against the vertical line x = `x`. */
function clipRing(ring: Position[], x: number, keep: "left" | "right"): Position[] {
  const inside = (p: Position) => (keep === "left" ? p[0] <= x : p[0] >= x);
  const out: Position[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (x - a[0]) / (b[0] - a[0]);
      out.push([x, round(a[1] + t * (b[1] - a[1]))]);
    }
  }
  if (out.length > 0) out.push([...out[0]]);
  return out;
}

/**
 * Splits an antimeridian-crossing polygon into parts that each lie within [-180, 180],
 * as recommended by RFC 7946 §3.1.9. Non-crossing input is returned unchanged.
 */
export function splitAtAntimeridian<P>(
  feature: Feature<Polygon, P>,
): Feature<Polygon | MultiPolygon, P> {
  const outer = feature.geometry.coordinates[0];
  if (!outer.some(([lng]) => lng < -180 || lng > 180)) return feature;

  const parts: Position[][] = [];
  for (const shift of [-360, 0, 360]) {
    const shifted = outer.map(([lng, lat]) => [lng + shift, lat]);
    const clipped = clipRing(clipRing(shifted, -180, "right"), 180, "left");
    if (clipped.length >= 4 && Math.abs(signedPlanarArea(clipped)) > 1e-12) parts.push(clipped);
  }

  const geometry: Polygon | MultiPolygon =
    parts.length === 1
      ? { type: "Polygon", coordinates: [parts[0]] }
      : { type: "MultiPolygon", coordinates: parts.map((r) => [r]) };
  return { ...feature, geometry };
}
