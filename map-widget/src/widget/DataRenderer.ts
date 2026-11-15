import {
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type LayerSpecification,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
  type SourceSpecification,
} from "maplibre-gl";
import type { FeatureClick, MapData } from "./types";

/** Prefix of all MapLibre sources/layers created for result data. */
export const DATA_LAYER_PREFIX = "mw-data";

const DEFAULT_COLOR = "#2563eb";
const color: ExpressionSpecification = ["to-color", ["get", "color"], DEFAULT_COLOR];
const isPolygon: ExpressionSpecification = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const isLine: ExpressionSpecification = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const isPoint: ExpressionSpecification = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
/** Opacity factor of layers faded by `setDimmed`. */
const DIM_FACTOR = 0.3;

export interface DataRendererOptions {
  /** Layer id to insert data below (e.g. basemap labels or the selection). */
  beforeLayerId: () => string | undefined;
  /** Return false to suppress feature popups (e.g. while a drawing tool is active). */
  popupsEnabled: () => boolean;
  /** Clicked a result feature; return true when handled, so no popup opens. */
  onFeatureClick?: (hit: FeatureClick) => boolean | void;
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
  /** MapLibre layer id -> `MapData.id` of the item it draws. */
  private readonly dataIdOf = new Map<string, string | undefined>();
  /** MapLibre layer ids of faded items; hover and click prefer the others. */
  private readonly dimmedLayerIds = new Set<string>();
  /** Ids or "prefix*" patterns of items drawn faded. */
  private dimmed: string[] = [];
  private readonly popup = new Popup({ closeButton: true, maxWidth: "320px", className: "mw-popup" });
  private readonly tip = new Popup({ closeButton: false, closeOnClick: false, className: "mw-region-tip mw-feature-tip", offset: 12 });

  private ready = false;

