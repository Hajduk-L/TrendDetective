# Map Widget – Integration Guide

The widget is a React component. The user picks a point, or one of the predefined regions
(Areas button), on a map; you get it as GeoJSON. There are no free drawing tools: an area is only
evaluated where there are enough measuring stations, so areas come from a fixed list (`regions`).
You send data back; the widget draws it on the same map.

```
user picks ──► MapWidget ──onAreaSelected(area)──► your page ──► Data Loader
                   ▲                                                  │
                   └──────────────── resultData ◄─────────────────────┘
```

All coordinates are `[longitude, latitude]` in WGS84.

---

## 1. Add it to the website

The website (`index.html`, served by `python3 app.py`) uses the **pre-built bundle** in
`static/map-widget/`. It contains React, MapLibre and the widget, so the page needs no Node or build step.

```html
<link rel="stylesheet" href="/static/map-widget/map-widget.css">
<script type="module" src="/static/map-widget/map-widget.js"></script>
<script type="module">
  const map = window.TrendDetectiveMap.mount(document.getElementById("map-widget"), {
    onAreaSelected: (area) => { /* send area to the Data Loader */ },
    onAreaCleared: () => { /* forget the area */ },
  });
  map.setRegions(regions);   // e.g. from GET /api/regions, see §3

  // later, when data arrives:
  map.setLoading(true);
  map.setResultData(data);   // see §4
  map.setLoading(false);
</script>
```

The element you mount into must have a size (the widget fills it).
This is already set up in `index.html` (box `.map-box`); the area is sent to Python with **Apply**
and ends up in `UserRequest.area`.

`mount(element, options)` returns a controller:

| Method | What it does |
|---|---|
| `setResultData(data)` | Show data (§4); `undefined` clears it. Same layers with new GeoJSON `data` (same `id`) are updated in place, which is smooth enough for animation |
| `setLoading(bool)` | Show / hide "Loading data…" |
| `getArea()` | Current point or region (§3) or `null` |
| `setArea(pointFeature)` | Select a point as if the user placed it (fires `onAreaSelected`); `false` for anything but a Point |
| `setRegions(regions)` | Regions offered by the Areas button: `[{id, name, bbox, note?}]` |
| `showRegions(bool)` | Show / hide the regions (same as the Areas button) |
| `clearArea()` | Remove the area |
| `fitToArea()` | Zoom to the area |
| `destroy()` | Remove the widget |

**After changing widget code**, rebuild the bundle and commit `static/map-widget/`:

```bash
cd map-widget && npm install && npm run build:embed
```

**In a React app** you can use the component directly instead: copy `map-widget/src/widget/`,
`npm install maplibre-gl terra-draw terra-draw-maplibre-gl-adapter`, and render
`<MapWidget onAreaSelected={…} resultData={…} loading={…} />` inside an element with a height
(example: [`src/demo/App.tsx`](src/demo/App.tsx)). This needs Vite.

---

## 2. What the widget needs (options / props)

| Prop | Type | Required | What it is |
|---|---|---|---|
| `onAreaSelected` | `(area: AreaFeature) => void` | **yes** (React) | Called when the user places or moves a point, or picks a region. |
| `onAreaCleared` | `() => void` | no | Called when the user deletes the selection. |
| `regions` | `Region[]` | no | Regions offered by the Areas button (bundle: `setRegions`). `{id, name, bbox, note?}`; `note` is shown on hover. |
| `resultData` | `MapData` or `MapData[]` | no | React only (bundle: `setResultData`). The data to show (§4). |
| `loading` | `boolean` | no | React only (bundle: `setLoading`). Shows "Loading data…". |
| `initialArea` | GeoJSON point feature | no | A point to show when the page opens. |
| `basemap` | `"streets"`, `"light"`, `"dark"`, `"satellite"` | no | Start map. Default `"streets"`. |
| `projection` | `"globe"` or `"mercator"` | no | Start view. Default `"globe"`. |

---

## 3. What the widget delivers: `AreaFeature`

`onAreaSelected` receives a GeoJSON Feature:

A picked **region**:

```json
{
  "type": "Feature",
  "bbox": [10.5, 47.5, 12.5, 49.5],
  "properties": {
    "selectionId": "bavaria",
    "shape": "region",
    "regionId": "bavaria",
    "name": "Bavaria",
    "crossesAntimeridian": false,
    "areaKm2": 32843
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[10.5, 47.5], [12.5, 47.5], [12.5, 49.5], [10.5, 49.5], [10.5, 47.5]]]
  }
}
```

The website sends it with **Apply**; `interface.py` sees `shape: "region"` and evaluates every
station in the region (`area_analysis.py`) instead of the station nearest to a point.

| Field | Meaning |
|---|---|
| `geometry` | The region's box (closed polygon, one ring), or a `Point` from the point tool. |
| `bbox` | `[west, south, east, north]`. Easiest input for most APIs. |
| `selectionId` | Same id while the user moves the point; new id for a new point. The region id for a region. |
| `shape` | `"point"` or `"region"`. |
| `regionId`, `name` | Only for a region: its id and name from `regions`. |
| `areaKm2` | Size of the area (`0` for a point). |
| `crossesAntimeridian` | `true` if the area spans the ±180° line. Then `bbox` has `west > east`. |

A **point** looks like this (`bbox` has zero size, longitude is wrapped to ±180):

```json
{
  "type": "Feature",
  "bbox": [13.4, 52.52, 13.4, 52.52],
  "properties": { "selectionId": "area-002", "shape": "point", "crossesAntimeridian": false, "areaKm2": 0 },
  "geometry": { "type": "Point", "coordinates": [13.4, 52.52] }
}
```

Check `geometry.type` before reading coordinates. There is only ever one area or point at a time.

---

## 4. What the widget needs back: `MapData`

Pick the type that matches your data.

### Points, lines, shapes – `geojson`

```ts
{ type: "geojson", data: featureCollection }
```

Optional `properties.color` per feature (e.g. `"#d7301f"`). Clicking a feature shows its properties.

Optional on the layer: `outline: false` hides polygon borders (for gapless fields such as
grid cells), `fillOpacity` sets the polygon fill opacity (default `0.45`), and `pointRadius`
sets the radius of point markers in pixels (default grows with zoom from 3 to 9).

To colour the whole selected area by one value (e.g. its mean trend), send the area itself:

```ts
{
  type: "geojson",
  data: { type: "FeatureCollection", features: [
    { type: "Feature", geometry: area.geometry, properties: { mean_trend: 0.42, color: "#ef8a62" } },
  ] },
}
```

### Map tiles – `raster`

```ts
{
  type: "raster",
  tiles: ["https://…/{z}/{x}/{y}.png"],   // Web Mercator XYZ tiles, e.g. NASA GIBS
  bounds: area.bbox,                      // optional: only load tiles here
  maxzoom: 7,                             // optional
}
```

### One image – `image`

```ts
{ type: "image", url: "https://…/picture.png", bounds: [west, south, east, north] }
```

Several layers at once: pass an array, e.g. `resultData={[rasterLayer, stationPoints]}`.

---

## 5. Optional (React): control it from your page

```tsx
const ref = useRef<MapWidgetHandle>(null);
<MapWidget ref={ref} … />

ref.current?.getArea();      // current area or null
ref.current?.clearArea();    // remove the area
ref.current?.fitToArea();    // zoom to the area
```
