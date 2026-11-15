/*
 * "Compare variables" section of the plot panel (between the main plot and "Change over time").
 *
 * plots.js calls window.TrendCompare.render(host, ctx) on every re-render of the
 * panel with every topic of the request (values and anomalies per interval). The
 * user picks the variables to compare; this file draws
 *
 *   combined   the chosen variables together in one plot (standardised or in original units)
 *   stacked    one plot per variable, stacked on a shared time axis (zoom is shared)
 *   matrix     Pearson r of every pair (three or more variables), click a cell to pick a pair
 *   scatter    a pair against each other, at the lag picked in the lag chart
 *   lags       lagged correlation: r of A(t) with B(t + k) for k = -L ... L
 *
 * Correlations come from POST /api/correlate (correlation.py). Any variables can be
 * combined, also ones where a correlation means little (e.g. wind direction): the
 * user decides what is worth comparing.
 *
 * Topics are identified by `name` (selection, pair, request); what the user reads is
 * `label` (falls back to `name`). Explanations sit behind the kit's "?" help icon.
 *
 * Rendering is idempotent: a signature of everything shown is compared with the
 * last one, so plots.js may call render() as often as it likes.
 */
(function () {
    'use strict';

    const API = '/api/correlate';
    const DAY_MS = 86400000;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // One colour per variable (distinct from each other; the first matches Fig. 1's series).
    const PALETTE = ['#2a78d6', '#eb6834', '#1a9e74', '#c2399b', '#8f6a00', '#6250d6', '#d1394a', '#52514e'];
    const MAX_SELECTED = 8; // correlation.MAX_SERIES
    const DEFAULT_SELECTED = 3;
    const LAG_CHOICES = [3, 6, 12, 24, 48];
    const DEFAULT_LAG = 12;
    const MIN_PAIRS_WARN = 10;
    const SCATTER_MAX_DRAWN = 6000;
    const CACHE_MAX = 40;

    const cache = new Map(); // request body (JSON) -> { pending } | { data, v } | { error, v }
    let version = 0;

    function kit() {
        return (window.TrendPlots && window.TrendPlots.kit) || null;
    }

    // ------------------------------------------------------------------ helpers

    function num(v) {
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    function pText(p) {
        if (num(p) === null) return 'p n/a';
        if (p < 0.001) return 'p < 0.001';
        return `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;
    }

    function rText(r) {
        return num(r) === null ? '–' : (r < 0 ? '−' : '') + Math.abs(r).toFixed(2);
    }

    // What the user reads for a topic (name stays the identity key).
    function lab(t) {
        return (t && (t.label || t.name)) || '';
    }

    function labelOf(ctx, name) {
        return lab(ctx.topics.find((t) => t.name === name)) || name;
    }

    function strengthOf(r) {
        const a = Math.abs(r);
        return a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'very weak';
    }

    function lagWord(ctx, k) {
        if (k === 0) return 'no lag';
        return `${k > 0 ? '+' : '−'}${Math.abs(k)} ${intervalWord(ctx, Math.abs(k) !== 1)}`;
    }

    // Cut a label to about `px` pixels of SVG text (≈ 6.3 px per character).
    function fitText(text, px) {
        const max = Math.max(4, Math.floor(px / 6.3));
        return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
    }

    function colorOf(ctx, name) {
        const i = ctx.topics.findIndex((t) => t.name === name);
        return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
    }

    // What one interval is called in sentences ("month", "day", "7-day interval").
    function intervalWord(ctx, plural) {
        const d = ctx.stepDays;
        let w;
        if (d <= 1) w = 'day';
        else if (Math.abs(d - 30.436875) < 1) w = 'month';
        else if (Math.abs(d - 365.2425) < 2) w = 'year';
        else w = `${Math.round(d)}-day interval`;
        return plural ? `${w}s` : w;
    }

    function formatTime(ctx, x) {
        const d = new Date(x);
        if (ctx.yearly) return String(d.getUTCFullYear());
        const mon = MONTHS[d.getUTCMonth()];
        return ctx.monthly ? `${mon} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
    }

    function linearTicks(K, lo, hi, count) {
        if (!(hi > lo)) { lo -= 1; hi += 1; }
        const step = K.niceStep((hi - lo) / count);
        const a = Math.floor(lo / step) * step;
        const b = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let k = 0; a + k * step <= b + step / 2; k++) ticks.push(a + k * step);
        const dec = K.tickDecimals(step);
        return { ticks, a, b, label: (v) => (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(dec).replace('-', '−') };
    }

    // The value of a point in the chosen series mode (anomaly only where the topic has one).
    function valueOf(st, topic, p) {
        if (st.mode === 'anomaly' && topic.anomalyOk) return num(p.anomaly);
        return num(p.value);
    }

    // Interval index of every point: x + 1 is the next interval for every topic of the request.
    function indexer(ctx) {
        let origin = Infinity;
        for (const t of ctx.topics) for (const p of t.points) if (p.start < origin) origin = p.start;
        const step = ctx.stepDays * DAY_MS;
        return (p) => Math.round((p.start - origin) / step);
    }

    // ------------------------------------------------------------------ server

    function remember(key, entry) {
        cache.set(key, entry);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }

    function request(host, st, key) {
        const have = cache.get(key);
        if (have) return have;
        const entry = { pending: true };
        remember(key, entry);
        fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                remember(key, { data: body, v: ++version });
            })
            .catch((err) => remember(key, { error: err.message || String(err), v: ++version }))
            .then(() => {
                if (st.key === key && st.ctx) render(host, st.ctx);
            });
        return entry;
    }

    // ------------------------------------------------------------------ render

    function render(host, ctx) {
        const K = kit();
        if (!host) return;
        if (!K || !ctx || ctx.topics.length < 2) {
            if (host._tc && host._tc.sig !== 'empty') { teardown(host); host.innerHTML = ''; host._tc.sig = 'empty'; }
            return;
        }
        const st = host._tc || (host._tc = {
            selected: [], touched: false, mode: null, axis: 'z', pair: null, maxLag: DEFAULT_LAG, lag: 0, zoom: null, sig: null,
        });
        if (st.ctx && st.ctx.domain && ctx.domain && (st.ctx.domain[0] !== ctx.domain[0] || st.ctx.domain[1] !== ctx.domain[1])) st.zoom = null;
        st.ctx = ctx;

        const withData = ctx.topics.filter((t) => t.points.length);
        const names = withData.map((t) => t.name);
        st.selected = st.selected.filter((n) => names.includes(n));
        // Topics stream in one by one: fill the default selection until the user changes it.
        if (!st.touched) for (const n of names) if (st.selected.length < DEFAULT_SELECTED && !st.selected.includes(n)) st.selected.push(n);
        const chosen = st.selected.map((n) => withData.find((t) => t.name === n));
        if (!st.mode) st.mode = 'value';
        const anomalyAny = chosen.some((t) => t.anomalyOk);

        // Correlation request for every chosen variable (all pairs at once).
        let key = null;
        let entry = null;
        if (chosen.length >= 2) {
            const idx = indexer(ctx);
            const body = {
                series: chosen.map((t) => {
                    const x = [];
                    const values = [];
                    for (const p of t.points) {
                        const v = valueOf(st, t, p);
                        if (v === null) continue;
                        x.push(idx(p));
                        values.push(v);
                    }
                    return { name: t.name, x, values };
                }),
                max_lag: st.maxLag,
            };
            key = JSON.stringify(body);
            entry = request(host, st, key);
        }
        st.key = key;
        if (!st.pair || !st.selected.includes(st.pair[0]) || !st.selected.includes(st.pair[1]) || st.pair[0] === st.pair[1]) {
            st.pair = chosen.length >= 2 ? [chosen[0].name, chosen[1].name] : null;
            st.lag = 0;
        }

        const sig = [ctx, key, entry ? (entry.pending ? 'p' : entry.v) : null, st.selected.join('|'), st.mode, st.axis, st.pair && st.pair.join('|'), st.maxLag, st.lag].map(String).join('§');
        if (sig === st.sig && host.querySelector('.tc-root') && host._tcCtx === ctx) return;
        st.sig = sig;
        host._tcCtx = ctx;

        const keepFocus = document.activeElement && host.contains(document.activeElement) ? document.activeElement.getAttribute('data-tc-focus') : null;
        teardown(host);
        host.innerHTML = sectionHtml(K, ctx, st, withData, chosen, anomalyAny, entry);
        bind(host, st);
        drawAll(K, host, ctx, st, chosen, entry);
        if (keepFocus) {
            const el = host.querySelector(`[data-tc-focus="${keepFocus}"]`);
            if (el) el.focus();
        }
    }

    function clear(host) {
        if (!host) return;
        teardown(host);
        host.innerHTML = '';
        if (host._tc) host._tc.sig = null;
    }

    function teardown(host) {
        if (host._tcObserver) { host._tcObserver.disconnect(); host._tcObserver = null; }
    }

    // ------------------------------------------------------------------ markup

    function pairResult(entry, pair) {
        if (!entry || !entry.data || !pair) return null;
        const [a, b] = pair;
        const direct = entry.data.pairs.find((p) => p.a === a && p.b === b);
        if (direct) return direct;
        const rev = entry.data.pairs.find((p) => p.a === b && p.b === a);
        if (!rev) return null;
        // Swap A and B: B(t) with A(t + k) equals A(t) with B(t − k).
        const lags = (rev.lags || []).map((l) => ({ ...l, lag: -l.lag })).reverse();
        return {
            ...rev, a, b, lags,
            best_lag: rev.best_lag ? { ...rev.best_lag, lag: -rev.best_lag.lag } : null,
            autocorrelation: (rev.autocorrelation || []).slice().reverse(),
        };
    }

    // Figure caption: a bold title of what is shown, an optional "?" and one short line of what the data says.
    function caption(K, title, helpText, text) {
        const help = (t) => (K.help ? K.help(t) : '');
        return `<figcaption><div class="tp-fig-title">${title}${helpText ? ` ${help(helpText)}` : ''}</div>${text ? `<p class="tp-fig-text">${text}</p>` : ''}</figcaption>`;
    }

    function sectionHtml(K, ctx, st, withData, chosen, anomalyAny, entry) {
        const { esc } = K;
        const help = (t) => (K.help ? K.help(t) : '');
        let html = '<section class="tc-root" aria-label="Compare variables">';
        html += `<header class="te-head"><h4 class="te-title">Compare variables ${help('See the chosen variables together, stacked on one time axis and correlated with each other, also with a time lag (does one lead the other?). Any variables can be combined; whether a comparison is meaningful (e.g. wind direction in degrees) is up to you.')}</h4>`
            + '</header>';

        if (withData.length < 2) {
            html += `<div class="te-state">${ctx.loading ? 'Waiting for more variables…' : 'At least two variables with data are needed to compare variables.'}</div>`;
            return `${html}</section>`;
        }

        // Controls: variables, series mode, axis of the combined plot.
        const chips = withData.map((t) => {
            const on = st.selected.includes(t.name);
            const full = !on && st.selected.length >= MAX_SELECTED;
            return `<button type="button" class="tc-var" data-tc-var="${esc(t.name)}" data-tc-focus="var-${esc(t.name)}" aria-pressed="${on}"${full ? ` disabled title="At most ${MAX_SELECTED} variables"` : ''} style="--tc-c:${colorOf(ctx, t.name)}"><span class="te-dot"></span>${esc(lab(t))}${t.unit ? ` <span class="tc-unit">${esc(t.unit)}</span>` : ''}</button>`;
        }).join('');
        html += `<div class="te-field"><span class="te-field-label" id="tc-var-label">Variables</span><div class="tc-vars" role="group" aria-labelledby="tc-var-label">${chips}</div></div>`;

        const seg = (attr, value, label, pressed, disabled, title) => `<button type="button" data-tc-${attr}="${value}" data-tc-focus="${attr}-${value}" aria-pressed="${pressed}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
        const anomalyHelp = 'Values: as measured, seasonal cycle included. Anomalies: departure from the multi-year mean of the same time of year, so the seasonal cycle is removed and a correlation is not just "both follow the seasons". Anomalies need ≥ 2 years and intervals of up to 2 months.';
        const axisHelp = 'Standardised: each variable minus its mean, divided by its standard deviation (unit σ), so variables with different units share one axis. Original units: all variables on one axis in their own units.';
        html += '<div class="te-controls">'
            + `<div class="te-field"><span class="te-field-label" id="tc-mode-label">Series ${help(anomalyHelp)}</span><div class="te-seg" role="group" aria-labelledby="tc-mode-label">${
                seg('mode', 'value', 'Values', st.mode === 'value' || !anomalyAny, false, 'As measured, seasonal cycle included')
                + seg('mode', 'anomaly', 'Anomalies', st.mode === 'anomaly' && anomalyAny, !anomalyAny, 'Departure from the multi-year mean of the same time of year')}</div></div>`
            + `<div class="te-field"><span class="te-field-label" id="tc-axis-label">Combined plot ${help(axisHelp)}</span><div class="te-seg" role="group" aria-labelledby="tc-axis-label">${
                seg('axis', 'z', 'Standardised (σ)', st.axis === 'z', false, 'Each variable minus its mean, divided by its standard deviation')
                + seg('axis', 'raw', 'Original units', st.axis === 'raw', false, 'All variables on one axis in their own units')}</div></div>`
            + '</div>';

        const noAnomaly = st.mode === 'anomaly' ? chosen.filter((t) => !t.anomalyOk) : [];
        if (noAnomaly.length) html += `<p class="te-note">No anomaly for ${esc(noAnomaly.map(lab).join(', '))}: values used.</p>`;

        if (!chosen.length) {
            html += '<div class="te-state">Pick at least one variable above.</div>';
            return `${html}</section>`;
        }

        const anomalyShown = st.mode === 'anomaly' && anomalyAny;
        const what = anomalyShown ? 'anomalies' : 'values';
        const units = [...new Set(chosen.map((t) => t.unit || ''))];
        const mixed = st.axis === 'raw' && units.length > 1;
        const n = chosen.length;
        const combinedTitle = `${n === 1 ? esc(lab(chosen[0])) : n === 2 ? `${esc(lab(chosen[0]))} and ${esc(lab(chosen[1]))}` : `All ${n} selected variables`}, ${st.axis === 'z' ? 'standardised' : 'original units'}`;
        const combinedText = mixed ? 'Mixed units on one axis: compare the shapes, not the levels.' : '';
        html += '<div class="tc-figs">';
        html += `<figure class="te-fig">${caption(K, combinedTitle, `${anomalyShown ? 'Anomalies' : 'Values'} of the chosen variables in one plot. ${axisHelp}`, esc(combinedText))}`
            + '<div class="tp-chart tc-chart" data-tc-chart="combined"></div><div class="tp-legend te-legend" data-tc-legend="combined"></div></figure>';

        const sites = new Set(chosen.map((t) => t.site || ''));
        html += `<figure class="te-fig">${caption(K, 'Each variable in its own unit', `${anomalyShown ? 'Anomalies' : 'Values'} of each variable, stacked on the same time axis. Drag across any plot to zoom all of them; double-click to reset.`)}`
            + chosen.map((t) => `<div class="tc-row">${sites.size > 1 && t.site ? `<div class="tc-row-head" style="--tc-c:${colorOf(ctx, t.name)}"><span class="te-dot"></span>${esc(lab(t))} <span class="tc-site">${esc(t.site)}</span></div>` : ''}<div class="tp-chart tc-chart tc-chart-row" data-tc-chart="row" data-tc-topic="${esc(t.name)}"></div></div>`).join('')
            + '</figure>';
        html += '</div>';

        html += correlationHtml(K, ctx, st, chosen, entry, what);
        return `${html}</section>`;
    }

    function correlationHtml(K, ctx, st, chosen, entry, what) {
        const { esc } = K;
        const help = (t) => (K.help ? K.help(t) : '');
        const methods = `Pearson r and Spearman ρ over the ${intervalWord(ctx, true)} where both variables have a value${st.mode === 'anomaly' ? ' (anomalies: departures from the multi-year mean of the same time of year)' : ''}. The p-values account for autocorrelation: two smooth series share fewer independent values than intervals, n_eff = n (1 − r1A·r1B) / (1 + r1A·r1B) with the lag-1 autocorrelations r1 (Bretherton et al. 1999). A correlation does not show cause and effect.`;
        let html = `<div class="tc-corr"><h5 class="tc-sub">Correlation ${help(methods)}</h5>`;
        if (chosen.length < 2) return `${html}<div class="te-state">Pick a second variable to correlate.</div></div>`;
        if (!entry || entry.pending) return `${html}<div class="te-state" role="status">Computing correlations…</div></div>`;
        if (entry.error) return `${html}<div class="te-state te-error" role="alert">The correlations could not be computed: ${esc(entry.error)}</div></div>`;

        const [a, b] = st.pair;
        const opts = (sel, other) => chosen.map((t) => `<option value="${esc(t.name)}"${t.name === sel ? ' selected' : ''}${t.name === other ? ' disabled' : ''}>${esc(lab(t))}</option>`).join('');
        html += '<div class="te-controls">'
            + `<label class="te-field"><span class="te-field-label">Variable A</span><select data-tc-pair="0" data-tc-focus="pair-0">${opts(a, b)}</select></label>`
            + '<button type="button" class="tp-link-btn tc-swap" data-tc-swap data-tc-focus="swap" title="Swap A and B">⇄ Swap</button>'
            + `<label class="te-field"><span class="te-field-label">Variable B</span><select data-tc-pair="1" data-tc-focus="pair-1">${opts(b, a)}</select></label>`
            + `<div class="te-field te-field-inline"><span class="te-field-label" id="tc-lag-label">Lags up to ±</span><div class="te-seg te-seg-small" role="group" aria-labelledby="tc-lag-label">${
                LAG_CHOICES.map((l) => `<button type="button" data-tc-maxlag="${l}" data-tc-focus="maxlag-${l}" aria-pressed="${l === st.maxLag}">${l}</button>`).join('')}</div><span class="te-field-unit">${esc(intervalWord(ctx, true))}</span></div>`
            + '</div>';

        if (chosen.length >= 3) html += matrixHtml(K, ctx, st, chosen, entry);

        const res = pairResult(entry, st.pair);
        if (!res || !res.available) {
            return `${html}<div class="te-state">${esc((res && res.error) || 'No result for this pair.')}</div></div>`;
        }
        const ta = chosen.find((t) => t.name === a);
        const tb = chosen.find((t) => t.name === b);
        const la = lab(ta);
        const lb = lab(tb);
        html += `<p class="te-headline">${headline(K, ctx, res, la, lb)}</p>`;
        html += factsHtml(K, ctx, res);
        const notes = [];
        if (res.n < MIN_PAIRS_WARN) notes.push(`Only ${res.n} ${intervalWord(ctx, true)} with both values: a rough indication only.`);
        if (ta.site && tb.site && ta.site !== tb.site) notes.push(`${la}: ${ta.site}; ${lb}: ${tb.site}.`);
        const seasonal = st.mode !== 'anomaly' || !(ta.anomalyOk && tb.anomalyOk);
        const canSwitch = st.mode !== 'anomaly' && (ta.anomalyOk || tb.anomalyOk);
        if (seasonal) notes.push(canSwitch ? 'Includes the seasonal cycle – switch to Anomalies to remove it.' : 'Includes the seasonal cycle.');
        if (notes.length) html += `<p class="te-note">${esc(notes.join(' '))}</p>`;

        html += '<div class="tc-figs tc-figs-2">';
        html += `<figure class="te-fig">${caption(K, `${esc(la)} vs. ${esc(lb)}`, `Each dot is one ${intervalWord(ctx, false)}: ${what} of ${la} (x) against ${lb} (y)${st.lag ? `, ${lb} shifted by ${lagWord(ctx, st.lag)}` : ''}. Dashed: least-squares line. Click a bar in the lag chart to pick another lag.`)}`
            + '<div class="tp-chart tc-chart" data-tc-chart="scatter"></div></figure>';
        html += `<figure class="te-fig">${caption(K, 'Correlation at different time lags', `Pearson r of ${la} at interval t with ${lb} at t + k. A peak at k > 0 means ${la} leads ${lb} by k ${intervalWord(ctx, true)}. Dashed lines: rough 95 % range of r without any relation (±1.96/√n_eff); faded bars lie inside it. Click a bar to show that lag in the scatter plot.`)}`
            + '<div class="tp-chart tc-chart" data-tc-chart="lags"></div></figure>';
        html += '</div>';
        return `${html}</div>`;
    }

    function headline(K, ctx, res, la, lb) {
        const { esc } = K;
        const r = res.pearson;
        const sign = r > 0 ? 'positive' : 'negative';
        let text = `<span class="tp-summary-label">Correlation</span>${esc(la)} and ${esc(lb)}: ${strengthOf(r)} ${sign}, <strong>r = ${esc(rText(r))}</strong> (${esc(pText(res.p_value))}, ${res.significant ? 'significant' : 'not significant'}).`;
        const best = res.best_lag;
        if (best && best.lag !== 0 && num(best.r) !== null && Math.abs(best.r) > Math.abs(r) + 0.02) {
            const outside = num(res.lag_band) !== null && Math.abs(best.r) > res.lag_band;
            text += ` Stronger at ${esc(lagWord(ctx, best.lag))} (r = ${esc(rText(best.r))})${outside ? `: ${esc(best.lag > 0 ? la : lb)} leads` : ', but within the noise range'}.`;
        }
        return text;
    }

    function factsHtml(K, ctx, res) {
        const { esc } = K;
        const fact = (name, value, sub) => `<div class="te-fact"><dt>${name}</dt><dd><span class="te-fact-value">${value}</span>${sub ? `<span class="te-fact-sub">${sub}</span>` : ''}</dd></div>`;
        return '<dl class="te-facts">'
            + fact('Pearson r', esc(rText(res.pearson)), esc(pText(res.p_value)))
            + fact('Spearman <span class="tc-nocase">ρ</span>', esc(rText(res.spearman)), esc(`${pText(res.spearman_p_value)} · rank-based`))
            + fact('R²', esc(K.fmt(res.r_squared, 2)), esc(`${Math.round(res.r_squared * 100)} % shared variance`))
            + fact(esc(intervalWord(ctx, true).replace(/^./, (c) => c.toUpperCase())), esc(String(res.n)), esc(`≈ ${K.fmt(res.effective_n, 0)} independent`))
            + (res.best_lag ? fact('Strongest lag', esc(`${res.best_lag.lag > 0 ? '+' : res.best_lag.lag < 0 ? '−' : ''}${Math.abs(res.best_lag.lag)}`), esc(`r = ${rText(res.best_lag.r)}`)) : '')
            + '</dl>';
    }

    // Diverging fill for r: blue (negative) – white – red (positive).
    function rFill(r) {
        if (num(r) === null) return '#f3f3f1';
        const t = Math.min(1, Math.abs(r));
        const [cr, cg, cb] = r > 0 ? [203, 24, 29] : [33, 113, 181];
        const mix = (c) => Math.round(255 + (c - 255) * t * 0.85);
        return `rgb(${mix(cr)}, ${mix(cg)}, ${mix(cb)})`;
    }

    function matrixHtml(K, ctx, st, chosen, entry) {
        const { esc } = K;
        const cell = (ta, tb) => {
            if (ta.name === tb.name) return '<td class="tc-cell tc-diag">1</td>';
            const res = pairResult(entry, [ta.name, tb.name]);
            const r = res && res.available ? res.pearson : null;
            const on = st.pair[0] === ta.name && st.pair[1] === tb.name;
            const title = res && res.available ? `${lab(ta)} vs ${lab(tb)}: r = ${rText(r)}, ${pText(res.p_value)}, n = ${res.n}` : (res && res.error) || '';
            return `<td class="tc-cell${on ? ' is-on' : ''}" style="background:${rFill(r)};color:${num(r) !== null && Math.abs(r) > 0.6 ? '#fff' : 'inherit'}"><button type="button" data-tc-cell="${esc(JSON.stringify([ta.name, tb.name]))}" title="${esc(title)}">${esc(rText(r))}${res && res.significant ? '*' : ''}</button></td>`;
        };
        const help = (t) => (K.help ? K.help(t) : '');
        return `<div class="tc-matrix-wrap"><table class="tc-matrix"><caption>Pearson r of every pair; * significant. Click a cell to inspect it. ${help('Red: positive, blue: negative correlation. * marks p < 0.05, with the p-value corrected for autocorrelation.')}</caption>`
            + `<thead><tr><th></th>${chosen.map((t) => `<th scope="col"><span class="te-dot" style="background:${colorOf(ctx, t.name)}"></span>${esc(lab(t))}</th>`).join('')}</tr></thead>`
            + `<tbody>${chosen.map((ta) => `<tr><th scope="row"><span class="te-dot" style="background:${colorOf(ctx, ta.name)}"></span>${esc(lab(ta))}</th>${chosen.map((tb) => cell(ta, tb)).join('')}</tr>`).join('')}</tbody></table></div>`;
    }

    // ------------------------------------------------------------------ figures

    function drawAll(K, host, ctx, st, chosen, entry) {
        const charts = [];
        const zoomHosts = [];
        const onZoom = (domain) => {
            st.zoom = domain;
            for (const h of zoomHosts) {
                const spec = h._tcSpec();
                K.renderChart(h, spec);
            }
        };
        const onPan = (from, domain) => {
            st.zoom = domain;
            for (const h of zoomHosts) {
                if (h === from || !h._spec) continue;
                h._spec.xDomain = domain;
                K.renderChart(h, h._spec);
            }
        };
        const prepTime = (el, makeSpec) => {
            el._tcSpec = () => {
                const spec = makeSpec();
                spec.fullDomain = ctx.domain;
                if (st.zoom) { spec.xDomain = st.zoom.slice(); spec.zoomed = true; }
                return spec;
            };
            el._onZoom = (domain) => onZoom(domain);
            el._onPan = (domain) => onPan(el, domain);
            zoomHosts.push(el);
            charts.push({ el, draw: () => K.renderChart(el, el._tcSpec()) });
        };

        const combined = host.querySelector('[data-tc-chart="combined"]');
        if (combined && ctx.domain) {
            const spec0 = combinedSpec(K, ctx, st, chosen);
            host.querySelector('[data-tc-legend="combined"]').innerHTML = K.legendHtml(spec0.legend);
            prepTime(combined, () => combinedSpec(K, ctx, st, chosen));
        }
        const rows = [...host.querySelectorAll('[data-tc-chart="row"]')];
        rows.forEach((el, i) => {
            const topic = chosen.find((t) => t.name === el.getAttribute('data-tc-topic'));
            const last = i === rows.length - 1;
            if (topic && ctx.domain) prepTime(el, () => rowSpec(K, ctx, st, topic, last));
        });

        const res = pairResult(entry, st.pair);
        if (res && res.available) {
            const ta = chosen.find((t) => t.name === st.pair[0]);
            const tb = chosen.find((t) => t.name === st.pair[1]);
            const scatter = host.querySelector('[data-tc-chart="scatter"]');
            if (scatter && ta && tb) charts.push({ el: scatter, draw: () => { scatter.innerHTML = scatterSvg(K, ctx, st, ta, tb, Math.max(280, Math.floor(scatter.clientWidth))); } });
            const lags = host.querySelector('[data-tc-chart="lags"]');
            if (lags) charts.push({ el: lags, draw: () => { lags.innerHTML = lagSvg(K, ctx, st, res, Math.max(280, Math.floor(lags.clientWidth))); } });
        }

        for (const c of charts) { c.el._tcW = Math.floor(c.el.clientWidth); c.draw(); }
        if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver((entries) => {
                for (const e of entries) {
                    const c = charts.find((x) => x.el === e.target);
                    const w = Math.floor(e.target.clientWidth);
                    if (c && w && w !== c.el._tcW) { c.el._tcW = w; c.draw(); }
                }
            });
            charts.forEach((c) => ro.observe(c.el));
            host._tcObserver = ro;
        }
    }

    function timeSeriesPoints(ctx, st, topic, standardise) {
        const pts = topic.points.map((p) => ({ x: p.t, y: valueOf(st, topic, p), meta: p }));
        if (!standardise) return pts;
        const ys = pts.map((p) => p.y).filter((v) => v !== null);
        const K = kit();
        const m = K.mean(ys);
        const sd = K.stdDev(ys);
        return pts.map((p) => ({ ...p, y: p.y === null || !(sd > 0) ? null : (p.y - m) / sd }));
    }

    function baseTimeSpec(ctx) {
        return {
            kind: 'time',
            xDomain: ctx.domain.slice(),
            xTicks: kit().timeTicks(ctx.domain),
            formatX: (x) => formatTime(ctx, x),
            bands: [],
            tooltipExtra: (row) => (row.meta && row.meta.label ? `interval from ${row.meta.label}` : ''),
        };
    }

    function combinedSpec(K, ctx, st, chosen) {
        const z = st.axis === 'z';
        const units = [...new Set(chosen.map((t) => t.unit || ''))];
        const shared = units.length === 1 ? units[0] : '';
        const gap = ctx.stepDays * DAY_MS * 1.6;
        const anomaly = st.mode === 'anomaly';
        const series = chosen.map((t) => {
            const pts = timeSeriesPoints(ctx, st, t, z);
            return {
                id: `v-${t.name}`, kind: 'line', name: z || shared ? lab(t) : `${lab(t)}${t.unit ? ` [${t.unit}]` : ''}`,
                color: colorOf(ctx, t.name), width: 1.6, points: pts, gap, markers: pts.length <= 120 ? 2.6 : 0,
            };
        });
        return {
            ...baseTimeSpec(ctx),
            height: 300,
            series,
            legend: chosen.map((t) => ({ name: `${lab(t)}${t.unit && !z ? ` [${t.unit}]` : ''}${anomaly && t.anomalyOk ? ' – anomaly' : ''}`, color: colorOf(ctx, t.name), style: 'line' })),
            unit: z ? 'σ' : shared,
            yLabel: z ? `Standardised ${anomaly ? 'anomaly' : 'value'} [σ]` : shared ? `${anomaly ? 'Anomaly' : 'Value'} [${shared}]` : `${anomaly ? 'Anomaly' : 'Value'} (mixed units)`,
            xLabel: 'Date',
            yInclude: z || anomaly ? [0] : [],
            ariaLabel: `Compared variables: ${chosen.map(lab).join(', ')}`,
        };
    }

    function rowSpec(K, ctx, st, topic, last) {
        const pts = timeSeriesPoints(ctx, st, topic, false);
        const anomaly = st.mode === 'anomaly' && topic.anomalyOk;
        return {
            ...baseTimeSpec(ctx),
            height: 150,
            series: [{
                id: `row-${topic.name}`, kind: 'line', name: anomaly ? `${lab(topic)} – anomaly` : lab(topic),
                color: colorOf(ctx, topic.name), width: 1.5, points: pts, gap: ctx.stepDays * DAY_MS * 1.6, markers: pts.length <= 120 ? 2.4 : 0,
            }],
            legend: [],
            unit: topic.unit || '',
            yLabel: `${lab(topic)}${anomaly ? ' – anomaly' : ''}${topic.unit ? ` [${topic.unit}]` : ''}`,
            xLabel: last ? 'Date' : undefined,
            yInclude: anomaly ? [0] : [],
            ariaLabel: `${lab(topic)} over time`,
        };
    }

    // Pairs A(t), B(t + lag) by interval index.
    function pairedPoints(ctx, st, ta, tb, lag) {
        const idx = indexer(ctx);
        const bMap = new Map();
        for (const p of tb.points) {
            const v = valueOf(st, tb, p);
            if (v !== null) bMap.set(idx(p), { v, p });
        }
        const out = [];
        for (const p of ta.points) {
            const v = valueOf(st, ta, p);
            if (v === null) continue;
            const q = bMap.get(idx(p) + lag);
            if (q) out.push({ x: v, y: q.v, a: p, b: q.p });
        }
        return out;
    }

    function scatterSvg(K, ctx, st, ta, tb, width) {
        const { COLOR, esc } = K;
        const pts = pairedPoints(ctx, st, ta, tb, st.lag);
        const height = 300;
        if (pts.length < 2) return `<div class="te-state">Too few ${esc(intervalWord(ctx, true))} with values of both variables at this lag.</div>`;
        let xlo = Infinity; let xhi = -Infinity; let ylo = Infinity; let yhi = -Infinity;
        for (const p of pts) {
            if (p.x < xlo) xlo = p.x; if (p.x > xhi) xhi = p.x;
            if (p.y < ylo) ylo = p.y; if (p.y > yhi) yhi = p.y;
        }
        const tx = linearTicks(K, xlo, xhi, 5);
        const ty = linearTicks(K, ylo, yhi, 5);
        const yLabels = ty.ticks.map(ty.label);
        const top = 22;
        const bottom = 44;
        const left = Math.max(...yLabels.map((s) => s.length)) * 6.6 + 18;
        const right = 14;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const sx = (v) => left + ((v - tx.a) / (tx.b - tx.a || 1)) * plotW;
        const sy = (v) => top + plotH - ((v - ty.a) / (ty.b - ty.a || 1)) * plotH;
        const f = (v) => v.toFixed(1);
        let out = '';
        ty.ticks.forEach((v, k) => {
            const y = f(sy(v));
            out += `<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${COLOR.grid}" />`;
            out += `<text x="${left - 7}" y="${y}" text-anchor="end" dominant-baseline="middle">${yLabels[k]}</text>`;
        });
        let lastEnd = -Infinity;
        tx.ticks.forEach((v) => {
            const x = sx(v);
            out += `<line x1="${f(x)}" x2="${f(x)}" y1="${top}" y2="${top + plotH}" stroke="${COLOR.grid}" />`;
            const label = tx.label(v);
            const w = label.length * 6.4;
            if (x - w / 2 < lastEnd + 6) return;
            lastEnd = x + w / 2;
            out += `<text x="${f(x)}" y="${top + plotH + 16}" text-anchor="middle">${label}</text>`;
        });
        out += `<line x1="${left}" x2="${left + plotW}" y1="${top + plotH}" y2="${top + plotH}" stroke="${COLOR.axis}" />`;
        const anomaly = (t) => (st.mode === 'anomaly' && t.anomalyOk ? ' – anomaly' : '');
        const unitOf = (t) => (t.unit ? ` [${t.unit}]` : '');
        // Long labels are cut to fit; the unit and lag always stay visible, the full text is in <title>.
        const xTail = `${anomaly(ta)}${unitOf(ta)}`;
        const yTail = `${anomaly(tb)}${unitOf(tb)}${st.lag ? ` (${lagWord(ctx, st.lag)})` : ''}`;
        const xTitle = fitText(lab(ta), plotW - xTail.length * 6.3) + xTail;
        const yTitle = fitText(lab(tb), width - 8 - yTail.length * 6.3) + yTail;
        out += `<text class="tp-axis-title" x="${left + plotW / 2}" y="${height - 6}" text-anchor="middle"><title>${esc(lab(ta) + xTail)}</title>${esc(xTitle)}</text>`;
        out += `<text class="tp-axis-title" x="4" y="${top - 9}" text-anchor="start"><title>${esc(lab(tb) + yTail)}</title>${esc(yTitle)}</text>`;

        const stride = Math.max(1, Math.ceil(pts.length / SCATTER_MAX_DRAWN));
        const color = colorOf(ctx, tb.name);
        const r = pts.length > 1500 ? 1.8 : pts.length > 300 ? 2.4 : 3.2;
        const titled = pts.length <= 1500;
        let dots = '';
        for (let i = 0; i < pts.length; i += stride) {
            const p = pts[i];
            const title = titled ? `<title>${esc(`${p.a.label}${st.lag ? ` / ${p.b.label}` : ''}: ${lab(ta)} ${K.fmt(p.x)}, ${lab(tb)} ${K.fmt(p.y)}`)}</title>` : '';
            dots += `<circle cx="${f(sx(p.x))}" cy="${f(sy(p.y))}" r="${r}" fill="${color}" fill-opacity="0.45" stroke="${color}" stroke-opacity="0.7" stroke-width="0.6">${title}</circle>`;
        }
        // Least-squares line over the shown pairs.
        const mx = K.mean(pts.map((p) => p.x));
        const my = K.mean(pts.map((p) => p.y));
        let sxx = 0; let sxy = 0;
        for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
        let fit = '';
        if (sxx > 0) {
            const slope = sxy / sxx;
            const y = (x) => my + slope * (x - mx);
            fit = `<line x1="${f(sx(xlo))}" y1="${f(sy(y(xlo)))}" x2="${f(sx(xhi))}" y2="${f(sy(y(xhi)))}" stroke="${COLOR.reference}" stroke-width="1.6" stroke-dasharray="6,4" />`;
        }
        const clipId = `tc-clip-${Math.random().toString(36).slice(2, 8)}`;
        out += `<clipPath id="${clipId}"><rect x="${left}" y="${top - 2}" width="${plotW}" height="${plotH + 4}" /></clipPath><g clip-path="url(#${clipId})">${dots}${fit}</g>`;
        const note = stride > 1 ? `<div class="te-note">Every ${stride}th of ${pts.length} pairs drawn.</div>` : '';
        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Scatter plot of ${lab(ta)} against ${lab(tb)}`)}">${out}</svg>${note}`;
    }

    function lagSvg(K, ctx, st, res, width) {
        const { COLOR, esc } = K;
        const lags = (res.lags || []).filter((l) => num(l.r) !== null);
        if (!lags.length) return '<div class="te-state">No lag has enough pairs.</div>';
        const height = 230;
        const top = 22;
        const bottom = 34;
        const band = num(res.lag_band);
        let lo = Math.min(0, ...lags.map((l) => l.r), band !== null ? -band : 0);
        let hi = Math.max(0, ...lags.map((l) => l.r), band !== null ? band : 0);
        const ty = linearTicks(K, lo, hi, 4);
        lo = ty.a; hi = ty.b;
        const yLabels = ty.ticks.map(ty.label);
        const left = Math.max(...yLabels.map((s) => s.length)) * 6.6 + 18;
        const right = 14;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const L = st.maxLag;
        const sx = (k) => left + ((k + L + 0.5) / (2 * L + 1)) * plotW;
        const sy = (v) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
        const f = (v) => v.toFixed(1);
        const bw = Math.max(2, Math.min(18, (plotW / (2 * L + 1)) * 0.7));
        let out = '';
        ty.ticks.forEach((v, k) => {
            const y = f(sy(v));
            out += `<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${COLOR.grid}" />`;
            out += `<text x="${left - 7}" y="${y}" text-anchor="end" dominant-baseline="middle">${yLabels[k]}</text>`;
        });
        out += `<text class="tp-axis-title" x="4" y="${top - 9}" text-anchor="start">Correlation r</text>`;
        if (band !== null) {
            for (const v of [band, -band]) out += `<line x1="${left}" x2="${left + plotW}" y1="${f(sy(v))}" y2="${f(sy(v))}" stroke="${COLOR.reference}" stroke-dasharray="4,3" />`;
        }
        // x labels: every lag when there is room, else a nice step; 0 always.
        const every = [1, 2, 3, 4, 6, 12, 24].find((s) => (plotW / (2 * L + 1)) * s >= 26) || 24;
        for (let k = -L; k <= L; k++) {
            if (k % every !== 0) continue;
            out += `<text x="${f(sx(k))}" y="${top + plotH + 15}" text-anchor="middle">${k > 0 ? `+${k}` : k < 0 ? `−${-k}` : '0'}</text>`;
        }
        // x title: "lag [days]" in the middle, who leads at either end (labels cut to fit).
        const la = labelOf(ctx, res.a);
        const lb = labelOf(ctx, res.b);
        const mid = `lag [${intervalWord(ctx, true)}]`;
        const side = (plotW - mid.length * 6.3) / 2 - 12;
        const ty2 = height - 3;
        out += `<text class="tp-axis-title" x="${f(left + plotW / 2)}" y="${ty2}" text-anchor="middle">${esc(mid)}</text>`;
        if (side > 60) {
            out += `<text class="tp-axis-title" x="${left}" y="${ty2}" text-anchor="start"><title>${esc(`${lb} leads`)}</title>${esc(`← ${fitText(lb, side - 60)} leads`)}</text>`;
            out += `<text class="tp-axis-title" x="${left + plotW}" y="${ty2}" text-anchor="end"><title>${esc(`${la} leads`)}</title>${esc(`${fitText(la, side - 60)} leads →`)}</text>`;
        }
        const zy = sy(0);
        const best = res.best_lag ? res.best_lag.lag : null;
        for (const l of lags) {
            const x = sx(l.lag) - bw / 2;
            const y = sy(Math.max(0, l.r));
            const h = Math.max(0.5, Math.abs(sy(l.r) - zy));
            const isBest = l.lag === best;
            const isSel = l.lag === st.lag;
            const fill = isBest ? COLOR.accent : l.r >= 0 ? '#cb181d' : '#2171b5';
            const outside = band === null || Math.abs(l.r) > band;
            out += `<rect class="tc-bar${isSel ? ' is-on' : ''}" data-tc-lag="${l.lag}" x="${f(x)}" y="${f(y)}" width="${f(bw)}" height="${f(h)}" fill="${fill}" fill-opacity="${outside ? 0.9 : 0.4}"${isSel ? ` stroke="${COLOR.reference}" stroke-width="1.5"` : ''}><title>${esc(`${lagWord(ctx, l.lag)}: r = ${rText(l.r)} (n = ${l.n})${isBest ? ' · strongest' : ''}`)}</title></rect>`;
        }
        out += `<line x1="${left}" x2="${left + plotW}" y1="${f(zy)}" y2="${f(zy)}" stroke="${COLOR.axis}" />`;
        out += `<line x1="${f(sx(0))}" x2="${f(sx(0))}" y1="${top}" y2="${top + plotH}" stroke="${COLOR.axis}" stroke-dasharray="2,3" />`;
        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Lagged correlation of ${la} and ${lb}`)}">${out}</svg>`;
    }

    // ---------------------------------------------------------------- controls

    function bind(host, st) {
        const rerender = () => { st.sig = null; render(host, st.ctx); };
        host.querySelectorAll('[data-tc-var]').forEach((btn) => btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-tc-var');
            st.touched = true;
            if (st.selected.includes(name)) st.selected = st.selected.filter((n) => n !== name);
            else if (st.selected.length < MAX_SELECTED) st.selected.push(name);
            rerender();
        }));
        host.querySelectorAll('[data-tc-mode]').forEach((btn) => btn.addEventListener('click', () => {
            st.mode = btn.getAttribute('data-tc-mode');
            rerender();
        }));
        host.querySelectorAll('[data-tc-axis]').forEach((btn) => btn.addEventListener('click', () => {
            st.axis = btn.getAttribute('data-tc-axis');
            rerender();
        }));
        host.querySelectorAll('[data-tc-maxlag]').forEach((btn) => btn.addEventListener('click', () => {
            st.maxLag = Number(btn.getAttribute('data-tc-maxlag'));
            if (Math.abs(st.lag) > st.maxLag) st.lag = 0;
            rerender();
        }));
        host.querySelectorAll('[data-tc-pair]').forEach((sel) => sel.addEventListener('change', () => {
            const i = Number(sel.getAttribute('data-tc-pair'));
            st.pair = st.pair.slice();
            st.pair[i] = sel.value;
            st.lag = 0;
            rerender();
        }));
        const swap = host.querySelector('[data-tc-swap]');
        if (swap) swap.addEventListener('click', () => { st.pair = [st.pair[1], st.pair[0]]; st.lag = -st.lag; rerender(); });
        host.querySelectorAll('[data-tc-cell]').forEach((btn) => btn.addEventListener('click', () => {
            st.pair = JSON.parse(btn.getAttribute('data-tc-cell'));
            st.lag = 0;
            rerender();
        }));
        const lags = host.querySelector('[data-tc-chart="lags"]');
        if (lags) lags.addEventListener('click', (e) => {
            const bar = e.target.closest('[data-tc-lag]');
            if (!bar) return;
            const k = Number(bar.getAttribute('data-tc-lag'));
            st.lag = st.lag === k ? 0 : k;
            rerender();
        });
    }

    window.TrendCompare = { render, clear };
})();
