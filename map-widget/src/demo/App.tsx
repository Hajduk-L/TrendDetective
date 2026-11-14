// Demo host page: plays the role of the "Hauptfrontend" and wires the widget to a simulated Data Loader.
import { useRef, useState } from "react";
import { MapWidget, type AreaFeature, type MapData, type MapWidgetHandle } from "../widget";
import { MOCK_DATASETS, mockLoadData, type MockDataset } from "./mockDataLoader";
import "./App.css";

const INITIAL_AREA: AreaFeature = {
  type: "Feature",
  bbox: [6, 50, 8, 52],
  properties: { selectionId: "area-000", shape: "rectangle", crossesAntimeridian: false, areaKm2: 0 },
  geometry: {
    type: "Polygon",
    coordinates: [[[6, 50], [8, 50], [8, 52], [6, 52], [6, 50]]],
  },
};

export default function App() {
  const widget = useRef<MapWidgetHandle>(null);
  const [area, setArea] = useState<AreaFeature | null>(null);
  const [dataset, setDataset] = useState<MockDataset>("grid");
  const [result, setResult] = useState<MapData | undefined>();
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const requestId = useRef(0);

  const addLog = (msg: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...l].slice(0, 30));

  async function load(a: AreaFeature, ds: MockDataset) {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const data = await mockLoadData(a, ds);
      if (id !== requestId.current) return; // a newer request superseded this one
      setResult(data);
      addLog(`data loaded: ${ds}`);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  return (
    <div className="demo">
      <header className="demo-header">
        <h1>TrendDetective · Map Widget</h1>
        <span>Demo host with simulated Data Loader</span>
      </header>
      <main className="demo-main">
        <section className="demo-map">
          <MapWidget
            ref={widget}
            initialArea={INITIAL_AREA}
            onAreaSelected={(a) => {
              setArea(a);
              addLog(`onAreaSelected ${a.properties.selectionId} (${a.properties.shape})`);
              void load(a, dataset);
            }}
            onAreaCleared={() => {
              setArea(null);
              setResult(undefined);
              requestId.current++;
              setLoading(false);
              addLog("onAreaCleared");
            }}
            resultData={result}
            loading={loading}
          />
        </section>
        <aside className="demo-side">
          <label>
            Dataset (mock Data Loader)
            <select
              value={dataset}
              onChange={(e) => {
                const ds = e.target.value as MockDataset;
                setDataset(ds);
                const a = area ?? widget.current?.getArea();
                if (a) void load(a, ds);
              }}
            >
              {MOCK_DATASETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className="demo-actions">
            <button
              type="button"
              onClick={() => {
                const a = widget.current?.getArea();
                if (a) {
                  setArea(a);
                  void load(a, dataset);
                }
              }}
            >
              Load for current area
            </button>
            <button type="button" onClick={() => widget.current?.fitToArea()}>
              Zoom to area
            </button>
          </div>
          <h2>Selection (GeoJSON sent to Data Loader)</h2>
          <pre className="demo-json">{area ? JSON.stringify(area, null, 2) : "Draw an area on the map."}</pre>
          <h2>Events</h2>
          <pre className="demo-log">{log.join("\n") || "—"}</pre>
        </aside>
      </main>
    </div>
  );
}
