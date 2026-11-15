/*
 * TrendDetective plot panel (below the map).
 *
 * Plots every series of the last request, one collapsible section per series
 * (each key of visualization.topics), in one of three views shared by all:
 *   - Timeline: the whole series; the analysis periods (e.g. every January)
 *     are shaded in every year.
 *   - Years overlaid: every year as its own line on a Jan..Dec axis.
 *   - Period across years: one value per year (the mean of a time frame,
 *     e.g. January) for every analysis time frame.
 * Analyses: any number of time frames (whole series, a month, a season, the
 * whole year or a custom DD.MM – DD.MM range), each with its own selection of
 * the analysis tools of src/task.py. For a period a tool runs inside every
 * year's period on its own; the per-year lines are drawn into the plot and the
 * slopes are compared year by year below it.
 * Functions: anomaly (deviation from the multi-year mean of the same time of
 * year), moving average, multi-year mean ± 1σ, zoom to period.
 *
 * Public API (window.TrendPlots):
 *   mount(element)                       build the panel inside `element`
 *   setData(visualization, userRequest)  data from the 'Apply' response
 *   setLoading(boolean)
 *   focusDate(iso[, topicKey]), focusExample(iso, preferCodes, topic)
 *   showSeries(topicKey)                 open a series' section and scroll to it
 *
 * Server calls: GET /api/topics (labels), GET /api/tools, POST /api/analyze.
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

    // Analysis time frames: presets (months, seasons, whole year) and a custom DD.MM range.
    const PERIOD_PRESETS = [
        { id: 'year', label: 'Whole year (annual mean)', start: [1, 1], end: [12, 31] },
        ...MONTH_NAMES.map((name, i) => ({ id: `m${i + 1}`, label: name, start: [i + 1, 1], end: [i + 1, i === 1 ? 29 : MONTH_DAYS[i]], group: 'Months' })),
        { id: 'djf', label: 'Winter (Dec–Feb)', start: [12, 1], end: [2, 29], group: 'Seasons' },
        { id: 'mam', label: 'Spring (Mar–May)', start: [3, 1], end: [5, 31], group: 'Seasons' },
        { id: 'jja', label: 'Summer (Jun–Aug)', start: [6, 1], end: [8, 31], group: 'Seasons' },
        { id: 'son', label: 'Autumn (Sep–Nov)', start: [9, 1], end: [11, 30], group: 'Seasons' },
        { id: 'custom', label: 'Custom (DD.MM – DD.MM)…' },
    ];

    const DEFAULT_TOOLS = ['Linear Regression', 'Mann-Kendall'];
    const TOOL_SHORT = { 'Linear Regression': 'Linear regression', 'Mann-Kendall': 'Mann-Kendall', 't-Test': 't-Test', "Sen's Slope": "Sen's slope", 'Change Point': 'Change point' };
    const TOOL_HELP = {
        'Linear Regression': 'Straight line through the values: the average change per year.',
        'Mann-Kendall': 'Does the series keep going up (or down)? Robust to outliers; says nothing about the size.',
        "Sen's Slope": 'Median of the slopes between all pairs of values: a trend that single extremes cannot pull.',
        'Change Point': 'Pettitt test: the moment where the level of the series shifted most clearly.',
        't-Test': 'Compares the mean of the first half with the second half.',
    };
    // Notable events (events.py): symbol, marker colour and neutral label per kind.
    const EVENT_STYLE = {
        record_high: { icon: '▲', color: '#a1452f', label: 'Record high' },
        record_low: { icon: '▼', color: '#2f5f8f', label: 'Record low' },
        high: { icon: '↑', color: '#b5654c', label: 'Positive anomaly' },
        low: { icon: '↓', color: '#4f7ba6', label: 'Negative anomaly' },
        warm_spell: { icon: '▬', color: '#a1452f', label: 'Warm spell' },
        cold_spell: { icon: '▬', color: '#2f5f8f', label: 'Cold spell' },
    };
    // One colour per analysis time frame (distinct from the blue data series and the year ramp).
    const WINDOW_COLORS = ['#eb6834', '#1a9e74', '#c2399b', '#8f6a00', '#6250d6', '#d1394a'];

    const VIEWS = [
        { id: 'timeline', label: 'Timeline' },
        { id: 'overlay', label: 'Years overlaid' },
        { id: 'period', label: 'Period across years' },
    ];

    // Collapsible blocks inside every topic section.
    const SUBS = [
        { id: 'summary', label: 'Data summary' },
        { id: 'analysis', label: 'Statistical analysis' },
        { id: 'events', label: 'Notable events' },
        { id: 'evolution', label: 'Change over time' },
    ];

    const state = {
        root: null,
        refs: {},
        viz: null,
        request: null,
        view: 'timeline',
        fn: { anomaly: false, ma: false, maWindow: 3, clim: false, zoom: false },
        tools: DEFAULT_TOOLS.slice(),
        // Analysis time frames: frame is 'all' (whole series) or a PERIOD_PRESETS id.
        windows: [{ id: 1, frame: 'all', custom: { start: '01.06', end: '31.08' }, tools: DEFAULT_TOOLS.slice() }],
        nextWindowId: 2,
        loading: false,
        analysisCache: new Map(),
        // Human labels of the topics (GET /api/topics -> details).
        labels: {},
        labelsVersion: 0,
        // Per series key: zoom, hidden years, active event, collapsed state, … (see topicState).
        per: new Map(),
        // Per series key: the section element and its refs (built once, reused).
        sections: new Map(),
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
                    const key = JSON.stringify([model.key, state.tools, seasonLength, rows.map((row) => [row.year, row.mean])]);
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
                const key = JSON.stringify([model.key, state.tools, 'groups', groups]);
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
                const acrossKey = JSON.stringify([model.key, state.tools, 'across', rows.map((row) => [row.year, row.mean])]);
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

    // Models depend only on the data and the request, so they are cached per series.
    let modelCache = { viz: null, request: null, map: new Map() };

    function buildModel(topic) {
        if (modelCache.viz !== state.viz || modelCache.request !== state.request) {
            modelCache = { viz: state.viz, request: state.request, map: new Map() };
        }
        const info = state.viz && state.viz.topics && state.viz.topics[topic];
        if (!info) return null;
        const hit = modelCache.map.get(topic);
        if (hit && hit.info === info) return hit;
        const model = computeModel(topic, info);
        modelCache.map.set(topic, model);
        return model;
    }

    function computeModel(topic, info) {
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
            key: topic, ps: topicState(topic),
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
        return list.map((ev, i) => ({ ...ev, n: i + 1, style: EVENT_STYLE[ev.kind] || EVENT_STYLE.high, label: eventLabel(ev) }));
    }

    // "Record high", "Warm spell (5 d)", …; spells of non-temperature series are "runs" above / below normal.
    function eventLabel(ev) {
        const style = EVENT_STYLE[ev.kind] || EVENT_STYLE.high;
        if (ev.kind === 'warm_spell' || ev.kind === 'cold_spell') {
            const temp = /warm|cold/i.test(ev.title || '');
            const base = temp ? style.label : ev.kind === 'warm_spell' ? 'Run above normal' : 'Run below normal';
            return isNum(ev.days) ? `${base} (${ev.days} d)` : base;
        }
        return style.label;
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
            if (best) marks.push({ x: best.x, y: best.y, n: ev.n, color: ev.style.color, active: model.ps.activeEvent === ev.n, title: `${ev.label}: ${fmtIsoDate(ev.date)}` });
            if (ev.end) {
                bands.push({ x0: isoToTime(ev.date), x1: isoToTime(ev.end) + DAY_MS, fill: ev.kind === 'cold_spell' ? 'rgba(47, 95, 143, 0.10)' : 'rgba(161, 69, 47, 0.09)' });
            }
        }
        return { marks, bands };
    }

    // Light wash of a time frame's colour, e.g. '#eb6834' -> 'rgba(235, 104, 52, 0.10)'.
    function wash(hex, alpha = 0.1) {
        const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return COLOR.accentWash;
        const n = parseInt(m[1], 16);
        return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    // Analysis time frames with a (valid) period, e.g. January; their windows are shaded in the plots.
    function periodWindows(wins) {
        return (wins || []).filter((win) => win.period && !win.period.invalid);
    }

    function buildTimeline(model, wins) {
        const series = [];
        const legend = [];
        const unit = model.unit;
        const pts = model.points.map((p) => ({ x: p.t, y: transformed(model, p), meta: p }));
        const gap = model.stepDays * DAY_MS * 1.6;
        const markers = pts.length <= 120;
        const shaded = periodWindows(wins);

        const bands = [];
        for (const win of shaded) {
            const period = win.period;
            const [sm, sd] = period.start;
            const [em, ed] = period.end;
            const y0 = new Date(model.domain[0]).getUTCFullYear() - 1;
            const y1 = new Date(model.domain[1]).getUTCFullYear();
            for (let y = y0; y <= y1; y++) {
                const endYear = period.wraps ? y + 1 : y;
                const lastDay = Math.min(ed, new Date(Date.UTC(endYear, em, 0)).getUTCDate());
                const x0 = Math.max(model.domain[0], Date.UTC(y, sm - 1, Math.min(sd, new Date(Date.UTC(y, sm, 0)).getUTCDate())));
                const x1 = Math.min(model.domain[1], Date.UTC(endYear, em - 1, lastDay) + DAY_MS);
                if (x1 > x0) bands.push({ x0, x1, fill: wash(win.color, 0.09) });
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
        });
        legend.unshift({ name: state.fn.anomaly ? 'Anomaly' : ({ 1: 'Daily value' })[model.stepDays] || 'Interval mean', color: COLOR.series, style: 'line' });
        for (const win of shaded) legend.push({ name: `${win.label} (shaded)`, color: win.color, style: 'band-color' });

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
        if (ev.marks.length) legend.push({ name: 'Notable events (numbered as in the list below)', color: EVENT_STYLE.record_high.color, style: 'hollow' });
        return {
            kind: 'time',
            xDomain: model.domain,
            xTicks: timeTicks(model.domain),
            formatX: (x) => timeLabel(model, x),
            series, bands: bands.concat(ev.bands), legend, unit,
            eventMarks: ev.marks,
            yInclude: state.fn.anomaly ? [0] : [],
            tooltipExtra: (row) => (row.meta && row.meta.label ? `interval from ${row.meta.label}` : ''),
            table: tableFrom(['Interval start', 'Mid date', state.fn.anomaly ? `Anomaly${unit ? ` (${unit})` : ''}` : `Value${unit ? ` (${unit})` : ''}`, ...shaded.map((win) => `In ${win.label}`)],
                pts.map((p) => [p.meta.label, ddmmyyyy(p.x), p.y, ...shaded.map((win) => (inPeriod(p.meta, win.period) ? 'yes' : ''))])),
        };
    }

    function buildOverlay(model, wins) {
        const unit = model.unit;
        const shaded = periodWindows(wins);
        // The first analysis period decides where a year starts (Dec–Feb: in December) and the zoom.
        const usePeriod = shaded.length ? shaded[0].period : null;
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
        const visibleYears = allYears.filter((y) => !model.ps.hiddenYears.has(y));
        const latest = visibleYears[visibleYears.length - 1];

        const series = [];
        const bands = [];
        if (!state.fn.zoom) {
            for (const win of shaded) {
                const a = xOf(yearPos(win.period.start[0], win.period.start[1]));
                const b = xOf(yearPos(win.period.end[0], win.period.end[1])) + 1;
                bands.push({ x0: a, x1: b > a ? b : b + YEAR_DAYS, fill: wash(win.color, 0.09) });
            }
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
                // Years are keyed by the first analysis period's season year; a point decides which line it belongs to.
                const lineYear = yr.pts.length ? seasonYear(model.points.find((p) => p.t === yr.pts[0].t), usePeriod) : yr.year;
                if (model.ps.hiddenYears.has(lineYear)) continue;
                for (const piece of fittedPieces(yr, lr, (q) => xOf(q.pos))) {
                    series.push({ id: `win${win.w.id}-${yr.year}-${drawn}`, kind: 'line', name: `${win.label} ${yr.label}: regression`, color: yearColor(colorModel, lineYear), width: 2.5, dash: '6,3', points: piece.filter((q) => inDomain(q.x)), hover: false });
                    drawn += 1;
                }
            }
        }

        const legend = allYears.map((y) => ({
            name: seasonYearLabel(y, usePeriod), color: yearColor(colorModel, y), style: 'line', toggleYear: y,
            pressed: !model.ps.hiddenYears.has(y),
        }));
        if (state.fn.clim && model.years.length >= 2) legend.push({ name: `Multi-year mean ± 1σ${model.monthly ? '' : ` (${CLIM_SMOOTH_DAYS}-day window)`}`, color: COLOR.reference, style: 'band' });
        if (!state.fn.zoom) for (const win of shaded) legend.push({ name: `${win.label} (shaded)`, color: win.color, style: 'band-color' });
        if ((wins || []).some((win) => win.period && win.years.some((yr) => yr.res && yr.res['Linear Regression'] && yr.res['Linear Regression'].available))) {
            legend.push({ name: 'Dashed: regression inside each year\u2019s period', color: COLOR.reference, style: 'dash' });
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
                    mean: periodMean, sd: v.length > 1 ? stdDev(v) : null, min: v.length ? v.reduce((a, b) => Math.min(a, b)) : null, max: v.length ? v.reduce((a, b) => Math.max(a, b)) : null,
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
        if (rows.some((r) => !r.complete)) legend.push({ name: 'Incomplete year (under half of the period has data; not analysed)', color: COLOR.series, style: 'hollow' });

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
        if (wins.some((win) => win.allRows.some((row) => !row.complete))) legend.push({ name: 'Incomplete year (under half of the period has data; not analysed)', color: COLOR.series, style: 'hollow' });
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

    let clipSeq = 0;

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
        // Every chart needs its own clip-path id: with a shared one the browser clips
        // all charts on the page with the first chart's rectangle.
        if (!host._clipId) host._clipId = `tp-clip-${++clipSeq}`;
        const drawn = svgFor(spec, width);
        const svg = drawn.svg.replace(/tp-clip\b/g, host._clipId);
        const geom = drawn.geom;
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
        const bottom = spec.xLabel ? 46 : 30;
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
        // y-axis title: a full label ("Daily air temperature [°C]") left-aligned, or just the unit.
        if (spec.yLabel) out += `<text class="tp-axis-title" x="4" y="${top - 9}" text-anchor="start">${esc(spec.yLabel)}</text>`;
        else if (spec.unit) out += `<text class="tp-axis-title" x="${left - 7}" y="${top - 9}" text-anchor="end">${esc(spec.unit)}</text>`;
        if (spec.xLabel) out += `<text class="tp-axis-title" x="${f(left + plotW / 2)}" y="${top + plotH + 36}" text-anchor="middle">${esc(spec.xLabel)}</text>`;
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

    const ZOOM_HELP = 'Drag across the plot to zoom in. Scroll with the bar below it (or Shift + wheel); double-click to reset.';
    const ANALYSES_HELP = "For a period such as January, each tool runs inside every year's January on its own; the results are compared year by year.";
    const SUMMARY_HELP = 'Figures of the values as measured (the Anomaly transform does not apply here). Years only partly inside the time range, or with less than three quarters of their values, are listed but not ranked.';
    const OVERVIEW_HELP = 'Change: linear trend of every series over the whole time range (for daily to monthly data the seasonal cycle is left out of the significance test). “× year-to-year spread” divides the change over the whole range by the standard deviation of the annual means, so series in different units can be compared. Links: Pearson correlation of the values at the same time; for daily to monthly data the seasonal cycle is removed first (anomalies), otherwise summer and winter alone would make most pairs correlate. p-values account for autocorrelation.';
    const EVENTS_HELP ='Ordered by how far they depart from normal. Normal: mean of the same time of year over all years; anomaly = value − normal; z = anomaly in standard deviations of that time of year; percentile among all values. Select a row to zoom the plot to the event.';

    // A small "?" that shows `text` on hover and keyboard focus (CSS tooltip, see plots.css).
    function help(text) {
        if (!text) return '';
        const t = esc(text);
        return `<span class="tp-help" tabindex="0" role="img" aria-label="${t}" data-tip="${t}">?</span>`;
    }

    // Keeps a "?" tooltip inside the viewport: shift it sideways and open it below near the top.
    function placeHelpTip(evt) {
        const h = evt.target && evt.target.closest ? evt.target.closest('.tp-help') : null;
        if (!h) return;
        const r = h.getBoundingClientRect();
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const w = Math.min(280, vw - 16);
        const centre = r.left + r.width / 2;
        let shift = 0;
        if (centre - w / 2 < 8) shift = 8 - (centre - w / 2);
        else if (centre + w / 2 > vw - 8) shift = vw - 8 - (centre + w / 2);
        h.style.setProperty('--tp-tip-shift', `${Math.round(shift)}px`);
        h.classList.toggle('tp-help-below', r.top < 150);
    }
    document.addEventListener('pointerover', placeHelpTip);
    document.addEventListener('focusin', placeHelpTip);

    // Human label of a series key: "precipitation" -> "Daily precipitation",
    // "temperature · average (TAVG)" -> "Daily air temperature · average (TAVG)".
    function topicLabel(key) {
        const k = String(key ?? '');
        const d = state.labels || {};
        if (d[k] && d[k].label) return d[k].label;
        const i = k.indexOf(' · ');
        if (i > 0) {
            const base = k.slice(0, i);
            if (d[base] && d[base].label) return `${d[base].label}${k.slice(i)}`;
        }
        return k;
    }

    function topicState(key) {
        let ps = state.per.get(key);
        if (!ps) {
            ps = { hiddenYears: new Set(), zoom: null, activeEvent: null, showTable: false, lastTable: null, lastView: 'timeline', collapsed: false, open: {} };
            state.per.set(key, ps);
        }
        return ps;
    }

    function topicKeys() {
        return state.viz && state.viz.topics ? Object.keys(state.viz.topics) : [];
    }

    function hasValues(key) {
        const info = state.viz && state.viz.topics && state.viz.topics[key];
        return Boolean(info && Array.isArray(info.values) && info.values.some(isNum));
    }

    function firstWithData() {
        return topicKeys().find(hasValues) || null;
    }

    // The heavy blocks are open for the first series with data, closed for the others, until toggled.
    // The data summary starts closed everywhere (the overview at the top already gives the gist).
    function isSubOpen(key, sub) {
        const v = topicState(key).open[sub];
        if (v !== undefined) return v;
        return sub === 'summary' ? false : key === firstWithData();
    }

    // Topic keys the request asked for (user_request.topics is {key: bool} or a list).
    function requestedTopics() {
        const t = state.request && state.request.topics;
        if (Array.isArray(t)) return t.map(String);
        if (t && typeof t === 'object') return Object.keys(t).filter((k) => t[k]);
        return [];
    }

    function siteText(model) {
        const info = model.info;
        const st = info.station;
        if (st && (st.name || st.id)) return st.name || st.id;
        if (info.region && info.region.name) return `${info.region.name} (area mean${isNum(info.station_count) ? ` of ${info.station_count} stations` : ''})`;
        if (Array.isArray(info.coordinates)) return `${fmt(Number(info.coordinates[0]), 2)}°, ${fmt(Number(info.coordinates[1]), 2)}°`;
        return '';
    }

    function yearsText(model) {
        const y = model.years;
        if (!y.length) return '';
        return y[0] === y[y.length - 1] ? String(y[0]) : `${y[0]}–${y[y.length - 1]}`;
    }

    // First sentence of an error message, for the availability list.
    function shortReason(text) {
        let t = String(text || 'No data in the selected time range.').replace(/\s+/g, ' ').trim();
        const m = /^(.+?[.!?])(\s|$)/.exec(t);
        if (m) t = m[1];
        return t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t;
    }

    function hasPeriodWindow() {
        return state.windows.some((w) => {
            if (w.frame === 'all') return false;
            const p = presetPeriod(w.frame, w.custom);
            return p && !p.invalid;
        });
    }

    let renderQueued = false;
    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; render(); });
    }

    const TEMPLATE = `
        <div class="tp-head">
            <h3 class="tp-title" data-ref="title">Plots</h3>
            <span class="tp-subtitle" data-ref="subtitle"></span>
        </div>
        <ul class="tp-avail" data-ref="avail" aria-label="Data availability"></ul>
        <section class="tp-overview" data-ref="overview" aria-label="Overview of all series" hidden></section>
        <div class="tp-controls">
            <div class="tp-field">View<div class="tp-segmented" role="group" aria-label="Plot view" data-ref="views">
                ${VIEWS.map((v) => `<button type="button" data-view="${v.id}">${v.label}</button>`).join('')}
            </div></div>
        </div>
        <div class="tp-chips" data-ref="functions">
            <span class="tp-chip-label">Transform</span>
            <button type="button" class="tp-chip" data-fn="anomaly" title="Subtract the multi-year mean of the same time of year (needs ≥ 2 years)">Anomaly</button>
            <button type="button" class="tp-chip" data-fn="ma" title="Centred moving average">Moving average
                <input type="number" min="2" max="60" step="1" data-ref="maWindow" aria-label="Moving average window"></button>
            <button type="button" class="tp-chip" data-fn="clim" title="Mean and ±1 standard deviation over all years (needs ≥ 2 years)">Multi-year mean ± σ</button>
            <button type="button" class="tp-chip" data-fn="zoom" title="Years overlaid: show only the first analysis period">Zoom to period</button>
        </div>
        <div class="tp-windows" data-ref="windows" aria-label="Analysis time frames"></div>
        <div class="tp-topics" data-ref="topics"></div>
        <div class="tp-compare" data-ref="compare"></div>`;

    function mount(element) {
        state.root = element;
        element.classList.add('tp-root');
        element.innerHTML = TEMPLATE;
        const refs = {};
        element.querySelectorAll('[data-ref]').forEach((el) => { refs[el.dataset.ref] = el; });
        state.refs = refs;
        state.sections.clear();

        refs.views.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-view]');
            if (!b || b.disabled) return;
            state.view = b.dataset.view;
            // The view needs a period: add January (like a new time frame) so it is never empty.
            if (state.view === 'period' && !hasPeriodWindow()) {
                state.windows.push({ id: state.nextWindowId++, frame: 'm1', custom: { start: '01.06', end: '31.08' }, tools: ['Linear Regression'] });
                renderWindowsEditor();
            }
            render();
        });
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
        const onGoto = (e) => {
            if (e.target.closest('button[data-goto-compare]')) {
                if (refs.compare) refs.compare.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            const b = e.target.closest('button[data-goto]');
            if (!b) return;
            const key = b.dataset.goto;
            topicState(key).collapsed = false;
            if (b.dataset.open) topicState(key).open[b.dataset.open] = true;
            render();
            scrollToTopic(key, 0);
        };
        refs.avail.addEventListener('click', onGoto);
        refs.overview.addEventListener('click', onGoto);
        refs.windows.addEventListener('click', (e) => {
            // A "?" inside a tool's label must not toggle the checkbox.
            if (e.target.closest('.tp-help')) { e.preventDefault(); return; }
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

        fetch('/api/tools')
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                if (body && Array.isArray(body.tools) && body.tools.length) {
                    state.tools = body.tools.slice();
                    renderWindowsEditor();
                    scheduleRender();
                }
            })
            .catch(() => {});
        fetch('/api/topics')
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                if (body && body.details && typeof body.details === 'object') {
                    state.labels = body.details;
                    state.labelsVersion += 1;
                    scheduleRender();
                }
            })
            .catch(() => {});
        renderWindowsEditor();
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
            const tools = state.tools.map((t) => `<label class="tp-tool${w.tools.includes(t) ? ' is-on' : ''}"><input type="checkbox" data-tool="${esc(t)}"${w.tools.includes(t) ? ' checked' : ''}>${esc(TOOL_SHORT[t] || t)}${help(TOOL_HELP[t])}</label>`).join('');
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
        host.innerHTML = `<div class="tp-windows-head"><span class="tp-chip-label">Analyses</span>${help(ANALYSES_HELP)}</div>
            ${rows}
            <button type="button" class="tp-link-btn tp-window-add" data-action="add">+ Add time frame</button>`;
    }

    function setData(visualization, userRequest) {
        const newRequest = (userRequest || null) !== state.request;
        state.viz = visualization || null;
        state.request = userRequest || null;
        // A new request: forget zoom, hidden years and the selected event (collapsed state stays).
        if (newRequest) {
            for (const ps of state.per.values()) {
                ps.hiddenYears.clear();
                ps.activeEvent = null;
                ps.zoom = null;
            }
        }
        render();
    }

    function setLoading(on) {
        state.loading = Boolean(on);
        // A new 'Apply' starts: the old data goes, the new one streams in topic by topic.
        if (on) {
            state.viz = null;
            state.request = null;
        }
        render();
    }

    // ------------------------------------------------------------ sections

    let sectionSeq = 0;

    function sectionHtml(id) {
        const subs = SUBS.map((sub) => `<div class="tp-sub" data-r="${sub.id}Sub">
                <div class="tp-sub-head">
                    <button type="button" class="tp-sub-toggle" data-r="${sub.id}Toggle" aria-expanded="false" aria-controls="${id}-${sub.id}"><span class="tp-chev" aria-hidden="true"></span>${esc(sub.label)}</button>
                    <span data-r="${sub.id}Help">${sub.id === 'events' ? help(EVENTS_HELP) : sub.id === 'summary' ? help(SUMMARY_HELP) : ''}</span>
                </div>
                <div class="tp-sub-body tp-${sub.id}" id="${id}-${sub.id}" data-r="${sub.id}"></div>
            </div>`).join('');
        return `<div class="tp-topic-head">
                <h4 class="tp-topic-title" data-r="title"></h4>
                <span class="tp-topic-meta" data-r="meta"></span>
                <button type="button" class="tp-topic-toggle" data-r="toggle" aria-expanded="true" aria-controls="${id}-body">−</button>
            </div>
            <div class="tp-topic-error" data-r="error" hidden></div>
            <div class="tp-topic-body" id="${id}-body" data-r="body">
                <div data-r="hint"></div>
                <div class="tp-fig-head" data-r="figHead"></div>
                <div class="tp-chart" data-r="chart"></div>
                <div class="tp-legend" data-r="legend"></div>
                <div class="tp-table-wrap" data-r="table" hidden></div>
                <div class="tp-footer" data-r="footer">
                    <span class="tp-footer-note">Zoom ${help(ZOOM_HELP)}</span>
                    <button type="button" class="tp-link-btn" data-r="tableBtn">Show table</button>
                    <button type="button" class="tp-link-btn" data-r="csvBtn">Download CSV</button>
                </div>
                ${subs}
            </div>`;
    }

    // The section of one series; built once and reused, so charts and "Change over time" keep their state.
    function ensureSection(key) {
        let sec = state.sections.get(key);
        if (sec) return sec;
        const id = `tp-sec-${++sectionSeq}`;
        const el = document.createElement('section');
        el.className = 'tp-topic';
        el.dataset.topic = key;
        el.innerHTML = sectionHtml(id);
        const refs = { section: el };
        el.querySelectorAll('[data-r]').forEach((node) => { refs[node.dataset.r] = node; });
        const ps = topicState(key);

        refs.toggle.addEventListener('click', () => { ps.collapsed = !ps.collapsed; render(); });
        for (const sub of SUBS) {
            refs[`${sub.id}Toggle`].addEventListener('click', () => {
                ps.open[sub.id] = !isSubOpen(key, sub.id);
                render();
            });
        }
        const onEventClick = (e) => {
            const sat = e.target.closest('button[data-sat]');
            if (sat) {
                // index.html draws the image on the map (NASA GIBS).
                document.dispatchEvent(new CustomEvent('trendplots:satellite', { detail: { date: sat.dataset.sat } }));
                return;
            }
            const fd = e.target.closest('button[data-focus]');
            if (fd) {
                focusDate(fd.dataset.focus, key);
                return;
            }
            const b = e.target.closest('[data-event]');
            if (!b) return;
            focusEvent(key, Number(b.dataset.event));
            refs.chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        refs.events.addEventListener('click', onEventClick);
        refs.summary.addEventListener('click', onEventClick);
        refs.legend.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-year]');
            if (!b) return;
            const y = Number(b.dataset.year);
            if (e.altKey || e.metaKey) {
                // Alt/Cmd-click: show only this year (or all again).
                const all = [...refs.legend.querySelectorAll('button[data-year]')].map((x) => Number(x.dataset.year));
                const solo = ps.hiddenYears.size === all.length - 1 && !ps.hiddenYears.has(y);
                ps.hiddenYears = new Set(solo ? [] : all.filter((v) => v !== y));
            } else if (ps.hiddenYears.has(y)) ps.hiddenYears.delete(y);
            else ps.hiddenYears.add(y);
            render();
        });
        refs.tableBtn.addEventListener('click', () => { ps.showTable = !ps.showTable; render(); });
        refs.csvBtn.addEventListener('click', () => downloadCsv(key));
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => layoutChart(refs.chart)).observe(refs.chart);
        }
        sec = { el, refs };
        state.sections.set(key, sec);
        return sec;
    }

    function dropSection(key) {
        const sec = state.sections.get(key);
        if (!sec) return;
        clearEvolution(sec.refs.evolution);
        sec.el.remove();
        state.sections.delete(key);
    }

    function render() {
        const r = state.refs;
        if (!r.topics) return;
        if (document.activeElement !== r.maWindow) r.maWindow.value = state.fn.maWindow;
        const keys = topicKeys();
        const models = keys.map((k) => buildModel(k)).filter(Boolean);

        renderHead(models);
        renderAvailability(keys);
        renderOverview(models);
        setControlStates(models);

        for (const key of [...state.sections.keys()]) if (!keys.includes(key)) dropSection(key);
        if (!keys.length) {
            // Nothing analysed yet: data-tp-idle hides the whole card (static/mode.css).
            r.topics.innerHTML = state.loading ? '<div class="tp-empty">Loading data…</div>' : '<div class="tp-empty" data-tp-idle></div>';
            renderCompare();
            return;
        }
        r.topics.querySelectorAll(':scope > .tp-empty').forEach((el) => el.remove());
        keys.forEach((key, i) => {
            const sec = ensureSection(key);
            if (r.topics.children[i] !== sec.el) r.topics.insertBefore(sec.el, r.topics.children[i] || null);
            try {
                renderTopic(key, sec.refs);
            } catch (err) {
                sec.refs.body.hidden = false;
                sec.refs.hint.innerHTML = `<div class="tp-hint">This series could not be drawn: ${esc(err.message || err)}</div>`;
                if (window.console) console.error(err);
            }
        });
        renderCompare();
    }

    function renderHead(models) {
        const r = state.refs;
        const m = models[0];
        const req = state.request || {};
        const range = Array.isArray(req.timeintervall) ? req.timeintervall.join(' – ') : '';
        r.subtitle.textContent = [
            m ? `${m.ivText} intervals` : '',
            range,
            state.loading && models.length ? 'loading more…' : '',
        ].filter(Boolean).join(' · ');
    }

    // One line per series without data at the top: ✗ with the reason, or … while it loads.
    function renderAvailability(keys) {
        const host = state.refs.avail;
        const items = keys.map((key) => {
            const model = buildModel(key);
            const label = topicLabel(key);
            // Series with data have their own section; only problems are listed here.
            if (model && model.points.length) return '';
            const reason = (model && model.info.error) || 'No values in the selected time range.';
            return `<li class="tp-avail-item is-failed"><button type="button" class="tp-avail-btn" data-goto="${esc(key)}" title="${esc(reason)}">`
                + `<span class="tp-avail-mark" aria-hidden="true">✗</span><span class="tp-visually-hidden">No data: </span>`
                + `<span class="tp-avail-name">${esc(label)}</span><span class="tp-avail-meta">${esc(shortReason(reason))}</span></button></li>`;
        });
        // Requested topics that have not arrived yet (topics stream in one by one).
        for (const t of requestedTopics()) {
            if (keys.some((k) => k === t || k.startsWith(`${t} · `))) continue;
            items.push(`<li class="tp-avail-item ${state.loading ? 'is-pending' : 'is-failed'}"><span class="tp-avail-btn">`
                + `<span class="tp-avail-mark" aria-hidden="true">${state.loading ? '…' : '✗'}</span>`
                + `<span class="tp-avail-name">${esc(topicLabel(t))}</span><span class="tp-avail-meta">${state.loading ? 'loading…' : 'no answer from the server'}</span></span></li>`);
        }
        const shown = items.filter(Boolean);
        host.innerHTML = shown.join('');
        host.hidden = !shown.length;
    }

    function renderTopic(key, refs) {
        const model = buildModel(key);
        const ps = model.ps;
        const label = topicLabel(key);
        refs.title.textContent = label;
        refs.meta.textContent = [model.unit, siteText(model), yearsText(model), model.points.length ? `${model.points.length.toLocaleString('en-US')} values` : ''].filter(Boolean).join(' · ');

        // No values (e.g. no station found): a compact section that says why.
        if (!model.points.length) {
            refs.section.classList.add('is-failed');
            refs.meta.textContent = 'no data';
            refs.toggle.hidden = true;
            refs.body.hidden = true;
            refs.chart._spec = null;
            refs.error.hidden = false;
            refs.error.innerHTML = `<span class="tp-x" aria-hidden="true">✗</span>${esc(model.info.error || 'No numeric values in the selected time range.')}`;
            clearEvolution(refs.evolution);
            return;
        }
        refs.section.classList.remove('is-failed');
        refs.error.hidden = true;
        refs.toggle.hidden = false;
        refs.toggle.textContent = ps.collapsed ? '+' : '−';
        refs.toggle.setAttribute('aria-expanded', String(!ps.collapsed));
        refs.toggle.setAttribute('aria-label', `${ps.collapsed ? 'Expand' : 'Collapse'} ${label}`);
        refs.toggle.title = ps.collapsed ? 'Expand' : 'Collapse';
        refs.body.hidden = ps.collapsed;
        if (ps.collapsed) {
            // Nothing to lay out while hidden; drawn again when expanded.
            refs.chart._spec = null;
            return;
        }

        const canCompare = model.canCompare && model.years.length >= 2;
        const wins = evaluateWindows(model);
        // Period across years: every analysis time frame with a period.
        const periodWins = wins.filter((win) => win.period && win.allRows.length);
        let view = canCompare ? state.view : 'timeline';
        if (view === 'period' && !periodWins.length) view = 'timeline';

        const hints = [];
        if (model.info.error) hints.push(model.info.error);
        if (model.unit === 'mm/day') hints.push('Precipitation is shown as a density: the average rainfall per day (mm/day) in each interval. Monthly or yearly totals and multiday totals (MDPR) are divided by the number of days they cover, so 3 mm/day over a month means about 90 mm in that month.');
        else if (model.unit === '% of days') hints.push('Share of days in each interval on which precipitation reached the threshold, e.g. 50 % = every second day.');
        if (model.info.dropped_intervals > 0) hints.push(`${model.info.dropped_intervals} interval${model.info.dropped_intervals === 1 ? ' was' : 's were'} left out because data covered less than three quarters of their days; their means would bias the trend.`);
        if (!model.canCompare) hints.push(`Comparing years needs intervals of up to 2 months (now ${model.ivText}).`);
        else if (model.years.length < 2) hints.push('The time range covers only one year; choose several years to compare them.');
        else if (state.view === 'period' && view !== 'period') hints.push('No analysis period has data here; showing the timeline.');
        refs.hint.innerHTML = hints.map((h) => `<div class="tp-hint"><span class="tp-hint-label">Note</span>${esc(h)}</div>`).join('');

        let spec;
        if (view === 'overlay') spec = buildOverlay(model, wins);
        else if (view === 'period' && periodWins.length > 1) spec = buildPeriodMulti(model, periodWins);
        else if (view === 'period') spec = buildPeriod(model, periodWins[0].period, null, periodWins[0].color);
        else spec = buildTimeline(model, wins);
        const anomaly = state.fn.anomaly && model.anomalyOk;
        const unitPart = model.unit ? ` [${model.unit}]` : '';
        spec.yLabel = anomaly ? `Anomaly${unitPart}` : `${label}${unitPart}`;
        spec.xLabel = view === 'overlay' ? 'Day of year' : view === 'period' ? 'Year' : 'Date';
        spec.ariaLabel = `${label}: ${VIEWS.find((v) => v.id === view).label}`;
        ps.lastTable = spec.table;
        ps.lastView = view;

        // Drag-to-zoom: keep the zoomed range while the view and full range stay the same.
        const fullDomain = spec.xDomain;
        const zoomKey = [view, fullDomain[0], fullDomain[1]].join('|');
        if (ps.zoom && ps.zoom.key === zoomKey) {
            spec.xDomain = ps.zoom.domain;
            spec.zoomed = true;
        } else {
            ps.zoom = null;
        }
        spec.fullDomain = fullDomain;
        refs.chart._onZoom = (domain) => {
            ps.zoom = domain ? { key: zoomKey, domain } : null;
            render();
        };
        // Scrolling only moves the visible window; the chart redraws itself (see panTo).
        refs.chart._onPan = (domain) => {
            ps.zoom = { key: zoomKey, domain };
        };

        refs.figHead.innerHTML = figureHead(model, view, periodWins);
        renderChart(refs.chart, spec);
        refs.legend.innerHTML = legendHtml(spec.legend);
        renderTable(refs, ps, spec.table);

        // The three heavy blocks: drawn only while open.
        const events = eventsOf(model);
        refs.eventsSub.hidden = !events.length;
        for (const sub of SUBS) {
            const open = isSubOpen(key, sub.id);
            refs[`${sub.id}Toggle`].setAttribute('aria-expanded', String(open));
            refs[sub.id].hidden = !open;
        }
        if (isSubOpen(key, 'summary')) renderDataSummary(model, wins, refs.summary);
        else refs.summary.innerHTML = '';
        if (isSubOpen(key, 'analysis')) renderAnalysis(model, wins, refs.analysis);
        else refs.analysis.innerHTML = '';
        if (events.length && isSubOpen(key, 'events')) renderEvents(model, refs.events);
        else refs.events.innerHTML = '';
        if (isSubOpen(key, 'evolution')) renderEvolution(model, wins, refs.evolution);
    }

    function scrollToTopic(key, delay = 80) {
        // Deferred, so it wins over a scroll the caller starts right after (index.html scrolls to the panel).
        setTimeout(() => {
            const sec = state.sections.get(key);
            if (sec) sec.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, delay);
    }

    // ------------------------------------------------------------ events list

    function renderEvents(model, host) {
        const list = eventsOf(model);
        if (!list.length) {
            host.innerHTML = '';
            return;
        }
        const ps = model.ps;
        const unit = model.unit;
        const rows = list.map((ev) => {
            const when = ev.end ? `${fmtIsoDate(ev.date)} – ${fmtIsoDate(ev.end)}` : fmtIsoDate(ev.date);
            const peak = ev.end && ev.peak_date ? `<span class="tp-cell-sub">peak ${esc(fmtIsoDate(ev.peak_date))}</span>` : '';
            const normal = isNum(ev.normal) ? `<span class="tp-cell-sub">normal ${esc(withUnit(fmt(ev.normal), unit))}</span>` : '';
            const sat = ev.peak_date || ev.date;
            const satellite = isoToTime(sat) >= Date.UTC(2000, 1, 24)
                ? `<button type="button" class="tp-link-btn tp-sat-btn" data-sat="${esc(sat)}" title="Show the NASA MODIS Terra true-colour image of ${esc(fmtIsoDate(sat))} on the map">Satellite image</button>` : '';
            return `<tr class="tp-event${ps.activeEvent === ev.n ? ' is-active' : ''}" data-event="${ev.n}" style="--tp-ev:${ev.style.color}" title="${esc(`${ev.title}: ${ev.description}`)}">
                <td><button type="button" class="tp-event-num-badge" data-event="${ev.n}" aria-label="Show event ${ev.n} in the plot">${ev.n}</button></td>
                <td class="tp-event-kind"><span class="tp-event-sym" aria-hidden="true">${esc(ev.style.icon)}</span>${esc(ev.label)}</td>
                <td class="tp-event-when">${esc(when)}${peak}</td>
                <td>${esc(withUnit(fmt(ev.value), unit))}${normal}</td>
                <td>${isNum(ev.anomaly) ? esc(withUnit(fmtSigned(ev.anomaly), unit)) : '–'}</td>
                <td>${isNum(ev.z) ? esc(signed1(ev.z)) : '–'}</td>
                <td>${isNum(ev.percentile) ? esc(fmt(ev.percentile, 1)) : '–'}</td>
                <td>${satellite}</td>
            </tr>`;
        }).join('');
        host.innerHTML = `<div class="tp-table-wrap tp-event-wrap"><table class="tp-table tp-event-table">
                <thead><tr><th>#</th><th class="tp-th-left">Type</th><th class="tp-th-left">Date</th><th>Value</th><th>Anomaly</th><th>z</th><th>Pctl.</th><th><span class="tp-visually-hidden">Satellite image</span></th></tr></thead>
                <tbody>${rows}</tbody></table></div>`;
    }

    // Zoom the timeline of one series to ±`days` around an event and mark it.
    function focusEvent(key, n, days = 45) {
        const model = buildModel(key);
        if (!model) return;
        const ev = eventsOf(model).find((e) => e.n === n);
        if (!ev) return;
        const ps = model.ps;
        ps.activeEvent = n;
        ps.collapsed = false;
        state.view = 'timeline';
        const first = isoToTime(ev.date);
        const last = isoToTime(ev.end || ev.date) + DAY_MS;
        const pad = Math.max(days * DAY_MS, model.stepDays * DAY_MS * 8);
        const domain = [Math.max(model.domain[0], first - pad), Math.min(model.domain[1], last + pad)];
        ps.zoom = { key: ['timeline', model.domain[0], model.domain[1]].join('|'), domain };
        render();
    }

    // Focus the event on (or nearest to) an ISO date in one series (default: the first with data).
    function focusDate(iso, topic) {
        const key = topic && hasValues(topic) ? topic : firstWithData();
        const model = key ? buildModel(key) : null;
        if (!model || !model.points.length) return false;
        const t = isoToTime(iso);
        let best = null;
        for (const ev of eventsOf(model)) {
            const d = Math.abs(isoToTime(ev.peak_date || ev.date) - t);
            if (d <= 7 * DAY_MS && (!best || d < best.d)) best = { ev, d };
        }
        if (best) {
            focusEvent(key, best.ev.n);
        } else {
            const ps = model.ps;
            ps.activeEvent = null;
            ps.collapsed = false;
            state.view = 'timeline';
            ps.zoom = { key: ['timeline', model.domain[0], model.domain[1]].join('|'), domain: [Math.max(model.domain[0], t - 45 * DAY_MS), Math.min(model.domain[1], t + 46 * DAY_MS)] };
            render();
        }
        scrollToTopic(key);
        return true;
    }

    // Choose the series whose events include `iso` (e.g. TMAX for a heat example) and focus it.
    // `topic` is a series key or a topic key such as "temperature" (then one of its series).
    function focusExample(iso, preferCodes, topic) {
        const keys = topicKeys();
        if (topic && keys.includes(topic) && hasValues(topic)) {
            topicState(topic).hiddenYears.clear();
            return focusDate(iso, topic);
        }
        let candidates = keys.filter(hasValues);
        if (!candidates.length) candidates = keys;
        if (topic) {
            const own = candidates.filter((k) => k === topic || k.startsWith(`${topic} · `));
            if (own.length) candidates = own;
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
        const ranked = candidates.slice().sort((a, b) => { const p = score(a); const q = score(b); return p[0] - q[0] || p[1] - q[1]; });
        if (!ranked.length) return false;
        topicState(ranked[0]).hiddenYears.clear();
        return focusDate(iso, ranked[0]);
    }

    // ------------------------------------------------------------ summary

    // One or two short lines about the whole series: trend, change point, most notable event.
    function summaryLines(model, wins) {
        const win = wins.find((w) => !w.period && w.results);
        if (!win || !model.points.length) {
            const pending = wins.some((w) => !w.period && w.analysis && w.analysis.pending);
            return pending ? '<p class="tp-muted">Calculating the trend…</p>' : '';
        }
        const res = win.results;
        const unit = model.unit;
        const lr = res['Linear Regression'];
        const sen = res["Sen's Slope"];
        const mk = res['Mann-Kendall'];
        const cp = res['Change Point'];
        const trend = lr && lr.available ? lr : sen && sen.available ? sen : null;
        const years = yearsText(model);
        const parts = [];
        const spanYears = (model.points[model.points.length - 1].t - model.points[0].t) / (365.2425 * DAY_MS);
        if (trend && spanYears < 2 && model.stepDays < 200) {
            parts.push('<span class="tp-summary-label">Note</span>Less than two years: a fitted slope mainly reflects the seasonal cycle, not a long-term change.');
        } else if (trend) {
            const perDecade = trend.slope * 10;
            const method = trend === lr ? 'Linear trend' : "Sen's slope";
            const what = state.fn.anomaly ? ' of the anomaly' : '';
            const evidence = isNum(trend.p_value) ? pLabel(trend.p_value) : '95 % CI excludes 0';
            let text = `<span class="tp-summary-label">Trend</span>${method}${what}, ${esc(years)}: <strong>${esc(withUnit(fmtSigned(perDecade), unit))} per decade</strong>`;
            if (trend.significant) text += ` (${evidence}, significant${mk && mk.available ? `; Mann-Kendall: ${esc(mk.trend)}` : ''}).`;
            else text += ` (${isNum(trend.p_value) ? `${evidence}, ` : ''}not significant${model.years.length < 20 ? `; ${model.years.length} years is short for a climate trend` : ''}).`;
            if (trend.deseasonalised) text += ' <span class="tp-muted">Seasonal cycle removed for the test.</span>';
            parts.push(text);
        }
        if (cp && cp.available && cp.significant) {
            const row = win.rows.find((rw) => rw.year === cp.x_after);
            parts.push(`<span class="tp-summary-label">Change point</span>Level shift of <strong>${esc(withUnit(fmtSigned(cp.shift), unit))}</strong> around ${esc(row ? row.label : String(Math.floor(cp.x_after)))} (Pettitt, ${pLabel(cp.p_value)}).`);
        }
        const top = eventsOf(model)[0];
        if (top) parts.push(`<span class="tp-summary-label">Extreme</span><button type="button" class="tp-inline-link" data-event="${top.n}">${esc(top.label)}, ${esc(fmtIsoDate(top.peak_date || top.date))}</button> (${esc(withUnit(fmt(top.value), unit))}${isNum(top.z) ? `, z = ${esc(signed1(top.z))}` : ''}).`);
        return parts.map((t) => `<p>${t}</p>`).join('');
    }

    // Words for the high and low end of a series: "Wettest" / "Driest", "Warmest" / "Coldest", …
    function extremeWords(key) {
        const k = String(key).toLowerCase();
        if (/temp|tmax|tmin|tavg/.test(k)) return ['Warmest', 'Coldest'];
        if (/snow/.test(k)) return ['Snowiest', 'Least snowy'];
        if (/prec|prcp|rain|mdpr/.test(k)) return ['Wettest', 'Driest'];
        if (/wind|gust/.test(k)) return ['Windiest', 'Calmest'];
        if (/sun/.test(k)) return ['Sunniest', 'Least sunny'];
        return ['Highest', 'Lowest'];
    }

    // One row per calendar year of the values as measured: mean, extremes, coverage.
    // `complete`: the whole year lies inside the time range and ≥ 75 % of its intervals have values.
    function yearStats(model) {
        if (model._yearStats) return model._yearStats;
        const byYear = new Map();
        for (const p of model.points) {
            if (!byYear.has(p.year)) byYear.set(p.year, []);
            byYear.get(p.year).push(p);
        }
        const yearly = model.stepDays >= 300;
        const rows = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, pts]) => {
            const y0 = Date.UTC(year, 0, 1);
            const y1 = Date.UTC(year + 1, 0, 1);
            const days = (y1 - y0) / DAY_MS;
            const whole = model.domain[0] <= y0 + DAY_MS && model.domain[1] >= y1 - DAY_MS;
            const expected = yearly ? 1 : Math.max(1, Math.round(days / model.stepDays));
            let hi = pts[0];
            let lo = pts[0];
            for (const p of pts) {
                if (p.value > hi.value) hi = p;
                if (p.value < lo.value) lo = p;
            }
            const m = mean(pts.map((p) => p.value));
            return { year, n: pts.length, expected, days, whole, complete: yearly || (whole && pts.length >= 0.75 * expected), mean: m, hi, lo };
        });
        model._yearStats = rows;
        return rows;
    }

    function isoOf(p) {
        return new Date(p.start).toISOString().slice(0, 10);
    }

    // When a single value happened, in words: "3 Jul 2015" for days, "Jul 2015" for months, …
    function whenText(model, p) {
        if (model.stepDays >= 300) return String(p.year);
        if (model.stepDays >= 28) return `${MONTHS[p.month - 1]} ${p.year}`;
        if (model.stepDays <= 1) return fmtIsoDate(isoOf(p));
        return `interval from ${fmtIsoDate(isoOf(p))}`;
    }

    // The "Data summary" drop-down below a series' plot: trend lines, key figures, year by year.
    function renderDataSummary(model, wins, host) {
        const unit = model.unit;
        const [hiWord, loWord] = extremeWords(model.key);
        const stepWord = model.stepDays <= 1 ? 'day' : model.stepDays >= 300 ? 'year' : model.stepDays >= 28 && model.stepDays <= 31 ? 'month' : 'interval';
        const pts = model.points;
        let hi = pts[0];
        let lo = pts[0];
        for (const p of pts) {
            if (p.value > hi.value) hi = p;
            if (p.value < lo.value) lo = p;
        }
        const overall = mean(pts.map((p) => p.value));
        const years = yearStats(model);
        const ranked = years.filter((y) => y.complete);
        const precip = unit === 'mm/day';
        const totalOf = (y) => y.mean * y.days;
        // Precipitation-like series with many zeros: "driest day = 0 mm" says nothing; count dry intervals instead.
        const dryCount = lo.value === 0 && hiWord === 'Wettest' && stepWord !== 'year';
        const dryOf = (y) => model.points.filter((p) => p.year === y.year && p.value === 0).length;
        const val = (v, d) => esc(withUnit(fmt(v, d), unit));
        const focusBtn = (p, text) => `<button type="button" class="tp-inline-link" data-focus="${isoOf(p)}" title="Show in the plot">${esc(text)}</button>`;

        const cards = [];
        cards.push(statCard('Mean of all values', val(overall), `${pts.length.toLocaleString('en-US')} values · ${esc(yearsText(model))}`));
        if (stepWord !== 'year') {
            cards.push(statCard(`${hiWord} ${stepWord}`, val(hi.value), focusBtn(hi, whenText(model, hi))));
            if (dryCount) {
                const n = pts.filter((p) => p.value === 0).length;
                cards.push(statCard(`Dry ${stepWord}s`, `${n.toLocaleString('en-US')} <span class="tp-stat-sub">of ${pts.length.toLocaleString('en-US')}</span>`, `${esc(fmt((100 * n) / pts.length, 0))} % without measurable precipitation`));
            } else cards.push(statCard(`${loWord} ${stepWord}`, val(lo.value), focusBtn(lo, whenText(model, lo))));
        }
        let hiYear = null;
        let loYear = null;
        if (ranked.length >= 2) {
            hiYear = ranked.reduce((a, b) => (b.mean > a.mean ? b : a));
            loYear = ranked.reduce((a, b) => (b.mean < a.mean ? b : a));
            const yearDetail = (y) => `${precip ? `≈ ${esc(fmt(totalOf(y), 0))} mm in the year · ` : ''}${esc(withUnit(fmtSigned(y.mean - overall), unit))} vs. the mean`;
            cards.push(statCard(`${hiWord} year`, `${hiYear.year} <span class="tp-stat-sub">${val(hiYear.mean)}</span>`, yearDetail(hiYear)));
            cards.push(statCard(`${loWord} year`, `${loYear.year} <span class="tp-stat-sub">${val(loYear.mean)}</span>`, yearDetail(loYear)));
        }
        if (ranked.length >= 3) {
            const sd = stdDev(ranked.map((y) => y.mean));
            cards.push(statCard('Year-to-year spread', `± ${val(sd)}`, `standard deviation of the annual means of ${ranked.length} complete years`));
        }
        // Seasonal cycle: the calendar month that is highest / lowest on average.
        if (model.canCompare && model.years.length >= 2 && model.stepDays <= 31) {
            const byMonth = Array.from({ length: 12 }, () => []);
            for (const p of pts) byMonth[p.month - 1].push(p.value);
            if (byMonth.every((a) => a.length)) {
                const means = byMonth.map(mean);
                const iHi = means.indexOf(Math.max(...means));
                const iLo = means.indexOf(Math.min(...means));
                cards.push(statCard('Seasonal cycle', `${MONTH_NAMES[iHi]} <span class="tp-stat-sub">${val(means[iHi])}</span>`,
                    `${hiWord.toLowerCase()} month on average; ${loWord.toLowerCase()}: ${MONTH_NAMES[iLo]} (${val(means[iLo])})`));
            }
        }

        // Year by year.
        let table = '';
        if (years.length >= 2 && stepWord !== 'year') {
            const head = `<tr><th>Year</th><th>Mean</th><th>vs. mean</th>${precip ? '<th title="Mean mm/day × days of the year">≈ Total</th>' : ''}<th>${esc(hiWord)} ${stepWord}</th><th>${dryCount ? `Dry ${stepWord}s` : `${esc(loWord)} ${stepWord}`}</th><th>Values</th></tr>`;
            const body = years.map((y) => {
                const tag = y === hiYear ? `<span class="tp-tag is-hi">${esc(hiWord.toLowerCase())}</span>` : y === loYear ? `<span class="tp-tag is-lo">${esc(loWord.toLowerCase())}</span>` : '';
                const note = y.complete ? '' : `<span class="tp-cell-sub">${y.whole ? 'too few values, not ranked' : 'part of the year only, not ranked'}</span>`;
                return `<tr class="${y.complete ? '' : 'is-muted'}"><td>${y.year}${tag}</td><td>${val(y.mean)}</td><td>${esc(fmtSigned(y.mean - overall))}</td>`
                    + `${precip ? `<td>${y.complete ? `${esc(fmt(totalOf(y), 0))} mm` : '–'}</td>` : ''}`
                    + `<td>${esc(fmt(y.hi.value))} ${focusBtn(y.hi, model.stepDays <= 1 ? fmtIsoDate(isoOf(y.hi)).replace(/ \d{4}$/, '') : MONTHS[y.hi.month - 1])}</td>`
                    + (dryCount ? `<td>${dryOf(y)}</td>` : `<td>${esc(fmt(y.lo.value))} ${focusBtn(y.lo, model.stepDays <= 1 ? fmtIsoDate(isoOf(y.lo)).replace(/ \d{4}$/, '') : MONTHS[y.lo.month - 1])}</td>`)
                    + `<td>${y.n}${y.expected > 1 ? ` / ${y.expected}` : ''}${note}</td></tr>`;
            }).join('');
            table = `<h5 class="tp-fig-title">Year by year</h5><div class="tp-table-wrap tp-years-wrap"><table class="tp-table tp-years-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
        }

        const st = model.info.station;
        const source = st && (st.name || st.id)
            ? `Station ${esc(st.name || st.id)}${st.id && st.name ? ` (${esc(st.id)})` : ''}${isNum(st.distance_km) ? `, ${esc(fmt(st.distance_km, 1))} km from the selected point` : ''}${st.source ? ` · source: ${esc(st.source)}` : ''}.`
            : siteText(model) ? `${esc(siteText(model))}.` : '';
        const lines = summaryLines(model, wins);
        host.innerHTML = `${lines ? `<div class="tp-summary-lines">${lines}</div>` : ''}`
            + `<div class="tp-stats">${cards.join('')}</div>${table}`
            + `${source ? `<p class="tp-source">${source}</p>` : ''}`;
    }

    // ------------------------------------------------------------ overview
    //
    // One box above all series: which series change the most, and which move together.
    // Trends come from /api/analyze (raw values, whole range), links from /api/correlate.

    const OV_TOOLS = ['Linear Regression', 'Mann-Kendall'];
    let ovCorr = { ctx: null, key: '', entry: null };

    function overviewTrend(model) {
        if (!model._ovKey) {
            const x = model.points.map((p) => +(1970 + p.t / (365.2425 * DAY_MS)).toFixed(5));
            const values = model.points.map((p) => p.value);
            const seasonLength = model.stepDays < 200 ? 1 : null;
            model._ovKey = JSON.stringify([model.key, OV_TOOLS, seasonLength, 'overview', x, values]);
            model._ovBody = { x, values, season_length: seasonLength };
        }
        if (!state.analysisCache.has(model._ovKey)) requestAnalysis(model._ovKey, model._ovBody);
        return state.analysisCache.get(model._ovKey);
    }

    function overviewCorrelation() {
        const ctx = compareContext();
        if (ovCorr.ctx === ctx) return ovCorr.entry;
        const usable = ctx.topics.filter((t) => t.points.length >= 5).slice(0, 8);
        ovCorr = { ctx, entry: null, anomalies: false };
        if (usable.length < 2 || state.loading) return null;
        const anomalies = !ctx.yearly && usable.every((t) => t.anomalyOk);
        let origin = Infinity;
        for (const t of usable) for (const p of t.points) if (p.start < origin) origin = p.start;
        const step = ctx.stepDays * DAY_MS;
        const series = usable.map((t) => {
            const pts = t.points.filter((p) => isNum(anomalies ? p.anomaly : p.value));
            return { name: t.name, x: pts.map((p) => Math.round((p.start - origin) / step)), values: pts.map((p) => (anomalies ? p.anomaly : p.value)) };
        });
        const entry = { pending: true, anomalies };
        ovCorr.entry = entry;
        fetch('/api/correlate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series, max_lag: 0 }) })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                entry.data = body;
            })
            .catch((err) => { entry.error = String(err.message || err); })
            .finally(() => { entry.pending = false; scheduleRender(); });
        return entry;
    }

    // Small line of the annual means of complete years.
    function sparkline(rows) {
        if (rows.length < 2) return '';
        const w = 84;
        const h = 22;
        const vs = rows.map((r) => r.mean);
        const lo = Math.min(...vs);
        const hi = Math.max(...vs);
        const sx = (i) => 2 + (i / (rows.length - 1)) * (w - 4);
        const sy = (v) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6));
        const d = rows.map((r, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(r.mean).toFixed(1)}`).join('');
        return `<svg class="tp-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    }

    // Bar from the centre: value in [-max, max].
    function divergingBar(v, max, cls) {
        const f = Math.max(-1, Math.min(1, v / max));
        const left = f < 0 ? 50 + f * 50 : 50;
        return `<span class="tp-dbar ${cls || ''}" aria-hidden="true"><span style="left:${left.toFixed(1)}%;width:${(Math.abs(f) * 50).toFixed(1)}%"></span></span>`;
    }

    function strengthWord(r) {
        const a = Math.abs(r);
        return a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'hardly any';
    }

    function renderOverview(models) {
        const host = state.refs.overview;
        if (!host) return;
        const withData = models.filter((m) => m.points.length >= 3);
        if (!withData.length) {
            if (host._html !== '') { host.innerHTML = ''; host._html = ''; }
            host.hidden = true;
            return;
        }
        // Trends, ranked: significant first, then by the size of the change against the year-to-year spread.
        const trends = withData.map((model) => {
            const a = overviewTrend(model);
            const lr = a && a.tools ? a.tools['Linear Regression'] : null;
            const ok = !!(lr && lr.available);
            const complete = yearStats(model).filter((y) => y.complete);
            const sd = complete.length >= 3 ? stdDev(complete.map((y) => y.mean)) : null;
            const span = (model.points[model.points.length - 1].t - model.points[0].t) / (365.2425 * DAY_MS);
            const change = ok ? lr.slope * span : null;
            const ratio = isNum(change) && isNum(sd) && sd > 0 ? change / sd : null;
            return { model, lr: ok ? lr : null, pending: !!(a && a.pending), error: a && a.error, change, ratio, span, complete };
        });
        const score = (t) => (isNum(t.ratio) ? Math.abs(t.ratio) : 0);
        trends.sort((a, b) => (!!b.lr - !!a.lr) || ((b.lr && b.lr.significant ? 1 : 0) - (a.lr && a.lr.significant ? 1 : 0)) || score(b) - score(a));

        const label = (key) => esc(topicLabel(key));
        const goto = (key, text) => `<button type="button" class="tp-ov-name" data-goto="${esc(key)}" data-open="summary" title="Open the data summary of this series">${text}</button>`;
        const rows = trends.map((t) => {
            const m = t.model;
            let trendCell;
            let changeCell;
            let evidence;
            if (t.lr) {
                const perDecade = t.lr.slope * 10;
                trendCell = `${esc(withUnit(fmtSigned(perDecade), m.unit))} <span class="tp-ov-sub">per decade</span>`;
                changeCell = isNum(t.ratio)
                    ? `${divergingBar(t.ratio, 2, t.lr.significant ? 'is-sig' : '')}<span class="tp-ov-num">${esc(fmtSigned(t.ratio, 1))}×</span>`
                    : `<span class="tp-ov-sub">${t.span < 2 ? 'under two years' : 'too few complete years'}</span>`;
                evidence = t.lr.significant
                    ? `<span class="tp-ov-sig">significant</span> <span class="tp-ov-sub">${esc(pLabel(t.lr.p_value))}</span>`
                    : `<span class="tp-ov-ns">not significant</span> <span class="tp-ov-sub">${esc(pLabel(t.lr.p_value))}</span>`;
            } else {
                const msg = t.pending ? 'calculating…' : t.error ? 'could not be calculated' : 'not available';
                trendCell = `<span class="tp-ov-sub">${msg}</span>`;
                changeCell = '';
                evidence = '';
            }
            return `<tr><th scope="row">${goto(m.key, label(m.key))}</th><td>${trendCell}</td><td class="tp-ov-change">${changeCell}</td><td>${evidence}</td><td class="tp-ov-spark">${sparkline(t.complete)}</td></tr>`;
        }).join('');

        // Headline sentences.
        const sent = [];
        const range = yearsText(withData[0]);
        const sig = trends.filter((t) => t.lr && t.lr.significant);
        const top = trends.find((t) => t.lr);
        const dir = (t) => (t.lr.slope > 0 ? 'rose' : 'fell');
        if (sig.length) {
            const t = sig[0];
            sent.push(`<strong>${label(t.model.key)}</strong> changed the most: it ${dir(t)} by ${esc(withUnit(fmt(Math.abs(t.lr.slope * 10)), t.model.unit))} per decade${isNum(t.ratio) ? `, ${esc(fmt(Math.abs(t.ratio), 1))} times its year-to-year spread over ${esc(range)}` : ''}.`);
            const others = trends.filter((x) => x.lr && !x.lr.significant);
            if (sig.length > 1) sent.push(`Significant trends also in ${sig.slice(1).map((x) => label(x.model.key)).join(', ')}.`);
            if (others.length) sent.push(`No significant trend in ${others.map((x) => label(x.model.key)).join(', ')}.`);
        } else if (top) {
            sent.push(`No series shows a significant trend over ${esc(range)}${withData.length > 1 ? `; the largest change is in <strong>${label(top.model.key)}</strong> (${esc(withUnit(fmtSigned(top.lr.slope * 10), top.model.unit))} per decade)` : ''}.`);
        }

        // Links between the series.
        let links = '';
        const corr = withData.length >= 2 ? overviewCorrelation() : null;
        if (withData.length >= 2) {
            if (!corr) {
                links = `<p class="tp-ov-sub">${state.loading ? 'Links between the series follow once every series has loaded.' : 'Needs two series with at least five values each.'}</p>`;
            } else if (corr.pending) {
                links = '<p class="tp-ov-sub">Calculating correlations…</p>';
            } else if (corr.error) {
                links = `<p class="tp-ov-sub">Correlations could not be calculated: ${esc(corr.error)}</p>`;
            } else {
                const pairs = corr.data.pairs.filter((p) => p.available && isNum(p.pearson)).sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson));
                const shown = pairs.slice(0, 6);
                const prow = (p) => `<tr><th scope="row">${label(p.a)} <span class="tp-ov-sub">and</span> ${label(p.b)}</th>`
                    + `<td class="tp-ov-change">${divergingBar(p.pearson, 1, p.significant ? 'is-sig' : '')}<span class="tp-ov-num">r = ${esc(fmtSigned(p.pearson, 2))}</span></td>`
                    + `<td>${esc(strengthWord(p.pearson))}${Math.abs(p.pearson) >= 0.2 ? (p.pearson > 0 ? ', move together' : ', move oppositely') : ''}</td>`
                    + `<td>${p.significant ? '<span class="tp-ov-sig">significant</span>' : '<span class="tp-ov-ns">not significant</span>'} <span class="tp-ov-sub">${esc(pLabel(p.p_value))}</span></td></tr>`;
                const what = corr.anomalies ? 'day-to-day departures from the seasonal normal' : 'values';
                links = pairs.length
                    ? `<table class="tp-ov-table"><caption>Strongest links (correlation of the ${corr.anomalies ? (withData[0].stepDays <= 1 ? 'day-to-day' : 'interval') + ' departures from the seasonal normal' : 'values'})</caption><tbody>${shown.map(prow).join('')}</tbody></table>`
                        + `${pairs.length > shown.length ? `<p class="tp-ov-sub">${pairs.length - shown.length} weaker pair${pairs.length - shown.length === 1 ? '' : 's'} not shown.</p>` : ''}`
                    : `<p class="tp-ov-sub">No pair of series overlaps enough to correlate the ${what}.</p>`;
                const best = pairs[0];
                if (best && Math.abs(best.pearson) >= 0.2) {
                    sent.push(`Strongest link: <strong>${label(best.a)}</strong> and <strong>${label(best.b)}</strong> ${best.pearson > 0 ? 'move together' : 'move in opposite directions'} (r = ${esc(fmtSigned(best.pearson, 2))}${best.significant ? '' : ', not significant'}).`);
                } else if (best) {
                    sent.push('The series hardly move together (all |r| < 0.2).');
                }
            }
        }

        const html = `<div class="tp-ov-head"><h4 class="tp-ov-title">Overview</h4>${help(OVERVIEW_HELP)}</div>`
            + `${sent.length ? `<p class="tp-ov-lede">${sent.join(' ')}</p>` : ''}`
            + `<div class="tp-ov-wrap"><table class="tp-ov-table"><caption>Change over ${esc(range)}, largest first</caption>`
            + `<thead><tr><th>Series</th><th>Trend</th><th title="Change over the whole time range divided by the year-to-year spread (standard deviation of the annual means)">vs. year-to-year spread</th><th>Evidence</th><th>Annual means</th></tr></thead>`
            + `<tbody>${rows}</tbody></table></div>`
            + `${links ? `<div class="tp-ov-wrap">${links}</div>` : ''}`;
        host.hidden = false;
        if (host._html !== html) {
            host.innerHTML = html;
            host._html = html;
        }
    }

    // A z-score always with one decimal and its sign: "+9.0", "−2.4".
    function signed1(v) {
        return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
    }

    // Short bold title of the main chart (the numbers are in the data summary below it).
    function figureHead(model, view, periodWins) {
        const label = topicLabel(model.key);
        const site = siteText(model);
        const years = yearsText(model);
        const at = site ? ` at ${site}` : '';
        const anomaly = state.fn.anomaly && model.anomalyOk;
        const title = view === 'period'
            ? `${label}${at}: ${periodWins.map((w) => w.label).join(', ')} mean per year, ${years}`
            : `${label}${anomaly ? ' anomaly' : ''}${at}, ${years}${view === 'overlay' ? ', years overlaid' : ''}`;
        return `<div class="tp-fig-title">${esc(title)}</div>`;
    }

    function setControlStates(models) {
        const r = state.refs;
        const any = models.some((m) => m.points.length);
        const canCompare = models.some((m) => m.points.length && m.canCompare && m.years.length >= 2);
        if (any && !canCompare) state.view = 'timeline';
        r.views.querySelectorAll('button').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
            b.disabled = !any || (b.dataset.view !== 'timeline' && !canCompare);
        });
        r.functions.querySelectorAll('button[data-fn]').forEach((b) => {
            const fn = b.dataset.fn;
            b.setAttribute('aria-pressed', String(Boolean(state.fn[fn])));
            let disabled = !any;
            if ((fn === 'anomaly' || fn === 'clim') && !canCompare) disabled = true;
            if (fn === 'zoom') disabled = !any || state.view !== 'overlay' || !hasPeriodWindow();
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
            else if (it.style === 'band-color') swatch = `<span class="tp-swatch tp-swatch-band" style="background:${wash(it.color, 0.18)};box-shadow:inset 0 0 0 1px ${wash(it.color, 0.6)}"></span>`;
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

    function renderTable(refs, ps, table) {
        refs.tableBtn.textContent = ps.showTable ? 'Hide table' : 'Show table';
        refs.tableBtn.setAttribute('aria-expanded', String(ps.showTable));
        refs.table.hidden = !ps.showTable;
        if (!ps.showTable || !table) return;
        refs.table.innerHTML = `<table class="tp-table"><thead><tr>${table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
            + `<tbody>${table.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(cell(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }

    function downloadCsv(key) {
        const ps = topicState(key);
        const table = ps.lastTable;
        if (!table) return;
        const q = (v) => {
            const s = isNum(v) ? String(v) : v === null || v === undefined ? '' : String(v);
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [table.columns, ...table.rows].map((row) => row.map(q).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `${(topicLabel(key) || 'data').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '')}_${ps.lastView}.csv`;
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
            .finally(scheduleRender);
    }

    function statCard(name, value, detail, flag) {
        const help = TOOL_HELP[name] || TOOL_HELP[Object.keys(TOOL_SHORT).find((k) => TOOL_SHORT[k] === name)] || '';
        const flagHtml = flag === undefined ? '' : `<span class="tp-stat-flag ${flag ? 'is-significant' : 'is-not-significant'}" title="${flag ? 'Significant at the 5 % level' : 'Not significant at the 5 % level'}">${flag ? 'significant, α = 0.05' : 'n.s.'}</span>`;
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

    // "p = 0.042", or "p < 0.001" instead of a rounded "p = 0".
    function pLabel(p) {
        if (!isNum(p)) return '';
        return p < 0.001 ? 'p < 0.001' : `p = ${fmt(p, 3)}`;
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
            cards.push(statCard('Mann-Kendall', `${inc} incr. · ${dec} decr.`, `significant trend inside the period in ${inc + dec} of ${mks.length} years (increasing / decreasing)`));
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
    function renderAnalysis(model, wins, host) {
        const unit = model.unit;
        const slopeSpec = slopeChartSpec(wins, unit);
        let html = '';
        if (slopeSpec) {
            html += `<div class="tp-analysis-block"><div class="tp-analysis-title">Slope inside each period, year by year${help(`Each point is the slope of the regression over the values inside one year's period (e.g. 1–31 January ${model.years[0] || ''}), not a regression between years.`)}</div>
                <div class="tp-chart tp-slope-chart" data-ref-slope></div><div class="tp-legend">${legendHtml(slopeSpec.legend)}</div></div>`;
        }
        html += wins.map((win) => {
            let note;
            if (win.period) {
                const skipped = win.years.filter((yr) => !yr.complete).length;
                note = `The tools run inside every year's ${win.label} on its own (x = day within the period), so each year gets its own result.${win.period.wraps ? ' A period across New Year counts towards the year it ends in.' : ''}${skipped > 0 ? ` ${skipped} incomplete year${skipped === 1 ? ' is' : 's are'} not analysed.` : ''}`;
            } else {
                const deseason = win.results && Object.values(win.results).some((res) => res && res.deseasonalised);
                note = `The tools run on every interval of the whole series; slopes are per year.${deseason ? ' The seasonal cycle was removed before testing (same trend, but the seasons no longer count as noise), so the t-test means are levels without the seasons.' : ''}`;
            }
            const head = `<div class="tp-analysis-title"><span class="tp-window-dot" style="background:${win.color}"></span>${esc(win.label)}${win.period ? ` · ${win.years.length} year${win.years.length === 1 ? '' : 's'}` : ` · ${win.rows.length.toLocaleString('en-US')} intervals`}${state.fn.anomaly ? ' (anomalies)' : ''}${help(note)}</div>`;
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
                extra = `<div class="tp-analysis-sub">Change across the years${help(`One mean of ${win.label} per year; slopes are per year.`)}</div>`
                    + `<div class="tp-stats">${acrossCards.join('')}</div>`
                    + `<div class="tp-analysis-sub">Inside each year's ${esc(win.label)}${help('x = day within the period. These slopes mostly show the seasonal shape, e.g. spring warming; turn on Anomaly to see departures from normal instead.')}</div>`
                    + `<div class="tp-stats">${yearSummaryCards(win, unit).join('')}</div>`
                    + yearTable(win, unit);
            } else for (const name of win.tools) if (win.results[name]) cards.push(toolCard(name, win.results[name], win.rows, unit));
            return `<div class="tp-analysis-block" style="--tp-win:${win.color}">${head}<div class="tp-stats">${cards.join('')}</div>${extra}</div>`;
        }).join('');
        host.innerHTML = html || '<div class="tp-analysis-note">Add a time frame under “Analyses” to run the tools.</div>';
        const slopeHost = host.querySelector('[data-ref-slope]');
        if (slopeHost && slopeSpec) renderChart(slopeHost, slopeSpec);
    }

    // ------------------------------------------------------- change over time
    //
    // The "Change over time" block (static/plots/evolution.js, window.TrendEvolution)
    // gets one frame per analysis time frame: one value per year plus, for a period,
    // the regression slope inside every year's period. One host per series.

    function annualRows(model) {
        if (model.stepDays >= 300) {
            // Yearly intervals: every interval already is one year.
            return model.points
                .map((p) => ({ year: p.year, label: String(p.year), mean: transformed(model, p), n: 1, expected: 1, complete: true, sd: null, min: null, max: null }))
                .filter((row) => isNum(row.mean));
        }
        if (!model.canCompare || model.years.length < 2) return [];
        return periodSeries(model, makePeriod([1, 1], [12, 31], 'Year'));
    }

    function evolutionContext(model, wins) {
        const frames = wins.map((win) => {
            const isPeriod = !!win.period;
            const rows = (isPeriod ? win.allRows : annualRows(model)).map((row) => ({
                year: row.year, label: row.label, value: row.mean, n: row.n, expected: row.expected,
                complete: row.complete, sd: isNum(row.sd) ? row.sd : null, min: row.min, max: row.max,
            }));
            const inside = isPeriod
                ? win.years
                    .map((yr) => ({ yr, res: yr.res && yr.res['Linear Regression'] }))
                    .filter((q) => q.res && q.res.available)
                    .map((q) => ({ year: q.yr.year, label: q.yr.label, slope: q.res.slope, lo: q.res.confidence_interval[0], hi: q.res.confidence_interval[1], p: q.res.p_value, significant: q.res.significant }))
                : null;
            return {
                id: win.w.id, label: isPeriod ? win.label : 'Annual mean', color: win.color, isPeriod,
                wraps: !!(win.period && win.period.wraps), lengthDays: win.lengthDays || null, rows, inside,
                insidePending: !!(isPeriod && win.analysis && win.analysis.pending),
            };
        }).filter((f) => f.rows.length);
        const st = model.info.station;
        return {
            topic: topicLabel(model.key), topicKey: model.key, unit: model.unit, anomaly: !!(state.fn.anomaly && model.anomalyOk),
            intervalText: model.ivText, stepDays: model.stepDays, station: st && st.name ? st.name : null,
            years: model.years.slice(), frames,
        };
    }

    function renderEvolution(model, wins, host) {
        if (!host) return;
        if (!window.TrendEvolution) { host.innerHTML = ''; return; }
        try {
            window.TrendEvolution.render(host, evolutionContext(model, wins));
        } catch (err) {
            host.innerHTML = `<div class="tp-hint">Change over time could not be drawn: ${esc(err.message || err)}</div>`;
        }
    }

    function clearEvolution(host) {
        if (!host) return;
        if (window.TrendEvolution && window.TrendEvolution.clear) window.TrendEvolution.clear(host);
        else host.innerHTML = '';
    }

    // ------------------------------------------------------ compare variables
    //
    // The "Compare variables" section (static/plots/compare.js, window.TrendCompare) gets
    // every series of the request with its values and anomalies. The context object is
    // rebuilt only when new data or labels arrive, so compare.js can skip redraws by identity.

    let compareCache = { viz: null, request: null, loading: null, labels: -1, ctx: null };

    function compareContext() {
        if (compareCache.ctx && compareCache.viz === state.viz && compareCache.request === state.request
            && compareCache.loading === state.loading && compareCache.labels === state.labelsVersion) {
            return compareCache.ctx;
        }
        const names = topicKeys();
        const topics = [];
        let stepDays = null;
        let domain = null;
        for (const name of names) {
            const model = buildModel(name);
            if (!model) continue;
            stepDays = stepDays ?? model.stepDays;
            if (model.points.length) {
                domain = domain ? [Math.min(domain[0], model.domain[0]), Math.max(domain[1], model.domain[1])] : model.domain.slice();
            }
            const info = model.info;
            const st = info.station;
            let site = '';
            if (st && (st.name || st.id)) site = `station ${st.name || st.id}`;
            else if (info.region && info.region.name) site = `area mean, ${info.region.name}`;
            topics.push({
                name, label: topicLabel(name), unit: model.unit, site, error: info.error || null,
                anomalyOk: model.anomalyOk,
                points: model.points.map((p) => {
                    const c = model.anomalyOk ? model.clim.get(model.bucketOf(p)) : null;
                    const normal = c ? (model.exactBuckets ? c.exact : c.mean) : null;
                    return { t: p.t, start: p.start, label: p.label, value: p.value, anomaly: isNum(normal) ? p.value - normal : null };
                }),
            });
        }
        const ctx = {
            topics, stepDays: stepDays || 1, domain, loading: state.loading,
            monthly: (stepDays || 1) >= 20, yearly: (stepDays || 1) >= 300,
        };
        compareCache = { viz: state.viz, request: state.request, loading: state.loading, labels: state.labelsVersion, ctx };
        return ctx;
    }

    function renderCompare() {
        const host = state.refs.compare;
        if (!host) return;
        if (!window.TrendCompare) { host.innerHTML = ''; return; }
        try {
            window.TrendCompare.render(host, compareContext());
        } catch (err) {
            host.innerHTML = `<div class="tp-hint">Compare variables could not be drawn: ${esc(err.message || err)}</div>`;
        }
    }

    // Open one series' section and scroll to it (the Simple cards' "Details" button).
    function showSeries(key) {
        if (!state.refs) return;
        topicState(key).collapsed = false;
        render();
        scrollToTopic(key, 0);
    }

    window.TrendPlots = {
        mount, setData, setLoading, focusDate, focusExample, showSeries,
        // Drawing helpers shared with evolution.js and compare.js, so every chart looks the same.
        kit: { renderChart, legendHtml, esc, fmt, fmtSigned, withUnit, pLabel, mean, stdDev, isNum, COLOR, timeTicks, niceStep, tickDecimals, help, topicLabel },
    };
})();
