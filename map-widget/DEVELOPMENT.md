# Map Widget – Developer Reference

Internal notes for working on the widget: what is used, how it works, and what to watch out for.
For embedding the widget in the website, see [API.md](API.md).

---

## 1. Purpose and scope

- The widget lets a user select **one** area on a world map and returns it as GeoJSON.
- It draws the Data Loader's results on the same map.
- It knows nothing about NASA APIs or the rest of the website. Everything goes through props and callbacks.
- Based on the team spec "Technische Spezifikation – Interactive Map Widget". We extended it with
  the `image` data type, `onAreaCleared`, a `ref` handle, and extra area properties.

## 2. Commands

Run these in `map-widget/`:

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Demo at http://localhost:5173 (also startable from the app via `.claude/launch.json`) |
| `npx tsc -b` | Type check |
| `npm run lint` | oxlint |
| `npm run build` | Production build of the demo to `dist/` (type check + Vite) |
| `npm run build:embed` | **Website bundle** → `../static/map-widget/` (commit the result!) |

There are no automated tests yet. Checks are done by hand in the demo (see §12).

## 3. Stack

| Package | Version | Used for |
|---|---|---|
| `react`, `react-dom` | 19.3 | Component. Uses React 19 `ref` as a prop. |
| `maplibre-gl` | 6.18 | Map engine: globe/mercator, sources, layers, popups |
| `terra-draw` | 1.39 | Drawing and editing shapes |
| `terra-draw-maplibre-gl-adapter` | 1.5 | Connects Terra Draw to MapLibre |
| `vite` | 8.3 | Dev server and build |
| `typescript` | 7.0 | Types (`erasableSyntaxOnly`: no `enum`, no constructor parameter properties) |
| `@types/geojson` | – | GeoJSON types |

Basemaps need no API key: **OpenFreeMap** (vector styles liberty/positron/dark) and **NASA GIBS Blue Marble** (raster, tiles up to z8).

## 4. Folder layout

```
TrendDetective/
├── app.py, interface.py   Python website server (team), serves index.html and static/
├── index.html             website; mounts the widget into the map box (.map-box)
├── static/map-widget/     built widget bundle (npm run build:embed) — generated, but committed
└── map-widget/
├── API.md                 integration guide (for the website team)
├── DEVELOPMENT.md         this file
├── src/
│   ├── main.tsx           mounts the demo
│   ├── embed.tsx          website entry: window.TrendDetectiveMap.mount(el, options)
│   ├── demo/              demo host page ("Hauptfrontend" stand-in)
│   │   ├── App.tsx        wires widget ↔ mock loader, event log
│   │   └── mockDataLoader.ts  fake Data Loader: mean-trend fill / stations / MODIS raster
│   └── widget/            THE WIDGET — self-contained, no imports from outside
│       ├── index.ts       public exports
│       ├── types.ts       all public types (props, AreaFeature, MapData…)
│       ├── MapWidget.tsx  React component: wiring, toolbar, status line
│       ├── MapWidget.css  styles, all scoped under .mw-root
│       ├── MapEngine.ts   MapLibre: map, controls, basemap, projection, camera
│       ├── SelectionManager.ts  Terra Draw: tools, editing, single selection, export
│       ├── DataRenderer.ts      result layers: geojson / raster / image, popups
│       ├── geo.ts         ring normalisation, antimeridian, area, split
│       └── basemaps.ts    basemap presets
```

Rule: `src/widget/` must never import from `src/demo/` or the website.

## 5. Website integration

- The website is plain HTML + Python (`http.server`), no React and no build step. It loads
  `static/map-widget/map-widget.{js,css}`, built from `src/embed.tsx` by `vite.embed.config.ts`.
- The bundle contains React, MapLibre, Terra Draw and the widget (~1.5 MB, ~400 KB gzipped). The
  MapLibre worker is a separate file (`maplibre-gl-worker.mjs`), found relative to `map-widget.js`
  (`base: './'`), so the folder can be served from any path.
