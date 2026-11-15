// TrendDetective · Global Explorer – main application.
import * as maplibregl from "/static/vendor/maplibre/maplibre-gl.mjs";
import { renderGrid, drawColorbar, niceCeil, MERC_MAX_LAT, cssColor } from "./colormap.js";
import * as charts from "./charts.js";
import { TimeBar } from "./timebar.js";

maplibregl.setWorkerUrl("/static/vendor/maplibre/maplibre-gl-worker.mjs");

const API = "/api/global/";
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
const MAX_REGIONS = COLORS.length;
const BASEMAP = "https://tiles.openfreemap.org/styles/dark";
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1420" } }],
};

// "year" and "trend" are the two main views; the others sit in the "Mehr" menu.
const LAYER_UI = [
  { id: "year", short: "Zeitreise", hint: (w) => `${w ? "Wie viel wärmer oder kälter" : "Wie viel nasser oder trockener"} als im Mittel ${baselineLabel()} – Jahr für Jahr. ▶ spielt den Zeitraffer ab.` },
  { id: "trend", short: "Trend", hint: (w) => `Wie schnell ${w ? "es sich erwärmt" : "sich der Niederschlag ändert"} (${trendUnit()}). Zeitraum unten in der Zeitleiste ziehen. Punkte = nicht signifikant.` },
  { id: "trend_rel", short: "Relativer Trend", more: true, hint: () => "Niederschlagstrend relativ zum Klimamittel 1991–2020 (% pro Dekade) – vergleicht trockene und feuchte Gebiete fair." },
  { id: "anomaly", short: "Mittlere Abweichung", more: true, hint: () => "Mittlere Abweichung im gewählten Zeitraum gegenüber der Referenzperiode." },
  { id: "acceleration", short: "Beschleunigung", more: true, hint: (w) => `Trend der zweiten minus Trend der ersten Hälfte des Zeitraums. ${w ? "Rot = Erwärmung wird schneller." : "Grün = wird schneller feuchter."} Punkte = nicht signifikant.` },
  { id: "snr", short: "Signal / Rauschen", more: true, hint: () => "Änderung im Zeitraum geteilt durch die natürliche Jahr-zu-Jahr-Schwankung. Ab ≈ 2 hebt sich der Trend klar vom Rauschen ab." },
  { id: "gradient", short: "Räumlicher Gradient", more: true, hint: () => `Wie stark sich der Trend zwischen Nachbarregionen ändert (${trendUnit()} pro 1000 km) – zeigt Kanten wie Meereisgrenzen.` },
];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const SPEEDS = [0.5, 1, 2, 4];

const PERIOD_PRESETS = [
  { label: "seit 1880", start: 1880 },
  { label: "seit 1951", start: 1951 },
  { label: "seit 1979", start: 1979, title: "Satellitenära – Standardzeitraum vieler Studien" },
  { label: "letzte 30 J.", recent: 30 },
];

// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = {
  meta: null,
  ds: "gistemp",
  kind: "year",
  res: "annual", // time step of the Zeitreise: annual | monthly
  start: 1979,
  end: null,
  season: "annual",
  baseline: "1951-1980",
  sig: true,
  mapCharts: true,
  smooth: true,
  globe: true,
  opacity: 0.85,
  scaleMax: null,
  year: null,
  month: 1, // 1–12, only for res = monthly
  speed: 1,
  regions: [], // {uid, spec, name, color}
  tab: "series",
  layer: null, // last layer response
  grid: null, // Float32Array of the displayed grid
  sigMask: null,
  regionData: null,
  frames: null, // yearly maps {key, years, data: Int16Array, vmax}
  monthly: new Map(), // decade → {key, y0, count, data}
  view: null, // Float32Array weights of the visible cells
  viewSeries: null, // yearly area mean of the visible cells
  playing: false,
};
let map;
let overlayCanvas;
let timebar;
let uidCounter = 0;
const presetById = {};

// ---------------------------------------------------------------------------
// Utilities

async function getJSON(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const res = await fetch(API + path + (qs ? "?" + qs : ""));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

let loadingCount = 0;
function loading(on, text = "Berechne …") {
  loadingCount += on ? 1 : -1;
  $("loading").hidden = loadingCount <= 0;
  if (on) $("loading-text").textContent = text;
}

let toastTimer;
function toast(msg, kind = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "info" ? " info" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const SEASON_LAST_MONTH = { annual: 12, DJF: 2, MAM: 5, JJA: 8, SON: 11 };

/** Last year whose chosen season is complete in the dataset. */
function lastFullYear() {
  const [y, m] = state.meta.dataset.last;
  const need = SEASON_LAST_MONTH[state.season] ?? Number(String(state.season).slice(1)) ?? 12;
  return need <= m ? y : y - 1;
}

function commonParams() {
  return { ds: state.ds, season: state.season, baseline: state.baseline };
}

const isTemp = () => state.meta?.dataset.kind !== "precipitation";
const unitOf = () => state.meta?.dataset.unit || "°C";
const trendUnit = () => `${unitOf()}/Dekade`;
const trendShort = () => `${unitOf()}/Dek.`;
const trendDigits = () => (isTemp() ? 2 : 3);
const scaleKind = () => (isTemp() ? "diverging" : "drywet");

function configureCharts() {
  charts.configure({
    unit: unitOf(), trendUnit: trendUnit(), trendShort: trendShort(), digits: trendDigits(),
    scale: scaleKind(), trendTitle: isTemp() ? "Erwärmungstrend" : "Niederschlagstrend",
  });
  const tabs = { tempo: isTemp() ? "Erwärmungstempo" : "Trendtempo", stripes: isTemp() ? "Wärmestreifen" : "Niederschlagsstreifen" };
  for (const [tab, label] of Object.entries(tabs)) document.querySelector(`#tabs [data-tab=${tab}]`).textContent = label;
  for (const b of $("ds-seg").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.ds === state.ds));
  document.body.dataset.ds = state.ds;
}

function periodParams() {
  return { start: state.start, end: state.end, ...commonParams() };
}

function baselineLabel() {
  const b = state.meta.baselines.find((x) => x.id === state.baseline);
  return b ? b.label : "1951–1980";
}

function seasonLabel() {
  return state.meta.seasons.find((s) => s.id === state.season)?.label || state.season;
}

// ---------------------------------------------------------------------------
// URL hash (shareable state)

function writeHash() {
  const p = new URLSearchParams();
  if (state.ds !== "gistemp") p.set("d", state.ds);
  p.set("k", state.kind);
  p.set("p", `${state.start}-${state.end}`);
  p.set("s", state.season);
  p.set("b", state.baseline);
  if (state.kind === "year" && state.year) p.set("y", state.res === "monthly" ? `${state.year}-${String(state.month).padStart(2, "0")}` : state.year);
  if (state.kind === "year" && state.res === "monthly") p.set("m", "1");
  if (state.regions.length) p.set("r", state.regions.map((r) => (r.spec.preset ? r.spec.preset : JSON.stringify(r.spec))).join("|"));
  if (state.tab !== "series") p.set("t", state.tab);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.toString()) return false;
  if (state.meta.layers.some((l) => l.id === p.get("k")) || p.get("k") === "year") state.kind = p.get("k");
  const per = (p.get("p") || "").split("-").map(Number);
  if (per.length === 2 && per.every(Number.isFinite)) [state.start, state.end] = per;
  // Only accept values the dataset offers, so a broken link falls back to defaults.
  if (state.meta.seasons.some((x) => x.id === p.get("s"))) state.season = p.get("s");
  if (state.meta.baselines.some((x) => x.id === p.get("b"))) state.baseline = p.get("b");
  const [yy, mm] = String(p.get("y") || "").split("-").map(Number);
  if (Number.isFinite(yy) && yy > 0) state.year = yy;
  if (Number.isFinite(mm) && mm >= 1 && mm <= 12) state.month = mm;
  if (p.get("m") === "1") state.res = "monthly";
  if ([...document.querySelectorAll("#tabs [data-tab]")].some((b) => b.dataset.tab === p.get("t"))) state.tab = p.get("t");
  state.regions = [];
  for (const part of (p.get("r") || "").split("|").filter(Boolean)) {
    try {
      const spec = part.startsWith("{") ? JSON.parse(part) : { preset: part };
      addRegion(spec, { silent: true });
    } catch { /* ignore broken entries */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Controls

function buildControls() {
  populateControls();
  buildListeners();
}

function populateControls() {
  const available = new Set(state.meta.layers.map((l) => l.id).concat(["year"]));
  const menu = $("more-menu");
  menu.innerHTML = "";
  for (const l of LAYER_UI.filter((x) => x.more && available.has(x.id))) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "menuitemradio";
    b.dataset.kind = l.id;
    b.innerHTML = `<b>${l.short}</b><span>${charts.escapeHtml(l.hint(isTemp()).split(/[.–]/)[0])}</span>`;
    b.addEventListener("click", () => { closeMoreMenu(); setKind(l.id); });
    menu.appendChild(b);
  }
  const season = $("season");
  season.innerHTML = "";
  const groupMain = document.createElement("optgroup");
  groupMain.label = "Jahr & Jahreszeiten";
  const groupMonths = document.createElement("optgroup");
  groupMonths.label = "Einzelne Monate";
  for (const s of state.meta.seasons) {
    const o = new Option(s.label, s.id);
    (s.id.startsWith("m") ? groupMonths : groupMain).appendChild(o);
  }
  season.append(groupMain, groupMonths);
  const baseline = $("baseline");
  baseline.innerHTML = "";
  for (const b of state.meta.baselines) {
    const label = b.id === "1880-1900" ? `${b.label} (vorindustriell)` : b.id === "1951-1980" ? `${b.label} (NASA)` : b.id === "1991-2020" ? `${b.label} (heutiges Klima)` : b.label;
    baseline.appendChild(new Option(label, b.id));
  }
  const pp = $("period-presets");
  pp.innerHTML = "";
  for (const p of PERIOD_PRESETS.filter((x) => x.recent || x.start >= state.meta.dataset.first[0])) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = p.label;
    b.title = p.title || "";
    b.dataset.start = p.start ?? "";
    b.dataset.recent = p.recent ?? "";
    b.addEventListener("click", () => {
      const end = lastFullYear();
      setPeriod(p.recent ? end - p.recent + 1 : p.start, end);
    });
    pp.appendChild(b);
  }
  const first = state.meta.dataset.first[0];
  for (const id of ["start-year", "end-year"]) {
    $(id).min = first;
    $(id).max = state.meta.dataset.last[0];
  }
}

function closeMoreMenu() {
  $("more-menu").hidden = true;
  $("btn-more").setAttribute("aria-expanded", "false");
}

function buildListeners() {
  for (const b of $("ds-seg").querySelectorAll("button")) b.addEventListener("click", () => switchDataset(b.dataset.ds));
  for (const b of $("mode-seg").querySelectorAll("[data-mode=year],[data-mode=trend]")) b.addEventListener("click", () => setKind(b.dataset.mode));
  $("btn-more").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("more-menu").hidden;
    $("more-menu").hidden = !open;
    $("btn-more").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest?.(".more")) closeMoreMenu(); });
  for (const b of $("res-seg").querySelectorAll("button")) b.addEventListener("click", () => setRes(b.dataset.res));
  $("start-year").addEventListener("change", (e) => setPeriod(Number(e.target.value), state.end));
  $("end-year").addEventListener("change", (e) => setPeriod(state.start, Number(e.target.value)));
  $("season").addEventListener("change", (e) => {
    state.season = e.target.value;
    state.frames = null;
    state.end = Math.min(state.end, lastFullYear());
    syncControls();
    refreshAll();
  });
  $("baseline").addEventListener("change", (e) => { state.baseline = e.target.value; state.frames = null; state.monthly.clear(); refreshAll(); });
  $("opt-sig").addEventListener("change", (e) => { state.sig = e.target.checked; redrawOverlay(); });
  $("opt-smooth").addEventListener("change", (e) => { state.smooth = e.target.checked; redrawOverlay(); });
  $("opt-globe").addEventListener("change", (e) => { state.globe = e.target.checked; applyProjection(); });
  $("opt-mapcharts").addEventListener("change", (e) => { state.mapCharts = e.target.checked; drawRegionMarkers(); });
  $("opacity").addEventListener("input", (e) => {
    state.opacity = Number(e.target.value);
    if (map?.getLayer("overlay")) map.setPaintProperty("overlay", "raster-opacity", state.opacity);
    if (map?.getLayer("caps")) map.setPaintProperty("caps", "fill-opacity", state.opacity);
  });
  $("scale-max").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    state.scaleMax = v > 0 ? v : null;
    redrawOverlay();
    updateTimebar();
  });
  $("btn-collapse-controls").addEventListener("click", () => {
    const c = $("controls");
    c.classList.toggle("collapsed");
    $("btn-collapse-controls").textContent = c.classList.contains("collapsed") ? "›" : "‹";
    $("btn-collapse-controls").title = c.classList.contains("collapsed") ? "Ausklappen" : "Einklappen";
    scheduleChipLayout();
  });
  $("btn-collapse-regions").addEventListener("click", () => {
    const c = $("regions-panel");
    c.classList.toggle("collapsed");
    $("btn-collapse-regions").textContent = c.classList.contains("collapsed") ? "+" : "–";
    scheduleChipLayout();
  });
  $("btn-toggle-analysis").addEventListener("click", () => setAnalysisOpen(isAnalysisCollapsed()));
  for (const b of $("tabs").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      syncControls();
      if (isAnalysisCollapsed()) setAnalysisOpen(true); else renderAnalysis();
      writeHash();
    });
  }
  $("btn-play").addEventListener("click", togglePlay);
  $("btn-speed").addEventListener("click", () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    $("btn-speed").textContent = `${String(state.speed).replace(".", ",")}×`;
  });
  $("btn-view-region").addEventListener("click", addViewAsRegion);
  $("btn-about").addEventListener("click", () => $("about").showModal());
  $("btn-draw").addEventListener("click", () => setDrawMode(!drawMode));
  $("btn-csv").addEventListener("click", downloadCsv);
  $("btn-link").addEventListener("click", async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); toast("Link mit allen Einstellungen kopiert.", "info"); }
    catch { toast("Kopieren nicht möglich – bitte die Adresszeile kopieren.", "info"); }
  });
  timebar = new TimeBar($("tb-track"), {
    onValue: (t) => {
      if (state.kind !== "year") return;
      if (state.playing) togglePlay();
      setTime(t);
    },
    onRange: (a, b) => setPeriod(a, b),
  });
  setupResize();
  if (window.matchMedia("(max-width: 760px)").matches) {
    state.mapCharts = false; // too little room for chips on a phone
    $("opt-mapcharts").checked = false;
    $("controls").classList.add("collapsed");
    $("btn-collapse-controls").textContent = "›";
    $("regions-panel").classList.add("collapsed");
    $("btn-collapse-regions").textContent = "+";
  }
  buildPresets();
  buildSearch();
  buildAbout();
}

