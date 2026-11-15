// Small SVG/canvas chart toolkit for the analysis drawer (no dependencies).
import { cssColor, niceCeil, SCALES, colorFor } from "./colormap.js";

const NS = "http://www.w3.org/2000/svg";

// Units and colour scale of the active dataset (set by the app via configure()).
const CFG = { unit: "°C", trendUnit: "°C/Dekade", trendShort: "°C/Dek.", digits: 2, scale: "diverging", trendTitle: "Erwärmungstrend" };
export function configure(opts) { Object.assign(CFG, opts); }

export function fmt(v, digits = 2, signed = true) {
  if (v == null || !Number.isFinite(v)) return "–";
  const s = v.toFixed(digits).replace(".", ",").replace("-", "−");
  return signed && v > 0 ? "+" + s : s;
}

export function fmtP(p) {
  if (p == null) return "–";
  if (p < 0.001) return "< 0,001";
  return p.toFixed(3).replace(".", ",");
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function ticks(min, max, count = 6) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function makeTip(container) {
  let tip = container.querySelector(":scope > .tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    container.appendChild(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const cw = container.clientWidth;
      const w = tip.offsetWidth;
      const left = x + 14 + w > cw ? x - w - 14 : x + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function frame(container, margin) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "chart";
  container.appendChild(div);
  const W = Math.max(280, div.clientWidth || container.clientWidth);
  const H = Math.max(180, div.clientHeight || 260);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" }, div);
  return { div, svg, W, H, iw: W - margin.l - margin.r, ih: H - margin.t - margin.b };
}

/**
 * Anomaly time series: thin annual line, bold 11-yr running mean, dashed OLS trend over the period.
 * series: [{name, color, values[], running[], coverage[], stats}]
 */
export function timeSeries(container, { years, series, period, unit = CFG.unit, baselineLabel }) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "series-wrap";
  container.appendChild(wrap);
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = series.map((s) => `<span style="--c:${s.color}">${escapeHtml(s.name)}</span>`).join("")
    + `<span class="key thin">Jahreswert</span><span class="key thick">11-Jahres-Mittel</span><span class="key dash">Linearer Trend ${period[0]}–${period[1]}</span>`;
  wrap.appendChild(legend);
  const host = document.createElement("div");
  host.style.flex = "1";
  host.style.minHeight = "0";
  host.style.position = "relative";
  wrap.appendChild(host);

  const direct = series.length <= 4 && host.clientWidth >= 560;
  const m = { l: 44, r: direct ? 118 : 12, t: 8, b: 26 };
  const { div, svg, W, H, iw, ih } = frame(host, m);
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const x0 = years[0], x1 = years[years.length - 1];
  const X = (yr) => m.l + ((yr - x0) / (x1 - x0)) * iw;
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;

  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  for (const t of ticks(lo, hi, 6)) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }, grid);
    el("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end" }, axis).textContent = fmt(t, Math.abs(t) < 1 && t !== 0 ? 1 : 1, false).replace("+", "");
  }
  for (const t of ticks(x0, x1, Math.max(4, Math.round(iw / 90)))) {
    el("text", { x: X(t), y: H - 8, "text-anchor": "middle" }, axis).textContent = t;
  }
  el("rect", { class: "period-band", x: X(period[0]), y: m.t, width: Math.max(0, X(period[1]) - X(period[0])), height: ih }, svg);
  if (lo < 0 && hi > 0) el("line", { class: "zero", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }, svg);
  const yt = el("text", { class: "axis-title", x: 12, y: m.t + ih / 2, transform: `rotate(-90 12 ${m.t + ih / 2})`, "text-anchor": "middle" }, svg);
  yt.textContent = `Anomalie (${unit}) ggü. ${baselineLabel}`;

  const path = (vals) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(years[i]).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const labels = [];
  for (const s of series) {
    el("path", { d: path(s.values), fill: "none", stroke: s.color, "stroke-width": 1, "stroke-opacity": 0.5 }, svg);
    el("path", { d: path(s.running), fill: "none", stroke: s.color, "stroke-width": 2.25, "stroke-linejoin": "round" }, svg);
    const st = s.stats || {};
    if (st.trend != null && st.intercept != null) {
      const f = (yr) => st.intercept + (st.trend / 10) * (yr - st.x_mean);
      el("line", {
        x1: X(period[0]), y1: Y(f(period[0])), x2: X(period[1]), y2: Y(f(period[1])),
        stroke: s.color, "stroke-width": 1.5, "stroke-dasharray": "5 4",
      }, svg);
    }
    let lastIdx = -1;
    s.running.forEach((v, i) => { if (v != null) lastIdx = i; });
    if (lastIdx < 0) s.values.forEach((v, i) => { if (v != null) lastIdx = i; });
    if (lastIdx >= 0 && direct) {
      const v = s.running[lastIdx] ?? s.values[lastIdx];
      labels.push({ y: Y(v), x: X(years[lastIdx]), name: s.name, color: s.color, trend: st.trend });
    }
  }
  // Direct labels at the right edge, de-collided.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 26) labels[i].y = labels[i - 1].y + 26;
  for (const l of labels) {
    const t = el("text", { class: "label", x: W - m.r + 8, y: l.y + 3 }, svg);
    t.textContent = truncate(l.name, 15);
    const t2 = el("text", { class: "axis", x: W - m.r + 8, y: l.y + 15 }, svg);
    t2.textContent = l.trend != null ? `${fmt(l.trend, CFG.digits)} ${CFG.trendShort}` : "";
    el("line", { x1: l.x + 2, x2: W - m.r + 4, y1: l.y, y2: l.y, stroke: l.color, "stroke-width": 1, "stroke-opacity": 0.4 }, svg);
  }

  // Hover crosshair.
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih, visibility: "hidden" }, svg);
  const dots = series.map((s) => el("circle", { r: 3.5, fill: s.color, stroke: "#0f1622", "stroke-width": 1.5, visibility: "hidden" }, svg));
  const tip = makeTip(host);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const yr = Math.round(x0 + ((px - m.l) / iw) * (x1 - x0));
    const i = years.indexOf(Math.max(x0, Math.min(x1, yr)));
    if (i < 0) return;
    cross.setAttribute("x1", X(years[i])); cross.setAttribute("x2", X(years[i]));
    cross.setAttribute("visibility", "visible");
    let rows = "";
    series.forEach((s, k) => {
      const v = s.values[i];
      const dot = dots[k];
      if (v == null) { dot.setAttribute("visibility", "hidden"); }
      else { dot.setAttribute("cx", X(years[i])); dot.setAttribute("cy", Y(v)); dot.setAttribute("visibility", "visible"); }
      const cov = s.coverage?.[i];
      rows += `<div class="t-row"><i style="background:${s.color}"></i><span>${escapeHtml(truncate(s.name, 22))}</span><b>${fmt(v, 2)} ${CFG.unit}</b></div>`;
      if (s.running[i] != null) rows += `<div class="t-row"><i></i><span class="muted">11-J.-Mittel</span><span class="muted">${fmt(s.running[i], 2)}</span></div>`;
      if (cov != null && cov < 0.9) rows += `<div class="t-row"><i></i><span class="muted">Flächenabdeckung</span><span class="muted">${Math.round(cov * 100)} %</span></div>`;
    });
    tip.show(`<div class="t-head">${years[i]}</div>${rows}`, ((X(years[i])) / W) * rect.width, ev.clientY - rect.top);
  });
  hit.addEventListener("mouseleave", () => { tip.hide(); cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
}

/** Warming stripes: one row per region, one bar per year, coloured by anomaly. */
export function stripes(container, { years, series }) {
  const m = { l: 150, r: 10, t: 6, b: 24 };
  const avail = (container.clientHeight || 260) - m.t - m.b - 50;
  const rowH = Math.min(64, Math.max(14, avail / Math.max(1, series.length) - 6));
  container.innerHTML = "";
  const host = document.createElement("div");
  host.style.position = "relative";
  container.appendChild(host);
  const W = Math.max(320, container.clientWidth - 4);
  const H = m.t + m.b + series.length * (rowH + 6);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H }, host);
  const iw = W - m.l - m.r;
  let maxAbs = 0;
  for (const s of series) for (const v of s.values) if (v != null) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = { kind: CFG.scale, min: -niceCeil(maxAbs * 0.85), max: niceCeil(maxAbs * 0.85) };
  const bw = iw / years.length;
  const tip = makeTip(host);
  series.forEach((s, r) => {
    const y = m.t + r * (rowH + 6);
    const label = el("text", { class: "stripe-row-label", x: m.l - 10, y: y + rowH / 2 + 4, "text-anchor": "end" }, svg);
    label.textContent = truncate(s.name, 22);
    el("rect", { x: m.l - 6, y: y + rowH / 2 - 5, width: 3, height: 10, rx: 1.5, fill: s.color }, svg);
    const g = el("g", {}, svg);
    s.values.forEach((v, i) => {
      el("rect", { x: m.l + i * bw, y, width: bw + 0.4, height: rowH, fill: v == null ? "#1a2230" : cssColor(v, scale) }, g);
    });
    const hit = el("rect", { x: m.l, y, width: iw, height: rowH, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(years.length - 1, Math.floor((px - m.l) / bw)));
      tip.show(`<div class="t-head">${escapeHtml(s.name)} · ${years[i]}</div><b>${fmt(s.values[i], 2)} ${CFG.unit}</b>`,
        ev.clientX - rect.left, ev.clientY - rect.top);
    });
    hit.addEventListener("mouseleave", () => tip.hide());
  });
  const axis = el("g", { class: "axis" }, svg);
  for (const t of ticks(years[0], years[years.length - 1], Math.round(iw / 80))) {
    el("text", { x: m.l + (years.indexOf(t) + 0.5) * bw, y: H - 6, "text-anchor": "middle" }, axis).textContent = t;
  }
  return scale;
}

