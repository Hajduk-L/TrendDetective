import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type LngLatBoundsLike,
  type StyleSpecification,
} from "maplibre-gl";
// MapLibre v6 loads its worker as a separate module; bundlers (Vite pre-bundling) break the
// default lookup next to import.meta.url, so we hand it the bundled asset URL explicitly.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { BBox, ProjectionType } from "./types";

setWorkerUrl(workerUrl);

export interface MapEngineOptions {
  container: HTMLElement;
  style: string | StyleSpecification;
  projection: ProjectionType;
  center?: [number, number];
  zoom?: number;
}

type Listener = () => void;

/**
 * Owns the MapLibre instance: creation, basemap style, projection, camera.
 * Knows nothing about selections or result data; other modules hook in via
 * `onStyleReady` (fired after every style load) and `onBeforeStyleChange`.
 */
export class MapEngine {
  readonly map: MapLibreMap;
  private projection: ProjectionType;
  private styleReady = false;
  private readyListeners = new Set<Listener>();
  private beforeChangeListeners = new Set<Listener>();

  constructor(opts: MapEngineOptions) {
    this.projection = opts.projection;
    this.map = new MapLibreMap({
      container: opts.container,
      style: opts.style,
      center: opts.center ?? [10, 25],
      zoom: opts.zoom ?? 1.4,
      renderWorldCopies: true,
      attributionControl: { compact: true },
    });
    this.map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

    this.map.on("style.load", () => {
      this.applyProjection();
      this.styleReady = true;
      this.readyListeners.forEach((fn) => fn());
    });
  }

  get isStyleReady(): boolean {
    return this.styleReady;
  }

  get currentProjection(): ProjectionType {
    return this.projection;
  }

  /** Called after every style load (initial and after basemap switches). */
  onStyleReady(fn: Listener): () => void {
    this.readyListeners.add(fn);
    return () => this.readyListeners.delete(fn);
  }

  /** Called right before the style is replaced (custom layers are about to disappear). */
  onBeforeStyleChange(fn: Listener): () => void {
    this.beforeChangeListeners.add(fn);
    return () => this.beforeChangeListeners.delete(fn);
  }

  setStyle(style: string | StyleSpecification): void {
    this.beforeChangeListeners.forEach((fn) => fn());
    this.styleReady = false;
    // diff:false guarantees a full reload and therefore a `style.load` event.
    this.map.setStyle(style, { diff: false });
  }

  setProjection(projection: ProjectionType): void {
    this.projection = projection;
    if (this.styleReady) this.applyProjection();
  }

  private applyProjection(): void {
    this.map.setProjection({ type: this.projection });
  }

  fitToBBox(bbox: BBox, opts: { padding?: number; maxZoom?: number } = {}): void {
    let [west, south, east, north] = bbox;
    if (west > east) east += 360; // antimeridian-crossing box
    const bounds: LngLatBoundsLike = [
      [west, south],
      [east, north],
    ];
    this.map.fitBounds(bounds, { padding: opts.padding ?? 60, maxZoom: opts.maxZoom ?? 9, duration: 800 });
  }

  /** First symbol (label) layer of the basemap, so data can be inserted below labels. */
  firstBasemapSymbolLayerId(ignorePrefixes: string[]): string | undefined {
    const layers = this.map.getStyle()?.layers ?? [];
    return layers.find((l) => l.type === "symbol" && !ignorePrefixes.some((p) => l.id.startsWith(p)))?.id;
  }

  destroy(): void {
    this.readyListeners.clear();
    this.beforeChangeListeners.clear();
    this.map.remove();
  }
}
