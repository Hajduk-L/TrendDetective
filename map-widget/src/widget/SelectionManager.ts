import type { Feature, Polygon } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  TerraDraw,
  TerraDrawFreehandMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode,
  ValidateNotSelfIntersecting,
  type GeoJSONStoreFeatures,
  type TerraDrawEventListeners,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { geodesicAreaKm2, isAxisAlignedRectangle, normalizeRing } from "./geo";
import type { AreaFeature, DrawTool, SelectionShape } from "./types";

/** Prefix of all MapLibre sources/layers created by Terra Draw. */
export const SELECTION_LAYER_PREFIX = "mw-sel";

const SHAPES: readonly SelectionShape[] = ["rectangle", "polygon", "freehand"];
const ACCENT = "#ff6b2c";
const WHITE = "#ffffff";

type FeatureId = string | number;

/**
 * MapLibre returns wrapped longitudes on the globe. Keep them continuous relative to the
 * view centre so a shape can be drawn across the antimeridian without jumping around the world.
 * (In Mercator, MapLibre already returns continuous longitudes across world copies.)
 */
class ContinuousLngAdapter extends TerraDrawMapLibreGLAdapter<MapLibreMap> {
  private readonly mlMap: MapLibreMap;

  constructor(map: MapLibreMap, prefixId: string) {
    super({ map, prefixId });
    this.mlMap = map;
  }

  override unproject(x: number, y: number): { lng: number; lat: number } {
    const p = super.unproject(x, y);
    if (this.mlMap.getProjection()?.type !== "globe") return p;
    const center = this.mlMap.getCenter().lng;
    let lng = p.lng;
    while (lng - center > 180) lng -= 360;
    while (lng - center < -180) lng += 360;
    return { lng, lat: p.lat };
  }
}

export interface SelectionCallbacks {
  /** User finished drawing/editing (area) or deleted the selection (null). */
  onChange: (area: AreaFeature | null) => void;
  onToolChange: (tool: DrawTool) => void;
}

const isAreaFeature = (f: GeoJSONStoreFeatures) =>
  f.geometry.type === "Polygon" && SHAPES.includes(f.properties.mode as SelectionShape);

/**
 * Wraps Terra Draw: drawing tools, editing, single-selection policy and GeoJSON export.
 * Survives basemap switches via detach() (before the style changes) and attach() (after).
 */
export class SelectionManager {
  private draw: TerraDraw | null = null;
  private tool: DrawTool = "select";
  private parked: GeoJSONStoreFeatures[] = [];
  private pendingArea: Feature<Polygon> | null = null;
  private currentId: FeatureId | null = null;
  private selectionId: string | null = null;
  private counter = 0;
  private suppressDelete = false;
  private readonly callbacks: SelectionCallbacks;

  constructor(callbacks: SelectionCallbacks) {
    this.callbacks = callbacks;
  }

  attach(map: MapLibreMap): void {
    if (this.draw) return;
    const draw = new TerraDraw({
      adapter: new ContinuousLngAdapter(map, SELECTION_LAYER_PREFIX),
      modes: createModes(),
    });
    draw.start();
    draw.on("finish", this.handleFinish);
    draw.on("change", this.handleChange);
    this.draw = draw;

    if (this.parked.length > 0) {
      draw.addFeatures(this.parked);
      this.parked = [];
    }
    if (this.pendingArea) {
      const area = this.pendingArea;
      this.pendingArea = null;
      this.setArea(area);
    }
    draw.setMode(this.tool);
  }

  /** Removes Terra Draw from the map but keeps the selection for the next attach(). */
  detach(): void {
    const draw = this.draw;
    if (!draw) return;
    this.parked = draw
      .getSnapshot()
      .filter(isAreaFeature)
      .map((f) => ({ ...f, properties: { mode: f.properties.mode } }));
    draw.off("finish", this.handleFinish);
    draw.off("change", this.handleChange);
    try {
      draw.stop();
    } catch {
      // Layers may already be gone if the map was removed first.
    }
    this.draw = null;
  }

  get currentTool(): DrawTool {
    return this.tool;
  }

  setTool(tool: DrawTool): void {
    this.tool = tool;
    this.draw?.setMode(tool);
    this.callbacks.onToolChange(tool);
  }

