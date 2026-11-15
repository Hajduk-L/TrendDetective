/*
 * Simple mode: one widget per variable (static/mode.js switches modes).
 *
 * Each widget answers "is it changing?" in plain words for one series:
 *   - the change every 10 years, with a certainty label (from the p-value)
 *   - a small chart: every complete year as a bar above / below its average,
 *     with the trend line
 *   - one sentence about the warmest / coldest (wettest / driest ...) year
 *   - average, highest and lowest single value with their dates
 *
 * The yearly averages are computed here from the raw values the Apply stream
 * delivers; the trend comes from POST /api/evolution (the same statistics the
 * scientific view shows). index.html calls setData / setLoading next to the
 * plot panel's. "Details" switches to Scientific mode and opens that series.
 */
(function () {
    'use strict';

    const API = '/api/evolution';
    const INTERVAL_DAYS = { Day: 1, Month: 30.436875, Year: 365.2425 };
    const MIN_YEARS = 3;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const PALETTE = {
        warm: { up: '#cb181d', down: '#2171b5', upW: 'warmer', downW: 'colder', hiW: 'warmest', loW: 'coldest' },
        wet: { up: '#35978f', down: '#bf812d', upW: 'wetter', downW: 'drier', hiW: 'wettest', loW: 'driest' },
        neutral: { up: '#6250d6', down: '#8f6a00', upW: 'higher', downW: 'lower', hiW: 'highest', loW: 'lowest' },
    };

    const state = { host: null, viz: null, request: null, loading: false };
    const cache = new Map(); // request body -> { pending } | { data } | { error }

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

    function label(key) {
        const k = K();
        return k && k.topicLabel ? k.topicLabel(key) : key;
    }

    // One decimal from 1 up (records read as on the station sheet: 112.8 mm), more below.
    function round(v) {
        const a = Math.abs(v);
        const dg = a >= 1000 ? 0 : a >= 1 ? 1 : a >= 0.1 ? 2 : 3;
        return Number(v.toFixed(dg));
    }

    function show(v, unit, signed) {
        const r = round(v);
        const s = Math.abs(r).toLocaleString('en-US', { maximumFractionDigits: 3 });
        const sign = r < 0 ? '−' : signed && r > 0 ? '+' : '';
        return `${sign}${s}${unit ? (unit.startsWith('%') ? unit : ` ${unit}`) : ''}`;
    }

    function parseDate(label) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(label || ''));
        return m ? { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) } : null;
    }

    function dateText(dt, stepDays) {
        if (!dt) return '';
        if (stepDays >= 300) return String(dt.y);
        if (stepDays >= 20) return `${MONTHS[dt.m - 1]} ${dt.y}`;
        return `${dt.d} ${MONTHS[dt.m - 1]} ${dt.y}`;
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

    // ------------------------------------------------------------ yearly values

    const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    // Day of the year 0..364 (29 Feb shares 28 Feb's slot), as in plots.js.
    function dayOfYear(month, day) {
        if (month === 2 && day === 29) return MONTH_START[1] + 27;
        return MONTH_START[month - 1] + Math.min(day, MONTH_DAYS[month - 1]) - 1;
    }

    // The interval's midpoint decides its year and time of year (as in plots.js).
    function midpoint(dt, stepDays) {
        if (stepDays <= 1) return dt;
        const t = Date.UTC(dt.y, dt.m - 1, dt.d) + (stepDays * 86400000) / 2;
        const d = new Date(t);
        return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }

    // One value per year, computed like the scientific view's annual mean: the mean
    // normal of the year plus the year's mean departure from the normal of each
    // calendar day (or month), so missing days do not bias a year. A year counts
    // with at least half of its values. Daily precipitation is shown as the yearly total.
    function summarise(key, info, stepDays) {
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
            pts.push({ v, year: mid.y, bucket: monthly ? mid.m - 1 : dayOfYear(mid.m, mid.d) });
            if (!hi || v > hi.v) hi = { v, dt };
            if (!lo || v < lo.v) lo = { v, dt };
        });
        const n = pts.length;
        const mean = n ? pts.reduce((a, p) => a + p.v, 0) / n : null;
        const yearSet = [...new Set(pts.map((p) => p.year))].sort((a, b) => a - b);
        const totals = unit === 'mm/day' && stepDays <= 1;
        const scale = totals ? 365.2425 : 1;
        let years;
        if (stepDays >= 300) {
            years = pts.map((p) => ({ year: p.year, value: p.v * scale }));
        } else {
            const normals = new Map();
            const useNormals = stepDays <= 62 && yearSet.length >= 2;
            if (useNormals) {
                const acc = new Map();
                for (const p of pts) {
                    const a = acc.get(p.bucket) || [0, 0];
                    a[0] += p.v; a[1] += 1;
                    acc.set(p.bucket, a);
                }
                for (const [b, [sum, cnt]] of acc) normals.set(b, sum / cnt);
            }
            const periodNormal = useNormals ? pts.reduce((a, p) => a + normals.get(p.bucket), 0) / n : null;
            const expected = Math.max(1, Math.round(365 / stepDays));
            years = yearSet.map((y) => {
                const ps = pts.filter((p) => p.year === y);
                const value = useNormals
                    ? periodNormal + ps.reduce((a, p) => a + (p.v - normals.get(p.bucket)), 0) / ps.length
                    : ps.reduce((a, p) => a + p.v, 0) / ps.length;
                return { year: y, value: value * scale, complete: ps.length >= Math.max(1, Math.floor(expected * 0.5)) };
            }).filter((r) => r.complete);
        }
        return {
            key, info, unit, totals,
            yearUnit: totals ? 'mm' : unit,
            kind: kindOf(key, unit),
            years, hi, lo, n, mean,
        };
    }

    function evolutionFor(s) {
        if (s.years.length < MIN_YEARS) return null;
        const body = JSON.stringify({ years: s.years.map((r) => r.year), values: s.years.map((r) => r.value) });
        let entry = cache.get(body);
        if (!entry) {
            entry = { pending: true };
            cache.set(body, entry);
            fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                    cache.set(body, { data });
                })
                .catch((err) => cache.set(body, { error: String((err && err.message) || err) }))
                .finally(render);
        }
        return entry;
    }

    // ----------------------------------------------------------------- verdict

    function verdict(t, nYears) {
        const p = num(t.p_value ?? t.p);
        if (nYears < 8) return { cls: 'is-weak', word: 'Too few years', text: `${nYears} years are too few to tell a trend from chance. Choose a longer time range.` };
        if (p === null) return null;
        if (p < 0.01) return { cls: 'is-clear', word: 'Clear trend', text: 'This change is clear in the data and very unlikely to be chance.' };
        if (p < 0.05) return { cls: 'is-likely', word: 'Likely trend', text: 'This change is probably real, but not certain.' };
        return { cls: 'is-weak', word: 'Could be chance', text: 'The years go up and down a lot, so this change could still be chance.' };
    }

    // ------------------------------------------------------------------ render

    function mount(host) {
        state.host = host;
        host.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-simple-details]');
            if (!b) return;
            const key = b.dataset.simpleDetails;
            if (window.TrendMode) window.TrendMode.set('scientific');
            // The plot panel's availability list opens and scrolls to a series.
            requestAnimationFrame(() => {
                const go = [...document.querySelectorAll('#plot-panel [data-goto]')].find((x) => x.dataset.goto === key);
                if (go) go.click();
                else document.getElementById('plot-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
        render();
    }

    function setData(viz, request) {
        state.viz = viz || null;
        state.request = request || null;
        render();
    }

    function setLoading(on) {
        state.loading = Boolean(on);
        if (on) { state.viz = null; state.request = null; }
        render();
    }

    function render() {
        const host = state.host;
        if (!host) return;
        const topics = state.viz && state.viz.topics ? Object.entries(state.viz.topics) : [];
        if (!topics.length) {
            host.innerHTML = `<div class="sw-empty">${state.loading
                ? 'Loading data…'
                : 'Pick a place on the map (or a case study above), choose variables on the left and click “Analyze”. Each variable then gets its own card here.'}</div>`;
            return;
        }
        const stepDays = stepDaysOf(state.request);
        const range = state.request && Array.isArray(state.request.timeintervall) ? state.request.timeintervall : null;
        const firstInfo = topics[0][1] || {};
        const head = `<div class="sw-head"><h3 class="sw-title">At a glance</h3>`
            + `<span class="sw-sub">${esc([siteOf(firstInfo), range ? `${range[0]} – ${range[1]}` : ''].filter(Boolean).join(' · '))}</span></div>`;
        const cards = topics.map(([key, info]) => card(key, info || {}, stepDays)).join('');
        const more = state.loading ? '<div class="sw-card sw-card-pending">Loading the next variable…</div>' : '';
        host.innerHTML = `${head}<div class="sw-grid">${cards}${more}</div>`;
    }

    function card(key, info, stepDays) {
        const name = label(key);
        const values = Array.isArray(info.values) ? info.values.filter((v) => num(v) !== null) : [];
        if (info.error || !values.length) {
            return `<article class="sw-card sw-card-failed"><h4 class="sw-name">${esc(name)}</h4>`
                + `<p class="sw-note">No data for this place and time range${info.error ? `: ${esc(info.error)}` : '.'}</p></article>`;
        }
        const s = summarise(key, info, stepDays);
        const pal = PALETTE[s.kind];
        const yearsText = s.years.length ? `${s.years[0].year}–${s.years[s.years.length - 1].year}` : '';
        let html = `<article class="sw-card"><header class="sw-card-head"><h4 class="sw-name">${esc(name)}</h4>`
            + `<span class="sw-meta">${esc([siteOf(info), yearsText].filter(Boolean).join(' · '))}</span></header>`;

        const entry = evolutionFor(s);
        if (!entry) {
            html += `<p class="sw-note">At least ${MIN_YEARS} full years are needed to show a trend; this selection has ${s.years.length}. Choose a longer time range.</p>`;
        } else if (entry.pending) {
            html += '<p class="sw-note" role="status">Working out the trend…</p>';
        } else if (entry.error) {
            html += `<p class="sw-note">The trend could not be computed: ${esc(entry.error)}</p>`;
        } else {
            html += trendBlock(s, entry.data, pal);
        }
        html += factsRow(s, stepDays, pal);
        html += `<button type="button" class="sw-details" data-simple-details="${esc(key)}">Details and statistics →</button></article>`;
        return html;
    }

    function trendBlock(s, d, pal) {
        const t = d.trend || {};
        const dec = num(t.slope_per_decade) ?? (num(t.slope) !== null ? t.slope * 10 : null);
        const series = (d.series || []).filter((p) => num(p.value) !== null);
        let html = '';
        if (t.available !== false && dec !== null) {
            const v = verdict(t, series.length);
            const flat = round(dec) === 0;
            const color = flat ? '#52514e' : dec > 0 ? pal.up : pal.down;
            const arrow = flat ? '→' : dec > 0 ? '↑' : '↓';
            const what = flat ? 'about the same' : dec > 0 ? pal.upW : pal.downW;
            html += '<div class="sw-trend">'
                + `<div class="sw-big" style="color:${color}"><span class="sw-arrow" aria-hidden="true">${arrow}</span>${esc(show(dec, s.yearUnit, true))}</div>`
                + `<div class="sw-big-sub">every 10 years${s.totals ? ' (yearly total)' : ''}${flat ? '' : ` · ${esc(what)}`}</div>`
                + (v ? `<span class="sw-verdict ${v.cls}">${esc(v.word)}</span>` : '')
                + '</div>';
            if (v) html += `<p class="sw-explain">${esc(v.text)}</p>`;
        }
        html += chart(s, d, pal);
        html += yearsSentence(s, series, pal, d);
        return html;
    }

    // Bars: each year's difference to the average of all shown years; line: the trend.
    function chart(s, d, pal) {
        const series = (d.series || []).filter((p) => num(p.value) !== null);
        if (series.length < 2) return '';
        const avg = series.reduce((a, p) => a + p.value, 0) / series.length;
        const t = d.trend || {};
        const W = 300;
        const H = 84;
        const pad = 4;
        const n = series.length;
        const bw = (W - 2 * pad) / n;
        const xs = series.map((p) => p.year);
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const trendAt = (y) => (num(t.slope) !== null ? avg + t.slope * (y - mx) - avg : null);
        const devs = series.map((p) => p.value - avg);
        const ends = [trendAt(xs[0]), trendAt(xs[n - 1])].filter((v) => v !== null);
        const amp = Math.max(...devs.map(Math.abs), ...ends.map(Math.abs)) || 1;
        const y0 = H / 2;
        const sy = (v) => y0 - (v / amp) * (H / 2 - pad);
        let bars = '';
        series.forEach((p, i) => {
            const dv = devs[i];
            const x = pad + i * bw + bw * 0.12;
            const y = Math.min(sy(dv), y0);
            const h = Math.max(0.8, Math.abs(sy(dv) - y0));
            bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" fill="${dv >= 0 ? pal.up : pal.down}" opacity="0.85">`
                + `<title>${p.year}: ${esc(show(p.value, s.yearUnit))} (${esc(show(dv, s.yearUnit, true))} vs. average)</title></rect>`;
        });
        let line = '';
        if (ends.length === 2) {
            const x1 = pad + bw / 2;
            const x2 = W - pad - bw / 2;
            line = `<line x1="${x1.toFixed(1)}" y1="${sy(ends[0]).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${sy(ends[1]).toFixed(1)}" stroke="#0b0b0b" stroke-width="1.6" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"/>`;
        }
        const aria = `Each year from ${xs[0]} to ${xs[n - 1]} compared with the average of ${show(avg, s.yearUnit)}, with the trend line`;
        return `<figure class="sw-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}">`
            + `<line x1="0" x2="${W}" y1="${y0}" y2="${y0}" stroke="#c8c6c1" stroke-width="1" vector-effect="non-scaling-stroke"/>${bars}${line}</svg>`
            + `<figcaption class="sw-axis"><span>${xs[0]}</span><span>bars: year vs. average · dashed: trend</span><span>${xs[n - 1]}</span></figcaption></figure>`;
    }

    function yearsSentence(s, series, pal) {
        if (series.length < 2) return '';
        let top = series[0];
        let bot = series[0];
        for (const p of series) { if (p.value > top.value) top = p; if (p.value < bot.value) bot = p; }
        const avg = series.reduce((a, p) => a + p.value, 0) / series.length;
        const above = series.filter((p) => p.value > avg).length;
        let txt = `${top.year} was the ${pal.hiW} year (${show(top.value, s.yearUnit)}), ${bot.year} the ${pal.loW} (${show(bot.value, s.yearUnit)}).`;
        if (series.length >= 8) {
            const lastAbove = series.slice(-5).filter((p) => p.value > avg).length;
            txt += ` ${lastAbove} of the last 5 years were ${pal.upW} than average.`;
        } else {
            txt += ` ${above} of ${series.length} years were ${pal.upW} than average.`;
        }
        return `<p class="sw-years">${esc(txt)}</p>`;
    }

    function factsRow(s, stepDays, pal) {
        const per = stepDays <= 1 ? 'day' : stepDays >= 300 ? 'year' : stepDays >= 20 ? 'month' : 'value';
        const facts = [];
        if (s.totals && s.years.length) {
            const avgYear = s.years.reduce((a, r) => a + r.value, 0) / s.years.length;
            facts.push(['Average year', show(avgYear, 'mm')]);
        } else if (num(s.mean) !== null) {
            facts.push(['Average', show(s.mean, s.unit)]);
        }
        const u = s.totals ? 'mm' : s.unit;
        if (s.hi) facts.push([s.kind === 'neutral' ? `Highest ${per}` : `${cap(pal.hiW)} ${per}`, show(s.hi.v, u), dateText(s.hi.dt, stepDays)]);
        if (s.lo && s.kind !== 'wet') facts.push([`${cap(s.kind === 'neutral' ? 'lowest' : pal.loW)} ${per}`, show(s.lo.v, u), dateText(s.lo.dt, stepDays)]);
        if (!facts.length) return '';
        return `<dl class="sw-facts">${facts.map(([k, v, sub]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub ? `<span>${esc(sub)}</span>` : ''}</dd></div>`).join('')}</dl>`;
    }

    function cap(w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
    }

    window.TrendSimple = { mount, setData, setLoading };
})();
