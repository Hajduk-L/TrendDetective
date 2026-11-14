# Interactive Map Widget

React + TypeScript widget built on MapLibre GL JS and Terra Draw. Users pick a point or one of
the predefined regions with many measuring stations (Areas button); the widget hands it out as GeoJSON and shows the Data
Loader's results (GeoJSON vectors, raster tiles, images) on the same map.

- **[API.md](API.md)** – how to put the widget into the website: what it needs, what it delivers.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** – internal reference: libraries, architecture, how each part works, pitfalls.

## Run the demo

```bash
npm install
npm run dev
```

Open http://localhost:5173. The demo page (`src/demo/`) plays the main frontend and uses a
simulated Data Loader (`src/demo/mockDataLoader.ts`).

## Layout

| Path | Content |
|---|---|
| `src/widget/` | The widget, self-contained. Entry point `src/widget/index.ts`. |
| `src/widget/MapWidget.tsx` | React component and external interface |
| `src/widget/MapEngine.ts` | MapLibre setup, basemap, projection |
| `src/widget/SelectionManager.ts` | Terra Draw, drawing/editing, GeoJSON export |
| `src/widget/DataRenderer.ts` | Vector and raster result layers |
| `src/widget/geo.ts` | Antimeridian handling, area, ring normalisation |
| `src/demo/` | Demo host page and mock Data Loader |

## Notes

- Basemaps need no API key (OpenFreeMap, NASA GIBS Blue Marble).
- MapLibre v6 loads its web worker as a separate file. `MapEngine.ts` registers it via Vite's
  `?url` import; a non-Vite host bundler needs an equivalent asset import.
- Areas crossing the ±180° meridian are supported in both projections; see API.md §3.
