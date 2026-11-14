import "maplibre-gl/dist/maplibre-gl.css";
import "./MapWidget.css";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { StyleSpecification } from "maplibre-gl";
import { BASEMAPS, resolveBasemap } from "./basemaps";
import { DataRenderer, DATA_LAYER_PREFIX } from "./DataRenderer";
import { MapEngine } from "./MapEngine";
import { SelectionManager, SELECTION_LAYER_PREFIX } from "./SelectionManager";
import type { AreaFeature, BasemapId, DrawTool, MapWidgetHandle, MapWidgetProps, ProjectionType } from "./types";

const TOOLS: { id: DrawTool; label: string; hint: string; icon: string }[] = [
  {
    id: "select",
    label: "Pan",
    hint: "Drag to pan. The selection is locked; use Edit to move or reshape it.",
    icon: "M12 2l3 3h-2v4h-2V5H9zm0 20l-3-3h2v-4h2v4h2zM2 12l3-3v2h4v2H5v2zm20 0l-3 3v-2h-4v-2h4V9z",
  },
  {
    id: "rectangle",
    label: "Rectangle",
    hint: "Click and drag (or click twice) to draw a rectangle.",
    icon: "M3 5h18v14H3zm2 2v10h14V7z",
  },
  {
    id: "polygon",
    label: "Polygon",
    hint: "Click to place corners. Click the first point or press Enter to finish. Esc cancels.",
    icon: "M12 2l9 6.5-3.5 11h-11L3 8.5zm0 2.5L5.4 9.2 8 17.5h8l2.6-8.3z",
  },
  {
    id: "freehand",
    label: "Freehand",
    hint: "Click to start, move the mouse to draw, click again to finish.",
    icon: "M4 18c2-6 5-11 8-11s2 6 4 6 2-4 4-6l1.4 1.4C19.6 10.2 19 15 16 15s-2-6-4-6-5 6-6.2 9.7z",
  },
  {
    id: "point",
    label: "Point",
    hint: "Click to pick a single location.",
    icon: "M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
  },
];

const TRASH_ICON = "M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z";
const EDIT_ICON =
  "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z";
const EDIT_HINT = "Editing: drag the selection to move it, drag its corners to reshape it. Esc or Edit again to lock it.";

function isBasemapId(b: unknown): b is BasemapId {
  return typeof b === "string" && b in BASEMAPS;
}

/**
 * Interactive map widget: draw/edit an area (exported as GeoJSON via `onAreaSelected`)
 * and show Data Loader results (`resultData`) as map layers.
 */
export function MapWidget(props: MapWidgetProps & { ref?: Ref<MapWidgetHandle> }) {
  const {
    initialArea,
    resultData,
    loading = false,
    basemap: basemapProp = "streets",
    projection: projectionProp = "globe",
    hideToolbar = false,
    className,
    style,
    ref,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const selectionRef = useRef<SelectionManager | null>(null);
  const rendererRef = useRef<DataRenderer | null>(null);
  // Latest callbacks without re-initialising the map.
  const propsRef = useRef(props);
  propsRef.current = props;

  const [tool, setTool] = useState<DrawTool>("select");
  const [area, setArea] = useState<AreaFeature | null>(null);
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
        setArea(next);
        if (next) propsRef.current.onAreaSelected(next);
        else propsRef.current.onAreaCleared?.();
      },
      onToolChange: setTool,
    });
    const renderer = new DataRenderer(engine.map, {
      beforeLayerId: () =>
        engine.firstBasemapSymbolLayerId([DATA_LAYER_PREFIX, SELECTION_LAYER_PREFIX]) ??
        (engine.map.getLayer(`${SELECTION_LAYER_PREFIX}-polygon`) ? `${SELECTION_LAYER_PREFIX}-polygon` : undefined),
      // Results lie inside the selection, so popups may open on top of it; only drawing tools suppress them.
      popupsEnabled: () => selection.currentTool === "select",
    });

    let first = true;
    engine.onBeforeStyleChange(() => {
      selection.detach();
      renderer.suspend();
    });
    engine.onStyleReady(() => {
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

    return () => {
      selection.detach();
      renderer.destroy();
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

  // ---- Result data ----
  useEffect(() => {
    const list = resultData == null ? [] : Array.isArray(resultData) ? resultData : [resultData];
    rendererRef.current?.setData(list);
  }, [resultData]);

  // ---- Imperative API ----
  useImperativeHandle(
    ref,
    (): MapWidgetHandle => ({
      getArea: () => selectionRef.current?.getArea() ?? null,
      clearArea: () => {
        selectionRef.current?.clear(false);
        setArea(null);
      },
      fitToArea: () => {
        const a = selectionRef.current?.getArea();
        if (a) engineRef.current?.fitToBBox(a.bbox);
      },
      setTool: (t) => selectionRef.current?.setTool(t),
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

  const hint = tool === "edit" ? EDIT_HINT : TOOLS.find((t) => t.id === tool)?.hint;
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
                aria-pressed={tool === t.id}
                aria-label={t.label}
                title={t.label}
                onClick={() => selectionRef.current?.setTool(t.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
              </button>
            ))}
            <span className="mw-sep" />
            <button
              type="button"
              className="mw-btn"
              aria-pressed={tool === "edit"}
              aria-label="Edit selection"
              title={tool === "edit" ? "Lock selection (Esc)" : "Edit selection: move or reshape it"}
              disabled={!area}
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
              onClick={() => selectionRef.current?.clear(true)}
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
                <strong>{area.properties.selectionId}</strong> ·{" "}
                {area.geometry.type === "Point"
                  ? formatPoint(area.geometry.coordinates)
                  : formatArea(area.properties.areaKm2)}
                {area.properties.crossesAntimeridian ? " · crosses 180°" : ""}
                {tool === "select" ? "" : ` — ${hint}`}
              </span>
            ) : (
              <span>{tool === "select" ? "Pick a tool on the left to select an area or a point." : hint}</span>
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
