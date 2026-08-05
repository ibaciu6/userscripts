// ==UserScript==
// @name         Disney+ Subtitle Styler: Large & Yellow
// @namespace    https://greasyfork.org/users/1631012-ionut-baciu
// @version      1.9.0
// @description  Makes Disney+ subtitles always render large and yellow. Shadow-DOM aware, with optional Netflix Sans font support and fully customizable size, color, and font.
// @author       ionut-baciu
// @match        *://*.disneyplus.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    // ============ SETTINGS ============
    // Edit values below once; every reference in the script uses them.
    //
    // Named size presets. To add one, add another line here.
    const SIZES = {
        small: '1.5rem',
        medium: '2rem',
        large: '2.5rem',
        xlarge: '3rem',
    };

    // Netflix renders its subtitle cues at 17px (too small on large screens).
    // Use one of the SIZES presets above for bigger text: SIZES.small / SIZES.medium / SIZES.large / SIZES.xlarge
    const FONT_SIZE = SIZES.large;

    // Custom font, e.g. to mimic Netflix subtitles. Currently active.
    // To disable, comment out the line below.
    const FONT_FAMILY = "'Netflix Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";

    // Text color. #FFD200 is Disney yellow; any CSS color works.
    const TEXT_COLOR = '#FFD200';

    // Netflix uses font-weight: bolder (= 700 over a normal base).
    // 0 = normal, 400 = regular, 700 = bold, 800 = extra bold
    const FONT_WEIGHT = '700';

    // Netflix uses line-height: normal.
    // Lower = tighter, higher = more spacing.
    const LINE_HEIGHT = 'normal';

    // Netflix uses a black 7px blur shadow behind the text.
    // Layered with a directional offset shadow for a visible outline on bright scenes.
    // Remove the value to disable.
    const TEXT_SHADOW = '#000 0px 0px 7px, 0.05em 0.08em 0.06em rgba(0, 0, 0, 0.95), 0.02em 0.04em 0 rgba(0, 0, 0, 0.8)';

    // Netflix has no background box, only the text shadow.
    // Background box behind each subtitle line. 0 = no box, 0.55 = 55% black.
    const LINE_BACKGROUND = 'transparent';
    // ============ END SETTINGS ============

    const STYLE_ID = 'dplus-subtitle-force';
    const CUE_SELECTOR = '.hive-subtitle-renderer-cue, .dss-subtitle-renderer-cue';
    const CSS = `
    .dss-subtitle-renderer-cue,
    .hive-subtitle-renderer-cue {
        color: ${TEXT_COLOR} !important;
        font-size: ${FONT_SIZE} !important;
        font-weight: ${FONT_WEIGHT} !important;
        -webkit-text-fill-color: ${TEXT_COLOR} !important;
        text-shadow: ${TEXT_SHADOW} !important;
        line-height: ${LINE_HEIGHT} !important;
        ${typeof FONT_FAMILY !== 'undefined' ? `font-family: ${FONT_FAMILY} !important;` : ''}
    }
    .dss-subtitle-renderer-cue > div,
    .hive-subtitle-renderer-cue > div,
    .dss-subtitle-renderer-cue > div > span,
    .hive-subtitle-renderer-cue > div > span,
    .dss-subtitle-renderer-line,
    .hive-subtitle-renderer-line {
        color: ${TEXT_COLOR} !important;
        -webkit-text-fill-color: ${TEXT_COLOR} !important;
        text-shadow: ${TEXT_SHADOW} !important;
    }
    .dss-subtitle-renderer-line,
    .hive-subtitle-renderer-line {
        background-color: ${LINE_BACKGROUND} !important;
    }
    .dss-subtitle-renderer-cue-window,
    .hive-subtitle-renderer-cue-window {
        background-color: transparent !important;
    }
    `;

    const FONT_CSS = `
    @font-face {
        font-family: "Netflix Sans Variable";
        src: url("https://occ.a.nflxso.net/genc/hawkins/5.25.1/font/netflix-sans-core-variable-full.woff2") format("woff2"),
             local("Helvetica Neue"),
             local("Segoe UI"),
             local("Roboto"),
             local("Ubuntu");
        font-weight: 100 900;
        font-display: swap;
    }
    `;
    const observers = [];

    function makeFontStyle() {
        const style = document.createElement('style');
        style.id = STYLE_ID + '-font';
        style.textContent = FONT_CSS;
        return style;
    }

    function injectDocumentFont() {
        const head = document.head || document.documentElement;
        if (!head.querySelector('#' + STYLE_ID + '-font')) {
            head.appendChild(makeFontStyle());
        }
    }

    function makeStyle() {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        return style;
    }

    function styleCue(cue) {
        cue.style.color = TEXT_COLOR;
        cue.style.fontSize = FONT_SIZE;
        cue.style.fontWeight = FONT_WEIGHT;
        cue.style.webkitTextFillColor = TEXT_COLOR;
        cue.style.textShadow = TEXT_SHADOW;
        if (typeof FONT_FAMILY !== 'undefined') {
            cue.style.fontFamily = FONT_FAMILY;
        }
        cue.querySelectorAll('div, span').forEach(el => {
            el.style.color = TEXT_COLOR;
            el.style.webkitTextFillColor = TEXT_COLOR;
        });
    }

    function handleRoot(root) {
        if (root.nodeType !== 1 && root.nodeType !== 11) return;
        if (root.querySelector) {
            if (!root.querySelector('#' + STYLE_ID)) {
                root.appendChild(makeStyle());
            }
            if (root.querySelectorAll) {
                root.querySelectorAll(CUE_SELECTOR).forEach(styleCue);
            }
        }
    }

    function observeShadow(host) {
        if (!host.shadowRoot) return;
        handleRoot(host.shadowRoot);
        if (!host.shadowRoot.__dplusObserved) {
            host.shadowRoot.__dplusObserved = true;
            const observer = new MutationObserver(() => handleRoot(host.shadowRoot));
            observer.observe(host.shadowRoot, { childList: true, subtree: true });
            observers.push(observer);
        }
    }

    function walk(el) {
        if (el.shadowRoot) {
            observeShadow(el);
            for (const child of el.shadowRoot.children) walk(child);
        }
        for (const child of el.children) walk(child);
    }

    const lightObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) walk(node);
            }
        }
    });

    function init() {
        const root = document.documentElement;
        if (!root) return;
        if (typeof FONT_FAMILY !== 'undefined') {
            injectDocumentFont();
        }
        walk(root);
        if (!document.__dplusLightObserved) {
            document.__dplusLightObserved = true;
            lightObserver.observe(root, { childList: true, subtree: true });
            observers.push(lightObserver);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
