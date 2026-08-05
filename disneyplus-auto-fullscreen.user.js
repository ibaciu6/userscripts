// ==UserScript==
// @name         Disney+ Auto Fullscreen (Enhanced)
// @namespace    https://greasyfork.org/users/1631012-ionut-baciu
// @version      1.5.0
// @description  Automatically enters fullscreen when playback starts on Disney+ and stays on through binge-watching. Survives episode transitions, hides the mouse cursor in fullscreen, and offers a click-to-enter-fullscreen overlay when autoplay is blocked.
// @author       ionut-baciu
// @homepageURL  https://github.com/ibaciu6/userscripts
// @supportURL   https://github.com/ibaciu6/userscripts/issues
// @match        *://*.disneyplus.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/*
 * Enhanced rewrite of "Disney+ Auto Fullscreen" by Raizuto
 * https://greasyfork.org/en/scripts/553167 (MIT License).
 * Adds shadow-DOM awareness, episode-safe fullscreen on <html>,
 * cursor auto-hide, and a fallback overlay for gesture-less autoplay.
 */

(function () {
    'use strict';

    // ============ SETTINGS ============
    const CONFIG = {
        // Enter fullscreen automatically when playback starts after a user action.
        autoFullscreen: true,

        // When autoplay (e.g. next episode) starts without a click, browsers block
        // requestFullscreen, so show a clickable overlay instead.
        showOverlay: true,

        // Text shown on the overlay.
        overlayText: 'Click to enter fullscreen',

        // Actions inside this window (ms) count as user-initiated playback.
        userGestureWindowMs: 4000,

        // Hide the mouse cursor after this many ms of inactivity while fullscreen
        // (0 disables auto-hiding). Needed because <html> fullscreen doesn't
        // auto-hide the cursor like a native fullscreen <video> does.
        hideCursorIdleMs: 1500,
    };
    // ============ END SETTINGS ============

    const STYLE_ID = 'dp-auto-fs-style';
    const OVERLAY_CLASS = 'dp-auto-fs-overlay';
    const OVERLAY_TEXT = CONFIG.overlayText;
    const IDLE_MS = CONFIG.hideCursorIdleMs;

    let lastUserGesture = 0;
    let userExitedFullscreen = false;
    let overlay = null;
    let idleTimer = null;

    const now = () => Date.now();

    const fsElement = () =>
        document.fullscreenElement || document.webkitFullscreenElement ||
        document.mozFullScreenElement || document.msFullscreenElement;

    const isFullscreen = () => !!fsElement();

    function requestFullscreen(target) {
        const req = target && (target.requestFullscreen ||
            target.webkitRequestFullscreen || target.mozRequestFullScreen || target.msRequestFullscreen);
        if (!req) return;
        const p = req.call(target);
        if (p && p.catch) p.catch(() => {});
    }

    // Fullscreen on <html> so fullscreen persists when the player node is rebuilt
    // on episode changes (the old <video> element would otherwise be removed).
    function goFullscreen() {
        if (isFullscreen()) return;
        requestFullscreen(document.documentElement);
    }

    // ---- cursor auto-hide while fullscreen ----
    // Disney's player (video + controls) lives inside a shadow DOM, so plain CSS
    // rules can't reach it. Force cursor:none inline with !important on every
    // element (including inside shadow roots). Cursor is hidden IMMEDIATELY on
    // entering fullscreen and only restored briefly while the user is actively
    // moving the mouse / using the keyboard.
    const cursorTargets = [];
    const knownHovered = [];

    function allDescendants(root) {
        const out = [];
        (function walk(node) {
            if (!node || node.nodeType !== 1) return;
            out.push(node);
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) walk(child);
        })(root || document.documentElement);
        return out;
    }

    // composedPath() includes elements inside CLOSED shadow roots, which a DOM
    // walk can never reach. Remember whatever the mouse has touched so we can
    // force cursor:none on it during the hidden state.
    function trackHovered(e) {
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const el of path) {
            if (el && el.nodeType === 1 && !knownHovered.includes(el)) knownHovered.push(el);
        }
        if (knownHovered.length > 500) knownHovered.splice(0, knownHovered.length - 500);
    }

    function applyCursorHidden(on) {
        document.documentElement.classList.toggle('dpfs-idle', on);
        for (const el of cursorTargets.splice(0)) el.style.removeProperty('cursor');
        for (const el of knownHovered) el.style.removeProperty('cursor');
        if (!on) return;
        cursorTargets.push(...allDescendants());
        const targets = on ? cursorTargets.concat(knownHovered) : cursorTargets;
        for (const el of targets) el.style.setProperty('cursor', 'none', 'important');
    }

    function onCursorActivity() {
        if (!isFullscreen() || IDLE_MS <= 0) return;
        applyCursorHidden(false);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => applyCursorHidden(true), IDLE_MS);
    }

    document.addEventListener('mousemove', trackHovered, true);
    document.addEventListener('mousedown', trackHovered, true);
    document.addEventListener('mousemove', onCursorActivity, true);
    document.addEventListener('mousedown', onCursorActivity, true);
    document.addEventListener('keydown', onCursorActivity, true);
    document.addEventListener('wheel', onCursorActivity, true);

    // ---- CSS so the video fills the screen when <html> is fullscreen ----
    function ensureFsCss() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = `
            :fullscreen #hivePlayer, :-webkit-full-screen #hivePlayer, :-moz-full-screen #hivePlayer,
            :fullscreen video, :-webkit-full-screen video, :-moz-full-screen video {
                width: 100% !important;
                height: 100% !important;
                position: fixed !important;
                inset: 0 !important;
                object-fit: contain !important;
                background: #000 !important;
                z-index: 2147483647 !important;
            }
            :fullscreen.dpfs-idle, :fullscreen.dpfs-idle *,
            :-webkit-full-screen.dpfs-idle, :-webkit-full-screen.dpfs-idle *,
            :-moz-full-screen.dpfs-idle, :-moz-full-screen.dpfs-idle * {
                cursor: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // ---- video discovery, including Disney's shadow-DOM player ----
    function findVideos() {
        const out = [];
        (function walk(node) {
            if (!node || node.nodeType !== 1) return;
            if (node.tagName.toLowerCase() === 'video') out.push(node);
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of node.children) walk(child);
        })(document.documentElement);
        return out;
    }

    // ---- click-to-fullscreen overlay (fallback for gesture-less autoplay) ----
    function showOverlay() {
        if (!CONFIG.showOverlay || overlay || isFullscreen()) return;
        overlay = document.createElement('div');
        overlay.className = OVERLAY_CLASS;
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483647',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.35)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '20px',
            fontFamily: "Netflix Sans, 'Helvetica Neue', Arial, sans-serif",
            textShadow: '#000 0 2px 6px',
        });
        overlay.textContent = OVERLAY_TEXT;
        overlay.addEventListener('click', () => {
            lastUserGesture = now();
            goFullscreen();
            hideOverlay();
        }, { once: true });
        document.documentElement.appendChild(overlay);
    }

    function hideOverlay() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    }

    // ---- playback listeners ----
    function attachToVideo(v) {
        if (!v || v.__dpFsAttached) return;
        v.__dpFsAttached = true;

        v.addEventListener('play', () => {
            if (v.paused || v.ended || !CONFIG.autoFullscreen) return;
            const userInitiated = now() - lastUserGesture < CONFIG.userGestureWindowMs;
            if (isFullscreen()) {
                hideOverlay();
                return;
            }
            if (userInitiated) {
                userExitedFullscreen = false;
                goFullscreen();
                hideOverlay();
            } else if (!userExitedFullscreen) {
                // Autoplay (next episode) without a user gesture: offer the overlay.
                showOverlay();
            }
        }, true);

        v.addEventListener('pause', hideOverlay);
    }

    // Track whether the user deliberately left fullscreen, so we don't force it back.
    function onFsChange() {
        if (isFullscreen()) {
            userExitedFullscreen = false;
            ensureFsCss();
            hideOverlay();
            applyCursorHidden(true);
            clearTimeout(idleTimer);
        } else {
            userExitedFullscreen = true;
            hideOverlay();
            applyCursorHidden(false);
            knownHovered.length = 0;
        }
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('mozfullscreenchange', onFsChange);
    document.addEventListener('MSFullscreenChange', onFsChange);

    // Record user gestures so play() after a click/keypress is treated as intentional.
    document.addEventListener('click', () => { lastUserGesture = now(); }, true);
    document.addEventListener('keydown', () => { lastUserGesture = now(); }, true);

    // Watch for player creation/recreation (Disney+ is a SPA).
    const observer = new MutationObserver(() => {
        for (const v of findVideos()) attachToVideo(v);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // On SPA navigation to a new title, reset the "user exited" flag.
    (function hookHistory() {
        const push = history.pushState;
        const replace = history.replaceState;
        history.pushState = function () {
            const r = push.apply(this, arguments);
            window.dispatchEvent(new Event('dpfs:location'));
            return r;
        };
        history.replaceState = function () {
            const r = replace.apply(this, arguments);
            window.dispatchEvent(new Event('dpfs:location'));
            return r;
        };
        window.addEventListener('popstate', () => window.dispatchEvent(new Event('dpfs:location')));
    })();
    window.addEventListener('dpfs:location', () => {
        userExitedFullscreen = false;
        hideOverlay();
    });

    ensureFsCss();
    for (const v of findVideos()) attachToVideo(v);
})();