  constructor(map: MapLibreMap, opts: DataRendererOptions) {
    this.map = map;
    this.opts = opts;
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);
    map.on("mouseout", this.hideTip);
  }

  /** Fades the items whose id matches one of `patterns` (exact id, or a prefix ending in "*"). */
  setDimmed(patterns: string[]): void {
    if (patterns.join("\n") === this.dimmed.join("\n")) return;
    this.dimmed = patterns;
    this.render();
  }

  private isDimmed(dataId: string | undefined): boolean {
    const id = dataId ?? "";
    return this.dimmed.some((p) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p));
  }

  setData(data: MapData[]): void {
    const previous = this.data;
    this.data = data;
    if (this.isReady() && sameLayers(previous, data)) {
      // Only GeoJSON contents changed (e.g. animation frames): swap the data, keep the layers
      // and an open popup, so updates are smooth and do not flicker.
      data.forEach((item, index) => {
        if (item.type !== "geojson" || item === previous[index]) return;
        const source = this.map.getSource<GeoJSONSource>(layerKey(item, index));
        source?.setData(item.data);
      });
      return;
    }
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
    this.map.off("mouseout", this.hideTip);
    this.popup.remove();
    this.tip.remove();
  }

  private render(): void {
    // Not ready yet: MapWidget calls reapply() on every style load.
    if (!this.isReady()) return;
    this.clearLayers();
    this.popup.remove();
    this.hideTip();
    const before = this.opts.beforeLayerId();
    this.data.forEach((item, index) => this.addItem(item, index, before));
  }

  private clearLayers(): void {
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of this.sourceIds) if (this.map.getSource(id)) this.map.removeSource(id);
    this.sourceIds = [];
    this.layerIds = [];
    this.interactiveLayerIds = [];
    this.dataIdOf.clear();
    this.dimmedLayerIds.clear();
  }

  private addSource(id: string, spec: SourceSpecification): void {
    this.map.addSource(id, spec);
    this.sourceIds.push(id);
  }

  private addLayer(
    layer: LayerSpecification,
    before: string | undefined,
    interactive = false,
    dataId?: string,
  ): void {
    this.map.addLayer(layer, before && this.map.getLayer(before) ? before : undefined);
    this.layerIds.push(layer.id);
    this.dataIdOf.set(layer.id, dataId);
    if (this.isDimmed(dataId)) {
      this.dimmedLayerIds.add(layer.id);
    }
    if (interactive) this.interactiveLayerIds.push(layer.id);
  }

  private addItem(item: MapData, index: number, before: string | undefined): void {
    const key = layerKey(item, index);
    const dim = this.isDimmed(item.id) ? DIM_FACTOR : 1;
    const opacity = (item.opacity ?? 1) * dim;

    switch (item.type) {
      case "geojson": {
        this.addSource(key, { type: "geojson", data: item.data });
        this.addLayer(
          {
            id: `${key}-fill`,
            type: "fill",
            source: key,
            filter: isPolygon,
            // Antialiasing off when there are no outlines, so adjacent cells show no hairline seams.
            paint: {
              "fill-color": color,
              "fill-opacity": (item.fillOpacity ?? 0.45) * opacity,
              "fill-antialias": item.outline !== false,
            },
          },
          before,
          true,
          item.id,
        );
        this.addLayer(
          {
            id: `${key}-line`,
            type: "line",
            source: key,
            filter: item.outline === false ? isLine : ["any", isPolygon, isLine],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": color,
              "line-opacity": opacity,
              "line-width": ["case", isLine, 2.5, 1],
            },
          },
          before,
          true,
          item.id,
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
              "circle-radius": item.pointRadius ?? ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6, 12, 9],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
            },
          },
          before,
          true,
          item.id,
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
          { id: `${key}-raster`, type: "raster", source: key, paint: { "raster-opacity": (item.opacity ?? 0.8) * dim } },
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
          { id: `${key}-image`, type: "raster", source: key, paint: { "raster-opacity": (item.opacity ?? 0.8) * dim } },
          before,
        );
        break;
      }
    }
  }

  private handleMouseMove = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0) {
      this.hideTip();
      return;
    }
    const features = this.featuresAt(e);
    const enabled = this.opts.popupsEnabled();
    const canvas = this.map.getCanvas();
    // Only touch the cursor when we own it; Terra Draw manages it while drawing.
    if (features.length > 0 && enabled) canvas.dataset.mwHover = "1";
    else delete canvas.dataset.mwHover;

    // A short description box for features that bring one (e.g. the station used for a point).
    const withTip = enabled ? features.find((f) => typeof f.properties?.tooltip === "string") : undefined;
    if (!withTip) {
      this.tip.remove();
      return;
    }
    const at = withTip.geometry.type === "Point" ? (withTip.geometry.coordinates as [number, number]) : e.lngLat;
    this.tip.setLngLat(at).setDOMContent(tooltipContent(String(withTip.properties.tooltip))).addTo(this.map);
  };

  /** Result features under the cursor, top first; faded ones after the others. */
  private featuresAt(e: MapLayerMouseEvent) {
    const features = this.map.queryRenderedFeatures(e.point, { layers: this.interactiveLayerIds });
    if (this.dimmedLayerIds.size === 0) return features;
    const faded = (f: (typeof features)[number]) => this.dimmedLayerIds.has(f.layer.id);
    return [...features.filter((f) => !faded(f)), ...features.filter(faded)];
  }

  private hideTip = () => {
    this.tip.remove();
  };

  private handleClick = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0 || !this.opts.popupsEnabled()) return;
    const [feature] = this.featuresAt(e);
    if (!feature) return;
    const handled = this.opts.onFeatureClick?.({
      layerId: this.dataIdOf.get(feature.layer.id),
      properties: { ...feature.properties },
      lngLat: [e.lngLat.lng, e.lngLat.lat],
    });
    if (handled) {
      this.popup.remove();
      return;
    }
    this.hideTip();
    this.popup.setLngLat(e.lngLat).setDOMContent(propertiesTable(feature.properties)).addTo(this.map);
  };
}

/** MapLibre tile bounds must have west < east; antimeridian boxes are unwrapped. */
function rasterBounds([w, s, e, n]: [number, number, number, number]): [number, number, number, number] {
  return w > e ? [w, s, e + 360, n] : [w, s, e, n];
}

function layerKey(item: MapData, index: number): string {
  return `${DATA_LAYER_PREFIX}-${index}-${sanitize(item.id ?? item.type)}`;
}

/** True if both lists draw the same layers and differ at most in GeoJSON `data`. */
function sameLayers(a: MapData[], b: MapData[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const withoutData = (item: MapData) => JSON.stringify(item.type === "geojson" ? { ...item, data: null } : item);
  return a.every((item, i) => item === b[i] || withoutData(item) === withoutData(b[i]));
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function propertiesTable(props: Record<string, unknown>): HTMLElement {
  const table = document.createElement("table");
  table.className = "mw-popup-table";
  const entries = Object.entries(props).filter(([k]) => k !== "color" && k !== "tooltip" && !k.startsWith("_"));
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

/** Hover box: the first line in bold, the others below it. */
function tooltipContent(text: string): HTMLElement {
  const box = document.createElement("div");
  text.split("\n").forEach((line, i) => {
    if (i > 0) box.appendChild(document.createElement("br"));
    if (i === 0) {
      const strong = document.createElement("strong");
      strong.textContent = line;
      box.appendChild(strong);
    } else {
      box.appendChild(document.createTextNode(line));
    }
  });
  return box;
}
