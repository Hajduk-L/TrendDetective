/*
 * Stations of a box drawn on the map (Box tool), before anything is analysed.
 *
 * Whenever the box, the selected variables or the time frame change, POST /api/stations
 * (area_analysis.stations_in_box) lists every station in the box with data for the variable
 * in the time frame. Stations that only cover part of it are listed too, with the years they
 * cover. The result goes into #box-stations (below the map) and onto the map as dots:
 *   green  covers the whole time frame
 *   teal   covers enough of it (>= 80 %) to be used in the area mean
 *   amber  covers only a part; shown, but too short for the area mean
 *
 * Uses from index.html: window.getSelectedArea, selectedTopics, topicLabel, API_BASE,
 * escapeText, window.refreshMapLayers, the 'trend:area' and 'trend:inputs' events.
 */
(function () {
    'use strict';

    const card = document.getElementById('box-stations');
    if (!card) return;
    const COLORS = { full: '#15803d', used: '#0d9488', partial: '#d97706' };
    const DEBOUNCE_MS = 500;

    let timer = null;
    let requestNo = 0;
    let lastKey = '';
    let openTopic = null;

    const esc = (v) => escapeText(v == null ? '' : v);
    const year = (iso) => String(iso).slice(0, 4);
    const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

    function currentBox() {
        const area = window.getSelectedArea && window.getSelectedArea();
        return area && area.properties && area.properties.shape === 'box' ? area : null;
    }

    function inputs() {
        const topics = Object.keys(selectedTopics).filter((t) => selectedTopics[t]);
        const start = document.getElementById('timeintervall-start').value.trim();
        const end = document.getElementById('timeintervall-end').value.trim();
        return { topics, timeintervall: [start, end] };
    }

    function kind(station) {
        if (station.coverage >= 0.999) return 'full';
        return station.used ? 'used' : 'partial';
    }

    function clear() {
        card.hidden = true;
        card.innerHTML = '';
        lastKey = '';
        if (window.boxStationsLayer) {
            window.boxStationsLayer = null;
            window.refreshMapLayers();
        }
    }

    function schedule() {
        clearTimeout(timer);
        const box = currentBox();
        if (!box) { requestNo++; clear(); return; }
        const { topics, timeintervall } = inputs();
        const valid = /^\d{2}\.\d{2}\.\d{4}$/;
        if (!topics.length || !valid.test(timeintervall[0]) || !valid.test(timeintervall[1])) {
            requestNo++;
            card.hidden = false;
            card.innerHTML = '<p class="bx-empty">Choose a variable and a time range to see which stations in the box have data.</p>';
            return;
        }
        const key = JSON.stringify([box.bbox, topics, timeintervall]);
        if (key === lastKey) return;
        timer = setTimeout(() => load(box, topics, timeintervall, key), DEBOUNCE_MS);
    }

    async function load(box, topics, timeintervall, key) {
        const no = ++requestNo;
        lastKey = key;
        card.hidden = false;
        card.classList.add('is-loading');
        if (!card.querySelector('.bx-head')) {
            card.innerHTML = '<p class="bx-empty"><span class="bx-spinner" aria-hidden="true"></span>Looking for stations in the box…</p>';
        }
        try {
            const res = await fetch(`${API_BASE}/api/stations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ area: box, topics, timeintervall }),
            });
            const data = await res.json().catch(() => ({}));
            if (no !== requestNo) return;
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            render(data, timeintervall, box);
        } catch (error) {
            if (no !== requestNo) return;
            lastKey = '';
            card.innerHTML = `<p class="bx-empty bx-error">Could not look up the stations: ${esc(error.message)}</p>`;
        } finally {
            if (no === requestNo) card.classList.remove('is-loading');
        }
    }

    function topicSummary(info) {
        if (info.point_only) return 'only at a point (no fixed stations to average)';
        if (!info.total) return 'no station with data';
        const parts = [`${info.total} station${info.total === 1 ? '' : 's'}`];
        if (info.partial) parts.push(`${info.partial} only partly`);
        return parts.join(' · ');
    }

    function verdict(info) {
        if (info.point_only) return ['warn', 'Pick a point for this variable'];
        if (info.usable >= info.needed) return ['ok', `${info.usable} usable for the area mean`];
        if (info.total) return ['warn', `${info.usable} of ${info.needed} needed cover enough of the time frame`];
        return ['bad', 'No data here'];
    }

    function stationRow(s) {
        const k = kind(s);
        const span = `${year(s.from)}–${year(s.to)}`;
        const note = k === 'full'
            ? ''
            : `<span class="bx-note bx-${k}" title="Record ${esc(fmtDay(s.first))} – ${esc(fmtDay(s.last))}">only ${esc(span)} · ${Math.round(s.coverage * 100)} %</span>`;
        return `<li class="bx-row">
            <span class="bx-dot" style="background:${COLORS[k]}" aria-hidden="true"></span>
            <span class="bx-name" title="${esc(s.name)} (${esc(s.source)} ${esc(s.id)})">${esc(s.name)}</span>
            <span class="bx-src">${esc(s.source)}</span>
            ${note || `<span class="bx-note bx-full">${esc(span)}</span>`}
        </li>`;
    }

    function render(data, timeintervall, box) {
        const entries = Object.entries(data.topics || {});
        if (!openTopic || !(openTopic in (data.topics || {}))) openTopic = entries.length ? entries[0][0] : null;
        const period = `${timeintervall[0].slice(-4)}–${timeintervall[1].slice(-4)}`;

        let html = `<div class="bx-head">
            <h3>Stations in the box</h3>
            <span class="bx-sub">${Math.round(box.properties.areaKm2 || data.area_km2 || 0).toLocaleString('en-US')} km² · data in ${esc(period)}</span>
        </div>`;
        if (data.problem) {
            html += `<p class="bx-empty bx-error">${esc(data.problem)}</p>`;
        } else {
            html += '<div class="bx-tabs" role="tablist">' + entries.map(([topic, info]) => {
                const [tone, text] = verdict(info);
                return `<button type="button" role="tab" class="bx-tab" data-topic="${esc(topic)}" aria-selected="${topic === openTopic}">
                    <span class="bx-tab-name">${esc(topicLabel(topic))}</span>
                    <span class="bx-tab-sum">${esc(topicSummary(info))}</span>
                    <span class="bx-verdict bx-${tone}">${esc(text)}</span>
                </button>`;
            }).join('') + '</div>';
            const info = (data.topics || {})[openTopic];
            if (info) {
                const errors = (info.errors || []).length ? `<p class="bx-src-errors">Not reachable: ${esc(info.errors.join('; '))}</p>` : '';
                if (info.stations && info.stations.length) {
                    html += `<ul class="bx-list">${info.stations.map(stationRow).join('')}</ul>`;
                    if (info.total > info.stations.length) html += `<p class="bx-more">and ${info.total - info.stations.length} more with shorter records</p>`;
                    html += `<p class="bx-legend">
                        <span><span class="bx-dot" style="background:${COLORS.full}"></span>whole time frame</span>
                        <span><span class="bx-dot" style="background:${COLORS.used}"></span>≥ ${Math.round((info.min_coverage || 0.8) * 100)} %, used in the area mean</span>
                        <span><span class="bx-dot" style="background:${COLORS.partial}"></span>part only, not used</span>
                    </p>`;
                } else if (!info.point_only) {
                    html += '<p class="bx-empty">No station in the box has data for this variable in the time frame. Draw a larger box or change the time range.</p>';
                } else {
                    html += '<p class="bx-empty">This variable comes from hourly reports or moving platforms, which cannot be averaged over an area. Use the Point tool for it.</p>';
                }
                html += errors;
            }
        }
        card.innerHTML = html;
        card.querySelectorAll('.bx-tab').forEach((tab) => tab.addEventListener('click', () => {
            openTopic = tab.dataset.topic;
            render(data, timeintervall, box);
        }));
        setMapDots(data);
    }

    function setMapDots(data) {
        const info = (data.topics || {})[openTopic];
        const stations = (info && info.stations) || [];
        window.boxStationsLayer = stations.length ? {
            type: 'geojson',
            id: 'box-stations',
            pointRadius: 5,
            data: {
                type: 'FeatureCollection',
                features: stations.map((s) => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
                    properties: {
                        Station: `${s.name} (${s.source})`,
                        Variable: topicLabel(openTopic),
                        Record: `${fmtDay(s.first)} – ${fmtDay(s.last)}`,
                        'In your time frame': kind(s) === 'full'
                            ? 'complete'
                            : `${fmtDay(s.from)} – ${fmtDay(s.to)} (${Math.round(s.coverage * 100)} %)`,
                        'Area mean': s.used ? 'used' : 'not used (covers too little)',
                        color: COLORS[kind(s)],
                    },
                })),
            },
        } : null;
        window.boxPreviewHidden = false;
        window.refreshMapLayers();
    }

    window.addEventListener('trend:area', schedule);
    window.addEventListener('trend:inputs', schedule);
})();
