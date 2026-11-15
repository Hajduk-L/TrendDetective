/*
 * Simple / Scientific display mode.
 *
 * Loaded in <head> (before the page paints) so the right mode is on <html> from
 * the start. The mode lives in html[data-mode] ("simple" | "scientific");
 * static/mode.css hides the expert parts in simple mode, and scripts that word
 * things differently ask window.TrendMode.isSimple() and listen for the
 * 'trend:mode' event on window (detail: { mode }).
 *
 * Simple is the default. The choice is remembered per browser.
 */
(function () {
    'use strict';

    const KEY = 'trenddetective-mode';
    const MODES = ['simple', 'scientific'];
    const root = document.documentElement;

    function stored() {
        try {
            const v = window.localStorage.getItem(KEY);
            return MODES.includes(v) ? v : null;
        } catch (err) {
            return null;
        }
    }

    let mode = stored() || 'simple';
    root.dataset.mode = mode;

    function syncButtons() {
        document.querySelectorAll('[data-mode-set]').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.modeSet === mode));
        });
    }

    function set(next) {
        if (!MODES.includes(next) || next === mode) return;
        mode = next;
        root.dataset.mode = mode;
        try { window.localStorage.setItem(KEY, mode); } catch (err) { /* private mode: not remembered */ }
        syncButtons();
        window.dispatchEvent(new CustomEvent('trend:mode', { detail: { mode } }));
    }

    window.TrendMode = {
        get: () => mode,
        set,
        isSimple: () => mode === 'simple',
    };

    document.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('[data-mode-set]');
        if (b) set(b.dataset.modeSet);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncButtons);
    else syncButtons();
}());
