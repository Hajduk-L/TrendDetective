/*
 * "Change over time" section of the plot panel (below the main plot).
 *
 * plots.js calls window.TrendEvolution.render(host, ctx) on every re-render of
 * the panel with one value per year for every analysis time frame (annual mean
 * or the mean of a period such as January). This file sends the complete years
 * to POST /api/evolution (evolution.py) and draws the answer as numbers and
 * figures a scientist can quote:
 *
 *   headline   trend per decade with its 95 % CI and p, years above the baseline,
 *              share of running windows with the same sign
 *   Fig. 3a    yearly values with 95 % CI, OLS trend, baseline mean
 *   Fig. 3b    anomaly vs. the baseline per year (diverging bars)
 *   Fig. 3c    running trend: slope of every N-year window with its 95 % CI
 *   Fig. 3d    decadal means with the difference to the first decade
 *
 * Rendering is idempotent: a signature of everything shown is compared with
 * the last one, so repeated calls with the same data do nothing. Server
 * answers are cached by request body.
 */
(function () {
    'use strict';

    const API = '/api/evolution';
    const WINDOW_CHOICES = [5, 10, 15, 20, 30];
    const DEFAULT_WINDOW = 10;
    const MIN_YEARS = 3;
    const DEBOUNCE_MS = 180;
    const CACHE_MAX = 80;
    const FIG = 'Fig. 3';

    // Diverging pairs for Fig. 3b (above / below the baseline), taken from the
    // warming-stripes palettes in plots.js so both read the same.
    const DIVERGING = {
        warm: { above: '#cb181d', below: '#2171b5', aboveWord: 'warmer', belowWord: 'colder' },
        wet: { above: '#35978f', below: '#bf812d', aboveWord: 'wetter', belowWord: 'drier' },
        neutral: { above: '#6250d6', below: '#8f6a00', aboveWord: 'above', belowWord: 'below' },
    };

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

    // Digits for a set of values so that differences of a tenth of their spread stay visible.
    function digitsFor(values) {
        const vs = values.filter((v) => num(v) !== null).map(Math.abs);
        if (!vs.length) return 2;
        const ref = Math.max(...vs);
        if (ref >= 10) return 1;
        if (ref >= 0.1) return 2;
        if (ref >= 0.01) return 3;
        return 4;
    }

    // Fixed decimals with a real minus sign, so table columns line up.
    function fixed(v, digits, signed) {
        if (num(v) === null) return '–';
        const s = Math.abs(v).toFixed(digits);
        const zero = Number(s) === 0;
        return (v < 0 && !zero ? '−' : signed && !zero ? '+' : signed ? '±' : '') + s;
    }

    function median(values) {
        const v = values.filter((x) => num(x) !== null).sort((a, b) => a - b);
        if (!v.length) return null;
        const m = v.length >> 1;
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    // "°C/decade", or "mm/day per decade" so rate units do not read as "mm/day/decade".
    function perUnit(unit, what) {
        if (!unit) return `per ${what}`;
        return unit.includes('/') || unit.includes(' ') ? `${unit} per ${what}` : `${unit}/${what}`;
    }

    // Fixed decimals, so a slope and its interval read alike ("+0.40 (−0.20 to +0.99)").
    function rate(K, v, unit, what, digits) {
        return `${fixed(v, digits ?? digitsFor([v]), true)} ${perUnit(unit, what)}`;
    }

    function kindOf(ctx) {
        const unit = ctx.unit || '';
        const topic = String(ctx.topic || '');
        if (unit === 'mm/day' || unit === '% of days' || /precip|rain|snow|wet day/i.test(topic)) return 'wet';
        if (/°|\bK\b/.test(unit) || /temp/i.test(topic)) return 'warm';
        return 'neutral';
    }

    function words(kind) {
        if (kind === 'warm') return { up: 'warming', down: 'cooling' };
        if (kind === 'wet') return { up: 'an increase', down: 'a decrease' };
        return { up: 'an increase', down: 'a decrease' };
    }

    function niceStep(raw) {
        if (!(raw > 0)) return 1;
        const p = 10 ** Math.floor(Math.log10(raw));
        const r = raw / p;
        return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
    }

    function tickDecimals(step) {
        if (step >= 1) return 0;
        return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9) + (String(step).includes('25') ? 1 : 0));
    }

    function yearTicks(domain, labelOf) {
        return (plotW, shown = domain) => {
            const ys = [];
            for (let y = Math.ceil(shown[0]); y <= Math.floor(shown[1]); y++) ys.push(y);
            const every = Math.max(1, Math.ceil(ys.length / Math.max(2, Math.floor(plotW / 48))));
            // Round tick years (multiples of `every`) read better than "first year + k·every".
            const step = every <= 1 ? 1 : every <= 2 ? 2 : every <= 5 ? 5 : every <= 10 ? 10 : Math.ceil(every / 10) * 10;
            return ys.filter((y) => y % step === 0 || step === 1).map((y) => ({ v: y, label: labelOf(y) }));
        };
    }

    // ---------------------------------------------------------------- requests

    function remember(key, entry) {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }

    function fetchEvolution(key, host) {
        remember(key, { pending: true });
        fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                remember(key, { data: body, v: ++version });
            })
            .catch((err) => remember(key, { error: String((err && err.message) || err), v: ++version }))
            .finally(() => {
                const st = host._te;
                if (!st || !st.ctx || !host.isConnected) return;
                try {
                    render(host, st.ctx);
                } catch (err) {
                    const K = kit();
                    const msg = K ? K.esc(err.message || err) : 'unexpected error';
                    host.innerHTML = `<div class="tp-hint">Change over time could not be drawn: ${msg}</div>`;
                    st.sig = null;
                }
            });
    }

    // Asks the server once per distinct body; rapid changes only send the last one.
    function request(host, st, key) {
        const entry = cache.get(key);
        if (entry) return entry;
        if (st.timerKey !== key) {
            clearTimeout(st.timer);
            st.timerKey = key;
            st.timer = setTimeout(() => {
                st.timer = null;
                st.timerKey = null;
                if (!cache.has(key)) fetchEvolution(key, host);
            }, DEBOUNCE_MS);
        }
        return { pending: true };
    }

    // ------------------------------------------------------------------ render

    function render(host, ctx) {
        const K = kit();
        if (!host) return;
        if (!K) { host.innerHTML = ''; return; }
        const st = host._te || (host._te = { frameId: null, windowYears: DEFAULT_WINDOW, baseline: 'auto', sig: null });
        st.ctx = ctx;
        const frames = (ctx && ctx.frames) || [];
        if (!frames.length) {
            if (st.sig !== 'empty') { teardown(host); host.innerHTML = ''; st.sig = 'empty'; }
            return;
        }
        const frame = frames.find((f) => f.id === st.frameId) || frames[0];
        st.frameId = frame.id;

        const rows = frame.rows
            .filter((r) => r.complete && num(r.value) !== null && Number.isInteger(r.year))
            .sort((a, b) => a.year - b.year);
        const used = rows.filter((r, i) => i === 0 || r.year !== rows[i - 1].year);
        const span = used.length ? used[used.length - 1].year - used[0].year + 1 : 0;

        // Running-window choices that fit into the series.
        const allowed = WINDOW_CHOICES.filter((w) => w <= span);
        let windowYears = st.windowYears;
        if (!allowed.includes(windowYears)) windowYears = allowed.length ? allowed.filter((w) => w <= DEFAULT_WINDOW).pop() || allowed[0] : null;

        const baselines = baselineChoices(used);
        if (!baselines.some((b) => b.id === st.baseline)) st.baseline = 'auto';
        const baseline = baselines.find((b) => b.id === st.baseline);

        let key = null;
        let entry = null;
        if (used.length >= MIN_YEARS) {
            const body = {
                years: used.map((r) => r.year),
                values: used.map((r) => r.value),
            };
            if (used.some((r) => num(r.n) !== null && num(r.sd) !== null)) {
                body.n = used.map((r) => num(r.n));
                body.sd = used.map((r) => num(r.sd));
            }
            if (windowYears) body.window_years = windowYears;
            if (baseline && baseline.range) body.baseline = baseline.range;
            key = JSON.stringify(body);
            entry = request(host, st, key);
        }

        const sig = JSON.stringify([
            key, entry ? (entry.pending ? 'p' : entry.v) : null, frame.id,
            frames.map((f) => [f.id, f.label, f.color]), ctx.unit, ctx.anomaly, ctx.topic,
            frame.inside && frame.inside.map((q) => [q.year, q.slope, q.significant]), frame.insidePending,
            windowYears, st.baseline, frame.rows.length, frame.label,
        ]);
        if (sig === st.sig && host.querySelector('.te-root')) return;
        st.sig = sig;

        const keepFocus = document.activeElement && host.contains(document.activeElement) ? document.activeElement.getAttribute('data-te-focus') : null;
        teardown(host);
        host.innerHTML = sectionHtml(K, ctx, frames, frame, used, span, allowed, windowYears, baselines, st.baseline, entry);
        bind(host, st);
        if (entry && entry.data) drawFigures(K, host, ctx, frame, used, entry.data);
        if (keepFocus) {
            const el = host.querySelector(`[data-te-focus="${keepFocus}"]`);
            if (el) el.focus();
        }
    }

    function clear(host) {
        if (!host) return;
        teardown(host);
        host.innerHTML = '';
        if (host._te) { clearTimeout(host._te.timer); host._te.sig = null; host._te.ctx = null; host._te.timerKey = null; }
    }

    function teardown(host) {
        if (host._teObserver) { host._teObserver.disconnect(); host._teObserver = null; }
    }

    // Baseline periods offered: the server's choice, the WMO normals the series covers, all years.
    function baselineChoices(used) {
        const out = [{ id: 'auto', label: 'Automatic', range: null }];
        if (used.length < MIN_YEARS) return out;
        const first = used[0].year;
        const last = used[used.length - 1].year;
        for (const [a, b] of [[1961, 1990], [1991, 2020]]) {
            const inside = used.filter((r) => r.year >= a && r.year <= b).length;
            if (inside >= 10) out.push({ id: `${a}-${b}`, label: `${a}–${b}${inside < 24 ? ` (${inside} yrs)` : ''}`, range: [a, b] });
        }
        out.push({ id: 'all', label: `All years (${first}–${last})`, range: [first, last] });
        return out;
    }

    function sectionHtml(K, ctx, frames, frame, used, span, allowed, windowYears, baselines, baselineId, entry) {
        const { esc } = K;
        const labelOf = labeller(frame);
        let html = '<section class="te-root" aria-label="Change over time">';
        html += '<header class="te-head"><h4 class="te-title">Change over time</h4>'
            + `<p class="te-lede">One value per year${frame.isPeriod ? ` (the mean of ${esc(frame.label)})` : ' (the annual mean)'}: how large the change is, how certain, and how consistently the years and decades follow it.</p></header>`;

        // Controls: time frame, baseline.
        let controls = '';
        if (frames.length > 1) {
            controls += '<div class="te-field"><span class="te-field-label" id="te-frame-label">Time frame</span>'
                + '<div class="te-seg" role="group" aria-labelledby="te-frame-label">'
                + frames.map((f) => `<button type="button" data-te-frame="${esc(String(f.id))}" data-te-focus="frame-${esc(String(f.id))}" aria-pressed="${f.id === frame.id}"><span class="te-dot" style="background:${esc(f.color)}"></span>${esc(f.label)}</button>`).join('')
                + '</div></div>';
        }
        if (used.length >= MIN_YEARS) {
            controls += '<label class="te-field"><span class="te-field-label">Baseline</span>'
                + `<select data-te-baseline data-te-focus="baseline">${baselines.map((b) => `<option value="${esc(b.id)}"${b.id === baselineId ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select></label>`;
        }
        if (controls) html += `<div class="te-controls">${controls}</div>`;

        if (ctx.anomaly) {
            html += '<p class="te-note">Anomaly mode: the yearly values are already departures from the multi-year mean of the same time of year. Fig. 3b re-references them to the baseline period below.</p>';
        }

        const skipped = frame.rows.length - used.length;
        if (used.length < MIN_YEARS) {
            html += `<div class="te-state">Needs at least ${MIN_YEARS} complete years of ${esc(frame.isPeriod ? frame.label : 'data')}; this selection has ${used.length}${skipped > 0 ? ` (${skipped} more ${skipped === 1 ? 'is' : 'are'} incomplete)` : ''}. Choose a time range over more years${frame.isPeriod ? '' : ' with Day or Month intervals'}.</div>`;
            html += insideHtml(K, ctx, frame);
            return `${html}</section>`;
        }

        if (!entry || entry.pending) {
            html += '<div class="te-state" role="status">Computing…</div>';
            html += insideHtml(K, ctx, frame);
            return `${html}</section>`;
        }
        if (entry.error) {
            html += `<div class="te-state te-error" role="alert">The statistics could not be computed: ${esc(entry.error)}</div>`;
            html += insideHtml(K, ctx, frame);
            return `${html}</section>`;
        }

        const d = entry.data;
        const unit = ctx.unit;
        const t = d.trend || {};
        const b = d.baseline || {};
        const baseText = num(b.start) !== null ? `${labelOf(b.start)}–${labelOf(b.end)}` : 'baseline';

        html += `<p class="te-headline">${esc(headline(K, ctx, frame, used, d, labelOf))}</p>`;
        html += factsHtml(K, ctx, d, used, labelOf);
        html += insideHtml(K, ctx, frame);

        const subject = frame.isPeriod ? `${frame.label} mean` : 'Annual mean';
        const anomalyWord = ctx.anomaly ? ' anomaly' : '';
        const runPts = (d.running && d.running.points) || [];
        const runN = (d.running && d.running.window_years) || windowYears;

        html += '<div class="te-figs">';
        html += figureHtml('a', `${esc(subject)}${anomalyWord} per year${t.available !== false ? ' with the ordinary least-squares trend' : ''} and the ${esc(baseText)} baseline mean.${skipped > 0 ? ` ${skipped} incomplete year${skipped === 1 ? ' is' : 's are'} left out.` : ''}`,
            `Yearly ${subject}${anomalyWord}, trend and baseline`, 'values');
        html += figureHtml('b', `Anomaly of each year relative to the ${esc(baseText)} mean${num(b.mean) !== null ? ` (${esc(K.withUnit(K.fmt(b.mean), unit))})` : ''}.`,
            `Anomaly per year relative to the ${baseText} baseline`, 'bars');

        const sizeButtons = WINDOW_CHOICES.map((w) => `<button type="button" data-te-window="${w}" data-te-focus="window-${w}" aria-pressed="${w === runN}"${allowed.includes(w) ? '' : ` disabled title="Longer than the ${span} years of the series"`}>${w}</button>`).join('');
        const sizeControl = `<div class="te-field te-field-inline"><span class="te-field-label" id="te-win-label">Window</span><div class="te-seg te-seg-small" role="group" aria-labelledby="te-win-label">${sizeButtons}</div><span class="te-field-unit">years</span></div>`;
        html += figureHtml('c', allowed.length
            ? `Running trend: slope of the ordinary least-squares fit in every ${esc(String(runN))}-year window, plotted at the window centre, with 95 % CI (autocorrelation-corrected). Filled markers: p < 0.05.`
            : 'Running trend: slope of the ordinary least-squares fit in every N-year window.',
            `Running ${runN}-year trend per decade`, runPts.length ? 'running' : null, allowed.length ? sizeControl : '',
            runPts.length ? '' : `<div class="te-state">${allowed.length ? `No ${esc(String(runN))}-year window has enough years with values.` : `Running trends need a series of at least ${WINDOW_CHOICES[0]} years; this one spans ${span}.`}</div>`);
        html += decadesFigure(K, ctx, d);
        html += '</div>';

        const notes = (d.notes || []).filter(Boolean);
        html += `<p class="te-methods"><span class="te-methods-head">Methods.</span> Error bars: 95 % t interval of each year's mean from the spread of its ${ctx.intervalText ? `${esc(ctx.intervalText)} ` : ''}values (only when a year has two or more). Trend: ordinary least squares on the yearly values; CI and p corrected for lag-1 autocorrelation. Sen's slope and Mann-Kendall test as a robust check. Only complete years are used.${notes.length ? ` ${notes.map((n) => esc(n)).join(' ')}` : ''}</p>`;
        return `${html}</section>`;
    }

    function figureHtml(letter, caption, _aria, chartKind, controls = '', fallback = '') {
        return `<figure class="te-fig te-fig-${letter}">`
            + `<figcaption><span class="te-fig-no">${FIG}${letter}</span> ${caption}</figcaption>`
            + (controls ? `<div class="te-fig-controls">${controls}</div>` : '')
            + (chartKind ? `<div class="tp-chart te-chart" data-te-chart="${chartKind}"></div><div class="tp-legend te-legend" data-te-legend="${chartKind}"></div>` : fallback)
            + '</figure>';
    }

    function labeller(frame) {
        const byYear = new Map(frame.rows.map((r) => [r.year, r.label]));
        return (y) => {
            const k = Math.round(y);
            return byYear.has(k) && byYear.get(k) ? String(byYear.get(k)) : String(k);
        };
    }

    function headline(K, ctx, frame, used, d, labelOf) {
        const unit = ctx.unit;
        const t = d.trend || {};
        const c = d.consistency || {};
        const b = d.baseline || {};
        const w = words(kindOf(ctx));
        const subject = `${frame.isPeriod ? `${frame.label} mean` : 'Annual mean'}${ctx.anomaly ? ' anomaly' : ''}`;
        const range = `${labelOf(used[0].year)}–${labelOf(used[used.length - 1].year)}`;
        const parts = [];
        const dec = num(t.slope_per_decade) ?? (num(t.slope) !== null ? t.slope * 10 : null);
        if (t.available !== false && dec !== null) {
            const lo = num(t.ci_low_per_decade) ?? (num(t.ci_low) !== null ? t.ci_low * 10 : null);
            const hi = num(t.ci_high_per_decade) ?? (num(t.ci_high) !== null ? t.ci_high * 10 : null);
            const dg = digitsFor([dec, lo, hi]);
            const ci = lo !== null && hi !== null ? `95 % CI ${fixed(lo, dg, true)} to ${fixed(hi, dg, true)}, ` : '';
            parts.push(`${subject}, ${range}: ${rate(K, dec, unit, 'decade', dg)} (${ci}${pText(t.p_value ?? t.p)}).`);
        } else {
            parts.push(`${subject}, ${range}: no trend could be fitted.`);
        }
        const tail = [];
        if (num(c.years_compared) && num(b.start) !== null) {
            tail.push(`${c.years_above_baseline} of ${c.years_compared} years above the ${labelOf(b.start)}–${labelOf(b.end)} baseline`);
        }
        const total = num(c.running_total);
        if (total) {
            const n = (d.running && d.running.window_years) || '';
            const pos = c.running_positive || 0;
            const neg = c.running_negative || 0;
            const sp = c.running_significant_positive || 0;
            const sn = c.running_significant_negative || 0;
            const win = `${n}-year windows`;
            if (total === 1) tail.push(`the only ${n}-year window shows ${pos ? w.up : neg ? w.down : 'no change'}${(sp || sn) ? ' (significant)' : ' (not significant)'}`);
            else if (pos === total) tail.push(`all ${total} ${win} show ${w.up}, ${sp} significantly`);
            else if (neg === total) tail.push(`all ${total} ${win} show ${w.down}, ${sn} significantly`);
            else tail.push(`${pos} of ${total} ${win} show ${w.up} (${sp} significant), ${neg} ${w.down} (${sn} significant)`);
        }
        if (tail.length) parts.push(`${tail.join('; ')}.`.replace(/^./, (ch) => ch.toUpperCase()));
        return parts.join(' ');
    }

    function factsHtml(K, ctx, d, used, labelOf) {
        const { esc } = K;
        const unit = ctx.unit;
        const t = d.trend || {};
        const c = d.consistency || {};
        const facts = [];
        if (t.available !== false && num(t.slope) !== null) {
            const dec = num(t.slope_per_decade) ?? t.slope * 10;
            const dg = digitsFor([dec, t.ci_low_per_decade, t.ci_high_per_decade]);
            facts.push(['OLS trend', rate(K, dec, unit, 'decade', dg), `R² ${K.fmt(t.r_squared, 2)} · ${pText(t.p_value)}${num(t.effective_n) !== null && num(t.n_years) !== null && t.effective_n < t.n_years * 0.9 ? ` · n_eff ≈ ${Math.round(t.effective_n)} of ${t.n_years}` : ''}`]);
            if (num(t.total_change) !== null) {
                facts.push(['Change along the trend', K.withUnit(K.fmtSigned(t.total_change), unit), `${labelOf(t.first_year ?? used[0].year)} to ${labelOf(t.last_year ?? used[used.length - 1].year)}`]);
            }
            if (num(t.sen_slope) !== null) {
                const sdec = num(t.sen_slope_per_decade) ?? t.sen_slope * 10;
                facts.push(["Sen's slope", rate(K, sdec, unit, 'decade', digitsFor([sdec])), `Mann-Kendall τ ${fixed(t.mk_tau, 2, false)} · ${pText(t.mk_p_value)}`]);
            }
        }
        if (num(c.years_compared)) facts.push(['Years above baseline', `${c.years_above_baseline} of ${c.years_compared}`, `${c.years_compared - c.years_above_baseline} at or below`]);
        const steps = (c.increases_vs_previous || 0) + (c.decreases_vs_previous || 0);
        if (steps) facts.push(['Year-on-year', `${c.increases_vs_previous} up · ${c.decreases_vs_previous} down`, 'compared with the previous year']);
        if (!facts.length) return '';
        return `<dl class="te-facts">${facts.map(([k, v, s]) => `<div class="te-fact"><dt>${esc(k)}</dt><dd><span class="te-fact-value">${esc(v)}</span>${s ? `<span class="te-fact-sub">${esc(s)}</span>` : ''}</dd></div>`).join('')}</dl>`;
    }

    // One line about the regression inside every year's period (the chart of it lives in plots.js).
    function insideHtml(K, ctx, frame) {
        if (!frame.isPeriod) return '';
        const { esc } = K;
        const lead = `Regression inside each ${esc(frame.label)} (x = day within the period)`;
        if (frame.insidePending && !(frame.inside && frame.inside.length)) return `<p class="te-inside">${lead}: computing…</p>`;
        const ins = (frame.inside || []).filter((q) => num(q.slope) !== null);
        if (!ins.length) return '';
        const up = ins.filter((q) => q.slope > 0);
        const down = ins.filter((q) => q.slope < 0);
        const upSig = up.filter((q) => q.significant).length;
        const downSig = down.filter((q) => q.significant).length;
        const med = median(ins.map((q) => q.slope));
        const unitDay = ctx.unit ? `${ctx.unit} per day` : 'per day';
        const dg = digitsFor([med]);
        return `<p class="te-inside">${lead}: rising in ${up.length} of ${ins.length} years (${upSig} significant), falling in ${down.length} (${downSig} significant); median slope ${esc(`${K.fmtSigned(med, dg)} ${unitDay}`)}. This mostly reflects the seasonal shape within the period; the per-year chart is in the analysis section below.</p>`;
    }

    function decadesFigure(K, ctx, d) {
        const { esc } = K;
        const unit = ctx.unit;
        const decs = (d.decades || []).filter((x) => num(x.mean) !== null);
        const u = unit ? ` (${esc(unit)})` : '';
        let body;
        if (!decs.length) {
            body = '<div class="te-state">No calendar decade has five or more years with values.</div>';
        } else {
            const first = decs[0];
            const dg = Math.min(3, digitsFor(decs.flatMap((x) => [x.ci_high - x.ci_low, x.diff_to_first].filter((v) => num(v) !== null).map(Math.abs))) );
            body = '<div class="te-table-wrap" tabindex="0" role="region" aria-label="Decadal means"><table class="tp-table te-table">'
                + `<caption class="te-sr">Decadal means with 95 % confidence interval and difference to the ${esc(first.label)}</caption>`
                + `<thead><tr><th scope="col">Decade</th><th scope="col">Years</th><th scope="col">Mean${u}</th><th scope="col">95 % CI${u}</th><th scope="col">Δ to ${esc(first.label)}${u}</th></tr></thead><tbody>`
                + decs.map((x, i) => `<tr><th scope="row">${esc(x.label)}</th><td>${esc(String(x.n))}</td><td>${fixed(x.mean, dg)}</td>`
                    + `<td>${num(x.ci_low) !== null ? `${fixed(x.ci_low, dg)} to ${fixed(x.ci_high, dg)}` : '–'}</td>`
                    + `<td>${i === 0 ? '<span class="te-muted">reference</span>' : fixed(x.diff_to_first, dg, true)}</td></tr>`).join('')
                + '</tbody></table></div>';
        }
        return '<figure class="te-fig te-fig-d">'
            + `<figcaption><span class="te-fig-no">${FIG}d</span> Mean of every calendar decade with at least five years (1980s = 1980–1989), its 95 % t interval and the difference to the first decade.</figcaption>`
            + `${body}</figure>`;
    }

    // ----------------------------------------------------------------- figures

    function drawFigures(K, host, ctx, frame, used, d) {
        const labelOf = labeller(frame);
        const series = (d.series || []).filter((p) => num(p.value) !== null);
        if (!series.length) return;
        const domain = [series[0].year - 0.6, series[series.length - 1].year + 0.6];
        const charts = [];

        const valuesHost = host.querySelector('[data-te-chart="values"]');
        if (valuesHost) {
            const spec = valuesSpec(K, ctx, frame, series, d, domain, labelOf);
            charts.push({ host: valuesHost, spec });
            host.querySelector('[data-te-legend="values"]').innerHTML = K.legendHtml(spec.legend);
        }
        const barsHost = host.querySelector('[data-te-chart="bars"]');
        if (barsHost) {
            const pal = DIVERGING[kindOf(ctx)];
            const b = d.baseline || {};
            barsHost._teBars = { series, domain, unit: ctx.unit, pal, labelOf, baseText: num(b.start) !== null ? `${labelOf(b.start)}–${labelOf(b.end)}` : 'baseline' };
            charts.push({ host: barsHost, bars: true });
            host.querySelector('[data-te-legend="bars"]').innerHTML = K.legendHtml([
                { name: `Above the baseline mean (${pal.aboveWord})`, color: pal.above },
                { name: `Below (${pal.belowWord})`, color: pal.below },
            ]);
        }
        const runHost = host.querySelector('[data-te-chart="running"]');
        if (runHost) {
            const spec = runningSpec(K, ctx, d, domain, labelOf);
            charts.push({ host: runHost, spec });
            host.querySelector('[data-te-legend="running"]').innerHTML = K.legendHtml(spec.legend);
        }

        for (const c of charts) draw(K, c.host, c.spec);
        if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver((entries) => {
                for (const e of entries) {
                    const el = e.target;
                    const w = Math.floor(el.clientWidth);
                    if (w && w !== el._teW) draw(K, el, el._spec && !el._teBars ? el._spec : null);
                }
            });
            charts.forEach((c) => ro.observe(c.host));
            host._teObserver = ro;
        }
    }

    function draw(K, el, spec) {
        el._teW = Math.floor(el.clientWidth);
        if (el._teBars) { el.innerHTML = barsSvg(K, el._teBars, Math.max(280, el._teW)); return; }
        if (!spec) return;
        K.renderChart(el, spec);
        leftAlignUnit(el);
    }

    // The kit right-aligns the unit to the y labels; long units ("°C/decade") would run off the left edge.
    function leftAlignUnit(el) {
        const title = el.querySelector('text.tp-axis-title');
        if (title) { title.setAttribute('text-anchor', 'start'); title.setAttribute('x', '4'); }
    }

    function valuesSpec(K, ctx, frame, series, d, domain, labelOf) {
        const { COLOR } = K;
        const unit = ctx.unit;
        const t = d.trend || {};
        const b = d.baseline || {};
        const pts = series.map((p) => ({ x: p.year, y: p.value, lo: num(p.ci_low), hi: num(p.ci_high), meta: p }));
        const out = [];
        const legend = [];
        const bands = [];
        if (num(b.start) !== null && num(b.end) !== null) {
            bands.push({ x0: b.start - 0.5, x1: b.end + 0.5, fill: 'rgba(82, 81, 78, 0.06)' });
        }
        if (pts.some((p) => p.lo !== null)) {
            out.push({ id: 'ci', kind: 'whisker', name: '95 % CI', color: 'rgba(42, 120, 214, 0.45)', width: 1.4, points: pts, hover: false });
        }
        out.push({ id: 'val', kind: 'line', name: frame.isPeriod ? `${frame.label} mean` : 'Annual mean', color: COLOR.series, width: 1, points: pts, markers: 3.2, gap: 1.5 });
        legend.push({ name: `${frame.isPeriod ? `${frame.label} mean` : 'Annual mean'}${ctx.anomaly ? ' anomaly' : ''} per year${pts.some((p) => p.lo !== null) ? ' ± 95 % CI' : ''}`, color: COLOR.series, style: 'dot' });

        if (t.available !== false && num(t.slope) !== null) {
            const xs = series.map((p) => p.year);
            const ys = series.map((p) => p.value);
            const mx = K.mean(xs);
            const my = K.mean(ys);
            const x0 = xs[0];
            const x1 = xs[xs.length - 1];
            out.push({ id: 'trend', kind: 'line', name: 'OLS trend', color: COLOR.accent, width: 1.6, points: [x0, x1].map((x) => ({ x, y: my + t.slope * (x - mx) })), hover: false });
            const dec = num(t.slope_per_decade) ?? t.slope * 10;
            legend.push({ name: `OLS trend (${rate(K, dec, unit, 'decade', digitsFor([dec]))}, ${pText(t.p_value)})`, color: COLOR.accent, style: 'line' });
        }
        if (num(b.mean) !== null) {
            out.push({ id: 'base', kind: 'line', name: 'Baseline mean', color: COLOR.reference, width: 1, dash: '4,3', points: [{ x: domain[0], y: b.mean }, { x: domain[1], y: b.mean }], hover: false });
            legend.push({ name: `Baseline mean ${labelOf(b.start)}–${labelOf(b.end)} (${K.withUnit(K.fmt(b.mean), unit)}; shaded)`, color: COLOR.reference, style: 'dash' });
        }
        return {
            kind: 'year', height: 230, xDomain: domain, xTicks: yearTicks(domain, labelOf),
            formatX: (x) => `${frame.isPeriod ? `${frame.label} ` : ''}${labelOf(x)}`,
            series: out, bands, legend, unit, yInclude: ctx.anomaly ? [0] : [],
            tooltipExtra: (row) => {
                const p = row.meta;
                if (!p) return '';
                const bits = [];
                if (num(p.ci_low) !== null) bits.push(`95 % CI ${K.fmt(p.ci_low)} to ${K.fmt(p.ci_high)}`);
                if (num(p.anomaly) !== null) bits.push(`${K.withUnit(K.fmtSigned(p.anomaly), unit)} vs. baseline`);
                if (num(p.change_from_previous) !== null) bits.push(`${K.fmtSigned(p.change_from_previous)} vs. previous year`);
                return bits.join(' · ');
            },
            ariaLabel: 'Yearly values with 95 % confidence intervals, linear trend and baseline mean',
        };
    }

    function runningSpec(K, ctx, d, domain, labelOf) {
        const { COLOR } = K;
        const unit = ctx.unit;
        const n = d.running.window_years;
        const t = d.trend || {};
        const pts = d.running.points
            .filter((p) => num(p.slope) !== null && num(p.centre) !== null)
            .map((p) => ({ x: p.centre, y: p.slope * 10, lo: num(p.ci_low) !== null ? p.ci_low * 10 : null, hi: num(p.ci_high) !== null ? p.ci_high * 10 : null, meta: p }));
        const series = [
            { id: 'band', kind: 'area', name: '95 % CI', color: 'rgba(42, 120, 214, 0.14)', points: pts, hover: false },
            { id: 'run', kind: 'line', name: `${n}-year trend`, color: COLOR.series, width: 1.2, points: pts, markers: 3.2, gap: 1.01, hollow: (p) => !p.meta.significant },
        ];
        const legend = [
            { name: `Slope of the ${n}-year window centred on the year (filled: p < 0.05)`, color: COLOR.series, style: 'dot' },
            { name: '95 % CI', color: COLOR.series, style: 'band' },
        ];
        const whole = num(t.slope_per_decade) ?? (num(t.slope) !== null ? t.slope * 10 : null);
        if (whole !== null) {
            series.push({ id: 'whole', kind: 'line', name: 'Whole-period trend', color: COLOR.accent, width: 1, dash: '4,3', points: [{ x: domain[0], y: whole }, { x: domain[1], y: whole }], hover: false });
            legend.push({ name: `Whole-period trend (${rate(K, whole, unit, 'decade', digitsFor([whole]))})`, color: COLOR.accent, style: 'dash' });
        }
        legend.push({ name: 'Zero: no change', color: COLOR.axis, style: 'line' });
        return {
            kind: 'year', height: 210, xDomain: domain, xTicks: yearTicks(domain, labelOf),
            formatX: (x) => {
                const p = pts.find((q) => Math.abs(q.x - x) < 0.26);
                return p ? `Window ${labelOf(p.meta.start)}–${labelOf(p.meta.end)}` : String(x);
            },
            series, bands: [], legend, unit: perUnit(unit, 'decade'), yInclude: [0],
            tooltipExtra: (row) => {
                const p = row.meta;
                if (!p) return '';
                return `95 % CI ${num(row.lo) !== null ? `${K.fmtSigned(row.lo)} to ${K.fmtSigned(row.hi)}` : 'n/a'} · ${pText(p.p)} · ${p.n} years`;
            },
            ariaLabel: `Running ${n}-year trend per decade with 95 % confidence band`,
        };
    }

    // Diverging bars (the kit has no bar mark): anomaly vs. the baseline per year.
    function barsSvg(K, data, width) {
        const { COLOR, esc } = K;
        const { series, domain, unit, pal, labelOf, baseText } = data;
        const pts = series.filter((p) => num(p.anomaly) !== null);
        const height = 190;
        const top = 22;
        const bottom = 30;
        const right = 18;
        let lo = 0;
        let hi = 0;
        for (const p of pts) { lo = Math.min(lo, p.anomaly); hi = Math.max(hi, p.anomaly); }
        if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
        const step = niceStep((hi - lo) / 4);
        const y0 = Math.floor(lo / step) * step;
        const y1 = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let k = 0; y0 + k * step <= y1 + step / 2; k++) ticks.push(y0 + k * step);
        const dec = tickDecimals(step);
        const labels = ticks.map((v) => {
            const s = (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(dec);
            return v > step / 1e6 ? `+${s}` : s.replace('-', '−');
        });
        const left = Math.max(...labels.map((s) => s.length)) * 6.6 + 16;
        const plotW = width - left - right;
        const plotH = height - top - bottom;
        const sx = (x) => left + ((x - domain[0]) / (domain[1] - domain[0] || 1)) * plotW;
        const sy = (v) => top + plotH - ((v - y0) / (y1 - y0)) * plotH;
        const f = (v) => v.toFixed(1);
        const perYear = plotW / Math.max(1, domain[1] - domain[0]);
        const bw = Math.max(1, Math.min(16, perYear * 0.72));
        let out = '';
        ticks.forEach((v, k) => {
            const y = f(sy(v));
            out += `<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${COLOR.grid}" />`;
            out += `<text x="${left - 7}" y="${y}" text-anchor="end" dominant-baseline="middle">${labels[k]}</text>`;
        });
        if (unit) out += `<text class="tp-axis-title" x="4" y="${top - 9}" text-anchor="start">${esc(unit)}</text>`;
        out += `<line x1="${left}" x2="${left + plotW}" y1="${top + plotH}" y2="${top + plotH}" stroke="${COLOR.axis}" />`;
        const ticksX = yearTicks(domain, labelOf)(plotW);
        let lastEnd = -Infinity;
        for (const t of ticksX) {
            const x = sx(t.v);
            const w = t.label.length * 6.4;
            out += `<line x1="${f(x)}" x2="${f(x)}" y1="${top + plotH}" y2="${top + plotH + 4}" stroke="${COLOR.axis}" />`;
            const from = x - w / 2;
            if (from < lastEnd + 8 || from < 0 || x + w / 2 > width) continue;
            lastEnd = from + w;
            out += `<text x="${f(x)}" y="${top + plotH + 17}" text-anchor="middle">${esc(t.label)}</text>`;
        }
        const zy = sy(0);
        for (const p of pts) {
            const x = sx(p.year) - bw / 2;
            const y = sy(Math.max(0, p.anomaly));
            const h = Math.max(0.5, Math.abs(sy(p.anomaly) - zy));
            const color = p.anomaly > 0 ? pal.above : pal.below;
            out += `<rect class="te-bar" x="${f(x)}" y="${f(y)}" width="${f(bw)}" height="${f(h)}" fill="${color}"><title>${esc(`${labelOf(p.year)}: ${K.withUnit(K.fmtSigned(p.anomaly), unit)} vs. ${baseText} mean (value ${K.withUnit(K.fmt(p.value), unit)})`)}</title></rect>`;
        }
        out += `<line x1="${left}" x2="${left + plotW}" y1="${f(zy)}" y2="${f(zy)}" stroke="${COLOR.reference}" stroke-width="1" />`;
        return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Anomaly per year relative to the ${baseText} baseline, bars above zero ${pal.aboveWord}, below zero ${pal.belowWord}`)}">${out}</svg>`;
    }

    // ---------------------------------------------------------------- controls

    function bind(host, st) {
        host.querySelectorAll('[data-te-frame]').forEach((btn) => btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-te-frame');
            const frame = st.ctx.frames.find((f) => String(f.id) === id);
            if (!frame || frame.id === st.frameId) return;
            st.frameId = frame.id;
            render(host, st.ctx);
        }));
        host.querySelectorAll('[data-te-window]').forEach((btn) => btn.addEventListener('click', () => {
            const w = Number(btn.getAttribute('data-te-window'));
            if (btn.disabled || w === st.windowYears) return;
            st.windowYears = w;
            render(host, st.ctx);
        }));
        const sel = host.querySelector('[data-te-baseline]');
        if (sel) sel.addEventListener('change', () => {
            st.baseline = sel.value;
            render(host, st.ctx);
        });
    }

    window.TrendEvolution = { render, clear };
})();