/** Seasonal cycle of the trend: grouped bars per month with 95 % CI whiskers. */
export function seasons(container, { series }) {
  const m = { l: 48, r: 12, t: 8, b: 26 };
  container.innerHTML = "";
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = series.map((s) => `<span style="--c:${s.color}">${escapeHtml(s.name)}</span>`).join("")
    + `<span class="key">Balken = Trend je Monat · Strich = 95-%-Konfidenz · blass = nicht signifikant</span>`;
  container.appendChild(legend);
  const host = document.createElement("div");
  host.style.height = "calc(100% - 26px)";
  host.style.position = "relative";
  container.appendChild(host);
  const { svg, W, H, iw, ih } = frame(host, m);
  let lo = 0, hi = 0;
  for (const s of series) for (const mt of s.monthly) {
    if (mt.trend == null) continue;
    lo = Math.min(lo, mt.trend - (mt.ci || 0)); hi = Math.max(hi, mt.trend + (mt.ci || 0));
  }
  if (hi === lo) hi = lo + 1;
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  for (const t of ticks(lo, hi, 5)) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }, grid);
    el("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end" }, axis).textContent = fmt(t, 2, false);
  }
  el("line", { class: "zero", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }, svg);
  const yt = el("text", { class: "axis-title", x: 12, y: m.t + ih / 2, transform: `rotate(-90 12 ${m.t + ih / 2})`, "text-anchor": "middle" }, svg);
  yt.textContent = `Trend (${CFG.trendUnit})`;
  const gw = iw / 12;
  const n = series.length;
  const bw = Math.max(2, Math.min(22, (gw - 8) / n - 2));
  const tip = makeTip(host);
  const months = series[0]?.monthly.map((x) => x.month) || [];
  months.forEach((name, k) => {
    const gx = m.l + k * gw;
    el("text", { x: gx + gw / 2, y: H - 8, "text-anchor": "middle" }, axis).textContent = name;
    const startX = gx + gw / 2 - (n * (bw + 2) - 2) / 2;
    series.forEach((s, j) => {
      const mt = s.monthly[k];
      if (mt.trend == null) return;
      const x = startX + j * (bw + 2);
      const y0 = Y(0), y1 = Y(mt.trend);
      const sig = mt.p != null && mt.p < 0.05;
      el("rect", { x, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), rx: Math.min(3, bw / 3), fill: s.color, "fill-opacity": sig ? 0.95 : 0.35 }, svg);
      if (mt.ci != null) el("line", { x1: x + bw / 2, x2: x + bw / 2, y1: Y(mt.trend - mt.ci), y2: Y(mt.trend + mt.ci), stroke: "#cdd6e2", "stroke-width": 1, "stroke-opacity": 0.6 }, svg);
    });
    const hit = el("rect", { x: gx, y: m.t, width: gw, height: ih, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const rows = series.map((s) => {
        const mt = s.monthly[k];
        return `<div class="t-row"><i style="background:${s.color}"></i><span>${escapeHtml(truncate(s.name, 20))}</span><b>${fmt(mt.trend, CFG.digits)} ± ${fmt(mt.ci, CFG.digits, false)}</b></div>`
          + `<div class="t-row"><i></i><span class="muted">p</span><span class="muted">${fmtP(mt.p)}</span></div>`;
      }).join("");
      tip.show(`<div class="t-head">${name} · ${CFG.trendUnit}</div>${rows}`, ev.clientX - rect.left, ev.clientY - rect.top);
    });
    hit.addEventListener("mouseleave", () => tip.hide());
  });
}

