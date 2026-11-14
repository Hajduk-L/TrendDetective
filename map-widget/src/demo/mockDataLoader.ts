// Simulated Data Loader for local testing. The real loader (NASA APIs) is owned by the data team;
// it only has to accept an AreaFeature and return MapData — the same contract as here.
import type { Feature, Position } from "geojson";
import type { AreaFeature, MapData } from "../widget";

export type MockDataset = "grid" | "stations" | "lst";

export const MOCK_DATASETS: { id: MockDataset; label: string }[] = [
  { id: "grid", label: "Mean trend (area filled with one colour)" },
  { id: "stations", label: "Stations (GeoJSON points)" },
  { id: "lst", label: "MODIS land surface temp (raster tiles, NASA GIBS)" },
];

export async function mockLoadData(area: AreaFeature, dataset: MockDataset): Promise<MapData> {
  await new Promise((r) => setTimeout(r, 700)); // pretend network latency
  const ring = area.geometry.coordinates[0];

  switch (dataset) {
    case "grid": {
      // The whole selected area, filled with the colour of its mean trend.
      const mean = meanTrend(ring);
      return {
        type: "geojson",
        id: "mean-trend",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { mean_trend_K_per_decade: +mean.toFixed(3), color: trendColor(mean) },
              geometry: area.geometry,
            },
          ],
        },
      };
    }
    case "stations":
      return { type: "geojson", id: "stations", data: { type: "FeatureCollection", features: stations(ring) } };
    case "lst":
      return {
        type: "raster",
        id: "modis-lst",
        tiles: [
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/default/2025-07-01/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png",
        ],
        bounds: area.bbox,
        maxzoom: 7,
        opacity: 0.85,
        attribution: "NASA EOSDIS GIBS",
      };
  }
}

function extent(ring: Position[]) {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return { w: Math.min(...lngs), e: Math.max(...lngs), s: Math.min(...lats), n: Math.max(...lats) };
}

function inside([x, y]: Position, ring: Position[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Blue (cooling) → white → red (warming) for values in [-1, 1]. */
function trendColor(v: number): string {
  const t = Math.max(-1, Math.min(1, v));
  const mix = (a: number, b: number, f: number) => Math.round(a + (b - a) * f);
  const [r, g, b] =
    t < 0
      ? [mix(255, 33, -t), mix(255, 102, -t), mix(255, 172, -t)]
      : [mix(255, 178, t), mix(255, 24, t), mix(255, 43, t)];
  return `rgb(${r}, ${g}, ${b})`;
}

const syntheticTrend = (lng: number, lat: number) =>
  0.8 * Math.sin((lng * Math.PI) / 25) * Math.cos((lat * Math.PI) / 30) + 0.2 * Math.sin(lat / 7);

/** Mean of the synthetic trend over sample points inside the area. */
function meanTrend(ring: Position[]): number {
  const { w, e, s, n } = extent(ring);
  const steps = 20;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p: Position = [w + ((i + 0.5) * (e - w)) / steps, s + ((j + 0.5) * (n - s)) / steps];
      if (!inside(p, ring)) continue;
      sum += syntheticTrend(p[0], p[1]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function stations(ring: Position[]): Feature[] {
  const { w, e, s, n } = extent(ring);
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const out: Feature[] = [];
  for (let i = 0; out.length < 40 && i < 2000; i++) {
    const p: Position = [w + rand() * (e - w), s + rand() * (n - s)];
    if (!inside(p, ring)) continue;
    const trend = syntheticTrend(p[0], p[1]);
    out.push({
      type: "Feature",
      properties: { station: `ST-${String(out.length + 1).padStart(3, "0")}`, trend: +trend.toFixed(3), color: trendColor(trend) },
      geometry: { type: "Point", coordinates: p },
    });
  }
  return out;
}
