/*
 * Help button, help dialog and the introductory tour (static/help.css).
 *
 *   - A round "?" button, fixed at the bottom-right of the viewport, opens a
 *     <dialog> that explains the features. "Start the tutorial" in it runs the tour.
 *   - The tour highlights the real controls one by one (spotlight + card with
 *     Back / Next / Skip; arrow keys navigate, Esc skips). It starts by itself on
 *     the first visit; localStorage 'trenddetective-tour-done' remembers that it
 *     was finished or skipped. Steps whose target is missing or hidden (e.g.
 *     because of the current Simple / Scientific mode) are skipped; the user's
 *     mode is never switched. Targets in the left sidebar open it first
 *     (window.TrendSidebar from static/sidebar.js, when present).
 *
 * Public API: window.TrendHelp = { openHelp(), startTour() }
 */
(function () {
    'use strict';

    const TOUR_KEY = 'trenddetective-tour-done';
    const NARROW = '(max-width: 860px)';
    const MARGIN = 12;   // card distance to the viewport edge
    const GAP = 12;      // card distance to the highlighted element
    const PAD = 6;       // spotlight padding around the element

    const $ = (sel) => document.querySelector(sel);
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const isNarrow = () => !!(window.matchMedia && window.matchMedia(NARROW).matches);
    const currentMode = () => (window.TrendMode && window.TrendMode.get ? window.TrendMode.get() : document.documentElement.dataset.mode) || 'simple';

    function tourDone() {
        try {
            return window.localStorage.getItem(TOUR_KEY) === '1';
        } catch (err) {
            return null; // unknown: storage blocked
        }
    }
    function markTourDone() {
        try { window.localStorage.setItem(TOUR_KEY, '1'); } catch (err) { /* not remembered */ }
    }

    function el(tag, attrs, html) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
            if (k === 'class') node.className = v;
            else node.setAttribute(k, v);
        });
        if (html != null) node.innerHTML = html;
        return node;
    }

    // ------------------------------------------------------------------ help

    const HELP_HTML = `
        <h3>Getting started</h3>
        <p>Pick a place on the map, tick one or more variables, set the time range and press <strong>Analyze</strong>.
        Or pick an event in the <strong>Try an event</strong> row above the map to jump straight to a documented extreme.</p>

        <h3>Simple and Scientific mode</h3>
        <ul>
            <li><strong>Simple</strong>: an automatic dashboard. The app runs all analyses itself and shows the key findings in plain words.</li>
            <li><strong>Scientific</strong>: you choose time frames and methods yourself and see all plots, tests and confidence intervals.</li>
        </ul>
        <p>Switch at the top of the left panel; your choice is remembered.</p>

        <h3>Place</h3>
        <ul>
            <li><strong>Point</strong>: click the map to pick a place. <strong>Box</strong>: drag a rectangle (up to 1,000,000 km²); the stations inside it with data for your variables and time range are listed under the map and shown as dots. <strong>Areas</strong> offers ready-made regions. <strong>Edit</strong> moves or resizes the selection.</li>
            <li><strong>Search</strong> a city, region or coordinates (lat, lon) in the box on the map.</li>
            <li>For a notable day in the results you can show that day's <strong>satellite image</strong> on the map and step day by day.</li>
        </ul>

        <h3>Variables and time</h3>
        <ul>
            <li>Search and tick variables in the list (station data, weather model, satellite, marine). A <span class="th-x">✕</span> means no data in the selected area.</li>
            <li>Dates are written as <strong>DD.MM.YYYY</strong>, or use a quick range (10, 30, 50 years, since 1950). In Scientific mode, <strong>Average per</strong> sets how values are grouped (e.g. 1 Month).</li>
        </ul>

        <h3>Results in Simple mode</h3>
        <p>Key findings first, then per variable a grid of tiles: trend, the whole record, seasons, a typical year, sudden shifts,
        decades and extremes, plus how the variables relate. <strong>Click a tile</strong> to flip it open with its chart and details.</p>

        <h3>Results in Scientific mode</h3>
        <ul>
            <li>Timeline, years overlaid, or one period across the years; anomalies and moving averages.</li>
            <li>Trends with OLS, Sen's slope and the Mann-Kendall test; change points.</li>
            <li>Change over time (per decade, running trend) and comparisons and correlations between variables, including lags.</li>
        </ul>`;

    let helpBtn = null;
    let dialog = null;

    function buildHelp() {
        helpBtn = el('button', {
            type: 'button',
            class: 'th-help-btn',
            id: 'th-help-btn',
            'aria-label': 'Help: what can TrendDetective do?',
            title: 'Help',
            'aria-haspopup': 'dialog',
        }, '?');
        helpBtn.addEventListener('click', openHelp);

        dialog = el('dialog', { class: 'th-help-dialog', 'aria-labelledby': 'th-help-title' });
        dialog.innerHTML = `
            <div class="th-help-inner">
                <div class="th-help-head">
                    <h2 id="th-help-title">What can TrendDetective do?</h2>
                    <button type="button" class="th-help-close" aria-label="Close help">✕</button>
                </div>
                <div class="th-help-body">${HELP_HTML}</div>
                <div class="th-help-foot">
                    <button type="button" class="th-btn th-help-close-btn">Close</button>
                    <button type="button" class="th-btn th-btn-primary th-help-tour">Start the tutorial</button>
                </div>
            </div>`;
        dialog.querySelector('.th-help-close').addEventListener('click', () => dialog.close());
        dialog.querySelector('.th-help-close-btn').addEventListener('click', () => dialog.close());
        dialog.querySelector('.th-help-tour').addEventListener('click', () => {
            dialog.close();
            startTour();
        });
        // A click on the backdrop lands on the <dialog> itself (the inner box fills it).
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        dialog.addEventListener('close', () => {
            if (!tour.active && helpBtn) helpBtn.focus();
        });

        document.body.appendChild(helpBtn);
        document.body.appendChild(dialog);
    }

    function openHelp() {
        if (!dialog) return;
        if (tour.active) endTour(false);
        if (dialog.open) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        const body = dialog.querySelector('.th-help-body');
        if (body) body.scrollTop = 0;
        dialog.querySelector('.th-help-tour').focus();
    }

    // ------------------------------------------------------------------ tour

    const all = (...sels) => sels.map((s) => (typeof s === 'string' ? $(s) : s)).filter(Boolean);
    const timeGroup = () => {
        const start = $('#timeintervall-start');
        return start ? start.closest('.sb-section') : null;
    };

    const STEPS = [
        {
            title: 'Welcome to TrendDetective',
            text: () => 'Explore how the climate has changed at any place on Earth. This short tour shows the main controls and takes about a minute.',
        },
        {
            title: 'Simple or Scientific',
            targets: () => all('.mode-switch'),
            text: () => `<strong>Simple</strong> shows an automatic dashboard with the key findings in plain words. <strong>Scientific</strong> lets you choose the analyses yourself. You are in ${currentMode() === 'scientific' ? 'Scientific' : 'Simple'} mode; switch here any time.`,
        },
        {
            title: 'Pick a place',
            targets: () => all('.map-box'),
            text: () => 'Click the map to choose a <strong>point</strong>, or drag a <strong>Box</strong>: the stations inside it are listed under the map. <strong>Areas</strong> offers ready-made regions.',
        },
        {
            title: 'Search a place',
            targets: () => all('.place-search'),
            text: () => 'Type a city, a region or coordinates (lat, lon) and the map zooms there.',
        },
        {
            title: 'Or try an event',
            targets: () => all('#examples-card'),
            text: () => 'Documented extremes such as heat waves or floods. Scroll the row with ‹ ›; choosing one loads ten years of data around it and jumps to the event.',
        },
        {
            title: 'Choose variables',
            targets: () => all('.sb-variables'),
            text: () => 'Search and tick the variables you want, e.g. temperature or precipitation; your choice shows as chips. A red <span class="th-x">✕</span> means there is no data for it in the selected area.',
        },
        {
            title: 'Set the time range',
            targets: () => all(timeGroup()),
            text: () => (currentMode() === 'scientific'
                ? 'Enter start and end as DD.MM.YYYY or pick a quick range. <strong>Average per</strong> sets how values are grouped, e.g. 1 Month for monthly means.'
                : 'Enter start and end as DD.MM.YYYY or pick a quick range (10, 30, 50 years, since 1950).'),
        },
        {
            title: 'Analyze',
            targets: () => all('.top-bar'),
            text: () => 'Once a place, at least one variable and valid dates are set, this button turns active. Click it to fetch the data and run the analyses.',
        },
        {
            title: 'Your results',
            targets: () => all(currentMode() === 'scientific' ? '.plot-card' : '.simple-card'),
            fallbackCenter: true,
            text: (centered) => {
                const where = centered ? 'After you press Analyze, results appear below the map. ' : 'Results appear here, below the map. ';
                return where + (currentMode() === 'scientific'
                    ? 'Add time frames and pick analyses: trends (OLS, Sen\'s slope, Mann-Kendall), change points, comparisons and correlations.'
                    : 'Key findings come first, then tiles for trend, records, seasons, decades, extremes and how the variables relate. Click a tile to flip it open.');
            },
        },
        {
            title: 'Help is always here',
            targets: () => all('#th-help-btn'),
            text: () => 'Open this button for an overview of all features or to replay this tour.',
        },
    ];

    const tour = {
        active: false,
        index: -1,
        token: 0,
        targets: [],
        centered: false,
        returnFocus: null,
        raf: 0,
        ro: null,
        nodes: null,
    };

    function buildTourNodes() {
        if (tour.nodes) return tour.nodes;
        const blocker = el('div', { class: 'th-tour-blocker', 'aria-hidden': 'true' });
        const spot = el('div', { class: 'th-tour-spot', 'aria-hidden': 'true' });
        const card = el('div', {
            class: 'th-tour-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'th-tour-title',
            'aria-describedby': 'th-tour-text',
            tabindex: '-1',
        });
        card.innerHTML = `
            <div aria-live="polite">
                <h2 id="th-tour-title"></h2>
                <p id="th-tour-text"></p>
            </div>
            <div class="th-tour-foot">
                <span class="th-tour-count"></span>
                <button type="button" class="th-btn th-btn-link th-tour-skip">Skip tour</button>
                <button type="button" class="th-btn th-tour-back">Back</button>
                <button type="button" class="th-btn th-btn-primary th-tour-next">Next</button>
            </div>`;
        card.querySelector('.th-tour-skip').addEventListener('click', () => endTour(true));
        card.querySelector('.th-tour-back').addEventListener('click', () => go(tour.index - 1, -1));
        card.querySelector('.th-tour-next').addEventListener('click', () => go(tour.index + 1, 1));
        tour.nodes = { blocker, spot, card };
        return tour.nodes;
    }

    function visible(node) {
        if (!node || !node.isConnected) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (node.offsetParent === null && style.position !== 'fixed') return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function waitForSidebar() {
        return new Promise((resolve) => {
            const aside = $('.sidebar');
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                if (aside) aside.removeEventListener('transitionend', onEnd);
                resolve();
            };
            const onEnd = (e) => { if (e.target === aside) finish(); };
            if (aside) aside.addEventListener('transitionend', onEnd);
            window.setTimeout(finish, reducedMotion() ? 50 : 350);
        });
    }

    function startTour() {
        if (dialog && dialog.open) dialog.close();
        const { blocker, spot, card } = buildTourNodes();
        if (!tour.active) {
            const active = document.activeElement;
            tour.returnFocus = active && active !== document.body && !(dialog && dialog.contains(active))
                ? active : helpBtn;
            document.body.append(blocker, spot, card);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', schedulePosition);
            window.addEventListener('scroll', schedulePosition, true);
            window.addEventListener('trend:sidebar', onSidebar);
            window.addEventListener('trend:mode', onMode);
            if (window.ResizeObserver) tour.ro = new ResizeObserver(schedulePosition);
        }
        tour.active = true;
        go(0, 1);
    }

    function endTour(markDone) {
        if (!tour.active) return;
        tour.active = false;
        tour.token += 1;
        if (markDone) markTourDone();
        const { blocker, spot, card } = tour.nodes;
        blocker.remove();
        spot.remove();
        card.remove();
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', schedulePosition);
        window.removeEventListener('scroll', schedulePosition, true);
        window.removeEventListener('trend:sidebar', onSidebar);
        window.removeEventListener('trend:mode', onMode);
        if (tour.ro) { tour.ro.disconnect(); tour.ro = null; }
        window.cancelAnimationFrame(tour.raf);
        tour.index = -1;
        tour.targets = [];
        const back = tour.returnFocus && tour.returnFocus.isConnected ? tour.returnFocus : helpBtn;
        tour.returnFocus = null;
        if (back && typeof back.focus === 'function') back.focus();
    }

    // Show step `i`; when it cannot be shown, keep moving in direction `dir`.
    async function go(i, dir) {
        if (!tour.active) return;
        const token = ++tour.token;
        while (i >= 0 && i < STEPS.length) {
            const step = STEPS[i];
            let targets = step.targets ? step.targets() : [];
            if (targets.some((t) => t.closest('.sidebar'))) {
                const sb = window.TrendSidebar;
                if (sb && typeof sb.isOpen === 'function' && !sb.isOpen()) {
                    sb.open();
                    await waitForSidebar();
                    if (token !== tour.token) return;
                    targets = step.targets();
                }
            }
            targets = targets.filter(visible);
            const centered = !step.targets || (!targets.length && step.fallbackCenter);
            if (targets.length || centered) {
                show(i, targets, centered);
                return;
            }
            i += dir;
        }
        if (i >= STEPS.length) endTour(true);
        else if (i < 0 && tour.index < 0) endTour(true); // nothing showable at all
        // i < 0 while a step is shown: stay where we are.
    }

    function show(i, targets, centered) {
        const step = STEPS[i];
        const { blocker, spot, card } = tour.nodes;
        tour.index = i;
        tour.targets = targets;
        tour.centered = centered;

        if (tour.ro) {
            tour.ro.disconnect();
            targets.forEach((t) => tour.ro.observe(t));
        }

        card.querySelector('#th-tour-title').textContent = step.title;
        card.querySelector('#th-tour-text').innerHTML = step.text(centered);
        card.querySelector('.th-tour-count').textContent = `Step ${i + 1} of ${STEPS.length}`;
        const back = card.querySelector('.th-tour-back');
        const next = card.querySelector('.th-tour-next');
        const skip = card.querySelector('.th-tour-skip');
        const last = !STEPS.slice(i + 1).length;
        back.hidden = i === 0;
        skip.hidden = last;
        next.textContent = last ? 'Done' : 'Next';

        blocker.classList.toggle('th-dim', centered);
        spot.hidden = centered;
        card.classList.toggle('th-centered', centered);

        if (!centered) {
            const rect = unionRect(targets);
            const vh = window.innerHeight;
            const outside = rect.top < 0 || rect.bottom > vh || rect.left < 0 || rect.right > window.innerWidth;
            if (outside) {
                const tall = rect.height > vh * 0.6;
                targets[0].scrollIntoView({
                    behavior: reducedMotion() ? 'auto' : 'smooth',
                    block: tall || isNarrow() ? 'start' : 'center',
                    inline: 'nearest',
                });
            }
        }
        position();
        next.focus({ preventScroll: true });
    }

    function unionRect(targets) {
        let top = Infinity; let left = Infinity; let right = -Infinity; let bottom = -Infinity;
        targets.forEach((t) => {
            const r = t.getBoundingClientRect();
            top = Math.min(top, r.top);
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
            bottom = Math.max(bottom, r.bottom);
        });
        return { top, left, right, bottom, width: right - left, height: bottom - top };
    }

    function schedulePosition() {
        if (!tour.active) return;
        window.cancelAnimationFrame(tour.raf);
        tour.raf = window.requestAnimationFrame(position);
    }

    function onSidebar() {
        schedulePosition();
        window.setTimeout(schedulePosition, reducedMotion() ? 50 : 350);
    }

    function onMode() {
        // Texts and targets depend on the mode: show the current step again.
        if (tour.active && tour.index >= 0) go(tour.index, 1);
    }

    function position() {
        if (!tour.active || tour.index < 0) return;
        const { spot, card } = tour.nodes;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        const docked = isNarrow();
        card.classList.toggle('th-docked', docked && !tour.centered);

        let r = null;
        if (!tour.centered) {
            if (!tour.targets.every((t) => t.isConnected)) { go(tour.index, 1); return; }
            const u = unionRect(tour.targets);
            // Spotlight: the element plus padding, clipped to the viewport.
            const top = Math.max(4, u.top - PAD);
            const left = Math.max(4, u.left - PAD);
            const right = Math.min(vw - 4, u.right + PAD);
            const bottom = Math.min(vh - 4, u.bottom + PAD);
            r = { top, left, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
            spot.style.top = `${r.top}px`;
            spot.style.left = `${r.left}px`;
            spot.style.width = `${r.width}px`;
            spot.style.height = `${r.height}px`;
        }

        if (docked && !tour.centered) {
            card.style.top = '';
            card.style.left = '';
            return;
        }

        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        const clampX = (x) => Math.min(Math.max(MARGIN, x), Math.max(MARGIN, vw - cw - MARGIN));
        const clampY = (y) => Math.min(Math.max(MARGIN, y), Math.max(MARGIN, vh - ch - MARGIN));
        let x;
        let y;

        if (tour.centered || !r) {
            x = (vw - cw) / 2;
            y = (vh - ch) / 2;
        } else {
            const fits = {
                right: r.right + GAP + cw <= vw - MARGIN,
                left: r.left - GAP - cw >= MARGIN,
                bottom: r.bottom + GAP + ch <= vh - MARGIN,
                top: r.top - GAP - ch >= MARGIN,
            };
            const wide = r.width > vw * 0.45;
            const order = wide ? ['bottom', 'top', 'right', 'left'] : ['right', 'left', 'bottom', 'top'];
            const side = order.find((s) => fits[s]);
            if (side === 'right' || side === 'left') {
                x = side === 'right' ? r.right + GAP : r.left - GAP - cw;
                y = r.top + r.height / 2 - ch / 2;
            } else if (side === 'bottom' || side === 'top') {
                x = r.left + r.width / 2 - cw / 2;
                y = side === 'bottom' ? r.bottom + GAP : r.top - GAP - ch;
            } else {
                // The element fills the screen: place the card over its lower-right corner.
                x = r.right - cw - MARGIN;
                y = r.bottom - ch - MARGIN;
            }
        }
        card.style.left = `${Math.round(clampX(x))}px`;
        card.style.top = `${Math.round(clampY(y))}px`;
    }

    function onKey(e) {
        if (!tour.active) return;
        const { card } = tour.nodes;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            endTour(true);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowRight') go(tour.index + 1, 1);
            else if (tour.index > 0) go(tour.index - 1, -1);
        } else if (e.key === 'Tab') {
            // Keep focus inside the card.
            const items = Array.from(card.querySelectorAll('button')).filter((b) => !b.hidden);
            if (!items.length) return;
            const first = items[0];
            const lastItem = items[items.length - 1];
            const inside = card.contains(document.activeElement);
            if (e.shiftKey && (document.activeElement === first || !inside)) {
                e.preventDefault();
                lastItem.focus();
            } else if (!e.shiftKey && (document.activeElement === lastItem || !inside)) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    // ------------------------------------------------------------------ boot

    function maybeAutoStart() {
        // Storage blocked (null): the tour could not be remembered, so it would
        // come back on every visit; it stays available from the help dialog.
        if (tourDone() !== false) return;
        window.setTimeout(() => {
            if (tour.active || (dialog && dialog.open)) return;
            startTour();
        }, 700);
    }

    function init() {
        buildHelp();
        if (document.readyState === 'complete') maybeAutoStart();
        else window.addEventListener('load', maybeAutoStart, { once: true });
    }

    window.TrendHelp = { openHelp, startTour };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
