import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type { FocusPoint } from "./types";

/** Prefix of the MapLibre source and layers that grey out the area and mark the focused location. */
export const FOCUS_LAYER_PREFIX = "mw-focus";

const SOURCE_ID = `${FOCUS_LAYER_PREFIX}-src`;
const VEIL_FILL_ID = `${FOCUS_LAYER_PREFIX}-veil-fill`;
const VEIL_LINE_ID = `${FOCUS_LAYER_PREFIX}-veil-line`;
const RING_ID = `${FOCUS_LAYER_PREFIX}-ring`;
const DOT_ID = `${FOCUS_LAYER_PREFIX}-dot`;
const LAYER_IDS = [VEIL_FILL_ID, VEIL_LINE_ID, RING_ID, DOT_ID];
const ACCENT = "#ff6b2c";
const GREY = "#94a3b8";

/**
 * While one location inside the selected area is focused (e.g. a single station of a box):
 * draws a grey veil over the area (covering its orange outline) and a ring marker on the
 * location. Drawn on top of everything; call raise() after other layers were (re)added.
 * Survives basemap switches via suspend() / reapply().
 */
export class FocusLayer {
  private readonly map: MapLibreMap;
  private focus: FocusPoint | null = null;
  private area: Polygon | null = null;
  private ready = false;

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  set(focus: FocusPoint | null, area: Polygon | null): void {
    this.focus = focus;
    this.area = area;
    this.render();
  }

  reapply(): void {
    this.ready = true;
    this.render();
  }

  suspend(): void {
    this.ready = false;
  }

  /** Moves the focus layers back on top (after data or selection layers were added). */
  raise(): void {
    if (!this.ready) return;
    for (const id of LAYER_IDS) if (this.map.getLayer(id)) this.map.moveLayer(id);
  }

  destroy(): void {
    this.remove();
  }

  private remove(): void {
    if (!this.ready) return;
    for (const id of LAYER_IDS) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
  }

  private render(): void {
    if (!this.ready) return;
    if (!this.focus) {
      this.remove();
      return;
    }
    const data: FeatureCollection<Point | Polygon> = {
      type: "FeatureCollection",
      features: [
        ...(this.area ? [{ type: "Feature" as const, properties: {}, geometry: this.area }] : []),
        {
          type: "Feature",
          properties: { color: this.focus.color ?? ACCENT },
          geometry: { type: "Point", coordinates: this.focus.coordinates },
        },
      ],
    };
    const source = this.map.getSource<GeoJSONSource>(SOURCE_ID);
    if (source) {
      source.setData(data);
      this.raise();
      return;
    }
    this.map.addSource(SOURCE_ID, { type: "geojson", data });
    this.map.addLayer({
      id: VEIL_FILL_ID,
      type: "fill",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": GREY, "fill-opacity": 0.22 },
    });
    this.map.addLayer({
      id: VEIL_LINE_ID,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: { "line-join": "round" },
      paint: { "line-color": GREY, "line-width": 3 },
    });
    this.map.addLayer({
      id: RING_ID,
      type: "circle",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 13,
        "circle-color": "rgba(0, 0, 0, 0)",
        "circle-stroke-color": ACCENT,
        "circle-stroke-width": 3,
      },
    });
    this.map.addLayer({
      id: DOT_ID,
      type: "circle",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": ["to-color", ["get", "color"], ACCENT],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
}
