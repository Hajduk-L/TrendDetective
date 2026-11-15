/*
 * TrendDetective plot panel (below the map).
 *
 * Plots one topic of the last request in three views:
 *   - Timeline: the whole series; a chosen period (e.g. every January) is
 *     shaded in every year and its points are emphasised.
 *   - Years overlaid: every year as its own line on a Jan..Dec axis, so the
 *     same time frame of different years lies on top of each other.
 *   - Period across years: one value per year (the mean of a time frame,
 *     e.g. January) for every analysis time frame.
 * Analyses: any number of time frames (whole series, a month, a season, the
 * whole year or a custom DD.MM – DD.MM range), each with its own selection of
 * the analysis tools of src/task.py. For a period a tool runs inside every
 * year's period on its own (e.g. a linear regression over 1–31 January 2014,
 * another over January 2015, …); the per-year lines are drawn into the plot
 * and the slopes are compared year by year below it.
 * Functions: anomaly (deviation from the multi-year mean of the same time of
 * year), moving average, multi-year mean ± 1σ, zoom to period.
 *
 * Public API (window.TrendPlots):
 *   mount(element)                       build the panel inside `element`
 *   setData(visualization, userRequest)  data from the 'Apply' response
 *   setLoading(boolean)
 *
 * The only server call is POST /api/analyze (plot_analysis.py).
 */
