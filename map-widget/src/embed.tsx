/* eslint-disable react/only-export-components -- build entry, not hot-reloaded */
// Entry point for pages without React (e.g. the Python-served website).
// Built by `npm run build:embed` into ../static/map-widget/ and used as:
//
//   <link rel="stylesheet" href="/static/map-widget/map-widget.css">
//   <script type="module" src="/static/map-widget/map-widget.js"></script>
//   <script type="module">
//     const map = window.TrendDetectiveMap.mount(document.getElementById("map"), {
//       onAreaSelected: (area) => console.log(area),
//     });
//   </script>
import { StrictMode, useImperativeHandle, useState, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { MapWidget, type AreaFeature, type MapData, type MapWidgetHandle, type MapWidgetProps } from "./widget";

interface MountOptions
  extends Pick<MapWidgetProps, "initialArea" | "basemap" | "projection" | "hideToolbar"> {
  onAreaSelected?: (area: AreaFeature) => void;
  onAreaCleared?: () => void;
}

interface MapController {
  /** Show Data Loader results (undefined clears them). */
  setResultData: (data: MapData | MapData[] | undefined) => void;
  setLoading: (loading: boolean) => void;
  getArea: () => AreaFeature | null;
  clearArea: () => void;
  fitToArea: () => void;
  /** Remove the widget from the page. */
  destroy: () => void;
}

interface HostHandle {
  setResultData: MapController["setResultData"];
  setLoading: MapController["setLoading"];
  widget: MapWidgetHandle | null;
}

/** Holds the props that change after mounting, so plain JS can update them. */
function Host({ options, ref }: { options: MountOptions; ref: Ref<HostHandle> }) {
  const [resultData, setResultData] = useState<MapData | MapData[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [widget, setWidget] = useState<MapWidgetHandle | null>(null);

  useImperativeHandle(ref, () => ({ setResultData, setLoading, widget }), [widget]);

  return (
    <MapWidget
      ref={setWidget}
      initialArea={options.initialArea}
      basemap={options.basemap}
      projection={options.projection}
      hideToolbar={options.hideToolbar}
      onAreaSelected={(a) => options.onAreaSelected?.(a)}
      onAreaCleared={() => options.onAreaCleared?.()}
      resultData={resultData}
      loading={loading}
    />
  );
}

function mount(element: HTMLElement, options: MountOptions = {}): MapController {
  let host: HostHandle | null = null;
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <Host options={options} ref={(h) => void (host = h)} />
    </StrictMode>,
  );
  return {
    setResultData: (d) => host?.setResultData(d),
    setLoading: (l) => host?.setLoading(l),
    getArea: () => host?.widget?.getArea() ?? null,
    clearArea: () => host?.widget?.clearArea(),
    fitToArea: () => host?.widget?.fitToArea(),
    destroy: () => root.unmount(),
  };
}

declare global {
  interface Window {
    TrendDetectiveMap: { mount: typeof mount };
  }
}

window.TrendDetectiveMap = { mount };