const isAnalysisCollapsed = () => document.querySelector(".layout").classList.contains("analysis-collapsed");

function setAnalysisOpen(open) {
  const l = document.querySelector(".layout");
  if (open === !l.classList.contains("analysis-collapsed")) return;
  l.classList.toggle("analysis-collapsed", !open);
  $("btn-toggle-analysis").textContent = open ? "▾" : "▴";
  setTimeout(() => { map?.resize(); renderAnalysis(); scheduleChipLayout(); }, 60);
}

function syncControls() {
  const more = LAYER_UI.find((l) => l.id === state.kind && l.more);
  for (const b of $("mode-seg").querySelectorAll("[data-mode]")) {
    const on = b.dataset.mode === state.kind || (b.dataset.mode === "more" && !!more);
    b.setAttribute("aria-checked", String(on));
  }
  $("btn-more").innerHTML = `${more ? more.short : "Mehr"} <span aria-hidden="true">▾</span>`;
  for (const b of $("more-menu").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.kind === state.kind));
  for (const b of $("res-seg").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.res === state.res));
  $("layer-hint").textContent = LAYER_UI.find((l) => l.id === state.kind)?.hint(isTemp()) || "";
  const isYear = state.kind === "year";
  $("ctx-year").hidden = !isYear;
  $("ctx-period").hidden = isYear;
  $("baseline-field").hidden = !(isYear || state.kind === "anomaly");
  $("season-field").hidden = isYear && state.res === "monthly";
  $("res-seg").querySelector("[data-res=monthly]").disabled = false;
  $("start-year").value = state.start;
  $("end-year").value = state.end;
  $("season").value = state.season;
  $("baseline").value = state.baseline;
  const end = lastFullYear();
  for (const b of $("period-presets").children) {
    const start = b.dataset.recent ? end - Number(b.dataset.recent) + 1 : Number(b.dataset.start);
    b.classList.toggle("active", state.start === start && state.end === end);
  }
  for (const b of $("tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  $("btn-play").title = isYear ? "Zeitraffer abspielen (Leertaste)" : "Zur Zeitreise wechseln und abspielen";
  $("btn-speed").hidden = !isYear;
  document.body.dataset.kind = state.kind;
  updateTimebar();
}

async function switchDataset(key) {
  if (key === state.ds) return;
  if (state.playing) togglePlay();
  let meta;
  try {
    loading(true, key === "gpcp" ? "Lade Niederschlagsdaten (beim ersten Mal ~20 MB, bis ca. 1 Min.) …" : "Lade Datensatz …");
    meta = await getJSON("meta", { ds: key });
  } catch (err) {
    toast(err.message);
    return;
  } finally {
    loading(false);
  }
  state.ds = key;
  state.meta = meta;
  state.baseline = `${meta.dataset.baseline[0]}-${meta.dataset.baseline[1]}`;
  if (!meta.layers.some((l) => l.id === state.kind) && state.kind !== "year") state.kind = "trend";
  state.frames = null;
  state.monthly.clear();
  state.viewSeries = null;
  state.view = null;
  state.scaleMax = null;
  $("scale-max").value = "";
  const first = meta.dataset.first[0];
  state.end = Math.min(state.end, lastFullYear());
  state.start = Math.max(state.start, first);
  if (state.end - state.start < 9) state.start = Math.max(first, state.end - 29);
  state.year = Math.max(first, Math.min(state.year ?? state.end, meta.dataset.last[0]));
  populateControls();
  configureCharts();
  buildAbout();
  syncControls();
  refreshAll();
}

function setKind(kind) {
  if (state.playing) togglePlay();
  state.kind = kind;
  syncControls();
  refreshLayer();
  writeHash();
}

function setRes(res) {
  if (res === state.res) return;
  if (state.playing) togglePlay();
  state.res = res;
  if (res === "monthly") state.month = state.year >= state.meta.dataset.last[0] ? state.meta.dataset.last[1] : 12;
  syncControls();
  refreshLayer();
  writeHash();
}

function setPeriod(start, end) {
  const first = state.meta.dataset.first[0];
  const last = lastFullYear();
  start = Math.max(first, Math.min(last, Math.round(start || first)));
  end = Math.max(first, Math.min(last, Math.round(end || last)));
  if (end - start < 9) {
    toast("Der Zeitraum braucht mindestens 10 Jahre – ich habe ihn erweitert.", "info");
    if (start + 9 <= last) end = start + 9; else start = end - 9;
  }
  state.start = start;
  state.end = end;
  syncControls();
  refreshAll();
}

// ---------------------------------------------------------------------------
// Map

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: BASEMAP,
    center: [15, 32],
    zoom: initialZoom(),
    minZoom: 0.6,
    maxZoom: 7,
    attributionControl: { compact: true, customAttribution: "Daten: NASA GISTEMP v4 · GPCP v2.3 (NOAA PSL) · Natural Earth" },
    renderWorldCopies: true,
    boxZoom: false,
  });
  let fellBack = false;
  map.on("error", (e) => {
    console.warn("map error:", e?.error?.message || e);
    // If the basemap cannot be loaded (offline), continue with a plain background.
    if (!fellBack && !map.isStyleLoaded() && String(e?.error?.message || "").match(/style|fetch|Failed/i)) {
      fellBack = true;
      map.setStyle(FALLBACK_STYLE);
    }
  });
  if (location.search.includes("debug")) window.__map = map; // for automated UI checks
  overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = 1536;
  overlayCanvas.height = 1536;
  map.on("style.load", () => {
    applyProjection();
    try { tuneBasemap(); } catch { /* fallback style */ }
    addOverlayLayers();
    redrawOverlay();
    drawRegionsOnMap();
  });
  map.on("mousemove", onMapHover);
  map.on("mouseout", () => ($("hover-card").hidden = true));
  map.on("click", onMapClick);
  map.on("move", scheduleChipLayout);
  map.on("resize", scheduleChipLayout);
  map.on("moveend", updateView);
  map.on("load", () => {
    updateView();
    // keep the attribution folded to its (i) button; it would cover the legend
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  });
  setupDrawing();
}

function initialZoom() {
  // Fit the globe into the map area (globe diameter ≈ 512·2^z / π px).
  const el = $("map");
  const size = Math.max(180, Math.min(el.clientWidth > 900 ? el.clientWidth - 600 : el.clientWidth - 24, el.clientHeight - 170));
  return Math.max(0.2, Math.log2((size * Math.PI) / 512));
}

function applyProjection() {
  if (!map) return;
  try { map.setProjection({ type: state.globe ? "globe" : "mercator" }); } catch { /* style not ready */ }
}

function tuneBasemap() {
  // Keep the basemap quiet: only country names and large cities, light borders.
  for (const l of map.getStyle()?.layers || []) {
    if (l.type === "symbol") {
      const keep = /place_country_major|place_country_minor/.test(l.id);
      if (!keep) { map.setLayoutProperty(l.id, "visibility", "none"); continue; }
      map.setLayoutProperty(l.id, "text-size", ["interpolate", ["linear"], ["zoom"], 1, 9, 4, 12]);
      map.setLayoutProperty(l.id, "text-transform", "none");
      map.setPaintProperty(l.id, "text-color", "rgba(235,240,247,0.78)");
      map.setPaintProperty(l.id, "text-halo-color", "rgba(5,8,13,0.7)");
      map.setPaintProperty(l.id, "text-halo-width", 1);
    } else if (/^boundary_country/.test(l.id)) {
      map.setPaintProperty(l.id, "line-color", "rgba(10,14,20,0.55)");
    } else if (/^boundary_state/.test(l.id)) {
      map.setLayoutProperty(l.id, "visibility", "none");
    }
  }
}

function firstLabelLayer() {
  // Overlay goes above water/land/roads but below borders and place labels.
  const layers = map.getStyle()?.layers || [];
  const hit = layers.find((l) => /^boundary|admin/.test(l.id)) || layers.find((l) => l.type === "symbol" && !/water_name|road|highway/.test(l.id));
  return hit?.id;
}

