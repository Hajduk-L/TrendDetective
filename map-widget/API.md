# Map Widget – Integration Guide

The widget is a React component. The user draws an area on a map; you get that area as GeoJSON.
You send data back; the widget draws it on the same map.

```
user draws ──► MapWidget ──onAreaSelected(area)──► your page ──► Data Loader
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
| `setResultData(data)` | Show data (§4); `undefined` clears it |
| `setLoading(bool)` | Show / hide "Loading data…" |
| `getArea()` | Current area (§3) or `null` |
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
| `onAreaSelected` | `(area: AreaFeature) => void` | **yes** (React) | Called when the user finishes drawing or editing an area. |
| `onAreaCleared` | `() => void` | no | Called when the user deletes the area. |
| `resultData` | `MapData` or `MapData[]` | no | React only (bundle: `setResultData`). The data to show (§4). |
| `loading` | `boolean` | no | React only (bundle: `setLoading`). Shows "Loading data…". |
| `initialArea` | GeoJSON polygon feature | no | An area to show when the page opens. |
| `basemap` | `"streets"`, `"light"`, `"dark"`, `"satellite"` | no | Start map. Default `"streets"`. |
| `projection` | `"globe"` or `"mercator"` | no | Start view. Default `"globe"`. |

---

## 3. What the widget delivers: `AreaFeature`

`onAreaSelected` receives a GeoJSON Feature:

```json
{
  "type": "Feature",
  "bbox": [6.0, 50.0, 8.0, 52.0],
  "properties": {
    "selectionId": "area-001",
    "shape": "rectangle",
    "crossesAntimeridian": false,
    "areaKm2": 31193.4
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[6.0, 50.0], [8.0, 50.0], [8.0, 52.0], [6.0, 52.0], [6.0, 50.0]]]
  }
}
```

| Field | Meaning |
|---|---|
| `geometry` | The drawn area. Closed polygon, one ring. |
| `bbox` | `[west, south, east, north]`. Easiest input for most APIs. |
| `selectionId` | Same id while the user edits the area; new id for a new area. |
| `shape` | `"rectangle"`, `"polygon"` or `"freehand"`. |
| `areaKm2` | Size of the area. |
| `crossesAntimeridian` | `true` if the area spans the ±180° line. Then `bbox` has `west > east`. |

There is only ever one area at a time.

---

## 4. What the widget needs back: `MapData`

Pick the type that matches your data.

### Points, lines, shapes – `geojson`

```ts
{ type: "geojson", data: featureCollection }
```

Optional `properties.color` per feature (e.g. `"#d7301f"`). Clicking a feature shows its properties.

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