(function () {
    'use strict';

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const MONTH_START = MONTH_DAYS.reduce((acc, d, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + MONTH_DAYS[i - 1]); return acc; }, []);
    const DAY_MS = 86400000;
    const YEAR_DAYS = 365;
    const INTERVAL_DAYS = { Day: 1, Month: 30.436875, Year: 365.2425 };
    const MAX_OVERLAY_STEP_DAYS = 62;
    const CLIM_SMOOTH_DAYS = 15;

    // Sequential blue ramp (light -> dark) for ordered years; the latest year is darkest.
    const YEAR_RAMP = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
    const COLOR = {
        series: '#2a78d6',
        movingAverage: '#6250d6',
        reference: '#52514e',
        referenceBand: 'rgba(82, 81, 78, 0.13)',
        accent: '#eb6834',
        accentWash: 'rgba(235, 104, 52, 0.11)',
        whisker: '#9ec5f4',
        grid: '#e1e0d9',
        axis: '#c3c2b7',
        surface: '#fcfcfb',
    };

    const PERIOD_PRESETS = [
        { id: 'none', label: 'No highlight' },
        { id: 'year', label: 'Whole year (annual mean)', start: [1, 1], end: [12, 31] },
        ...MONTH_NAMES.map((name, i) => ({ id: `m${i + 1}`, label: name, start: [i + 1, 1], end: [i + 1, i === 1 ? 29 : MONTH_DAYS[i]], group: 'Months' })),
        { id: 'djf', label: 'Winter (Dec–Feb)', start: [12, 1], end: [2, 29], group: 'Seasons' },
        { id: 'mam', label: 'Spring (Mar–May)', start: [3, 1], end: [5, 31], group: 'Seasons' },
        { id: 'jja', label: 'Summer (Jun–Aug)', start: [6, 1], end: [8, 31], group: 'Seasons' },
        { id: 'son', label: 'Autumn (Sep–Nov)', start: [9, 1], end: [11, 30], group: 'Seasons' },
        { id: 'custom', label: 'Custom (DD.MM – DD.MM)…' },
    ];

    const DEFAULT_TOOLS = ['Linear Regression', 'Mann-Kendall', "Sen's Slope", 'Change Point', 't-Test'];
    const TOOL_SHORT = { 'Linear Regression': 'Linear regression', 'Mann-Kendall': 'Mann-Kendall', 't-Test': 't-Test', "Sen's Slope": "Sen's slope", 'Change Point': 'Change point' };
    const TOOL_HELP = {
        'Linear Regression': 'Straight line through the values: the average change per year.',
        'Mann-Kendall': 'Does the series keep going up (or down)? Robust to outliers; says nothing about the size.',
        "Sen's Slope": 'Median of the slopes between all pairs of values: a trend that single extremes cannot pull.',
        'Change Point': 'Pettitt test: the moment where the level of the series shifted most clearly.',
        't-Test': 'Compares the mean of the first half with the second half.',
    };
    // Notable events (events.py): icon and marker colour per kind.
    const EVENT_STYLE = {
        record_high: { icon: '▲', color: '#c2410c' },
        record_low: { icon: '▼', color: '#1d4ed8' },
        high: { icon: '↑', color: '#ea580c' },
        low: { icon: '↓', color: '#2563eb' },
        warm_spell: { icon: '≋', color: '#dc2626' },
        cold_spell: { icon: '≋', color: '#0284c7' },
    };
    // Diverging ramps for the stripes view (blue = below the mean, red = above; brown/green for wetness).
    const STRIPES_WARM = ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef', '#deebf7', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'];
    const STRIPES_WET = ['#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30'];
    // One colour per analysis time frame (distinct from the blue data series and the year ramp).
    const WINDOW_COLORS = ['#eb6834', '#1a9e74', '#c2399b', '#8f6a00', '#6250d6', '#d1394a'];

    const VIEWS = [
        { id: 'timeline', label: 'Timeline' },
        { id: 'overlay', label: 'Years overlaid' },
        { id: 'period', label: 'Period across years' },
        { id: 'stripes', label: 'Stripes' },
    ];

    const state = {
        root: null,
        refs: {},
        viz: null,
        request: null,
        topic: null,
        view: 'timeline',
        periodId: 'none',
        custom: { start: '01.06', end: '31.08' },
        fn: { anomaly: false, ma: false, maWindow: 3, clim: false, zoom: false },
        tools: DEFAULT_TOOLS.slice(),
        // Analysis time frames: frame is 'all' (whole series) or a PERIOD_PRESETS id.
        windows: [{ id: 1, frame: 'all', custom: { start: '01.06', end: '31.08' }, tools: DEFAULT_TOOLS.slice() }],
        nextWindowId: 2,
        hiddenYears: new Set(),
        zoom: null,
        showTable: false,
        loading: false,
        analysisCache: new Map(),
        lastTable: null,
        activeEvent: null,
    };

    // ------------------------------------------------------------------ utils

    function esc(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function isNum(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    function fmt(v, digits) {
        if (!isNum(v)) return '–';
        const abs = Math.abs(v);
        const d = digits ?? (abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 2 : 3);
        return v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
    }

    function fmtSigned(v, digits) {
        if (!isNum(v)) return '–';
        return (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), digits);
    }

    function withUnit(text, unit) {
        return unit ? `${text} ${unit}` : text;
    }

    function parseDdMmYyyy(s) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
        if (!m) return null;
        const t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
        return Number.isFinite(t) ? t : null;
    }

    function ddmmyyyy(t) {
        const d = new Date(t);
        return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
    }

    // Position in a generic 365-day year (0 = 1 Jan); 29 Feb sits between 28 Feb and 1 Mar.
    function yearPos(month, day) {
        if (month === 2 && day === 29) return MONTH_START[1] + 27.5;
        return MONTH_START[month - 1] + Math.min(day, MONTH_DAYS[month - 1]) - 1;
    }

    function mdKey(month, day) {
        return month * 100 + day;
    }

    function niceStep(raw) {
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        const f = raw / power;
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
    }

    function tickDecimals(step) {
        if (step >= 1) return step % 1 === 0 ? 0 : 1;
        return Math.min(4, Math.ceil(-Math.log10(step)) + (Math.round(step * Math.pow(10, Math.ceil(-Math.log10(step)))) % 1 ? 1 : 0));
    }

    function mean(values) {
        const v = values.filter(isNum);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    }

    function stdDev(values) {
        const v = values.filter(isNum);
        if (v.length < 2) return null;
        const m = mean(v);
        return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
    }

    function ols(points) {
        const p = points.filter((q) => isNum(q.x) && isNum(q.y));
        if (p.length < 2) return null;
        const mx = mean(p.map((q) => q.x));
        const my = mean(p.map((q) => q.y));
        let sxx = 0;
        let sxy = 0;
        for (const q of p) {
            sxx += (q.x - mx) * (q.x - mx);
            sxy += (q.x - mx) * (q.y - my);
        }
        if (sxx === 0) return null;
        const slope = sxy / sxx;
        return { slope, intercept: my - slope * mx };
    }

    // Centred moving average over consecutive points (by index), ignoring gaps inside the window.
    // Centred moving average over exactly `window` intervals (for an even window one more
    // before than after). `step` is one interval in x units: values farther away than the
    // window reaches (a gap in the data) are not averaged in.
    function movingAverage(points, window, step) {
        const before = Math.floor((window - 1) / 2);
        const after = window - 1 - before;
        return points.map((p, i) => {
            const slice = [];
            for (let k = Math.max(0, i - before); k <= Math.min(points.length - 1, i + after); k++) {
                const q = points[k];
                if (!isNum(q.y)) continue;
                if (step && (q.x < p.x - (before + 0.5) * step || q.x > p.x + (after + 0.5) * step)) continue;
                slice.push(q.y);
            }
            return { x: p.x, y: slice.length >= Math.ceil(window / 2) ? mean(slice) : null, meta: p.meta };
        });
    }

    // ------------------------------------------------------------- data model

    function currentPeriod() {
        const preset = PERIOD_PRESETS.find((p) => p.id === state.periodId) || PERIOD_PRESETS[0];
        if (preset.id === 'none') return null;
        if (preset.id === 'custom') {
            const a = parseDayMonth(state.custom.start);
            const b = parseDayMonth(state.custom.end);
            if (!a || !b) return { invalid: true };
            return makePeriod(a, b, `${state.custom.start}–${state.custom.end}`);
        }
        return makePeriod(preset.start, preset.end, preset.label.replace(/ \(.*\)$/, ''));
    }

    function makePeriod(start, end, label) {
        const s = mdKey(start[0], start[1]);
        const e = mdKey(end[0], end[1]);
        return { start, end, label, wraps: s > e, s, e };
    }

    // Puts the dot in while typing a DD.MM date: "0106" -> "01.06", "1." -> "01.".
    function formatDayMonthTyping(input, event) {
        const deleting = Boolean(event && event.inputType && event.inputType.startsWith('delete'));
        const raw = input.value;
        const parts = [''];
        for (const ch of raw) {
            const k = parts.length - 1;
            if (/\d/.test(ch)) {
                if (parts[k].length >= 2) {
                    if (k >= 1) continue;
                    parts.push('');
                }
                parts[parts.length - 1] += ch;
            } else if (ch === '.' && k === 0 && parts[0].length > 0) {
                parts[0] = parts[0].padStart(2, '0');
                parts.push('');
            }
        }
        let formatted = parts.join('.');
        if (!deleting && parts.length === 1 && parts[0].length === 2) formatted += '.';
        if (formatted !== raw) {
            input.value = formatted;
            input.setSelectionRange(formatted.length, formatted.length);
        }
    }

    function parseDayMonth(text) {
        const m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(String(text || '').trim());
        if (!m) return null;
        const day = +m[1];
        const month = +m[2];
        if (month < 1 || month > 12 || day < 1) return null;
        if (day > (month === 2 ? 29 : MONTH_DAYS[month - 1])) return null;
        return [month, day];
    }

    function inPeriod(point, period) {
        const k = point.md;
        return period.wraps ? k >= period.s || k <= period.e : k >= period.s && k <= period.e;
    }

    // Year a point counts towards; a period across New Year (Dec–Feb) belongs to the year it ends in.
    function seasonYear(point, period) {
        return period && period.wraps && point.md >= period.s ? point.year + 1 : point.year;
    }

    function seasonYearLabel(year, period) {
        return period && period.wraps ? `${year - 1}/${String(year).slice(-2)}` : String(year);
    }

    function presetPeriod(id, custom) {
        const preset = PERIOD_PRESETS.find((p) => p.id === id);
        if (!preset || preset.id === 'none') return null;
        if (preset.id === 'custom') {
            const a = parseDayMonth(custom.start);
            const b = parseDayMonth(custom.end);
            if (!a || !b) return { invalid: true };
            return makePeriod(a, b, `${custom.start}–${custom.end}`);
        }
        return makePeriod(preset.start, preset.end, preset.label.replace(/ \(.*\)$/, ''));
    }

    function windowColor(w) {
        return WINDOW_COLORS[(state.windows.indexOf(w) % WINDOW_COLORS.length + WINDOW_COLORS.length) % WINDOW_COLORS.length];
    }

    // Rows of the whole series for the analysis tools; x is the decimal year.
    function wholeSeriesRows(model) {
        return model.points
            .map((pt) => ({ year: 1970 + pt.t / (365.2425 * DAY_MS), t: pt.t, label: timeLabel(model, pt.t), mean: transformed(model, pt), complete: true }))
            .filter((row) => isNum(row.mean));
    }

    function yearToTime(x) {
        return (x - 1970) * 365.2425 * DAY_MS;
    }

    // The results of the selected tools only (the analysis runs every available tool).
    function pickTools(results, tools) {
        const out = {};
        for (const t of tools) if (results && results[t]) out[t] = results[t];
        return out;
    }

    // Everything one analysis time frame needs: its per-year rows and the tool results.
    function evaluateWindows(model) {
        const canCompare = model.canCompare && model.years.length >= 2;
        return state.windows.map((w) => {
            const color = windowColor(w);
            const period = w.frame === 'all' ? null : presetPeriod(w.frame, w.custom);
            const base = { w, color, period, tools: state.tools.filter((t) => w.tools.includes(t)) };
            if (period && period.invalid) return { ...base, label: 'Custom period', status: 'Enter the period as DD.MM – DD.MM, e.g. 01.06 – 31.08.', rows: [], allRows: [], years: [] };
            if (period && !canCompare) {
                return { ...base, label: period.label, status: model.canCompare ? 'Needs a time range over at least two years.' : `Needs intervals of up to 2 months; the current interval is ${model.ivText}.`, rows: [], allRows: [], years: [] };
            }
            const label = period ? period.label : 'Whole series';
            if (!period) {
                // Whole series: one analysis over every interval.
                const allRows = wholeSeriesRows(model);
                const rows = allRows;
                let analysis = null;
                let status = null;
                if (!base.tools.length) status = 'No tool selected for this time frame.';
                else if (rows.length < 2) status = 'Needs at least two values.';
                else {
                    // Keyed by every available tool (not the selected ones), so toggling a tool off
                    // reuses the cached results instead of re-running the others.
                    // x is in years; for sub-annual intervals the change-point test and the
                    // autocorrelation corrections leave out the seasonal cycle (season_length 1 year).
                    const seasonLength = model.stepDays < 200 ? 1 : null;
                    const key = JSON.stringify([state.topic, state.tools, seasonLength, rows.map((row) => [row.year, row.mean])]);
                    if (!state.analysisCache.has(key)) requestAnalysis(key, { x: rows.map((row) => row.year), values: rows.map((row) => row.mean), season_length: seasonLength });
                    analysis = state.analysisCache.get(key);
                }
                const results = analysis && !analysis.pending && !analysis.error ? pickTools(analysis.tools, base.tools) : null;
                return { ...base, label, rows, allRows, years: [], analysis, results, status };
            }

            // A period (e.g. January): the tools run inside every year's period on its own,
            // x = days since the period started that year.
            const allRows = periodSeries(model, period);
            const rows = allRows.filter((row) => row.complete);
            const lengthDays = periodLengthDays(period);
            const years = allRows.map((row) => {
                const startT = Date.UTC(period.wraps ? row.year - 1 : row.year, period.start[0] - 1, period.start[1]);
                const pts = model.points
                    .filter((p) => inPeriod(p, period) && seasonYear(p, period) === row.year)
                    .map((p) => ({ t: p.t, pos: p.pos, x: (p.t - startT) / DAY_MS, y: transformed(model, p) }))
                    .filter((q) => isNum(q.y));
                return { ...row, startT, pts, res: null };
            });
            const analysed = years.filter((yr) => yr.complete);
            let analysis = null;
            let status = null;
            if (!base.tools.length) status = 'No tool selected for this time frame.';
            else if (!analysed.length) status = 'No year has enough data in this time frame.';
            else if (analysed.every((yr) => yr.pts.length < 3)) status = `Each ${label} has fewer than three values. Choose a shorter interval (e.g. 1 Day) to analyse inside the period.`;
            else {
                const groups = analysed.map((yr) => ({ key: yr.year, x: yr.pts.map((q) => +q.x.toFixed(3)), values: yr.pts.map((q) => q.y) }));
                const key = JSON.stringify([state.topic, state.tools, 'groups', groups]);
                if (!state.analysisCache.has(key)) requestAnalysis(key, { groups });
                analysis = state.analysisCache.get(key);
                if (analysis && analysis.groups) {
                    const byKey = new Map(analysis.groups.map((g) => [g.key, g.tools]));
                    for (const yr of years) yr.res = byKey.has(yr.year) ? pickTools(byKey.get(yr.year), base.tools) : null;
                }
            }
            const results = analysis && !analysis.pending && !analysis.error ? {} : null;
            // The question most people ask of a period: does it change from year to year?
            // One value per year (the period mean), x = year, so slopes are per year.
            let across = null;
            if (base.tools.length && rows.length >= 3) {
                const acrossKey = JSON.stringify([state.topic, state.tools, 'across', rows.map((row) => [row.year, row.mean])]);
                if (!state.analysisCache.has(acrossKey)) requestAnalysis(acrossKey, { x: rows.map((row) => row.year), values: rows.map((row) => row.mean) });
                across = state.analysisCache.get(acrossKey);
            }
            return { ...base, label, rows, allRows, years, lengthDays, analysis, results, status, across };
        });
    }

    function periodLengthDays(period) {
        const a = yearPos(period.start[0], period.start[1]);
        let b = yearPos(period.end[0], period.end[1]) + 1;
        if (b <= a) b += YEAR_DAYS;
        return b - a;
    }

    // Fitted regression values at a year's points; split where the x position jumps back
    // (a period across New Year on an axis that starts in January).
    function fittedPieces(yr, lr, xOf) {
        const pieces = [];
        let cur = [];
        for (const q of yr.pts) {
            const x = xOf(q);
            if (cur.length && x < cur[cur.length - 1].x) { pieces.push(cur); cur = []; }
            cur.push({ x, y: lr.slope * q.x + lr.intercept });
        }
        if (cur.length) pieces.push(cur);
        return pieces.filter((piece) => piece.length >= 2);
    }

    function buildModel() {
        const info = state.viz && state.viz.topics && state.viz.topics[state.topic];
        if (!info) return null;
        const req = state.request || {};
        const [ivValue, ivUnit] = Array.isArray(req.interval_length) ? req.interval_length : [1, 'Day'];
        const stepDays = (Number(ivValue) || 1) * (INTERVAL_DAYS[ivUnit] || 1);
        const range = Array.isArray(req.timeintervall) ? req.timeintervall.map(parseDdMmYyyy) : [null, null];

        const labels = Array.isArray(info.labels) ? info.labels : [];
        const values = Array.isArray(info.values) ? info.values : [];
        const points = [];
        labels.forEach((label, i) => {
            const start = parseDdMmYyyy(label);
            const value = values[i];
            if (start === null || !isNum(value)) return;
            // The interval's midpoint decides which month/day of the year a value belongs to.
            let t = start + (stepDays * DAY_MS) / 2;
            if (range[1] !== null) t = Math.min(t, range[1] + DAY_MS - 1);
            if (stepDays <= 1) t = start + DAY_MS / 2;
            const d = new Date(t);
            const month = d.getUTCMonth() + 1;
            const day = d.getUTCDate();
            points.push({ t, start, label, value, year: d.getUTCFullYear(), month, day, md: mdKey(month, day), pos: yearPos(month, day) + 0.5 });
        });
        points.sort((a, b) => a.t - b.t);

        const monthly = stepDays >= 20;
        const bucketOf = (p) => (monthly ? p.month - 1 : Math.min(YEAR_DAYS - 1, Math.floor(p.pos)));
        const bucketPos = (b) => (monthly ? MONTH_START[b] + MONTH_DAYS[b] / 2 : b + 0.5);
        const groups = new Map();
        for (const p of points) {
            const b = bucketOf(p);
            if (!groups.has(b)) groups.set(b, []);
            groups.get(b).push(p.value);
        }
        const clim = new Map();
        // `exact` is the plain mean of this bucket's values (never smoothed), so the anomalies of
        // each bucket – and therefore of the whole series – average to exactly zero.
        for (const [b, vals] of groups) clim.set(b, { mean: mean(vals), exact: mean(vals), sd: stdDev(vals), n: vals.length });
        // Intervals of several days land on drifting days of the year, so each day bucket
        // holds values of only some years: smooth over at least two intervals.
        const smoothWindow = Math.max(CLIM_SMOOTH_DAYS, 2 * Math.ceil(stepDays) + 1);
        if (!monthly) smoothClimatology(clim, smoothWindow);

        const years = [...new Set(points.map((p) => p.year))].sort((a, b) => a - b);
        const domain = [
            range[0] ?? (points.length ? points[0].start : 0),
            (range[1] ?? (points.length ? points[points.length - 1].t : 0)) + DAY_MS,
        ];
        const tools = req.tools && typeof req.tools === 'object'
            ? Object.keys(req.tools).filter((k) => req.tools[k])
            : [];

        return {
            info, points, stepDays, monthly, bucketOf, bucketPos, clim, years, domain,
            unit: info.unit || '',
            ivText: `${fmt(Number(ivValue), 2)} ${ivUnit}${Number(ivValue) === 1 ? '' : 's'}`,
            tools,
            canCompare: stepDays <= MAX_OVERLAY_STEP_DAYS,
            // Anomalies need several years and a seasonal resolution; the exact bucket mean
            // only works where every year hits the same buckets (daily or calendar months).
            anomalyOk: stepDays <= MAX_OVERLAY_STEP_DAYS && years.length >= 2,
            exactBuckets: monthly || stepDays <= 1,
            smoothWindow,
        };
    }

    // Daily means of only a few years are noisy; average them over a circular window
    // of neighbouring days (the usual way to build a daily climatology).
    function smoothClimatology(clim, window) {
        const half = Math.floor(window / 2);
        const raw = new Map([...clim.entries()].map(([b, c]) => [b, { ...c }]));
        for (const b of clim.keys()) {
            const means = [];
            const sds = [];
            for (let k = -half; k <= half; k++) {
                const c = raw.get((b + k + YEAR_DAYS) % YEAR_DAYS);
                if (!c) continue;
                if (isNum(c.mean)) means.push(c.mean);
                if (isNum(c.sd)) sds.push(c.sd);
            }
            clim.set(b, { ...raw.get(b), mean: mean(means), sd: sds.length ? mean(sds) : null });
        }
    }

    // Value after the "anomaly" function: deviation from the multi-year mean of the same time of year.
    function transformed(model, p) {
        if (!state.fn.anomaly || !model.anomalyOk) return p.value;
        const c = model.clim.get(model.bucketOf(p));
        if (!c) return null;
        // Multi-day intervals: the smoothed normal (the exact bucket mean of 1–3 values
        // would swallow most of a trend).
        const normal = model.exactBuckets ? c.exact : c.mean;
        return isNum(normal) ? p.value - normal : null;
    }

    function yearColor(model, year) {
        const n = model.years.length;
        const i = model.years.indexOf(year);
        if (n <= 1) return YEAR_RAMP[YEAR_RAMP.length - 3];
        // Spread over the ramp; few years use the darker, more readable part.
        const lo = n <= 3 ? 4 : n <= 6 ? 2 : 0;
        return YEAR_RAMP[Math.round(lo + (i * (YEAR_RAMP.length - 1 - lo)) / (n - 1))];
    }

    function timeLabel(model, t) {
        const d = new Date(t);
        const mon = MONTHS[d.getUTCMonth()];
        return model.monthly ? `${mon} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
    }

    // --------------------------------------------------------------- views

    function timeTicks(domain) {
        return (plotW, shown = domain) => {
            const [a, b] = shown;
            const spanYears = (b - a) / (YEAR_DAYS * DAY_MS);
            const startYear = new Date(a).getUTCFullYear();
            const endYear = new Date(b).getUTCFullYear();
            const ticks = [];
            const spanDays = (b - a) / DAY_MS;
            if (spanDays <= 90) {
                // Zoomed in to a few weeks: day ticks, with the month named at its first tick.
                const every = [1, 2, 5, 7, 10, 15].find((k) => spanDays / k <= Math.max(2, Math.floor(plotW / 62))) || 15;
                let lastMonth = -1;
                for (let t = Math.ceil(a / DAY_MS) * DAY_MS; t <= b; t += DAY_MS) {
                    const d = new Date(t);
                    const day = d.getUTCDate();
                    // Every 7 days: Mondays. Otherwise days 1, 1+k, …; skip 29–31 so they don't crowd the 1st.
                    if (every === 7 ? d.getUTCDay() !== 1 : (day - 1) % every !== 0 || (every > 1 && day > 28)) continue;
                    const m = d.getUTCMonth();
                    ticks.push({ v: t, label: m !== lastMonth ? `${day} ${MONTHS[m]}${m === 0 || lastMonth < 0 ? ` ${d.getUTCFullYear()}` : ''}` : String(day) });
                    lastMonth = m;
                }
                return ticks;
            }
            if (spanYears > 2.5) {
                const every = Math.max(1, Math.ceil((endYear - startYear + 1) / Math.max(2, Math.floor(plotW / 56))));
                for (let y = startYear; y <= endYear + 1; y++) {
                    if ((y - startYear) % every) continue;
                    const t = Date.UTC(y, 0, 1);
                    if (t >= a && t <= b) ticks.push({ v: t, label: String(y) });
                }
            } else {
                const months = Math.round(spanYears * 12) + 2;
                const every = [1, 2, 3, 4, 6, 12].find((k) => months / k <= Math.max(2, Math.floor(plotW / 62))) || 12;
                const d0 = new Date(a);
                for (let k = 0; k <= months + 1; k++) {
                    const y = d0.getUTCFullYear() + Math.floor((d0.getUTCMonth() + k) / 12);
                    const m = (d0.getUTCMonth() + k) % 12;
                    if (m % every) continue;
                    const t = Date.UTC(y, m, 1);
                    if (t >= a && t <= b) ticks.push({ v: t, label: m === 0 || ticks.length === 0 ? `${MONTHS[m]} ${y}` : MONTHS[m] });
                }
            }
            return ticks;
        };
    }

    function seasonTicks(offset, fullDomain) {
        return (plotW, domain = fullDomain) => {
            const every = plotW / 12 < 34 ? 2 : 1;
            const ticks = [];
            for (let i = 0; i < 12; i++) {
                const x = (MONTH_START[i] - offset + YEAR_DAYS) % YEAR_DAYS;
                if (x < domain[0] - 0.01 || x > domain[1] + 0.01) continue;
                ticks.push({ v: x, label: MONTHS[i], month: i });
            }
            ticks.sort((p, q) => p.v - q.v);
            // Thin out evenly when crowded; when zoomed add day ticks inside a short period.
            const out = ticks.filter((_, i) => i % every === 0);
            if (domain[1] - domain[0] <= 62) {
                for (let x = Math.ceil(domain[0]); x <= domain[1]; x++) {
                    const abs = (x + offset) % YEAR_DAYS;
                    const m = MONTH_START.findIndex((s, i) => abs >= s && abs < s + MONTH_DAYS[i]);
                    const day = abs - MONTH_START[m] + 1;
                    if ((day === 10 || day === 20) && plotW > 360) out.push({ v: x, label: `${day} ${MONTHS[m]}` });
                }
                out.sort((p, q) => p.v - q.v);
            }
            return out;
        };
    }

    function seasonPosLabel(offset, x) {
        const abs = ((Math.floor(x) + offset) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
        const m = MONTH_START.findIndex((s, i) => abs >= s && abs < s + MONTH_DAYS[i]);
        return `${abs - MONTH_START[m] + 1} ${MONTHS[m]}`;
    }

    // ------------------------------------------------------------ events

    function isoToTime(iso) {
        const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
        return Date.UTC(y, m - 1, d);
    }

    function fmtIsoDate(iso) {
        const t = isoToTime(iso);
        if (!isNum(t)) return String(iso);
        const d = new Date(t);
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }

    // The notable events of the shown topic (events.py), numbered in their order of importance.
    function eventsOf(model) {
        const list = Array.isArray(model.info.events) ? model.info.events : [];
        return list.map((ev, i) => ({ ...ev, n: i + 1, style: EVENT_STYLE[ev.kind] || EVENT_STYLE.high }));
    }

    // Event markers and spell bands for the timeline, placed on the plotted value of the event's interval.
    function eventMarks(model, pts) {
        const marks = [];
        const bands = [];
        for (const ev of eventsOf(model)) {
            const at = isoToTime(ev.peak_date || ev.date) + DAY_MS / 2;
            let best = null;
            for (const p of pts) {
                if (!isNum(p.y) || p.meta.start > at || p.meta.start + model.stepDays * DAY_MS <= at - DAY_MS / 2) continue;
                if (!best || Math.abs(p.x - at) < Math.abs(best.x - at)) best = p;
            }
            if (best) marks.push({ x: best.x, y: best.y, n: ev.n, color: ev.style.color, active: state.activeEvent === ev.n, title: `${ev.title}: ${fmtIsoDate(ev.date)}` });
            if (ev.end) {
                bands.push({ x0: isoToTime(ev.date), x1: isoToTime(ev.end) + DAY_MS, fill: ev.kind === 'cold_spell' ? 'rgba(2, 132, 199, 0.13)' : 'rgba(220, 38, 38, 0.11)' });
            }
        }
        return { marks, bands };
    }

    function buildTimeline(model, period, wins) {
        const series = [];
        const legend = [];
        const unit = model.unit;
        const pts = model.points.map((p) => ({ x: p.t, y: transformed(model, p), meta: p }));
        const gap = model.stepDays * DAY_MS * 1.6;
        const markers = pts.length <= 120;

        const bands = [];
        if (period && !period.invalid) {
            const [sm, sd] = period.start;
            const [em, ed] = period.end;
            const y0 = new Date(model.domain[0]).getUTCFullYear() - 1;
            const y1 = new Date(model.domain[1]).getUTCFullYear();
            for (let y = y0; y <= y1; y++) {
                const endYear = period.wraps ? y + 1 : y;
                const lastDay = Math.min(ed, new Date(Date.UTC(endYear, em, 0)).getUTCDate());
                const x0 = Math.max(model.domain[0], Date.UTC(y, sm - 1, Math.min(sd, new Date(Date.UTC(y, sm, 0)).getUTCDate())));
                const x1 = Math.min(model.domain[1], Date.UTC(endYear, em - 1, lastDay) + DAY_MS);
                if (x1 > x0) bands.push({ x0, x1, fill: COLOR.accentWash });
            }
        }

        if (state.fn.clim && model.years.length >= 2) {
            const climPts = model.points.map((p) => {
                const c = model.clim.get(model.bucketOf(p));
                const m = state.fn.anomaly ? 0 : c.mean;
                return { x: p.t, y: m, lo: isNum(c.sd) ? m - c.sd : null, hi: isNum(c.sd) ? m + c.sd : null };
            });
            series.push({ id: 'band', kind: 'area', name: 'Multi-year ±1σ', color: COLOR.referenceBand, points: climPts, gap, hover: false });
            series.push({ id: 'clim', kind: 'line', name: state.fn.anomaly ? 'Multi-year mean (0)' : 'Multi-year mean', color: COLOR.reference, width: 1.5, dash: '2,3', points: climPts, gap });
            legend.push({ name: `Multi-year mean ± 1σ (same time of year${model.monthly ? '' : `, ${model.smoothWindow}-day window`})`, color: COLOR.reference, style: 'band' });
        }

        series.push({
            id: 'values', kind: 'line', name: state.fn.anomaly ? 'Anomaly' : 'Value', color: COLOR.series, width: 2,
            points: pts, gap, markers: markers ? 3 : 0,
            emphasize: period && !period.invalid ? (p) => inPeriod(p.meta, period) : null,
        });
        legend.unshift({ name: state.fn.anomaly ? `${model.info.variables?.length ? 'Anomaly of interval mean' : 'Anomaly'}` : 'Interval mean', color: COLOR.series, style: 'line' });
        if (period && !period.invalid) legend.push({ name: `${period.label} (highlighted)`, color: COLOR.accent, style: 'dot' });

        if (state.fn.ma) {
            const w = state.fn.maWindow;
            series.push({ id: 'ma', kind: 'line', name: `Moving average (${w})`, color: COLOR.movingAverage, width: 2, points: movingAverage(pts, w, model.stepDays * DAY_MS), gap });
            legend.push({ name: `Moving average over ${w} intervals`, color: COLOR.movingAverage, style: 'line' });
        }

        // Analysis time frames: a period's regression is drawn inside every year's period on its own;
        // the whole series gets one line (and the early / late means of its t-Test).
        for (const win of wins || []) {
            const res = win.results || {};
            if (win.period) {
                let drawn = 0;
                for (const yr of win.years) {
                    const lr = yr.res && yr.res['Linear Regression'];
                    if (!lr || !lr.available) continue;
                    for (const piece of fittedPieces(yr, lr, (q) => q.t)) {
                        series.push({ id: `win${win.w.id}-${yr.year}-${drawn}`, kind: 'line', name: `${win.label} ${yr.label}: linear regression`, color: win.color, width: 2.5, points: piece, hover: false });
                        drawn += 1;
                    }
                }
                if (drawn) legend.push({ name: `${win.label}: linear regression inside each year`, color: win.color, style: 'line' });
                continue;
            }
            if (!win.rows.length) continue;
            const lr = res['Linear Regression'];
            const tt = res['t-Test'];
            const first = win.rows[0];
            const last = win.rows[win.rows.length - 1];
            if (lr && lr.available) {
                series.push({
                    id: `win${win.w.id}-lr`, kind: 'line', name: `${win.label}: linear regression`, color: win.color, width: 2, dash: '6,4',
                    points: [first, last].map((row) => ({ x: row.t, y: lr.slope * row.year + lr.intercept })), hover: false,
                });
                legend.push({ name: `${win.label}: linear regression (${withUnit(fmtSigned(lr.slope), unit)} per year)`, color: win.color, style: 'dash' });
            }
            if (tt && tt.available) {
                const split = win.rows.find((row) => row.year === tt.split_x) || win.rows[Math.floor(win.rows.length / 2)];
                const splitT = isNum(split.t) ? split.t : yearToTime(tt.split_x);
                series.push({ id: `win${win.w.id}-tt1`, kind: 'line', name: `${win.label}: early mean`, color: win.color, width: 2.5, dash: '1,3', points: [{ x: first.t, y: tt.early_mean }, { x: splitT, y: tt.early_mean }], hover: false });
                series.push({ id: `win${win.w.id}-tt2`, kind: 'line', name: `${win.label}: late mean`, color: win.color, width: 2.5, dash: '1,3', points: [{ x: splitT, y: tt.late_mean }, { x: last.t, y: tt.late_mean }], hover: false });
                legend.push({ name: `${win.label}: t-Test early vs. late mean (${withUnit(fmtSigned(tt.late_mean - tt.early_mean), unit)})`, color: win.color, style: 'dash' });
            }
        }

        const ev = eventMarks(model, pts);
        if (ev.marks.length) legend.push({ name: 'Notable events (numbered, see list below the plot)', color: EVENT_STYLE.record_high.color, style: 'hollow' });
        return {
            kind: 'time',
            xDomain: model.domain,
            xTicks: timeTicks(model.domain),
            formatX: (x) => timeLabel(model, x),
            series, bands: bands.concat(ev.bands), legend, unit,
            eventMarks: ev.marks,
            yInclude: state.fn.anomaly ? [0] : [],
            tooltipExtra: (row) => (row.meta && row.meta.label ? `interval from ${row.meta.label}` : ''),
            table: tableFrom(['Interval start', 'Mid date', state.fn.anomaly ? `Anomaly${unit ? ` (${unit})` : ''}` : `Value${unit ? ` (${unit})` : ''}`, 'In period'],
                pts.map((p) => [p.meta.label, ddmmyyyy(p.x), p.y, period && !period.invalid ? (inPeriod(p.meta, period) ? 'yes' : '') : ''])),
        };
    }

    function buildOverlay(model, period, wins) {
        const unit = model.unit;
        const usePeriod = period && !period.invalid ? period : null;
        const offset = usePeriod && usePeriod.wraps ? yearPos(usePeriod.start[0], usePeriod.start[1]) : 0;
        const xOf = (pos) => ((pos - offset) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
        let domain = [0, YEAR_DAYS];
        if (usePeriod && state.fn.zoom) {
            const a = xOf(yearPos(usePeriod.start[0], usePeriod.start[1]));
            const b = xOf(yearPos(usePeriod.end[0], usePeriod.end[1])) + 1;
            domain = [a, b > a ? b : b + YEAR_DAYS];
        }
        const inDomain = (x) => x >= domain[0] - 0.5 && x <= domain[1] + 0.5;
        const gap = Math.max(1.6, model.stepDays * 1.6);

        const byYear = new Map();
        for (const p of model.points) {
            const sy = seasonYear(p, usePeriod);
            if (!byYear.has(sy)) byYear.set(sy, []);
            byYear.get(sy).push({ x: xOf(p.pos), y: transformed(model, p), meta: p });
        }
        const allYears = [...byYear.keys()].sort((a, b) => a - b);
        const colorModel = { years: allYears };
        const visibleYears = allYears.filter((y) => !state.hiddenYears.has(y));
        const latest = visibleYears[visibleYears.length - 1];

        const series = [];
        const bands = [];
        if (usePeriod && !state.fn.zoom) {
            const a = xOf(yearPos(usePeriod.start[0], usePeriod.start[1]));
            const b = xOf(yearPos(usePeriod.end[0], usePeriod.end[1])) + 1;
            bands.push({ x0: a, x1: b > a ? b : b + YEAR_DAYS, fill: COLOR.accentWash });
        }

        if (state.fn.clim && model.years.length >= 2) {
            const climPts = [...model.clim.entries()]
                .map(([b, c]) => {
                    const m = state.fn.anomaly ? 0 : c.mean;
                    return { x: xOf(model.bucketPos(b)), y: m, lo: isNum(c.sd) ? m - c.sd : null, hi: isNum(c.sd) ? m + c.sd : null };
                })
                .sort((p, q) => p.x - q.x)
                .filter((p) => inDomain(p.x));
            series.push({ id: 'band', kind: 'area', name: 'Multi-year ±1σ', color: COLOR.referenceBand, points: climPts, gap: gap * 2, hover: false });
            series.push({ id: 'clim', kind: 'line', name: 'Multi-year mean', color: COLOR.reference, width: 2, dash: '2,3', points: climPts, gap: gap * 2 });
        }

        for (const y of visibleYears) {
            let pts = byYear.get(y).sort((p, q) => p.x - q.x).filter((p) => inDomain(p.x));
            if (state.fn.ma) pts = movingAverage(pts, state.fn.maWindow, model.stepDays);
            const isLatest = y === latest;
            series.push({
                id: `y${y}`, kind: 'line', name: seasonYearLabel(y, usePeriod), color: yearColor(colorModel, y),
                width: isLatest ? 2.5 : 1.5, points: pts, gap,
                markers: pts.length <= 40 ? (isLatest ? 3.5 : 2.5) : 0,
                directLabel: visibleYears.length <= 4 ? seasonYearLabel(y, usePeriod) : null,
            });
        }

        // Each year's regression inside every analysis period, in that year's colour.
        for (const win of wins || []) {
            if (!win.period) continue;
            let drawn = 0;
            for (const yr of win.years) {
                const lr = yr.res && yr.res['Linear Regression'];
                if (!lr || !lr.available) continue;
                // Years are keyed by the highlight period's season year; a point decides which line it belongs to.
                const lineYear = yr.pts.length ? seasonYear(model.points.find((p) => p.t === yr.pts[0].t), usePeriod) : yr.year;
                if (state.hiddenYears.has(lineYear)) continue;
                for (const piece of fittedPieces(yr, lr, (q) => xOf(q.pos))) {
                    series.push({ id: `win${win.w.id}-${yr.year}-${drawn}`, kind: 'line', name: `${win.label} ${yr.label}: regression`, color: yearColor(colorModel, lineYear), width: 2.5, dash: '6,3', points: piece.filter((q) => inDomain(q.x)), hover: false });
                    drawn += 1;
                }
            }
        }

        const legend = allYears.map((y) => ({
            name: seasonYearLabel(y, usePeriod), color: yearColor(colorModel, y), style: 'line', toggleYear: y,
            pressed: !state.hiddenYears.has(y),
        }));
        if (state.fn.clim && model.years.length >= 2) legend.push({ name: `Multi-year mean ± 1σ${model.monthly ? '' : ` (${CLIM_SMOOTH_DAYS}-day window)`}`, color: COLOR.reference, style: 'band' });
        if (usePeriod && !state.fn.zoom) legend.push({ name: `${usePeriod.label} (highlighted)`, color: COLOR.accent, style: 'band-accent' });
        if ((wins || []).some((win) => win.period && win.years.some((yr) => yr.res && yr.res['Linear Regression'] && yr.res['Linear Regression'].available))) {
            legend.push({ name: 'Dashed: linear regression inside each year\u2019s analysis period (colour of the year)', color: COLOR.reference, style: 'dash' });
        }

        // Table: one row per position in the year, one column per year.
        const xs = [...new Set(series.filter((s) => s.id.startsWith('y')).flatMap((s) => s.points.map((p) => Math.round(p.x * 10) / 10)))].sort((a, b) => a - b);
        const cols = visibleYears.map((y) => {
            const m = new Map(series.find((s) => s.id === `y${y}`).points.map((p) => [Math.round(p.x * 10) / 10, p.y]));
            return m;
        });

        return {
            kind: 'season',
            xDomain: domain,
            xTicks: seasonTicks(offset, domain),
            formatX: (x) => (model.monthly ? MONTHS[MONTH_START.findIndex((s, i) => {
                const abs = ((Math.floor(x) + offset) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
                return abs >= s && abs < s + MONTH_DAYS[i];
            })] : seasonPosLabel(offset, x)),
            series, bands, legend, unit,
            sortTooltip: true,
            yInclude: state.fn.anomaly ? [0] : [],
            tooltipExtra: (row) => (row.meta && row.meta.label ? row.meta.label : ''),
            table: tableFrom(['Time of year', ...visibleYears.map((y) => seasonYearLabel(y, usePeriod))],
                xs.map((x) => [seasonPosLabel(offset, x), ...cols.map((m) => m.get(x) ?? null)])),
        };
    }

    // One value per (season) year: mean, min, max and coverage of the period.
    // One row per year (season year for periods across New Year): the period's mean.
    // With several years the mean is "normal of the period + mean anomaly of the values
    // present", so a year missing part of the period (e.g. a range ending in July) is not
    // pulled towards the season it happens to cover.
    function periodSeries(model, period) {
        const normalOf = (p) => {
            if (!model.anomalyOk) return null;
            const c = model.clim.get(model.bucketOf(p));
            const normal = c ? (model.exactBuckets ? c.exact : c.mean) : null;
            return isNum(normal) ? normal : null;
        };
        const groups = new Map();
        const allNormals = [];
        for (const p of model.points) {
            if (!inPeriod(p, period)) continue;
            const sy = seasonYear(p, period);
            if (!groups.has(sy)) groups.set(sy, []);
            const normal = normalOf(p);
            groups.get(sy).push({ v: transformed(model, p), raw: p.value, normal, t: p.t });
            if (isNum(normal)) allNormals.push(normal);
        }
        // Mean normal over the whole period (every day of it, as seen across all years).
        const periodNormal = allNormals.length ? mean(allNormals) : null;
        const startPos = yearPos(period.start[0], period.start[1]);
        let endPos = yearPos(period.end[0], period.end[1]) + 1;
        if (endPos <= startPos) endPos += YEAR_DAYS;
        const expected = Math.max(1, Math.round((endPos - startPos) / model.stepDays));
        return [...groups.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([year, items]) => {
                const valid = items.filter((it) => isNum(it.v));
                const v = valid.map((it) => it.v);
                let periodMean = mean(v);
                const withNormal = valid.filter((it) => isNum(it.normal));
                if (isNum(periodNormal) && withNormal.length === valid.length && valid.length) {
                    const anomaly = mean(withNormal.map((it) => it.raw - it.normal));
                    periodMean = state.fn.anomaly && model.anomalyOk ? anomaly : periodNormal + anomaly;
                }
                return {
                    year, label: seasonYearLabel(year, period), n: v.length, expected,
                    t: mean(valid.map((it) => it.t)),
                    complete: v.length >= Math.max(1, Math.floor(expected * 0.5)),
                    mean: periodMean, min: v.length ? v.reduce((a, b) => Math.min(a, b)) : null, max: v.length ? v.reduce((a, b) => Math.max(a, b)) : null,
                };
            })
            .filter((r) => r.n > 0);
    }

    function buildPeriod(model, period, analysis, color) {
        const unit = model.unit;
        const rows = periodSeries(model, period);
        const series = [];
        const legend = [];
        const used = rows.filter((r) => r.complete);
        const overall = mean(used.map((r) => r.mean));
        const sd = stdDev(used.map((r) => r.mean));
        const years = rows.map((r) => r.year);
        const domain = years.length ? [years[0] - 0.6, years[years.length - 1] + 0.6] : [0, 1];

        if (isNum(overall)) {
            const flat = [{ x: domain[0], y: overall, lo: isNum(sd) && state.fn.clim ? overall - sd : null, hi: isNum(sd) && state.fn.clim ? overall + sd : null }, { x: domain[1], y: overall, lo: isNum(sd) && state.fn.clim ? overall - sd : null, hi: isNum(sd) && state.fn.clim ? overall + sd : null }];
            if (state.fn.clim && isNum(sd)) series.push({ id: 'band', kind: 'area', name: '±1σ', color: COLOR.referenceBand, points: flat, hover: false });
            series.push({ id: 'mean', kind: 'line', name: 'Mean of all years', color: COLOR.reference, width: 1.5, dash: '2,3', points: flat, hover: false });
            legend.push({ name: `Mean of all years (${withUnit(fmt(overall), unit)})${state.fn.clim ? ' ± 1σ' : ''}`, color: COLOR.reference, style: state.fn.clim ? 'band' : 'dash' });
        }

        series.push({
            id: 'range', kind: 'whisker', name: 'Min – max in period', color: COLOR.whisker, width: 3,
            points: rows.map((r) => ({ x: r.year, y: r.mean, lo: r.min, hi: r.max })), hover: false,
        });
        series.push({
            id: 'periodMean', kind: 'line', name: `${period.label} mean`, color: COLOR.series, width: 1.5,
            points: rows.map((r) => ({ x: r.year, y: r.mean, meta: r })), gap: 1.5, markers: 4.5,
            hollow: (p) => !p.meta.complete,
        });
        legend.unshift({ name: `${period.label} mean per year`, color: COLOR.series, style: 'dot' }, { name: 'Min – max within the period', color: COLOR.whisker, style: 'line' });
        if (rows.some((r) => !r.complete)) legend.push({ name: 'Incomplete year (less than half of the period has data; not analysed)', color: COLOR.series, style: 'hollow' });

        if (state.fn.ma) {
            series.push({ id: 'ma', kind: 'line', name: `Moving average (${state.fn.maWindow} years)`, color: COLOR.movingAverage, width: 2, points: movingAverage(used.map((r) => ({ x: r.year, y: r.mean })), state.fn.maWindow, 1), gap: 1.5 });
            legend.push({ name: `Moving average over ${state.fn.maWindow} years`, color: COLOR.movingAverage, style: 'line' });
        }

        const lr = analysis && analysis.tools && analysis.tools['Linear Regression'];
        if (lr && lr.available && used.length >= 2) {
            const xs = [used[0].year, used[used.length - 1].year];
            series.push({ id: 'trend', kind: 'line', name: 'Linear regression', color: color || COLOR.reference, width: 2, dash: '6,4', points: xs.map((x) => ({ x, y: lr.slope * x + lr.intercept })), hover: false });
            legend.push({ name: `Linear regression (${withUnit(fmtSigned(lr.slope), unit)} per year)`, color: color || COLOR.reference, style: 'dash' });
        }
        const tt = analysis && analysis.tools && analysis.tools['t-Test'];
        if (tt && tt.available && used.length >= 4) {
            const split = tt.split_x;
            series.push({ id: 'early', kind: 'line', name: 'Early mean (t-Test)', color: color || COLOR.accent, width: 2, dash: '1,3', points: [{ x: used[0].year - 0.3, y: tt.early_mean }, { x: split - 0.5, y: tt.early_mean }], hover: false });
            series.push({ id: 'late', kind: 'line', name: 'Late mean (t-Test)', color: color || COLOR.accent, width: 2, dash: '1,3', points: [{ x: split - 0.5, y: tt.late_mean }, { x: used[used.length - 1].year + 0.3, y: tt.late_mean }], hover: false });
            legend.push({ name: 't-Test: mean of the early vs. late years', color: color || COLOR.accent, style: 'dash' });
        }

        return {
            kind: 'year',
            xDomain: domain,
            xTicks: (plotW, shown = domain) => {
                const visible = rows.filter((r) => r.year >= shown[0] - 0.01 && r.year <= shown[1] + 0.01);
                const every = Math.max(1, Math.ceil(visible.length / Math.max(2, Math.floor(plotW / (period.wraps ? 58 : 44)))));
                return visible.filter((_, i) => i % every === 0).map((r) => ({ v: r.year, label: r.label }));
            },
            formatX: (x) => {
                const r = rows.find((q) => q.year === Math.round(x));
                return r ? `${period.label} ${r.label}` : String(Math.round(x));
            },
            series, bands: [], legend, unit,
            yInclude: state.fn.anomaly ? [0] : [],
            tooltipExtra: (row) => (row.meta ? `min ${fmt(row.meta.min)} · max ${fmt(row.meta.max)} · ${row.meta.n}/${row.meta.expected} intervals${row.meta.complete ? '' : ' (incomplete)'}` : ''),
            rows, used, overall, sd,
            table: tableFrom(['Year', `Mean${unit ? ` (${unit})` : ''}`, 'Min', 'Max', 'Intervals', 'Complete'],
                rows.map((r) => [r.label, r.mean, r.min, r.max, `${r.n}/${r.expected}`, r.complete ? 'yes' : 'no'])),
        };
    }

    // Several analysis time frames on one year axis: one line per time frame with its tool results.
    function buildPeriodMulti(model, wins) {
        const unit = model.unit;
        const series = [];
        const legend = [];
        const years = [...new Set(wins.flatMap((win) => win.allRows.map((row) => row.year)))].sort((a, b) => a - b);
        const domain = years.length ? [years[0] - 0.6, years[years.length - 1] + 0.6] : [0, 1];
        for (const win of wins) {
            series.push({
                id: `win${win.w.id}`, kind: 'line', name: `${win.label} mean`, color: win.color, width: 1.8,
                points: win.allRows.map((row) => ({ x: row.year, y: row.mean, meta: { ...row, win: win.label } })), gap: 1.5, markers: 4.5,
                hollow: (q) => !q.meta.complete,
            });
            legend.push({ name: `${win.label} mean per year`, color: win.color, style: 'dot' });
        }
        if (wins.some((win) => win.allRows.some((row) => !row.complete))) legend.push({ name: 'Incomplete year (less than half of the period has data; not analysed)', color: COLOR.series, style: 'hollow' });
        const byYear = wins.map((win) => new Map(win.allRows.map((row) => [row.year, row.mean])));
        return {
            kind: 'year',
            xDomain: domain,
            xTicks: (plotW, shown = domain) => {
                const visible = years.filter((y) => y >= shown[0] - 0.01 && y <= shown[1] + 0.01);
                const every = Math.max(1, Math.ceil(visible.length / Math.max(2, Math.floor(plotW / 44))));
                return visible.filter((_, i) => i % every === 0).map((y) => ({ v: y, label: String(y) }));
            },
            formatX: (x) => String(Math.round(x)),
            series, bands: [], legend, unit,
            yInclude: state.fn.anomaly ? [0] : [],
            tooltipExtra: (row) => (row.meta && row.meta.win ? `${row.meta.win} ${row.meta.label}: ${row.meta.n}/${row.meta.expected} intervals${row.meta.complete ? '' : ' (incomplete)'}` : ''),
            table: tableFrom(['Year', ...wins.map((win) => `${win.label} mean${unit ? ` (${unit})` : ''}`)],
                years.map((y) => [String(y), ...byYear.map((m) => m.get(y) ?? null)])),
        };
    }

    function tableFrom(columns, rows) {
        return { columns, rows };
    }

    // ------------------------------------------------------------- renderer

    function renderChart(host, spec) {
        host._spec = spec;
        host._w = 0;
        layoutChart(host);
    }

    function layoutChart(host) {
        const spec = host._spec;
        if (!spec) return;
        const width = Math.max(300, Math.floor(host.clientWidth));
        if (width === host._w) return;
        host._w = width;
        const { svg, geom } = svgFor(spec, width);
        const reset = spec.zoomed && geom
            ? `<button type="button" class="tp-zoom-reset" title="Show the whole time range (or double-click the plot)">Reset zoom</button>`
            : '';
        const scroll = spec.zoomed && geom && spec.fullDomain ? scrollbarHtml(spec, geom) : '';
        host.innerHTML = `${svg}${scroll}${reset}<div class="tp-tooltip" hidden></div>`;
        const btn = host.querySelector('.tp-zoom-reset');
        if (btn) btn.addEventListener('click', () => host._onZoom && host._onZoom(null));
        attachHover(host, spec, geom);
        if (scroll) attachScrollbar(host, spec, geom);
        if (!host._wheelBound) {
            host._wheelBound = true;
            // Horizontal scrolling (trackpad swipe or Shift + wheel) pans a zoomed plot.
            host.addEventListener('wheel', (evt) => {
                const sp = host._spec;
                if (!sp || !sp.zoomed || !sp.fullDomain || !host._geom) return;
                const delta = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? evt.deltaX : evt.shiftKey ? evt.deltaY : 0;
                if (!delta) return;
                evt.preventDefault();
                const span = sp.xDomain[1] - sp.xDomain[0];
                panTo(host, sp.xDomain[0] + (delta / host._geom.plotW) * span);
            }, { passive: false });
        }
    }

    // ------------------------------------------------------------ scrollbar

    function clampDomainStart(spec, start) {
        const [f0, f1] = spec.fullDomain;
        const span = spec.xDomain[1] - spec.xDomain[0];
        return Math.min(Math.max(start, f0), f1 - span);
    }

    // Moves the visible window of a zoomed plot so that it starts at `start` (same width).
    function panTo(host, start) {
        const spec = host._spec;
        if (!spec || !spec.fullDomain) return;
        const span = spec.xDomain[1] - spec.xDomain[0];
        const a = clampDomainStart(spec, start);
        if (Math.abs(a - spec.xDomain[0]) < 1e-9) return;
        host._pending = [a, a + span];
        if (host._raf) return;
        host._raf = requestAnimationFrame(() => {
            host._raf = null;
            const domain = host._pending;
            if (host._onPan) host._onPan(domain);
            host._spec.xDomain = domain;
            host._w = 0;
            layoutChart(host);
        });
    }

    function scrollbarHtml(spec, geom) {
        const [f0, f1] = spec.fullDomain;
        const full = f1 - f0 || 1;
        const [a, b] = spec.xDomain;
        const left = Math.max(0, (a - f0) / full) * 100;
        const width = Math.max(2, Math.min(100, ((b - a) / full) * 100));
        return `<div class="tp-scroll" style="margin-left:${geom.left}px;width:${geom.plotW}px" title="Drag to scroll the zoomed plot · Shift + wheel or swipe also scroll">`
            + `<div class="tp-scroll-thumb" tabindex="0" role="scrollbar" aria-orientation="horizontal" aria-label="Scroll the zoomed plot" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(left)}" style="left:${left}%;width:${width}%"></div></div>`;
    }

    function attachScrollbar(host, spec, geom) {
        host._geom = geom;
        const track = host.querySelector('.tp-scroll');
        const thumb = host.querySelector('.tp-scroll-thumb');
        if (!track || !thumb) return;
        const [f0, f1] = spec.fullDomain;
        const perPx = (f1 - f0) / geom.plotW;
        // Dragging keeps working although the chart (and this thumb) is redrawn on every move.
        thumb.addEventListener('pointerdown', (evt) => {
            if (evt.button !== 0) return;
            evt.preventDefault();
            evt.stopPropagation();
            const startX = evt.clientX;
            const startA = host._spec.xDomain[0];
            host.classList.add('is-scrolling');
            const move = (e) => panTo(host, startA + (e.clientX - startX) * perPx);
            const up = () => {
                host.classList.remove('is-scrolling');
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);
        });
        // A click on the track centres the visible window there.
        track.addEventListener('pointerdown', (evt) => {
            if (evt.target !== track || evt.button !== 0) return;
            const rect = track.getBoundingClientRect();
            const x = f0 + ((evt.clientX - rect.left) / rect.width) * (f1 - f0);
            const span = host._spec.xDomain[1] - host._spec.xDomain[0];
            panTo(host, x - span / 2);
        });
        thumb.addEventListener('keydown', (evt) => {
            const span = host._spec.xDomain[1] - host._spec.xDomain[0];
            const step = { ArrowLeft: -0.1, ArrowRight: 0.1, PageUp: -0.9, PageDown: 0.9 }[evt.key];
            // The thumb is redrawn by the pan; keep the keyboard focus on the new one.
            if (step !== undefined || evt.key === 'Home' || evt.key === 'End') host._refocusScroll = true;
            if (step !== undefined) { evt.preventDefault(); panTo(host, host._spec.xDomain[0] + step * span); }
            else if (evt.key === 'Home') { evt.preventDefault(); panTo(host, f0); }
            else if (evt.key === 'End') { evt.preventDefault(); panTo(host, f1); }
        });
        if (host._refocusScroll) {
            host._refocusScroll = false;
            thumb.focus();
        }
    }

    function svgFor(spec, width) {
        const height = spec.height || 320;
        const top = 22;
        const bottom = 30;
        const hasDirect = spec.series.some((s) => s.directLabel);
        const right = hasDirect ? 58 : 18;

        const ys = [...(spec.yInclude || [])];
        // When zoomed, fit the y axis to what is visible (plus the neighbour on each side).
        const [dx0, dx1] = spec.xDomain;
        const visiblePoints = (pts) => {
            if (!spec.zoomed) return pts;
            const inside = pts.filter((p) => p.x >= dx0 && p.x <= dx1);
            return inside.length ? inside : pts;
        };
        for (const s of spec.series) {
            for (const p of visiblePoints(s.points)) {
                if (isNum(p.y)) ys.push(p.y);
                if (isNum(p.lo)) ys.push(p.lo);
                if (isNum(p.hi)) ys.push(p.hi);
            }
        }
        if (!ys.length) return { svg: '<div class="tp-empty">No numeric values to plot.</div>', geom: null };
        // A loop, not Math.min(...ys): spreading 100k+ values overflows the call stack.
        let minV = Infinity;
        let maxV = -Infinity;
        for (const v of ys) {
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        if (maxV - minV < 1e-9) {
            const pad = Math.abs(minV) > 1 ? Math.abs(minV) * 0.1 : 1;
            minV -= pad;
            maxV += pad;
        }
        const step = niceStep((maxV - minV) / 5);
        const y0 = Math.floor(minV / step) * step;
        const y1 = Math.ceil(maxV / step) * step;
        const yTicks = [];
        for (let k = 0; y0 + k * step <= y1 + step / 2; k++) yTicks.push(y0 + k * step);
        const dec = tickDecimals(step);
        const yLabels = yTicks.map((v) => (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(dec));
        const left = Math.max(...yLabels.map((t) => t.length)) * 6.6 + 16;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const [x0, x1] = spec.xDomain;
        const sx = (x) => left + ((x - x0) / (x1 - x0 || 1)) * plotW;
        const sy = (v) => top + plotH - ((v - y0) / (y1 - y0)) * plotH;
        const f = (n) => n.toFixed(1);

        let out = `<clipPath id="tp-clip"><rect x="${left}" y="${top - 4}" width="${plotW}" height="${plotH + 8}" /></clipPath>`;
        for (const b of spec.bands || []) {
            const a = Math.max(left, sx(b.x0));
            const c = Math.min(left + plotW, sx(b.x1));
            if (c > a) out += `<rect x="${f(a)}" y="${top}" width="${f(c - a)}" height="${plotH}" fill="${b.fill}" />`;
        }
        yTicks.forEach((v, k) => {
            const y = f(sy(v));
            const zero = Math.abs(v) < step / 1e6 && y0 < 0 && y1 > 0;
            out += `<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${zero ? COLOR.axis : COLOR.grid}" />`;
            out += `<text x="${left - 7}" y="${y}" text-anchor="end" dominant-baseline="middle">${yLabels[k]}</text>`;
        });
        if (spec.unit) out += `<text class="tp-axis-title" x="${left - 7}" y="${top - 9}" text-anchor="end">${esc(spec.unit)}</text>`;
        out += `<line x1="${left}" x2="${left + plotW}" y1="${top + plotH}" y2="${top + plotH}" stroke="${COLOR.axis}" />`;

        // x ticks; drop labels that would overlap.
        let lastEnd = -Infinity;
        for (const t of spec.xTicks(plotW, spec.xDomain)) {
            const x = sx(t.v);
            if (x < left - 0.5 || x > left + plotW + 0.5) continue;
            const w = t.label.length * 6.4;
            let anchor = 'middle';
            let tx = x;
            if (x - w / 2 < 2) { anchor = 'start'; tx = Math.max(2, x - 2); }
            if (x + w / 2 > width - 2) { anchor = 'end'; tx = Math.min(width - 2, x + 2); }
            const from = anchor === 'start' ? tx : anchor === 'end' ? tx - w : tx - w / 2;
            out += `<line x1="${f(x)}" x2="${f(x)}" y1="${top + plotH}" y2="${top + plotH + 4}" stroke="${COLOR.axis}" />`;
            if (from < lastEnd + 8) continue;
            lastEnd = from + w;
            out += `<text x="${f(tx)}" y="${top + plotH + 17}" text-anchor="${anchor}">${esc(t.label)}</text>`;
        }

        // Splits a series into runs without missing values or gaps larger than `gap`.
        const runs = (s, key = 'y') => {
            const res = [];
            let cur = [];
            let prev = null;
            for (const p of s.points) {
                if (!isNum(p[key]) || (key !== 'y' && !isNum(p.lo))) { if (cur.length) res.push(cur); cur = []; prev = null; continue; }
                if (prev && s.gap && p.x - prev.x > s.gap) { res.push(cur); cur = []; }
                cur.push(p);
                prev = p;
            }
            if (cur.length) res.push(cur);
            return res;
        };

        let marks = '';
        let overlays = '';
        let labels = '';
        for (const s of spec.series) {
            if (s.kind === 'area') {
                for (const run of runs(s, 'hi')) {
                    if (run.length < 2) continue;
                    const upper = run.map((p) => `${f(sx(p.x))},${f(sy(p.hi))}`);
                    const lower = run.slice().reverse().map((p) => `${f(sx(p.x))},${f(sy(p.lo))}`);
                    marks += `<polygon points="${upper.concat(lower).join(' ')}" fill="${s.color}" />`;
                }
            } else if (s.kind === 'whisker') {
                for (const p of s.points) {
                    if (!isNum(p.lo) || !isNum(p.hi)) continue;
                    marks += `<line x1="${f(sx(p.x))}" x2="${f(sx(p.x))}" y1="${f(sy(p.lo))}" y2="${f(sy(p.hi))}" stroke="${s.color}" stroke-width="${s.width || 3}" stroke-linecap="round" />`;
                }
            } else {
                for (const run of runs(s)) {
                    if (run.length >= 2) {
                        marks += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${run.map((p) => `${f(sx(p.x))},${f(sy(p.y))}`).join(' ')}" />`;
                    } else if (!s.markers) {
                        marks += `<circle cx="${f(sx(run[0].x))}" cy="${f(sy(run[0].y))}" r="2" fill="${s.color}" />`;
                    }
                }
                if (s.markers) {
                    for (const p of s.points) {
                        if (!isNum(p.y)) continue;
                        const hollow = s.hollow && s.hollow(p);
                        marks += `<circle cx="${f(sx(p.x))}" cy="${f(sy(p.y))}" r="${s.markers}" fill="${hollow ? COLOR.surface : s.color}" stroke="${hollow ? s.color : COLOR.surface}" stroke-width="${hollow ? 1.5 : 1}" />`;
                    }
                }
                if (s.emphasize) {
                    for (const p of s.points) {
                        if (!isNum(p.y) || !s.emphasize(p)) continue;
                        overlays += `<circle cx="${f(sx(p.x))}" cy="${f(sy(p.y))}" r="${s.markers ? 4 : 2.6}" fill="${COLOR.accent}" stroke="${COLOR.surface}" stroke-width="1" />`;
                    }
                }
                if (s.directLabel) {
                    const last = [...s.points].reverse().find((p) => isNum(p.y) && p.x <= x1);
                    if (last) labels += `<text class="tp-direct" x="${f(sx(last.x) + 6)}" y="${f(sy(last.y))}" dominant-baseline="middle">${esc(s.directLabel)}</text>`;
                }
            }
        }
        let eventsSvg = '';
        for (const m of spec.eventMarks || []) {
            if (!isNum(m.y) || m.x < x0 || m.x > x1) continue;
            const cx = f(sx(m.x));
            const cy = f(Math.max(top + 9, sy(m.y)));
            const r = m.active ? 10 : 8;
            eventsSvg += `<g class="tp-event-mark${m.active ? ' is-active' : ''}"><title>${esc(m.title)}</title>`
                + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLOR.surface}" stroke="${m.color}" stroke-width="${m.active ? 3 : 2}" />`
                + `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="tp-event-num" fill="${m.color}">${m.n}</text></g>`;
        }
        out += `<g clip-path="url(#tp-clip)">${marks}${overlays}${eventsSvg}</g>${labels}`;
        out += `<line class="tp-cross" x1="0" x2="0" y1="${top}" y2="${top + plotH}" stroke="${COLOR.reference}" stroke-width="1" visibility="hidden" />`;
        out += '<g class="tp-hover-dots"></g>';
        out += `<rect class="tp-brush" x="0" y="${top}" width="0" height="${plotH}" fill="${COLOR.accentWash}" stroke="${COLOR.accent}" stroke-width="1" visibility="hidden" pointer-events="none" />`;
        out += `<rect class="tp-hit" x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="transparent" />`;

        const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.ariaLabel || 'Chart')}">${out}</svg>`;
        return { svg, geom: { sx, sy, left, plotW, top, plotH, x0, x1, width } };
    }

    function nearestIndex(points, x) {
        let lo = 0;
        let hi = points.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (points[mid].x < x) lo = mid; else hi = mid;
        }
        return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? lo : hi;
    }

    function attachHover(host, spec, geom) {
        if (!geom) return;
        const svg = host.querySelector('svg');
        const tip = host.querySelector('.tp-tooltip');
        const cross = svg.querySelector('.tp-cross');
        const dots = svg.querySelector('.tp-hover-dots');
        const hoverable = spec.series
            .filter((s) => s.hover !== false && s.kind !== 'area' && s.points.length)
            .map((s) => ({ s, pts: s.points.filter((p) => isNum(p.y)).sort((a, b) => a.x - b.x) }))
            .filter((h) => h.pts.length);

        const hide = () => {
            tip.hidden = true;
            cross.setAttribute('visibility', 'hidden');
            dots.innerHTML = '';
        };
        const show = (evt) => {
            const rect = svg.getBoundingClientRect();
            const scale = geom.width / rect.width;
            const px = (evt.clientX - rect.left) * scale;
            const xVal = geom.x0 + ((px - geom.left) / geom.plotW) * (geom.x1 - geom.x0);
            let best = null;
            for (const h of hoverable) {
                const p = h.pts[nearestIndex(h.pts, xVal)];
                const d = Math.abs(geom.sx(p.x) - px);
                if (!best || d < best.d) best = { d, x: p.x };
            }
            if (!best || best.d > 40) { hide(); return; }
            const anchorPx = geom.sx(best.x);
            const rows = [];
            for (const h of hoverable) {
                const p = h.pts[nearestIndex(h.pts, best.x)];
                if (Math.abs(geom.sx(p.x) - anchorPx) > Math.max(6, (geom.plotW / Math.max(1, h.pts.length)) * 0.6)) continue;
                rows.push({ s: h.s, p });
            }
            if (!rows.length) { hide(); return; }
            if (spec.sortTooltip) rows.sort((a, b) => b.p.y - a.p.y);
            cross.setAttribute('x1', anchorPx.toFixed(1));
            cross.setAttribute('x2', anchorPx.toFixed(1));
            cross.setAttribute('visibility', 'visible');
            dots.innerHTML = rows.map((r) => `<circle cx="${geom.sx(r.p.x).toFixed(1)}" cy="${geom.sy(r.p.y).toFixed(1)}" r="4.5" fill="${r.s.color}" stroke="${COLOR.surface}" stroke-width="2" />`).join('');

            const main = rows.find((r) => r.p.meta) || rows[0];
            const extra = spec.tooltipExtra ? spec.tooltipExtra(main.p) : '';
            const shown = rows.slice(0, 12);
            tip.innerHTML = `<div class="tp-tooltip-title">${esc(spec.formatX(best.x))}</div>`
                + shown.map((r) => `<div class="tp-tooltip-row"><span class="tp-swatch" style="background:${r.s.color}"></span><span class="tp-tooltip-name">${esc(r.s.name)}</span><span class="tp-tooltip-value">${esc(withUnit(fmt(r.p.y), spec.unit))}</span></div>`).join('')
                + (rows.length > shown.length ? `<div class="tp-analysis-note">+${rows.length - shown.length} more</div>` : '')
                + (extra && rows.length === 1 || (extra && spec.kind === 'year') ? `<div class="tp-analysis-note">${esc(extra)}</div>` : '');
            tip.hidden = false;
            const cssX = anchorPx / scale;
            const tipW = tip.offsetWidth;
            const hostW = host.clientWidth;
            let leftPos = cssX + 14;
            if (leftPos + tipW > hostW - 4) leftPos = cssX - tipW - 14;
            tip.style.left = `${Math.max(4, leftPos)}px`;
            tip.style.top = `${Math.max(4, (evt.clientY - rect.top) - tip.offsetHeight / 2)}px`;
        };
        const hit = svg.querySelector('.tp-hit');
        const brush = svg.querySelector('.tp-brush');
        const toPx = (evt) => {
            const rect = svg.getBoundingClientRect();
            const px = (evt.clientX - rect.left) * (geom.width / rect.width);
            return Math.min(geom.left + geom.plotW, Math.max(geom.left, px));
        };
        const toX = (px) => geom.x0 + ((px - geom.left) / geom.plotW) * (geom.x1 - geom.x0);
        let drag = null;

        // Drag across the plot to zoom into that range (like a timeline in a video editor).
        hit.addEventListener('pointerdown', (evt) => {
            if (evt.button !== 0) return;
            drag = { from: toPx(evt), to: toPx(evt), id: evt.pointerId };
            hit.setPointerCapture(evt.pointerId);
            evt.preventDefault();
        });
        hit.addEventListener('pointermove', (evt) => {
            if (!drag) { show(evt); return; }
            drag.to = toPx(evt);
            const a = Math.min(drag.from, drag.to);
            const w = Math.abs(drag.to - drag.from);
            brush.setAttribute('x', a.toFixed(1));
            brush.setAttribute('width', w.toFixed(1));
            brush.setAttribute('visibility', w > 2 ? 'visible' : 'hidden');
            if (w > 2) hide(); else show(evt);
        });
        const finish = (evt, apply) => {
            if (!drag || evt.pointerId !== drag.id) return;
            const { from, to } = drag;
            drag = null;
            brush.setAttribute('visibility', 'hidden');
            if (hit.hasPointerCapture(evt.pointerId)) hit.releasePointerCapture(evt.pointerId);
            if (apply && Math.abs(to - from) >= 8 && host._onZoom) {
                host._onZoom([toX(Math.min(from, to)), toX(Math.max(from, to))]);
            }
        };
        hit.addEventListener('pointerup', (evt) => finish(evt, true));
        hit.addEventListener('pointercancel', (evt) => finish(evt, false));
        hit.addEventListener('pointerleave', () => { if (!drag) hide(); });
        hit.addEventListener('dblclick', () => { if (spec.zoomed && host._onZoom) host._onZoom(null); });
    }

    // --------------------------------------------------------------- panel

    const TEMPLATE = `
        <div class="tp-head">
            <h3 class="tp-title" data-ref="title">Plot</h3>
            <span class="tp-subtitle" data-ref="subtitle"></span>
        </div>
        <div class="tp-controls">
            <label class="tp-field">Topic<select data-ref="topic"></select></label>
            <div class="tp-field">View<div class="tp-segmented" role="group" aria-label="Plot view" data-ref="views">
                ${VIEWS.map((v) => `<button type="button" data-view="${v.id}">${v.label}</button>`).join('')}
            </div></div>
            <label class="tp-field">Highlight period<select data-ref="period">
                ${PERIOD_PRESETS.filter((p) => !p.group).slice(0, 2).map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
                <optgroup label="Months">${PERIOD_PRESETS.filter((p) => p.group === 'Months').map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</optgroup>
                <optgroup label="Seasons">${PERIOD_PRESETS.filter((p) => p.group === 'Seasons').map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</optgroup>
                <option value="custom">${esc(PERIOD_PRESETS[PERIOD_PRESETS.length - 1].label)}</option>
            </select></label>
            <div class="tp-field" data-ref="customField" hidden>Custom period<div class="tp-inline">
                <input class="tp-md" data-ref="customStart" maxlength="5" placeholder="DD.MM" aria-label="Period start (DD.MM)">
                <span>–</span>
                <input class="tp-md" data-ref="customEnd" maxlength="5" placeholder="DD.MM" aria-label="Period end (DD.MM)">
            </div></div>
        </div>
        <div class="tp-chips" data-ref="functions">
            <span class="tp-chip-label">Functions</span>
            <button type="button" class="tp-chip" data-fn="anomaly" title="Subtract the multi-year mean of the same time of year (needs ≥ 2 years)">Anomaly</button>
            <button type="button" class="tp-chip" data-fn="ma" title="Centred moving average">Moving average
                <input type="number" min="2" max="60" step="1" data-ref="maWindow" aria-label="Moving average window"></button>
            <button type="button" class="tp-chip" data-fn="clim" title="Mean and ±1 standard deviation over all years (needs ≥ 2 years)">Multi-year mean ± σ</button>
            <button type="button" class="tp-chip" data-fn="zoom" title="Show only the highlighted period (Years overlaid)">Zoom to period</button>
        </div>
        <div class="tp-windows" data-ref="windows" aria-label="Analysis time frames"></div>
        <div data-ref="hint"></div>
        <div class="tp-summary" data-ref="summary" aria-live="polite"></div>
        <div class="tp-chart" data-ref="chart"></div>
        <div class="tp-legend" data-ref="legend"></div>
        <div class="tp-table-wrap" data-ref="table" hidden></div>
        <div class="tp-footer" data-ref="footer">
            <span class="tp-footer-note">Drag across the plot to zoom in · scroll with the bar below it (or Shift + wheel) · double-click to reset</span>
            <button type="button" class="tp-link-btn" data-ref="tableBtn">Show table</button>
            <button type="button" class="tp-link-btn" data-ref="csvBtn">Download CSV</button>
        </div>
        <div class="tp-events" data-ref="events"></div>
        <div class="tp-analysis" data-ref="analysis"></div>`;

    function mount(element) {
        state.root = element;
        element.classList.add('tp-root');
        element.innerHTML = TEMPLATE;
        const refs = {};
        element.querySelectorAll('[data-ref]').forEach((el) => { refs[el.dataset.ref] = el; });
        state.refs = refs;

        refs.topic.addEventListener('change', () => { state.topic = refs.topic.value; state.activeEvent = null; state.hiddenYears.clear(); render(); });
        const onEventClick = (e) => {
            const sat = e.target.closest('button[data-sat]');
            if (sat) {
                // index.html draws the image on the map (NASA GIBS).
                document.dispatchEvent(new CustomEvent('trendplots:satellite', { detail: { date: sat.dataset.sat } }));
                return;
            }
            const b = e.target.closest('[data-event]');
            if (!b) return;
            focusEvent(Number(b.dataset.event));
            refs.chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        refs.events.addEventListener('click', onEventClick);
        refs.summary.addEventListener('click', onEventClick);
        refs.views.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-view]');
            if (!b || b.disabled) return;
            state.view = b.dataset.view;
            if (state.view === 'period' && state.periodId === 'none' && !state.windows.some((w) => w.frame !== 'all')) state.periodId = 'm1';
            render();
        });
        refs.period.addEventListener('change', () => { state.periodId = refs.period.value; state.hiddenYears.clear(); render(); });
        const onCustom = () => {
            state.custom.start = refs.customStart.value;
            state.custom.end = refs.customEnd.value;
            refs.customStart.setAttribute('aria-invalid', String(!parseDayMonth(refs.customStart.value)));
            refs.customEnd.setAttribute('aria-invalid', String(!parseDayMonth(refs.customEnd.value)));
            render();
        };
        refs.customStart.addEventListener('input', (e) => { formatDayMonthTyping(refs.customStart, e); onCustom(); });
        refs.customEnd.addEventListener('input', (e) => { formatDayMonthTyping(refs.customEnd, e); onCustom(); });
        refs.functions.addEventListener('click', (e) => {
            if (e.target.matches('input')) return;
            const b = e.target.closest('button[data-fn]');
            if (!b || b.disabled) return;
            state.fn[b.dataset.fn] = !state.fn[b.dataset.fn];
            render();
        });
        refs.maWindow.addEventListener('input', () => {
            const n = Math.round(Number(refs.maWindow.value));
            if (n >= 2 && n <= 60) {
                state.fn.maWindow = n;
                state.fn.ma = true;
                render();
            }
        });
        refs.legend.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-year]');
            if (!b) return;
            const y = Number(b.dataset.year);
            if (e.altKey || e.metaKey) {
                // Alt/Cmd-click: show only this year (or all again).
                const all = [...refs.legend.querySelectorAll('button[data-year]')].map((x) => Number(x.dataset.year));
                const solo = state.hiddenYears.size === all.length - 1 && !state.hiddenYears.has(y);
                state.hiddenYears = new Set(solo ? [] : all.filter((v) => v !== y));
            } else if (state.hiddenYears.has(y)) state.hiddenYears.delete(y);
            else state.hiddenYears.add(y);
            render();
        });
        refs.windows.addEventListener('change', (e) => {
            const row = e.target.closest('[data-window]');
            const w = row && state.windows.find((x) => x.id === Number(row.dataset.window));
            if (!w) return;
            if (e.target.matches('select[data-w="frame"]')) {
                w.frame = e.target.value;
                renderWindowsEditor();
                render();
            } else if (e.target.matches('input[data-tool]')) {
                const tool = e.target.dataset.tool;
                w.tools = e.target.checked ? [...new Set([...w.tools, tool])] : w.tools.filter((t) => t !== tool);
                render();
            }
        });
        refs.windows.addEventListener('input', (e) => {
            if (!e.target.matches('input[data-w]')) return;
            formatDayMonthTyping(e.target, e);
            const row = e.target.closest('[data-window]');
            const w = row && state.windows.find((x) => x.id === Number(row.dataset.window));
            if (!w) return;
            w.custom[e.target.dataset.w] = e.target.value;
            e.target.setAttribute('aria-invalid', String(!parseDayMonth(e.target.value)));
            render();
        });
        refs.windows.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            if (btn.dataset.action === 'add') {
                const used = new Set(state.windows.map((w) => w.frame));
                const frame = PERIOD_PRESETS.filter((p) => p.group === 'Months').map((p) => p.id).find((id) => !used.has(id)) || 'm1';
                state.windows.push({ id: state.nextWindowId++, frame, custom: { start: '01.06', end: '31.08' }, tools: ['Linear Regression'] });
            } else if (btn.dataset.action === 'remove') {
                const id = Number(btn.closest('[data-window]').dataset.window);
                state.windows = state.windows.filter((w) => w.id !== id);
            }
            renderWindowsEditor();
            render();
        });
        fetch('/api/tools')
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                if (body && Array.isArray(body.tools) && body.tools.length) {
                    state.tools = body.tools.slice();
                    renderWindowsEditor();
                    render();
                }
            })
            .catch(() => {});
        renderWindowsEditor();

        refs.tableBtn.addEventListener('click', () => { state.showTable = !state.showTable; render(); });
        refs.csvBtn.addEventListener('click', downloadCsv);

        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => layoutChart(refs.chart)).observe(refs.chart);
        }
        render();
    }

    function frameOptions(selected) {
        const opt = (id, label) => `<option value="${id}"${id === selected ? ' selected' : ''}>${esc(label)}</option>`;
        return opt('all', 'Whole series')
            + opt('year', 'Whole year (annual mean)')
            + `<optgroup label="Months">${PERIOD_PRESETS.filter((p) => p.group === 'Months').map((p) => opt(p.id, p.label)).join('')}</optgroup>`
            + `<optgroup label="Seasons">${PERIOD_PRESETS.filter((p) => p.group === 'Seasons').map((p) => opt(p.id, p.label)).join('')}</optgroup>`
            + opt('custom', 'Custom (DD.MM – DD.MM)…');
    }

    // The list of analysis time frames; rebuilt only when frames are added, removed or changed,
    // so typing in a custom period keeps the focus.
    function renderWindowsEditor() {
        const host = state.refs.windows;
        if (!host) return;
        const rows = state.windows.map((w) => {
            const color = windowColor(w);
            const tools = state.tools.map((t) => `<label class="tp-tool${w.tools.includes(t) ? ' is-on' : ''}" title="${esc(TOOL_HELP[t] || '')}"><input type="checkbox" data-tool="${esc(t)}"${w.tools.includes(t) ? ' checked' : ''}>${esc(TOOL_SHORT[t] || t)}</label>`).join('');
            const custom = w.frame === 'custom'
                ? `<span class="tp-inline"><input class="tp-md" data-w="start" maxlength="5" placeholder="DD.MM" aria-label="Time frame start (DD.MM)" value="${esc(w.custom.start)}" aria-invalid="${!parseDayMonth(w.custom.start)}"><span>–</span><input class="tp-md" data-w="end" maxlength="5" placeholder="DD.MM" aria-label="Time frame end (DD.MM)" value="${esc(w.custom.end)}" aria-invalid="${!parseDayMonth(w.custom.end)}"></span>`
                : '';
            return `<div class="tp-window" data-window="${w.id}" style="--tp-win:${color}">
                <span class="tp-window-swatch" aria-hidden="true"></span>
                <select data-w="frame" aria-label="Time frame">${frameOptions(w.frame)}</select>
                ${custom}
                <span class="tp-window-tools" role="group" aria-label="Tools for this time frame">${tools}</span>
                <button type="button" class="tp-window-remove" data-action="remove" title="Remove this time frame" aria-label="Remove this time frame">×</button>
            </div>`;
        }).join('');
        host.innerHTML = `<div class="tp-windows-head"><span class="tp-chip-label">Analyses</span><span class="tp-windows-note">For a period such as January, each tool runs inside every year's January on its own; the results are compared year by year.</span></div>
            ${rows}
            <button type="button" class="tp-link-btn tp-window-add" data-action="add">+ Add time frame</button>`;
    }

    function setData(visualization, userRequest) {
        state.viz = visualization || null;
        state.request = userRequest || null;
        const topics = state.viz && state.viz.topics ? Object.keys(state.viz.topics) : [];
        const withData = topics.filter((t) => (state.viz.topics[t].values || []).some(isNum));
        // Also leave a topic without data once one with data arrives (topics stream in one by one).
        if (!topics.includes(state.topic) || (withData.length && !withData.includes(state.topic))) {
            state.topic = withData[0] || topics[0] || null;
        }
        state.hiddenYears.clear();
        state.activeEvent = null;
        render();
    }

    function setLoading(on) {
        state.loading = Boolean(on);
        if (!state.refs.chart) return;
        if (on) {
            state.refs.chart._spec = null;
            state.refs.chart.innerHTML = '<div class="tp-empty">Loading data…</div>';
        } else {
            render();
        }
    }

    function render() {
        const r = state.refs;
        if (!r.chart) return;
        const topics = state.viz && state.viz.topics ? Object.keys(state.viz.topics) : [];
        r.topic.innerHTML = topics.map((t) => `<option value="${esc(t)}"${t === state.topic ? ' selected' : ''}>${esc(t)}</option>`).join('');
        r.topic.disabled = topics.length < 2;
        r.period.value = state.periodId;
        r.customField.hidden = state.periodId !== 'custom';
        if (document.activeElement !== r.customStart) r.customStart.value = state.custom.start;
        if (document.activeElement !== r.customEnd) r.customEnd.value = state.custom.end;
        if (document.activeElement !== r.maWindow) r.maWindow.value = state.fn.maWindow;

        const model = buildModel();
        if (!model) {
            r.subtitle.textContent = '';
            r.chart._spec = null;
            r.chart.innerHTML = `<div class="tp-empty">${state.loading ? 'Loading data…' : 'Pick a point or an area (Areas) on the map, choose topics and click “Apply” to plot the data here.'}</div>`;
            r.legend.innerHTML = '';
            r.hint.innerHTML = '';
            r.analysis.innerHTML = '';
            r.summary.innerHTML = '';
            r.events.innerHTML = '';
            r.table.hidden = true;
            r.footer.hidden = true;
            setControlStates(null, null);
            return;
        }

        const period = currentPeriod();
        const canCompare = model.canCompare && model.years.length >= 2;
        const stripesOk = model.years.length >= 2;
        if (!canCompare && state.view !== 'timeline' && !(state.view === 'stripes' && stripesOk)) state.view = 'timeline';
        setControlStates(model, period);

        const st = model.info.station;
        r.subtitle.textContent = [
            `${model.points.length} intervals of ${model.ivText}`,
            model.years.length ? `${model.years[0]}–${model.years[model.years.length - 1]}` : '',
            st && st.name ? `station ${st.name}` : '',
            // Topics arrive one by one (setData while loading): say that more is coming.
            state.loading ? 'still loading other topics…' : '',
        ].filter(Boolean).join(' · ');
        r.title.textContent = `Plot: ${state.topic}`;

        const hints = [];
        if (model.info.error) hints.push(model.info.error);
        if (model.unit === 'mm/day') hints.push('Precipitation is shown as a density: the average rainfall per day (mm/day) in each interval. Monthly or yearly totals and multiday totals (MDPR) are divided by the number of days they cover, so 3 mm/day over a month means about 90 mm in that month.');
        else if (model.unit === '% of days') hints.push('Share of days in each interval on which precipitation reached the threshold (monthly / yearly rain-day counts divided by the number of days), e.g. 50 % = every second day.');
        if (model.info.dropped_intervals > 0) hints.push(`${model.info.dropped_intervals} interval${model.info.dropped_intervals === 1 ? ' was' : 's were'} left out because data covered less than three quarters of their days (e.g. a year with only its first months); their means would bias the trend.`);
        if (!model.points.length) hints.push('This topic has no numeric values in the selected time range.');
        else if (!model.canCompare) hints.push(`Comparing years needs intervals of up to 2 months; the current interval is ${model.ivText}. Choose Day or Month intervals.`);
        else if (model.years.length < 2) hints.push('The time range covers only one year. Choose a range over several years to compare them.');
        if (period && period.invalid) hints.push('Enter the custom period as DD.MM – DD.MM, e.g. 01.06 – 31.08 or 01.12 – 28.02.');
        r.hint.innerHTML = hints.map((h) => `<div class="tp-hint">${esc(h)}</div>`).join('');

        if (!model.points.length) {
            r.chart._spec = null;
            r.chart.innerHTML = '<div class="tp-empty">No data to plot.</div>';
            r.legend.innerHTML = '';
            r.analysis.innerHTML = '';
            r.summary.innerHTML = '';
            r.events.innerHTML = '';
            r.table.hidden = true;
            r.footer.hidden = true;
            return;
        }

        const usablePeriod = period && !period.invalid ? period : null;
        const wins = evaluateWindows(model);
        // Period across years: every analysis time frame with a period; without one, the highlight period.
        const periodWins = wins.filter((win) => win.period && win.allRows.length);
        if (state.view === 'period' && !periodWins.length && !usablePeriod) state.view = 'timeline';
        setControlStates(model, period);

        renderSummary(model, wins);
        renderEvents(model);
        if (state.view === 'stripes') {
            const out = renderStripes(r.chart, model, usablePeriod);
            state.lastTable = out ? out.table : null;
            r.legend.innerHTML = '';
            r.footer.hidden = !out;
            r.footer.classList.add('tp-footer-stripes');
            renderTable(state.lastTable);
            renderAnalysis(model, wins);
            return;
        }

        let spec;
        if (state.view === 'overlay') spec = buildOverlay(model, usablePeriod, wins);
        else if (state.view === 'period' && periodWins.length > 1) spec = buildPeriodMulti(model, periodWins);
        else if (state.view === 'period' && periodWins.length === 1) spec = buildPeriod(model, periodWins[0].period, null, periodWins[0].color);
        else if (state.view === 'period') spec = buildPeriod(model, usablePeriod, null);
        else spec = buildTimeline(model, usablePeriod, wins);
        spec.ariaLabel = `${state.topic}: ${VIEWS.find((v) => v.id === state.view).label}`;
        state.lastTable = spec.table;

        // Drag-to-zoom: keep the zoomed range while the view, topic and full range stay the same.
        const fullDomain = spec.xDomain;
        const zoomKey = [state.topic, state.view, fullDomain[0], fullDomain[1]].join('|');
        if (state.zoom && state.zoom.key === zoomKey) {
            spec.xDomain = state.zoom.domain;
            spec.zoomed = true;
        } else {
            state.zoom = null;
        }
        spec.fullDomain = fullDomain;
        r.chart._onZoom = (domain) => {
            state.zoom = domain ? { key: zoomKey, domain } : null;
            render();
        };
        // Scrolling only moves the visible window; the chart redraws itself (see panTo).
        r.chart._onPan = (domain) => {
            state.zoom = { key: zoomKey, domain };
        };

        r.footer.hidden = false;
        r.footer.classList.remove('tp-footer-stripes');
        renderChart(r.chart, spec);
        r.legend.innerHTML = legendHtml(spec.legend);
        renderTable(spec.table);
        renderAnalysis(model, wins);
    }

    // ------------------------------------------------------------ stripes

    // One stripe per year (or per year's highlighted period), coloured by its departure from the
    // mean of all years: the "warming stripes" of Ed Hawkins, for any topic.
    function stripesData(model, period) {
        const use = period || presetPeriod('year', state.custom);
        // Stricter than elsewhere: a year missing a fifth of its values would bias its colour.
        const rows = periodSeries(model, use).filter((row) => row.n >= Math.floor(row.expected * 0.8) && isNum(row.mean));
        if (rows.length < 2) return null;
        const avg = mean(rows.map((row) => row.mean));
        const anomalies = rows.map((row) => row.mean - avg);
        const span = Math.max(...anomalies.map(Math.abs)) || 1;
        const wet = /mm|snow|%/.test(model.unit) && !/°C/.test(model.unit);
        const ramp = wet ? STRIPES_WET : STRIPES_WARM;
        return {
            label: use.label,
            avg,
            rows: rows.map((row, i) => {
                const k = Math.round(((anomalies[i] / span + 1) / 2) * (ramp.length - 1));
                return { ...row, anomaly: anomalies[i], color: ramp[Math.max(0, Math.min(ramp.length - 1, k))] };
            }),
            ramp,
            span,
        };
    }

    function renderStripes(host, model, period) {
        const data = stripesData(model, period);
        host._spec = null;
        if (!data) {
            host.innerHTML = '<div class="tp-empty">Stripes need at least two complete years (or two complete periods of the highlighted period).</div>';
            return null;
        }
        const unit = model.unit;
        const n = data.rows.length;
        const stripes = data.rows.map((row) => `<div class="tp-stripe" style="background:${row.color}" tabindex="0"
            title="${esc(`${row.label}: ${withUnit(fmt(row.mean), unit)} (${withUnit(fmtSigned(row.anomaly), unit)} vs. the mean of all years)`)}"
            aria-label="${esc(`${row.label}: ${withUnit(fmtSigned(row.anomaly), unit)}`)}"></div>`).join('');
        const every = Math.max(1, Math.ceil(n / 12));
        const ticks = data.rows.map((row, i) => `<span style="left:${((i + 0.5) / n) * 100}%">${i % every === 0 || i === n - 1 ? esc(row.label) : ''}</span>`).join('');
        const scale = data.ramp.map((c) => `<span style="background:${c}"></span>`).join('');
        host.innerHTML = `<div class="tp-stripes" role="img" aria-label="${esc(`Stripes of ${data.label}: one per year`)}">${stripes}</div>
            <div class="tp-stripes-axis">${ticks}</div>
            <div class="tp-stripes-scale"><span>${esc(withUnit(fmtSigned(-data.span), unit))}</span><span class="tp-stripes-ramp">${scale}</span><span>${esc(withUnit(fmtSigned(data.span), unit))}</span>
            <span class="tp-stripes-note">departure of each year's ${esc(data.label === 'Whole year' ? 'annual mean' : data.label)} from the mean of all ${n} years (${esc(withUnit(fmt(data.avg), unit))})</span></div>`;
        return {
            legend: [],
            table: tableFrom(['Year', `Mean${unit ? ` (${unit})` : ''}`, `Departure${unit ? ` (${unit})` : ''}`], data.rows.map((row) => [row.label, row.mean, row.anomaly])),
        };
    }

    // ------------------------------------------------------------ events list

    function renderEvents(model) {
        const r = state.refs;
        const list = eventsOf(model);
        if (!list.length) {
            r.events.innerHTML = '';
            return;
        }
        const unit = model.unit;
        const cards = list.map((ev) => {
            const when = ev.end ? `${fmtIsoDate(ev.date)} – ${fmtIsoDate(ev.end)}` : fmtIsoDate(ev.date);
            const value = ev.end ? `${ev.days} days` : withUnit(fmt(ev.value), unit);
            const delta = isNum(ev.anomaly) ? `${ev.end ? 'peak ' : ''}${withUnit(fmtSigned(ev.anomaly), unit)} vs. normal` : '';
            const satellite = isoToTime(ev.peak_date || ev.date) >= Date.UTC(2000, 1, 24)
                ? `<button type="button" class="tp-link-btn" data-sat="${esc(ev.peak_date || ev.date)}" title="Show the satellite image (NASA MODIS) of this day on the map">🛰 Satellite image</button>` : '';
            return `<li class="tp-event${state.activeEvent === ev.n ? ' is-active' : ''}" style="--tp-ev:${ev.style.color}">
                <button type="button" class="tp-event-main" data-event="${ev.n}" title="Show this event in the plot">
                    <span class="tp-event-num-badge">${ev.n}</span>
                    <span class="tp-event-body"><span class="tp-event-title">${esc(ev.style.icon)} ${esc(ev.title)} · <span class="tp-event-date">${esc(when)}</span></span>
                    <span class="tp-event-value">${esc(value)}${delta ? ` <span class="tp-event-delta">${esc(delta)}</span>` : ''}</span>
                    <span class="tp-event-desc">${esc(ev.description)}</span></span>
                </button>${satellite}</li>`;
        }).join('');
        r.events.innerHTML = `<div class="tp-analysis-title">Notable events</div>
            <div class="tp-analysis-note">The values that stand out most from the normal of their time of year (mean of the same calendar days over all years), the records of the time range and the strongest warm / cold spells. Click one to zoom the plot to it.</div>
            <ol class="tp-event-list">${cards}</ol>`;
    }

    // Zoom the timeline to ±`days` around an event and mark it.
    function focusEvent(n, days = 45) {
        const model = buildModel();
        if (!model) return;
        const ev = eventsOf(model).find((e) => e.n === n);
        if (!ev) return;
        state.activeEvent = n;
        state.view = 'timeline';
        const first = isoToTime(ev.date);
        const last = isoToTime(ev.end || ev.date) + DAY_MS;
        const pad = Math.max(days * DAY_MS, model.stepDays * DAY_MS * 8);
        const domain = [Math.max(model.domain[0], first - pad), Math.min(model.domain[1], last + pad)];
        state.zoom = { key: [state.topic, 'timeline', model.domain[0], model.domain[1]].join('|'), domain };
        render();
    }

    // Focus the event on (or nearest to) an ISO date, e.g. after loading an example.
    function focusDate(iso) {
        const model = buildModel();
        if (!model) return false;
        const t = isoToTime(iso);
        const list = eventsOf(model);
        let best = null;
        for (const ev of list) {
            const d = Math.abs(isoToTime(ev.peak_date || ev.date) - t);
            if (d <= 7 * DAY_MS && (!best || d < best.d)) best = { ev, d };
        }
        if (best) {
            focusEvent(best.ev.n);
        } else {
            state.activeEvent = null;
            state.view = 'timeline';
            state.zoom = { key: [state.topic, 'timeline', model.domain[0], model.domain[1]].join('|'), domain: [Math.max(model.domain[0], t - 45 * DAY_MS), Math.min(model.domain[1], t + 46 * DAY_MS)] };
            render();
        }
        return true;
    }

    // Choose the topic whose events include `iso` (e.g. TMAX for a heat example) and focus it.
    function focusExample(iso, preferCodes, topic) {
        const topics = state.viz && state.viz.topics ? Object.keys(state.viz.topics) : [];
        if (topic && topics.includes(topic)) {
            state.topic = topic;
            state.hiddenYears.clear();
            return focusDate(iso);
        }
        const t = isoToTime(iso);
        const score = (key) => {
            const info = state.viz.topics[key];
            const evs = Array.isArray(info.events) ? info.events : [];
            const hit = evs.findIndex((ev) => Math.abs(isoToTime(ev.peak_date || ev.date) - t) <= 3 * DAY_MS);
            const code = (info.variables || [])[0] || '';
            const preferred = (preferCodes || []).indexOf(code);
            return [hit < 0 ? 99 : hit, preferred < 0 ? 9 : preferred];
        };
        const ranked = topics.slice().sort((a, b) => { const p = score(a); const q = score(b); return p[0] - q[0] || p[1] - q[1]; });
        if (ranked.length) state.topic = ranked[0];
        state.hiddenYears.clear();
        return focusDate(iso);
    }

    // ------------------------------------------------------------ summary

    // One or two sentences in plain language about the whole series.
    function renderSummary(model, wins) {
        const r = state.refs;
        const win = wins.find((w) => !w.period && w.results);
        if (!win || !model.points.length) { r.summary.innerHTML = ''; return; }
        const res = win.results;
        const unit = model.unit;
        const lr = res['Linear Regression'];
        const sen = res["Sen's Slope"];
        const mk = res['Mann-Kendall'];
        const cp = res['Change Point'];
        const trend = lr && lr.available ? lr : sen && sen.available ? sen : null;
        const years = model.years.length ? `${model.years[0]}–${model.years[model.years.length - 1]}` : '';
        const parts = [];
        const spanYears = (model.points[model.points.length - 1].t - model.points[0].t) / (365.2425 * DAY_MS);
        if (trend && spanYears < 2 && model.stepDays < 200) {
            parts.push('ℹ The time range covers less than two years, so a slope here mostly follows the seasons, not a long-term change. Choose several years (ideally 30) to look for a trend.');
        } else if (trend) {
            const perDecade = trend.slope * 10;
            const sig = trend.significant;
            const dir = perDecade > 0 ? 'rose' : perDecade < 0 ? 'fell' : 'stayed level';
            const icon = !sig ? '〰' : perDecade > 0 ? '📈' : '📉';
            const what = state.fn.anomaly ? 'the anomaly' : 'the value';
            let text = `${icon} Over ${years}, ${what} ${dir}${perDecade ? ` by <strong>${esc(withUnit(fmt(Math.abs(perDecade)), unit))} per decade</strong>` : ''}`;
            const evidence = isNum(trend.p_value) ? pLabel(trend.p_value) : '95 % interval of the slope excludes 0';
            if (sig) text += ` — a <strong>statistically significant</strong> trend (${evidence}${mk && mk.available ? `; Mann-Kendall: ${esc(mk.trend)}` : ''}).`;
            else text += ` — but this is <strong>not statistically significant</strong>: natural ups and downs alone could produce such a slope${model.years.length < 20 ? `; ${model.years.length} years are short for a climate trend (30 are common)` : ''}.`;
            if (trend.deseasonalised) text += ' <span class="tp-muted">(tested without the seasonal cycle)</span>';
            parts.push(text);
        }
        if (cp && cp.available && cp.significant) {
            const row = win.rows.find((rw) => rw.year === cp.x_after);
            parts.push(`⇅ The level shifted by <strong>${esc(withUnit(fmtSigned(cp.shift), unit))}</strong> around ${esc(row ? row.label : String(Math.floor(cp.x_after)))} (change-point test, ${pLabel(cp.p_value)}).`);
        }
        const evs = eventsOf(model);
        const top = evs[0];
        if (top) parts.push(`⚑ Most notable: <button type="button" class="tp-inline-link" data-event="${top.n}">${esc(top.title.toLowerCase())} on ${esc(fmtIsoDate(top.peak_date || top.date))}</button> (${esc(withUnit(fmt(top.value), unit))}).`);
        r.summary.innerHTML = parts.length ? parts.map((t) => `<p>${t}</p>`).join('') : '';
    }

    function setControlStates(model, period) {
        const r = state.refs;
        const canCompare = Boolean(model && model.canCompare && model.years.length >= 2);
        r.views.querySelectorAll('button').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
            const stripesOk = Boolean(model && model.years.length >= 2);
            b.disabled = !model || (b.dataset.view !== 'timeline' && !canCompare && !(b.dataset.view === 'stripes' && stripesOk));
        });
        r.period.disabled = !model || !model.canCompare;
        r.functions.querySelectorAll('button[data-fn]').forEach((b) => {
            const fn = b.dataset.fn;
            b.setAttribute('aria-pressed', String(Boolean(state.fn[fn])));
            let disabled = !model;
            if ((fn === 'anomaly' || fn === 'clim') && !canCompare) disabled = true;
            if (fn === 'zoom') disabled = !model || state.view !== 'overlay' || !period || period.invalid;
            b.disabled = disabled;
        });
    }

    function legendHtml(items) {
        return (items || []).map((it) => {
            let swatch;
            if (it.style === 'dot') swatch = `<span class="tp-swatch tp-swatch-dot" style="background:${it.color}"></span>`;
            else if (it.style === 'hollow') swatch = `<span class="tp-swatch tp-swatch-dot" style="background:#fff;box-shadow:inset 0 0 0 1.5px ${it.color}"></span>`;
            else if (it.style === 'band') swatch = `<span class="tp-swatch tp-swatch-band" style="background:${COLOR.referenceBand};box-shadow:inset 0 -2px 0 ${it.color}"></span>`;
            else if (it.style === 'band-accent') swatch = `<span class="tp-swatch tp-swatch-band" style="background:${COLOR.accentWash};box-shadow:inset 0 0 0 1px ${it.color}"></span>`;
            else if (it.style === 'dash') swatch = `<span class="tp-swatch tp-swatch-dash" style="color:${it.color}"></span>`;
            else swatch = `<span class="tp-swatch" style="background:${it.color}"></span>`;
            if (it.toggleYear !== undefined) {
                return `<button type="button" class="tp-legend-item" data-year="${it.toggleYear}" aria-pressed="${it.pressed}" title="Click to show/hide · Alt-click to show only this year">${swatch}${esc(it.name)}</button>`;
            }
            return `<span class="tp-legend-item">${swatch}${esc(it.name)}</span>`;
        }).join('');
    }

    function cell(v) {
        return isNum(v) ? fmt(v, 3) : v === null || v === undefined ? '' : String(v);
    }

    function renderTable(table) {
        const r = state.refs;
        r.tableBtn.textContent = state.showTable ? 'Hide table' : 'Show table';
        r.table.hidden = !state.showTable;
        if (!state.showTable || !table) return;
        r.table.innerHTML = `<table class="tp-table"><thead><tr>${table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
            + `<tbody>${table.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(cell(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }

    function downloadCsv() {
        const table = state.lastTable;
        if (!table) return;
        const q = (v) => {
            const s = isNum(v) ? String(v) : v === null || v === undefined ? '' : String(v);
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [table.columns, ...table.rows].map((row) => row.map(q).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `${(state.topic || 'data').replace(/[^\w-]+/g, '_')}_${state.view}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    // ------------------------------------------------------------ analysis

    function requestAnalysis(key, body) {
        state.analysisCache.set(key, { pending: true });
        const tools = JSON.parse(key)[1];
        fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, tools }),
        })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                state.analysisCache.set(key, body);
            })
            .catch((err) => state.analysisCache.set(key, { error: String(err.message || err) }))
            .finally(render);
    }

    function statCard(name, value, detail, flag) {
        const help = TOOL_HELP[name] || TOOL_HELP[Object.keys(TOOL_SHORT).find((k) => TOOL_SHORT[k] === name)] || '';
        const flagHtml = flag === undefined ? '' : `<span class="tp-stat-flag ${flag ? 'is-significant' : 'is-not-significant'}">${flag ? 'significant' : 'not significant'}</span>`;
        return `<div class="tp-stat"${help ? ` title="${esc(help)}"` : ''}><div class="tp-stat-name">${esc(name)}</div><div class="tp-stat-value">${value}${flagHtml}</div>${detail ? `<div class="tp-stat-detail">${detail}</div>` : ''}</div>`;
    }

    function mutedCard(name, text) {
        return `<div class="tp-stat tp-stat-muted"><div class="tp-stat-name">${esc(name)}</div><div class="tp-stat-value">${esc(text)}</div></div>`;
    }

    function toolCard(name, res, rows, unit) {
        if (!res.available) return mutedCard(TOOL_SHORT[name] || name, res.error || 'not available');
        if (name === 'Linear Regression') {
            return statCard('Linear regression',
                `${esc(withUnit(fmtSigned(res.slope), unit))} / year`,
                `${esc(withUnit(fmtSigned(res.slope * 10), unit))} per decade · R² ${fmt(res.r_squared, 2)} · ${pLabel(res.p_value)}<br>95% CI of slope [${fmt(res.confidence_interval[0])}, ${fmt(res.confidence_interval[1])}]${isNum(res.effective_n) && res.effective_n < res.observations * 0.9 ? `<br><span title="Neighbouring values are similar (autocorrelation ${fmt(res.autocorrelation, 2)}), so the series holds about ${Math.round(res.effective_n)} independent values; the p-value accounts for that.">≈ ${Math.round(res.effective_n)} independent values (autocorrelation-corrected)</span>` : ''}`,
                res.significant);
        }
        if (name === 'Mann-Kendall') {
            return statCard('Mann-Kendall', esc(res.trend.charAt(0).toUpperCase() + res.trend.slice(1)), `τ ${fmt(res.tau, 2)} · z ${fmt(res.z_statistic, 2)} · ${pLabel(res.p_value)}`, res.significant);
        }
        if (name === "Sen's Slope") {
            const ci = res.confidence_interval || [];
            return statCard("Sen's slope",
                `${esc(withUnit(fmtSigned(res.slope), unit))} / year`,
                `${esc(withUnit(fmtSigned(res.slope * 10), unit))} per decade · 95% CI [${fmt(ci[0])}, ${fmt(ci[1])}] / year${res.exact === false ? ' · from a sample of value pairs' : ''}`,
                res.significant);
        }
        if (name === 'Change Point') {
            const row = rows.find((rw) => rw.year === res.x_after);
            return statCard('Change point',
                `${esc(row ? row.label : String(Math.floor(res.x_after)))}`,
                `level ${esc(withUnit(fmt(res.mean_before), unit))} → ${esc(withUnit(fmt(res.mean_after), unit))} (${esc(withUnit(fmtSigned(res.shift), unit))}) · ${pLabel(res.p_value)}${res.deseasonalised ? ' · seasonal cycle removed' : ''}`,
                res.significant);
        }
        if (name === 't-Test') {
            const splitRow = rows.find((row) => row.year === res.split_x);
            return statCard('t-Test (early vs. late)',
                `${esc(withUnit(fmtSigned(res.late_mean - res.early_mean), unit))}`,
                `early ${esc(withUnit(fmt(res.early_mean), unit))} → late ${esc(withUnit(fmt(res.late_mean), unit))}${splitRow ? ` (from ${esc(splitRow.label)})` : ''} · t ${fmt(res.t_statistic, 2)} · ${pLabel(res.p_value)}`,
                res.significant);
        }
        return statCard(name, 'done', '');
    }

    function pText(p) {
        return pLabel(p);
    }

    // "p 0.042", or "p < 0.001" instead of a rounded "p 0".
    function pLabel(p) {
        if (!isNum(p)) return '';
        return p < 0.001 ? 'p < 0.001' : `p ${fmt(p, 3)}`;
    }

    function sigMark(res) {
        return res && res.available ? (res.significant ? ' <span class="tp-sig" title="significant (p < 0.05)">*</span>' : '') : '';
    }

    // Per-year results of a period time frame: one row per year, one column per tool.
    function yearTable(win, unit) {
        const cols = win.tools.map((t) => `<th title="${esc(TOOL_HELP[t] || '')}">${esc(TOOL_SHORT[t] || t)}${t === 'Linear Regression' ? ' (per day)' : ''}</th>`).join('');
        const body = win.years.map((yr) => {
            const cells = win.tools.map((t) => {
                if (!yr.complete) return '<td class="tp-muted">incomplete year</td>';
                const res = yr.res && yr.res[t];
                if (!res) return `<td class="tp-muted">${win.analysis && win.analysis.pending ? '…' : '–'}</td>`;
                if (!res.available) return `<td class="tp-muted">${esc(res.error || 'n/a')}</td>`;
                if (t === 'Linear Regression') {
                    return `<td>${esc(withUnit(fmtSigned(res.slope), unit))}${sigMark(res)}<span class="tp-cell-sub">${esc(withUnit(fmtSigned(res.slope * win.lengthDays), unit))} over the period · R² ${fmt(res.r_squared, 2)} · ${pText(res.p_value)}</span></td>`;
                }
                if (t === 'Mann-Kendall') {
                    return `<td>${esc(res.trend)}${sigMark(res)}<span class="tp-cell-sub">τ ${fmt(res.tau, 2)} · ${pText(res.p_value)}</span></td>`;
                }
                if (t === 't-Test') {
                    return `<td>${esc(withUnit(fmtSigned(res.late_mean - res.early_mean), unit))}${sigMark(res)}<span class="tp-cell-sub">2nd half vs. 1st half · ${pText(res.p_value)}</span></td>`;
                }
                if (t === "Sen's Slope") {
                    return `<td>${esc(withUnit(fmtSigned(res.slope), unit))}${sigMark(res)}<span class="tp-cell-sub">per day · robust</span></td>`;
                }
                if (t === 'Change Point') {
                    return `<td>day ${fmt(res.x_after, 0)}${sigMark(res)}<span class="tp-cell-sub">${esc(withUnit(fmtSigned(res.shift), unit))} · ${pText(res.p_value)}</span></td>`;
                }
                return '<td></td>';
            }).join('');
            return `<tr><td>${esc(yr.label)}</td><td>${yr.n}</td><td>${esc(withUnit(fmt(yr.mean), unit))}</td>${cells}</tr>`;
        }).join('');
        return `<div class="tp-table-wrap"><table class="tp-table tp-year-table"><thead><tr><th>Year</th><th>Values</th><th>Mean</th>${cols}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    // Summary cards of a period time frame: how the per-year results compare over the years.
    function yearSummaryCards(win, unit) {
        const cards = [];
        const done = win.years.filter((yr) => yr.res);
        const lrs = done.map((yr) => yr.res['Linear Regression']).filter((res) => res && res.available);
        if (lrs.length) {
            const up = lrs.filter((res) => res.slope > 0);
            const sig = lrs.filter((res) => res.significant);
            const m = mean(lrs.map((res) => res.slope));
            cards.push(statCard(`Linear regression inside ${win.label}`,
                `${esc(withUnit(fmtSigned(m), unit))} per day`,
                `mean slope of ${lrs.length} years (≈ ${esc(withUnit(fmtSigned(m * win.lengthDays), unit))} over the period) · rising in ${up.length} of ${lrs.length} years, ${sig.length} significant`));
        }
        const mks = done.map((yr) => yr.res['Mann-Kendall']).filter((res) => res && res.available);
        if (mks.length) {
            const inc = mks.filter((res) => res.trend === 'increasing').length;
            const dec = mks.filter((res) => res.trend === 'decreasing').length;
            cards.push(statCard('Mann-Kendall', `${inc} ↑ · ${dec} ↓`, `significant trend inside the period in ${inc + dec} of ${mks.length} years (increasing / decreasing)`));
        }
        const tts = done.map((yr) => yr.res['t-Test']).filter((res) => res && res.available);
        if (tts.length) {
            const diffs = tts.map((res) => res.late_mean - res.early_mean);
            cards.push(statCard('t-Test (2nd vs. 1st half)', `${esc(withUnit(fmtSigned(mean(diffs)), unit))}`, `mean difference over ${tts.length} years · significant in ${tts.filter((res) => res.significant).length}`));
        }
        return cards;
    }

    // Chart of the regression slope inside the period, one point per year with its 95% CI.
    function slopeChartSpec(wins, unit) {
        const withLr = wins.filter((win) => win.period && win.years.some((yr) => yr.res && yr.res['Linear Regression'] && yr.res['Linear Regression'].available));
        if (!withLr.length) return null;
        const series = [];
        const legend = [];
        const all = [];
        withLr.forEach((win, i) => {
            const shift = (i - (withLr.length - 1) / 2) * 0.12;
            const pts = win.years
                .map((yr) => ({ yr, res: yr.res && yr.res['Linear Regression'] }))
                .filter((q) => q.res && q.res.available)
                .map((q) => ({ x: q.yr.year + shift, y: q.res.slope, lo: q.res.confidence_interval[0], hi: q.res.confidence_interval[1], meta: { label: `${win.label} ${q.yr.label}`, res: q.res } }));
            all.push(...pts.map((q) => q.x));
            series.push({ id: `ci${win.w.id}`, kind: 'whisker', name: '95% CI', color: `${win.color}55`, width: 3, points: pts, hover: false });
            series.push({ id: `sl${win.w.id}`, kind: 'line', name: `${win.label} slope`, color: win.color, width: 1.2, dash: '2,3', points: pts, markers: 4.5, gap: 1.5, hollow: (q) => !q.meta.res.significant });
            legend.push({ name: `${win.label}: slope inside the period per year`, color: win.color, style: 'dot' });
        });
        legend.push({ name: 'Filled: significant (p < 0.05) · hollow: not significant · bar: 95% CI', color: COLOR.reference, style: 'hollow' });
        const lo = Math.min(...all);
        const hi = Math.max(...all);
        const domain = [Math.floor(lo) - 0.6, Math.ceil(hi) + 0.6];
        // "per day" in words, so rate units (mm/day) don't read as "mm/day/day".
        const perDay = unit ? `${unit} per day` : 'per day';
        return {
            kind: 'year', height: 210, xDomain: domain,
            xTicks: (plotW, shown = domain) => {
                const ys = [];
                for (let y = Math.ceil(shown[0]); y <= Math.floor(shown[1]); y++) ys.push(y);
                const every = Math.max(1, Math.ceil(ys.length / Math.max(2, Math.floor(plotW / 44))));
                return ys.filter((_, k) => k % every === 0).map((y) => ({ v: y, label: String(y) }));
            },
            formatX: (x) => String(Math.round(x)),
            series, bands: [], legend, unit: perDay, yInclude: [0],
            tooltipExtra: (row) => (row.meta ? `${row.meta.label} · R² ${fmt(row.meta.res.r_squared, 2)} · ${pLabel(row.meta.res.p_value)}` : ''),
            ariaLabel: 'Regression slope inside the period, per year',
        };
    }

    // One block per analysis time frame: what the tools ran on and their results.
    function renderAnalysis(model, wins) {
        const r = state.refs;
        const unit = model.unit;
        const slopeSpec = slopeChartSpec(wins, unit);
        let html = '';
        if (slopeSpec) {
            html += `<div class="tp-analysis-block"><div class="tp-analysis-title">Linear regression inside each period, year by year</div>
                <div class="tp-analysis-note">Each point is the slope of the regression over the values inside one year's period (e.g. 1–31 January ${esc(String(model.years[0] || ''))}), not a regression between years.</div>
                <div class="tp-chart tp-slope-chart" data-ref-slope></div><div class="tp-legend">${legendHtml(slopeSpec.legend)}</div></div>`;
        }
        html += wins.map((win) => {
            const head = `<div class="tp-analysis-title"><span class="tp-window-dot" style="background:${win.color}"></span>${esc(win.label)}${win.period ? ` in ${win.years.length} year${win.years.length === 1 ? '' : 's'}` : `: ${win.rows.length} intervals`}${state.fn.anomaly ? ' (anomalies)' : ''}</div>`;
            let note;
            if (win.period) {
                const skipped = win.years.filter((yr) => !yr.complete).length;
                note = `The tools run inside every year's ${esc(win.label)} on its own (x = day within the period), so each year gets its own result.${win.period.wraps ? ' A period across New Year counts towards the year it ends in.' : ''}${skipped > 0 ? ` ${skipped} incomplete year${skipped === 1 ? ' is' : 's are'} not analysed.` : ''}`;
            } else {
                const deseason = win.results && Object.values(win.results).some((res) => res && res.deseasonalised);
                note = `The tools run on every interval of the whole series; slopes are per year.${deseason ? ' The seasonal cycle was removed before testing (the trend is the same, but the seasons no longer count as noise), so the t-test means are levels without the seasons.' : ''}`;
            }
            const cards = [];
            if (win.rows.length) {
                const vals = win.rows.map((row) => row.mean);
                cards.push(statCard(win.period ? `Mean of ${win.label}` : 'Mean', esc(withUnit(fmt(mean(vals)), unit)), `σ ${win.period ? 'between years ' : ''}${esc(withUnit(fmt(stdDev(vals)), unit))}`));
            }
            let extra = '';
            if (win.status) cards.push(mutedCard('Analysis tools', win.status));
            else if (!win.analysis || win.analysis.pending) cards.push(mutedCard('Analysis tools', 'Running…'));
            else if (win.analysis.error) cards.push(mutedCard('Analysis tools', `Not available: ${win.analysis.error}`));
            else if (win.period) {
                const acrossRes = win.across && !win.across.pending && !win.across.error ? pickTools(win.across.tools, win.tools) : null;
                const acrossCards = acrossRes
                    ? win.tools.filter((name) => acrossRes[name]).map((name) => toolCard(name, acrossRes[name], win.rows, unit))
                    : [mutedCard('Across years', win.rows.length < 3 ? 'Needs at least three complete years.' : win.across && win.across.error ? `Not available: ${win.across.error}` : 'Running…')];
                extra = `<div class="tp-analysis-sub">Change across the years: one mean of ${esc(win.label)} per year, slopes per year</div>`
                    + `<div class="tp-stats">${acrossCards.join('')}</div>`
                    + `<div class="tp-analysis-sub">Inside each year's ${esc(win.label)} (x = day within the period). These slopes mostly show the seasonal shape, e.g. spring warming; turn on <em>Anomaly</em> to see departures from normal instead.</div>`
                    + `<div class="tp-stats">${yearSummaryCards(win, unit).join('')}</div>`
                    + yearTable(win, unit);
            } else for (const name of win.tools) if (win.results[name]) cards.push(toolCard(name, win.results[name], win.rows, unit));
            return `<div class="tp-analysis-block" style="--tp-win:${win.color}">${head}<div class="tp-analysis-note">${note}</div><div class="tp-stats">${cards.join('')}</div>${extra}</div>`;
        }).join('');
        r.analysis.innerHTML = html || '<div class="tp-analysis-note">Add a time frame under “Analyses” to run the tools.</div>';
        const slopeHost = r.analysis.querySelector('[data-ref-slope]');
        if (slopeHost && slopeSpec) renderChart(slopeHost, slopeSpec);
    }

    window.TrendPlots = { mount, setData, setLoading, focusDate, focusExample };
})();