/** Horizontal bar ranking with CI whiskers; onPick(id) when a row is clicked. */
export function ranking(container, { rows, global, selectedIds, colors, onPick }) {
  const rowH = 20;
  const m = { l: 190, r: 120, t: 18, b: 22 };
  container.innerHTML = "";
  const host = document.createElement("div");
  host.style.position = "relative";
  container.appendChild(host);
  const W = Math.max(420, container.clientWidth - 4);
  const valid = rows.filter((r) => r.trend != null);
  const H = m.t + m.b + valid.length * rowH;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H }, host);
  const iw = W - m.l - m.r;
  let lo = 0, hi = 0;
  for (const r of valid) { lo = Math.min(lo, r.trend - (r.trend_ci || 0)); hi = Math.max(hi, r.trend + (r.trend_ci || 0)); }
  const X = (v) => m.l + ((v - lo) / (hi - lo)) * iw;
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  for (const t of ticks(lo, hi, 6)) {
    el("line", { x1: X(t), x2: X(t), y1: m.t - 4, y2: H - m.b }, grid);
    el("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, axis).textContent = fmt(t, 2, false);
  }
  el("text", { class: "axis-title", x: 4, y: 10 }, svg).textContent = `${CFG.trendTitle} in ${CFG.trendUnit} · Strich = 95-%-Konfidenz · blass = nicht signifikant · ${CFG.scale === "diverging" ? "×n = Vielfaches des globalen Trends" : "% = relativ zum Klimamittel"}`;
  const scale = { kind: CFG.scale, min: -niceCeil(Math.max(Math.abs(lo), Math.abs(hi))), max: niceCeil(Math.max(Math.abs(lo), Math.abs(hi))) };
  const tip = makeTip(host);
  valid.forEach((r, i) => {
    const y = m.t + i * rowH;
    const sel = selectedIds.includes(r.id);
    const g = el("g", { style: "cursor:pointer" }, svg);
    if (sel) el("rect", { x: 0, y, width: W, height: rowH, fill: "rgba(90,169,255,0.08)" }, g);
    const name = el("text", { x: m.l - 10, y: y + rowH / 2 + 4, "text-anchor": "end", fill: sel ? "#e8edf4" : "#a9b6c7", "font-size": 11.5, "font-weight": sel ? 600 : 400 }, g);
    name.textContent = r.name;
    if (sel && colors[r.id]) el("rect", { x: 4, y: y + 6, width: 8, height: 8, rx: 2, fill: colors[r.id] }, g);
    const x0 = X(0), x1 = X(r.trend);
    el("rect", { x: Math.min(x0, x1), y: y + 4, width: Math.max(1, Math.abs(x1 - x0)), height: rowH - 8, rx: 3, fill: cssColor(r.trend, scale), "fill-opacity": r.trend_p != null && r.trend_p < 0.05 ? 1 : 0.45 }, g);
    if (r.trend_ci != null) el("line", { x1: X(r.trend - r.trend_ci), x2: X(r.trend + r.trend_ci), y1: y + rowH / 2, y2: y + rowH / 2, stroke: "#e8edf4", "stroke-width": 1.2, "stroke-opacity": 0.75 }, g);
    const val = el("text", { x: W - m.r + 8, y: y + rowH / 2 + 4, "font-size": 11, fill: "#a9b6c7" }, g);
    val.textContent = `${fmt(r.trend, CFG.digits)}  ${r.vs_global != null ? "×" + r.vs_global.toFixed(1).replace(".", ",") : r.trend_rel != null ? fmt(r.trend_rel, 1) + " %" : ""}`;
    el("rect", { x: 0, y, width: W, height: rowH, fill: "transparent" }, g);
    g.addEventListener("click", () => onPick?.(r.id));
    g.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      tip.show(`<div class="t-head">${escapeHtml(r.name)}</div>`
        + `Trend <b>${fmt(r.trend, 3)} ± ${fmt(r.trend_ci, 3, false)}</b> ${CFG.trendShort}<br>`
        + (r.trend_rel != null ? `relativ <b>${fmt(r.trend_rel, 1)} %</b> pro Dekade<br>` : "")
        + `p = ${fmtP(r.trend_p)} · ${r.vs_global != null ? "×" + r.vs_global.toFixed(2).replace(".", ",") + " global" : ""}<br>`
        + `Änderung im Zeitraum <b>${fmt(r.change, 2)} ${CFG.unit}</b><br>`
        + `Beschleunigung ${fmt(r.acceleration, CFG.digits)} ${CFG.trendShort}<br>`
        + `<span class="muted">${sel ? "Klick: aus Vergleich entfernen" : "Klick: zum Vergleich hinzufügen"}</span>`,
        ev.clientX - rect.left, ev.clientY - rect.top);
    });
    g.addEventListener("mouseleave", () => tip.hide());
  });
  if (global != null) {
    el("line", { x1: X(global), x2: X(global), y1: m.t - 4, y2: H - m.b, stroke: "#e8edf4", "stroke-dasharray": "4 3", "stroke-opacity": 0.6 }, svg);
    el("text", { x: X(global) + 4, y: m.t + 4, class: "axis", fill: "#a9b6c7" }, svg).textContent = "global";
  }
  el("line", { class: "zero", x1: X(0), x2: X(0), y1: m.t - 4, y2: H - m.b }, svg);
}

