/*
 * Simple mode: an automatic dashboard of widgets (static/mode.js switches modes).
 *
 * In Scientific mode the user picks time frames and methods. Here the software
 * does that itself: for every variable it runs all analyses, keeps only the
 * widgets that have something to say and puts the strongest result first.
 *
 *   - Key findings: the most prominent results of all variables, ranked
 *   - per variable, one widget each, ordered by the strength of their signal:
 *       Trend         one value per year with trend line and certainty
 *       Whole record  every value with a running one-year mean and notable events
 *       Seasons       the trend of every season; the one changing most is marked
 *       Typical year  each month in the first years vs. the last years
 *       Sudden shift  a step change of the level (only when it is clear)
 *       Decades       the mean of every decade
 *       Extremes      highest / lowest values and the most notable events
 *   - How the variables relate (two or more variables): the strongest links
 *
 * Every widget is a tile: the front shows one large number with a short line
 * beneath; a click flips the tile over and widens it to the full row, and the
 * back shows the chart and a "How this was worked out" fold-out with the
 * numbers, so details do not need Scientific mode. Charts are drawn only on an
 * open tile, at its full width. No sentences repeat what a chart shows;
 * explanations sit in title attributes.
 *
 * Statistics come from the server, the same as in the scientific view:
 * POST /api/evolution (OLS + Mann-Kendall trend, decades), POST /api/analyze
 * (Pettitt change point) and POST /api/correlate. index.html calls
 * setData / setLoading next to the plot panel's. #simple-panel stays empty
 * while nothing is analysed, so mode.css hides its card.
 */
