import type { Feature, Point, Polygon } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  TerraDraw,
  TerraDrawFreehandMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawSelectMode,
  ValidateNotSelfIntersecting,
  type GeoJSONStoreFeatures,
  type TerraDrawEventListeners,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { geodesicAreaKm2, isAxisAlignedRectangle, normalizePoint, normalizeRing } from "./geo";
import type { AreaFeature, DrawTool, SelectionShape } from "./types";

/** Prefix of all MapLibre sources/layers created by Terra Draw. */
export const SELECTION_LAYER_PREFIX = "mw-sel";

const POLYGON_SHAPES: readonly SelectionShape[] = ["rectangle", "polygon", "freehand"];
const ACCENT = "#ff6b2c";
const WHITE = "#ffffff";

type FeatureId = string | number;

/**
 * Terra Draw mode for a toolbar tool. "select" (Pan) uses Terra Draw's built-in passive
 * "static" mode, so the selection is locked and clicks/drags only move the map; only the
 * "edit" tool turns on Terra Draw's select mode, where the shape can be moved and reshaped.
 */
function terraMode(tool: DrawTool): string {
  if (tool === "select") return "static";
  if (tool === "edit") return "select";
  return tool;
}

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

/** A selection drawn by one of our tools (polygon shapes or a single point). */
const isAreaFeature = (f: GeoJSONStoreFeatures) =>
  (f.geometry.type === "Polygon" && POLYGON_SHAPES.includes(f.properties.mode as SelectionShape)) ||
  (f.geometry.type === "Point" && f.properties.mode === "point");

/**
 * Wraps Terra Draw: drawing tools, editing, single-selection policy and GeoJSON export.
 * Survives basemap switches via detach() (before the style changes) and attach() (after).
 */
export class SelectionManager {
  private draw: TerraDraw | null = null;
  private tool: DrawTool = "select";
  private parked: GeoJSONStoreFeatures[] = [];
  private pendingArea: Feature<Polygon | Point> | null = null;
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
    this.applyMode();
  }

  /** Puts Terra Draw into the mode of the current tool; in edit mode the shape is pre-selected. */
  private applyMode(): void {
    const draw = this.draw;
    if (!draw) return;
    draw.setMode(terraMode(this.tool));
    if (this.tool === "edit" && this.currentId != null && draw.hasFeature(this.currentId)) {
      draw.selectFeature(this.currentId);
    }
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

  /** Switches the tool. "edit" without a selection falls back to "select" (Pan). */
  setTool(tool: DrawTool): void {
    this.tool = tool === "edit" && this.currentId == null ? "select" : tool;
    this.applyMode();
    this.callbacks.onToolChange(this.tool);
  }

  /** Current selection as exported GeoJSON, or null. */
  getArea(): AreaFeature | null {
    if (this.currentId == null || this.selectionId == null) return null;
    const f = this.draw
      ? this.draw.getSnapshotFeature(this.currentId)
      : this.parked.find((p) => p.id === this.currentId);
    if (!f) return null;

    if (f.geometry.type === "Point") {
      const coordinates = normalizePoint(f.geometry.coordinates);
      return {
        type: "Feature",
        bbox: [coordinates[0], coordinates[1], coordinates[0], coordinates[1]],
        properties: { selectionId: this.selectionId, shape: "point", crossesAntimeridian: false, areaKm2: 0 },
        geometry: { type: "Point", coordinates },
      };
    }
    if (f.geometry.type !== "Polygon") return null;

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
  setArea(feature: Feature<Polygon | Point>): boolean {
    const draw = this.draw;
    if (!draw) {
      this.pendingArea = feature;
      return true;
    }
    if (feature.geometry.type === "Point") {
      const id = draw.getFeatureId();
      const coordinates = normalizePoint(feature.geometry.coordinates);
      const [result] = draw.addFeatures([
        { id, type: "Feature", geometry: { type: "Point", coordinates }, properties: { mode: "point" } },
      ]);
      if (!result?.valid) {
        console.warn("[MapWidget] initial point rejected:", result?.reason);
        return false;
      }
      this.removeAreas((fid) => fid !== id);
      this.currentId = id;
      const given = feature.properties?.selectionId;
      this.selectionId = typeof given === "string" ? given : this.nextSelectionId();
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
    if (this.tool === "edit") this.setTool("select"); // nothing left to edit
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
      // Back to Pan with the new shape locked, so it cannot be moved by accident
      // (deferred: Terra Draw is mid-event). The Edit tool unlocks it.
      setTimeout(() => {
        if (this.draw !== draw) return;
        this.setTool("select");
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
    if (this.tool === "edit") setTimeout(() => this.setTool("select"), 0); // Terra Draw is mid-event
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
        point: { feature: { draggable: true } },
      },
      styles: {
        selectedPolygonColor: ACCENT,
        selectedPolygonFillOpacity: 0.05,
        selectedPolygonOutlineColor: ACCENT,
        selectedPolygonOutlineWidth: 3,
        selectedPointColor: ACCENT,
        selectedPointWidth: 7,
        selectedPointOutlineColor: WHITE,
        selectedPointOutlineWidth: 3,
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
    new TerraDrawPointMode({
      styles: { pointColor: ACCENT, pointWidth: 6, pointOutlineColor: WHITE, pointOutlineWidth: 2 },
    }),
  ];
}
