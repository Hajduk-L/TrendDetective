import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import type { StyleSpecification } from "maplibre-gl";
import type { CSSProperties } from "react";

/** [west, south, east, north] in WGS84 degrees. If west > east the box crosses the antimeridian (RFC 7946 §5.2). */
export type BBox = [west: number, south: number, east: number, north: number];

/** How the selection was made: a single point, or one of the predefined evaluation regions. */
export type SelectionShape = "point" | "region";

/**
 * A predefined evaluation region: a box in which there are enough measuring stations to
 * evaluate an area instead of a single point. Supplied by the host page (e.g. `/api/regions`).
 */
export interface Region {
  /** Stable id, sent back as `properties.regionId` of the selection. */
  id: string;
  name: string;
  /** [west, south, east, north]. */
  bbox: BBox;
  /** Short text shown on hover, e.g. how many stations the region has. */
  note?: string;
  /**
   * Outline of the region's measuring stations (convex hull with a border). Drawn
   * instead of the box when given, so the user sees which area the stations cover.
   */
  outline?: Polygon;
}

export interface AreaProperties {
  /** Stable id of the selection; stays the same while the user edits it. */
  selectionId: string;
  /** How the area was drawn. */
  shape: SelectionShape;
  /**
   * True if the area crosses the ±180° meridian. The ring is then kept continuous,
   * so some longitudes lie outside [-180, 180]. Use `feature.bbox` (west > east) or
   * `splitAtAntimeridian()` if the consumer needs strictly wrapped coordinates.
   */
  crossesAntimeridian: boolean;
  /** Geodesic area in km² (spherical approximation). 0 for a point. */
  areaKm2: number;
  [key: string]: unknown;
}

/**
 * The selection handed to `onAreaSelected`: an area (Polygon) or a single location (Point).
 * Polygon: closed, counter-clockwise ring. Coordinates [longitude, latitude] in WGS84 (EPSG:4326).
 * A point has `shape: "point"`, wrapped longitude, `areaKm2: 0` and a zero-size `bbox`.
 * `bbox` is always set.
 */
export type AreaFeature = Feature<Polygon | Point, AreaProperties> & { bbox: BBox };

interface MapDataBase {
  /** Optional stable id; used for layer ids and popups. */
  id?: string;
  /** Layer opacity 0..1. */
  opacity?: number;
}

/**
 * Vector results. Points, lines and polygons are drawn automatically.
 * A feature may set `properties.color` (any CSS color) to override the default color.
 */
export interface GeoJsonMapData extends MapDataBase {
  type: "geojson";
  data: FeatureCollection;
  /** Draw polygon outlines. Default true; set false for gapless fields such as grid cells. */
  outline?: boolean;
  /** Fill opacity of polygons 0..1 (multiplied by `opacity`). Default 0.45. */
  fillOpacity?: number;
  /** Radius of point markers in pixels. Default grows with zoom from 3 to 9. */
  pointRadius?: number;
}

/** Raster tiles (XYZ, Web Mercator / EPSG:3857 tile grid). `{z}/{x}/{y}` placeholders in the URL. */
export interface RasterMapData extends MapDataBase {
  type: "raster";
  tiles: string[];
  /** Restricts tile requests to this box. */
  bounds?: BBox;
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

/**
 * A single georeferenced image stretched over `bounds`.
 * The image should be in Web Mercator; an equirectangular (EPSG:4326) image will be
 * misaligned in latitude over large areas.
 */
export interface ImageMapData extends MapDataBase {
  type: "image";
  url: string;
  bounds: BBox;
}

export type MapData = GeoJsonMapData | RasterMapData | ImageMapData;

export type ProjectionType = "globe" | "mercator";

export type BasemapId = "streets" | "light" | "dark" | "satellite";

/**
 * Toolbar tools. "select" is Pan: the selection is locked, clicks and drags only move the map.
 * "edit" unlocks a point so it can be moved (needs a point). Areas are not drawn but picked
 * from the predefined regions (the Areas button).
 */
export type DrawTool = "select" | "edit" | "point";

export interface MapWidgetProps {
  /** Selection shown when the widget mounts (not echoed back via `onAreaSelected`). */
  initialArea?: Feature<Point>;
  /** Called when the user finishes drawing or editing an area. */
  onAreaSelected: (area: AreaFeature) => void;
  /** Called when the user deletes the selection. */
  onAreaCleared?: () => void;
  /** Data from the Data Loader. A single dataset or several layered ones (first = bottom). */
  resultData?: MapData | MapData[];
  /** Shows a loading indicator over the map. */
  loading?: boolean;
  /** Basemap preset, a style URL, or a full MapLibre style object. Default: "streets". */
  basemap?: BasemapId | string | StyleSpecification;
  /** Default: "globe". */
  projection?: ProjectionType;
  /** Predefined regions offered by the Areas button. */
  regions?: Region[];
  /** Hide the built-in toolbar (e.g. if the host page provides its own controls via the ref). */
  hideToolbar?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Imperative API available via `ref`. */
export interface MapWidgetHandle {
  getArea: () => AreaFeature | null;
  clearArea: () => void;
  fitToArea: () => void;
  /** Zoom the map to a bounding box, e.g. one covering the selection and the result data. */
  fitToBounds: (bbox: BBox) => void;
  setTool: (tool: DrawTool) => void;
  /**
   * Select a point, as if the user had placed it (fires `onAreaSelected`). Returns false for
   * anything but a Point: areas can only be picked from the predefined regions.
   */
  setArea: (feature: Feature) => boolean;
  /** Show or hide the predefined regions (same as the Areas button). */
  showRegions: (visible: boolean) => void;
}