function addOverlayLayers() {
  if (map.getSource("overlay")) return;
  map.addSource("overlay", {
    type: "image",
    url: overlayUrl || BLANK_PNG,
    coordinates: OVERLAY_COORDS,
  });
  map.addLayer({
    id: "overlay", type: "raster", source: "overlay",
    paint: { "raster-opacity": state.opacity, "raster-fade-duration": 0, "raster-resampling": "linear" },
  }, firstLabelLayer());
  // Mercator images stop at ±85.05°; caps in the zonal-mean colour close the globe.
  map.addSource("caps", { type: "geojson", data: polarCaps() });
  map.addLayer({
    id: "caps", type: "fill", source: "caps",
    paint: { "fill-color": ["coalesce", ["get", "color"], "#1a2230"], "fill-opacity": state.opacity, "fill-antialias": false },
  }, firstLabelLayer());
  map.addSource("coast", { type: "geojson", data: "/static/vendor/natural-earth/coastline_50m.geojson" });
  map.addLayer({
    id: "coast", type: "line", source: "coast",
    paint: { "line-color": "#0b1018", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 1.4] },
  }, firstLabelLayer());
  map.addSource("regions", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "regions-fill", type: "fill", source: "regions", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.08 } });
  map.addLayer({ id: "regions-halo", type: "line", source: "regions", paint: { "line-color": "#05080d", "line-width": 4, "line-opacity": 0.6 } });
  map.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": ["get", "color"], "line-width": 2 } });
  map.addSource("draw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "draw-line", type: "line", source: "draw", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 2] } });
}

// The overlay is an image source fed from an off-screen canvas via blob URLs.
// (A MapLibre canvas source stalls rendering in globe mode, so it is not used.)
const OVERLAY_COORDS = [[-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT]];
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let overlayUrl = null;
let overlayBusy = false;
let overlayQueued = false;

function touchOverlay() {
  if (overlayBusy) { overlayQueued = true; return; }
  overlayBusy = true;
  overlayCanvas.toBlob((blob) => {
    const old = overlayUrl;
    overlayUrl = URL.createObjectURL(blob);
    const src = map?.getSource("overlay");
    if (src) src.updateImage({ url: overlayUrl, coordinates: OVERLAY_COORDS });
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    overlayBusy = false;
    if (overlayQueued) { overlayQueued = false; touchOverlay(); }
  }, "image/png");
}

function polarCaps(colors = {}) {
  const ring = (a, b) => {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 30) pts.push([lon, a]);
    for (let lon = 180; lon >= -180; lon -= 30) pts.push([lon, b]);
    pts.push([-180, a]);
    return pts;
  };
  const cap = (name, a, b) => ({ type: "Feature", properties: { color: colors[name] || null }, geometry: { type: "Polygon", coordinates: [ring(a, b)] } });
  return { type: "FeatureCollection", features: [cap("n", MERC_MAX_LAT - 0.05, 90), cap("s", -90, -MERC_MAX_LAT + 0.05)] };
}

function updateCaps(scale) {
  const src = map?.getSource("caps");
  if (!src || !state.grid) return;
  const g = geom();
  const rowMean = (r) => {
    let s = 0, n = 0;
    for (let c = 0; c < g.nlon; c++) { const v = state.grid[r * g.nlon + c]; if (v === v) { s += v; n++; } }
    return n ? s / n : null;
  };
  const north = rowMean(g.nlat - 1), south = rowMean(0);
  src.setData(polarCaps({
    n: north == null ? null : cssColor(north, scale),
    s: south == null ? null : cssColor(south, scale),
  }));
}

function currentScale() {
  const L = state.layer;
  if (state.kind === "year") {
    const m = state.scaleMax || (state.res === "monthly" ? state.monthlyVmax : state.frames?.vmax) || 4;
    return { kind: scaleKind(), min: -m, max: m };
  }
  if (!L) return { kind: scaleKind(), min: -1, max: 1 };
  if (L.kind === "gradient") {
    const m = state.scaleMax || niceCeil(absPercentile(state.grid, 0.97) || 1);
    return { kind: "sequential", min: 0, max: m };
  }
  const auto = niceCeil(absPercentile(state.grid, 0.95) || 1);
  const m = state.scaleMax || auto;
  return { kind: scaleKind(), min: -m, max: m };
}

function absPercentile(grid, q) {
  // Area-weighted quantile of |value| (polar rows hold many tiny cells).
  if (!grid) return null;
  const g = geom();
  const items = [];
  let total = 0;
  for (let r = 0; r < g.nlat; r++) {
    const w = Math.cos(((g.lat0 + r * g.dlat) * Math.PI) / 180);
    for (let c = 0; c < g.nlon; c++) {
      const v = grid[r * g.nlon + c];
      if (v === v) { items.push([Math.abs(v), w]); total += w; }
    }
  }
  if (!items.length) return null;
  items.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const [v, w] of items) { acc += w; if (acc >= q * total) return v; }
  return items[items.length - 1][0];
}

function geom() {
  const g = state.meta.dataset.grid;
  return { nlat: g.nlat, nlon: g.nlon, lat0: g.lat0, lon0: g.lon0, dlat: g.lat_step, dlon: g.lon_step };
}

function redrawOverlay() {
  if (!state.grid || !overlayCanvas) return;
  const scale = currentScale();
  const mask = state.sig && state.sigMask ? state.sigMask : null;
  renderGrid(overlayCanvas, state.grid, geom(), scale, { smooth: state.smooth, mask });
  touchOverlay();
  updateCaps(scale);
  updateLegend(scale);
}

function updateLegend(scale) {
  const L = state.layer;
  const year = state.kind === "year";
  const unit = year ? unitOf() : L?.unit || "";
  const title = year ? `Abweichung vom Mittel ${baselineLabel()}` : L?.label || "";
  $("legend-title").innerHTML = `${charts.escapeHtml(title)} <span class="unit">${charts.escapeHtml(unit)}</span>`;
  drawColorbar($("legend-bar"), scale);
  const ticks = $("legend-ticks");
  ticks.innerHTML = "";
  const n = 5;
  for (let i = 0; i < n; i++) {
    const v = scale.min + (i / (n - 1)) * (scale.max - scale.min);
    const s = document.createElement("span");
    s.style.left = `${(i / (n - 1)) * 100}%`;
    const digits = Math.abs(scale.max) < 0.1 ? 3 : Math.abs(scale.max) < 1 ? 2 : 1;
    s.textContent = charts.fmt(v, digits, scale.kind !== "sequential");
    if (i === 0) s.style.transform = "none";
    if (i === n - 1) s.style.transform = "translateX(-100%)";
    ticks.appendChild(s);
  }
  let ends = ["", ""];
  if (scale.kind === "sequential") ends = ["gering", "stark"];
  else if (!year && L?.kind === "snr") ends = ["Abnahme", "Zunahme"];
  else if (!year && L?.kind === "acceleration") ends = isTemp() ? ["bremst", "beschleunigt"] : ["trockener werdend", "feuchter werdend"];
  else ends = isTemp() ? ["kälter", "wärmer"] : ["trockener", "nasser"];
  $("legend-ends").innerHTML = `<span>← ${ends[0]}</span><span>${ends[1]} →</span>`;
  updateHeadline();
}

/** Big label on the map: which time the map shows and the global mean. */
function updateHeadline() {
  const L = state.layer;
  let time, sub;
  if (state.kind === "year") {
    if (state.res === "monthly") {
      time = `${MONTHS[state.month - 1]} ${state.year}`;
      sub = "Monatswert";
    } else {
      time = String(state.year ?? "");
      sub = state.season === "annual" ? "Jahresmittel" : seasonLabel();
    }
    const gm = state.grid ? globalMean(state.grid) : null;
    if (gm != null) sub += ` · Welt <b>${charts.fmt(gm, isTemp() ? 2 : 2)} ${unitOf()}</b>`;
  } else if (L) {
    time = `${L.period[0]} – ${L.period[1]}`;
    const s = L.summary || {};
    sub = `${L.label}${state.season !== "annual" ? ` · ${seasonLabel()}` : ""}`;
    if (s.area_mean != null && L.kind !== "gradient") {
      sub += ` · Welt <b>${charts.fmt(s.area_mean, isTemp() || L.unit === "σ" || L.unit.startsWith("%") ? 2 : 3)} ${L.unit}</b>`;
    }
    if (s.significant_area != null) sub += ` · ${Math.round(s.significant_area * 100)} % der Fläche signifikant`;
  }
  $("hl-time").textContent = time || "";
  $("hl-sub").innerHTML = sub || "";
}

function globalMean(grid) {
  const g = geom();
  let s = 0, w = 0;
  for (let r = 0; r < g.nlat; r++) {
    const cw = Math.cos(((g.lat0 + r * g.dlat) * Math.PI) / 180);
    for (let c = 0; c < g.nlon; c++) {
      const v = grid[r * g.nlon + c];
      if (v === v) { s += v * cw; w += cw; }
    }
  }
  return w ? s / w : null;
}

function cellIndex(lng, lat) {
  const g = geom();
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const r = Math.round((lat - g.lat0) / g.dlat);
  const c = ((Math.round((lng - g.lon0) / g.dlon) % g.nlon) + g.nlon) % g.nlon;
  if (r < 0 || r >= g.nlat) return null;
  return { r, c, k: r * g.nlon + c, lat: g.lat0 + r * g.dlat, lon: g.lon0 + c * g.dlon };
}

