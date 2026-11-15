import "maplibre-gl/dist/maplibre-gl.css";
import "./MapWidget.css";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Feature, Point } from "geojson";
import type { StyleSpecification } from "maplibre-gl";
import { BASEMAPS, resolveBasemap } from "./basemaps";
import { DataRenderer, DATA_LAYER_PREFIX } from "./DataRenderer";
import { MapEngine } from "./MapEngine";
import { regionGeometry, RegionLayer, REGION_LAYER_PREFIX } from "./RegionLayer";
import { SelectionManager, SELECTION_LAYER_PREFIX } from "./SelectionManager";
import { geodesicAreaKm2 } from "./geo";
import type {
  AreaFeature,
  BasemapId,
  DrawTool,
  MapWidgetHandle,
  MapWidgetProps,
  ProjectionType,
  Region,
} from "./types";

const TOOLS: { id: DrawTool; label: string; hint: string; icon: string }[] = [
  {
    id: "select",
    label: "Pan",
    hint: "Drag to pan. The point is locked; use Edit to move it.",
    icon: "M12 2l3 3h-2v4h-2V5H9zm0 20l-3-3h2v-4h2v4h2zM2 12l3-3v2h4v2H5v2zm20 0l-3 3v-2h-4v-2h4V9z",
  },
  {
    id: "point",
    label: "Point",
    hint: "Click to pick a single location.",
    icon: "M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
  },
];

const AREAS_ICON = "M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm8-2h8v8h-8z";
const AREAS_HINT = "Click a highlighted region to evaluate all measuring stations inside it.";
const TRASH_ICON = "M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z";
const EDIT_ICON =
  "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z";
const EDIT_HINT = "Editing: drag the point to move it. Esc or Edit again to lock it.";

function isBasemapId(b: unknown): b is BasemapId {
  return typeof b === "string" && b in BASEMAPS;
}

/**
 * Interactive map widget: pick a point or one of the predefined regions (exported as GeoJSON
 * via `onAreaSelected`) and show Data Loader results (`resultData`) as map layers.
 */
