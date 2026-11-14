import type { StyleSpecification } from "maplibre-gl";
import type { BasemapId } from "./types";

/** NASA GIBS Blue Marble: public domain, no API key, global, tiles up to z8. */
const blueMarbleStyle: StyleSpecification = {
  version: 8,
  sources: {
    "blue-marble": {
      type: "raster",
      tiles: [
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
      ],
      tileSize: 256,
      maxzoom: 8,
      attribution:
        'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a> Blue Marble',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0b1d33" } },
    { id: "blue-marble", type: "raster", source: "blue-marble" },
  ],
};

/** All presets work without API keys (OpenFreeMap + NASA GIBS). */
export const BASEMAPS: Record<BasemapId, { label: string; style: string | StyleSpecification }> = {
  streets: { label: "Streets", style: "https://tiles.openfreemap.org/styles/liberty" },
  light: { label: "Light", style: "https://tiles.openfreemap.org/styles/positron" },
  dark: { label: "Dark", style: "https://tiles.openfreemap.org/styles/dark" },
  satellite: { label: "Blue Marble", style: blueMarbleStyle },
};

export function resolveBasemap(
  basemap: BasemapId | string | StyleSpecification,
): string | StyleSpecification {
  if (typeof basemap === "string" && basemap in BASEMAPS) {
    return BASEMAPS[basemap as BasemapId].style;
  }
  return basemap;
}
