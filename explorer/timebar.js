// Time bar: the track shows the history of the visible map area as climate stripes
// with a line on top; one handle marks the shown year (Zeitreise) or two handles
// mark the analysed period (trend views).
import { colorFor } from "./colormap.js";

export class TimeBar {
  constructor(host, { onValue, onRange }) {
    this.host = host;
    this.onValue = onValue;
    this.onRange = onRange;
    this.canvas = document.createElement("canvas");
    host.appendChild(this.canvas);
    this.mode = "point";
    this.years = [];
    this.values = [];
    this.scale = { kind: "diverging", min: -1, max: 1 };
    this.domain = [1880, 2025];
    this.value = 2025; // fractional year in point mode
    this.step = 1; // 1 = years, 1/12 = months
    this.range = [1979, 2025];
    this.trend = null; // {slope, intercept} drawn across the range
    this.drag = null;
    host.addEventListener("pointerdown", (e) => this.down(e));
    host.addEventListener("keydown", (e) => this.key(e));
    new ResizeObserver(() => this.draw()).observe(host);
  }

  set(props) {
    Object.assign(this, props);
    this.draw();
  }

  // --- geometry ---
  get pad() { return { l: 10, r: 10, top: 10, bottom: 15 }; }
  x(t) {
    const { l, r } = this.pad;
    const w = this.host.clientWidth - l - r;
    const [a, b] = this.domain;
    return l + ((t - a) / Math.max(1e-9, b + 1 - a)) * w;
  }
  t(px) {
    const { l, r } = this.pad;
    const w = this.host.clientWidth - l - r;
    const [a, b] = this.domain;
    return a + ((px - l) / w) * (b + 1 - a);
  }
  snap(t) {
    const [a, b] = this.domain;
    if (this.step >= 1) return Math.max(a, Math.min(this.maxValue ?? b, Math.floor(t)));
    const months = Math.floor((t - a) * 12);
    const v = a + months / 12;
    return Math.max(a, Math.min(this.maxValue ?? b + 11 / 12, v));
  }

  // --- interaction ---
  down(e) {
    if (e.button !== 0) return;
    this.host.focus();
    const rect = this.host.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (this.mode === "range") {
      const d0 = Math.abs(px - this.x(this.range[0] + 0.5));
      const d1 = Math.abs(px - this.x(this.range[1] + 0.5));
      this.drag = d0 < d1 ? 0 : 1;
    } else {
      this.drag = "v";
    }
    this.move(e);
    const move = (ev) => this.move(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this.mode === "range") this.onRange?.(this.range[0], this.range[1]);
      this.drag = null;
      this.draw();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  }

  move(e) {
    if (this.drag == null) return;
    const rect = this.host.getBoundingClientRect();
    const t = this.t(e.clientX - rect.left);
    if (this.drag === "v") {
      const v = this.snap(t);
      if (v !== this.value) { this.value = v; this.onValue?.(v); this.draw(); }
      return;
    }
    const y = Math.max(this.domain[0], Math.min(this.maxYear ?? this.domain[1], Math.floor(t)));
    const r = [...this.range];
    r[this.drag] = y;
    if (r[1] - r[0] < 9) return; // at least 10 years
    this.range = r;
    this.draw();
  }

  key(e) {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.mode === "point") {
      const v = this.snap(this.value + dir * this.step + (this.step < 1 ? 1e-6 : 0));
      if (v !== this.value) { this.value = v; this.onValue?.(v); this.draw(); }
    } else {
      const r = [this.range[0] + (e.shiftKey ? dir : 0), this.range[1] + (e.shiftKey ? 0 : dir)];
      if (r[0] < this.domain[0] || r[1] > (this.maxYear ?? this.domain[1]) || r[1] - r[0] < 9) return;
      this.range = r;
      this.draw();
      this.onRange?.(r[0], r[1]);
    }
  }

  // --- drawing ---
  draw() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { top, bottom } = this.pad;
    const y0 = top, y1 = H - bottom;
    const [a, b] = this.domain;

    // stripes
    for (let i = 0; i < this.years.length; i++) {
      const yr = this.years[i];
      const v = this.values[i];
      if (yr < a || yr > b) continue;
      const xa = this.x(yr), xb = this.x(yr + 1);
      if (v == null || !Number.isFinite(v)) { ctx.fillStyle = "rgba(255,255,255,0.04)"; }
      else { const [r, g, bb] = colorFor(v, this.scale); ctx.fillStyle = `rgb(${r},${g},${bb})`; }
      ctx.fillRect(xa, y0, Math.max(1, xb - xa + 0.4), y1 - y0);
    }
    // dim outside the analysed period
    if (this.mode === "range") {
      ctx.fillStyle = "rgba(6,10,16,0.66)";
      ctx.fillRect(this.x(a), y0, this.x(this.range[0]) - this.x(a), y1 - y0);
      ctx.fillRect(this.x(this.range[1] + 1), y0, this.x(b + 1) - this.x(this.range[1] + 1), y1 - y0);
    }
    // line of the values
    const finite = this.values.filter((v) => v != null && Number.isFinite(v));
    if (finite.length > 1) {
      const lo = Math.min(...finite, 0), hi = Math.max(...finite, 0);
      const span = hi - lo || 1;
      const yv = (v) => y1 - 3 - ((v - lo) / span) * (y1 - y0 - 6);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.x(a), yv(0));
      ctx.lineTo(this.x(b + 1), yv(0));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(8,12,18,0.85)";
      ctx.lineWidth = 3;
      this.#path(ctx, yv);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 1.4;
      this.#path(ctx, yv);
      if (this.mode === "range" && this.trend) {
        const [s, e] = this.range;
        const f = (yr) => this.trend.intercept + this.trend.slope * yr;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(this.x(s + 0.5), yv(f(s)));
        ctx.lineTo(this.x(e + 0.5), yv(f(e)));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // decade ticks
    ctx.fillStyle = "rgba(169,182,199,0.85)";
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const span = b - a;
    const pxPerYear = (this.x(b + 1) - this.x(a)) / Math.max(1, span + 1);
    const every = [5, 10, 20, 25, 50, 100].find((e) => e * pxPerYear >= 42) || 100;
    for (let yr = Math.ceil(a / every) * every; yr <= b; yr += every) {
      const px = this.x(yr);
      ctx.fillRect(px, y1, 1, 3);
      ctx.fillText(String(yr), px, y1 + 3);
    }
    // handles
    if (this.mode === "point") {
      this.#handle(ctx, this.x(this.value + this.step / 2), y0, y1);
    } else {
      for (const yr of this.range) this.#handle(ctx, this.x(yr + 0.5), y0, y1, true);
    }
    this.host.setAttribute("aria-valuetext", this.mode === "point" ? String(Math.floor(this.value)) : `${this.range[0]}–${this.range[1]}`);
  }

  #path(ctx, yv) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < this.years.length; i++) {
      const v = this.values[i];
      if (v == null || !Number.isFinite(v)) { pen = false; continue; }
      const px = this.x(this.years[i] + 0.5), py = yv(v);
      if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }

  #handle(ctx, px, y0, y1, bracket = false) {
    ctx.fillStyle = "#05080d";
    ctx.fillRect(px - 2.5, y0 - 4, 5, y1 - y0 + 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(px - 1, y0 - 3, 2, y1 - y0 + 6);
    ctx.beginPath();
    ctx.arc(px, y0 - 2, bracket ? 4.5 : 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#05080d";
    ctx.stroke();
  }
}