function fmtLatLon(lat, lon) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(0)}°${lon >= 0 ? "O" : "W"}`;
}

function onMapHover(e) {
  const card = $("hover-card");
  if (!state.grid || drawStart) { card.hidden = true; return; }
  const cell = cellIndex(e.lngLat.lng, e.lngLat.lat);
  if (!cell) { card.hidden = true; return; }
  const v = state.grid[cell.k];
  const unit = state.kind === "year" ? unitOf() : state.layer?.unit || "";
  let extra = "";
  if (state.sigMask && v === v && state.kind !== "anomaly" && state.kind !== "year" && state.kind !== "gradient") {
    extra = state.sigMask[cell.k] ? " · <span class=muted>signifikant</span>" : " · <span class=muted>nicht signifikant</span>";
  }
  card.innerHTML = `<span class="muted">Zelle ${fmtLatLon(cell.lat, cell.lon)}</span><br>`
    + (v === v ? `<b>${charts.fmt(v, isTemp() || unit === "σ" || unit.startsWith("%") ? 2 : 3, state.kind !== "gradient")} ${unit}</b>${extra}` : `<span class="muted">keine Daten</span>`);
  card.hidden = false;
  const W = $("map").clientWidth;
  const x = e.point.x + 14 + card.offsetWidth > W ? e.point.x - card.offsetWidth - 14 : e.point.x + 14;
  card.style.left = `${x}px`;
  card.style.top = `${e.point.y + 12}px`;
}

let popup;
async function onMapClick(e) {
  if (drawMode) return;
  const cell = cellIndex(e.lngLat.lng, e.lngLat.lat);
  if (!cell) return;
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: "280px", closeButton: true })
    .setLngLat([cell.lon, cell.lat])
    .setHTML(`<div class="cell-pop"><h4>Gitterzelle ${fmtLatLon(cell.lat, cell.lon)}</h4><span class="muted">Lade …</span></div>`)
    .addTo(map);
  try {
    const data = await getJSON("cell", { lat: cell.lat, lon: cell.lon, ...periodParams() });
    const r = data.regions[0];
    const s = r.stats;
    const spark = charts.sparkline(data.years, r.values, r.running, { color: "#ef8a62" });
    const html = `<div class="cell-pop"><h4>Gitterzelle ${fmtLatLon(cell.lat, cell.lon)}</h4>`
      + (s.trend != null
        ? `<div class="big">${charts.fmt(s.trend, trendDigits())} <small>${trendUnit()}</small></div>`
          + (s.trend_rel != null ? `<div class="row"><span>relativ zum Klimamittel</span><b>${charts.fmt(s.trend_rel, 1)} %/Dek.</b></div>` : "")
          + `<div class="row"><span>${data.period[0]}–${data.period[1]}, ${data.season_label}</span><span>p ${charts.fmtP(s.trend_p)}</span></div>`
        : `<div class="muted">${s.error || "Keine Daten"}</div>`)
      + spark
      + (s.change != null ? `<div class="row"><span>Änderung im Zeitraum</span><b>${charts.fmt(s.change, 2)} ${unitOf()}</b></div>` : "")
      + (s.vs_global != null ? `<div class="row"><span>× globaler Trend</span><b>${s.vs_global.toFixed(2).replace(".", ",")}</b></div>` : "")
      + (s.emergence_year ? `<div class="row"><span>Signal tritt hervor ab</span><b>${s.emergence_year}</b></div>` : "")
      + `<button class="primary" type="button" id="pop-add">+ Zum Vergleich</button></div>`;
    popup.setHTML(html);
    popup.getElement().querySelector("#pop-add")?.addEventListener("click", () => {
      addRegion({ point: [cell.lon, cell.lat], name: `Zelle ${fmtLatLon(cell.lat, cell.lon)}` });
      popup.remove();
    });
  } catch (err) {
    popup.setHTML(`<div class="cell-pop">${charts.escapeHtml(err.message)}</div>`);
  }
}

// --- rectangle drawing -------------------------------------------------------
let drawMode = false;
let drawStart = null;
function setDrawMode(on) {
  drawMode = on;
  $("btn-draw").classList.toggle("active", on);
  document.querySelector(".map-area").classList.toggle("drawing", on);
  if (on) map.dragPan.disable(); else map.dragPan.enable();
}

function boxFeature(a, b) {
  // Globe longitudes wrap at ±180°: unwrap the end point relative to the start.
  const bl = b.lng + 360 * Math.round((a.lng - b.lng) / 360);
  const w = Math.min(a.lng, bl), e = Math.max(a.lng, bl);
  const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
  const ring = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) ring.push([w + ((e - w) * i) / steps, s]);
  for (let i = 0; i <= steps; i++) ring.push([e - ((e - w) * i) / steps, n]);
  ring.push([w, s]);
  return { bbox: [w, s, e, n], feature: { type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} } };
}

function setupDrawing() {
  map.on("mousedown", (e) => {
    if (!drawMode) return;
    drawStart = e.lngLat;
  });
  map.on("mousemove", (e) => {
    if (!drawMode || !drawStart) return;
    const { feature } = boxFeature(drawStart, e.lngLat);
    map.getSource("draw")?.setData({ type: "FeatureCollection", features: [feature] });
  });
  map.on("mouseup", (e) => {
    if (!drawMode || !drawStart) return;
    const { bbox } = boxFeature(drawStart, e.lngLat);
    drawStart = null;
    map.getSource("draw")?.setData({ type: "FeatureCollection", features: [] });
    setDrawMode(false);
    if (bbox[2] - bbox[0] < 0.5 || bbox[3] - bbox[1] < 0.5) { toast("Rechteck zu klein – bitte größer aufziehen."); return; }
    const name = `Rechteck ${fmtLatLon(bbox[3], bbox[0])} – ${fmtLatLon(bbox[1], bbox[2])}`;
    addRegion({ bbox: bbox.map((v) => Math.round(v * 100) / 100), name });
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawMode) { drawStart = null; setDrawMode(false); }
    // Space plays/pauses, ← / → step through time (not while typing in a field).
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(document.activeElement?.tagName || "") || document.querySelector("dialog[open]")) return;
    if (e.key === " ") { togglePlay(); e.preventDefault(); return; }
    if (state.kind !== "year" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    if (document.activeElement === $("tb-track")) return; // the time bar handles its own keys
    if (state.playing) togglePlay();
    const step = state.res === "monthly" ? 1 / 12 : 1;
    const t = (state.res === "monthly" ? state.year + (state.month - 1) / 12 : state.year) + (e.key === "ArrowRight" ? step : -step);
    const ds = state.meta.dataset;
    const max = state.res === "monthly" ? ds.last[0] + (ds.last[1] - 1) / 12 : state.frames?.years.at(-1) ?? ds.last[0];
    if (t >= ds.first[0] - 1e-6 && t <= max + 1e-6) setTime(t);
    e.preventDefault();
  });
}

// ---------------------------------------------------------------------------
// Layer loading

let layerReq = 0;
async function refreshLayer() {
  const req = ++layerReq;
  // The yearly maps feed the time bar (history of the visible area) in every view.
  loadFrames().then(() => { computeViewSeries(); updateTimebar(); }).catch(() => {});
  if (state.kind === "year") return showYearMode(req);
  loading(true, "Berechne Karte …");
  try {
    const L = await getJSON("layer", { kind: state.kind, ...periodParams() });
    if (req !== layerReq) return;
    state.layer = L;
    state.grid = Float32Array.from(L.values, (v) => (v == null ? NaN : v));
    state.sigMask = L.significant ? Uint8Array.from(L.significant, (b) => (b ? 1 : 0)) : null;
    if (L.period[0] !== state.start || L.period[1] !== state.end) {
      state.start = L.period[0];
      state.end = L.period[1];
      syncControls();
    }
    redrawOverlay();
    updateTimebar();
  } catch (err) {
    toast(err.message);
  } finally {
    loading(false);
  }
}

const framesKey = () => `${state.ds}|${state.season}|${state.baseline}`;
const framesPending = new Map();
async function loadFrames() {
  const key = framesKey();
  if (state.frames?.key === key) return state.frames;
  if (framesPending.has(key)) return framesPending.get(key);
  const promise = fetchFrames(key);
  framesPending.set(key, promise);
  try { return await promise; } finally { framesPending.delete(key); }
}

async function fetchFrames(key) {
  loading(true, "Lade Jahreskarten …");
  try {
    const qs = new URLSearchParams(commonParams()).toString();
    const res = await fetch(API + "frames?" + qs);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const [y0, y1] = res.headers.get("X-Years").split("-").map(Number);
    const buf = await res.arrayBuffer();
    const years = [];
    for (let y = y0; y <= y1; y++) years.push(y);
    const data = new Int16Array(buf);
    const frames = { key, years, data, vmax: robustMax(data) };
    if (key === framesKey()) state.frames = frames;
    return frames;
  } finally {
    loading(false);
  }
}

/** Colour range for animations: 99th percentile of |value| over a sample of all frames. */
function robustMax(data, q = 0.985) {
  const sample = [];
  for (let k = 0; k < data.length; k += 7) if (data[k] !== -32768) sample.push(Math.abs(data[k]) / 100);
  sample.sort((a, b) => a - b);
  return niceCeil(sample[Math.floor(sample.length * q)] || 1);
}

// --- monthly maps, loaded per decade -----------------------------------------
const monthlyKey = (decade) => `${state.ds}|${state.baseline}|${decade}`;
const monthlyPending = new Map();
async function loadMonthChunk(decade) {
  const key = monthlyKey(decade);
  if (state.monthly.has(key)) return state.monthly.get(key);
  if (monthlyPending.has(key)) return monthlyPending.get(key);
  const vmaxKey = `${state.ds}|${state.baseline}`;
  const promise = (async () => {
    const qs = new URLSearchParams({ ds: state.ds, baseline: state.baseline, res: "monthly", from: decade, to: decade + 9 });
    const res = await fetch(API + "frames?" + qs);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const [y0] = res.headers.get("X-Start").split("-").map(Number);
    const count = Number(res.headers.get("X-Count"));
    const data = new Int16Array(await res.arrayBuffer());
    const chunk = { key, y0, count, data };
    if (state.monthlyVmaxKey !== vmaxKey) { state.monthlyVmax = robustMax(data, 0.95) /* monthly values are noisier */; state.monthlyVmaxKey = vmaxKey; }
    state.monthly.set(key, chunk);
    while (state.monthly.size > 6) state.monthly.delete(state.monthly.keys().next().value);
    return chunk;
  })();
  monthlyPending.set(key, promise);
  try { return await promise; } finally { monthlyPending.delete(key); }
}

function lastDataMonth() {
  const [y, m] = state.meta.dataset.last;
  return { y, m };
}

async function showYearMode(req) {
  try {
    const f = await loadFrames();
    if (req !== layerReq || state.kind !== "year" || f.key !== framesKey()) return;
    state.sigMask = null;
    if (state.res === "monthly") {
      const first = state.meta.dataset.first[0];
      const last = lastDataMonth();
      if (!state.year || state.year < first || state.year > last.y) state.year = last.y;
      if (state.year === last.y && state.month > last.m) state.month = last.m;
      await showMonth();
    } else {
      const [y0, y1] = [f.years[0], f.years[f.years.length - 1]];
      if (!state.year || state.year > y1 || state.year < y0) state.year = y1;
      showYear();
    }
  } catch (err) {
    toast(err.message);
  }
}

function fillGrid(data, i) {
  const g = geom();
  const n = g.nlat * g.nlon;
  const grid = state.grid && state.grid.length === n && !state.layer ? state.grid : new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = data[i * n + k];
    grid[k] = v === -32768 ? NaN : v / 100;
  }
  state.layer = null;
  state.grid = grid;
}

function showYear() {
  const f = state.frames;
  if (!f || state.kind !== "year") return;
  const i = f.years.indexOf(state.year);
  if (i < 0) return;
  fillGrid(f.data, i);
  afterFrame();
}

async function showMonth() {
  const want = `${state.year}-${state.month}`;
  const decade = Math.floor(state.year / 10) * 10;
  let chunk = state.monthly.get(monthlyKey(decade));
  if (!chunk) {
    loading(true, "Lade Monatskarten …");
    try { chunk = await loadMonthChunk(decade); } finally { loading(false); }
  }
  if (`${state.year}-${state.month}` !== want || state.kind !== "year" || state.res !== "monthly") return;
  const i = (state.year - chunk.y0) * 12 + (state.month - 1);
  if (i < 0 || i >= chunk.count) return;
  fillGrid(chunk.data, i);
  afterFrame();
}

function afterFrame() {
  redrawOverlay();
  updateTimebar();
  if (!state.playing) writeHash();
}

/** Jump to a fractional year from the time bar. */
function setTime(t) {
  if (state.res === "monthly") {
    state.year = Math.floor(t + 1e-6);
    state.month = Math.min(12, Math.max(1, Math.round((t - state.year) * 12) + 1));
    showMonth().catch((err) => toast(err.message));
  } else {
    state.year = Math.round(t);
    showYear();
  }
}

/** One animation step; false at the end of the data. */
async function advance() {
  if (state.res === "monthly") {
    const last = lastDataMonth();
    let { year, month } = state;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    if (year > last.y || (year === last.y && month > last.m)) return false;
    state.year = year;
    state.month = month;
    await showMonth();
    // fetch the next decade early so the animation does not stall
    const decade = Math.floor(year / 10) * 10;
    if (year % 10 >= 7 && decade + 10 <= last.y) loadMonthChunk(decade + 10).catch(() => {});
    return true;
  }
  const f = state.frames;
  if (!f || state.year >= f.years[f.years.length - 1]) return false;
  state.year += 1;
  showYear();
  return true;
}

let playTimer;
async function playStep() {
  if (!state.playing) return;
  const t0 = performance.now();
  let more;
  try { more = await advance(); } catch (err) { toast(err.message); more = false; }
  if (!state.playing) return;
  if (!more) { togglePlay(); return; }
  const delay = (state.res === "monthly" ? 110 : 190) / state.speed;
  playTimer = setTimeout(playStep, Math.max(0, delay - (performance.now() - t0)));
}

async function togglePlay() {
  if (!state.playing && state.kind !== "year") {
    // ▶ in a trend view: play the chosen period as a time-lapse
    const from = state.start;
    state.kind = "year";
    state.year = from;
    syncControls();
    writeHash();
    await refreshLayer();
  }
  state.playing = !state.playing;
  $("btn-play").textContent = state.playing ? "❚❚" : "▶";
  $("btn-play").setAttribute("aria-label", state.playing ? "Anhalten" : "Zeitraffer abspielen");
  document.body.classList.toggle("playing", state.playing);
  clearTimeout(playTimer);
  if (state.playing) {
    if (state.res !== "monthly" && !state.frames) { state.playing = false; return; }
    overlayCanvas.width = overlayCanvas.height = 1024; // lighter frames while animating
    const last = lastDataMonth();
    const atEnd = state.res === "monthly"
      ? state.year === last.y && state.month >= last.m
      : state.year >= state.frames.years[state.frames.years.length - 1];
    if (atEnd) {
      state.year = state.res === "monthly" ? Math.max(state.meta.dataset.first[0], last.y - 30) : state.frames.years[0];
      state.month = 1;
      if (state.res === "monthly") await showMonth(); else showYear();
    }
    playTimer = setTimeout(playStep, 120);
  } else {
    overlayCanvas.width = overlayCanvas.height = 1536;
    redrawOverlay();
    writeHash();
  }
}

// --- visible area & time bar ------------------------------------------------
function updateView() {
  if (!map || !state.meta) return;
  const g = geom();
  const el = map.getContainer();
  const W = el.clientWidth, H = el.clientHeight;
  const center = map.getCenter();
  const w = new Float32Array(g.nlat * g.nlon);
  let shown = 0, total = 0;
  for (let r = 0; r < g.nlat; r++) {
    const lat = g.lat0 + r * g.dlat;
    const cw = Math.cos((lat * Math.PI) / 180);
    const plat = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
    for (let c = 0; c < g.nlon; c++) {
      total += cw;
      const lon = g.lon0 + c * g.dlon;
      if (state.globe && angularDistance(center.lng, center.lat, lon, lat) > 86) continue;
      for (const off of state.globe ? [0] : [0, -360, 360]) {
        const p = map.project([lon + off, plat]);
        if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) { w[r * g.nlon + c] = cw; shown += cw; break; }
      }
    }
  }
  state.view = w;
  state.viewAll = shown > 0.97 * total;
  state.viewHemisphere = !state.viewAll && shown > 0.42 * total;
  computeViewSeries();
  updateTimebar();
}

function weightedMean(grid, weights, offset = 0) {
  let s = 0, sw = 0, all = 0;
  const n = weights.length;
  for (let k = 0; k < n; k++) {
    const w = weights[k];
    if (!w) continue;
    all += w;
    const v = grid[offset + k];
    if (v === v && v !== -32768) { s += v * w; sw += w; }
  }
  return sw > all / 3 ? s / sw : null;
}

function computeViewSeries() {
  const f = state.frames;
  if (!f || !state.view || f.key !== framesKey()) { state.viewSeries = null; return; }
  const n = state.view.length;
  const out = new Float32Array(f.years.length);
  for (let i = 0; i < f.years.length; i++) {
    const m = weightedMean(f.data, state.view, i * n);
    out[i] = m == null ? NaN : m / 100;
  }
  state.viewSeries = out;
}

function viewTrend() {
  const f = state.frames, s = state.viewSeries;
  if (!f || !s) return null;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  f.years.forEach((y, i) => {
    const v = s[i];
    if (y < state.start || y > state.end || !Number.isFinite(v)) return;
    n++; sx += y; sy += v; sxx += y * y; sxy += y * v;
  });
  if (n < 8) return null;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope, intercept: (sy - slope * sx) / n };
}

function updateTimebar() {
  if (!timebar || !state.meta) return;
  const f = state.frames;
  const ds = state.meta.dataset;
  const monthly = state.kind === "year" && state.res === "monthly";
  const domain = [f?.years[0] ?? ds.first[0], monthly ? ds.last[0] : f?.years[f.years.length - 1] ?? ds.last[0]];
  const vals = state.viewSeries ? Array.from(state.viewSeries) : [];
  const finite = vals.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const m = niceCeil(finite[Math.floor(finite.length * 0.95)] || 1);
  const props = { domain, years: f?.years || [], values: vals, scale: { kind: scaleKind(), min: -m, max: m } };
  if (state.kind === "year") {
    props.mode = "point";
    props.step = monthly ? 1 / 12 : 1;
    props.value = monthly ? state.year + (state.month - 1) / 12 : state.year ?? domain[1];
    props.maxValue = monthly ? ds.last[0] + (ds.last[1] - 1) / 12 : domain[1];
  } else {
    props.mode = "range";
    props.range = [state.start, state.end];
    props.maxYear = lastFullYear();
    props.trend = viewTrend();
  }
  timebar.set(props);
  updateReadout(props.trend);
}

function updateReadout(trend) {
  const label = state.viewAll ? "Ganze Welt" : state.viewHemisphere ? "Sichtbare Hälfte" : "Sichtbarer Ausschnitt";
  let value = "–";
  if (state.view) {
    if (state.kind === "year") {
      const v = state.grid ? weightedMean(state.grid, state.view) : null;
      if (v != null) value = `${charts.fmt(v, 2)} ${unitOf()}`;
    } else if (trend) {
      value = `${charts.fmt(trend.slope * 10, trendDigits())} ${trendShort()}`;
    }
  }
  $("tb-readout").querySelector(".tb-label").textContent = state.kind === "year" ? label : `Trend · ${label}`;
  $("tb-value").textContent = value;
  $("btn-view-region").hidden = !!state.viewAll;
}

function addViewAsRegion() {
  if (!state.view) return;
  const g = geom();
  const lats = [], lonSet = new Set();
  for (let r = 0; r < g.nlat; r++) for (let c = 0; c < g.nlon; c++) {
    if (state.view[r * g.nlon + c]) { lats.push(g.lat0 + r * g.dlat); lonSet.add(c); }
  }
  if (!lats.length) return;
  // longitudes: the visible columns form one arc; start after the largest gap
  const cols = [...lonSet].sort((a, b) => a - b);
  let gap = -1, at = 0;
  for (let i = 0; i < cols.length; i++) {
    const next = i + 1 < cols.length ? cols[i + 1] : cols[0] + g.nlon;
    if (next - cols[i] > gap) { gap = next - cols[i]; at = i; }
  }
  const startCol = cols[(at + 1) % cols.length];
  const span = (cols.length === g.nlon ? g.nlon : g.nlon - gap + 1);
  const w = g.lon0 + startCol * g.dlon - g.dlon / 2;
  const e = Math.min(w + 360, w + span * g.dlon);
  const s = Math.max(-90, Math.min(...lats) - g.dlat / 2);
  const n = Math.min(90, Math.max(...lats) + g.dlat / 2);
  const bbox = [w, s, e, n].map((v) => Math.round(v * 100) / 100);
  addRegion({ bbox, name: `Ausschnitt ${fmtLatLon(n, w)} – ${fmtLatLon(s, e)}` });
}

// ---------------------------------------------------------------------------
// Regions

function buildPresets() {
  const host = $("preset-groups");
  host.innerHTML = "";
  const groups = {};
  for (const p of state.meta.presets) {
    presetById[p.id] = p;
    (groups[p.group] ||= []).push(p);
  }
  for (const [name, items] of Object.entries(groups)) {
    const g = document.createElement("div");
    g.className = "preset-group";
    g.innerHTML = `<h4>${name}</h4>`;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const p of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.preset = p.id;
      b.textContent = p.name;
      b.title = p.note || p.name;
      b.addEventListener("click", () => togglePreset(p.id));
      chips.appendChild(b);
    }
    g.appendChild(chips);
    host.appendChild(g);
  }
}

function togglePreset(id) {
  const existing = state.regions.find((r) => r.spec.preset === id);
  if (existing) removeRegion(existing.uid);
  else addRegion({ preset: id });
}

function specKey(spec) {
  return spec.preset ? `p:${spec.preset}` : JSON.stringify(spec.bbox || spec.point || spec.polygon);
}

function addRegion(spec, { silent = false } = {}) {
  if (state.regions.some((r) => specKey(r.spec) === specKey(spec))) return;
  if (state.regions.length >= MAX_REGIONS) {
    toast(`Höchstens ${MAX_REGIONS} Regionen gleichzeitig – bitte erst eine entfernen.`);
    return;
  }
  const used = new Set(state.regions.map((r) => r.color));
  const color = COLORS.find((c) => !used.has(c));
  const name = spec.preset ? presetById[spec.preset]?.name || spec.preset : spec.name || "Eigene Region";
  state.regions.push({ uid: ++uidCounter, spec, name, color });
  if (!silent) {
    renderSelected(); drawRegionsOnMap(); refreshRegions(); writeHash();
    if (state.regions.length === 1) setAnalysisOpen(true);
  }
}

function removeRegion(uid) {
  state.regions = state.regions.filter((r) => r.uid !== uid);
  renderSelected();
  drawRegionsOnMap();
  refreshRegions();
  writeHash();
}

function regionInfo(r) {
  return state.regionData?.regions?.find((x) => x._uid === r.uid);
}

function renderSelected() {
  const ul = $("selected");
  ul.innerHTML = "";
  for (const r of state.regions) {
    const info = regionInfo(r);
    const li = document.createElement("li");
    const trend = info?.stats?.trend;
    li.innerHTML = `<span class="swatch" style="background:${r.color}"></span>`
      + `<span class="name" title="${charts.escapeHtml(r.name)}">${charts.escapeHtml(r.name)}</span>`
      + `<span class="val" title="Trend ${trendUnit()}">${trend != null ? charts.fmt(trend, trendDigits()) : ""}</span>`
      + `<button type="button" aria-label="Entfernen" title="Entfernen">✕</button>`;
    li.querySelector("button").addEventListener("click", () => removeRegion(r.uid));
    li.querySelector(".name").addEventListener("click", () => zoomToRegion(r));
    li.querySelector(".name").style.cursor = "pointer";
    ul.appendChild(li);
  }
  $("selected-hint").hidden = state.regions.length > 0;
  $("region-count").textContent = state.regions.length ? String(state.regions.length) : "";
  for (const b of document.querySelectorAll("[data-preset]")) {
    b.classList.toggle("active", state.regions.some((r) => r.spec.preset === b.dataset.preset));
  }
}

function outlineFor(r) {
  if (r.spec.preset) return presetById[r.spec.preset]?.outline;
  const info = regionInfo(r);
  if (info?.outline) return info.outline;
  if (r.spec.bbox) {
    const [w, s, e, n] = r.spec.bbox;
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  }
  if (r.spec.point) {
    const c = cellIndex(r.spec.point[0], r.spec.point[1]);
    const g = geom();
    const [w, e, s, n] = [c.lon - g.dlon / 2, c.lon + g.dlon / 2, c.lat - g.dlat / 2, c.lat + g.dlat / 2];
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  }
  return null;
}

function drawRegionsOnMap() {
  const src = map?.getSource("regions");
  if (!src) return;
  const features = [];
  for (const r of state.regions) {
    const ring = outlineFor(r);
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))) continue;
    const clamped = ring.map(([x, y]) => [x, Math.max(-MERC_MAX_LAT + 0.5, Math.min(MERC_MAX_LAT - 0.5, y))]);
    features.push({ type: "Feature", properties: { color: r.color, name: r.name }, geometry: { type: "Polygon", coordinates: [clamped] } });
  }
  src.setData({ type: "FeatureCollection", features });
}

// --- mini charts on the map ---------------------------------------------------
// Chips are laid out in screen space on every map render: each sits next to its
// region's anchor, overlaps are resolved greedily and a leader line keeps the link.
let chipItems = []; // {el, lon, lat, color}
let chipFrame = 0;

function drawRegionMarkers() {
  const layer = $("chip-layer");
  layer.querySelectorAll(".map-chip").forEach((e) => e.remove());
  chipItems = [];
  if (!map || !state.mapCharts || !state.regionData) { layoutChips(); return; }
  const startIdx = state.regionData.years.indexOf(state.start);
  const sl = (arr) => (startIdx > 0 ? arr.slice(startIdx) : arr);
  for (const r of state.regions) {
    const info = regionInfo(r);
    const ring = outlineFor(r);
    if (!info || !ring) continue;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const lat = Math.max(-80, Math.min(80, (Math.min(...ys) + Math.max(...ys)) / 2));
    const band = Math.max(...xs) - Math.min(...xs) > 300;
    if (band && Math.abs(lat) < 55) continue; // global/hemisphere bands have no sensible anchor
    const st = info.stats || {};
    const el = document.createElement("button");
    el.type = "button";
    el.className = "map-chip";
    el.style.setProperty("--c", r.color);
    el.innerHTML = `<span class="mc-name">${charts.escapeHtml(charts.truncate(r.name, 16))}</span>`
      + charts.sparkline(sl(state.regionData.years), sl(info.values), sl(info.running), { width: 84, height: 22, color: r.color })
      + `<span class="mc-val">${st.trend != null ? charts.fmt(st.trend, trendDigits()) : "–"}<small> ${trendShort()}</small></span>`;
    el.title = `${r.name}: Klick zeigt die Statistik`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.tab = "stats";
      syncControls();
      renderAnalysis();
      writeHash();
    });
    layer.appendChild(el);
    chipItems.push({ el, lon: (Math.min(...xs) + Math.max(...xs)) / 2, lat, band, color: r.color });
  }
  layoutChips();
}

function angularDistance(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const c = Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon1 - lon2) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

function layoutChips() {
  chipFrame = 0;
  const svg = $("chip-lines");
  svg.innerHTML = "";
  if (!chipItems.length || !map) return;
  const W = $("map").clientWidth, H = $("map").clientHeight;
  const center = map.getCenter();
  // Floating panels count as occupied space.
  const area = $("map").getBoundingClientRect();
  const placed = [...document.querySelectorAll("#controls, #legend, #regions-panel, #timebar, #headline")]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width && r.height)
    .map((r) => ({ x: r.left - area.left, y: r.top - area.top, w: r.width, h: r.height }));
  const items = chipItems.map((it) => {
    const lon = it.band ? center.lng : it.lon;
    const visible = !state.globe || angularDistance(center.lng, center.lat, lon, it.lat) < 80;
    const p = map.project([lon, it.lat]);
    return { ...it, p, visible, w: it.el.offsetWidth || 110, h: it.el.offsetHeight || 52 };
  });
  const overlaps = (a) => a.x < 4 || a.y < 4 || a.x + a.w > W - 4 || a.y + a.h > H - 4
    || placed.some((b) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4);
  for (const it of items.sort((a, b) => a.p.y - b.p.y)) {
    if (!it.visible || it.p.x < -50 || it.p.x > W + 50 || it.p.y < -50 || it.p.y > H + 50) { it.el.style.display = "none"; continue; }
    it.el.style.display = "";
    const g = 12;
    const candidates = [
      [-it.w / 2, -it.h - g], [g, -it.h / 2], [-it.w - g, -it.h / 2], [-it.w / 2, g],
      [g, -it.h - g], [-it.w - g, -it.h - g], [g, g], [-it.w - g, g],
    ];
    for (let ring = 1; ring <= 4; ring++) {
      candidates.push([-it.w / 2, -it.h - g - ring * (it.h + 8)], [g + ring * (it.w + 8), -it.h / 2], [-it.w - g - ring * (it.w + 8), -it.h / 2], [-it.w / 2, g + ring * (it.h + 8)]);
    }
    let box = null;
    for (const [dx, dy] of candidates) {
      const b = { x: it.p.x + dx, y: it.p.y + dy, w: it.w, h: it.h };
      if (!overlaps(b)) { box = b; break; }
    }
    box ||= { x: it.p.x - it.w / 2, y: it.p.y - it.h - g, w: it.w, h: it.h };
    placed.push(box);
    it.el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
    // leader line from the anchor to the nearest point of the chip
    const tx = Math.max(box.x, Math.min(it.p.x, box.x + box.w));
    const ty = Math.max(box.y, Math.min(it.p.y, box.y + box.h));
    svg.insertAdjacentHTML("beforeend",
      `<line x1="${it.p.x}" y1="${it.p.y}" x2="${tx}" y2="${ty}" stroke="${it.color}" stroke-width="1.5" stroke-opacity="0.9"/>`
      + `<circle cx="${it.p.x}" cy="${it.p.y}" r="3.5" fill="${it.color}" stroke="#05080d" stroke-width="1.5"/>`);
  }
}

function scheduleChipLayout() {
  if (chipFrame || !chipItems.length) return;
  chipFrame = requestAnimationFrame(layoutChips);
}

function zoomToRegion(r) {
  const ring = outlineFor(r);
  if (!ring) return;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const b = [[Math.min(...xs), Math.max(-80, Math.min(...ys))], [Math.max(...xs), Math.min(80, Math.max(...ys))]];
  if (b[1][0] - b[0][0] > 300) map.flyTo({ center: [0, (b[0][1] + b[1][1]) / 2], zoom: 1.2 });
  else map.fitBounds(b, { padding: 60, maxZoom: 5.5, duration: 900 });
}

let regionReq = 0;
async function refreshRegions() {
  const req = ++regionReq;
  if (!state.regions.length) {
    state.regionData = null;
    drawRegionMarkers();
    renderSelected();
    renderAnalysis();
    return;
  }
  loading(true, "Berechne Regionen …");
  try {
    const custom = state.regions.map((r) => ({ ...r.spec, id: String(r.uid), name: r.name }));
    const data = await getJSON("regions", { custom: JSON.stringify(custom), ...periodParams() });
    if (req !== regionReq) return;
    data.regions.forEach((x, i) => { x._uid = state.regions[i]?.uid; });
    state.regionData = data;
    renderSelected();
    drawRegionsOnMap();
    drawRegionMarkers();
    renderAnalysis();
  } catch (err) {
    toast(err.message);
  } finally {
    loading(false);
  }
}

// --- search -------------------------------------------------------------------
function buildSearch() {
  const input = $("search");
  const list = $("search-results");
  let items = [];
  let active = -1;
  const render = () => {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = i === active ? "active" : "";
      li.innerHTML = `${charts.escapeHtml(it.name)} <span class="kind">${charts.escapeHtml(it.kind)}</span>`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(it); });
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const choose = (it) => {
    if (!it.spec) {
      toast(`„${it.name.split(",")[0]}“ reicht über die Datumsgrenze; der Suchdienst liefert dafür nur einen weltumspannenden Rahmen. Bitte die Region mit ▭ selbst aufziehen.`, "info");
      return;
    }
    addRegion(it.spec);
    input.value = "";
    items = [];
    render();
    const r = state.regions[state.regions.length - 1];
    if (r) zoomToRegion(r);
  };
  const search = debounce(async (q) => {
    const local = state.meta.presets
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ name: p.name, kind: "Vordefiniert", spec: { preset: p.id } }));
    items = local;
    active = items.length ? 0 : -1;
    render();
    if (q.length < 3) return;
    try {
      const res = await fetch("/api/places?q=" + encodeURIComponent(q));
      const body = await res.json();
      if (input.value.trim() !== q) return;
      const remote = (body.places || []).map((p) => {
        const [w, s, e, n] = p.bbox;
        if (e - w > 180) {
          // Nominatim gives -180…180 for places that cross the date line (USA, Russia, Fiji …).
          return { name: p.label || p.name, kind: "über die Datumsgrenze – bitte als Rechteck zeichnen", spec: null };
        }
        const tiny = e - w < 0.05 && n - s < 0.05;
        const spec = tiny ? { point: [p.lon, p.lat], name: p.name } : { bbox: [w, s, e, n], name: p.name };
        return { name: p.label || p.name, kind: tiny ? "Punkt → 2°-Zelle" : p.kind || "Gebiet", spec };
      });
      items = local.concat(remote);
      active = items.length ? 0 : -1;
      render();
    } catch { /* place search is optional */ }
  }, 300);
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) { items = []; render(); return; }
    search(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && items[active]) { choose(items[active]); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  input.addEventListener("focus", () => { if (items.length) list.hidden = false; });
}

// ---------------------------------------------------------------------------
// Analysis drawer

function setupResize() {
  const handle = $("resize-handle");
  let startY = 0, startH = 0;
  const move = (e) => {
    const h = Math.min(window.innerHeight * 0.8, Math.max(140, startH - (e.clientY - startY)));
    document.documentElement.style.setProperty("--analysis-h", `${h}px`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    map?.resize();
    renderAnalysis();
  };
  handle.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    startH = $("analysis").getBoundingClientRect().height;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  });
}

function downloadCsv() {
  const d = state.regionData;
  if (!d) { toast("Keine Regionen gewählt.", "info"); return; }
  const series = seriesForCharts();
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    `# TrendDetective Global Explorer – ${state.meta.dataset.name}`,
    `# Anomalie in ${unitOf()} gegenüber ${d.baseline[0]}-${d.baseline[1]}, ${d.season_label}; flächengewichtetes Mittel je Region`,
    `# Quelle: ${state.meta.dataset.url}`,
    ["year", ...series.flatMap((s) => [q(`${s.name} anomaly`), q(`${s.name} mean11y`), q(`${s.name} trend30y_per_decade`), q(`${s.name} coverage`)])].join(","),
  ];
  d.years.forEach((y, i) => {
    const row = [y];
    for (const s of series) row.push(s.values[i] ?? "", s.running[i] ?? "", s.rolling?.[i] ?? "", s.coverage[i] ?? "");
    lines.push(row.join(","));
  });
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trenddetective_${state.season}_${d.period[0]}-${d.period[1]}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function seriesForCharts() {
  const d = state.regionData;
  if (!d) return [];
  return d.regions.map((x) => {
    const r = state.regions.find((y) => y.uid === x._uid);
    return {
      uid: x._uid, name: r?.name || x.name, color: r?.color || "#888", values: x.values, running: x.running,
      coverage: x.coverage, stats: x.stats, monthly: x.monthly_trends, rolling: x.rolling_trend, rollingCi: x.rolling_ci, raw: x,
    };
  });
}

