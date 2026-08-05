# Userscripts

A collection of userscripts for [Disney+](https://www.disneyplus.com) (and [Netflix](https://www.netflix.com)), written by [Ionut Baciu](https://github.com/ibaciu6). All scripts are MIT licensed.

## How to install

1. Install the **Tampermonkey** browser extension from <https://www.tampermonkey.net/>.
2. Open a script below, then open its `.user.js` file (the links in each entry).
3. Tampermonkey shows an install page — click **Install**.
4. Reload the target site (Disney+ / Netflix) and the script runs automatically.

## Scripts

### 1. Binge Watching (Netflix & Disney+)

Automatically skips intros, recaps, and credits and clicks the next episode, so you can binge without touching the keyboard.

- Skips **Skip Intro / Skip Recap / Skip Credits** buttons on both Netflix and Disney+.
- Auto-advances to the next episode when an episode ends (Disney+ post-play "Play Next" / countdown and tray paths).
- No dependencies, no jQuery — plain vanilla JS.
- **Shadow-DOM aware:** patches `attachShadow` (closed roots included) so it can see and click inside Disney+'s web-component player.
- Event-driven scanning (mutation observer + fallback timer), with safety guards so it never clicks mid-recap, during ads, or twice into the same transition.
- Optional debug logging (disabled by default).

**Settings:** edit the `CONFIG` block at the top of the script.

| Setting | Default | Purpose |
|---|---|---|
| `skipIntros` | `true` | Click "Skip Intro" / "Skip Recap" buttons |
| `skipCredits` | `true` | Click skip-credits / next-episode buttons near the end of an episode |
| `autoNext` | `true` | Click "Up Next" / post-play overlays to start the next episode |
| `debug` | `false` | Log actions to the browser console (enable only when troubleshooting) |
| `fallbackScanMs` | `3000` | Fallback scan interval in ms (the MutationObserver does most of the work) |

**File:** [binge-watching-netflix-disney-plus.user.js](binge-watching-netflix-disney-plus.user.js)

**Install:** <https://github.com/ibaciu6/userscripts/raw/main/binge-watching-netflix-disney-plus.user.js>

---

### 2. Disney+ Subtitle Styler: Large & Yellow

**Greasy Fork:** https://greasyfork.org/en/scripts/589939-disney-subtitle-styler-large-yellow

Makes Disney+ subtitles always render **large and yellow** so they're easy to read, even on big screens.

- Forces subtitle text to a large size and Disney-yellow (`#FFD200`).
- Works with the current Disney+ player, including its shadow-DOM subtitle renderer.
- Optional **Netflix Sans** font support: loads Netflix's variable font so subtitles can look like Netflix's.
- Layered text shadow keeps subtitles readable on bright scenes.
- Fully configurable: size, color, font, weight, shadow, and background.

**Customization:** edit the `SETTINGS` block at the top of the script.

| Setting | Default | Purpose |
|---|---|---|
| `SIZES` | presets | Named size presets (small → xlarge) |
| `FONT_SIZE` | `SIZES.large` | Subtitle font size |
| `FONT_FAMILY` | `'Netflix Sans', ...` | Font family (set to `undefined` to disable) |
| `TEXT_COLOR` | `#FFD200` | Subtitle color |
| `FONT_WEIGHT` | `700` | Font weight |
| `TEXT_SHADOW` | layered shadow | Text outline/shadow |
| `LINE_BACKGROUND` | `transparent` | Background box behind each line |

**File:** [disneyplus-yellow-large-subtitles.user.js](disneyplus-yellow-large-subtitles.user.js)

---

### 3. Disney+ Auto Fullscreen (Enhanced)

**Greasy Fork:** https://greasyfork.org/en/scripts/589940-disney-auto-fullscreen-enhanced

Automatically enters fullscreen on Disney+ when you click **Play/Continue** and stays on through entire binge-watching sessions.

- Auto-enters fullscreen on user-initiated playback.
- **Survives episode transitions:** fullscreen persists when the player is rebuilt between episodes.
- **Cursor auto-hide:** the mouse cursor hides while fullscreen (reappears on mouse move).
- **Fallback overlay:** when a next episode autoplays without a user gesture (and the browser blocks fullscreen), a clickable "Click to enter fullscreen" overlay is shown.
- Respects a manual Esc exit until you navigate to another title.

**Settings:** edit the `CONFIG` block at the top of the script.

| Setting | Default | Purpose |
|---|---|---|
| `autoFullscreen` | `true` | Enter fullscreen automatically on playback |
| `showOverlay` | `true` | Show click-to-fullscreen overlay for gesture-less autoplay |
| `overlayText` | `Click to enter fullscreen` | Overlay message |
| `userGestureWindowMs` | `4000` | Window (ms) after a click/keypress counted as user-initiated |
| `hideCursorIdleMs` | `1500` | Hide cursor after inactivity in fullscreen (`0` = never) |

**Credits:** enhanced rewrite of **Disney+ Auto Fullscreen** by [Raizuto](https://greasyfork.org/en/scripts/553167) (MIT License).

**File:** [disneyplus-auto-fullscreen.user.js](disneyplus-auto-fullscreen.user.js)

---

## License

MIT License. See the `@license` header in each script.
