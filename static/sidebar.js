/*
 * Foldable analysis sidebar.
 *
 * Loaded in <head> (before the page paints) so the remembered state is on <html>
 * from the start: html[data-sidebar] is "open" | "closed". static/sidebar.css
 * turns the closed sidebar into a slim rail (desktop) or a compact bar (<= 860px).
 *
 * Public API:
 *   window.TrendSidebar.open() / close() / toggle() / isOpen()
 *   'trend:sidebar' CustomEvent on window, detail: { open }
 * After the width transition a 'resize' event is dispatched on window so the
 * map and the charts re-layout.
 *
 * Open is the default. The choice is remembered per browser.
 */
(function () {
    'use strict';

    const KEY = 'trenddetective-sidebar';
    const root = document.documentElement;
    const LABEL_OPEN = 'Hide analysis panel';
    const LABEL_CLOSED = 'Show analysis panel';

    function stored() {
        try {
            const v = window.localStorage.getItem(KEY);
            return v === 'open' || v === 'closed' ? v : null;
        } catch (err) {
            return null;
        }
    }

    let open = stored() !== 'closed';
    root.dataset.sidebar = open ? 'open' : 'closed';

    let aside = null;
    let button = null;
    let resizeTimer = 0;

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // Everything in the sidebar except the toggle is unreachable while closed.
    function syncDom() {
        if (!aside || !button) return;
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', open ? LABEL_OPEN : LABEL_CLOSED);
        button.title = open ? LABEL_OPEN : LABEL_CLOSED;
        Array.prototype.forEach.call(aside.children, (el) => {
            if (el === button) return;
            if (open) el.removeAttribute('inert');
            else el.setAttribute('inert', '');
        });
    }

    function announceResize() {
        window.clearTimeout(resizeTimer);
        resizeTimer = 0;
        window.dispatchEvent(new Event('resize'));
    }

    function set(next) {
        next = !!next;
        if (next === open) return;
        open = next;
        root.dataset.sidebar = open ? 'open' : 'closed';
        try { window.localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch (err) { /* not remembered */ }
        syncDom();
        window.dispatchEvent(new CustomEvent('trend:sidebar', { detail: { open } }));
        if (!aside) return;
        // transitionend (width) normally fires the resize; the timer covers reduced
        // motion, the mobile layout (no width transition) and interrupted transitions.
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(announceResize, reducedMotion() ? 0 : 320);
    }

    function init() {
        aside = document.querySelector('aside.sidebar');
        if (!aside) return;
        if (!aside.id) aside.id = 'analysis-sidebar';

        button = document.getElementById('sidebar-toggle');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.id = 'sidebar-toggle';
            button.className = 'sidebar-toggle';
            button.innerHTML = '<span class="sidebar-toggle-icon" aria-hidden="true">&laquo;</span>';
            aside.insertBefore(button, aside.firstChild);
        }
        button.setAttribute('aria-controls', aside.id);
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
        });

        // The collapsed rail / bar itself opens the sidebar.
        aside.addEventListener('click', (e) => {
            if (!open && e.target !== button) set(true);
        });

        aside.addEventListener('transitionend', (e) => {
            if (e.target === aside && e.propertyName === 'width' && resizeTimer) announceResize();
        });

        syncDom();
        // Animate only after the first paint, never the restored state.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            root.classList.add('sidebar-animate');
        }));
    }

    function toggle() { set(!open); }

    window.TrendSidebar = {
        open: () => set(true),
        close: () => set(false),
        toggle,
        isOpen: () => open,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