const rankingCache = new Map();
const zonalCache = new Map();
const distCache = new Map();
let renderToken = 0;

async function renderAnalysis() {
  const token = ++renderToken;
  const stale = () => token !== renderToken;
  const body = $("analysis-body");
  if (document.querySelector(".layout").classList.contains("analysis-collapsed")) return;
  const d = state.regionData;
  $("analysis-meta").textContent = `${seasonLabel()} · ${state.start}–${state.end} · Referenz ${baselineLabel()} · ${state.ds === "gpcp" ? "GPCP v2.3" : "NASA GISTEMP v4"}`;
  const series = seriesForCharts();
  const needRegions = ["series", "tempo", "stripes", "seasons", "stats", "dist"].includes(state.tab);
  if (needRegions && !series.length) {
    body.innerHTML = `<div class="empty"><b>Noch keine Region gewählt.</b><br>Klicke eine Stelle auf der Karte an, suche oben rechts nach einem Ort oder zieh mit ▭ ein Rechteck auf.<br>Ohne Auswahl funktionieren <a href="#" data-tab-link="ranking">Ranking</a> und <a href="#" data-tab-link="zonal">Breitengrade</a>.</div>`;
    body.querySelectorAll("[data-tab-link]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      state.tab = a.dataset.tabLink;
      syncControls();
      renderAnalysis();
      writeHash();
    }));
    return;
  }
  try {
    if (state.tab === "series") {
      charts.timeSeries(body, { years: d.years, series, period: d.period, baselineLabel: baselineLabel() });
    } else if (state.tab === "tempo") {
      charts.rollingTrend(body, { years: d.years, series, window: d.rolling_window, global: null });
    } else if (state.tab === "dist") {
      await renderDistribution(body, series, stale);
    } else if (state.tab === "stripes") {
      charts.stripes(body, { years: d.years, series });
      const note = document.createElement("p");
      note.className = "hint";
      note.style.marginTop = "6px";
      note.textContent = `Jeder Streifen = ein Jahr (${seasonLabel()}), Farbe = Anomalie ggü. ${baselineLabel()}. Gemeinsame Farbskala für alle Regionen; grau = keine ausreichende Datenabdeckung.`;
      body.appendChild(note);
    } else if (state.tab === "seasons") {
      charts.seasons(body, { series });
    } else if (state.tab === "stats") {
      renderStats(body, series, d);
    } else if (state.tab === "ranking") {
      const key = JSON.stringify(periodParams());
      if (!rankingCache.has(key)) {
        body.innerHTML = `<div class="empty">Berechne Ranking aller Regionen …</div>`;
        rankingCache.set(key, await getJSON("ranking", periodParams()));
        if (stale()) return;
      }
      const ranking = rankingCache.get(key);
      const colors = {};
      for (const r of state.regions) if (r.spec.preset) colors[r.spec.preset] = r.color;
      charts.ranking(body, {
        rows: ranking.rows,
        global: ranking.global.trend,
        selectedIds: state.regions.filter((r) => r.spec.preset).map((r) => r.spec.preset),
        colors,
        onPick: (id) => { togglePreset(id); setTimeout(renderAnalysis, 0); },
      });
    } else if (state.tab === "zonal") {
      const key = JSON.stringify(commonParams());
      if (!zonalCache.has(key)) {
        body.innerHTML = `<div class="empty">Berechne Zonalmittel …</div>`;
        zonalCache.set(key, await getJSON("zonal", commonParams()));
        if (stale()) return;
      }
      const z = zonalCache.get(key);
      const highlight = state.regions.map((r) => {
        const ring = outlineFor(r);
        if (!ring) return null;
        const ys = ring.map((p) => p[1]);
        return { lat: [Math.min(...ys), Math.max(...ys)], color: r.color };
      }).filter(Boolean);
      body.innerHTML = "";
      const split = document.createElement("div");
      split.className = "split";
      const left = document.createElement("div");
      left.style.minHeight = "0";
      const right = document.createElement("div");
      right.className = "side-note";
      right.innerHTML = `<h4>Hovmöller-Diagramm</h4><p>Mittlere Anomalie jedes Breitenkreises (über alle Längengrade) für jedes Jahr. So sieht man, <b>wo</b> und <b>wann</b> sich das Klima verändert hat.</p>${isTemp() ? "<p>Die rote Fläche oben rechts ist die <b>arktische Verstärkung</b>: Seit etwa 2000 erwärmt sich der hohe Norden viel stärker als der Rest der Welt.</p>" : "<p>Beim Niederschlag zeigt das Diagramm u. a. die Verschiebung der tropischen Regengürtel und feuchtere hohe Breiten; El-Niño-Jahre (z. B. 1983, 1998, 2016) erscheinen als Streifen in den Tropen.</p>"}${isTemp() ? "<p>Leere Flächen: weniger als ein Viertel des Breitenkreises hat Messungen (z. B. Antarktis vor 1957).</p>" : ""}<p>Farbige Balken rechts = Breitenbereich deiner Regionen; gestrichelt = gewählter Zeitraum.</p>`;
      split.append(left, right);
      body.appendChild(split);
      charts.hovmoller(left, { years: z.years, lats: z.lats, values: z.values, period: [state.start, state.end], highlight });
    }
  } catch (err) {
    if (!stale()) body.innerHTML = `<div class="empty">${charts.escapeHtml(err.message)}</div>`;
  }
}