export function MapWidget(props: MapWidgetProps & { ref?: Ref<MapWidgetHandle> }) {
  const {
    initialArea,
    resultData,
    loading = false,
    basemap: basemapProp = "streets",
    projection: projectionProp = "globe",
    regions,
    hideToolbar = false,
    className,
    style,
    ref,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const selectionRef = useRef<SelectionManager | null>(null);
  const rendererRef = useRef<DataRenderer | null>(null);
  const regionLayerRef = useRef<RegionLayer | null>(null);
  // Latest callbacks without re-initialising the map.
  const propsRef = useRef(props);
  propsRef.current = props;

  const [tool, setTool] = useState<DrawTool>("select");
  const [area, setArea] = useState<AreaFeature | null>(null);
  const [showRegions, setShowRegions] = useState(false);
  const showRegionsRef = useRef(showRegions);
  showRegionsRef.current = showRegions;
  // The picked region; null while a point (or nothing) is selected.
  const regionRef = useRef<AreaFeature | null>(null);
  const [basemap, setBasemap] = useState<BasemapId | string | StyleSpecification>(basemapProp);
  const [projection, setProjection] = useState<ProjectionType>(projectionProp);

  useEffect(() => setBasemap(basemapProp), [basemapProp]);
  useEffect(() => setProjection(projectionProp), [projectionProp]);

  // ---- Map lifecycle (once) ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new MapEngine({ container, style: resolveBasemap(basemap), projection });
    const selection = new SelectionManager({
      onChange: (next) => {
        if (next) {
          // A point replaces a picked region.
          regionRef.current = null;
          regionLayer.setSelected(null);
        } else if (regionRef.current) {
          return; // the point was removed because a region was picked
        }
        setArea(next);
        if (next) propsRef.current.onAreaSelected(next);
        else propsRef.current.onAreaCleared?.();
      },
      onToolChange: (t) => {
        setTool(t);
        if (t !== "select") setShowRegions(false);
      },
    });
    const regionLayer = new RegionLayer(engine.map, {
      beforeLayerId: () =>
        engine.firstBasemapSymbolLayerId([DATA_LAYER_PREFIX, SELECTION_LAYER_PREFIX, REGION_LAYER_PREFIX]),
      onPick: (region) => {
        const feature = regionFeature(region);
        regionRef.current = feature;
        selection.clear(false);
        regionLayer.setSelected(region.id);
        setShowRegions(false);
        setArea(feature);
        engine.fitToBBox(region.bbox);
        propsRef.current.onAreaSelected(feature);
      },
    });
    const renderer = new DataRenderer(engine.map, {
      beforeLayerId: () =>
        engine.firstBasemapSymbolLayerId([DATA_LAYER_PREFIX, SELECTION_LAYER_PREFIX, REGION_LAYER_PREFIX]) ??
        (engine.map.getLayer(`${SELECTION_LAYER_PREFIX}-polygon`) ? `${SELECTION_LAYER_PREFIX}-polygon` : undefined),
      // Results lie inside the selection, so popups may open on top of it; only drawing tools suppress them.
      popupsEnabled: () => selection.currentTool === "select" && !showRegionsRef.current,
    });

    let first = true;
    engine.onBeforeStyleChange(() => {
      selection.detach();
      renderer.suspend();
      regionLayer.suspend();
    });
    engine.onStyleReady(() => {
      regionLayer.reapply();
      renderer.reapply();
      selection.attach(engine.map); // after data, so the selection is drawn on top
      if (first) {
        first = false;
        const initial = propsRef.current.initialArea;
        if (initial && selection.setArea(initial)) {
          const a = selection.getArea();
          setArea(a);
          if (a) engine.fitToBBox(a.bbox);
        }
      }
    });

    engineRef.current = engine;
    selectionRef.current = selection;
    rendererRef.current = renderer;
    regionLayerRef.current = regionLayer;

    return () => {
      selection.detach();
      renderer.destroy();
      regionLayer.destroy();
      regionLayerRef.current = null;
      engine.destroy();
      engineRef.current = null;
      selectionRef.current = null;
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- map is created once; props flow in via the effects below
  }, []);

  // ---- Basemap / projection ----
  const appliedBasemap = useRef(basemap);
  useEffect(() => {
    if (appliedBasemap.current === basemap) return;
    appliedBasemap.current = basemap;
    engineRef.current?.setStyle(resolveBasemap(basemap));
  }, [basemap]);

  useEffect(() => {
    engineRef.current?.setProjection(projection);
  }, [projection]);

  // ---- Regions ----
  useEffect(() => {
    regionLayerRef.current?.setRegions(regions ?? []);
  }, [regions]);

  useEffect(() => {
    regionLayerRef.current?.setVisible(showRegions);
  }, [showRegions]);

  // ---- Result data ----
  useEffect(() => {
    const list = resultData == null ? [] : Array.isArray(resultData) ? resultData : [resultData];
    rendererRef.current?.setData(list);
    regionLayerRef.current?.setSelectedHidden(list.some((d) => d.id === "area-result"));
  }, [resultData]);

  // ---- Imperative API ----
  useImperativeHandle(
    ref,
    (): MapWidgetHandle => ({
      getArea: () => regionRef.current ?? selectionRef.current?.getArea() ?? null,
      clearArea: () => {
        regionRef.current = null;
        regionLayerRef.current?.setSelected(null);
        selectionRef.current?.clear(false);
        setArea(null);
      },
      fitToArea: () => {
        const a = regionRef.current ?? selectionRef.current?.getArea();
        if (a) engineRef.current?.fitToBBox(a.bbox);
      },
      fitToBounds: (bbox) => engineRef.current?.fitToBBox(bbox),
      setTool: (t) => selectionRef.current?.setTool(t),
      setArea: (feature) => {
        const selection = selectionRef.current;
        if (!selection || feature.geometry?.type !== "Point") return false;
        if (!selection.setArea(feature as Feature<Point>)) return false;
        regionRef.current = null;
        regionLayerRef.current?.setSelected(null);
        setShowRegions(false);
        const next = selection.getArea();
        setArea(next);
        if (next) propsRef.current.onAreaSelected(next);
        return next != null;
      },
      showRegions: (visible) => setShowRegions(visible),
    }),
    [],
  );

  // Esc leaves edit mode and locks the selection again.
  useEffect(() => {
    if (tool !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selectionRef.current?.setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  const hint = showRegions ? AREAS_HINT : tool === "edit" ? EDIT_HINT : TOOLS.find((t) => t.id === tool)?.hint;
  const isRegion = area?.properties.shape === "region";

  const toggleRegions = () => {
    if (!showRegions) selectionRef.current?.setTool("select");
    setShowRegions(!showRegions);
  };

  const deleteSelection = () => {
    if (regionRef.current) {
      regionRef.current = null;
      regionLayerRef.current?.setSelected(null);
      setArea(null);
      propsRef.current.onAreaCleared?.();
      return;
    }
    selectionRef.current?.clear(true);
  };
  void initialArea; // consumed once on mount via propsRef

  return (
    <div className={`mw-root${className ? ` ${className}` : ""}`} style={style}>
      <div ref={containerRef} className="mw-map" />

      {!hideToolbar && (
        <>
          <div className="mw-toolbar" role="toolbar" aria-label="Selection tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="mw-btn"
                aria-pressed={tool === t.id && !showRegions}
                aria-label={t.label}
                title={t.label}
                onClick={() => {
                  setShowRegions(false);
                  selectionRef.current?.setTool(t.id);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
              </button>
            ))}
            <button
              type="button"
              className="mw-btn"
              aria-pressed={showRegions}
              aria-label="Areas"
              title={
                regions && regions.length > 0
                  ? "Areas: show the regions with enough measuring stations to evaluate an area"
                  : "Areas: no regions loaded"
              }
              disabled={!regions || regions.length === 0}
              onClick={toggleRegions}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={AREAS_ICON} />
              </svg>
            </button>
            <span className="mw-sep" />
            <button
              type="button"
              className="mw-btn"
              aria-pressed={tool === "edit"}
              aria-label="Edit point"
              title={tool === "edit" ? "Lock the point (Esc)" : "Edit: move the point"}
              disabled={!area || isRegion}
              onClick={() => selectionRef.current?.setTool(tool === "edit" ? "select" : "edit")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={EDIT_ICON} />
              </svg>
            </button>
            <button
              type="button"
              className="mw-btn"
              aria-label="Delete selection"
              title="Delete selection"
              disabled={!area}
              onClick={deleteSelection}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={TRASH_ICON} />
              </svg>
            </button>
          </div>

          <div className="mw-panel">
            <label className="mw-field">
              <span>Basemap</span>
              <select
                value={isBasemapId(basemap) ? basemap : "custom"}
                onChange={(e) => setBasemap(e.target.value as BasemapId)}
              >
                {Object.entries(BASEMAPS).map(([id, b]) => (
                  <option key={id} value={id}>
                    {b.label}
                  </option>
                ))}
                {!isBasemapId(basemap) && <option value="custom">Custom</option>}
              </select>
            </label>
            <div className="mw-segmented" role="group" aria-label="Projection">
              {(["globe", "mercator"] as const).map((p) => (
                <button key={p} type="button" aria-pressed={projection === p} onClick={() => setProjection(p)}>
                  {p === "globe" ? "Globe" : "Flat"}
                </button>
              ))}
            </div>
          </div>

          <div className="mw-status" aria-live="polite">
            {area ? (
              <span>
                {isRegion ? (
                  <>
                    <strong>Area: {String(area.properties.name)}</strong> · {formatArea(area.properties.areaKm2)}
                  </>
                ) : (
                  <>
                    <strong>Point</strong> ·{" "}
                    {area.geometry.type === "Point" ? formatPoint(area.geometry.coordinates) : ""}
                  </>
                )}
                {tool === "select" && !showRegions ? "" : ` — ${hint}`}
              </span>
            ) : (
              <span>
                {tool === "select" && !showRegions
                  ? "Pick a point, or press Areas to evaluate one of the regions with many stations."
                  : hint}
              </span>
            )}
          </div>
        </>
      )}

      {loading && (
        <div className="mw-loading" role="status">
          <span className="mw-spinner" aria-hidden="true" />
          Loading data…
        </div>
      )}
    </div>
  );
}

function formatPoint([lng, lat]: number[]): string {
  const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, "N", "S")}, ${f(lng, "E", "W")}`;
}

function formatArea(km2: number): string {
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(2)} M km²`;
  return `${Math.round(km2).toLocaleString("en-US")} km²`;
}

/** The selection handed to `onAreaSelected` when a predefined region is picked. */
function regionFeature(region: Region): AreaFeature {
  const geometry = regionGeometry(region);
  return {
    type: "Feature",
    bbox: region.bbox,
    properties: {
      selectionId: region.id,
      shape: "region",
      regionId: region.id,
      name: region.name,
      crossesAntimeridian: false,
      areaKm2: Math.round(geodesicAreaKm2(geometry.coordinates[0] as [number, number][])),
    },
    geometry,
  };
}