- `embed.tsx` renders a small `Host` component that keeps `resultData`/`loading` in React state, so
  plain JS can update them through the controller (`setResultData`, `setLoading`, …).
- `index.html` keeps the selected area in `selectedArea` and adds it as `area` to the Apply POST.
  `app.py` passes it to `AppInterface.set_request_inputs(..., area=...)` and it is stored in
  `UserRequest.area` (GeoJSON dict or `None`; optional, old requests without it still work).
- **`app.py` must use `ThreadingHTTPServer`.** With the single-threaded `HTTPServer` the map never
  loads: browsers open spare connections in advance, an idle one blocks the server, and the
  parallel worker requests hang (globe stays blank, no error).
- The box: `.map-box` (relative, `min-height: 480px`) with `#map-widget` absolutely filling it.
  `.main-content` needs `min-width: 0`, otherwise the map canvas squeezes the sidebar.
- **Time player** (`index.html`, data panel): `/api/map-data` returns per topic `frames.values`
  (one value per cell per timestamp, cells in feature order) and `frames.legend` (one scale for
  the whole window). The page recolours the grid in JS (`frameLayer`, `colorFromStops`) and calls
  `setResultData` with the same layer id, so the widget swaps data in place. `frameIndex === null`
  is the mean view. Play steps at 1–16 steps/s and stops at the last timestamp. A small SVG chart
  (`drawSeries`) shows `series` (area mean, or the point's values) with a cursor at the current
  frame; clicking or dragging on it seeks.
- **Point requests**: `map_data` sends one API request for a `Point` selection instead of one per
  grid cell. Result per topic: `kind: "point"`, one Point feature with `pointRadius: 16` (a ring of
  colour around the orange selection marker), `cells: 1`, `resolution_deg: null`. Mean view and
  frames share one colour scale built from the values over time. Area results have `kind: "area"`.
  Intervals without data are `null` and drawn grey.
- **Remember**: after changing anything in `src/widget/`, run `npm run build:embed` and commit
  `static/map-widget/`, otherwise the website keeps the old version.

## 6. Architecture

```
MapWidget.tsx (React)
 ├── MapEngine          owns the maplibregl.Map
 ├── SelectionManager   owns the TerraDraw instance   (attached to engine.map)
 └── DataRenderer       owns result sources/layers    (attached to engine.map)
```

The three modules don't know about each other. `MapWidget` connects them with callbacks.

### Lifecycle

**Mount** (effect runs once; React StrictMode mounts twice in dev, which is fine):
1. `new MapEngine(...)` creates the map with the start basemap.
2. `new SelectionManager(...)` and `new DataRenderer(...)` are created but not drawn yet.
3. On every `style.load`, `MapEngine` applies the projection and calls `onStyleReady`. Then:
   - `renderer.reapply()` adds the data layers.
   - `selection.attach(map)` starts Terra Draw. Its layers come last, so they sit on top.
   - The first time only, `initialArea` is set and the map zooms to it.

**Basemap switch** (`engine.setStyle`):
1. `onBeforeStyleChange` → `selection.detach()` parks the selection and stops Terra Draw; `renderer.suspend()`.
2. `map.setStyle(style, { diff: false })` — `diff:false` forces a full reload, so `style.load` fires.
3. `style.load` → same as mount step 3. The parked selection and current data come back.

**Unmount**: `selection.detach()` → `renderer.destroy()` → `engine.destroy()` (`map.remove()`).

**Props after mount**:
- `resultData` → `renderer.setData()`.
- `basemap` / `projection` → engine.
- Callbacks are read from `propsRef`, so changing them doesn't rebuild the map.
- `initialArea` is read only once.

## 7. MapEngine

- Creates the map with center `[10, 25]`, zoom 1.4, `renderWorldCopies: true`, compact attribution, navigation control (top right) and scale bar (bottom left).
- **Worker fix**: MapLibre v6 loads its worker from a separate file found relative to `import.meta.url`. Vite's dependency pre-bundling breaks that path ("Worker failed to load"). We import `maplibre-gl/dist/maplibre-gl-worker.mjs?url` and call `setWorkerUrl()`. This works in dev and production. A non-Vite bundler needs its own asset import here.
- The projection is part of the style in MapLibre 5+, so it's set again after every style load.
- `fitToBBox` handles `west > east` by adding 360 to east.
- `firstBasemapSymbolLayerId` finds the first label layer of the basemap, so data can go below labels.

## 8. SelectionManager (Terra Draw)

### Tools and modes
| Tool | Terra Draw mode | Interaction |
|---|---|---|
| `select` ("Pan", default) | built-in `static` mode | Pan the map only. The selection is locked: clicking or dragging it moves the map, not the area |
| `edit` ("Edit" toggle, needs a selection) | `TerraDrawSelectMode` | The area is pre-selected; drag it, drag corners or vertices; Delete key removes it. Esc or the toggle locks it again |
| `rectangle` | `TerraDrawRectangleMode` (`click-move-or-drag`) | Drag, or click twice |
| `polygon` | `TerraDrawPolygonMode` | Click corners; click the first point or press Enter to finish; Esc cancels |
| `freehand` | `TerraDrawFreehandMode` | Click, move, click |
| `point` | `TerraDrawPointMode` | Click once |

`terraMode()` maps tools to Terra Draw modes. Locking by default prevents moving the area by accident while panning.

Edit rules per shape (select-mode `flags`, edit tool only):
- **rectangle**: move it, or resize it from the opposite corner.
- **polygon**: move it, drag/add/delete vertices.
- **freehand**: move it, drag/delete vertices.
- **point**: drag it. Exported via `normalizePoint` (rounded, longitude wrapped, latitude clamped), `areaKm2: 0`, zero-size `bbox`; `fitToArea` zooms to it (capped at `maxZoom` 9).

Polygon and freehand reject self-intersecting shapes (`ValidateNotSelfIntersecting`).

### Behaviour
- **One area at a time.** When a drawing finishes (`finish` with `action === "draw"`), all other areas are removed. Removal sets `suppressDelete`, so it doesn't fire "cleared".
- After drawing, the tool switches back to `select` (Pan) with the new area locked. This runs in a `setTimeout(0)`, because Terra Draw is still handling its own event.
- Deleting the area while editing switches back to `select` (nothing left to edit).
- **Edits** (`finish` with any other action on the current feature) fire `onAreaSelected` again with the same `selectionId`.
- **Delete** (`change` event of type `delete` for the current feature) fires `onAreaCleared`.
- `selectionId` comes from a counter: `area-001`, `area-002`, … Terra Draw's own UUIDs stay internal.
- **Basemap switch**: `detach()` saves the area features (properties stripped to `{ mode }`) and `attach()` adds them back with the same ids.
- `setArea()` (used for `initialArea`) tries rectangle mode for axis-aligned rectangles, else polygon. It returns `false` if Terra Draw rejects the geometry.

### Export (`getArea` → `geo.normalizeRing`)
1. Round to 6 decimals and clamp latitude to ±90.
2. Close the ring.
3. Shift the whole ring by a multiple of 360° so its centre is within ±180.
4. Make it counter-clockwise (RFC 7946).
5. Compute `bbox`. If the ring goes past ±180, set `crossesAntimeridian = true` and use a wrapped bbox with `west > east` (RFC 7946 §5.2).
6. Compute `areaKm2` with the spherical ring-area formula.

### Antimeridian
- **Mercator**: MapLibre's `unproject` already returns continuous longitudes across world copies (e.g. 196°).
- **Globe**: MapLibre returns wrapped longitudes. `ContinuousLngAdapter` (a subclass of the Terra Draw adapter) shifts each longitude to within ±180° of the view centre, so a shape drawn across 180° stays in one piece.
- The exported ring therefore stays **continuous** (values like −197.9 can appear). `splitAtAntimeridian()` in `geo.ts` cuts it into a MultiPolygon within ±180 for consumers that need that.
- Terra Draw's `addFeatures` validation rejects longitudes outside ±180. So an `initialArea` that crosses 180° in continuous form can't be loaded (a warning is logged). Drawing interactively works.

## 9. DataRenderer

- Layer and source ids: `mw-data-<index>-<id|type>-<suffix>`. The selection uses `mw-sel-*`. Host styles must not use these prefixes.
- **Order**: data goes below the first basemap label layer if there is one, otherwise below the selection layer. The selection is always on top.
- `setData()` normally removes all previous data layers and rebuilds them. **Exception**: if the new list
  has the same layers (same length, type, id and options) and only GeoJSON `data` differs, it calls
  `source.setData()` in place. Layers and an open popup stay, so animation frames (the website's time
  player) don't flicker. Keep the layer `id` stable between frames to get this path.
- **geojson**: three layers (fill / line / circle) filtered by geometry type. Colour = `properties.color`, or blue if missing.
- **raster**: raster source. `bounds` limits which tiles are **requested**; it does not cut tiles at the box edge. Antimeridian bounds get +360 on east.
- **image**: image source stretched over the four corners. The image must be in Web Mercator. EPSG:4326 images drift in latitude over large areas.
- **Popups**: click on geojson features in the `select` tool → table of properties (except `color`). They are off while a drawing tool is active.

## 10. Area colouring (no mesh)

- The area is coloured with plain `geojson` data: the Data Loader sends the selected polygon
  (`area.geometry`) with `properties.color`, and it is drawn as one fill with one colour.
- The demo's "Mean trend" dataset does this: it averages a synthetic trend over points inside the
  area and maps it blue–white–red (`trendColor` in `mockDataLoader.ts`).
- A triangle-mesh fill with border refinement was tried and removed (commit `a27a2ee`, reverted
  afterwards) because the refinement didn't behave as wanted. Use that commit as a starting point
  if it comes back.

## 11. Styling / UI

- All CSS is scoped under `.mw-root`, plus `.mw-popup` for popups. Accent colour `#ff6b2c`.
- The selection fill is very light (6 % while drawing, 5 % when selected), so it doesn't tint the data colours.
- Toolbar on the left; basemap and projection panel at top left; status line at the bottom (area id, size, hint for the current tool); loading badge at the top.
- Below 560 px width the panel and status line move so they don't overlap.

## 12. Manual test checklist

Run `npm run dev`, then in the demo:

1. The map loads (no "Worker failed to load" in the console); the initial rectangle over NRW is visible.
2. Draw a rectangle, a polygon (also a concave one) and a freehand shape → each fires `onAreaSelected`, the old area disappears, and data loads.
3. In Pan: dragging over the area moves the map, not the area. Turn on Edit: drag a corner or the whole area → the event fires again with the same `selectionId`; Esc locks it again.
4. Trash button → `onAreaCleared`, data disappears.
5. Switch basemap (Streets → Blue Marble) → the area and data stay.
6. Globe ↔ Flat; draw across 180° in both → `crossesAntimeridian: true`, `bbox` west > east.
7. Mean trend dataset: the whole area is filled with one colour; clicking it shows the mean value.
8. MODIS raster and stations datasets load; clicking a feature opens a popup.
9. `npm run build:embed`, then `python3 app.py` and open http://127.0.0.1:8000: the globe renders in
   the map box; draw an area, fill the sidebar, click Apply → the status card shows `area=area-…`.

## 13. Known limitations / ideas

- The whole widget ships as one ~1.5 MB JS chunk (mostly MapLibre). It could be lazy-loaded by the host.
- Only one selection at a time. Multiple selections would need `onAreaSelected` to handle a list.
- An `initialArea` crossing the antimeridian can't be loaded (Terra Draw validation, §8).
- No automated tests. `geo.ts` is pure functions and is and the easiest place to start (e.g. with Vitest).
- Raster tiles stick out past `bounds`. Exact clipping would need a mask layer.