/** Hovmöller diagram: zonal-mean anomaly, years (x) × latitude (y), on a canvas. */
export function hovmoller(container, { years, lats, values, period, highlight }) {
  container.innerHTML = "";
  const host = document.createElement("div");
  host.className = "chart";
  container.appendChild(host);
  const m = { l: 44, r: 70, t: 8, b: 24 };
  const W = Math.max(320, host.clientWidth), H = Math.max(200, host.clientHeight);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ny = years.length, nl = lats.length;
  const cv = document.createElement("canvas");
  cv.width = ny; cv.height = nl;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(ny, nl);
  const absVals = values.filter((v) => v != null).map(Math.abs).sort((a, b) => a - b);
  const vmax = niceCeil(absVals[Math.floor(absVals.length * 0.98)] || 1);
  const scale = { kind: CFG.scale, min: -vmax, max: vmax };
  for (let i = 0; i < ny; i++) for (let j = 0; j < nl; j++) {
    const v = values[i * nl + j];
    const p = ((nl - 1 - j) * ny + i) * 4;
    if (v == null) { img.data[p + 3] = 0; continue; }
    const [r, g, b] = colorFor(v, scale);
    img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" }, host);
  const fo = el("image", { x: m.l, y: m.t, width: iw, height: ih, preserveAspectRatio: "none", href: cv.toDataURL() }, svg);
  fo.style.imageRendering = "pixelated";
  const X = (yr) => m.l + ((yr - years[0] + 0.5) / ny) * iw;
  const Y = (lat) => m.t + ((90 - lat) / 180) * ih;
  const axis = el("g", { class: "axis" }, svg);
  for (const t of [-60, -30, 0, 30, 60]) {
    el("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end" }, axis).textContent = t === 0 ? "Äq." : `${Math.abs(t)}°${t > 0 ? "N" : "S"}`;
    el("line", { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), stroke: "rgba(255,255,255,0.12)" }, svg);
  }
  for (const t of ticks(years[0], years[ny - 1], Math.round(iw / 90))) {
    el("text", { x: X(t), y: H - 7, "text-anchor": "middle" }, axis).textContent = t;
  }
  if (period) {
    for (const yr of period) el("line", { x1: X(yr), x2: X(yr), y1: m.t, y2: m.t + ih, stroke: "#e8edf4", "stroke-dasharray": "3 3", "stroke-opacity": 0.5 }, svg);
  }
  for (const h of highlight || []) {
    const [s, n] = h.lat;
    el("rect", { x: m.l + iw + 4, y: Y(n), width: 5, height: Math.max(2, Y(s) - Y(n)), rx: 2, fill: h.color }, svg);
  }
  // Colour bar on the right.
  const cbX = m.l + iw + 22;
  const steps = 60;
  for (let k = 0; k < steps; k++) {
    const v = scale.max - (k / steps) * (scale.max - scale.min);
    el("rect", { x: cbX, y: m.t + (k / steps) * ih, width: 10, height: ih / steps + 0.5, fill: cssColor(v, scale) }, svg);
  }
  for (const t of ticks(scale.min, scale.max, 6)) {
    el("text", { x: cbX + 14, y: m.t + ((scale.max - t) / (scale.max - scale.min)) * ih + 3.5 }, axis).textContent = fmt(t, vmax < 2 ? 1 : 0);
  }
  const tip = makeTip(host);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const py = ((ev.clientY - rect.top) / rect.height) * H;
    const i = Math.max(0, Math.min(ny - 1, Math.floor(((px - m.l) / iw) * ny)));
    const lat = 90 - ((py - m.t) / ih) * 180;
    const j = Math.max(0, Math.min(nl - 1, Math.round((lat - lats[0]) / (lats[1] - lats[0]))));
    const v = values[i * nl + j];
    tip.show(`<div class="t-head">${years[i]} · ${Math.abs(lats[j])}°${lats[j] >= 0 ? "N" : "S"}</div>Zonalmittel <b>${fmt(v, 2)} ${CFG.unit}</b>`,
      ev.clientX - rect.left, ev.clientY - rect.top);
  });
  hit.addEventListener("mouseleave", () => tip.hide());
}

