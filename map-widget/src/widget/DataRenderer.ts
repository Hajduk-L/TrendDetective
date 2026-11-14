import {
  Popup,
  type ExpressionSpecification,
  type LayerSpecification,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
  type SourceSpecification,
} from "maplibre-gl";
import type { MapData } from "./types";

/** Prefix of all MapLibre sources/layers created for result data. */
export const DATA_LAYER_PREFIX = "mw-data";

const DEFAULT_COLOR = "#2563eb";
const color: ExpressionSpecification = ["to-color", ["get", "color"], DEFAULT_COLOR];
const isPolygon: ExpressionSpecification = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const isLine: ExpressionSpecification = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const isPoint: ExpressionSpecification = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];

export interface DataRendererOptions {
  /** Layer id to insert data below (e.g. basemap labels or the selection). */
  beforeLayerId: () => string | undefined;
  /** Return false to suppress feature popups (e.g. while a drawing tool is active). */
  popupsEnabled: () => boolean;
}

/**
 * Renders Data Loader results (GeoJSON vectors, XYZ raster tiles, single images) as MapLibre
 * sources/layers. Keeps the current data so it can be re-applied after a basemap switch.
 */
export class DataRenderer {
  private readonly map: MapLibreMap;
  private readonly opts: DataRendererOptions;
  private data: MapData[] = [];
  private sourceIds: string[] = [];
  private layerIds: string[] = [];
  private interactiveLayerIds: string[] = [];
  private readonly popup = new Popup({ closeButton: true, maxWidth: "320px", className: "mw-popup" });

  private ready = false;

  constructor(map: MapLibreMap, opts: DataRendererOptions) {
    this.map = map;
    this.opts = opts;
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);
  }

  setData(data: MapData[]): void {
    this.data = data;
    this.render();
  }

  /** Re-adds layers after the style was replaced. */
  reapply(): void {
    this.ready = true;
    this.sourceIds = [];
    this.layerIds = [];
    this.interactiveLayerIds = [];
    this.render();
  }

  /** Call before the style is replaced; layers vanish with it. */
  suspend(): void {
    this.ready = false;
  }

  private isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMouseMove);
    this.popup.remove();
  }

  private render(): void {
    // Not ready yet: MapWidget calls reapply() on every style load.
    if (!this.isReady()) return;
    this.clearLayers();
    this.popup.remove();
    const before = this.opts.beforeLayerId();
    this.data.forEach((item, index) => this.addItem(item, index, before));
  }

  private clearLayers(): void {
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of this.sourceIds) if (this.map.getSource(id)) this.map.removeSource(id);
    this.sourceIds = [];
    this.layerIds = [];
    this.interactiveLayerIds = [];
  }

  private addSource(id: string, spec: SourceSpecification): void {
    this.map.addSource(id, spec);
    this.sourceIds.push(id);
  }

  private addLayer(layer: LayerSpecification, before: string | undefined, interactive = false): void {
    this.map.addLayer(layer, before && this.map.getLayer(before) ? before : undefined);
    this.layerIds.push(layer.id);
    if (interactive) this.interactiveLayerIds.push(layer.id);
  }

  private addItem(item: MapData, index: number, before: string | undefined): void {
    const key = `${DATA_LAYER_PREFIX}-${index}-${sanitize(item.id ?? item.type)}`;
    const opacity = item.opacity ?? 1;

    switch (item.type) {
      case "geojson": {
        this.addSource(key, { type: "geojson", data: item.data });
        this.addLayer(
          {
            id: `${key}-fill`,
            type: "fill",
            source: key,
            filter: isPolygon,
            paint: { "fill-color": color, "fill-opacity": 0.45 * opacity },
          },
          before,
          true,
        );
        this.addLayer(
          {
            id: `${key}-line`,
            type: "line",
            source: key,
            filter: ["any", isPolygon, isLine],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": color,
              "line-opacity": opacity,
              "line-width": ["case", isLine, 2.5, 1],
            },
          },
          before,
          true,
        );
        this.addLayer(
          {
            id: `${key}-point`,
            type: "circle",
            source: key,
            filter: isPoint,
            paint: {
              "circle-color": color,
              "circle-opacity": 0.9 * opacity,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6, 12, 9],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
            },
          },
          before,
          true,
        );
        break;
      }
      case "raster": {
        this.addSource(key, {
          type: "raster",
          tiles: item.tiles,
          tileSize: item.tileSize ?? 256,
          ...(item.bounds ? { bounds: rasterBounds(item.bounds) } : {}),
          ...(item.minzoom != null ? { minzoom: item.minzoom } : {}),
          ...(item.maxzoom != null ? { maxzoom: item.maxzoom } : {}),
          ...(item.attribution ? { attribution: item.attribution } : {}),
        });
        this.addLayer(
          { id: `${key}-raster`, type: "raster", source: key, paint: { "raster-opacity": item.opacity ?? 0.8 } },
          before,
        );
        break;
      }
      case "image": {
        let [w, s, e, n] = item.bounds;
        if (w > e) e += 360;
        this.addSource(key, {
          type: "image",
          url: item.url,
          coordinates: [
            [w, n],
            [e, n],
            [e, s],
            [w, s],
          ],
        });
        this.addLayer(
          { id: `${key}-image`, type: "raster", source: key, paint: { "raster-opacity": item.opacity ?? 0.8 } },
          before,
        );
        break;
      }
    }
  }

  private handleMouseMove = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0) return;
    const hit = this.map.queryRenderedFeatures(e.point, { layers: this.interactiveLayerIds }).length > 0;
    const canvas = this.map.getCanvas();
    // Only touch the cursor when we own it; Terra Draw manages it while drawing.
    if (hit && this.opts.popupsEnabled()) canvas.dataset.mwHover = "1";
    else delete canvas.dataset.mwHover;
  };

  private handleClick = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0 || !this.opts.popupsEnabled()) return;
    const [feature] = this.map.queryRenderedFeatures(e.point, { layers: this.interactiveLayerIds });
    if (!feature) return;
    this.popup.setLngLat(e.lngLat).setDOMContent(propertiesTable(feature.properties)).addTo(this.map);
  };
}

/** MapLibre tile bounds must have west < east; antimeridian boxes are unwrapped. */
function rasterBounds([w, s, e, n]: [number, number, number, number]): [number, number, number, number] {
  return w > e ? [w, s, e + 360, n] : [w, s, e, n];
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function propertiesTable(props: Record<string, unknown>): HTMLElement {
  const table = document.createElement("table");
  table.className = "mw-popup-table";
  const entries = Object.entries(props).filter(([k]) => k !== "color");
  if (entries.length === 0) {
    const row = table.insertRow();
    row.insertCell().textContent = "No attributes";
  }
  for (const [k, v] of entries) {
    const row = table.insertRow();
    const th = document.createElement("th");
    th.textContent = k;
    row.appendChild(th);
    row.insertCell().textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return table;
}