  /** Current selection as exported GeoJSON, or null. */
  getArea(): AreaFeature | null {
    if (this.currentId == null || this.selectionId == null) return null;
    const f = this.draw
      ? this.draw.getSnapshotFeature(this.currentId)
      : this.parked.find((p) => p.id === this.currentId);
    if (!f || f.geometry.type !== "Polygon") return null;

    const { ring, bbox, crossesAntimeridian } = normalizeRing(f.geometry.coordinates[0]);
    return {
      type: "Feature",
      bbox,
      properties: {
        selectionId: this.selectionId,
        shape: f.properties.mode as SelectionShape,
        crossesAntimeridian,
        areaKm2: Math.round(geodesicAreaKm2(ring) * 10) / 10,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  }

  /** Programmatically sets the selection (does not fire onChange). Returns false if the geometry was rejected. */
  setArea(feature: Feature<Polygon>): boolean {
    const draw = this.draw;
    if (!draw) {
      this.pendingArea = feature;
      return true;
    }
    const ring = normalizeRing(feature.geometry.coordinates[0]).ring;
    const requested = feature.properties?.shape as SelectionShape | undefined;
    const candidates: SelectionShape[] =
      requested === "rectangle" || (!requested && isAxisAlignedRectangle(ring))
        ? ["rectangle", "polygon"]
        : [requested === "freehand" ? "freehand" : "polygon"];

    for (const mode of candidates) {
      const id = draw.getFeatureId();
      const [result] = draw.addFeatures([
        { id, type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { mode } },
      ]);
      if (result?.valid) {
        this.removeAreas((fid) => fid !== id);
        this.currentId = id;
        const given = feature.properties?.selectionId;
        this.selectionId = typeof given === "string" ? given : this.nextSelectionId();
        return true;
      }
      console.warn(`[MapWidget] initial area rejected as ${mode}:`, result?.reason);
    }
    return false;
  }

  /** Removes the selection. `notify` fires onChange(null). */
  clear(notify: boolean): void {
    this.removeAreas(() => true);
    this.parked = [];
    const had = this.currentId != null;
    this.currentId = null;
    this.selectionId = null;
    if (notify && had) this.callbacks.onChange(null);
  }

  private nextSelectionId(): string {
    this.counter += 1;
    return `area-${String(this.counter).padStart(3, "0")}`;
  }

  private removeAreas(predicate: (id: FeatureId) => boolean): void {
    const draw = this.draw;
    if (!draw) return;
    const ids = draw
      .getSnapshot()
      .filter(isAreaFeature)
      .map((f) => f.id as FeatureId)
      .filter(predicate);
    if (ids.length === 0) return;
    this.suppressDelete = true;
    try {
      draw.removeFeatures(ids);
    } finally {
      this.suppressDelete = false;
    }
  }

  private handleFinish: TerraDrawEventListeners["finish"] = (id, context) => {
    const draw = this.draw;
    if (!draw) return;

    if (context.action === "draw") {
      // Single-selection policy: a new drawing replaces the previous one.
      this.removeAreas((fid) => fid !== id);
      this.currentId = id;
      this.selectionId = this.nextSelectionId();
      this.callbacks.onChange(this.getArea());
      // Hand over to edit mode with the new shape selected (deferred: Terra Draw is mid-event).
      setTimeout(() => {
        if (this.draw !== draw || !draw.hasFeature(id)) return;
        this.setTool("select");
        draw.selectFeature(id);
      }, 0);
      return;
    }

    if (id === this.currentId) this.callbacks.onChange(this.getArea());
  };

  private handleChange: TerraDrawEventListeners["change"] = (ids, type) => {
    if (type !== "delete" || this.suppressDelete || this.currentId == null) return;
    if (!ids.includes(this.currentId)) return;
    this.currentId = null;
    this.selectionId = null;
    this.callbacks.onChange(null);
  };
}

function createModes() {
  const shapeStyle = {
    fillColor: ACCENT,
    fillOpacity: 0.06,
    outlineColor: ACCENT,
    outlineWidth: 2,
  } as const;
  const notSelfIntersecting = (f: GeoJSONStoreFeatures) => ValidateNotSelfIntersecting(f);

  return [
    new TerraDrawSelectMode({
      flags: {
        rectangle: { feature: { draggable: true, coordinates: { resizable: "opposite" } } },
        polygon: {
          feature: {
            draggable: true,
            validation: notSelfIntersecting,
            coordinates: { draggable: true, midpoints: true, deletable: true },
          },
        },
        freehand: { feature: { draggable: true, coordinates: { draggable: true, deletable: true } } },
      },
      styles: {
        selectedPolygonColor: ACCENT,
        selectedPolygonFillOpacity: 0.05,
        selectedPolygonOutlineColor: ACCENT,
        selectedPolygonOutlineWidth: 3,
        selectionPointColor: WHITE,
        selectionPointOutlineColor: ACCENT,
        selectionPointWidth: 5,
        selectionPointOutlineWidth: 2,
        midPointColor: ACCENT,
        midPointOutlineColor: WHITE,
        midPointWidth: 3,
        midPointOutlineWidth: 1,
      },
    }),
    new TerraDrawRectangleMode({ drawInteraction: "click-move-or-drag", styles: shapeStyle }),
    new TerraDrawPolygonMode({
      validation: notSelfIntersecting,
      styles: {
        ...shapeStyle,
        closingPointColor: WHITE,
        closingPointOutlineColor: ACCENT,
        closingPointWidth: 5,
        closingPointOutlineWidth: 2,
      },
    }),
    new TerraDrawFreehandMode({ styles: shapeStyle, validation: notSelfIntersecting }),
  ];
}
