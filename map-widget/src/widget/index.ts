// Public entry point of the Interactive Map Widget.
export { MapWidget } from "./MapWidget";
export { BASEMAPS } from "./basemaps";
export { splitAtAntimeridian, wrapLng, geodesicAreaKm2 } from "./geo";
export type {
  AreaFeature,
  AreaProperties,
  BasemapId,
  BBox,
  DrawTool,
  GeoJsonMapData,
  ImageMapData,
  MapData,
  MapWidgetHandle,
  MapWidgetProps,
  ProjectionType,
  RasterMapData,
  Region,
  SelectionShape,
} from "./types";
