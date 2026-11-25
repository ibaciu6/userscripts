// ==UserScript==
// @name         Binge Watching (Netflix & Disney+)
// @namespace    https://greasyfork.org/users/1631012-ionut-baciu
// @version      1.2.0
// @description  Automatically skips intros, recaps, and credits and clicks next episodes so you can binge on Netflix and Disney+. No dependencies, shadow-DOM aware.
// @author       ionut-baciu
// @homepageURL  https://github.com/ibaciu6/userscripts
// @supportURL   https://github.com/ibaciu6/userscripts/issues
// @match        *://*.netflix.com/*
// @match        *://*.disneyplus.com/*
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/*
 * Improved rewrite of "Netflix Marathon" v2.7 by ran
 * https://greasyfork.org/en/scripts/30029 (MIT License).
 * Changes: dropped the jQuery dependency, focused on Netflix + Disney+,
 * modern selectors with a text fallback, shadow-DOM aware scanning,
 * crash guards, and event-driven scanning instead of blind 300ms polling.
 */

(function () {
    'use strict';

    // ============ CLOSED SHADOW ROOT SUPPORT ============
    // Disney+'s player (web components) may attach CLOSED shadow roots. From
    // outside, `element.shadowRoot` is null for closed roots, so the DOM is
    // invisible to scripts. We patch attachShadow BEFORE any page code runs
    // (hence @run-at document-start) and cache the returned root ourselves.
    const SHADOW_CACHE = new WeakMap();
    {
        const nativeAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
            const root = nativeAttachShadow.call(this, init);
            SHADOW_CACHE.set(this, root);
            return root;
        };
    }
    function getShadow(host) {
        return (host && (host.shadowRoot || SHADOW_CACHE.get(host))) || null;
    }

    // ============ SETTINGS ============
    const CONFIG = {
        // Click "Skip Intro" / "Skip Recap" buttons.
        skipIntros: true,

        // Click skip-credits / next-episode buttons near the end of an episode.
        skipCredits: true,

        // Click "Up Next" / post-play overlays to start the next episode.
        autoNext: true,

        // Log actions to the browser console. Disabled — debugging is done.
        // Set to true only while investigating a problem.
        debug: false,

        // Fallback scan interval in ms (the MutationObserver does most of the work).
        fallbackScanMs: 3000,
    };
    // ============ END SETTINGS ============

    const HOST = location.hostname;
    const IS_NETFLIX = /(^|\.)netflix\.com$/i.test(HOST);
    const IS_DISNEY = /(^|\.)disneyplus\.com$/i.test(HOST);
    if (!IS_NETFLIX && !IS_DISNEY) return;

    const now = () => Date.now();
    const log = (...a) => { if (CONFIG.debug) console.log('[Binge Watching]', ...a); };

    // Per-element click cooldown, so the same node is never clicked in a burst,
    // but a reused node (Disney+ keeps its player alive across episodes) can be
    // clicked again in a later episode.
    const clickedAt = new Map();
    const CLICK_COOLDOWN_MS = 60000;

    // Per-action cooldown, keyed by a stable action name (not the element),
    // because the player re-creates DOM nodes on every render, which would
    // otherwise reset the per-element cooldown and cause click storms.
    const actionClickedAt = new Map();
    const ACTION_COOLDOWN_MS = { skip: 15000, next: 20000 };

    // v1.1.19/20: a next-click is only allowed at the TRUE end of the real
    // episode. Disney+ plays pre-roll ads and recaps as SHORT (15-60s)
    // segments in the same hivePlayer video, so any duration-based heuristic
    // must require an episode-length video (recap/ad are < 120s).
    const MIN_EPISODE_SECONDS = 120;

    function isVisible(el) {
        try {
            if (!el || el.getClientRects().length === 0) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = getComputedStyle(el);
            return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
        } catch (e) {
            return false;
        }
    }

    // Diagnostic-only: dump exactly why isVisible() did or didn't accept an
    // element — rect, getClientRects() count, and the specific computed-style
    // properties isVisible() checks, PLUS a few more (transform, position,
    // contain) that aren't checked but commonly cause a real on-screen
    // element to report a 0x0 rect (e.g. `display: contents` hosts, which
    // produce zero client rects because the box lives in their children, or
    // a Swiper carousel duplicate/off-screen slide clone). Also walks up a
    // few ancestors so a hidden PARENT (not the element itself) shows up too.
    // Throttled per element+label (10 s) so the 1 s scan loop doesn't spam
    // the console with 3-4 identical lines every tick (v1.1.20).
    const visThrottle = new Map();
    function visDebug(el, label) {
        if (!CONFIG.debug || !el) return;
        const key = label + '|' + (el.__bwKey || (el.__bwKey = (el.tagName + ':' + (el.getAttribute('data-testid') || '') + ':' + (el.className || '') + ':' + (el.id || '')).slice(0, 80)));
        const last = visThrottle.get(key);
        const nowMs = now();
        if (last && nowMs - last < 10000) return;
        visThrottle.set(key, nowMs);
        if (visThrottle.size > 400) {
            const cutoff = nowMs - 10000;
            for (const [k, t] of visThrottle) if (t < cutoff) visThrottle.delete(k);
        }
        try {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const rectCount = el.getClientRects().length;
            const parts = [
                label,
                el.tagName + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''),
                'rects=' + rectCount,
                'rect=' + JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }),
                'display=' + cs.display,
                'visibility=' + cs.visibility,
                'opacity=' + cs.opacity,
                'transform=' + (cs.transform === 'none' ? 'none' : cs.transform.slice(0, 40)),
                'position=' + cs.position,
                'isVisible()=' + isVisible(el),
            ];
            log('visDebug', parts.join(' '));
            // One level of ancestor context — catches a hidden/0-size
            // wrapper around an otherwise-fine element.
            const p = el.parentElement;
            if (p) {
                const pr = p.getBoundingClientRect();
                const pcs = getComputedStyle(p);
                log('visDebug parent', p.tagName + (p.className ? '.' + String(p.className).trim().replace(/\s+/g, '.') : ''),
                    'rect=' + JSON.stringify({ w: Math.round(pr.width), h: Math.round(pr.height) }),
                    'display=' + pcs.display, 'opacity=' + pcs.opacity);
            }
        } catch (e) {
            log('visDebug error', label, e);
        }
    }

    // ============ EXTENSIVE DEBUG CONTEXT ============

    // Pull asset/episode info out of the React fiber attached to a DOM node
    // (Netflix and the Disney+ app shell are React; the player web components
    // are Lit, but their surrounding containers carry React props).
    function reactProps(node) {
        try {
            for (const key in node) {
                if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
                    const info = {};
                    let f = node[key];
                    for (let i = 0; f && i < 30; i++) {
                        const p = f.memoizedProps;
                        if (p) {
                            for (const k of ['asset', 'contentId', 'episodeId', 'seriesId', 'videoId', 'titleId', 'programType', 'episodeNumber', 'seasonNumber', 'title', 'seriesTitle', 'videoType']) {
                                if (p[k] !== undefined && info[k] === undefined) {
                                    info[k] = typeof p[k] === 'object'
                                        ? JSON.stringify(p[k]).slice(0, 200)
                                        : p[k];
                                }
                            }
                        }
                        f = f.return;
                    }
                    return Object.keys(info).length ? info : null;
                }
            }
        } catch (e) { }
        return null;
    }

    // Disney+ renders 2+ <video> elements: the first is a small ad/always-first
    // one, the real player is the <video id="hivePlayerN" class="hive-video">.
    // querySelector('video') was returning the ad one, so pause/currentTime/
    // duration were always read as paused/t=0/d=0. Pick the real player:
    // prefer any video with a real duration, tie-break to the longest, then a
    // hive id, then the first video on the page.
    function mainVideo() {
        try {
            const all = [...document.querySelectorAll('video')];
            if (!all.length) return null;
            // v1.1.21: a background/detail-page loop video reports duration
            // = Infinity (and keeps playing forever, so currentTime climbs
            // while the real player is paused at the countdown). mainVideo()
            // must never pick it — its Infinity >= MIN_EPISODE_SECONDS made
            // the v1.1.20 episode-end gate fire during recap/loading, and its
            // paused state poisoned the userPaused guard. Only finite,
            // positive durations are real media.
            const finite = all.filter(v => v && Number.isFinite(v.duration) && v.duration > 0);
            if (finite.length) {
                finite.sort((a, b) => b.duration - a.duration);
                return finite[0];
            }
            if (all.length === 1) return all[0];
            const byId = all.filter(v => v.id && /hive/i.test(v.id));
            if (byId.length) return byId[0];
            return all[0];
        } catch (e) { return null; }
    }

    // Snapshot everything that identifies the currently loaded media, so a
    // click on "skip intro/recap" can be correlated with the exact episode it
    // fired on (and we can catch a click that wrongly advances the episode).
    function mediaInfo() {
        const info = {};
        try {
            info.href = location.href;
            info.path = location.pathname;
            info.docTitle = document.title;
            const allVideos = [...document.querySelectorAll('video')];
            info.videoCount = allVideos.length;
            const v = mainVideo();
            if (v) {
                info.video = {
                    id: v.id || '',
                    paused: v.paused,
                    t: Math.round(v.currentTime),
                    d: Math.round(v.duration || 0),
                    ended: !!v.ended,
                };
                const src = v.currentSrc ||
                    (v.querySelector && v.querySelector('source') && v.querySelector('source').src);
                if (src) info.vsrc = String(src).slice(0, 120);
            }
        } catch (e) { info.err = String(e); }
        // Walk up from known React container nodes to grab the current asset.
        try {
            const hosts = document.querySelectorAll('[data-gv2containerkey], [data-uia]');
            for (let i = 0; i < hosts.length && i < 30; i++) {
                for (let n = hosts[i]; n && n !== document.documentElement; n = n.parentElement) {
                    const props = reactProps(n);
                    if (props && (props.asset || props.contentId || props.episodeId || props.videoId)) {
                        info.react = props;
                        break;
                    }
                }
                if (info.react) break;
            }
        } catch (e) { }
        // Disney+ "Up Next" tray tile carries the next episode's title/number.
        try {
            const tile = document.querySelector('pivot-tray-tile') ||
                document.querySelector('.tile-container');
            if (tile) {
                const titleEl = tile.querySelector('.title');
                const epEl = tile.querySelector('.episode-title');
                if (titleEl || epEl) {
                    info.upNext = {
                        title: titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '',
                        episode: epEl ? epEl.textContent.replace(/\s+/g, ' ').trim() : '',
                    };
                }
            }
        } catch (e) { }
        return info;
    }

    // Short ancestor chain (tag+class) of a node, to see what container a
    // clicked element belongs to.
    function ancestorChain(el, depth) {
        try {
            const parts = [];
            let n = el;
            for (let i = 0; n && i < (depth || 3); i++) {
                parts.push(n.tagName +
                    (n.className && typeof n.className === 'string'
                        ? '.' + String(n.className).trim().split(/\s+/).join('.')
                        : ''));
                n = n.parentElement;
            }
            return parts.join(' < ');
        } catch (e) { return ''; }
    }
    // ============ END EXTENSIVE DEBUG CONTEXT ============

    // Web components (e.g. Disney+ <skip-button>) keep their interactive element
    // inside the shadow root. A click on the HOST does not reach it, so descend
    // into the shadow root and click the most appropriate element instead.
    // Interactive elements (button/a/[role="button"]) are preferred over
    // decorative spans/labels, and hidden candidates are ignored, so a tray
    // <pivot-tray-tile> resolves to its .tile-container (role="button") rather
    // than a 0x0 title span that merely sits deeper in the tree.
    function deepestClickable(el) {
        const sr = getShadow(el);
        if (sr) {
            const cands = sr.querySelectorAll(
                'button, a, [role="button"], .label, [class*="button"], span');
            let best = null, bestScore = -1;
            for (const c of cands) {
                if (!isVisible(c)) continue;
                const interactive = c.tagName === 'BUTTON' || c.tagName === 'A' ||
                    (c.getAttribute && c.getAttribute('role') === 'button');
                let d = 0, p = c;
                while (p && p !== sr) { d++; p = p.parentElement; }
                const score = (interactive ? 100 : 0) + d;
                if (score > bestScore) { best = c; bestScore = score; }
            }
            if (best) return deepestClickable(best);
        }
        return el;
    }

    function isDisabled(el) {
        try {
            if (el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true')) return true;
            const cls = typeof el.className === 'string' ? el.className : '';
            return /(^|\s)disabled(\s|$)/i.test(cls);
        } catch (e) { return false; }
    }

    // The Playful player's web components (Lit) respond to full pointer/mouse
    // sequences, not just .click(). Dispatch pointerdown/mousedown/pointerup/
    // mouseup/click — composed, bubbles, with the element's center coordinates —
    // then call .click() as well. Mirrors Disney+ Enchantments' approach, which
    // is the one script that works on the new player.
    function dispatchClick(el) {
        try {
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            const rect = el.getBoundingClientRect();
            const clientX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
            const clientY = rect.height > 0 ? rect.top + rect.height / 2 : 0;
            log('dispatchClick: firing pointer/mouse sequence at', clientX + ',' + clientY,
                'on', el.tagName, 'class=' + String(el.className || '').slice(0, 40),
                'shadowRoot=' + (getShadow(el) ? 'yes' : 'no'),
                'chain=' + ancestorChain(el, 3));
            const opts = {
                bubbles: true,
                cancelable: true,
                composed: true,
                view,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
                clientX,
                clientY,
            };
            if (typeof view.PointerEvent === 'function') {
                el.dispatchEvent(new view.PointerEvent('pointerdown', opts));
            }
            if (typeof view.MouseEvent === 'function') {
                el.dispatchEvent(new view.MouseEvent('mousedown', opts));
            }
            if (typeof view.PointerEvent === 'function') {
                el.dispatchEvent(new view.PointerEvent('pointerup', opts));
            }
            if (typeof view.MouseEvent === 'function') {
                el.dispatchEvent(new view.MouseEvent('mouseup', opts));
                el.dispatchEvent(new view.MouseEvent('click', opts));
            }
            if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        } catch (e) {
            log('dispatchClick error', e);
        }
    }

    // Disney+ Enchantments trick: dispatch a pointermove/mousemove on the video
    // (or main) to wake the player controls so buttons are visible/active before
    // we try to click them. Useful when the tray is present but controls are
    // decayed/hidden.
    function wakePlayerControls() {
        try {
            const target = mainVideo() || document.querySelector('main') || document.body;
            if (!target) return;
            const view = target.ownerDocument?.defaultView || window;
            const rect = target.getBoundingClientRect();
            const clientX = rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
            const clientY = rect.height > 0 ? rect.top + rect.height / 2 : window.innerHeight / 2;
            const opts = {
                bubbles: true, cancelable: true, composed: true, view,
                pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX, clientY
            };
            if (typeof view.PointerEvent === 'function') {
                target.dispatchEvent(new view.PointerEvent('pointermove', opts));
            }
            if (typeof view.MouseEvent === 'function') {
                target.dispatchEvent(new view.MouseEvent('mousemove', opts));
            }
        } catch (e) { }
    }

    // v1.1.15 tried simulating hover over the tray to reveal the CTA
    // (display:none by default). FIELD RESULT (2nd log): the hover dispatch
    // fired every scan (visible in the log's own stack trace) but did NOT
    // reveal anything — isVisible() was still false on every single check
    // (0/376). Worse, because the dispatch used composed:true and targeted
    // the tray backdrop, it bubbled straight into Disney+'s own *document*-
    // level player-controls handler (handleMouseMove -> updateVisibility ->
    // dwp's internal @EVENT/PLAYER/UI/CONTROLS/OVERLAY/VISIBLE command) —
    // logged as "No sink handled command", i.e. a no-op this time, but not a
    // signal worth continuing to send.
    //
    // v1.1.16 field log REFINED this: the CTA's whole ancestor chain reports
    // a genuine 0x0 box (getClientRects().length === 0), but the PIVOT-TRAY-
    // TILE does NOT — once the tray fully opens (overlay gets data-tray-open)
    // the tile's SWIPER-SLIDE gets sized and the tile measures a real box
    // (263x238 at x:66,y:147) with its shadow .tile-container[role="button"]
    // being the actual play-next control. The 0x0-forever part is the CTA,
    // which the page comments literally say "fades in when closed" — it only
    // becomes clickable AFTER the tray closes. So the tile (not the CTA) is
    // the right click target during the tray phase.
    //
    // The shadow-internal DIV.pivot-tray-overlay backdrop reliably measures a
    // real box (e.g. 958x800, display:flex, opacity:1) at the same moments.
    // trayBackdropVisible() below uses that as a backup "the tray is genuinely
    // up" signal — but nextAllowed() only trusts it when the overlay ALSO
    // carries [data-tray-open], which is absent during the pre-roll/ad phases
    // (confirmed in the v1.1.16 log, where the bare-backdrop fallback fired
    // premature next-clicks at t:0 d:0 and t:24/d:25).
    function trayBackdropVisible() {
        const panel = q('.pivot-tray-overlay')[0];
        return !!panel && isVisible(panel);
    }

    // If the matched element is a non-interactive inner button (aria-hidden /
    // tabindex=-1), the player listens on its interactive parent container.
    function interactiveOrParent(el) {
        if (el && (el.getAttribute('aria-hidden') === 'true' || el.tabIndex === -1)) {
            const parent = el.parentElement;
            if (parent && (parent.getAttribute('role') === 'button' || parent.tabIndex >= 0)) {
                log('clickEl: using interactive parent', parent.tagName, String(parent.className || '').slice(0, 40));
                return parent;
            }
        }
        return el;
    }

    // The control-bar's own "Play Next" control must NEVER be clicked (see
    // v1.1.11 notes): a single click on it storms ~2-10 native
    // PLAY_NEXT/CLICKED events and can queue a stray SECOND navigation
    // (confirmed again in the v1.1.11 field logs: ed40b884->dc050600 with no
    // scripted click in between). v1.1.11 removed it from scanSelectors'
    // Disney next-target list, but that guard was incomplete: scanByText()
    // does an unscoped text search and this control is wrapped in an
    // <info-tooltip> whose hidden a11y/tooltip label text is literally
    // "Next For You" / "PLAY NEXT" — the SAME strings used to find the
    // tray's real CTA — so text matching alone can't tell the two apart.
    // Every logged "next" click in both the v1.1.11 field sessions (3/3 in
    // the older log, 1/1 in the newer one) went through this wrong element,
    // via scanByText, because the tray's own CTA is still 0x0 at the exact
    // moment the control-bar button is visible/enabled. This walks a short
    // ancestor chain (parentElement only; doesn't need to cross shadow
    // boundaries since info-tooltip and the button-container are siblings in
    // the same shadow root) and blocks the control regardless of which scan
    // path — selector or text — found it.
    //
    // v1.1.20: the aria-label check (`/^PLAY NEXT$/i`) was REMOVED. The
    // new-player post-play screen's real <button aria-label="PLAY NEXT">
    // (role="main" section with post-play-metadata, confirmed on-field during
    // the 5 s countdown) also matches it, so the check was silently blocking
    // the one element that actually advances the episode. The distinguishing
    // mark of the CONTROL-BAR storm button is its INFO-TOOLTIP wrapper (its
    // tooltip label text is what carries "PLAY NEXT"), and that check stays.
    function isControlBarPlayNext(el) {
        try {
            let n = el;
            for (let i = 0; n && i < 6; i++) {
                if (n.tagName === 'INFO-TOOLTIP') return true;
                if (n.getAttribute) {
                    const part = n.getAttribute('part') || '';
                    const cls = typeof n.className === 'string' ? n.className : '';
                    if (/play-next/i.test(part)) return true;
                    if (/(^|\s)play-next(\s|$)/i.test(cls)) return true;
                }
                n = n.parentElement;
            }
        } catch (e) { /* fail open — don't block a real target on error */ }
        return false;
    }

    // v1.1.28: the real post-play "PLAY NEXT" button. The v1.1.27 field log
    // (...1785918557030) proved the exact-match selector
    // button[aria-label="PLAY NEXT"] never fired because the new-player button
    // carries the LIVE COUNTDOWN in its aria-label — the on-screen element was
    // dumped as <button aria-label="PLAY NEXT IN 3" ...> visible=true, a real
    // 218x48 light-DOM button (shadow=no, ctrlBar=false), while dpPostNext
    // stayed 0 and the native advance fired when the countdown hit 0. So match
    // the prefix ("PLAY NEXT", "PLAY NEXT IN 3", "PLAY NEXT IN 2", ...),
    // filter out the CONTROL-BAR Play Next (its aria-label is the exact same
    // "PLAY NEXT"), and return the first VISIBLE, non-control-bar instance.
    // The user-confirmed flow is: the button appears DURING CREDITS / at the
    // end (user: "click near the end of the episode, let it run for 1 minute
    // before the screen with play next shows") with the countdown ticking in
    // the label — that button is exactly what should be clicked, immediately,
    // not after the 5s countdown.
    function postPlayButton() {
        try {
            for (const el of q('button[aria-label^="PLAY NEXT" i]')) {
                if (isControlBarPlayNext(el)) continue;
                if (isVisible(el)) return el;
            }
        } catch (e) { /* fail closed on error */ }
        return null;
    }

    // True when the user has paused the real player mid-episode. Auto actions
    // are blocked while paused, so we never advance an episode the user is
    // reading. Re-evaluated every scan from live video state, so it can't go
    // stale (a buffering pause with real progress also blocks, which is safe:
    // skip/next buttons are only actionable at episode start/end anyway).
    let userPaused = false;
    function trackPlaybackState() {
        const v = mainVideo();
        if (!v) { userPaused = false; return; }
        if (v.ended || v.duration <= 0) { userPaused = false; return; }
        userPaused = v.paused && v.currentTime > 1;
    }

    // v1.1.22: the REAL episode-end signal. Field logs proved that the moment
    // the "Up Next" tray/countdown opens, Disney UNLOADS the episode <video>
    // (it's replaced by the ambient loop that reports duration=Infinity), so
    // a duration/time-remaining check can never fire at the countdown. But
    // the episode video fires the standard `ended` event right before being
    // unloaded, while its duration is still finite. Record that; nextAllowed()
    // treats a recent episode-end as the "real end" for the tray gate.
    const episodeEndedAt = { t: 0 };
    // v1.1.27: last time a real episode-length video was seen actively
    // playing. The hive player unloads the episode video at the countdown
    // WITHOUT reliably firing `ended`, so Gate 2's endedNow window never
    // opens (epEnded=0 in every field session where the episode played out —
    // v1.1.24/25/26 logs). Detecting "a real episode was playing a moment ago
    // and is now gone/unloaded" is a reliable end signal: that disappearance
    // is exactly what the countdown does.
    let lastEpPlayedAt = 0;
    function watchEpisodeEnded() {
        try {
            for (const v of document.querySelectorAll('video')) {
                if (v.__bwEndedWatched) continue;
                v.__bwEndedWatched = true;
                const onEnded = () => {
                    if (Number.isFinite(v.duration) && v.duration >= MIN_EPISODE_SECONDS) {
                        v.__bwEndedRecorded = true;
                        episodeEndedAt.t = now();
                        log('episode-ended', 't=' + Math.round(v.currentTime),
                            'd=' + Math.round(v.duration), 'id=' + (v.id || ''));
                    }
                };
                v.addEventListener('ended', onEnded);
                if (!v.__bwEndedRecorded && v.ended &&
                    Number.isFinite(v.duration) && v.duration >= MIN_EPISODE_SECONDS) {
                    v.__bwEndedRecorded = true;
                    episodeEndedAt.t = now();
                }
            }
            // v1.1.27: video-loss end detection (the `ended`-independent path).
            const mv = mainVideo();
            const nowMs = now();
            if (mv && Number.isFinite(mv.duration) && mv.duration >= MIN_EPISODE_SECONDS && mv.currentTime > 1) {
                lastEpPlayedAt = nowMs;
            } else if (lastEpPlayedAt && nowMs - lastEpPlayedAt < 5000) {
                // A real episode-length video was playing within the last 5s and
                // is no longer episode-length (gone / 0x0 / Infinity loop /
                // swapped for the recap/ad). Re-record guard: don't overwrite a
                // fresh end (e.g. a brief in-episode ad swap re-triggering).
                if (nowMs - episodeEndedAt.t > 10000) {
                    episodeEndedAt.t = nowMs;
                    log('episode-ended (video loss)', 'sinceEpPlay=' + (nowMs - lastEpPlayedAt) + 'ms');
                }
            }
        } catch (e) { }
    }
    const episodeEndedRecent = () => (now() - episodeEndedAt.t) < 60000;
    const episodeEndedWithin = (ms) => episodeEndedAt.t > 0 && (now() - episodeEndedAt.t) < ms;

    // v1.1.24: the post-play screen (button[aria-label="PLAY NEXT"]) being
    // VISIBLE is itself an episode-end signal — the user confirmed it shows
    // DURING CREDITS, as the episode nears its end. Track its last visible
    // moment so Gate 1 accepts it even if Disney unloads the episode video
    // right as the screen appears (durOk drops, and the `ended` event may
    // never fire if the video is swapped mid-credits).
    const postPlaySeenAt = { t: 0 };
    const postPlayRecent = () => (now() - postPlaySeenAt.t) < 60000;

    // v1.1.24: the ADVANCE LATCH. Once an advance happens — our PLAY NEXT
    // click OR a native MEDIA-CHANGE — every next-action is blocked until a
    // FRESH episode-length video (finite duration >= MIN_EPISODE_SECONDS)
    // actually starts playing. This is what separates the countdown from the
    // next episode's pre-roll-ad window: Gate 1 fires while the previous
    // episode is still on screen (credits), and the ONLY thing between that
    // click and the next episode's real content is the pre-roll ad block
    // (~17-23s after ended, finite but < 120s, tray sub-elements also
    // present) — a timing window alone cannot tell those apart once Disney
    // has advanced. The latch is the guard.
    let advanceBlocked = false;
    let advanceBlockedAt = 0;
    // Set once the advance's MEDIA-CHANGE is actually observed (scan sees the
    // new href). Before that the old episode is still transitioning, and
    // mainVideo() can still report the old (episode-length) credits video —
    // the latch must NOT clear on it.
    let advanceChangeObserved = false;
    // The video we clicked from, so a reused hive <video> element (Disney
    // keeps the player alive across episodes) can still be told apart from the
    // next episode: its src changes and/or currentTime rewinds well below the
    // click point.
    let lastNextSrc = '';
    let lastNextTime = 0;
    function armAdvanceLatch(reason) {
        if (advanceBlocked) return;
        advanceBlocked = true;
        advanceBlockedAt = now();
        // v1.1.25: a latch armed BY a media change already has its change
        // observed (the new episode URL is live) — only a click-armed latch
        // waits for the MEDIA-CHANGE to confirm the advance actually started.
        // The v1.1.24 field log (...1785917458884) showed the latch armed via
        // `media-change` staying forever-armed: observed stayed false, so the
        // 5-min stale fallback was the only way out (advLock climbed 0->12
        // while the next episode's recap played).
        advanceChangeObserved = (reason === 'media-change');
        log('advance-latch: armed', reason);
    }
    function updateAdvanceLatch() {
        if (!advanceBlocked) return;
        // Not cleared until the new episode's media change is observed: the
        // transition (and a second-click storm into it) is the whole point.
        if (!advanceChangeObserved) return;
        const v = mainVideo();
        let freshEpisode = false;
        if (v && Number.isFinite(v.duration) && v.duration >= MIN_EPISODE_SECONDS && v.currentTime > 0) {
            if (!lastNextSrc && !lastNextTime) {
                // v1.1.25: no click reference (native advance) — the
                // episode-length, playing video IS the fresh episode; the
                // recap/ad segments are <120s so they can never match durOk.
                freshEpisode = true;
            } else {
                // Our own click: a reused hive <video> keeps its element, so
                // require its src to change or its currentTime to rewind well
                // below the click point before treating it as the new episode.
                const src = v.currentSrc || '';
                freshEpisode = (lastNextSrc && src && src !== lastNextSrc) ||
                    (lastNextTime > 0 && v.currentTime < lastNextTime - 10);
            }
        }
        // 2-min stale fallback: if the advance never produced a new episode
        // video (no MEDIA-CHANGE href, weird continuation), don't brick
        // auto-next for the whole session. Ads/recaps are <60s, so 120s can
        // never clear the latch into a live ad window.
        // v1.1.29: the >=120s fresh-episode check never passes on SHORT
        // episodes (children's shows, ~40-90s), so the latch stayed up through
        // the next episode and blocked its end — Disney native-advanced
        // instead (v1.1.28 field log ...1785919199193: the 20a5d68a click
        // armed the latch, then short f85b5120 ended and its post-play button
        // was blocked — f85b5120->47b41610 has no CLICKED line and went
        // natively; 47b41610 was still latched at log end). But once the
        // advance's MEDIA-CHANGE is confirmed, a newly visible post-play PLAY
        // NEXT button IS a real new episode end (the old post-play screen is
        // torn down when the new URL goes live, so this can't be the button we
        // already clicked), and both gates still require that button to
        // actually click — so clearing here is safe and un-bricks short
        // episodes.
        if (!freshEpisode && postPlayButton()) {
            freshEpisode = true;
            log('advance-latch: cleared fresh-post-play-button');
        }
        if (freshEpisode || now() - advanceBlockedAt > 120000) {
            advanceBlocked = false;
            log('advance-latch: cleared', freshEpisode ? 'fresh-episode' : 'stale-2min');
        }
    }

    // Disney+ ad tier plays pre-roll ads in the SAME hive player, and those ads
    // are ~15-60s — a video-state heuristic must never decide when to advance.

    // Only advance to the next episode when an ACTUAL, actionable "Up Next"
    // element is visible. The bare pivot-tray-overlay is NOT enough on its own:
    // the overlay backdrop can stay "visible" while its content is 0x0 (e.g.
    // while the player's control bar is showing), which previously let the scan
    // keep trying and fall through to the control-bar Play Next button.
    function nextAllowed() {
        // This whole gate exists to solve a Disney+-specific problem (the
        // tray CTA vs. control-bar Play Next ambiguity below). Its checks are
        // all Disney-only selectors, so on Netflix they always miss and this
        // was silently blocking Netflix's own normal, non-hover-gated
        // next-episode button too. isVisible(target) later in clickEl()
        // already covers Netflix's real visibility — no extra gate needed.
        if (!IS_DISNEY) return true;
        // v1.1.24: advance latch — after OUR next-click or any MEDIA-CHANGE,
        // block until the NEXT episode is actually playing (see
        // armAdvanceLatch/updateAdvanceLatch). Prevents a second navigation
        // into the next episode's pre-roll-ad window.
        if (advanceBlocked) {
            const msgKey = 'nextLatched';
            const lastMsg = visThrottle.get(msgKey);
            const nowMs = now();
            if (!lastMsg || nowMs - lastMsg >= 10000) {
                visThrottle.set(msgKey, nowMs);
                // v1.1.26: include the video state so a "still blocking" log
                // shows WHY the latch hasn't cleared (observed? durOk?).
                const lv = mainVideo();
                log('nextAllowed: advance latch active, blocking', (nowMs - advanceBlockedAt) + 'ms',
                    'observed=' + advanceChangeObserved,
                    'video=' + (lv ? Math.round(lv.currentTime) + '/' + Math.round(lv.duration || 0) : 'none'));
            }
            return false;
        }
        const tile = q('pivot-tray-tile')[0];
        if (tile) visDebug(tile, 'nextAllowed tile');
        if (tile && isVisible(tile)) return true;
        // The tray's real CTA is <div class="cta-button-container"><div
        // role="button" tabindex="0" aria-label="Next For You"
        // class="button-container">...<button aria-hidden tabindex="-1"
        // class="cta-button">...</div></div> — the INTERACTIVE element is the
        // middle role="button" div, not the outer container (which has no
        // visible box of its own) or the inner button (aria-hidden,
        // tabindex=-1, never the thing that's actually rendered/clickable).
        // This selector is scoped to be a descendant of .cta-button-container,
        // so it can never match the control-bar's own (structurally identical)
        // .button-container[aria-label="PLAY NEXT"], which lives in the
        // player-controls shadow tree, not inside the tray.
        const ctaWrap = q('.cta-button-container [role="button"]')[0];
        if (ctaWrap) visDebug(ctaWrap, 'nextAllowed ctaWrap');
        if (ctaWrap && isVisible(ctaWrap)) return true;
        const cta = q('.cta-button-container')[0];
        if (cta) visDebug(cta, 'nextAllowed cta');
        if (cta && isVisible(cta)) return true;
        const ctaBtn = q('button.cta-button')[0];
        if (ctaBtn) visDebug(ctaBtn, 'nextAllowed ctaBtn');
        if (ctaBtn && isVisible(ctaBtn)) return true;
        // v1.1.17 field data: the loose backdrop+existence fallback was firing
        // during pre-roll (t:0 d:0, paused) and ad phases (t:24/d:25 in
        // hivePlayer2) — the overlay backdrop gets a real 958x800 box even
        // while the tray content is still 0x0 — and clicking that 0x0 CTA did
        // nothing but poison the 20s next cooldown. The overlay only carries
        // [data-tray-open] during the REAL tray/countdown phase, so require
        // that marker plus a real backdrop box before trusting the fallback.
        const trayOpen = !!q('pivot-tray-overlay[data-tray-open]')[0];
        if ((tile || ctaWrap || cta || ctaBtn) && trayOpen && trayBackdropVisible()) {
            log('nextAllowed: tray sub-elements unmeasurable (0x0), allowing via data-tray-open+backdrop');
            return true;
        }
        // v1.1.20: two episode-end gates, both independent of Disney's tray
        // markup. The v1.1.17/18/19 field logs proved that during the visible
        // countdown the overlay never gets data-tray-open, the tray swiper
        // stays init="false" (tile inert, empty computed styles), the CTA is
        // display:none, AND the video's currentTime does not reliably land
        // within a few seconds of the file end (the tray opens at
        // the credits / "Play Next in 5" moment, not the last 8 s), so the
        // v1.1.19 duration-gate never fired and next waited out the 5 s.
        //
        // Gate 1 — the post-play screen's real <button aria-label="PLAY NEXT
        // …"> (a role="main" section carrying post-play-metadata).
        // User-confirmed on the new player to show DURING CREDITS — as the
        // episode nears its end, while the episode video is still loaded (not
        // just at/after the end) — and carries the live countdown in its
        // aria-label ("PLAY NEXT IN 3", v1.1.28 field log
        // ...1785918557030), so it's matched by prefix, filtered to the
        // visible non-control-bar instance (postPlayButton()). A plain, real,
        // visible button — the exact thing to click.
        // Guarded by durOk || episodeEndedRecent() || postPlayRecent() so it
        // never fires against the short recap/ad segments that swap the same
        // hive video, and by the v1.1.24 advance latch after the click.
        //
        // Gate 2 — tray content present (tile/CTA/header live) at a real
        // episode end (duration >= MIN_EPISODE_SECONDS) with NO skip button
        // up. SKIP INTRO/RECAP only exists on the ~15-60s intro/recap
        // segments, so its absence discriminates the countdown from a recap.
        const v = mainVideo();
        // v1.1.23: the countdown is identified by a SHORT window right after
        // the episode's `ended` event — NOT by the current video, which is
        // unreliable there (the episode is unloaded; the ambient behind the
        // tray can be a duration=Infinity loop OR a finite ~44s promo). The
        // v1.1.22 gate keyed on video state and missed the finite-promo case
        // (field log ...1785916526630: 44s ambient, gate never allowed). The
        // 15s window separates the countdown (0-5s after ended) from the next
        // episode's pre-roll ads (~17-23s after ended, tray also present) and
        // the recap (has a skip-button). A 20s next-action cooldown sits on
        // top, so even a stray second click cannot fire into the ad window.
        const durOk = !!v && Number.isFinite(v.duration) && v.duration >= MIN_EPISODE_SECONDS;
        const vEndedNear = durOk && !!v && (v.ended || (v.duration - v.currentTime) < 15);
        const endedNow = episodeEndedWithin(15000);
        const postNext = postPlayButton();
        if (postNext) visDebug(postNext, 'nextAllowed postNext');
        const postNextVisible = !!postNext && isVisible(postNext);
        if (postNextVisible) postPlaySeenAt.t = now();
        if (postNextVisible && (durOk || episodeEndedRecent() || postPlayRecent())) {
            log('nextAllowed: post-play PLAY NEXT button visible, allowing',
                't=' + (v ? Math.round(v.currentTime) : '?'), 'd=' + (v ? Math.round(v.duration) : '?'),
                'label=' + String(postNext.getAttribute('aria-label') || '').slice(0, 30));
            return true;
        }
        const tileContainer = q('div.tile-container[role="button"]')[0];
        const skipBtn = !!q('skip-button')[0];
        if ((tileContainer || tile || ctaWrap || cta || ctaBtn) && !skipBtn &&
            (endedNow || (durOk && vEndedNear))) {
            log('nextAllowed: tray content present at episode end, allowing',
                't=' + (v ? Math.round(v.currentTime) : '?'),
                'd=' + (v ? Math.round(v.duration) : '?'),
                'endedMs=' + (episodeEndedAt.t ? (now() - episodeEndedAt.t) : 'none'));
            return true;
        }
        return false;
    }

    // v1.1.18: the tray's clickable next-episode tile (div.tile-container
    // [role="button"] inside pivot-tray-tile's shadow root) is frequently
    // 0x0 during the visible countdown because the tray's
    // <swiper-container init="false"> never sized its slides (Swiper-init-
    // while-hidden — confirmed in the v1.1.17 log where the tile stayed 0x0
    // the entire countdown). Make it measurable so the normal isVisible() +
    // dispatchClick() path can click it at real coordinates (the same path
    // that already works for SKIP RECAP). Two-step:
    //   1) ask the swiper to initialize itself (Swiper web-component API);
    //   2) if that doesn't produce a real box, force one on the tile itself
    //      (position:fixed at the tile's measured on-screen spot within the
    //      tray backdrop, ~263x238 at ~x:66,y:147 per the v1.1.16 log),
    //      restored right after the click so we never leave Disney's DOM
    //      mutated. The click dispatches straight on the element, so the
    //      forced box only has to be real — it doesn't need to be exact.
    function ensureTileClickable(el) {
        if (!IS_DISNEY || !el) return el;
        // If we were handed a host wrapper (pivot-tray-tile / swiper-slide /
        // the overlay host) instead of the actual clickable, resolve to the
        // tray's div.tile-container[role="button"] first — that's the element
        // Disney's click handler is attached to.
        // v1.1.22: prefer the ACTIVE slide's tile. The swiper renders 10 tiles
        // (one per episode); the first one in document order lives in a
        // display:none slide, so forcing a box on it never produced a real
        // rect (v1.1.21 field log: 0,0,0,0 right after forcing). The
        // swiper-slide-active tile is the one the user sees and Disney's
        // handler is wired to.
        const container = (el.matches && el.matches('div.tile-container[role="button"]') &&
            el.closest && el.closest('.swiper-slide-active'))
            ? el
            : (q('.swiper-slide-active div.tile-container[role="button"]')[0]
                || q('pivot-tray-tile div.tile-container[role="button"]')[0]
                || q('div.tile-container[role="button"]')[0] || null);
        if (!container) return el;
        if (isVisible(container)) return container;
        try {
            for (const sc of q('.pivot-tray-overlay swiper-container')) {
                if (typeof sc.initialize === 'function') {
                    log('ensureTileClickable: initializing tray swiper', String(sc.className || ''));
                    sc.initialize();
                }
                // Some Swiper builds only expose the instance (sc.swiper);
                // make sure its .init() ran too.
                if (sc.swiper && typeof sc.swiper.init === 'function') {
                    try { sc.swiper.init(); } catch (e) { }
                }
            }
            if (typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new Event('resize'));
            }
            // Force a synchronous reflow so the freshly-initialized swiper's
            // layout (swiper-slide-active, real slide box) is measurable in
            // THIS tick, not the next one.
            void container.getBoundingClientRect();
        } catch (e) {
            log('ensureTileClickable swiper init error', e);
        }
        if (isVisible(container)) return container;
        try {
            const panel = q('.pivot-tray-overlay')[0];
            const pr = panel ? panel.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
            // v1.1.21: during the tray slide-in the overlay's own rect can be
            // mid-translate (negative Y), which made the v1.1.20 forced box
            // land off-screen (66,-236 and 726,-351 in the field log). Clamp
            // so the box (and thus the dispatched click coordinates) is always
            // inside the viewport.
            let left = pr.width > 0 ? pr.x + 66 : 66;
            let top = pr.height > 0 ? pr.y + 147 : 147;
            left = Math.max(8, Math.min(left, window.innerWidth - 271));
            top = Math.max(8, Math.min(top, window.innerHeight - 246));
            const s = container.style;
            container.__bwSavedStyle = s.cssText;
            // v1.1.22: a position:fixed descendant cannot render (and thus
            // measures 0x0) while any ancestor is display:none. The swiper's
            // non-active slides are display:none; flip the whole chain up to
            // 5 levels so the forced box is actually laid out. Saved per
            // element and restored by the same timeout as the container.
            const savedChain = [];
            let up = container.parentElement;
            for (let k = 0; k < 5 && up; k++) {
                if (getComputedStyle(up).display === 'none') {
                    savedChain.push([up, up.style.cssText]);
                    up.style.display = 'block';
                }
                up = up.parentElement;
            }
            container.__bwSavedChain = savedChain;
            s.position = 'fixed';
            s.left = left + 'px';
            s.top = top + 'px';
            s.width = '263px';
            s.height = '238px';
            s.zIndex = '2147483000';
            s.pointerEvents = 'auto';
            s.display = 'block';
            s.background = 'transparent';
            const fr = container.getBoundingClientRect();
            log('ensureTileClickable: forced box on', container.tagName, 'at', left + ',' + top,
                'rect=', fr.width + 'x' + fr.height, 'chainFlipped=' + savedChain.length);
            if (container.__bwRestoreTimer) clearTimeout(container.__bwRestoreTimer);
            container.__bwRestoreTimer = setTimeout(() => {
                try {
                    if (container.__bwSavedStyle !== undefined) {
                        container.style.cssText = container.__bwSavedStyle;
                        delete container.__bwSavedStyle;
                    }
                    if (Array.isArray(container.__bwSavedChain)) {
                        for (const [upEl, css] of container.__bwSavedChain) upEl.style.cssText = css;
                        delete container.__bwSavedChain;
                    }
                } catch (e) { }
                container.__bwRestoreTimer = null;
            }, 1500);
        } catch (e) {
            log('ensureTileClickable force error', e);
        }
        return container;
    }

    function clickEl(el, action) {
        // v1.1.21: evaluate nextAllowed() FIRST. While the countdown tray is
        // up Disney pauses the episode, so the old userPaused-first ordering
        // blocked every genuine episode-end next click. During normal playback
        // nextAllowed() is false anyway, so reordering cannot open the skip
        // vector. userPaused still guards 'skip'/'prev' while paused.
        if (action === 'next') {
            if (!nextAllowed()) {
                // v1.1.20: throttle — this fires on nearly every 1s scan tick
                // while the tray/CTA elements exist but are unclickable.
                const msgKey = 'nextBlocked';
                const lastMsg = visThrottle.get(msgKey);
                const nowMs = now();
                if (!lastMsg || nowMs - lastMsg >= 10000) {
                    visThrottle.set(msgKey, nowMs);
                    log('clickEl: next not allowed yet (video mid-play, no tray)', el && el.tagName,
                        String(el && (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) || ''));
                }
                return false;
            }
        } else if (action && userPaused) {
            log('clickEl: user paused, blocking action', action);
            return false;
        }
        let target = interactiveOrParent(deepestClickable(el));
        if (!target) {
            log('clickEl: no clickable target for', el && el.tagName, String(el && (el.className || el.textContent || '')).slice(0, 40));
            return false;
        }
        // v1.1.18: Disney's tray tile is often 0x0 during the countdown
        // because the tray swiper (init="false") never sized its slides. Ask
        // the swiper to initialize / force a real box on the tile BEFORE the
        // isVisible() gate below, so the click lands at real coordinates.
        // ensureTileClickable() returns the tile-container (the element whose
        // listeners matter), so reassign target to it.
        // v1.1.20: skip this for the post-play "PLAY NEXT" button — it's a
        // real, visible button, and ensureTileClickable() would resolve it to
        // a tray tile-container (if one exists) and click the wrong thing.
        if (action === 'next' && IS_DISNEY &&
            !(target.matches && target.matches('button[aria-label^="PLAY NEXT" i]'))) {
            const ensured = ensureTileClickable(target);
            if (ensured) target = ensured;
        }
        if (action === 'next' && IS_DISNEY && isControlBarPlayNext(target)) {
            log('clickEl: refusing control-bar Play Next (guard)', target.tagName,
                'chain=' + ancestorChain(target, 4));
            return false;
        }
        if (isDisabled(target)) {
            log('clickEl: target disabled, skipping', target.tagName, String(target.className || '').slice(0, 40));
            return false;
        }
        if (action) {
            const last = actionClickedAt.get(action);
            if (last && now() - last < ACTION_COOLDOWN_MS[action]) {
                log('clickEl: action cooldown', action, (now() - last) + 'ms');
                return false;
            }
        }
        // v1.1.17: require the TARGET itself to have a real box. The 0x0 CTA
        // (which only "fades in when closed", i.e. after the tray closes) is
        // no longer clickable-through the backdrop fallback — during the real
        // tray/countdown phase the clickable element is the TILE's visible
        // .tile-container, which passes isVisible() on its own. A click
        // dispatched on a 0x0 element lands at (0,0) and never advances the
        // episode (confirmed in the v1.1.16 field log: CLICKED fires but the
        // AFTER-CLICK href never changes).
        const vis = isVisible(target);
        const text = (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        log('clickEl: target', target.tagName, 'class=' + String(target.className || '').slice(0, 40),
            'text=' + text, 'visible=', vis,
            'rect=', JSON.stringify(target.getBoundingClientRect ? (({ x, y, width, height }) => ({ x, y, width, height }))(target.getBoundingClientRect()) : null));
        if (!vis) return false;
        const lastEl = clickedAt.get(target);
        if (lastEl && now() - lastEl < CLICK_COOLDOWN_MS) {
            log('clickEl: cooldown active, last click', now() - lastEl, 'ms ago');
            return false;
        }
        try {
            dispatchClick(target);
        } catch (e) {
            log('click error', e);
            return false;
        }
        clickedAt.set(target, now());
        if (action) actionClickedAt.set(action, now());
        // v1.1.24: our own advance arms the latch immediately. The re-click
        // risk is NOT after MEDIA-CHANGE is seen (checkMediaChange runs first
        // in scan and would arm/observe it), but in the ~600ms until the next
        // scan runs, while the old credits video is still loaded and the
        // post-play button is still visible.
        if (action === 'next') {
            const cv = mainVideo();
            lastNextSrc = (cv && cv.currentSrc) || '';
            lastNextTime = cv ? cv.currentTime : 0;
            armAdvanceLatch('after-next-click');
        }
        if (clickedAt.size > 200) {
            const cutoff = now() - CLICK_COOLDOWN_MS;
            for (const [k, t] of clickedAt) if (t < cutoff) clickedAt.delete(k);
        }
        log('CLICKED', target.tagName, String(target.className || target.textContent || '').slice(0, 60),
            'action=' + action, 'chain=' + ancestorChain(target, 3));
        log('CLICK-CONTEXT', JSON.stringify(mediaInfo()));
        // 1.5s after the click, log the media again so we can see whether the
        // click actually advanced/changed the episode (or wrongly skipped it).
        if (action) {
            setTimeout(() => {
                log('AFTER-CLICK ' + action, JSON.stringify(mediaInfo()));
            }, 1500);
        }
        return true;
    }

    function clickOne(elements, action) {
        for (const el of elements) {
            if (clickEl(el, action)) return true;
        }
        return false;
    }

    // Collect all matching elements, including inside shadow roots.
    function queryAll(root, selector) {
        const out = [];
        const start = root && root.nodeType === 9
            ? root.documentElement
            : (root || document.documentElement);
        (function walk(node) {
            if (!node) return;
            if (node.nodeType === 1 && node.matches && node.matches(selector)) out.push(node);
            if (node.nodeType === 1) {
                const sr = getShadow(node);
                if (sr) walk(sr);
            }
            for (const child of node.childNodes) walk(child);
        })(start);
        return out;
    }

    const q = (...selectors) => selectors.flatMap(sel => queryAll(document, sel));

    // ---- platform selectors, one action per scan pass ----
    function scanSelectors() {
        if (CONFIG.debug) {
            const c = {
                nfIntro: q('[data-uia="player-skip-intro"]').length,
                nfRecap: q('[data-uia="player-skip-recap"]').length,
                nfNext: q('[data-uia="next-episode-seamless-button"]').length,
                dpSkip: q('skip-button').length,
                dpSkipLabel: (function () {
                    const sb = q('skip-button')[0];
                    const r = sb && getShadow(sb);
                    const l = r && r.querySelector('.label, span');
                    return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
                })(),
                dpTray: q('pivot-tray-overlay').length,
                dpPlay: q('.play-overlay').length,
                dpTile: q('pivot-tray-tile').length,
                dpTileC: q('div.tile-container[role="button"]').length,
                dpHeader: q('.pivot-tray-overlay .countdown-text').length,
                dpPlayNext: q('button.play-next, [part~="play-next"]').length,
                dpPostNext: q('button[aria-label^="PLAY NEXT" i]').filter(el => !isControlBarPlayNext(el)).length,
                dpCta: q('.cta-button-container', 'button.cta-button').length,
                dpCtaWrap: q('.cta-button-container [role="button"]').length,
                epEnded: episodeEndedAt.t ? Math.max(0, Math.round((now() - episodeEndedAt.t) / 1000)) : 0,
                advLock: advanceBlocked ? Math.max(0, Math.round((now() - advanceBlockedAt) / 1000)) : 0,
            };
            const mv = mainVideo();
            if (mv) c.video = Math.round(mv.currentTime) + '/' + Math.round(mv.duration || 0) + (mv.ended ? ' ended' : '');
            log('candidates ' + Object.keys(c).map(k => k + '=' + c[k]).join(' '));
        }
        if (IS_NETFLIX) {
            if (CONFIG.skipIntros && clickOne(q('[data-uia="player-skip-recap"]'), 'skip')) return;
            if (CONFIG.skipIntros && clickOne(q('[data-uia="player-skip-intro"]', '.watch-video--skip-content-button'), 'skip')) return;
            if ((CONFIG.skipCredits || CONFIG.autoNext) &&
                clickOne(q('[data-uia="next-episode-seamless-button"]', '[data-uia="next-episode-seamless-button-draining"]', '.skip-credits'), 'next')) return;
            if (CONFIG.autoNext && clickOne(q('.postplay-still-container', '.WatchNext-still-container'), 'next')) return;
            return;
        }

        if (IS_DISNEY) {
            // Skip Intro / Skip Recap: a <skip-button> custom element (label text
            // "SKIP INTRO" / "SKIP RECAP"). Legacy .skip__button kept as fallback.
            if (CONFIG.skipIntros &&
                clickOne(q('skip-button', 'button.skip__button', '[data-testid="skip-overlay"] button'), 'skip')) return;
            // Next episode. v1.1.20: the post-play screen's real
            // <button aria-label="PLAY NEXT …"> FIRST — user-confirmed present
            // during the countdown on the new player, a plain visible
            // button that advances the episode. v1.1.28: its aria-label
            // carries the live countdown ("PLAY NEXT IN 3"), so it's matched
            // by prefix via postPlayButton(). The CONTROL-BAR Play Next
            // (button.play-next / [part~="play-next"], wrapped in
            // <info-tooltip>) is still NEVER used: a single click on it emits
            // a 10x native PLAY_NEXT/CLICKED event storm that queues a SECOND
            // navigation, so the next episode loads and then gets skipped to
            // the one after it. isControlBarPlayNext() (INFO-TOOLTIP /
            // part="play-next" / play-next class — but NOT a bare aria-label,
            // which is how the legit post-play button used to be blocked)
            // filters the control-bar one out regardless of how it was found.
            // wakePlayerControls() is deliberately NOT called here either — it
            // shows the control bar, which makes Disney+ hide the tray content
            // (tile/CTA go 0x0), which is what forced the fall-through to the
            // control-bar button in the first place.
            if ((CONFIG.skipCredits || CONFIG.autoNext) && nextAllowed() &&
                (q('pivot-tray-overlay')[0] ||
                 postPlayButton() ||
                 q('.cta-button-container', 'button.cta-button')[0])) {
            // v1.1.17/18: the tile-container FIRST. The v1.1.16 field log showed
            // the tile DOES get a real, measurable box (263x238 at
            // x:66,y:147) once the tray swiper initializes (slide gets
            // swiper-slide-active / display:flex) — and the tile's shadow root
            // contains the actual clickable: div.tile-container[role="button"]
            // [aria-label="PLAY …"]. During the countdown the swiper is still
            // init="false", so the tile-container is INERT (empty computed
            // styles, not in the render tree) — ensureTileClickable() below
            // calls swiper.initialize() (per v1.1.16 this brings the slide
            // into the live DOM with a real box) and only then clicks it at
            // real coordinates. The CTA (.cta-button-container [role="button"]
            // "Next For You") is only "faded in when closed" — 0x0 DURING the
            // tray — so it's the fallback for the post-tray phase, and
            // clicking any 0x0 element is blocked anyway in clickEl().
            const postPlayBtn = postPlayButton();
            if (clickOne((postPlayBtn ? [postPlayBtn] : []).concat(
                q('div.tile-container[role="button"]',
                    'pivot-tray-tile',
                    '.cta-button-container [role="button"]',
                    'button.cta-button', '.cta-button-container')), 'next')) return;
            }
        }
    }

    // ---- text fallback for platforms/sites where class names change ----
    const TEXT_TARGETS = [
        'Skip Intro', 'Skip Recap', 'Skip Credits', 'Skip Summary',
        'Next Episode', 'Play Next Episode', 'Watch Next Episode', 'Play Next',
        'Next For You',
    ].map(t => t.toUpperCase());

    function scanByText() {
        let found = null;
        (function walk(node) {
            if (found || !node) return;
            if (node.nodeType === 1) {
                const tag = node.tagName;
                const role = node.getAttribute && node.getAttribute('role');
                const cls = typeof node.className === 'string' ? node.className : '';
                const isCandidate = tag === 'BUTTON' || tag === 'A' || role === 'button' ||
                    /(skip|up.?next|countdown|postplay)/i.test(cls);
                if (isCandidate) {
                    const text = (node.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
                    if (TEXT_TARGETS.some(t => text === t || text.indexOf(t + ' ') === 0)) {
                        const action = /^SKIP\b/.test(text) ? 'skip' : 'next';
                        // Don't latch onto the control-bar Play Next control
                        // just because its tooltip text matches — keep
                        // walking so a real tray candidate can still be found.
                        if (!(action === 'next' && IS_DISNEY && isControlBarPlayNext(node))) {
                            found = node;
                            return;
                        }
                    }
                }
                const sr = getShadow(node);
                if (sr) walk(sr);
            }
            for (const child of node.childNodes) { walk(child); if (found) return; }
        })(document.documentElement);
        if (found) {
            const action = /^SKIP\b/.test((found.textContent || '').trim()) ? 'skip' : 'next';
            log('scanByText: found candidate', found.tagName,
                'class=' + String(found.className || '').slice(0, 40),
                'text=' + (found.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                'action=' + action);
            clickEl(found, action);
        }
    }

    // Dump the LIVE (often class-hashed) structure of the tray and skip overlay
    // so selectors can be fixed against what actually renders. Throttled to
    // ~10s (v1.1.20) — it ran on every 1s scan tick and was the noisiest
    // logger while the tray existed.
    let lastDebugDump = 0;
    function debugDump() {
        if (!CONFIG.debug) return;
        const nowMs = now();
        if (nowMs - lastDebugDump < 10000) return;
        lastDebugDump = nowMs;
        const tray = q('pivot-tray-overlay')[0];
        if (tray) {
            const root = getShadow(tray) || tray;
            const btns = [...root.querySelectorAll('button, [role="button"], a')].map(b =>
                b.tagName + '|role=' + (b.getAttribute('role') || '') +
                '|class=' + String(b.className || '').slice(0, 40) +
                '|text=' + (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30))
                .join(' ;; ');
            log('tray buttons:', btns);
            log('tray html:', (tray.outerHTML || '').slice(0, 1000));
            // v1.1.23: also dump the SHADOW-root markup (the host outerHTML is
            // empty) so the countdown structure — including any visible
            // "Play Next in 5…" number — is captured for the next session.
            log('tray shadow:', (root.innerHTML || '').slice(0, 4000));
        }
        const skip = q('skip-button')[0];
        if (skip) {
            log('skip html:', (skip.outerHTML || '').slice(0, 1000));
            const skipRoot = getShadow(skip);
            if (skipRoot) {
                log('skip shadow:', [...skipRoot.querySelectorAll('button, [role="button"], .label, span, [part]')]
                    .map(b => b.tagName + '|part=' + (b.getAttribute && b.getAttribute('part') || '') +
                        '|role=' + (b.getAttribute && b.getAttribute('role') || '') +
                        '|text=' + (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30))
                    .join(' ;; '));
            }
        }
        const skipOv = q('skip-overlay')[0];
        if (skipOv) log('skip-overlay html:', (skipOv.outerHTML || '').slice(0, 1000));
        // v1.1.27: dump every element that looks like the post-play "Play Next"
        // screen (aria-label, class, part, or visible text) with its real rect
        // and shadow ancestry, so the next session shows WHY Gate 1's
        // button[aria-label="PLAY NEXT"] is (or isn't) being found/visible.
        const ppSel = '[aria-label*="PLAY NEXT" i], [aria-label*="Play Next" i], ' +
            '[class*="post-play" i], [class*="postplay" i], ' +
            'button.play-next, [part~="play-next"], [part*="post" i]';
        for (const el of q(ppSel)) {
            try {
                const r = el.getBoundingClientRect();
                log('postplay el:', el.tagName,
                    'class=' + String(el.className || '').slice(0, 60),
                    'aria=' + (el.getAttribute && el.getAttribute('aria-label') || ''),
                    'rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
                        '@' + Math.round(r.x) + ',' + Math.round(r.y),
                    'visible=' + isVisible(el),
                    'shadow=' + (getShadow(el) ? 'yes' : 'no'),
                    'ctrlBar=' + isControlBarPlayNext(el),
                    'html=' + (el.outerHTML || '').slice(0, 300).replace(/\s+/g, ' '),
                    'chain=' + ancestorChain(el, 4));
            } catch (e) { }
        }
    }

    // Log every SPA navigation / media change with full episode context so we
    // can correlate clicks with episodes in the log.
    let lastMediaHref = '';
    function checkMediaChange() {
        try {
            const href = location.href;
            if (href && href !== lastMediaHref) {
                const old = lastMediaHref;
                lastMediaHref = href;
                if (old) {
                    log('MEDIA-CHANGE', 'old=' + old.slice(-60), 'new=' + href.slice(-60));
                    log('MEDIA-CONTEXT', JSON.stringify(mediaInfo()));
                    // v1.1.24: any media change (ours or native) arms the
                    // advance latch; if it was already armed by our own click,
                    // this just marks the change as observed.
                    if (advanceBlocked) advanceChangeObserved = true;
                    else armAdvanceLatch('media-change');
                }
            }
        } catch (e) { }
    }

    // v1.1.19 diagnostic: during the countdown the overlay's shadow content
    // stays visually hidden (tile inert in the uninitialized swiper, CTA
    // display:none, header opacity 0), and we still haven't identified the
    // element that renders the on-screen "Play Next in 5…". Dump every
    // element inside the tray overlay (walking nested shadow roots) that has a
    // countdown/next-ish class OR non-empty visible text, with its measured
    // box and opacity — throttled to ~10s so the log stays readable.
    let lastTrayDump = 0;
    function dumpTrayState() {
        if (!CONFIG.debug) return;
        const nowMs = now();
        if (nowMs - lastTrayDump < 10000) return;
        lastTrayDump = nowMs;
        const tray = q('pivot-tray-overlay')[0];
        if (!tray) return;
        const root = getShadow(tray);
        if (!root) return;
        const parts = [];
        (function walk(n, depth) {
            if (!n || depth > 7) return;
            const cls = typeof n.className === 'string' ? n.className : '';
            const txt = (n.textContent || '').replace(/\s+/g, ' ').trim();
            const interesting = /countdown|pill|timer|play.?next|up.?next|tray/i.test(cls) ||
                (txt && txt.length > 0 && txt.length < 60 && (/play next|up next|in \d|^[0-9]$/.test(txt)));
            if (interesting) {
                try {
                    const r = n.getBoundingClientRect();
                    parts.push(n.tagName + '.' + cls.slice(0, 40) + '[' +
                        Math.round(r.width) + 'x' + Math.round(r.height) + ' op=' +
                        getComputedStyle(n).opacity + ' vis=' + getComputedStyle(n).visibility + '] "' + txt.slice(0, 50) + '"');
                } catch (e) { }
            }
            const sr = getShadow(n);
            if (sr) walk(sr, depth + 1);
            for (const c of n.children) walk(c, depth + 1);
        })(root, 0);
        log('TRAY-STATE', parts.join(' ;; ').slice(0, 1800));
    }

    function scan() {
        if (!IS_NETFLIX && !IS_DISNEY) return;
        checkMediaChange();
        trackPlaybackState();
        watchEpisodeEnded();
        updateAdvanceLatch();
        log('scan tick', new Date().toISOString());
        scanSelectors();
        scanByText();
        dumpTrayState();
        debugDump();
    }

    // ---- mutation-driven scanning (debounced) ----
    let scanTimer = null;
    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 600);
    }

    // Watch the document and every (open) shadow root that appears.
    const observed = new WeakSet();

    function observe(root) {
        if (observed.has(root)) return;
        observed.add(root);
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node && node.nodeType === 1) attachToNode(node);
                }
            }
            scheduleScan();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    function attachToNode(node) {
        if (!node || node.nodeType !== 1) return;
        const sr = getShadow(node);
        if (sr) observe(sr);
        for (const child of node.children) attachToNode(child);
    }

    // Light-DOM walk to pick up shadow roots whose host existed before their
    // attachShadow() call. observe() dedupes via WeakSet, so this is cheap.
    function syncShadowObservers() {
        (function walk(node) {
            if (!node || node.nodeType !== 1) return;
            const sr = getShadow(node);
            if (sr) observe(sr);
            for (const child of node.children) walk(child);
        })(document.documentElement);
    }

    function init() {
        const root = document.documentElement;
        log('init: platform=', HOST, 'attachShadowPatched=', !!SHADOW_CACHE);
        observe(root);
        attachToNode(root);
        scan();
        setInterval(() => { syncShadowObservers(); scan(); }, CONFIG.fallbackScanMs);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