async function renderDistribution(body, series, stale) {
  if (!series.some((s) => s.uid === state.distUid)) state.distUid = series[0].uid;
  const r = state.regions.find((x) => x.uid === state.distUid);
  const spec = { ...r.spec, name: r.name };
  const params = { ds: state.ds, region: JSON.stringify(spec), season: state.season, baseline: state.baseline };
  const key = JSON.stringify(params);
  if (!distCache.has(key)) {
    body.innerHTML = `<div class="empty">Berechne Verteilung …</div>`;
    distCache.set(key, await getJSON("distribution", params));
    if (stale()) return;
  }
  const d = distCache.get(key);
  body.innerHTML = "";
  const split = document.createElement("div");
  split.className = "split";
  const left = document.createElement("div");
  left.style.cssText = "min-height:0;display:flex;flex-direction:column";
  const pick = document.createElement("div");
  pick.className = "chips small";
  pick.style.marginBottom = "6px";
  for (const s of series) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (s.uid === state.distUid ? " active" : "");
    b.innerHTML = `<span style="color:${s.color}">■</span> ${charts.escapeHtml(charts.truncate(s.name, 26))}`;
    b.addEventListener("click", () => { state.distUid = s.uid; renderAnalysis(); });
    pick.appendChild(b);
  }
  const chartHost = document.createElement("div");
  chartHost.style.cssText = "flex:1;min-height:0;position:relative";
  left.append(pick, chartHost);
  const right = document.createElement("div");
  right.className = "side-note";
  split.append(left, right);
  body.appendChild(split);
  const colors = charts.distributionChart(chartHost, d);
  const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0).replace(".", ",")} %`);
  right.innerHTML = `<h4>${charts.escapeHtml(r.name)} · ${charts.escapeHtml(d.season_label)}</h4>`
    + `<table class="stats"><thead><tr><th>Zeitraum</th><th>Mittel</th><th>&gt; 2σ</th><th>&gt; 3σ</th></tr></thead><tbody>`
    + d.periods.map((p, k) => `<tr><td><span style="color:${colors[Math.min(k, colors.length - 1)]}">■</span> ${p.period[0]}–${p.period[1]}</td><td>${charts.fmt(p.mean, 1)}σ</td><td>${pct(p.above2)}</td><td>${pct(p.above3)}</td></tr>`).join("")
    + `</tbody></table>`
    + `<p style="margin-top:8px">Jede Gitterzelle und jedes Jahr wird an der <b>eigenen</b> Jahr-zu-Jahr-Schwankung (σ) der Referenzperiode ${d.baseline[0]}–${d.baseline[1]} gemessen. In einem stabilen Klima läge nur ≈ 2 % der Fläche über 2σ und ≈ 0,1 % über 3σ.</p>`
    + `<p>Rechtsverschiebung = was früher ein seltenes ${isTemp() ? "Hitze" : "Nass"}-${d.season_label === "Jahr" ? "jahr" : "saison"} war, ist heute ${isTemp() ? "normal" : "häufiger"}; Linksverschiebung = trockener (nach Hansen et al. 2012, PNAS).</p>`
    + `<p class="hint">${d.cells} Gitterzellen. ${isTemp() ? "Vorsicht beim Vergleich mit Stationsdaten: GISTEMP glättet über bis zu 1200 km, und über dem Meer schwankt die Temperatur wenig – beides macht σ klein und die Verschiebung in σ größer als an einer einzelnen Wetterstation. Am aussagekräftigsten ist der Sommer (JJA) über Land." : "Niederschlag ist nicht normalverteilt (rechtsschief) – die σ-Skala ist hier eine grobe Orientierung."}</p>`;
}

const STAT_ROWS = [
  { group: "Trend im Zeitraum" },
  { key: "trend", label: "Linearer Trend (OLS)", unit: "T", digits: 3, info: "Kleinste-Quadrate-Gerade durch die Jahreswerte." },
  { key: "trend_ci", label: "± 95-%-Konfidenz", unit: "T", digits: 3, signed: false, info: "Autokorrelationskorrigiert (effektive Stichprobengröße, Santer et al. 2000)." },
  { key: "trend_p", label: "p-Wert (t-Test, AR1-korr.)", p: true },
  { key: "sen", label: "Theil-Sen-Steigung", unit: "T", digits: 3, info: "Robuster Median aller paarweisen Steigungen – unempfindlich gegen Ausreißer." },
  { key: "mk_p", label: "Mann-Kendall p-Wert", p: true, info: "Nichtparametrischer Trendtest (ohne Autokorrelationskorrektur)." },
  { key: "change", label: "Änderung über den Zeitraum", unit: "U", digits: 2, info: "Trend × Länge des Zeitraums." },
  { key: "trend_rel", label: "Relativer Trend", unit: "%/Dek.", digits: 1, info: "Trend geteilt durch das Klimamittel 1991–2020 der Region." },
  { key: "vs_global", label: "Faktor ggü. globalem Trend", unit: "×", digits: 2, signed: false },
  { group: "Dynamik" },
  { key: "trend_first_half", label: "Trend 1. Hälfte", unit: "T", digits: 3, halves: 0 },
  { key: "trend_second_half", label: "Trend 2. Hälfte", unit: "T", digits: 3, halves: 1 },
  { key: "acceleration", label: "Beschleunigung", unit: "T", digits: 3, info: "Trend 2. Hälfte minus Trend 1. Hälfte; fett = signifikant (|Δ| > 1,96·σ)." },
  { key: "snr", label: "Signal / Rauschen", unit: "σ", digits: 1, signed: false, info: "Lineare Änderung geteilt durch Standardabweichung der trendbereinigten Jahreswerte." },
  { key: "emergence_year", label: "Signal tritt hervor ab", year: true, info: "Erstes Jahr, ab dem das 11-Jahres-Mittel dauerhaft über 2σ der Jahresschwankung der Referenzperiode liegt (Hawkins & Sutton 2012)." },
  { group: "Niveau" },
  { key: "mean_last10", label: "Mittel letzte 10 Jahre", unit: "U", digits: 2 },
  { key: "clim", label: "Klimamittel 1991–2020 (absolut)", unit: "U", digits: 2, signed: false },
  { key: "warmest", label: "W", list: true },
  { key: "noise_std", label: "Jahr-zu-Jahr-Schwankung (σ)", unit: "U", digits: 2, signed: false },
  { group: "Region" },
  { key: "_area", label: "Fläche", area: true },
  { key: "_cells", label: "G", cells: true },
];

function renderStats(body, series, d) {
  body.innerHTML = "";
  // Key figures first
  const kpis = document.createElement("div");
  kpis.className = "kpis";
  for (const s of series) {
    const st = s.stats;
    kpis.innerHTML += `<div class="kpi"><div class="k-name"><i style="background:${s.color}"></i>${charts.escapeHtml(charts.truncate(s.name, 24))}</div>`
      + `<div class="k-val">${charts.fmt(st.trend, trendDigits())} <small>${trendShort()}</small></div>`
      + `<div class="k-sub">${st.vs_global != null ? "× " + st.vs_global.toFixed(1).replace(".", ",") + " global · " : ""}${st.trend_rel != null ? charts.fmt(st.trend_rel, 1) + " %/Dek. · " : ""}${charts.fmt(st.change, isTemp() ? 1 : 2)} ${unitOf()} seit ${d.period[0]}</div></div>`;
  }
  body.appendChild(kpis);
  body.appendChild(summaryText(series, d));
  const table = document.createElement("table");
  table.className = "stats";
  let html = `<thead><tr><th>${d.season_label}, ${d.period[0]}–${d.period[1]}</th>${series.map((s) => `<th><span style="color:${s.color}">■</span> ${charts.escapeHtml(charts.truncate(s.name, 20))}</th>`).join("")}</tr></thead><tbody>`;
  const present = (key) => series.some((x) => x.stats?.[key] != null);
  for (const row of STAT_ROWS) {
    if (row.key && !row.key.startsWith("_") && !row.group && ["trend_rel", "clim", "vs_global"].includes(row.key) && !present(row.key)) continue;
    if (row.group) { html += `<tr class="grp"><td colspan="${series.length + 1}">${row.group}</td></tr>`; continue; }
    let label = row.label === "W" ? (isTemp() ? "Wärmste Jahre" : "Nasseste Jahre")
      : row.label === "G" ? `${state.meta.dataset.resolution}-Gitterzellen` : row.label;
    if (row.halves != null) {
      const h = series[0]?.stats?.halves?.[row.halves];
      if (h) label += ` (${h[0]}–${h[1]})`;
    }
    html += `<tr><td>${row.info ? `<span class="info" title="${charts.escapeHtml(row.info)}">${label}</span>` : label}</td>`;
    for (const s of series) {
      const st = s.stats || {};
      let cell = "–", cls = "";
      if (row.p) { cell = charts.fmtP(st[row.key]); cls = st[row.key] != null && st[row.key] < 0.05 ? "sig" : "nsig"; }
      else if (row.year) cell = st[row.key] ?? "noch nicht";
      else if (row.list) cell = (st[row.key] || []).map(([y, v]) => `${y} (${charts.fmt(v, 1)})`).join(", ") || "–";
      else if (row.area) cell = s.raw.area_km2 != null ? `${Math.round(s.raw.area_km2).toLocaleString("de-DE")} km²` : "–";
      else if (row.cells) cell = s.raw.cells;
      else {
        const digits = row.unit === "T" ? Math.max(row.digits, trendDigits()) : row.digits;
        cell = charts.fmt(st[row.key], digits, row.signed !== false);
        const unit = row.unit === "T" ? trendShort() : row.unit === "U" ? unitOf() : row.unit;
        if (cell !== "–" && unit) cell += ` ${unit}`;
        if (row.key === "acceleration" && st.acceleration_significant) cell = `<b>${cell}</b>`;
      }
      html += `<td class="${cls}">${cell}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  table.innerHTML = html;
  body.appendChild(table);
  const notes = series.filter((s) => s.raw.note).map((s) => `<b>${charts.escapeHtml(s.name)}:</b> ${charts.escapeHtml(s.raw.note)}`);
  if (notes.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.marginTop = "8px";
    p.innerHTML = notes.join("<br>");
    body.appendChild(p);
  }
}

