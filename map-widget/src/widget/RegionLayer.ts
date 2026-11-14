import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import type { Region } from "./types";

/** Prefix of the MapLibre source and layers that show the predefined regions. */
export const REGION_LAYER_PREFIX = "mw-region";

const SOURCE_ID = `${REGION_LAYER_PREFIX}-src`;
const FILL_ID = `${REGION_LAYER_PREFIX}-fill`;
const LINE_ID = `${REGION_LAYER_PREFIX}-line`;
const DOT_ID = `${REGION_LAYER_PREFIX}-dot`;
/** Below this zoom a 1° box is only a few pixels, so a marker shows where the region is. */
const DOT_MAX_ZOOM = 6;
const ACCENT = "#ff6b2c";
const IDLE = "#0f766e";

export interface RegionLayerOptions {
  /** Layer id to insert the regions below (basemap labels), so result data can lie on top. */
  beforeLayerId: () => string | undefined;
  /** User clicked a region while the regions are shown. */
  onPick: (region: Region) => void;
}

/**
 * Draws the predefined evaluation regions (areas dense enough in measuring stations).
 * All regions are shown while `visible` is on; the selected one is always shown and
 * highlighted. Survives basemap switches via suspend() / reapply().
 */
export class RegionLayer {
  private readonly map: MapLibreMap;
  private readonly opts: RegionLayerOptions;
  private regions: Region[] = [];
  private visible = false;
  private selectedId: string | null = null;
  /** The area result outlines the stations used, so the selected box is no longer drawn. */
  private selectedHidden = false;
  private ready = false;
  private readonly hover = new Popup({ closeButton: false, closeOnClick: false, className: "mw-region-tip", offset: 10 });

  constructor(map: MapLibreMap, opts: RegionLayerOptions) {
    this.map = map;
    this.opts = opts;
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);
    map.on("mouseout", this.hideTip);
  }

  setRegions(regions: Region[]): void {
    this.regions = regions;
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.hideTip();
    this.render();
  }

  setSelected(id: string | null): void {
    if (id !== this.selectedId) this.selectedHidden = false;
    this.selectedId = id;
    this.render();
  }

  /** Hides the selected region's box while its area result is on the map (shown again on a new pick). */
  setSelectedHidden(hidden: boolean): void {
    this.selectedHidden = hidden;
    this.render();
  }

  find(id: string): Region | undefined {
    return this.regions.find((r) => r.id === id);
  }

  /** Re-adds the layers after the style was replaced. */
  reapply(): void {
    this.ready = true;
    this.render();
  }

  /** Call before the style is replaced; layers vanish with it. */
  suspend(): void {
    this.ready = false;
  }

  destroy(): void {
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMouseMove);
    this.map.off("mouseout", this.hideTip);
    this.hover.remove();
  }

  private shown(): Region[] {
    return this.regions.filter((r) => this.visible || (r.id === this.selectedId && !this.selectedHidden));
  }

  private render(): void {
    if (!this.ready) return;
    const data = {
      type: "FeatureCollection" as const,
      features: this.shown().flatMap((r) => {
        const properties = { id: r.id, selected: r.id === this.selectedId };
        const [w, south, e, n] = r.bbox;
        return [
          { type: "Feature" as const, properties, geometry: bboxPolygon(r.bbox) },
          {
            type: "Feature" as const,
            properties,
            geometry: { type: "Point" as const, coordinates: [(w + e) / 2, (south + n) / 2] },
          },
        ];
      }),
    };
    const source = this.map.getSource<GeoJSONSource>(SOURCE_ID);
    if (source) {
      source.setData(data);
      return;
    }
    const selected: ExpressionSpecification = ["boolean", ["get", "selected"], false];
    this.map.addSource(SOURCE_ID, { type: "geojson", data });
    const before = this.opts.beforeLayerId();
    const at = before && this.map.getLayer(before) ? before : undefined;
    const isPolygon: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];
    this.map.addLayer({
      id: FILL_ID,
      type: "fill",
      source: SOURCE_ID,
      filter: isPolygon,
      paint: { "fill-color": ["case", selected, ACCENT, IDLE], "fill-opacity": ["case", selected, 0.06, 0.18] },
    }, at);
    this.map.addLayer({
      id: LINE_ID,
      type: "line",
      source: SOURCE_ID,
      filter: isPolygon,
      layout: { "line-join": "round" },
      paint: { "line-color": ["case", selected, ACCENT, IDLE], "line-width": ["case", selected, 3, 1.5] },
    }, at);
    this.map.addLayer({
      id: DOT_ID,
      type: "circle",
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      maxzoom: DOT_MAX_ZOOM,
      paint: {
        "circle-color": ["case", selected, ACCENT, IDLE],
        "circle-radius": 7,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    }, at);
  }

  private regionAt(e: MapLayerMouseEvent): Region | undefined {
    if (!this.ready || !this.visible || !this.map.getLayer(FILL_ID)) return undefined;
    // A few pixels of slack around the cursor, so the small markers are easy to hit.
    const box: [[number, number], [number, number]] = [
      [e.point.x - 4, e.point.y - 4],
      [e.point.x + 4, e.point.y + 4],
    ];
    const [hit] = this.map.queryRenderedFeatures(box, { layers: [DOT_ID, FILL_ID] });
    const id = hit?.properties?.id;
    return typeof id === "string" ? this.find(id) : undefined;
  }

  private handleClick = (e: MapLayerMouseEvent) => {
    const region = this.regionAt(e);
    if (region) {
      this.hideTip();
      this.opts.onPick(region);
    }
  };

  private handleMouseMove = (e: MapLayerMouseEvent) => {
    const region = this.regionAt(e);
    const canvas = this.map.getCanvas();
    if (!region) {
      delete canvas.dataset.mwRegion;
      this.hideTip();
      return;
    }
    canvas.dataset.mwRegion = "1";
    const tip = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = region.name;
    tip.appendChild(name);
    if (region.note) {
      tip.appendChild(document.createElement("br"));
      tip.appendChild(document.createTextNode(region.note));
    }
    this.hover.setLngLat(e.lngLat).setDOMContent(tip).addTo(this.map);
  };

  private hideTip = () => {
    this.hover.remove();
    delete this.map.getCanvas().dataset.mwRegion;
  };
}

/** Closed counter-clockwise ring of a [west, south, east, north] box. */
export function bboxPolygon([w, s, e, n]: [number, number, number, number]) {
  return {
    type: "Polygon" as const,
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}