/** Tiny sparkline (for popups). */
export function sparkline(years, values, running, { width = 220, height = 54, color = "#e0654c" } = {}) {
  const vals = values.filter((v) => v != null);
  if (!vals.length) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const X = (i) => (i / (years.length - 1)) * width;
  const Y = (v) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (height - 6);
  const line = (arr) => {
    let d = "", pen = false;
    arr.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const zero = lo < 0 && hi > 0 ? `<line x1="0" x2="${width}" y1="${Y(0)}" y2="${Y(0)}" stroke="#56677e" stroke-width="1"/>` : "";
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${zero}`
    + `<path d="${line(values)}" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>`
    + `<path d="${line(running)}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export { SCALES };

/** Rolling-window trend per region ("Erwärmungstempo"). */
export function rollingTrend(container, { years, series, window, global }) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "series-wrap";
  container.appendChild(wrap);
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = series.map((s) => `<span style="--c:${s.color}">${escapeHtml(s.name)}</span>`).join("")
    + `<span class="key">Trend der jeweils letzten ${window} Jahre, aufgetragen am Endjahr${series.length <= 2 ? " · Fläche = 95-%-Konfidenz" : ""}</span>`;
  wrap.appendChild(legend);
  const host = document.createElement("div");
  host.style.cssText = "flex:1;min-height:0;position:relative";
  wrap.appendChild(host);
  const direct = series.length <= 4 && host.clientWidth >= 560;
  const m = { l: 48, r: direct ? 118 : 12, t: 8, b: 26 };
  const { svg, W, H, iw, ih } = frame(host, m);
  let lo = 0, hi = 0, first = Infinity;
  const band = series.length <= 2;
  for (const s of series) s.rolling.forEach((v, i) => {
    if (v == null) return;
    first = Math.min(first, i);
    const c = band ? s.rollingCi[i] || 0 : 0;
    lo = Math.min(lo, v - c); hi = Math.max(hi, v + c);
  });
  if (!Number.isFinite(first)) { host.innerHTML = `<div class="empty">Zu kurze Zeitreihe für ${window}-Jahres-Trends.</div>`; return; }
  const x0 = years[first], x1 = years[years.length - 1];
  const X = (yr) => m.l + ((yr - x0) / (x1 - x0)) * iw;
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  for (const t of ticks(lo, hi, 6)) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }, grid);
    el("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end" }, axis).textContent = fmt(t, 2, false);
  }
  for (const t of ticks(x0, x1, Math.max(4, Math.round(iw / 90)))) el("text", { x: X(t), y: H - 8, "text-anchor": "middle" }, axis).textContent = t;
  el("line", { class: "zero", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }, svg);
  const yt = el("text", { class: "axis-title", x: 12, y: m.t + ih / 2, transform: `rotate(-90 12 ${m.t + ih / 2})`, "text-anchor": "middle" }, svg);
  yt.textContent = `${window}-Jahres-Trend (${CFG.trendUnit})`;
  const pathOf = (vals) => {
    let d = "", pen = false;
    vals.forEach((v, i) => { if (v == null || i < first) { pen = false; return; } d += `${pen ? "L" : "M"}${X(years[i]).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const labels = [];
  for (const s of series) {
    if (band) {
      let up = "", down = [];
      s.rolling.forEach((v, i) => {
        const c = s.rollingCi[i];
        if (v == null || c == null || i < first) return;
        up += `${up ? "L" : "M"}${X(years[i]).toFixed(1)},${Y(v + c).toFixed(1)}`;
        down.unshift(`L${X(years[i]).toFixed(1)},${Y(v - c).toFixed(1)}`);
      });
      if (up) el("path", { d: up + down.join("") + "Z", fill: s.color, "fill-opacity": 0.13, stroke: "none" }, svg);
    }
    el("path", { d: pathOf(s.rolling), fill: "none", stroke: s.color, "stroke-width": 2.25, "stroke-linejoin": "round" }, svg);
    let li = -1;
    s.rolling.forEach((v, i) => { if (v != null) li = i; });
    if (li >= 0 && direct) labels.push({ y: Y(s.rolling[li]), name: s.name, v: s.rolling[li], color: s.color });
  }
  if (global != null) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(global), y2: Y(global), stroke: "#a9b6c7", "stroke-dasharray": "2 4", "stroke-opacity": 0.5 }, svg);
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 26) labels[i].y = labels[i - 1].y + 26;
  for (const l of labels) {
    el("text", { class: "label", x: W - m.r + 8, y: l.y + 3 }, svg).textContent = truncate(l.name, 15);
    el("text", { class: "axis", x: W - m.r + 8, y: l.y + 15 }, svg).textContent = `${fmt(l.v, CFG.digits)} ${CFG.trendShort}`;
  }
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih, visibility: "hidden" }, svg);
  const tip = makeTip(host);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const yr = Math.round(x0 + ((px - m.l) / iw) * (x1 - x0));
    const i = years.indexOf(Math.max(x0, Math.min(x1, yr)));
    if (i < 0) return;
    cross.setAttribute("x1", X(years[i])); cross.setAttribute("x2", X(years[i])); cross.setAttribute("visibility", "visible");
    const rows = series.map((s) => `<div class="t-row"><i style="background:${s.color}"></i><span>${escapeHtml(truncate(s.name, 22))}</span><b>${fmt(s.rolling[i], 2)} ± ${fmt(s.rollingCi[i], 2, false)}</b></div>`).join("");
    tip.show(`<div class="t-head">${years[i] - window + 1}–${years[i]} · ${CFG.trendUnit}</div>${rows}`, (X(years[i]) / W) * rect.width, ev.clientY - rect.top);
  });
  hit.addEventListener("mouseleave", () => { tip.hide(); cross.setAttribute("visibility", "hidden"); });
}

const PERIOD_COLORS = ["#8fb8d8", "#f4a582", "#d6604d", "#a50f15"];

/** Shift of the standardised anomaly distribution, one curve per period. */
export function distributionChart(container, data) {
  const { bins, periods } = data;
  const m = { l: 44, r: 16, t: 10, b: 30 };
  const { svg, W, H, iw, ih } = frame(container, m);
  const centers = bins.slice(0, -1).map((b, i) => (b + bins[i + 1]) / 2);
  let hi = 0, zMin = -4, zMax = 4;
  for (const p of periods) p.density.forEach((d, i) => {
    hi = Math.max(hi, d || 0);
    if (d > 0.002) { zMin = Math.min(zMin, centers[i] - 0.5); zMax = Math.max(zMax, centers[i] + 0.5); }
  });
  hi *= 1.08;
  zMin = Math.max(bins[0], Math.floor(zMin));
  zMax = Math.min(bins[bins.length - 1], Math.ceil(zMax));
  const X = (z) => m.l + ((Math.max(zMin, Math.min(zMax, z)) - zMin) / (zMax - zMin)) * iw;
  const Y = (v) => m.t + (1 - v / hi) * ih;
  const axis = el("g", { class: "axis" }, svg);
  for (const [a, b, label] of [[2, 3, "selten (> 2σ)"], [3, zMax, "extrem (> 3σ)"]]) {
    el("rect", { x: X(a), y: m.t, width: X(b) - X(a), height: ih, fill: a === 3 ? "rgba(178,24,43,0.12)" : "rgba(214,96,77,0.07)" }, svg);
    el("text", { class: "axis", x: X(a) + 4, y: m.t + (a === 3 ? 26 : 12) }, svg).textContent = label;
  }
  const step = zMax - zMin > 12 ? 2 : 1;
  for (let z = Math.ceil(zMin / step) * step; z <= zMax; z += step) {
    el("line", { x1: X(z), x2: X(z), y1: m.t, y2: m.t + ih, stroke: z === 0 ? "#56677e" : "rgba(255,255,255,0.06)" }, svg);
    el("text", { x: X(z), y: H - 12, "text-anchor": "middle" }, axis).textContent = z === 0 ? "0" : `${z > 0 ? "+" : "−"}${Math.abs(z)}σ`;
  }
  el("text", { class: "axis-title", x: m.l + iw / 2, y: H, "text-anchor": "middle" }, svg).textContent = "Anomalie in Vielfachen der Jahr-zu-Jahr-Schwankung (σ) der Referenzperiode";
  periods.forEach((p, k) => {
    const color = PERIOD_COLORS[Math.min(k, PERIOD_COLORS.length - 1)];
    let d = "";
    let first = true;
    p.density.forEach((v, i) => {
      if (centers[i] < zMin || centers[i] > zMax) return;
      d += `${first ? "M" : "L"}${X(centers[i]).toFixed(1)},${Y(v || 0).toFixed(1)}`;
      first = false;
    });
    el("path", { d: d + `L${X(zMax)},${Y(0)}L${X(zMin)},${Y(0)}Z`, fill: color, "fill-opacity": 0.1, stroke: "none" }, svg);
    el("path", { d, fill: "none", stroke: color, "stroke-width": k === 0 ? 1.5 : 2.25, "stroke-dasharray": k === 0 ? "5 3" : "none" }, svg);
  });
  el("line", { x1: m.l, x2: m.l + iw, y1: Y(0), y2: Y(0), stroke: "#56677e" }, svg);
  return PERIOD_COLORS;
}