function summaryText(series, d) {
  const p = document.createElement("p");
  p.className = "hint";
  p.style.margin = "0 0 10px";
  p.style.fontSize = "12.5px";
  p.style.color = "var(--text-2)";
  const valid = series.filter((s) => s.stats?.trend != null);
  if (!valid.length) return p;
  const name = (s) => `<b>${charts.escapeHtml(s.name)}</b>`;
  const tr = (s) => `${charts.fmt(s.stats.trend, trendDigits())} ${trendUnit()}`;
  const nsig = (s) => (s.stats.trend_p != null && s.stats.trend_p >= 0.05 ? ", statistisch nicht signifikant" : "");
  let txt;
  if (isTemp()) {
    const sorted = [...valid].sort((a, b) => b.stats.trend - a.stats.trend);
    const fast = sorted[0], slow = sorted[sorted.length - 1];
    const g = d.global?.trend;
    txt = `Im Zeitraum ${d.period[0]}–${d.period[1]} (${d.season_label}) erwärmt sich ${name(fast)} am schnellsten mit ${tr(fast)}`;
    if (fast.stats.vs_global != null) txt += ` – ${fast.stats.vs_global.toFixed(1).replace(".", ",")}-mal so schnell wie die Welt im Mittel (${charts.fmt(g, 2)} °C/Dek.)`;
    txt += ".";
    if (sorted.length > 1) txt += ` Am langsamsten: ${name(slow)} (${tr(slow)}${nsig(slow)}).`;
    const acc = valid.filter((s) => s.stats.acceleration_significant && s.stats.acceleration > 0);
    if (acc.length) txt += ` Signifikant beschleunigt hat sich die Erwärmung in: ${acc.map((s) => charts.escapeHtml(s.name)).join(", ")}.`;
  } else {
    const key = (s) => s.stats.trend_rel ?? s.stats.trend;
    const sorted = [...valid].sort((a, b) => key(b) - key(a));
    const wet = sorted[0], dry = sorted[sorted.length - 1];
    const rel = (s) => (s.stats.trend_rel != null ? ` bzw. ${charts.fmt(s.stats.trend_rel, 1)} % pro Dekade` : "");
    txt = `Im Zeitraum ${d.period[0]}–${d.period[1]} (${d.season_label}) wird ${name(wet)} am deutlichsten feuchter (${tr(wet)}${rel(wet)}${nsig(wet)})`;
    if (sorted.length > 1) txt += `, ${name(dry)} am deutlichsten trockener (${tr(dry)}${rel(dry)}${nsig(dry)})`;
    const sig = valid.filter((s) => s.stats.trend_p != null && s.stats.trend_p < 0.05);
    txt += `. Niederschlag schwankt stark von Jahr zu Jahr – ${sig.length ? `signifikant ist der Trend nur in: ${sig.map((s) => charts.escapeHtml(s.name)).join(", ")}` : "keiner der Trends ist statistisch signifikant"}.`;
  }
  p.innerHTML = txt;
  return p;
}

