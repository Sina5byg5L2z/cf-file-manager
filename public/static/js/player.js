// A dependency-free, modern video player (Bilibili-style skin + gestures).
//
// Usage:  const p = VideoPlayer.create(containerEl, srcUrl, opts); ... p.destroy();
//
// Features
//   • Custom controls: play/pause, ±10s skip, volume (+mute, remembered),
//     current/total time, speed menu, picture-in-picture, fullscreen.
//   • Progress bar: click to jump, drag to scrub, buffered indicator, and a
//     hover tooltip showing the target time.
//   • Gestures (mouse): hold the RIGHT button to fast-forward at high speed
//     (release to restore); double-click the left/right third to skip ∓10s,
//     the center to toggle fullscreen; single click toggles play.
//   • Gestures (touch/mobile): single tap shows/hides the control overlay,
//     double-tap the left/right third skips ∓10s, the center plays/pauses,
//     long-press fast-forwards — tap never pauses on mobile.
//   • Keyboard: Space/K play, ←/→ (5s) J/L (10s), ↑/↓ volume, F fullscreen,
//     M mute, 0–9 seek to percentage.
//   • Loading spinner, auto-hiding controls, PiP.
//
// Playback relies on the server's HTTP Range support so seeking issues a fresh
// request for the target byte offset instead of downloading from the start.
(function (global) {
    'use strict';

    var STYLE_ID = 'vp-styles-v1';
    var HOLD_SPEED = 3;          // playback rate while the right button is held
    var HOLD_DELAY = 250;        // ms before a right-button press counts as "hold"
    var TOUCH_LONG_MS = 550;     // touch long-press before hold-to-fast-forward engages
    var TOUCH_DOUBLE_MS = 300;   // max gap between the two taps of a double-tap
    var TOUCH_DOUBLE_DIST = 40;  // max px drift between the two taps of a double-tap
    var TAP_MS = 350;            // max press duration that still counts as a tap
    var TAP_MOVE = 12;           // px of movement beyond which a press is a swipe/scroll
    var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    var AUTO_TICK = 15000;       // ms between auto-quality buffer-health checks

    // Estimated bandwidth (kbps) needed to comfortably sustain each tier — the
    // rung's capped bitrate plus headroom. Used by the "Auto" quality mode.
    function autoRequirement(tier) {
        if (tier === 'original') return 9000;
        return ({ 360: 1050, 480: 1800, 720: 3750, 1080: 6750 })[tier] || 1800;
    }

    var ICONS = {
        play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
        back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>',
        fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l5 5-5 5"/><path d="M6 7l5 5-5 5"/></svg>',
        volHigh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
        volMute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
        pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="15" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
        fileWarn: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="12" y1="12.5" x2="12" y2="15.5"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
        fileDl: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        fsEnter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        fsExit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3a1 1 0 0 0 1-1V4M16 4v3a1 1 0 0 0 1 1h3M20 16h-3a1 1 0 0 0-1 1v3M8 20v-3a1 1 0 0 0-1-1H4"/></svg>',
        music: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>'
    };

    var CSS = [
        '.vp-root{position:relative;width:100%;background:#000;overflow:hidden;border-radius:10px;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
        'outline:none;user-select:none;-webkit-user-select:none;color:#fff;line-height:1;--vp-accent:#3ea6ff}',
        '.vp-root *{box-sizing:border-box}',
        '.vp-video{display:block;width:100%;max-height:78vh;background:#000}',
        '.vp-root:fullscreen{border-radius:0;width:100vw;height:100vh}',
        '.vp-root:fullscreen .vp-video{width:100%;height:100%;max-height:none;object-fit:contain}',
        '.vp-root.vp-hidden{cursor:none}',
        '.vp-surface{position:absolute;inset:0;z-index:1;-webkit-touch-callout:none}',
        // big center play button
        '.vp-bigplay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(1);z-index:3;',
        'width:74px;height:74px;border-radius:50%;border:none;cursor:pointer;',
        'background:rgba(0,0,0,.45);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;',
        'transition:opacity .2s,transform .2s;opacity:0;pointer-events:none}',
        '.vp-bigplay svg{width:34px;height:34px;fill:#fff;margin-left:3px}',
        '.vp-root.vp-paused .vp-bigplay{opacity:1;pointer-events:auto}',
        '.vp-bigplay:hover{transform:translate(-50%,-50%) scale(1.08);background:rgba(0,0,0,.6)}',
        // loading spinner
        '.vp-loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;',
        'width:46px;height:46px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;',
        'animation:vp-spin .8s linear infinite;display:none}',
        '.vp-root.vp-loading-on .vp-loading{display:block}',
        '@keyframes vp-spin{to{transform:translate(-50%,-50%) rotate(360deg)}}',
        // gesture hints (skip / speed)
        '.vp-hint{position:absolute;top:50%;transform:translateY(-50%);z-index:4;pointer-events:none;',
        'background:rgba(0,0,0,.55);color:#fff;padding:10px 16px;border-radius:24px;font-size:14px;',
        'display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .25s}',
        '.vp-hint.vp-show{opacity:1}',
        '.vp-hint-left{left:12%}.vp-hint-right{right:12%}',
        '.vp-pill{position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:4;pointer-events:none;',
        'background:rgba(0,0,0,.6);color:#fff;padding:7px 14px;border-radius:20px;font-size:13px;font-weight:600;',
        'display:flex;align-items:center;gap:7px;opacity:0;transition:opacity .2s}',
        '.vp-pill.vp-show{opacity:1}',
        '.vp-pill .vp-pill-ar{color:var(--vp-accent);letter-spacing:-2px}',
        // controls
        '.vp-controls{position:absolute;left:0;right:0;bottom:0;z-index:5;padding:0 12px 8px;',
        'background:linear-gradient(to top,rgba(0,0,0,.78) 0,rgba(0,0,0,.35) 60%,transparent 100%);',
        'opacity:1;transform:translateY(0);transition:opacity .25s,transform .25s}',
        '.vp-root.vp-hidden .vp-controls{opacity:0;transform:translateY(8px);pointer-events:none}',
        // progress bar
        '.vp-progress{position:relative;height:16px;display:flex;align-items:center;cursor:pointer;margin-bottom:2px}',
        '.vp-track{position:relative;width:100%;height:4px;border-radius:3px;background:rgba(255,255,255,.28);transition:height .12s}',
        '.vp-progress:hover .vp-track{height:6px}',
        '.vp-buffered{position:absolute;left:0;top:0;height:100%;border-radius:3px;background:rgba(255,255,255,.4);width:0}',
        '.vp-hover{position:absolute;left:0;top:0;height:100%;border-radius:3px;background:rgba(255,255,255,.3);width:0}',
        '.vp-played{position:absolute;left:0;top:0;height:100%;border-radius:3px;background:var(--vp-accent);width:0}',
        '.vp-scrubber{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;background:#fff;',
        'transform:translate(-50%,-50%) scale(0);left:0;transition:transform .12s;box-shadow:0 0 4px rgba(0,0,0,.5)}',
        '.vp-progress:hover .vp-scrubber,.vp-root.vp-dragging .vp-scrubber{transform:translate(-50%,-50%) scale(1)}',
        '.vp-tooltip{position:absolute;bottom:18px;transform:translateX(-50%);background:rgba(0,0,0,.85);',
        'color:#fff;font-size:12px;padding:3px 7px;border-radius:4px;pointer-events:none;opacity:0;transition:opacity .12s;white-space:nowrap}',
        // button bar
        '.vp-bar{display:flex;align-items:center;gap:4px;height:40px}',
        '.vp-btn{background:none;border:none;color:#fff;cursor:pointer;width:38px;height:38px;padding:7px;',
        'border-radius:6px;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,transform .1s;flex:none}',
        '.vp-btn:hover{background:rgba(255,255,255,.16)}',
        '.vp-btn:active{transform:scale(.9)}',
        '.vp-btn svg{width:100%;height:100%;display:block}',
        '.vp-btn.vp-play svg{fill:#fff}',
        '.vp-spacer{flex:1}',
        '.vp-time{font-size:13px;color:#eee;font-variant-numeric:tabular-nums;padding:0 6px;white-space:nowrap}',
        '.vp-time .vp-dur{color:#bbb}',
        // volume
        '.vp-volume{display:flex;align-items:center}',
        '.vp-vol-slider{width:0;overflow:hidden;transition:width .2s;display:flex;align-items:center}',
        '.vp-volume:hover .vp-vol-slider,.vp-vol-slider.vp-open{width:72px}',
        '.vp-vol-track{position:relative;width:60px;height:4px;border-radius:3px;background:rgba(255,255,255,.3);margin:0 6px;cursor:pointer}',
        '.vp-vol-fill{position:absolute;left:0;top:0;height:100%;border-radius:3px;background:#fff;width:100%}',
        '.vp-vol-knob{position:absolute;top:50%;width:11px;height:11px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);left:100%}',
        // speed
        '.vp-speed{position:relative}',
        '.vp-speed-btn{width:auto;padding:0 9px;font-size:13px;font-weight:600;min-width:44px}',
        '.vp-speed-menu{position:absolute;bottom:44px;right:0;background:rgba(28,28,30,.96);border-radius:8px;',
        'padding:5px;min-width:88px;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none;flex-direction:column;gap:1px}',
        '.vp-speed-menu.vp-open{display:flex}',
        '.vp-speed-opt{padding:8px 12px;font-size:13px;border-radius:5px;cursor:pointer;color:#eee;white-space:nowrap;text-align:center}',
        '.vp-speed-opt:hover{background:rgba(255,255,255,.12)}',
        '.vp-speed-opt.vp-active{color:var(--vp-accent);font-weight:700}',
        // quality menu (shares the speed menu look)
        '.vp-quality{position:relative}',
        '.vp-quality-btn{width:auto;padding:0 9px;font-size:13px;font-weight:600;min-width:44px}',
        '.vp-quality-menu{position:absolute;bottom:44px;right:0;background:rgba(28,28,30,.96);border-radius:8px;',
        'padding:5px;min-width:96px;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none;flex-direction:column;gap:1px}',
        '.vp-quality-menu.vp-open{display:flex}',
        '.vp-quality-opt{padding:8px 12px;font-size:13px;border-radius:5px;cursor:pointer;color:#eee;white-space:nowrap;text-align:center}',
        '.vp-quality-opt:hover{background:rgba(255,255,255,.12)}',
        '.vp-quality-opt.vp-active{color:var(--vp-accent);font-weight:700}',
        // transcode status overlay
        '.vp-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:6;',
        'background:rgba(0,0,0,.62);color:#fff;padding:10px 18px;border-radius:22px;font-size:13px;',
        'display:none;align-items:center;gap:9px;white-space:nowrap}',
        '.vp-root.vp-status-on .vp-status{display:flex}',
        '.vp-status-spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:vp-rot .8s linear infinite}',
        '@keyframes vp-rot{to{transform:rotate(360deg)}}',
        // audio card
        '.vp-audio{position:relative;width:100%;max-width:560px;margin:0 auto;background:#1c1c1e;color:#fff;',
        'border-radius:12px;padding:16px 18px;--vp-accent:#3ea6ff;user-select:none;-webkit-user-select:none;outline:none;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-touch-callout:none}',
        '.vp-audio *{box-sizing:border-box}',
        '.vp-audio-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}',
        '.vp-audio-icon{width:44px;height:44px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;',
        'background:linear-gradient(135deg,var(--vp-accent),#9b6cff)}',
        '.vp-audio-icon svg{width:24px;height:24px;fill:#fff}',
        '.vp-audio-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:#f2f2f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.vp-audio-badge{flex:none;font-size:12px;font-weight:600;color:var(--vp-accent);opacity:0;transition:opacity .2s;white-space:nowrap}',
        '.vp-audio-badge.vp-show{opacity:1}',
        '.vp-audio .vp-time{font-size:12px;color:#bbb;flex:none}',
        '.vp-audio .vp-progress{margin-bottom:8px}',
        '.vp-audio-controls{display:flex;align-items:center;gap:4px}',
        '.vp-audio .vp-vol-slider{width:72px}',
        '@media (max-width:640px){.vp-time{font-size:12px}.vp-btn{width:34px;height:34px}.vp-volume{display:none}}',
        // media error overlay (格式不支持/网络加载失败)
        '.vp-media-error{position:absolute;inset:0;z-index:8;background:rgba(22,22,24,.96);display:none;',
        'flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;',
        'padding:18px;border-radius:inherit}',
        '.vp-media-error.vp-show{display:flex}',
        '.vp-media-error svg{width:38px;height:38px;stroke:#9aa0a6;fill:none;stroke-width:1.5}',
        '.vp-media-error-txt{font-size:13px;color:#e8eaed;line-height:1.7}',
        '.vp-media-error button{margin-top:2px;background:var(--vp-accent);border:none;color:#fff;font-size:13px;',
        'font-weight:600;padding:8px 18px;border-radius:20px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
        '.vp-media-error button:hover{filter:brightness(1.1)}',
        '.vp-media-error button svg{width:14px;height:14px;stroke:#fff;stroke-width:2}'
    ].join('');

    function injectCss() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
    }

    function fmtRate(r) {
        var str = (Math.round(r * 100) / 100).toString();
        return str + '×';
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function VideoPlayer(container, src, opts) {
        injectCss();
        this.opts = opts || {};
        this.container = container;
        this._listeners = [];
        this._dragging = false;
        this._holding = false;
        this._menuOpen = false;
        this._clickTimer = null;
        this._holdTimer = null;
        this._hideTimer = null;
        this._hintTimer = null;
        this._t = null;              // active touch gesture (tap / long-press tracking)
        this._lastTap = null;        // previous tap of a possible double-tap
        this._lastPointerType = null;
        this._destroyed = false;
        this._curQuality = 'original';
        this.qualityCfg = this.opts.quality || null;
        this._qualityOptions = null;
        this._auto = false;
        this._autoTier = null;
        this._autoTimer = null;
        this._lastAutoSwitch = 0;

        var root = document.createElement('div');
        root.className = 'vp-root vp-paused';
        root.tabIndex = 0;
        root.innerHTML =
            '<video class="vp-video" playsinline preload="metadata"></video>' +
            '<div class="vp-surface"></div>' +
            '<div class="vp-loading"></div>' +
            '<div class="vp-status"><span class="vp-status-spin"></span><span class="vp-status-txt"></span></div>' +
            '<div class="vp-media-error">' + ICONS.fileWarn + '<div class="vp-media-error-txt"></div>' +
                '<button type="button">' + ICONS.fileDl + '下载文件</button></div>' +
            '<button class="vp-bigplay" aria-label="播放">' + ICONS.play + '</button>' +
            '<div class="vp-hint vp-hint-left">' + ICONS.back10 + '<span>10秒</span></div>' +
            '<div class="vp-hint vp-hint-right"><span>10秒</span>' + ICONS.fwd10 + '</div>' +
            '<div class="vp-pill"><span class="vp-pill-ar">▶▶</span><span class="vp-pill-txt"></span></div>' +
            '<div class="vp-controls">' +
                '<div class="vp-progress"><div class="vp-track">' +
                    '<div class="vp-buffered"></div><div class="vp-hover"></div><div class="vp-played"></div>' +
                    '<div class="vp-scrubber"></div></div><div class="vp-tooltip">00:00</div></div>' +
                '<div class="vp-bar">' +
                    '<button class="vp-btn vp-play" aria-label="播放/暂停">' + ICONS.play + '</button>' +
                    '<button class="vp-btn vp-back" title="后退10秒 (J)">' + ICONS.back10 + '</button>' +
                    '<button class="vp-btn vp-fwd" title="快进10秒 (L)">' + ICONS.fwd10 + '</button>' +
                    '<div class="vp-volume"><button class="vp-btn vp-mute" aria-label="静音">' + ICONS.volHigh + '</button>' +
                        '<div class="vp-vol-slider"><div class="vp-vol-track"><div class="vp-vol-fill"></div><div class="vp-vol-knob"></div></div></div></div>' +
                    '<div class="vp-time"><span class="vp-cur">00:00</span> / <span class="vp-dur">00:00</span></div>' +
                    '<div class="vp-spacer"></div>' +
                    '<div class="vp-quality" style="display:none"><button class="vp-btn vp-quality-btn" aria-label="清晰度">原画</button><div class="vp-quality-menu"></div></div>' +
                    '<div class="vp-speed"><button class="vp-btn vp-speed-btn" aria-label="倍速">倍速</button>' +
                        '<div class="vp-speed-menu"></div></div>' +
                    '<button class="vp-btn vp-pip" title="画中画">' + ICONS.pip + '</button>' +
                    '<button class="vp-btn vp-fs" title="全屏 (F)">' + ICONS.fsEnter + '</button>' +
                '</div>' +
            '</div>';

        container.innerHTML = '';
        container.appendChild(root);
        this.root = root;

        var q = function (sel) { return root.querySelector(sel); };
        this.video = q('.vp-video');
        this.surface = q('.vp-surface');
        this.bigplay = q('.vp-bigplay');
        this.pill = q('.vp-pill');
        this.pillTxt = q('.vp-pill-txt');
        this.hintLeft = q('.vp-hint-left');
        this.hintRight = q('.vp-hint-right');
        this.progress = q('.vp-progress');
        this.track = q('.vp-track');
        this.buffered = q('.vp-buffered');
        this.hover = q('.vp-hover');
        this.played = q('.vp-played');
        this.scrubber = q('.vp-scrubber');
        this.tooltip = q('.vp-tooltip');
        this.playBtn = q('.vp-play');
        this.muteBtn = q('.vp-mute');
        this.volTrack = q('.vp-vol-track');
        this.volFill = q('.vp-vol-fill');
        this.volKnob = q('.vp-vol-knob');
        this.curEl = q('.vp-cur');
        this.durEl = q('.vp-dur');
        this.speedBtn = q('.vp-speed-btn');
        this.speedMenu = q('.vp-speed-menu');
        this.pipBtn = q('.vp-pip');
        this.fsBtn = q('.vp-fs');
        this.statusEl = q('.vp-status');
        this.statusTxt = q('.vp-status-txt');
        this.qualityWrap = q('.vp-quality');
        this.qualityBtn = q('.vp-quality-btn');
        this.qualityMenu = q('.vp-quality-menu');
        this.errBox = q('.vp-media-error');

        this._buildSpeedMenu();
        this._restorePrefs();
        this._bind();

        this.video.src = src;
        if (this.opts.autoplay) { var self = this; this.video.play().catch(function () {}); }
        this._syncVolumeUI();
        if (this.qualityCfg) this._initQuality();
    }

    VideoPlayer.prototype._on = function (target, event, handler, options) {
        target.addEventListener(event, handler, options);
        this._listeners.push({ target: target, event: event, handler: handler, options: options });
    };

    VideoPlayer.prototype._buildSpeedMenu = function () {
        var self = this;
        SPEEDS.forEach(function (sp) {
            var opt = document.createElement('div');
            opt.className = 'vp-speed-opt';
            opt.dataset.speed = sp;
            opt.textContent = sp === 1 ? '正常' : fmtRate(sp);
            opt.addEventListener('click', function (e) {
                e.stopPropagation();
                self.video.playbackRate = sp;
                self._closeMenu();
            });
            self.speedMenu.appendChild(opt);
        });
    };

    VideoPlayer.prototype._restorePrefs = function () {
        try {
            var vol = localStorage.getItem('vp-volume');
            var muted = localStorage.getItem('vp-muted');
            if (vol !== null) this.video.volume = Math.max(0, Math.min(1, parseFloat(vol)));
            if (muted === '1') this.video.muted = true;
        } catch (e) {}
    };

    VideoPlayer.prototype._persist = function () {
        try {
            localStorage.setItem('vp-volume', String(this.video.volume));
            localStorage.setItem('vp-muted', this.video.muted ? '1' : '0');
        } catch (e) {}
    };

    VideoPlayer.prototype._bind = function () {
        var self = this;
        var v = this.video;

        // --- media element events ---
        this._on(v, 'loadedmetadata', function () {
            self._updateProgress();
            self._syncSpeed();
            if (self._pendingSeek != null) {
                try { v.currentTime = self._pendingSeek; } catch (e) {}
                self._pendingSeek = null;
                if (self._pendingPlay) { v.play().catch(function () {}); self._pendingPlay = false; }
            }
        });
        this._on(v, 'timeupdate', function () { self._updateProgress(); });
        this._on(v, 'progress', function () { self._updateBuffered(); });
        this._on(v, 'play', function () { self.root.classList.remove('vp-paused'); self.playBtn.innerHTML = ICONS.pause; self.bigplay.innerHTML = ICONS.pause; self._scheduleHide(); });
        this._on(v, 'pause', function () { self.root.classList.add('vp-paused'); self.playBtn.innerHTML = ICONS.play; self.bigplay.innerHTML = ICONS.play; self._showControls(); });
        this._on(v, 'ratechange', function () { self._syncSpeed(); });
        this._on(v, 'volumechange', function () { self._syncVolumeUI(); });
        this._on(v, 'waiting', function () { self.root.classList.add('vp-loading-on'); if (self._auto) self._autoStep(-1); });
        this._on(v, 'seeking', function () { self.root.classList.add('vp-loading-on'); });
        this._on(v, 'canplay', function () { self.root.classList.remove('vp-loading-on'); });
        this._on(v, 'playing', function () { self.root.classList.remove('vp-loading-on'); });
        this._on(v, 'seeked', function () { self.root.classList.remove('vp-loading-on'); });
        this._on(v, 'ended', function () { self.root.classList.add('vp-paused'); self._showControls(); });
        this._on(v, 'error', function () { self._showMediaError(v); });

        // --- button bar ---
        this._on(this.playBtn, 'click', function () { self.togglePlay(); });
        this._on(this.bigplay, 'click', function () { self.togglePlay(); });
        this._on(this.root.querySelector('.vp-back'), 'click', function () { self.skip(-10); self._flashHint('left'); });
        this._on(this.root.querySelector('.vp-fwd'), 'click', function () { self.skip(10); self._flashHint('right'); });
        this._on(this.muteBtn, 'click', function () { self.toggleMute(); });
        this._on(this.fsBtn, 'click', function () { self.toggleFullscreen(); });
        this._on(this.pipBtn, 'click', function () { self.togglePip(); });
        this._on(this.speedBtn, 'click', function (e) { e.stopPropagation(); self._toggleMenu(); });
        this._on(this.qualityBtn, 'click', function (e) { e.stopPropagation(); self._toggleQualityMenu(); });
        if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
            this.pipBtn.style.display = 'none';
        }

        // --- progress bar: click / drag / hover ---
        this._on(this.progress, 'pointerdown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            self._dragging = true;
            self.root.classList.add('vp-dragging');
            try { self.progress.setPointerCapture(e.pointerId); } catch (err) {}
            self._seekFromEvent(e);
        });
        this._on(this.progress, 'pointermove', function (e) {
            self._updateHover(e);
            if (self._dragging) self._seekFromEvent(e);
        });
        this._on(this.progress, 'pointerup', function (e) {
            if (!self._dragging) return;
            self._dragging = false;
            self.root.classList.remove('vp-dragging');
            try { self.progress.releasePointerCapture(e.pointerId); } catch (err) {}
        });
        this._on(this.progress, 'pointerleave', function () { self.tooltip.style.opacity = '0'; self.hover.style.width = '0'; });

        // --- volume slider ---
        this._on(this.volTrack, 'pointerdown', function (e) {
            e.preventDefault();
            self._volDragging = true;
            try { self.volTrack.setPointerCapture(e.pointerId); } catch (err) {}
            self._volFromEvent(e);
        });
        this._on(this.volTrack, 'pointermove', function (e) { if (self._volDragging) self._volFromEvent(e); });
        this._on(this.volTrack, 'pointerup', function (e) {
            self._volDragging = false;
            try { self.volTrack.releasePointerCapture(e.pointerId); } catch (err) {}
        });

        // --- gesture surface: single/double click, right-hold speed ---
        // touch taps take the pointer-gesture path below; mouse keeps click/dblclick.
        this._on(this.root, 'pointerdown', function (e) { self._lastPointerType = e.pointerType; });
        this._on(this.surface, 'contextmenu', function (e) { e.preventDefault(); });
        this._on(this.surface, 'click', function (e) {
            if (e.button !== 0) return;
            if (self._lastPointerType === 'touch') return;
            if (self._clickTimer) { clearTimeout(self._clickTimer); self._clickTimer = null; }
            self._clickTimer = setTimeout(function () {
                self._clickTimer = null;
                self.togglePlay();
            }, 220);
        });
        this._on(this.surface, 'dblclick', function (e) {
            if (self._lastPointerType === 'touch') return;
            if (self._clickTimer) { clearTimeout(self._clickTimer); self._clickTimer = null; }
            var rect = self.surface.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var third = rect.width / 3;
            if (x < third) { self.skip(-10); self._flashHint('left'); }
            else if (x > 2 * third) { self.skip(10); self._flashHint('right'); }
            else { self.toggleFullscreen(); }
        });
        this._on(this.surface, 'pointerdown', function (e) {
            if (e.pointerType === 'touch') { self._touchStart(e); return; }
            if (e.button === 2) {           // right button → hold to fast-forward
                e.preventDefault();
                self._holdTimer = setTimeout(function () {
                    self._holdTimer = null;
                    self._engageHold();
                }, HOLD_DELAY);
            }
        });
        this._on(this.surface, 'pointermove', function (e) { self._touchMove(e); });
        this._on(this.surface, 'pointerup', function (e) { self._touchEnd(e); });
        this._on(this.surface, 'pointercancel', function () { self._touchCancel(); });
        var endHold = function () {
            if (self._holdTimer) { clearTimeout(self._holdTimer); self._holdTimer = null; }
            if (self._holding) self._releaseHold();
        };
        this._on(window, 'pointerup', endHold);
        this._on(this.surface, 'pointerleave', endHold);

        // --- show/hide controls on activity ---
        this._on(this.root, 'pointermove', function () { self._showControls(); });
        this._on(this.root, 'mouseleave', function () { if (!self.video.paused && !self._menuOpen) self._scheduleHide(0); });

        // --- keyboard ---
        this._on(this.root, 'keydown', function (e) { self._onKey(e); });
        // focus so keyboard works immediately (without scrolling the page)
        setTimeout(function () { try { self.root.focus({ preventScroll: true }); } catch (err) { self.root.focus(); } }, 0);

        // --- fullscreen state ---
        this._fsHandler = function () {
            var on = document.fullscreenElement === self.root;
            self.fsBtn.innerHTML = on ? ICONS.fsExit : ICONS.fsEnter;
        };
        this._on(document, 'fullscreenchange', this._fsHandler);

        // --- close speed menu on outside click ---
        this._docClick = function (e) {
            if (self._menuOpen && !self.speedMenu.contains(e.target) && e.target !== self.speedBtn) self._closeMenu();
            if (self._qMenuOpen && !self.qualityMenu.contains(e.target) && e.target !== self.qualityBtn) self._closeQualityMenu();
        };
        this._on(document, 'click', this._docClick);
    };

    // ---- playback controls ----
    VideoPlayer.prototype.togglePlay = function () {
        if (this.video.paused) this.video.play().catch(function () {});
        else this.video.pause();
    };
    VideoPlayer.prototype.skip = function (delta) {
        var d = this.video.duration;
        var t = this.video.currentTime + delta;
        if (isFinite(d)) t = Math.max(0, Math.min(d, t));
        else t = Math.max(0, t);
        this.video.currentTime = t;
    };
    VideoPlayer.prototype.setVolume = function (v) {
        v = Math.max(0, Math.min(1, v));
        this.video.volume = v;
        this.video.muted = v === 0;
        this._persist();
    };
    VideoPlayer.prototype.toggleMute = function () {
        this.video.muted = !this.video.muted;
        if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5;
        this._persist();
    };
    VideoPlayer.prototype.toggleFullscreen = function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (this.root.requestFullscreen) this.root.requestFullscreen();
    };
    VideoPlayer.prototype.togglePip = function () {
        try {
            if (document.pictureInPictureElement) document.exitPictureInPicture();
            else if (this.video.requestPictureInPicture) this.video.requestPictureInPicture();
        } catch (e) {}
    };

    // ---- media error overlay (格式不支持 / 网络失败): 遮住整卡, 提供下载出口 ----
    VideoPlayer.prototype._showMediaError = function (el) {
        if (this._destroyed || this._errShown) return;
        this._errShown = true;
        var code = 0;
        try { code = el && el.error ? el.error.code : 0; } catch (e) {}
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
        var box = this.errBox;
        if (!box) return;
        box.querySelector('.vp-media-error-txt').textContent =
            code === 2 ? '媒体加载失败，请检查网络后重试' : '当前浏览器不支持播放此格式';
        var btn = box.querySelector('button');
        if (typeof this.opts.onDownload === 'function') {
            var self = this;
            btn.addEventListener('click', function () { self.opts.onDownload(); });
        } else {
            btn.style.display = 'none';
        }
        box.classList.add('vp-show');
        this.root.classList.remove('vp-paused'); // 隐藏大播放键, 避免对空源再试播
    };

    // ---- right-button hold-to-fast-forward ----
    VideoPlayer.prototype._engageHold = function () {
        this._holding = true;
        this._prevRate = this.video.playbackRate;
        this._prevPaused = this.video.paused;
        if (this._prevPaused) this.video.play().catch(function () {});
        this.video.playbackRate = this.opts.holdSpeed || HOLD_SPEED;
        this.pillTxt.textContent = fmtRate(this.video.playbackRate) + ' 快进中';
        this.pill.classList.add('vp-show');
    };
    VideoPlayer.prototype._releaseHold = function () {
        this._holding = false;
        this.video.playbackRate = this._prevRate || 1;
        if (this._prevPaused) this.video.pause();
        this.pill.classList.remove('vp-show');
    };

    // ---- touch gestures (mobile conventions) ----
    // Single tap: show/hide the control overlay (never pauses). Double tap:
    // left/right third seeks ∓10s, center plays/pauses. Long press:
    // hold-to-fast-forward, same as the desktop right-button hold.
    // Swipes / page scrolls and multi-touch cancel everything pending.
    VideoPlayer.prototype._touchStart = function (e) {
        var self = this;
        if (this._t) return;                       // multi-touch — ignore extra fingers
        try { this.surface.setPointerCapture(e.pointerId); } catch (err) {}
        this._t = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false, held: false };
        this._t.longTimer = setTimeout(function () {
            if (!self._t || self._t.moved) return;
            self._t.held = true;
            self._engageHold();
        }, TOUCH_LONG_MS);
    };
    VideoPlayer.prototype._touchMove = function (e) {
        if (!this._t || e.pointerId !== this._t.id) return;
        var dx = e.clientX - this._t.x, dy = e.clientY - this._t.y;
        if (dx * dx + dy * dy > TAP_MOVE * TAP_MOVE) {
            this._t.moved = true;
            if (!this._t.held) clearTimeout(this._t.longTimer);   // it's a swipe/scroll, not a hold
        }
    };
    VideoPlayer.prototype._touchEnd = function (e) {
        var t = this._t;
        if (!t || e.pointerId !== t.id) return;
        this._t = null;
        clearTimeout(t.longTimer);
        if (t.held) { this._releaseHold(); return; }              // long-press consumed the gesture
        if (t.moved || Date.now() - t.t > TAP_MS) { this._lastTap = null; return; }
        var now = Date.now(), last = this._lastTap;
        if (last && now - last.t < TOUCH_DOUBLE_MS &&
            Math.abs(e.clientX - last.x) < TOUCH_DOUBLE_DIST &&
            Math.abs(e.clientY - last.y) < TOUCH_DOUBLE_DIST) {
            this._lastTap = null;
            if (last.toggled) this._mobileToggleControls();       // revert tap #1's toggle
            var rect = this.surface.getBoundingClientRect();
            var x = e.clientX - rect.left, third = rect.width / 3;
            if (x < third) { this.skip(-10); this._flashHint('left'); }
            else if (x > 2 * third) { this.skip(10); this._flashHint('right'); }
            else this.togglePlay();
            return;
        }
        this._lastTap = { x: e.clientX, y: e.clientY, t: now, toggled: this._mobileToggleControls() };
    };
    VideoPlayer.prototype._touchCancel = function () {
        if (!this._t) return;
        clearTimeout(this._t.longTimer);
        if (this._t.held) this._releaseHold();
        this._t = null;
        this._lastTap = null;
    };
    VideoPlayer.prototype._mobileToggleControls = function () {
        if (this._destroyed || this._menuOpen || this._qMenuOpen) return false;
        if (this.root.classList.contains('vp-hidden')) { this._showControls(); return true; }
        if (!this.video.paused) { this.root.classList.add('vp-hidden'); clearTimeout(this._hideTimer); return true; }
        return false;   // paused: controls stay visible
    };

    // ---- progress / hover / buffered ----
    VideoPlayer.prototype._seekFromEvent = function (e) {
        var rect = this.track.getBoundingClientRect();
        var ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
        ratio = Math.max(0, Math.min(1, ratio));
        var d = this.video.duration;
        if (isFinite(d) && d > 0) this.video.currentTime = ratio * d;
        this._updateProgress();
    };
    VideoPlayer.prototype._updateHover = function (e) {
        var rect = this.track.getBoundingClientRect();
        var ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
        ratio = Math.max(0, Math.min(1, ratio));
        var d = this.video.duration || 0;
        this.tooltip.textContent = fmtTime(ratio * d);
        this.tooltip.style.left = (ratio * 100) + '%';
        this.tooltip.style.opacity = '1';
        this.hover.style.width = (ratio * 100) + '%';
    };
    VideoPlayer.prototype._updateProgress = function () {
        var d = this.video.duration, c = this.video.currentTime;
        var pct = (isFinite(d) && d > 0) ? (c / d) * 100 : 0;
        this.played.style.width = pct + '%';
        this.scrubber.style.left = pct + '%';
        this.curEl.textContent = fmtTime(c);
        this.durEl.textContent = fmtTime(d);
    };
    VideoPlayer.prototype._updateBuffered = function () {
        var d = this.video.duration;
        if (!isFinite(d) || d <= 0 || !this.video.buffered.length) return;
        var end = this.video.buffered.end(this.video.buffered.length - 1);
        this.buffered.style.width = Math.min(100, (end / d) * 100) + '%';
    };

    // ---- volume UI ----
    VideoPlayer.prototype._volFromEvent = function (e) {
        var rect = this.volTrack.getBoundingClientRect();
        var ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
        this.setVolume(ratio);
    };
    VideoPlayer.prototype._syncVolumeUI = function () {
        var muted = this.video.muted || this.video.volume === 0;
        var v = muted ? 0 : this.video.volume;
        this.volFill.style.width = (v * 100) + '%';
        this.volKnob.style.left = (v * 100) + '%';
        this.muteBtn.innerHTML = muted ? ICONS.volMute : ICONS.volHigh;
    };

    // ---- speed menu ----
    VideoPlayer.prototype._syncSpeed = function () {
        var r = this.video.playbackRate;
        this.speedBtn.textContent = r === 1 ? '倍速' : fmtRate(r);
        var opts = this.speedMenu.querySelectorAll('.vp-speed-opt');
        for (var i = 0; i < opts.length; i++) {
            opts[i].classList.toggle('vp-active', parseFloat(opts[i].dataset.speed) === r);
        }
    };
    VideoPlayer.prototype._toggleMenu = function () { this._menuOpen ? this._closeMenu() : this._openMenu(); };
    VideoPlayer.prototype._openMenu = function () { this._menuOpen = true; this.speedMenu.classList.add('vp-open'); this._showControls(); };
    VideoPlayer.prototype._closeMenu = function () { this._menuOpen = false; this.speedMenu.classList.remove('vp-open'); };

    // ---- quality / resolution ----
    VideoPlayer.prototype._initQuality = function () {
        var self = this;
        Promise.resolve(this.qualityCfg.fetchOptions()).then(function (options) {
            if (self._destroyed) return;
            options = options || [];
            if (!options.length) return; // nothing lower than original — keep the button hidden
            self._qualityOptions = options;
            self._buildQualityMenu(options);
            self.qualityWrap.style.display = '';
            self._syncQualityLabel();
            // Apply the remembered preference (without re-saving it).
            var pref = self._loadQualityPref();
            if (pref === 'auto') {
                self._enableAuto();
            } else if (pref && pref !== 'original') {
                var rung = parseInt(pref, 10);
                if (!isNaN(rung) && options.some(function (o) { return String(o.value) === String(rung); })) {
                    self._applyQuality(rung);
                }
            }
        }).catch(function () {});
    };
    VideoPlayer.prototype._buildQualityMenu = function (options) {
        var self = this;
        // Auto first, then Original, then the transcoded rungs (high → low).
        var items = [{ value: 'auto', label: '自动' }, { value: 'original', label: '原画' }]
            .concat(options.map(function (o) { return { value: o.value, label: o.label }; }));
        this.qualityMenu.innerHTML = '';
        items.forEach(function (it) {
            var el = document.createElement('div');
            el.className = 'vp-quality-opt';
            el.dataset.value = it.value;
            el.textContent = it.label;
            el.addEventListener('click', function (e) { e.stopPropagation(); self._closeQualityMenu(); self._setQuality(it.value); });
            self.qualityMenu.appendChild(el);
        });
    };
    VideoPlayer.prototype._syncQualityLabel = function () {
        var activeVal, label;
        if (this._auto) {
            activeVal = 'auto';
            if (this._autoTier === 'original') label = '自动 · 原画';
            else if (this._autoTier) label = '自动 · ' + this._autoTier + 'P';
            else label = '自动';
        } else {
            activeVal = this._curQuality;
            label = this._curQuality === 'original' ? '原画' : (this._curQuality + 'P');
        }
        this.qualityBtn.textContent = label;
        var opts = this.qualityMenu.querySelectorAll('.vp-quality-opt');
        for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('vp-active', String(opts[i].dataset.value) === String(activeVal));
    };
    VideoPlayer.prototype._toggleQualityMenu = function () { this._qMenuOpen ? this._closeQualityMenu() : this._openQualityMenu(); };
    VideoPlayer.prototype._openQualityMenu = function () { this._qMenuOpen = true; this.qualityMenu.classList.add('vp-open'); this._showControls(); };
    VideoPlayer.prototype._closeQualityMenu = function () { this._qMenuOpen = false; this.qualityMenu.classList.remove('vp-open'); };
    VideoPlayer.prototype._showStatus = function (txt) { this.statusTxt.textContent = txt; this.root.classList.add('vp-status-on'); };
    VideoPlayer.prototype._hideStatus = function () { this.root.classList.remove('vp-status-on'); };

    // Remembered quality preference ('auto' | 'original' | rung), shared across videos.
    VideoPlayer.prototype._loadQualityPref = function () {
        try { return localStorage.getItem('vp-quality-pref'); } catch (e) { return null; }
    };
    VideoPlayer.prototype._saveQualityPref = function (value) {
        try { localStorage.setItem('vp-quality-pref', String(value)); } catch (e) {}
    };

    // Menu selection: 'auto' | 'original' | <rung number>
    VideoPlayer.prototype._setQuality = function (value) {
        this._saveQualityPref(value); // remember the explicit user choice
        if (value === 'auto') {
            if (!this._auto) this._enableAuto();
            return;
        }
        this._disableAuto();
        if (String(value) === String(this._curQuality)) { this._syncQualityLabel(); return; }
        this._applyQuality(value);
    };

    // Perform the actual source switch (transcoding first if needed).
    VideoPlayer.prototype._applyQuality = function (value) {
        var self = this;
        if (this._switching) return;
        this._switching = true;
        var t = this.video.currentTime;
        var wasPlaying = !this.video.paused;

        var doSwitch = function () {
            self._pendingSeek = t;
            self._pendingPlay = wasPlaying;
            self.root.classList.add('vp-loading-on');
            self.video.src = self.qualityCfg.srcFor(value);
            self.video.load();
            self._curQuality = value;
            self._syncQualityLabel();
            self._switching = false;
        };

        if (value === 'original') { this._hideStatus(); doSwitch(); return; }

        this._showStatus('转码中…');
        (function poll() {
            if (self._destroyed) { self._switching = false; return; }
            Promise.resolve(self.qualityCfg.prepare(value)).then(function (res) {
                if (self._destroyed) { self._switching = false; return; }
                res = res || {};
                if (res.status === 'ready') { self._hideStatus(); doSwitch(); }
                else if (res.status === 'failed') {
                    self._switching = false;
                    self._showStatus('转码失败，请重试');
                    setTimeout(function () { self._hideStatus(); }, 2000);
                } else {
                    self._showStatus('转码中 ' + (res.progress || 0) + '%');
                    sleep(1000).then(poll);
                }
            }).catch(function () { self._hideStatus(); self._switching = false; });
        })();
    };

    // ---- Auto (adaptive) quality ----
    VideoPlayer.prototype._autoTiers = function () {
        var vals = (this._qualityOptions || []).map(function (o) { return o.value; }).sort(function (a, b) { return a - b; });
        return vals.concat(['original']); // ascending, original as the ceiling
    };
    VideoPlayer.prototype._enableAuto = function () {
        var self = this;
        this._auto = true;
        this._autoTier = null;
        this._syncQualityLabel();
        this._autoEvaluate();
        clearInterval(this._autoTimer);
        this._autoTimer = setInterval(function () { self._autoTick(); }, AUTO_TICK);
    };
    VideoPlayer.prototype._disableAuto = function () {
        this._auto = false;
        this._autoTier = null;
        clearInterval(this._autoTimer);
        this._autoTimer = null;
    };
    // Estimate downstream bandwidth in kbps (Network Info API, else a small probe).
    VideoPlayer.prototype._estimateKbps = function () {
        try {
            var c = navigator.connection;
            if (c && c.downlink) return Promise.resolve(c.downlink * 1000);
        } catch (e) {}
        var url = this.qualityCfg.srcFor('original');
        var N = 500000, t0 = (window.performance || Date).now();
        return fetch(url, { headers: { Range: 'bytes=0-' + (N - 1) }, cache: 'no-store' })
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (buf) {
                var secs = ((window.performance || Date).now() - t0) / 1000;
                if (secs <= 0) return null;
                return (buf.byteLength * 8 / 1000) / secs;
            })
            .catch(function () { return null; });
    };
    VideoPlayer.prototype._pickTierForBandwidth = function (kbps) {
        var tiers = this._autoTiers();
        for (var i = tiers.length - 1; i >= 0; i--) {
            if (kbps >= autoRequirement(tiers[i])) return tiers[i];
        }
        return tiers[0];
    };
    VideoPlayer.prototype._autoEvaluate = function () {
        var self = this;
        if (!this._auto || this._destroyed) return;
        this._estimateKbps().then(function (kbps) {
            if (!self._auto || self._destroyed) return;
            var tier;
            if (kbps == null) {
                var tiers = self._autoTiers();
                tier = tiers.indexOf(480) >= 0 ? 480 : tiers[0];
            } else {
                tier = self._pickTierForBandwidth(kbps);
            }
            self._autoApplyTier(tier);
        });
    };
    VideoPlayer.prototype._autoTick = function () {
        // Periodic: upshift when the buffer is comfortably ahead.
        if (!this._auto || this._destroyed || this._switching || this.video.paused) return;
        var v = this.video, ahead = 0;
        if (v.buffered.length) ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
        if (ahead > 20) this._autoStep(1);
    };
    VideoPlayer.prototype._autoStep = function (dir) {
        if (!this._auto || this._destroyed || this._switching) return;
        var tiers = this._autoTiers();
        var idx = -1;
        for (var i = 0; i < tiers.length; i++) if (String(tiers[i]) === String(this._autoTier)) { idx = i; break; }
        if (idx < 0) idx = tiers.length - 1;
        var ni = idx + dir;
        if (ni < 0 || ni >= tiers.length) return;
        var cd = dir < 0 ? 6000 : 15000; // downshift reacts fast, upshift is conservative
        if (Date.now() - this._lastAutoSwitch < cd) return;
        this._autoApplyTier(tiers[ni]);
    };
    VideoPlayer.prototype._autoApplyTier = function (tier) {
        if (!this._auto || this._destroyed) return;
        if (String(tier) === String(this._autoTier) && this._curQuality != null) return;
        this._autoTier = tier;
        this._lastAutoSwitch = Date.now();
        this._syncQualityLabel();
        this._applyQuality(tier);
    };

    // ---- controls auto-hide ----
    VideoPlayer.prototype._showControls = function () {
        this.root.classList.remove('vp-hidden');
        this._scheduleHide();
    };
    VideoPlayer.prototype._scheduleHide = function (delay) {
        var self = this;
        clearTimeout(this._hideTimer);
        if (this.video.paused) return;
        this._hideTimer = setTimeout(function () {
            if (!self.video.paused && !self._menuOpen && !self._dragging) self.root.classList.add('vp-hidden');
        }, delay === undefined ? 2600 : delay);
    };

    // ---- gesture hints ----
    VideoPlayer.prototype._flashHint = function (side) {
        var el = side === 'left' ? this.hintLeft : this.hintRight;
        el.classList.add('vp-show');
        var self = this;
        clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(function () { el.classList.remove('vp-show'); }, 500);
    };

    // ---- keyboard ----
    VideoPlayer.prototype._onKey = function (e) {
        var k = e.key;
        if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); this.togglePlay(); }
        else if (k === 'ArrowRight') { e.preventDefault(); this.skip(5); this._flashHint('right'); }
        else if (k === 'l' || k === 'L') { e.preventDefault(); this.skip(10); this._flashHint('right'); }
        else if (k === 'ArrowLeft') { e.preventDefault(); this.skip(-5); this._flashHint('left'); }
        else if (k === 'j' || k === 'J') { e.preventDefault(); this.skip(-10); this._flashHint('left'); }
        else if (k === 'ArrowUp') { e.preventDefault(); this.setVolume(this.video.volume + 0.1); }
        else if (k === 'ArrowDown') { e.preventDefault(); this.setVolume(this.video.volume - 0.1); }
        else if (k === 'f' || k === 'F') { e.preventDefault(); this.toggleFullscreen(); }
        else if (k === 'm' || k === 'M') { e.preventDefault(); this.toggleMute(); }
        else if (k >= '0' && k <= '9') {
            e.preventDefault();
            var d = this.video.duration;
            if (isFinite(d)) this.video.currentTime = d * (parseInt(k, 10) / 10);
        }
    };

    // ---- teardown ----
    VideoPlayer.prototype.destroy = function () {
        this._destroyed = true;
        clearTimeout(this._clickTimer);
        clearTimeout(this._holdTimer);
        clearTimeout(this._hideTimer);
        clearTimeout(this._hintTimer);
        clearInterval(this._autoTimer);
        if (this._t) { clearTimeout(this._t.longTimer); this._t = null; }
        this._lastTap = null;
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            l.target.removeEventListener(l.event, l.handler, l.options);
        }
        this._listeners = [];
        try {
            if (document.pictureInPictureElement === this.video) document.exitPictureInPicture();
        } catch (e) {}
        try { this.video.pause(); } catch (e) {}
        this.video.removeAttribute('src');
        try { this.video.load(); } catch (e) {}
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    VideoPlayer.create = function (container, src, opts) { return new VideoPlayer(container, src, opts); };

    // ============================================================
    //  AudioPlayer — same modern skin as a "now playing" card.
    //  Reuses the shared progress / volume / speed CSS + icons.
    // ============================================================
    function AudioPlayer(container, src, opts) {
        injectCss();
        this.opts = opts || {};
        this.container = container;
        this._listeners = [];
        this._dragging = false;
        this._holding = false;
        this._menuOpen = false;
        this._holdTimer = null;

        var root = document.createElement('div');
        root.className = 'vp-audio';
        root.tabIndex = 0;
        root.innerHTML =
            '<audio preload="metadata"></audio>' +
            '<div class="vp-media-error">' + ICONS.fileWarn + '<div class="vp-media-error-txt"></div>' +
                '<button type="button">' + ICONS.fileDl + '下载文件</button></div>' +
            '<div class="vp-audio-head">' +
                '<div class="vp-audio-icon">' + ICONS.music + '</div>' +
                '<div class="vp-audio-title"></div>' +
                '<div class="vp-audio-badge"><span class="vp-pill-ar">▶▶</span> <span class="vp-badge-txt"></span></div>' +
                '<div class="vp-time"><span class="vp-cur">00:00</span> / <span class="vp-dur">00:00</span></div>' +
            '</div>' +
            '<div class="vp-progress"><div class="vp-track">' +
                '<div class="vp-buffered"></div><div class="vp-hover"></div><div class="vp-played"></div><div class="vp-scrubber"></div>' +
            '</div><div class="vp-tooltip">00:00</div></div>' +
            '<div class="vp-audio-controls">' +
                '<button class="vp-btn vp-play" aria-label="播放/暂停">' + ICONS.play + '</button>' +
                '<button class="vp-btn vp-back" title="后退10秒 (J)">' + ICONS.back10 + '</button>' +
                '<button class="vp-btn vp-fwd" title="快进10秒 (L)">' + ICONS.fwd10 + '</button>' +
                '<div class="vp-spacer"></div>' +
                '<div class="vp-volume"><button class="vp-btn vp-mute" aria-label="静音">' + ICONS.volHigh + '</button>' +
                    '<div class="vp-vol-slider"><div class="vp-vol-track"><div class="vp-vol-fill"></div><div class="vp-vol-knob"></div></div></div></div>' +
                '<div class="vp-speed"><button class="vp-btn vp-speed-btn" aria-label="倍速">倍速</button><div class="vp-speed-menu"></div></div>' +
            '</div>';

        container.innerHTML = '';
        container.appendChild(root);
        this.root = root;

        var q = function (sel) { return root.querySelector(sel); };
        this.audio = q('audio');
        this.head = q('.vp-audio-head');
        this.badge = q('.vp-audio-badge');
        this.badgeTxt = q('.vp-badge-txt');
        this.progress = q('.vp-progress');
        this.track = q('.vp-track');
        this.buffered = q('.vp-buffered');
        this.hover = q('.vp-hover');
        this.played = q('.vp-played');
        this.scrubber = q('.vp-scrubber');
        this.tooltip = q('.vp-tooltip');
        this.playBtn = q('.vp-play');
        this.muteBtn = q('.vp-mute');
        this.volTrack = q('.vp-vol-track');
        this.volFill = q('.vp-vol-fill');
        this.volKnob = q('.vp-vol-knob');
        this.curEl = q('.vp-cur');
        this.durEl = q('.vp-dur');
        this.speedBtn = q('.vp-speed-btn');
        this.speedMenu = q('.vp-speed-menu');
        this.errBox = q('.vp-media-error');

        if (this.opts.title) q('.vp-audio-title').textContent = this.opts.title;

        this._buildSpeedMenu();
        this._restorePrefs();
        this._bind();

        this.audio.src = src;
        if (this.opts.autoplay) this.audio.play().catch(function () {});
        this._syncVolumeUI();
    }

    // Shared helpers reused verbatim from VideoPlayer.
    AudioPlayer.prototype._on = VideoPlayer.prototype._on;
    AudioPlayer.prototype._showMediaError = VideoPlayer.prototype._showMediaError;
    AudioPlayer.prototype._buildSpeedMenu = function () {
        var self = this;
        SPEEDS.forEach(function (sp) {
            var opt = document.createElement('div');
            opt.className = 'vp-speed-opt';
            opt.dataset.speed = sp;
            opt.textContent = sp === 1 ? '正常' : fmtRate(sp);
            opt.addEventListener('click', function (e) { e.stopPropagation(); self.audio.playbackRate = sp; self._closeMenu(); });
            self.speedMenu.appendChild(opt);
        });
    };
    AudioPlayer.prototype._restorePrefs = function () {
        try {
            var vol = localStorage.getItem('vp-volume');
            var muted = localStorage.getItem('vp-muted');
            if (vol !== null) this.audio.volume = Math.max(0, Math.min(1, parseFloat(vol)));
            if (muted === '1') this.audio.muted = true;
        } catch (e) {}
    };
    AudioPlayer.prototype._persist = function () {
        try {
            localStorage.setItem('vp-volume', String(this.audio.volume));
            localStorage.setItem('vp-muted', this.audio.muted ? '1' : '0');
        } catch (e) {}
    };

    AudioPlayer.prototype._bind = function () {
        var self = this;
        var a = this.audio;

        this._on(a, 'loadedmetadata', function () { self._updateProgress(); self._syncSpeed(); });
        this._on(a, 'timeupdate', function () { self._updateProgress(); });
        this._on(a, 'progress', function () { self._updateBuffered(); });
        this._on(a, 'play', function () { self.playBtn.innerHTML = ICONS.pause; });
        this._on(a, 'pause', function () { self.playBtn.innerHTML = ICONS.play; });
        this._on(a, 'error', function () { self._showMediaError(a); });
        this._on(a, 'ratechange', function () { self._syncSpeed(); });
        this._on(a, 'volumechange', function () { self._syncVolumeUI(); });

        this._on(this.playBtn, 'click', function () { self.togglePlay(); });
        this._on(this.root.querySelector('.vp-back'), 'click', function () { self.skip(-10); });
        this._on(this.root.querySelector('.vp-fwd'), 'click', function () { self.skip(10); });
        this._on(this.muteBtn, 'click', function () { self.toggleMute(); });
        this._on(this.speedBtn, 'click', function (e) { e.stopPropagation(); self._toggleMenu(); });

        // progress: click / drag / hover
        this._on(this.progress, 'pointerdown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            self._dragging = true;
            try { self.progress.setPointerCapture(e.pointerId); } catch (err) {}
            self._seekFromEvent(e);
        });
        this._on(this.progress, 'pointermove', function (e) { self._updateHover(e); if (self._dragging) self._seekFromEvent(e); });
        this._on(this.progress, 'pointerup', function (e) {
            if (!self._dragging) return;
            self._dragging = false;
            try { self.progress.releasePointerCapture(e.pointerId); } catch (err) {}
        });
        this._on(this.progress, 'pointerleave', function () { self.tooltip.style.opacity = '0'; self.hover.style.width = '0'; });

        // volume slider
        this._on(this.volTrack, 'pointerdown', function (e) { e.preventDefault(); self._volDragging = true; try { self.volTrack.setPointerCapture(e.pointerId); } catch (err) {} self._volFromEvent(e); });
        this._on(this.volTrack, 'pointermove', function (e) { if (self._volDragging) self._volFromEvent(e); });
        this._on(this.volTrack, 'pointerup', function (e) { self._volDragging = false; try { self.volTrack.releasePointerCapture(e.pointerId); } catch (err) {} });

        // hold right button / touch long-press (on the card body, not the
        // controls/progress) → fast-forward
        this._on(this.root, 'contextmenu', function (e) { e.preventDefault(); });
        this._on(this.root, 'pointerdown', function (e) {
            var touch = e.pointerType === 'touch';
            if (e.button !== 2 && !touch) return;
            if (e.target.closest('.vp-audio-controls') || e.target.closest('.vp-progress')) return;
            e.preventDefault();
            var delay = touch ? TOUCH_LONG_MS : HOLD_DELAY;
            self._holdTimer = setTimeout(function () { self._holdTimer = null; self._engageHold(); }, delay);
        });
        var endHold = function () {
            if (self._holdTimer) { clearTimeout(self._holdTimer); self._holdTimer = null; }
            if (self._holding) self._releaseHold();
        };
        this._on(window, 'pointerup', endHold);
        this._on(this.root, 'pointercancel', endHold);
        this._on(this.root, 'pointerleave', endHold);

        // keyboard
        this._on(this.root, 'keydown', function (e) { self._onKey(e); });

        this._docClick = function (e) { if (self._menuOpen && !self.speedMenu.contains(e.target) && e.target !== self.speedBtn) self._closeMenu(); };
        this._on(document, 'click', this._docClick);
    };

    AudioPlayer.prototype.togglePlay = function () { if (this.audio.paused) this.audio.play().catch(function () {}); else this.audio.pause(); };
    AudioPlayer.prototype.skip = function (delta) {
        var d = this.audio.duration, t = this.audio.currentTime + delta;
        t = isFinite(d) ? Math.max(0, Math.min(d, t)) : Math.max(0, t);
        this.audio.currentTime = t;
    };
    AudioPlayer.prototype.setVolume = function (v) { v = Math.max(0, Math.min(1, v)); this.audio.volume = v; this.audio.muted = v === 0; this._persist(); };
    AudioPlayer.prototype.toggleMute = function () {
        this.audio.muted = !this.audio.muted;
        if (!this.audio.muted && this.audio.volume === 0) this.audio.volume = 0.5;
        this._persist();
    };

    AudioPlayer.prototype._engageHold = function () {
        this._holding = true;
        this._prevRate = this.audio.playbackRate;
        this._prevPaused = this.audio.paused;
        if (this._prevPaused) this.audio.play().catch(function () {});
        this.audio.playbackRate = this.opts.holdSpeed || HOLD_SPEED;
        this.badgeTxt.textContent = fmtRate(this.audio.playbackRate) + ' 快进中';
        this.badge.classList.add('vp-show');
    };
    AudioPlayer.prototype._releaseHold = function () {
        this._holding = false;
        this.audio.playbackRate = this._prevRate || 1;
        if (this._prevPaused) this.audio.pause();
        this.badge.classList.remove('vp-show');
    };

    AudioPlayer.prototype._seekFromEvent = function (e) {
        var rect = this.track.getBoundingClientRect();
        var ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
        ratio = Math.max(0, Math.min(1, ratio));
        var d = this.audio.duration;
        if (isFinite(d) && d > 0) this.audio.currentTime = ratio * d;
        this._updateProgress();
    };
    AudioPlayer.prototype._updateHover = function (e) {
        var rect = this.track.getBoundingClientRect();
        var ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
        ratio = Math.max(0, Math.min(1, ratio));
        var d = this.audio.duration || 0;
        this.tooltip.textContent = fmtTime(ratio * d);
        this.tooltip.style.left = (ratio * 100) + '%';
        this.tooltip.style.opacity = '1';
        this.hover.style.width = (ratio * 100) + '%';
    };
    AudioPlayer.prototype._updateProgress = function () {
        var d = this.audio.duration, c = this.audio.currentTime;
        var pct = (isFinite(d) && d > 0) ? (c / d) * 100 : 0;
        this.played.style.width = pct + '%';
        this.scrubber.style.left = pct + '%';
        this.curEl.textContent = fmtTime(c);
        this.durEl.textContent = fmtTime(d);
    };
    AudioPlayer.prototype._updateBuffered = function () {
        var d = this.audio.duration;
        if (!isFinite(d) || d <= 0 || !this.audio.buffered.length) return;
        var end = this.audio.buffered.end(this.audio.buffered.length - 1);
        this.buffered.style.width = Math.min(100, (end / d) * 100) + '%';
    };
    AudioPlayer.prototype._volFromEvent = function (e) {
        var rect = this.volTrack.getBoundingClientRect();
        this.setVolume(rect.width ? (e.clientX - rect.left) / rect.width : 0);
    };
    AudioPlayer.prototype._syncVolumeUI = function () {
        var muted = this.audio.muted || this.audio.volume === 0;
        var v = muted ? 0 : this.audio.volume;
        this.volFill.style.width = (v * 100) + '%';
        this.volKnob.style.left = (v * 100) + '%';
        this.muteBtn.innerHTML = muted ? ICONS.volMute : ICONS.volHigh;
    };
    AudioPlayer.prototype._syncSpeed = function () {
        var r = this.audio.playbackRate;
        this.speedBtn.textContent = r === 1 ? '倍速' : fmtRate(r);
        var opts = this.speedMenu.querySelectorAll('.vp-speed-opt');
        for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('vp-active', parseFloat(opts[i].dataset.speed) === r);
    };
    AudioPlayer.prototype._toggleMenu = function () { this._menuOpen ? this._closeMenu() : this._openMenu(); };
    AudioPlayer.prototype._openMenu = function () { this._menuOpen = true; this.speedMenu.classList.add('vp-open'); };
    AudioPlayer.prototype._closeMenu = function () { this._menuOpen = false; this.speedMenu.classList.remove('vp-open'); };
    AudioPlayer.prototype._onKey = function (e) {
        var k = e.key;
        if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); this.togglePlay(); }
        else if (k === 'ArrowRight') { e.preventDefault(); this.skip(5); }
        else if (k === 'l' || k === 'L') { e.preventDefault(); this.skip(10); }
        else if (k === 'ArrowLeft') { e.preventDefault(); this.skip(-5); }
        else if (k === 'j' || k === 'J') { e.preventDefault(); this.skip(-10); }
        else if (k === 'ArrowUp') { e.preventDefault(); this.setVolume(this.audio.volume + 0.1); }
        else if (k === 'ArrowDown') { e.preventDefault(); this.setVolume(this.audio.volume - 0.1); }
        else if (k === 'm' || k === 'M') { e.preventDefault(); this.toggleMute(); }
        else if (k >= '0' && k <= '9') { e.preventDefault(); var d = this.audio.duration; if (isFinite(d)) this.audio.currentTime = d * (parseInt(k, 10) / 10); }
    };
    AudioPlayer.prototype.destroy = function () {
        clearTimeout(this._holdTimer);
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            l.target.removeEventListener(l.event, l.handler, l.options);
        }
        this._listeners = [];
        try { this.audio.pause(); } catch (e) {}
        this.audio.removeAttribute('src');
        try { this.audio.load(); } catch (e) {}
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };
    AudioPlayer.create = function (container, src, opts) { return new AudioPlayer(container, src, opts); };

    global.VideoPlayer = VideoPlayer;
    global.AudioPlayer = AudioPlayer;
})(window);
