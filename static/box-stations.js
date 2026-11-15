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
 * One station of the box (a row or a dot) or of an area result (a dot) can be clicked to
 * analyse it alone: window.getSelectedArea() then answers a point at that station, so the
 * normal single-station request runs, while the map greys out the area and highlights the
 * station (trendMap.setFocus). Clicking it again, "Use whole area" or the map's "Whole area"
 * goes back to the area.
 *
 * Uses from index.html: window.getDrawnArea / getSelectedArea, selectedTopics, topicLabel,
 * API_BASE, escapeText, window.refreshMapLayers, triggerButton, window.lastMapLayers,
 * the 'trend:area' and 'trend:inputs' events.
 * Provides: window.areaFocusPoint, window.onMapFeatureClick, window.clearAreaFocus.
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
    let shown = null; // [data, timeintervall, box] of the list on screen
    // The station picked for a single analysis: {area, key, name, coordinates}, or null.
    let focus = null;

    const esc = (v) => escapeText(v == null ? '' : v);
    const year = (iso) => String(iso).slice(0, 4);
    const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

    // The area drawn or picked on the map (never the focused station).
    function drawnArea() {
        const get = window.getDrawnArea || window.getSelectedArea;
        return get ? get() : null;
    }

    function currentBox() {
        const area = drawnArea();
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
        shown = null;
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

    const stationKey = (lon, lat) => `${Number(lon).toFixed(4)},${Number(lat).toFixed(4)}`;

    function stationRow(s) {
        const k = kind(s);
        const key = stationKey(s.longitude, s.latitude);
        const picked = focus && focus.key === key;
        const span = `${year(s.from)}–${year(s.to)}`;
        const note = k === 'full'
            ? ''
            : `<span class="bx-note bx-${k}" title="Record ${esc(fmtDay(s.first))} – ${esc(fmtDay(s.last))}">only ${esc(span)} · ${Math.round(s.coverage * 100)} %</span>`;
        return `<li class="bx-row${picked ? ' is-focus' : ''}" role="button" tabindex="0" data-key="${esc(key)}" aria-pressed="${picked ? 'true' : 'false'}"
            title="${picked ? 'Click again to go back to the whole box' : 'Click to analyse this station alone'}">
            <span class="bx-dot" style="background:${COLORS[k]}" aria-hidden="true"></span>
            <span class="bx-name" title="${esc(s.name)} (${esc(s.source)} ${esc(s.id)})">${esc(s.name)}</span>
            <span class="bx-src">${esc(s.source)}</span>
            ${note || `<span class="bx-note bx-full">${esc(span)}</span>`}
        </li>`;
    }

    function render(data, timeintervall, box, withDots = true) {
        const entries = Object.entries(data.topics || {});
        if (!openTopic || !(openTopic in (data.topics || {}))) openTopic = entries.length ? entries[0][0] : null;
        const period = `${timeintervall[0].slice(-4)}–${timeintervall[1].slice(-4)}`;

        shown = [data, timeintervall, box];
        let html = `<div class="bx-head">
            <h3>Stations in the box</h3>
            <span class="bx-sub">${Math.round(box.properties.areaKm2 || data.area_km2 || 0).toLocaleString('en-US')} km² · data in ${esc(period)}</span>
            ${focus
        ? `<span class="bx-focus">Analysing only <strong>${esc(focus.name)}</strong> · <button type="button" class="bx-whole">Use whole area</button></span>`
        : '<span class="bx-sub bx-hint">Click a station to analyse it alone</span>'}
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
                    html += `<ul class="bx-list${focus ? ' has-focus' : ''}">${info.stations.map(stationRow).join('')}</ul>`;
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
        const whole = card.querySelector('.bx-whole');
        if (whole) whole.addEventListener('click', () => clearFocus());
        const pick = (row) => {
            const s = ((data.topics || {})[openTopic] || {}).stations || [];
            const station = s.find((x) => stationKey(x.longitude, x.latitude) === row.dataset.key);
            if (station) toggleFocus({ key: row.dataset.key, name: station.name, coordinates: [station.longitude, station.latitude] });
        };
        card.querySelectorAll('.bx-row[data-key]').forEach((row) => {
            row.addEventListener('click', () => pick(row));
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                pick(row);
            });
        });
        if (withDots) setMapDots(data);
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
                        _key: stationKey(s.longitude, s.latitude),
                        tooltip: `${s.name} (${s.source})\n${kind(s) === 'full' ? 'whole time frame' : `${year(s.from)}–${year(s.to)} · ${Math.round(s.coverage * 100)} %`}\nClick: analyse this station alone`,
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

    // ---- One station of the area, analysed alone ----

    // Point at the focused station: what the analysis is run for while a station is picked.
    window.areaFocusPoint = function () {
        if (!focus) return null;
        const [lon, lat] = focus.coordinates;
        return {
            type: 'Feature',
            bbox: [lon, lat, lon, lat],
            properties: {
                selectionId: `station-${focus.key}`,
                shape: 'point',
                placeName: focus.name,
                areaStation: true,
                crossesAntimeridian: false,
                areaKm2: 0,
            },
            geometry: { type: 'Point', coordinates: [lon, lat] },
        };
    };

    // An analysis is on screen, so a new pick re-runs it right away (else Analyze does).
    function rerunIfShown() {
        const apply = document.getElementById('apply');
        if (!window.lastMapLayers || !window.lastMapLayers.length || !apply || apply.disabled) return;
        if (typeof triggerButton === 'function') triggerButton('apply');
    }

    function applyFocus() {
        if (window.trendMap && typeof window.trendMap.setFocus === 'function') {
            window.trendMap.setFocus(focus ? {
                coordinates: focus.coordinates,
                label: focus.name,
                dimLayers: ['box-stations', 'area-stations-*', 'area-result'],
            } : null);
        }
        if (window.refreshMapLayers) window.refreshMapLayers();
        if (shown) render(...shown, false); // only the list; the dots keep their state
        window.dispatchEvent(new Event('trend:area')); // Analyze button and its status line
    }

    function toggleFocus(station) {
        const area = drawnArea();
        if (!area || !area.geometry || area.geometry.type !== 'Polygon') return;
        if (focus && focus.key === station.key) {
            clearFocus();
            return;
        }
        focus = { ...station, area };
        applyFocus();
        rerunIfShown();
    }

    function clearFocus(rerun = true) {
        if (!focus) return;
        focus = null;
        applyFocus();
        if (rerun) rerunIfShown();
    }
    window.clearAreaFocus = () => clearFocus();

    // A station dot on the map (box preview or area result) picks that station.
    window.onMapFeatureClick = function (hit) {
        const id = String(hit.layerId || '');
        if (id !== 'box-stations' && !id.startsWith('area-stations-')) return false;
        let coordinates = null;
        let name = '';
        if (id === 'box-stations') {
            const feature = ((window.boxStationsLayer || {}).data || { features: [] }).features
                .find((f) => f.properties._key === hit.properties._key);
            if (feature) {
                coordinates = feature.geometry.coordinates;
                name = String(feature.properties.Station || '').replace(/ \([^()]*\)$/, '');
            }
        } else {
            // Exact position from the result itself (rendered features are tile-rounded).
            const layer = (window.lastMapLayers || []).find((l) => l.id === id);
            const feature = layer && layer.data && layer.data.features
                .find((f) => f.properties && f.properties.Station === hit.properties.Station);
            if (feature) {
                coordinates = feature.geometry.coordinates;
                name = String(feature.properties.Station || '').replace(/ \([^()]*\)$/, '');
            }
        }
        if (!coordinates) return false;
        toggleFocus({ key: stationKey(coordinates[0], coordinates[1]), name: name || 'Station', coordinates: [coordinates[0], coordinates[1]] });
        return true;
    };

    // A new or deleted area ends the focus on one of its stations.
    window.addEventListener('trend:area', () => {
        if (focus && drawnArea() !== focus.area) clearFocus(false);
    });
    window.addEventListener('trend:area', schedule);
    window.addEventListener('trend:inputs', schedule);
})();