function buildAbout() {
  const ds = state.meta.dataset;
  $("about-body").innerHTML = `
    <h3>Daten</h3>
    ${isTemp()
      ? `<p><b>${ds.name}</b> – monatliche Oberflächentemperatur-Anomalien auf einem 2°×2°-Gitter (≈ 220 km), ${ds.first[0]} bis ${ds.last[1]}/${ds.last[0]}, relativ zu ${ds.baseline[0]}–${ds.baseline[1]}. Über Land aus rund 27 000 Wetterstationen (GHCNv4), über dem Meer aus Schiffs- und Bojenmessungen (ERSSTv5). NASA interpoliert jede Zelle aus Stationen im Umkreis von 1200 km – Zellen ohne Station in Reichweite bleiben <b>leer</b>, es wird nichts erfunden.</p>`
      : `<p><b>${ds.name}</b> – monatlicher Niederschlag auf einem 2,5°×2,5°-Gitter (≈ 280 km), ${ds.first[0]} bis ${ds.last[1]}/${ds.last[0]}. Kombiniert Satellitenmessungen (Mikrowelle/Infrarot) mit Regenmesser-Daten des Weltzentrums für Niederschlagsklimatologie (GPCC, DWD). Anomalien beziehen sich auf das Monatsmittel ${ds.baseline[0]}–${ds.baseline[1]}; „relativer Trend“ teilt durch dieses Klimamittel. Niederschlag schwankt stark von Jahr zu Jahr, Trends sind daher seltener signifikant als bei der Temperatur.</p>`}
    <p class="hint">${charts.escapeHtml(ds.citation)} · <a href="${ds.url}" target="_blank" rel="noopener">${ds.url}</a></p>
    <h3>Karte</h3>
    <p>Die Werte gehören zu den Mittelpunkten der Gitterzellen. Für die glatte Darstellung wird zwischen den vier benachbarten Mittelpunkten <b>bilinear interpoliert</b>; wo Nachbarn fehlen, wird nur zwischen vorhandenen Werten gemittelt und nicht über Datenlücken hinaus extrapoliert. Mit „Zwischen Gitterpunkten interpolieren“ aus siehst du die Rohzellen.</p>
    <h3>Statistik</h3>
    <ul>
      <li><b>Trend</b>: lineare Regression (kleinste Quadrate) der Jahres- bzw. Jahreszeitenmittel. Konfidenzintervall und p-Wert sind für Autokorrelation erster Ordnung korrigiert (Santer et al. 2000). Eine Zelle bekommt nur einen Trend, wenn mindestens ⅔ der Jahre und jedes Drittel des Zeitraums Daten haben.</li>
      <li><b>Robuste Prüfung</b>: Theil-Sen-Steigung und Mann-Kendall-Test.</li>
      <li><b>Beschleunigung</b>: Trend der zweiten minus Trend der ersten Hälfte des Zeitraums – die „zweite Ableitung“ der Temperatur.</li>
      <li><b>Signal/Rauschen &amp; Zeitpunkt des Hervortretens</b>: wie deutlich sich die Veränderung von der natürlichen Jahr-zu-Jahr-Schwankung abhebt (Hawkins &amp; Sutton 2012).</li>
      <li><b>${isTemp() ? "Erwärmungstempo" : "Trendtempo"}</b>: Trend der jeweils letzten 30 Jahre, für jedes Endjahr neu berechnet – zeigt, ob und wann sich die Veränderung beschleunigt hat.</li>
      <li><b>Extreme</b>: Jede Zelle und jedes Jahr wird mit Mittel und Schwankung (σ) der Referenzperiode standardisiert; die Kurven zeigen, wie sich die Verteilung verschiebt und wie oft früher seltene (&gt; 2σ) oder extreme (&gt; 3σ) Werte heute auftreten (Hansen, Sato &amp; Ruedy 2012).</li>
      <li><b>Räumlicher Gradient</b>: Betrag des räumlichen Gradienten des Trendfelds (zentrale Differenzen) in ${trendUnit()} pro 1000 km.</li>
      <li><b>Regionen</b>: flächengewichtetes Mittel (cos Breite × Anteil der Zelle in der Region). Jahre mit weniger als ⅓ Datenabdeckung der Region werden nicht gezeigt.</li>
      <li><b>Referenzperiode</b> verschiebt nur das Nullniveau der Anomalien, Trends bleiben gleich.</li>
    </ul>
    <h3>Grenzen</h3>
    <p>2° sind für kleine Regionen wie NRW grob (wenige Zellen); dafür ist die stationsbasierte Analyse dieses Projekts besser geeignet. Frühe Jahre (vor ~1950) haben besonders in Polarregionen, Afrika und auf den Südmeeren wenige Messungen – die Flächenabdeckung steht im Tooltip der Zeitreihe.</p>`;
}

// ---------------------------------------------------------------------------

function refreshAll() {
  writeHash();
  refreshLayer();
  refreshRegions();
}

async function main() {
  const hashDs = new URLSearchParams(location.hash.slice(1)).get("d");
  if (hashDs && ["gistemp", "gpcp"].includes(hashDs)) state.ds = hashDs;
  try {
    state.meta = await getJSON("meta", { ds: state.ds });
  } catch (err) {
    $("hl-time").textContent = "Datensatz nicht verfügbar";
    $("hl-sub").textContent = err.message;
    return;
  }
  const ds = state.meta.dataset;
  state.baseline = `${ds.baseline[0]}-${ds.baseline[1]}`;
  state.start = Math.max(state.start, ds.first[0]);
  state.end = lastFullYear();
  state.year = state.end;
  buildControls();
  configureCharts();
  readHash();
  if (!state.end) state.end = lastFullYear();
  // The analysis drawer starts closed until there is something to analyse.
  const hasTab = new URLSearchParams(location.hash.slice(1)).has("t");
  if (!state.regions.length && !hasTab) {
    document.querySelector(".layout").classList.add("analysis-collapsed");
    $("btn-toggle-analysis").textContent = "▴";
  } else {
    $("btn-toggle-analysis").textContent = "▾";
  }
  syncControls();
  renderSelected();
  initMap();
  refreshLayer();
  refreshRegions();
  window.addEventListener("resize", debounce(() => renderAnalysis(), 150));
}

main();