(function () {
    'use strict';

    const INTERVAL_DAYS = { Day: 1, Month: 30.436875, Year: 365.2425 };
    const DAY_MS = 86400000;
    const MIN_YEARS = 3;
    const TREND_YEARS = 8;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    const SEASONS = [
        { id: 'djf', months: [12, 1, 2], north: 'Winter', south: 'Summer', span: 'Dec–Feb' },
        { id: 'mam', months: [3, 4, 5], north: 'Spring', south: 'Autumn', span: 'Mar–May' },
        { id: 'jja', months: [6, 7, 8], north: 'Summer', south: 'Winter', span: 'Jun–Aug' },
        { id: 'son', months: [9, 10, 11], north: 'Autumn', south: 'Spring', span: 'Sep–Nov' },
    ];

    const PALETTE = {
        warm: { up: '#cb181d', down: '#2171b5', upW: 'warmer', downW: 'colder', hiW: 'warmest', loW: 'coldest' },
        wet: { up: '#35978f', down: '#bf812d', upW: 'wetter', downW: 'drier', hiW: 'wettest', loW: 'driest' },
        neutral: { up: '#6250d6', down: '#8f6a00', upW: 'higher', downW: 'lower', hiW: 'highest', loW: 'lowest' },
    };
    const LINE = '#2a78d6';
    const LIGHT = 'rgba(42, 120, 214, 0.28)';
    const EARLY = '#9aa5b1';
    const ACCENT = '#eb6834';
    const REF = '#52514e';

    // Tile animation: the first half turn in place, then the second half while growing.
    const TURN_MS = 170;
    const GROW_MS = 400;
    const EASE = 'cubic-bezier(0.2, 0.75, 0.25, 1)';

    // open: tile group (variable) -> id of its open tile; kept across renders.
    const state = { host: null, viz: null, request: null, loading: false, raf: 0, html: '', open: new Map() };
    const cache = new Map(); // request key -> { pending } | { data } | { error }
    const prepared = new WeakMap(); // info -> { stepDays, s }
    let observer = null;

    // ----------------------------------------------------------------- helpers

    function K() {
        return (window.TrendPlots && window.TrendPlots.kit) || null;
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function num(v) {
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    function mean(vs) {
        return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    }

    function sd(vs) {
        if (vs.length < 2) return null;
        const m = mean(vs);
        return Math.sqrt(vs.reduce((a, v) => a + (v - m) ** 2, 0) / (vs.length - 1));
    }

    function label(key) {
        const k = K();
        return k && k.topicLabel ? k.topicLabel(key) : key;
    }

    function cap(w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
    }

    function slug(s) {
        return String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    }

    // One decimal from 1 up (records read as on the station sheet: 112.8 mm), more below.
    function round(v) {
        const a = Math.abs(v);
        const dg = a >= 1000 ? 0 : a >= 1 ? 1 : a >= 0.1 ? 2 : 3;
        return Number(v.toFixed(dg));
    }

    // Number and unit apart, so a tile can set the unit smaller.
    function split(v, unit, signed) {
        const r = round(v);
        const s = Math.abs(r).toLocaleString('en-US', { maximumFractionDigits: 3 });
        const sign = r < 0 ? '−' : signed && r > 0 ? '+' : '';
        return { value: `${sign}${s}`, unit: unit || '' };
    }

    function show(v, unit, signed) {
        const p = split(v, unit, signed);
        return `${p.value}${p.unit ? (p.unit.startsWith('%') ? p.unit : ` ${p.unit}`) : ''}`;
    }

    // Chance as a percentage, two significant digits without exponent notation (1 → "100 %").
    function pct(p) {
        const v = p * 100;
        if (v >= 10) return `${Math.round(v)} %`;
        if (v < 0.1) return '< 0.1 %';
        return `${Number(v.toPrecision(2))} %`;
    }

    function parseDate(text) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(text || ''));
        return m ? { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) } : null;
    }

    function dateText(dt, stepDays) {
        if (!dt) return '';
        if (stepDays >= 300) return String(dt.y);
        if (stepDays >= 20) return `${MONTHS[dt.m - 1]} ${dt.y}`;
        return `${dt.d} ${MONTHS[dt.m - 1]} ${dt.y}`;
    }

    function timeText(t, stepDays) {
        const d = new Date(t);
        return dateText({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }, stepDays);
    }

    function isoText(iso, stepDays) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? dateText({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, stepDays) : '';
    }

    function pWords(p) {
        if (p === null) return '';
        if (p < 0.01) return 'very unlikely to be chance';
        if (p < 0.05) return 'unlikely to be chance';
        return 'could be chance';
    }

    function kindOf(key, unit) {
        const k = `${key} ${label(key)}`;
        if (unit === 'mm/day' || unit === '% of days' || /precip|rain|snow|wet day/i.test(k)) return 'wet';
        if (/°|\bK\b/.test(unit || '') || /temp/i.test(k)) return 'warm';
        return 'neutral';
    }

    function stepDaysOf(request) {
        const iv = request && Array.isArray(request.interval_length) ? request.interval_length : [1, 'Day'];
        return (Number(iv[0]) || 1) * (INTERVAL_DAYS[iv[1]] || 1);
    }

    function siteOf(info) {
        const st = info.station;
        if (st && (st.name || st.id)) return st.name || st.id;
        if (info.region && info.region.name) return `${info.region.name} (area average)`;
        if (Array.isArray(info.coordinates)) return `${Number(info.coordinates[0]).toFixed(2)}°, ${Number(info.coordinates[1]).toFixed(2)}°`;
        return '';
    }

    // Latitude of the series, if known (season names flip south of the equator).
    function latitudeOf(info) {
        const st = info.station || {};
        const lat = num(Number(st.latitude ?? st.lat));
        if (lat !== null) return lat;
        if (info.region && Array.isArray(info.region.bbox)) return (info.region.bbox[1] + info.region.bbox[3]) / 2;
        const area = window.getSelectedArea && window.getSelectedArea();
        const c = area && area.geometry && area.geometry.type === 'Point' ? area.geometry.coordinates : null;
        return Array.isArray(c) ? Number(c[1]) : null;
    }

    function seasonName(season, lat) {
        return `${lat !== null && lat < 0 ? season.south : season.north} (${season.span})`;
    }

    // ------------------------------------------------------------ preparation

    function dayOfYear(month, day) {
        if (month === 2 && day === 29) return MONTH_START[1] + 27;
        return MONTH_START[month - 1] + Math.min(day, MONTH_DAYS[month - 1]) - 1;
    }

    // The interval's midpoint decides its year and time of year (as in plots.js).
    function midpoint(dt, stepDays) {
        if (stepDays <= 1) return dt;
        const d = new Date(Date.UTC(dt.y, dt.m - 1, dt.d) + (stepDays * DAY_MS) / 2);
        return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }

    // One value per (season) year, like the scientific view's annual mean: the mean normal
    // of the selected values plus their mean departure from the normal of each calendar
    // day (or month), so missing days do not bias a year. A year needs half of its values.
    function aggregate(pts, normals, select, yearOf, expected, scale) {
        const chosen = pts.filter(select);
        if (!chosen.length) return [];
        const groups = new Map();
        for (const p of chosen) {
            const y = yearOf(p);
            if (!groups.has(y)) groups.set(y, []);
            groups.get(y).push(p);
        }
        const periodNormal = normals ? mean(chosen.map((p) => normals.get(p.bucket))) : null;
        const need = Math.max(1, Math.floor(expected * 0.5));
        return [...groups.keys()].sort((a, b) => a - b)
            .filter((y) => groups.get(y).length >= need)
            .map((y) => {
                const ps = groups.get(y);
                const value = normals
                    ? periodNormal + mean(ps.map((p) => p.v - normals.get(p.bucket)))
                    : mean(ps.map((p) => p.v));
                return { year: y, value: value * scale };
            });
    }

    function prepare(key, info, stepDays) {
        const hit = prepared.get(info);
        if (hit && hit.stepDays === stepDays) return hit.s;
        const labels = Array.isArray(info.labels) ? info.labels : [];
        const values = Array.isArray(info.values) ? info.values : [];
        const unit = info.unit || '';
        const monthly = stepDays >= 20;
        const pts = [];
        let hi = null;
        let lo = null;
        labels.forEach((l, i) => {
            const v = values[i];
            const dt = parseDate(l);
            if (num(v) === null || !dt) return;
            const mid = midpoint(dt, stepDays);
            pts.push({ v, y: mid.y, m: mid.m, dt, t: Date.UTC(dt.y, dt.m - 1, dt.d) + (stepDays * DAY_MS) / 2, bucket: monthly ? mid.m - 1 : dayOfYear(mid.m, mid.d) });
            if (!hi || v > hi.v) hi = { v, dt };
            if (!lo || v < lo.v) lo = { v, dt };
        });
        const totals = unit === 'mm/day' && stepDays <= 1;
        let normals = null;
        if (stepDays <= 62 && new Set(pts.map((p) => p.y)).size >= 2) {
            const acc = new Map();
            for (const p of pts) {
                const a = acc.get(p.bucket) || [0, 0];
                a[0] += p.v; a[1] += 1;
                acc.set(p.bucket, a);
            }
            normals = new Map([...acc].map(([b, [sum, n]]) => [b, sum / n]));
        }
        const years = stepDays >= 300
            ? pts.map((p) => ({ year: p.y, value: p.v * (totals ? 365.2425 : 1) }))
            : aggregate(pts, normals, () => true, (p) => p.y, 365 / stepDays, totals ? 365.2425 : 1);

        // Seasons and months need at least monthly values.
        const seasons = [];
        if (stepDays <= 31) {
            for (const season of SEASONS) {
                const days = season.months.reduce((a, m) => a + MONTH_DAYS[m - 1], 0);
                seasons.push({
                    season,
                    years: aggregate(
                        pts, normals,
                        (p) => season.months.includes(p.m),
                        (p) => (season.id === 'djf' && p.m === 12 ? p.y + 1 : p.y),
                        days / stepDays, totals ? days : 1,
                    ),
                });
            }
        }

        const s = {
            key, info, unit, totals, stepDays, pts, years, seasons, hi, lo,
            n: pts.length,
            mean: mean(pts.map((p) => p.v)),
            yearUnit: totals ? 'mm' : unit,
            kind: kindOf(key, unit),
            lat: latitudeOf(info),
            typical: stepDays <= 31 ? typicalYear(pts, years, totals) : null,
        };
        prepared.set(info, { stepDays, s });
        return s;
    }

    // Each month in the first years vs. the last years of the range.
    function typicalYear(pts, years, totals) {
        const ys = years.map((r) => r.year);
        if (ys.length < 6) return null;
        const k = Math.max(3, Math.min(10, Math.floor(ys.length / 3)));
        const early = ys.slice(0, k);
        const late = ys.slice(-k);
        const monthMeans = (list) => {
            const set = new Set(list);
            return MONTH_NAMES.map((_, i) => {
                const m = mean(pts.filter((p) => p.m === i + 1 && set.has(p.y)).map((p) => p.v));
                return m === null ? null : m * (totals ? MONTH_DAYS[i] : 1);
            });
        };
        const a = monthMeans(early);
        const b = monthMeans(late);
        if (a.filter((v) => v !== null).length < 6) return null;
        const span = (l) => (l.length > 1 ? `${l[0]}–${l[l.length - 1]}` : String(l[0]));
        return { early: a, late: b, earlyLabel: span(early), lateLabel: span(late), k };
    }

    // ---------------------------------------------------------------- requests

    function fetchOnce(url, body) {
        const text = JSON.stringify(body);
        const key = `${url} ${text}`;
        let entry = cache.get(key);
        if (!entry) {
            entry = { pending: true };
            cache.set(key, entry);
            fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                    cache.set(key, { data });
                })
                .catch((err) => cache.set(key, { error: String((err && err.message) || err) }))
                .finally(scheduleRender);
        }
        return entry;
    }

    function evolutionOf(years) {
        if (years.length < MIN_YEARS) return null;
        return fetchOnce('/api/evolution', { years: years.map((r) => r.year), values: years.map((r) => r.value) });
    }

    function changePointOf(years) {
        if (years.length < TREND_YEARS) return null;
        return fetchOnce('/api/analyze', { x: years.map((r) => r.year), values: years.map((r) => r.value), tools: ['Change Point'] });
    }

    // Monthly departures from each month's normal (yearly values for yearly data) on one grid.
    function correlationOf(list) {
        const usable = list.filter((s) => s.pts.length >= 5).slice(0, 8);
        if (usable.length < 2) return null;
        const yearly = usable[0].stepDays >= 300;
        const series = usable.map((s) => {
            if (yearly) return { name: s.key, x: s.years.map((r) => r.year), values: s.years.map((r) => r.value) };
            const byMonth = new Map();
            for (const p of s.pts) {
                const idx = p.y * 12 + p.m - 1;
                if (!byMonth.has(idx)) byMonth.set(idx, []);
                byMonth.get(idx).push(p.v);
            }
            const monthMean = new Map([...byMonth].map(([i, vs]) => [i, mean(vs)]));
            const normal = MONTHS.map((_, m) => mean([...monthMean].filter(([i]) => i % 12 === m).map(([, v]) => v)));
            const xs = [...monthMean.keys()].sort((a, b) => a - b);
            return { name: s.key, x: xs, values: xs.map((i) => monthMean.get(i) - normal[i % 12]) };
        });
        return { entry: fetchOnce('/api/correlate', { series, max_lag: 0 }), yearly };
    }

    // ---------------------------------------------------------------- analyses

    const CLEAR = ['Clear', 'is-clear'];
    const LIKELY = ['Likely', 'is-likely'];

    // All analyses of one variable: widgets (each with a score: how strong its signal
    // is) and findings for the key-findings list.
    function analyse(s) {
        const pal = PALETTE[s.kind];
        const out = { widgets: [], findings: [], pending: false };
        const name = label(s.key);
        const yearSd = sd(s.years.map((r) => r.value));
        const track = (e) => { if (e && e.pending) out.pending = true; return e; };

        // Trend of the yearly values.
        const evo = track(evolutionOf(s.years));
        const evoData = evo && evo.data ? evo.data : null;
        const t = evoData && evoData.trend && evoData.trend.available !== false ? evoData.trend : null;
        let annualDec = null;
        let annualSig = false;
        if (t) {
            annualDec = num(t.slope_per_decade);
            const p = num(t.p_value) ?? 1;
            annualSig = p < 0.05 && s.years.length >= TREND_YEARS;
            const span = s.years[s.years.length - 1].year - s.years[0].year;
            const size = yearSd ? Math.abs((num(t.slope) || 0) * span) / yearSd : 0;
            // A trend that could be chance is worth mentioning, but below every real result.
            const score = !annualSig ? 0.5 : (p < 0.01 ? 3 : 2) + Math.min(2, size);
            const flat = annualDec === null || round(annualDec) === 0;
            out.findings.push({
                score,
                text: annualSig && !flat
                    ? `${name}: ${annualDec > 0 ? pal.upW : pal.downW} by ${show(annualDec, s.yearUnit, true)} every 10 years`
                    : `${name}: no clear trend over ${s.years.length} years`,
                badge: annualSig ? (p < 0.01 ? CLEAR : LIKELY) : ['Weak', 'is-weak'],
                target: 'trend',
            });
        }
        out.widgets.push({ id: 'trend', fixed: 0, score: 99, html: (ctx, w) => trendWidget(s, evo, pal, ctx, w) });
        out.widgets.push({ id: 'record', fixed: 1, score: 98, html: (ctx, w) => recordWidget(s, ctx, w) });

        // Seasons: which part of the year changes most.
        if (s.seasons.length && s.years.length >= TREND_YEARS) {
            const rows = s.seasons.map((x) => {
                const e = track(evolutionOf(x.years));
                const tr = e && e.data && e.data.trend && e.data.trend.available !== false ? e.data.trend : null;
                return { ...x, trend: tr, dec: tr ? num(tr.slope_per_decade) : null, p: tr ? num(tr.p_value) : null };
            });
            const top = rows
                .filter((r) => r.dec !== null && r.p !== null && r.p < 0.05 && r.years.length >= TREND_YEARS)
                .sort((a, b) => Math.abs(b.dec) - Math.abs(a.dec))[0] || null;
            let score = 0.6;
            if (top) {
                const stronger = !annualSig || annualDec === null || Math.abs(top.dec) > 1.5 * Math.abs(annualDec);
                score = stronger ? 1.6 + (top.p < 0.01 ? 0.6 : 0) : 1.0;
                if (stronger) {
                    out.findings.push({
                        score,
                        text: `${name}: strongest change in ${seasonName(top.season, s.lat)}, ${show(top.dec, s.yearUnit, true)} every 10 years`,
                        badge: top.p < 0.01 ? CLEAR : LIKELY,
                        target: 'seasons',
                    });
                }
            }
            if (rows.some((r) => r.dec !== null)) out.widgets.push({ id: 'seasons', score, html: (ctx, w) => seasonsWidget(s, rows, top, pal, w) });
        }

        // A sudden shift of the level, only when it is clear.
        const cpEntry = track(changePointOf(s.years));
        const cp = cpEntry && cpEntry.data && cpEntry.data.tools ? cpEntry.data.tools['Change Point'] : null;
        if (cp && cp.available && num(cp.p_value) !== null && cp.p_value < 0.05) {
            const score = (cp.p_value < 0.01 ? 1.9 : 1.4) - (annualSig ? 0.6 : 0);
            out.findings.push({
                score,
                text: `${name}: step change around ${Math.round(cp.x_after)}, ${show(cp.mean_before, s.yearUnit)} → ${show(cp.mean_after, s.yearUnit)}`,
                badge: cp.p_value < 0.01 ? CLEAR : LIKELY,
                target: 'shift',
            });
            out.widgets.push({ id: 'shift', score, html: (ctx, w) => shiftWidget(s, cp, pal, w) });
        }

        // Typical year: first vs. last years, month by month.
        if (s.typical) {
            const diffs = s.typical.early.map((v, i) => (v !== null && s.typical.late[i] !== null ? s.typical.late[i] - v : null));
            const valid = diffs.filter((d) => d !== null);
            let topMonth = -1;
            diffs.forEach((d, i) => { if (d !== null && (topMonth < 0 || Math.abs(d) > Math.abs(diffs[topMonth]))) topMonth = i; });
            const spread = sd(valid) || 0;
            const stand = topMonth >= 0 && spread > 0 ? Math.abs(diffs[topMonth] - (mean(valid) || 0)) / spread : 0;
            const score = 0.7 + Math.min(0.6, stand / 4);
            if (topMonth >= 0 && stand >= 1.8) {
                out.findings.push({
                    score: score + 0.2,
                    text: `${name}: ${MONTH_NAMES[topMonth]} ${show(diffs[topMonth], s.totals ? 'mm' : s.unit, true)} in ${s.typical.lateLabel} vs. ${s.typical.earlyLabel}`,
                    badge: ['Pattern', 'is-pattern'],
                    target: 'typical',
                });
            }
            out.widgets.push({ id: 'typical', score, html: (ctx, w) => typicalWidget(s, diffs, topMonth, pal, ctx, w) });
        }

        // Decades.
        const decades = evoData && Array.isArray(evoData.decades) ? evoData.decades.filter((d) => num(d.mean) !== null) : [];
        if (decades.length >= 2) out.widgets.push({ id: 'decades', score: 0.5 + Math.min(0.4, decades.length / 10), html: (ctx, w) => decadesWidget(s, decades, pal, w) });

        // Extremes and notable events.
        const events = Array.isArray(s.info.events) ? s.info.events : [];
        const lastYear = s.years.length ? s.years[s.years.length - 1].year : null;
        let evScore = 0.45;
        const first = events[0];
        if (first) {
            const year = Number(String(first.peak_date || first.date).slice(0, 4));
            evScore = (/^record/.test(first.kind || '') ? 1.1 : 0.8) + (lastYear !== null && year >= lastYear - 2 ? 0.4 : 0);
            out.findings.push({
                score: evScore,
                text: `${name}: ${first.title || 'notable event'}, ${isoText(first.peak_date || first.date, s.stepDays)}${num(first.value) !== null ? ` (${show(first.value, s.unit)})` : ''}`,
                badge: ['Event', 'is-event'],
                target: 'extremes',
            });
        }
        out.widgets.push({ id: 'extremes', score: evScore, html: (ctx, w) => extremesWidget(s, events, pal, w) });

        // Order: trend and record first, then by strength; mark the strongest one.
        out.widgets.sort((a, b) => (a.fixed ?? 9) - (b.fixed ?? 9) || b.score - a.score);
        const strongest = out.widgets.filter((w) => w.fixed === undefined).sort((a, b) => b.score - a.score)[0];
        if (strongest && strongest.score >= 1.2) strongest.strongest = true;
        return out;
    }

    // ------------------------------------------------------------------ widgets

    function widget(s, w, parts) {
        return tile(`sw-${slug(s.key)}-${w.id}`, slug(s.key), s.key, w, parts);
    }

    // Front of a tile: t = { label, value, unit, pre, arrow, color, desc, chip: [word, class], empty }.
    function front(id, t, w) {
        const big = t.value == null
            ? `<span class="sw-tile-num">${esc(t.empty || '–')}</span>`
            : (t.arrow ? `<span class="sw-tile-arrow" aria-hidden="true">${t.arrow}</span>` : '')
                + (t.pre ? `<small class="sw-tile-pre">${esc(t.pre)}</small>` : '')
                + `<span class="sw-tile-num">${esc(t.value)}</span>`
                + (t.unit ? `<small class="sw-tile-unit${t.unit.startsWith('%') ? ' is-tight' : ''}">${esc(t.unit)}</small>` : '');
        const chip = w.strongest
            ? '<span class="sw-badge is-top" title="The tile with the strongest signal for this variable">Strongest</span>'
            : t.chip ? `<span class="sw-badge ${t.chip[1]}">${esc(t.chip[0])}</span>` : '';
        return `<button type="button" class="sw-face sw-front${w.strongest ? ' is-top' : ''}${t.value == null ? ' is-empty' : ''}" aria-expanded="false" aria-controls="${id}-back" title="Show the chart and details">`
            + `<span class="sw-tile-label">${esc(t.label || '')}</span>`
            + `<span class="sw-tile-big"${t.color ? ` style="color:${t.color}"` : ''}>${big}</span>`
            + `<span class="sw-tile-desc">${esc(t.desc || '')}</span>`
            + `<span class="sw-tile-foot">${chip}<span class="sw-tile-hint" aria-hidden="true">`
            + '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            + '</span></span></button>';
    }

    // A tile: the summary on the front, the widget (chart, numbers) on the back.
    function tile(id, group, key, w, parts) {
        return `<div class="sw-tile" id="${id}" data-sw-group="${esc(group)}"><div class="sw-tile-card">`
            + front(id, parts.tile || { label: parts.title }, w)
            + `<div class="sw-face sw-back" id="${id}-back" role="region" aria-label="${esc(parts.title)}">`
            + `<header class="sw-w-head sw-back-head"><h5 class="sw-w-title"${parts.tip ? ` title="${esc(parts.tip)}"` : ''}>${esc(parts.title)}</h5>`
            + (parts.badge || '')
            + (w.strongest ? '<span class="sw-badge is-top" title="The tile with the strongest signal for this variable">Strongest signal</span>' : '')
            + `<button type="button" class="sw-tile-close" aria-label="Close ${esc(parts.title)}" title="Close (Esc)">✕</button>`
            + '</header>'
            + (parts.lead ? `<p class="sw-w-lead">${esc(parts.lead)}</p>` : '')
            + (parts.body || '')
            + ((parts.how || key)
                ? '<div class="sw-back-foot">'
                    + (parts.how ? `<details class="sw-how"><summary>How this was worked out</summary>${parts.how}</details>` : '')
                    + (key ? `<a class="sw-sci" href="#" data-sw-sci="${esc(key)}" title="Open this series in Scientific mode">Scientific view →</a>` : '')
                    + '</div>'
                : '')
            + '</div></div></div>';
    }

    function chartSlot(ctx, spec, legend, tip) {
        const i = ctx.specs.push(spec) - 1;
        const leg = legend && legend.length ? `<div class="tp-legend sw-legend">${K().legendHtml(legend)}</div>` : '';
        return `<div class="tp-chart sw-chart-host" data-sw-chart="${i}"${tip ? ` title="${esc(tip)}"` : ''}></div>${leg}`;
    }

    function facts(list) {
        const rows = list.filter(Boolean);
        if (!rows.length) return '';
        return `<dl class="sw-facts">${rows.map(([k, v, sub]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub ? `<span>${esc(sub)}</span>` : ''}</dd></div>`).join('')}</dl>`;
    }

    function howList(rows) {
        return `<dl class="sw-how-list">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    }

    function verdictBadge(cls, word, tip) {
        return `<span class="sw-verdict ${cls}" title="${esc(tip)}">${esc(word)}</span>`;
    }

    function yearTicks(domain) {
        return (plotW, shown = domain) => {
            const ys = [];
            for (let y = Math.ceil(shown[0]); y <= Math.floor(shown[1]); y++) ys.push(y);
            const every = Math.max(1, Math.ceil(ys.length / Math.max(2, Math.floor(plotW / 48))));
            const step = every <= 1 ? 1 : every <= 2 ? 2 : every <= 5 ? 5 : every <= 10 ? 10 : Math.ceil(every / 10) * 10;
            return ys.filter((y) => y % step === 0 || step === 1).map((y) => ({ v: y, label: String(y) }));
        };
    }

    function trendWidget(s, entry, pal, ctx, w) {
        const title = s.totals ? 'Trend of the yearly total' : 'Trend';
        const name = 'Trend';
        if (!entry) return widget(s, w, { title, lead: `${s.years.length} full year${s.years.length === 1 ? '' : 's'}: too few for a trend.`, tile: { label: name, desc: 'too few years for a trend' } });
        if (entry.pending) return widget(s, w, { title, body: '<p class="sw-note" role="status">Working out…</p>', tile: { label: name, empty: '…', desc: 'working out…' } });
        if (entry.error) return widget(s, w, { title, lead: `Not available: ${entry.error}`, tile: { label: name, desc: 'not available' } });
        const d = entry.data;
        const t = d.trend || {};
        const series = (d.series || []).filter((p) => num(p.value) !== null);
        const dec = num(t.slope_per_decade);
        let head = '';
        let badge = '';
        let face = { label: name, desc: 'no trend available' };
        if (t.available !== false && dec !== null) {
            const p = num(t.p_value);
            const both = num(t.mk_p_value) !== null && t.mk_p_value < 0.05;
            let chip = null;
            if (series.length < TREND_YEARS) { badge = verdictBadge('is-weak', 'Too few years', `${series.length} years are too few to tell a trend from chance.`); chip = ['Too few years', 'is-weak']; }
            else if (p !== null && p < 0.01) { badge = verdictBadge('is-clear', 'Clear trend', `Very unlikely to be chance${both ? '; an outlier-proof test agrees' : ''}.`); chip = ['Clear', 'is-clear']; }
            else if (p !== null && p < 0.05) { badge = verdictBadge('is-likely', 'Likely trend', `Probably real, but not certain${both ? '; an outlier-proof test agrees' : ''}.`); chip = ['Likely', 'is-likely']; }
            else if (p !== null) { badge = verdictBadge('is-weak', 'Could be chance', 'The years vary too much to be sure of this change.'); chip = ['Could be chance', 'is-weak']; }
            const flat = round(dec) === 0;
            const color = flat ? REF : dec > 0 ? pal.up : pal.down;
            face = {
                label: name, ...split(dec, s.yearUnit, true), color, chip,
                arrow: flat ? '→' : dec > 0 ? '↑' : '↓',
                desc: `per 10 years${flat ? '' : ` · ${dec > 0 ? pal.upW : pal.downW}`}`,
            };
            head = '<div class="sw-trend">'
                + `<div class="sw-big" style="color:${color}"><span class="sw-arrow" aria-hidden="true">${flat ? '→' : dec > 0 ? '↑' : '↓'}</span>${esc(show(dec, s.yearUnit, true))}</div>`
                + `<div class="sw-big-sub">per 10 years${flat ? '' : ` · ${esc(dec > 0 ? pal.upW : pal.downW)}`}</div>`
                + (num(t.total_change) !== null ? `<div class="sw-big-sub">${esc(show(t.total_change, s.yearUnit, true))} over ${t.first_year}–${t.last_year}</div>` : '')
                + '</div>';
        }
        let chart = '';
        if (series.length >= 2) {
            const avg = mean(series.map((p) => p.value));
            const pts = series.map((p) => ({ x: p.year, y: p.value, meta: p }));
            const hiP = pts.reduce((a, b) => (b.y > a.y ? b : a));
            const loP = pts.reduce((a, b) => (b.y < a.y ? b : a));
            const domain = [series[0].year - 0.6, series[series.length - 1].year + 0.6];
            const out = [{ id: 'val', kind: 'line', name: s.totals ? 'Yearly total' : 'Yearly mean', color: LINE, width: 1, points: pts, markers: 3.4, emphasize: (p) => p === hiP || p === loP }];
            const legend = [{ name: s.totals ? 'Yearly total' : 'Yearly mean', color: LINE, style: 'dot' }];
            if (num(t.slope) !== null) {
                const xs = series.map((p) => p.year);
                const mx = mean(xs);
                out.push({ id: 'trend', kind: 'line', name: 'Trend', color: ACCENT, width: 1.8, hover: false, points: [xs[0], xs[xs.length - 1]].map((x) => ({ x, y: avg + t.slope * (x - mx) })) });
                legend.push({ name: 'Trend', color: ACCENT, style: 'line' });
            }
            out.push({ id: 'avg', kind: 'line', name: 'Average', color: REF, width: 1, dash: '4,3', hover: false, points: [{ x: domain[0], y: avg }, { x: domain[1], y: avg }] });
            legend.push({ name: `Average ${show(avg, s.yearUnit)}`, color: REF, style: 'dash' });
            chart = chartSlot(ctx, {
                kind: 'year', height: 210, xDomain: domain, xTicks: yearTicks(domain), formatX: (x) => String(x),
                series: out, unit: s.yearUnit, yLabel: s.yearUnit, ariaLabel: `${label(s.key)}: one value per year with trend line`,
                tooltipExtra: (p) => (p && p.meta ? `${show(p.meta.value - avg, s.yearUnit, true)} vs. average` : ''),
            }, legend);
        }
        const c = d.consistency || {};
        const how = howList([
            ['Method', 'Straight-line trend through the yearly values, corrected for similar neighbouring years'],
            ['Years', `${series.length} (${t.first_year ?? '–'}–${t.last_year ?? '–'}), each with at least half of its values`],
            num(t.ci_low_per_decade) !== null ? ['95 % range', `${show(t.ci_low_per_decade, s.yearUnit, true)} to ${show(t.ci_high_per_decade, s.yearUnit, true)} per 10 years`] : null,
            num(t.p_value) !== null ? ['Chance by luck', `${pct(t.p_value)} (${pWords(t.p_value)})`] : null,
            num(t.sen_slope_per_decade) !== null ? ['Outlier-proof trend (Sen)', `${show(t.sen_slope_per_decade, s.yearUnit, true)} per 10 years`] : null,
            num(t.mk_p_value) !== null ? ['Mann-Kendall test', t.mk_significant ? `${t.mk_direction}, ${pct(t.mk_p_value)}` : `no clear direction (${pct(t.mk_p_value)})`] : null,
            num(c.years_compared) ? ['Years above reference', `${c.years_above_baseline} of ${c.years_compared}`] : null,
        ]);
        return widget(s, w, { title, badge, body: head + chart, how, tile: face });
    }

    function recordWidget(s, ctx, w) {
        const title = 'Whole record';
        const y0 = s.pts.length ? s.pts[0].dt.y : null;
        const y1 = s.pts.length ? s.pts[s.pts.length - 1].dt.y : null;
        const avg = s.totals ? mean(s.years.map((r) => r.value)) : s.mean;
        const face = {
            label: s.totals ? 'Average year' : 'Average',
            ...(avg !== null ? split(avg, s.totals ? 'mm' : s.unit) : {}),
            desc: `${s.n.toLocaleString('en-US')} value${s.n === 1 ? '' : 's'}${y0 !== null ? `, ${y0 === y1 ? y0 : `${y0}–${y1}`}` : ''}`,
        };
        if (s.pts.length < 2) return widget(s, w, { title, lead: 'Too few values.', tile: face });
        const pts = s.pts.map((p) => ({ x: p.t, y: p.v }));
        // Centred one-year running mean, so the seasons do not hide the long-term movement.
        const win = s.stepDays >= 300 ? 1 : Math.max(1, Math.round(365.2425 / s.stepDays));
        const smooth = [];
        if (win > 1 && pts.length > win) {
            let sum = 0;
            for (let i = 0; i < pts.length; i++) {
                sum += pts[i].y;
                if (i >= win) sum -= pts[i - win].y;
                if (i >= win - 1) smooth.push({ x: pts[i - Math.floor(win / 2)].x, y: sum / win });
            }
        }
        const domain = [pts[0].x, pts[pts.length - 1].x];
        const events = (Array.isArray(s.info.events) ? s.info.events : []).slice(0, 5);
        const marks = events.map((ev, i) => {
            const at = Date.parse(String(ev.peak_date || ev.date)) + DAY_MS / 2;
            let best = null;
            for (const p of pts) if (!best || Math.abs(p.x - at) < Math.abs(best.x - at)) best = p;
            const cold = /low|cold/.test(ev.kind || '');
            return best ? { x: best.x, y: best.y, n: i + 1, color: cold ? '#2f5f8f' : '#a1452f', title: `${ev.title || ''} · ${isoText(ev.peak_date || ev.date, s.stepDays)}` } : null;
        }).filter(Boolean);
        const raw = smooth.length ? LIGHT : LINE;
        const per = s.stepDays <= 1 ? 'Daily value' : s.stepDays >= 300 ? 'Yearly value' : s.stepDays >= 20 ? 'Monthly value' : 'Value';
        const series = [{ id: 'raw', kind: 'line', name: per, color: raw, width: 1, points: pts }];
        const legend = [{ name: per, color: raw, style: 'line' }];
        if (smooth.length) {
            series.push({ id: 'smooth', kind: 'line', name: 'One-year mean', color: LINE, width: 2, points: smooth });
            legend.push({ name: 'One-year mean', color: LINE, style: 'line' });
        }
        if (marks.length) legend.push({ name: 'Notable events (see Extremes)', color: '#a1452f', style: 'hollow' });
        const spec = {
            height: 230, xDomain: domain, fullDomain: domain, xTicks: K().timeTicks(domain),
            formatX: (x) => timeText(x, s.stepDays),
            series, unit: s.unit, yLabel: s.unit, eventMarks: marks, zoomable: true,
            ariaLabel: `${label(s.key)}: every value with a running one-year mean`,
        };
        const how = howList([
            ['Values', `${s.n.toLocaleString('en-US')}, ${dateText(s.pts[0].dt, s.stepDays)} – ${dateText(s.pts[s.pts.length - 1].dt, s.stepDays)}`],
            ['Measured at', siteOf(s.info)],
            win > 1 ? ['Smoothing', `running mean of ${win} values (one year)`] : null,
        ]);
        return widget(s, w, { title, body: chartSlot(ctx, spec, legend, 'Drag across the chart to zoom in, double-click to zoom out'), how, tile: face });
    }

    // Horizontal bars from the centre: rows = [{ name, v, sub, weak }].
    function bars(rows, unit, pal, highlight) {
        const max = Math.max(...rows.map((r) => Math.abs(r.v ?? 0))) || 1;
        return `<ul class="sw-bars">${rows.map((r) => {
            if (r.v === null) return `<li class="is-weak"><span class="sw-bar-name">${esc(r.name)}</span><span class="sw-bar-track"></span><span class="sw-bar-val">–</span></li>`;
            const f = (Math.abs(r.v) / max) * 50;
            const left = r.v < 0 ? 50 - f : 50;
            return `<li class="${r === highlight ? 'is-top' : ''}${r.weak ? ' is-weak' : ''}"${r.tip ? ` title="${esc(r.tip)}"` : ''}><span class="sw-bar-name">${esc(r.name)}</span>`
                + `<span class="sw-bar-track"><span style="left:${left.toFixed(1)}%;width:${f.toFixed(1)}%;background:${r.v >= 0 ? pal.up : pal.down}"></span></span>`
                + `<span class="sw-bar-val">${esc(show(r.v, unit, true))}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></li>`;
        }).join('')}</ul>`;
    }

    function seasonsWidget(s, rows, top, pal, w) {
        const list = rows.map((r) => ({
            name: seasonName(r.season, s.lat), v: r.dec, ref: r,
            sub: r.p === null ? '' : r.p < 0.01 ? 'clear' : r.p < 0.05 ? 'likely' : 'could be chance',
            weak: r.p === null || r.p >= 0.05,
        }));
        const hi = top ? list.find((x) => x.ref === top) : null;
        // The season changing most; without a clear one, the largest change (could be chance).
        const lead = top || rows.filter((r) => r.dec !== null).sort((a, b) => Math.abs(b.dec) - Math.abs(a.dec))[0];
        const short = seasonName(lead.season, s.lat).split(' ')[0];
        const face = {
            label: 'Seasons', ...split(lead.dec, s.yearUnit, true),
            color: round(lead.dec) === 0 ? REF : lead.dec > 0 ? pal.up : pal.down,
            desc: top ? `${short} changes most, per 10 years` : `${short}, per 10 years`,
            chip: top ? (top.p < 0.01 ? ['Clear', 'is-clear'] : ['Likely', 'is-likely']) : ['Could be chance', 'is-weak'],
        };
        const how = howList([
            ['Method', 'One value per season and year (winter counts to the year of its January), then the same trend test as the whole year'],
            ...rows.map((r) => [seasonName(r.season, s.lat), r.trend ? `${r.years.length} years, ${show(r.dec, s.yearUnit, true)} per 10 years, ${pWords(r.p)}` : `${r.years.length} years: too few`]),
        ]);
        return widget(s, w, {
            title: 'Seasons', tip: 'Change per 10 years in each season; faded bars could be chance',
            badge: top ? verdictBadge(top.p < 0.01 ? 'is-clear' : 'is-likely', `${seasonName(top.season, s.lat).split(' ')[0]} changes most`, 'The season with the largest clear change') : '',
            body: `${bars(list, s.yearUnit, pal, hi)}<p class="sw-unit">per 10 years${s.totals ? ' (season total)' : ''}</p>`, how, tile: face,
        });
    }

    function shiftWidget(s, cp, pal, w) {
        const when = Math.round(cp.x_after);
        const body = facts([
            [`Before ${when}`, show(cp.mean_before, s.yearUnit), `${s.years[0].year}–${Math.round(cp.x_before)}`],
            [`From ${when}`, show(cp.mean_after, s.yearUnit), `${when}–${s.years[s.years.length - 1].year}`],
            ['Step', show(cp.shift, s.yearUnit, true), cp.shift > 0 ? pal.upW : pal.downW],
        ]);
        const how = howList([
            ['Method', 'Pettitt test on the yearly values: the year where the values before and after differ most'],
            ['Chance by luck', `${pct(cp.p_value)} (${pWords(cp.p_value)})`],
            ['Note', 'A steady trend can also appear as a step'],
        ]);
        const face = {
            label: 'Sudden shift', ...split(cp.shift, s.yearUnit, true),
            color: cp.shift > 0 ? pal.up : pal.down,
            desc: `step around ${when}, ${cp.shift > 0 ? pal.upW : pal.downW}`,
            chip: cp.p_value < 0.01 ? ['Clear', 'is-clear'] : ['Likely', 'is-likely'],
        };
        return widget(s, w, { title: 'Sudden shift', badge: verdictBadge(cp.p_value < 0.01 ? 'is-clear' : 'is-likely', cp.p_value < 0.01 ? 'Clear' : 'Likely', pWords(cp.p_value)), body, how, tile: face });
    }

    function typicalWidget(s, diffs, topMonth, pal, ctx, w) {
        const ty = s.typical;
        const unit = s.totals ? 'mm' : s.unit;
        const mk = (vs) => vs.map((v, i) => ({ x: i + 1, y: v })).filter((p) => p.y !== null);
        const spec = {
            kind: 'year', height: 210, xDomain: [0.6, 12.4],
            xTicks: () => MONTHS.map((m, i) => ({ v: i + 1, label: m })),
            formatX: (x) => MONTH_NAMES[Math.round(x) - 1] || '',
            series: [
                { id: 'early', kind: 'line', name: ty.earlyLabel, color: EARLY, width: 1.6, points: mk(ty.early), markers: 3 },
                { id: 'late', kind: 'line', name: ty.lateLabel, color: pal.up, width: 2.2, points: mk(ty.late), markers: 3.4, emphasize: (p) => p.x === topMonth + 1 },
            ],
            unit, yLabel: `${s.totals ? 'Monthly total' : 'Monthly mean'}${unit ? ` (${unit})` : ''}`,
            ariaLabel: `Each month in ${ty.earlyLabel} compared with ${ty.lateLabel}`,
            tooltipExtra: (p) => { const d = p ? diffs[p.x - 1] : null; return num(d) !== null ? `${show(d, unit, true)} later vs. earlier` : ''; },
        };
        const legend = [
            { name: ty.earlyLabel, color: EARLY, style: 'dot' },
            { name: ty.lateLabel, color: pal.up, style: 'dot' },
        ];
        const badge = topMonth >= 0
            ? `<span class="sw-badge is-pattern" title="Month with the largest difference">${esc(MONTHS[topMonth])} ${esc(show(diffs[topMonth], unit, true))}</span>`
            : '';
        const how = howList([
            ['Method', `Mean of each calendar month over the first ${ty.k} and the last ${ty.k} full years`],
            ...diffs.map((d, i) => (d === null ? null : [MONTH_NAMES[i], show(d, unit, true)])),
        ]);
        const face = topMonth >= 0
            ? {
                label: 'Typical year', ...split(diffs[topMonth], unit, true),
                color: diffs[topMonth] > 0 ? pal.up : pal.down,
                desc: `${MONTH_NAMES[topMonth]}, last ${ty.k} vs. first ${ty.k} years`,
                chip: ['Pattern', 'is-pattern'],
            }
            : { label: 'Typical year', desc: 'then and now' };
        return widget(s, w, { title: 'Typical year: then and now', badge, body: chartSlot(ctx, spec, legend), how, tile: face });
    }

    function decadesWidget(s, decades, pal, w) {
        const first = decades[0];
        const rows = decades.map((d, i) => ({ name: d.label, v: i === 0 ? 0 : d.mean - first.mean, sub: show(d.mean, s.yearUnit) }));
        const last = rows[rows.length - 1];
        const how = howList([
            ['Method', 'Mean of every calendar decade (2010s = 2010–2019) with at least five years'],
            ...decades.map((d) => [d.label, `${show(d.mean, s.yearUnit)} from ${d.n} years`]),
        ]);
        return widget(s, w, {
            title: 'Decades', tip: `Difference of each decade to the ${first.label}; the decade mean is on the right`,
            body: `${bars(rows, s.yearUnit, pal, rows[rows.length - 1])}<p class="sw-unit">vs. the ${esc(first.label)}</p>`, how,
            tile: {
                label: 'Decades', ...split(last.v, s.yearUnit, true),
                color: round(last.v) === 0 ? REF : last.v > 0 ? pal.up : pal.down,
                desc: `${decades[decades.length - 1].label} vs. ${first.label}`,
            },
        });
    }

    function extremesWidget(s, events, pal, w) {
        const per = s.stepDays <= 1 ? 'day' : s.stepDays >= 300 ? 'year' : s.stepDays >= 20 ? 'month' : 'value';
        const u = s.unit;
        const list = [];
        if (num(s.mean) !== null) list.push(['Average', show(s.mean, u)]);
        if (s.hi) list.push([s.kind === 'neutral' ? `Highest ${per}` : `${cap(pal.hiW)} ${per}`, show(s.hi.v, u), dateText(s.hi.dt, s.stepDays)]);
        if (s.lo && s.kind !== 'wet') list.push([`${cap(s.kind === 'neutral' ? 'lowest' : pal.loW)} ${per}`, show(s.lo.v, u), dateText(s.lo.dt, s.stepDays)]);
        if (s.years.length >= 2) {
            const hiY = s.years.reduce((a, b) => (b.value > a.value ? b : a));
            const loY = s.years.reduce((a, b) => (b.value < a.value ? b : a));
            list.push([`${cap(pal.hiW)} year`, show(hiY.value, s.yearUnit), String(hiY.year)]);
            list.push([`${cap(pal.loW)} year`, show(loY.value, s.yearUnit), String(loY.year)]);
        }
        const evs = events.slice(0, 5);
        const evHtml = evs.length
            ? `<ol class="sw-events">${evs.map((ev) => `<li${ev.description ? ` title="${esc(ev.description)}"` : ''}><strong>${esc(ev.title || 'Event')}</strong>`
                + `<span>${esc(isoText(ev.peak_date || ev.date, s.stepDays))}${num(ev.value) !== null ? ` · ${esc(show(ev.value, u))}` : ''}</span></li>`).join('')}</ol>`
            : '';
        const how = howList([
            ['Highest / lowest', 'single values as measured'],
            evs.length ? ['Notable events', 'records and values far from the normal of that calendar day (or month), most remarkable first'] : null,
        ]);
        const face = s.hi
            ? {
                label: s.kind === 'neutral' ? `Highest ${per}` : `${cap(pal.hiW)} ${per}`,
                ...split(s.hi.v, u), color: pal.up, desc: dateText(s.hi.dt, s.stepDays),
                chip: events.length ? [`${events.length} event${events.length === 1 ? '' : 's'}`, 'is-event'] : null,
            }
            : { label: 'Extremes', desc: 'no values' };
        return widget(s, w, { title: 'Extremes', body: facts(list) + evHtml, how, tile: face });
    }

    function relationSection(corr) {
        if (!corr) return '';
        const { entry, yearly } = corr;
        const title = 'How the variables relate';
        const tip = 'Correlation r: −1 always opposite, 0 no link, +1 always together';
        const name = 'Strongest link';
        const wrap = (parts) => `<section class="sw-section" aria-label="${title}"><header class="sw-section-head"><h4 class="sw-name">${title}</h4></header>`
            + `<div class="sw-tiles">${tile('sw-relation', 'relation', null, { id: 'relation' }, { title, tip, ...parts })}</div></section>`;
        if (entry.pending) return wrap({ body: '<p class="sw-note" role="status">Working out…</p>', tile: { label: name, empty: '…', desc: 'working out…' } });
        if (entry.error || !entry.data) return wrap({ lead: `Not available${entry.error ? `: ${entry.error}` : ''}`, tile: { label: name, desc: 'not available' } });
        const pairs = (entry.data.pairs || []).filter((p) => p.available && num(p.pearson) !== null)
            .sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson));
        if (!pairs.length) return wrap({ lead: 'Too few overlapping values.', tile: { label: name, desc: 'too few overlapping values' } });
        const rows = pairs.slice(0, 6).map((p) => {
            const f = Math.abs(p.pearson) * 50;
            const left = p.pearson < 0 ? 50 - f : 50;
            return `<li class="${p.significant ? '' : 'is-weak'}"><span class="sw-bar-name">${esc(label(p.a))} & ${esc(label(p.b))}</span>`
                + `<span class="sw-bar-track"><span style="left:${left.toFixed(1)}%;width:${f.toFixed(1)}%;background:${p.pearson >= 0 ? LINE : ACCENT}"></span></span>`
                + `<span class="sw-bar-val">r = ${p.pearson.toFixed(2)}<small>${p.pearson >= 0 ? 'together' : 'opposite'}${p.significant ? '' : ', could be chance'}</small></span></li>`;
        }).join('');
        const how = howList([
            ['Compared', yearly ? 'yearly values' : 'monthly departures from each month’s normal, so the seasons alone create no link'],
            ...pairs.map((p) => [`${label(p.a)} & ${label(p.b)}`, `r = ${p.pearson.toFixed(2)} from ${p.n} ${yearly ? 'years' : 'months'}, ${pWords(num(p.p_value))}`]),
        ]);
        const best = pairs[0];
        const face = {
            label: name, pre: 'r', value: `${best.pearson < 0 ? '−' : ''}${Math.abs(best.pearson).toFixed(2)}`,
            color: best.pearson >= 0 ? LINE : ACCENT,
            desc: `${label(best.a)} & ${label(best.b)}`,
            chip: best.significant ? [best.pearson >= 0 ? 'Together' : 'Opposite', 'is-link'] : ['Could be chance', 'is-weak'],
        };
        return wrap({ body: `<ul class="sw-bars sw-bars-r">${rows}</ul>`, how, tile: face });
    }

    // ------------------------------------------------------------------- tiles

    function reducedMotion() {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function tilesOf(grid) {
        return [...grid.children].filter((el) => el.classList.contains('sw-tile'));
    }

    // A tile animation in a grid blocks the next one (a stale flag expires).
    function busy(grid) {
        return Boolean(grid._swBusy) && Date.now() - grid._swBusy < 2000;
    }

    // Charts sit on the back: drawn when the tile opens, at its full width, never into a hidden host.
    function drawCharts(tile) {
        const K0 = K();
        if (!K0) return;
        tile.querySelectorAll('[data-sw-chart]').forEach((el) => {
            const width = Math.floor(el.clientWidth);
            if (!el._swSpec || !width) return;
            el._swW = width;
            K0.renderChart(el, el._swSpec);
            if (observer) observer.observe(el);
        });
    }

    function releaseCharts(tile) {
        if (!observer) return;
        tile.querySelectorAll('[data-sw-chart]').forEach((el) => observer.unobserve(el));
    }

    function setOpen(tile, open) {
        tile.classList.toggle('is-open', open);
        const btn = tile.querySelector('.sw-front');
        if (btn) btn.setAttribute('aria-expanded', String(open));
        if (open) drawCharts(tile);
        else releaseCharts(tile);
    }

    // The tiles of a grid and the sections below it: everything a tile pushes around.
    function moversOf(grid) {
        const out = tilesOf(grid);
        const sec = grid.closest('.sw-section');
        for (let n = sec && sec.nextElementSibling; n; n = n.nextElementSibling) out.push(n);
        return out;
    }

    function rectsOf(tiles) {
        return new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
    }

    // FLIP: each element glides from its old place to its new one; `fade` also fades in.
    function glide(tiles, before, fade) {
        for (const t of tiles) {
            const a = before.get(t);
            const b = t.getBoundingClientRect();
            const dx = a.left - b.left;
            const dy = a.top - b.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && t !== fade) continue;
            const from = { transform: `translate(${dx}px, ${dy}px)` };
            const to = { transform: 'none' };
            if (t === fade) { from.opacity = 0; to.opacity = 1; }
            t.animate([from, to], { duration: GROW_MS, easing: EASE });
        }
    }

    function scrollNear(tile) {
        const r = tile.getBoundingClientRect();
        if (r.top >= 0 && r.bottom <= window.innerHeight) return;
        tile.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: r.height > window.innerHeight ? 'start' : 'nearest' });
    }

    // Open: the front turns to its edge in place, then the tile takes the full row and
    // grows from its old box (FLIP) while the back turns into view. One open tile per variable.
    function openTile(tile) {
        const grid = tile.parentElement;
        if (!grid || busy(grid) || tile.classList.contains('is-open') || tile.classList.contains('is-static')) return;
        const other = tilesOf(grid).find((t) => t !== tile && t.classList.contains('is-open'));
        state.open.set(tile.dataset.swGroup, tile.id);
        const card = tile.querySelector('.sw-tile-card');
        const swap = () => {
            if (other) setOpen(other, false);
            setOpen(tile, true);
        };
        const done = () => {
            grid._swBusy = 0;
            const close = tile.querySelector('.sw-tile-close');
            if (close) close.focus({ preventScroll: true });
            scrollNear(tile);
        };
        if (reducedMotion() || !card || typeof card.animate !== 'function') { swap(); done(); return; }
        grid._swBusy = Date.now();
        tile.classList.add('is-turning');
        const half = card.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(90deg)' }],
            { duration: TURN_MS, easing: 'cubic-bezier(0.55, 0, 1, 0.45)', fill: 'forwards' });
        half.onfinish = () => {
            if (!tile.isConnected) return;
            const movers = moversOf(grid);
            const before = rectsOf(movers);
            swap();
            const a = before.get(tile);
            const b = tile.getBoundingClientRect();
            glide(movers.filter((t) => t !== tile), before, other);
            tile.animate([
                { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})` },
                { transform: 'none' },
            ], { duration: GROW_MS, easing: EASE });
            const rest = card.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(180deg)' }],
                { duration: GROW_MS, easing: EASE, fill: 'forwards' });
            half.cancel();
            rest.onfinish = () => {
                tile.classList.remove('is-turning');
                rest.cancel();
                done();
            };
        };
    }

    // Close: the back shrinks to the tile's closed size while turning to its edge, then
    // the tile glides to its place in the grid while the front turns into view.
    function closeTile(tile, focus) {
        const grid = tile.parentElement;
        if (!grid || busy(grid) || !tile.classList.contains('is-open')) return;
        state.open.delete(tile.dataset.swGroup);
        const card = tile.querySelector('.sw-tile-card');
        const done = () => {
            grid._swBusy = 0;
            const btn = tile.querySelector('.sw-front');
            if (focus && btn) btn.focus({ preventScroll: true });
        };
        if (reducedMotion() || !card || typeof card.animate !== 'function') { setOpen(tile, false); done(); return; }
        grid._swBusy = Date.now();
        // The closed size, measured before anything is painted.
        const big = tile.getBoundingClientRect();
        tile.classList.remove('is-open');
        const small = tile.getBoundingClientRect();
        tile.classList.add('is-open', 'is-turning');
        const ease = 'cubic-bezier(0.55, 0, 1, 0.45)';
        const shrink = tile.animate([
            { transform: 'none' },
            { transform: `translate(${(big.width - small.width) / 2}px, ${(big.height - small.height) / 2}px) scale(${small.width / big.width}, ${small.height / big.height})` },
        ], { duration: TURN_MS + 60, easing: ease, fill: 'forwards' });
        const half = card.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(90deg)' }],
            { duration: TURN_MS + 60, easing: ease, fill: 'forwards' });
        half.onfinish = () => {
            if (!tile.isConnected) return;
            const movers = moversOf(grid);
            const before = rectsOf(movers);
            shrink.cancel();
            setOpen(tile, false);
            glide(movers, before);
            const rest = card.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0deg)' }],
                { duration: GROW_MS, easing: EASE, fill: 'forwards' });
            half.cancel();
            rest.onfinish = () => {
                tile.classList.remove('is-turning');
                rest.cancel();
                done();
            };
        };
    }

    // Key findings: scroll to the tile, then open it.
    function gotoTile(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const behavior = reducedMotion() ? 'auto' : 'smooth';
        el.scrollIntoView({ behavior, block: 'center' });
        if (!el.classList.contains('sw-tile') || el.classList.contains('is-open')) {
            el.classList.remove('is-flash');
            void el.offsetWidth;
            el.classList.add('is-flash');
            return;
        }
        setTimeout(() => {
            const now = document.getElementById(id);
            if (now) openTile(now);
        }, behavior === 'smooth' ? 420 : 0);
    }

    function openScientific(key) {
        if (window.TrendMode && typeof window.TrendMode.set === 'function') window.TrendMode.set('scientific');
        if (window.TrendPlots && typeof window.TrendPlots.showSeries === 'function') window.TrendPlots.showSeries(key);
    }

    // ------------------------------------------------------------------ render

    function mount(host) {
        state.host = host;
        host.addEventListener('click', (e) => {
            const t = e.target;
            if (!(t instanceof Element)) return;
            const goto = t.closest('a[data-sw-goto]');
            if (goto) { e.preventDefault(); gotoTile(goto.dataset.swGoto); return; }
            const sci = t.closest('a[data-sw-sci]');
            if (sci) { e.preventDefault(); openScientific(sci.dataset.swSci); return; }
            // "How this was worked out": once it has opened, scroll it into view.
            const how = t.closest('details.sw-how > summary');
            if (how) {
                const det = how.parentElement;
                setTimeout(() => { if (det.open) scrollNear(det); }, 0);
                return;
            }
            const tile = t.closest('.sw-tile');
            if (!tile || tile.classList.contains('is-static')) return;
            if (t.closest('.sw-front')) { openTile(tile); return; }
            if (t.closest('.sw-tile-close')) { closeTile(tile, true); return; }
            // A click on the back's head (not on a control) turns the tile back too.
            if (t.closest('.sw-back-head') && !t.closest('a, button, summary')) closeTile(tile, false);
        });
        host.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !(e.target instanceof Element)) return;
            const tile = e.target.closest('.sw-tile.is-open');
            if (tile) { e.preventDefault(); closeTile(tile, true); }
        });
        if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver((entries) => {
                const K0 = K();
                for (const en of entries) {
                    const el = en.target;
                    const width = Math.floor(el.clientWidth);
                    if (K0 && el._spec && width && width !== el._swW) { el._swW = width; K0.renderChart(el, el._spec); }
                }
            });
        }
        render();
    }

    function setData(viz, request) {
        state.viz = viz || null;
        state.request = request || null;
        scheduleRender();
    }

    function setLoading(on) {
        state.loading = Boolean(on);
        if (on) { state.viz = null; state.request = null; state.open.clear(); }
        scheduleRender();
    }

    function scheduleRender() {
        if (state.raf) return;
        // A timer, not requestAnimationFrame: that one pauses in a background tab.
        state.raf = setTimeout(() => { state.raf = 0; render(); }, 16);
    }

    function render() {
        const host = state.host;
        if (!host) return;
        const topics = state.viz && state.viz.topics ? Object.entries(state.viz.topics) : [];
        if (!topics.length || !K()) {
            // Nothing analysed yet: empty, so the card is hidden (mode.css).
            const html = state.loading ? '<div class="sw-empty">Loading data…</div>' : '';
            if (html !== state.html) { host.innerHTML = html; state.html = html; }
            return;
        }
        const stepDays = stepDaysOf(state.request);
        const ctx = { specs: [] };

        const ok = [];
        const failed = [];
        for (const [key, info] of topics) {
            const values = Array.isArray(info && info.values) ? info.values.filter((v) => num(v) !== null) : [];
            if (!info || info.error || !values.length) failed.push([key, info || {}]);
            else ok.push(prepare(key, info, stepDays));
        }
        const analysed = ok.map((s) => ({ s, a: analyse(s) }));
        const corr = state.loading ? null : correlationOf(ok);

        // Key findings: the strongest results of all variables.
        const findings = [];
        for (const { s, a } of analysed) for (const f of a.findings) findings.push({ ...f, anchor: `sw-${slug(s.key)}-${f.target}` });
        if (corr && corr.entry.data) {
            const best = (corr.entry.data.pairs || [])
                // Two series of one variable (maximum / minimum temperature) are linked anyway.
                .filter((p) => p.available && p.significant && num(p.pearson) !== null && Math.abs(p.pearson) >= 0.3
                    && p.a.split(' · ')[0] !== p.b.split(' · ')[0])
                .sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson))[0];
            if (best) {
                findings.push({
                    score: 0.9 + Math.abs(best.pearson),
                    text: `${label(best.a)} and ${label(best.b)} ${best.pearson >= 0 ? 'rise and fall together' : 'move in opposite directions'} (r = ${best.pearson.toFixed(2)})`,
                    badge: ['Link', 'is-link'], anchor: 'sw-relation',
                });
            }
        }
        findings.sort((x, y) => y.score - x.score);
        const shown = findings.filter((f, i) => i < 5 && (f.score >= 0.8 || i === 0));
        const pending = analysed.some(({ a }) => a.pending) || Boolean(corr && corr.entry.pending);

        let html = '';
        if (shown.length || pending) {
            html += '<section class="sw-findings" aria-label="Key findings">'
                + `<h4 class="sw-findings-title" title="Picked automatically from all analyses, strongest first; a click opens the tile">Key findings${pending ? '<span role="status">working out…</span>' : ''}</h4>`
                + (shown.length ? `<ol>${shown.map((f) => `<li><span class="sw-badge ${f.badge[1]}">${esc(f.badge[0])}</span><a href="#${f.anchor}" data-sw-goto="${f.anchor}">${esc(f.text)}</a></li>`).join('')}</ol>` : '')
                + '</section>';
        }

        // Variables in the order of their strongest finding.
        const strength = (a) => Math.max(0, ...a.findings.map((f) => f.score));
        analysed.sort((x, y) => strength(y.a) - strength(x.a));
        for (const { s, a } of analysed) {
            const yearsText = s.years.length ? `${s.years[0].year}–${s.years[s.years.length - 1].year}` : '';
            html += `<section class="sw-section" aria-label="${esc(label(s.key))}"><header class="sw-section-head"><h4 class="sw-name">${esc(label(s.key))}</h4>`
                + `<span class="sw-meta">${esc([siteOf(s.info), yearsText].filter(Boolean).join(' · '))}</span></header>`
                + `<div class="sw-tiles">${a.widgets.map((w) => w.html(ctx, w)).join('')}</div></section>`;
        }
        if (failed.length) {
            html += `<section class="sw-section" aria-label="Variables without data"><div class="sw-tiles">${failed.map(([key, info]) => '<div class="sw-tile is-static"><div class="sw-face sw-front sw-card-failed">'
                + `<span class="sw-tile-label">${esc(label(key))}</span><span class="sw-tile-big sw-x" aria-hidden="true">✕</span>`
                + `<span class="sw-tile-desc"${info.error ? ` title="${esc(info.error)}"` : ''}>No data${info.error ? `: ${esc(info.error)}` : ''}</span></div></div>`).join('')}</div></section>`;
        }
        html += relationSection(corr);
        if (state.loading) html += '<div class="sw-card-pending" role="status">Loading the next variable…</div>';

        // Same content: keep the tiles (open ones, their charts and zoom) as they are.
        if (html === state.html) return;
        state.html = html;
        const scrollY = window.scrollY;
        if (observer) observer.disconnect();
        host.innerHTML = html;
        const K0 = K();
        host.querySelectorAll('[data-sw-chart]').forEach((el) => {
            const spec = ctx.specs[Number(el.dataset.swChart)];
            if (!spec) return;
            el._swSpec = spec;
            if (spec.zoomable) {
                el._onZoom = (dom) => {
                    const sp = el._spec;
                    sp.xDomain = dom || sp.fullDomain;
                    sp.zoomed = Boolean(dom);
                    K0.renderChart(el, sp);
                };
            }
        });
        // Tiles that were open stay open (charts are drawn for them only).
        for (const [group, id] of state.open) {
            const t = document.getElementById(id);
            if (t && host.contains(t) && t.dataset.swGroup === group) setOpen(t, true);
            else state.open.delete(group);
        }
        window.scrollTo(0, scrollY);
    }

    window.TrendSimple = { mount, setData, setLoading };
})();
