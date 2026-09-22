// Immersive image viewer (最强看图模式).
//
// Usage:  const v = ImageViewer.create(containerEl, opts); ... v.destroy();
//
// opts
//   items    : [{ src, path, name, size, mime, thumb }]   — required, gallery in order
//   index    : start index (default 0)
//   onChange : (item, index) => void   — fired after an internal prev/next switch
//   onClose  : () => void              — top-bar ✕ button
//   onDownload / onNewTab : () => void — top-bar buttons (caller decides what they do)
//
// Features
//   • Zoom: wheel zoom-to-cursor (trackpad pinch too), buttons, double-click /
//     double-tap toggles fit ↔ zoom, 1:1 actual pixels, pinch on touch.
//   • Pan: drag with mouse/finger (grab cursor), clamped to image bounds,
//     elastic swipe feedback when the image fits the viewport.
//   • Rotate ±90°, flip horizontal/vertical (screen-space), rotation-aware fit.
//   • Gallery: prev/next arrows, keyboard, bottom filmstrip with thumbnails,
//     "current / total" counter, adjacent-image preloading.
//   • Immersive chrome: auto-hides after 3s idle (cursor hides too), tap
//     toggles on touch. Info panel, background cycle (black/white/checkerboard
//     for transparency), browser fullscreen, slideshow.
//   • Keyboard: +/- zoom, 0 fit, 1 100%, ←/→ navigate, Home/End ends,
//     r/R rotate, h/v flip, f fullscreen, i info, b background, p slideshow.
//   • Loading spinner with decode(), per-image error card with retry.
//
// All chrome is always-dark (photo viewing standard) regardless of theme.
// Dependency-free, mirrors player.js conventions (IIFE + injected stylesheet).
(function (global) {
    'use strict';

    var STYLE_ID = 'iv-styles-v1';
    var IDLE_MS = 3000;            // chrome auto-hide delay
    var SLIDESHOW_MS = 4000;       // slideshow interval
    var TAP_MS = 350;              // max press duration that still counts as a tap
    var TAP_MOVE = 12;             // px of movement beyond which a press is a drag
    var DBL_MS = 350;              // max gap between two clicks of a double-click
    var SWIPE_PX = 60;             // min horizontal travel for a swipe navigation
    var FIT_UPSCALE_CAP = 3;       // never upscale tiny images beyond 3x on "fit"

    var ICONS = {
        zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
        zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
        fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
        one2one: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><text x="12" y="15.5" text-anchor="middle" font-size="8.5" fill="currentColor" stroke="none" font-family="monospace" font-weight="700">1:1</text></svg>',
        rotLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 8 3.5 11.5 7 15"/><path d="M3.5 11.5H15a5.5 5.5 0 1 1 0 11h-3"/></svg>',
        rotRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 8 20.5 11.5 17 15"/><path d="M20.5 11.5H9a5.5 5.5 0 1 0 0 11h3"/></svg>',
        flipH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3v18" stroke-dasharray="2.5 2.5"/><path d="M9 7L3 12l6 5V7z" fill="currentColor" stroke="none"/><path d="M15 7l6 5-6 5V7z"/></svg>',
        flipV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 12h18" stroke-dasharray="2.5 2.5"/><path d="M7 9l5-6 5 6H7z" fill="currentColor" stroke="none"/><path d="M7 15l5 6 5-6H7z"/></svg>',
        slide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5v-7z" fill="currentColor" stroke="none"/></svg>',
        slideStop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
        bg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.5" r="0.5" fill="currentColor"/></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        newTab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>',
        prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 5 7.5 12 14.5 19"/></svg>',
        next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9.5 5 16.5 12 9.5 19"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
    };

    var CSS = [
        '.iv-root{position:relative;width:100%;height:100%;background:#000;overflow:hidden;',
        'user-select:none;-webkit-user-select:none;touch-action:none;outline:none;-webkit-touch-callout:none;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#fff;line-height:1.4}',
        '.iv-root *{box-sizing:border-box}',
        '.iv-root.iv-pannable{cursor:grab}',
        '.iv-root.iv-dragging{cursor:grabbing}',
        '.iv-btn,.iv-arrow,.iv-thumb,.iv-zoom-label,.iv-error-actions button{cursor:pointer}',
        '.preview-image-host{flex:1;min-height:0;display:flex}',
        // Image mode reshapes the whole preview modal into a near-fullscreen dark stage
        '.preview-modal.iv-mode{width:96vw;max-width:none;height:min(96vh,100dvh);max-height:none;display:flex;flex-direction:column;overflow:hidden;background:#000;border-color:rgba(255,255,255,.09)}',
        '.preview-modal.iv-mode .modal-header{display:none}',
        '.preview-modal.iv-mode .modal-body{padding:0;flex:1;min-height:0;display:flex}',
        '@media (max-width:640px){.preview-modal.iv-mode{width:100vw;height:100dvh;border-radius:0;border:none}}',

        '.iv-stage{position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center}',
        '.iv-root.iv-bg-white .iv-stage{background:#fff}',
        '.iv-root.iv-bg-checker .iv-stage{background:repeating-conic-gradient(#2a2a2a 0% 25%, #181818 0% 50%) 50%/22px 22px}',
        '.iv-frame{position:relative;flex:none;max-width:none}',
        '.iv-frame.iv-in-l{animation:ivInL .22s ease-out}',
        '.iv-frame.iv-in-r{animation:ivInR .22s ease-out}',
        '@keyframes ivInL{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}',
        '@keyframes ivInR{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}',
        '.iv-img{display:block;max-width:none;max-height:none;-webkit-user-drag:none;will-change:transform;',
        'image-orientation:from-image;opacity:0;transition:opacity .18s}',
        '.iv-img.iv-ready{opacity:1}',
        '.iv-img.iv-spring{transition:transform .25s ease,opacity .18s}',

        // spinner
        '.iv-loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;',
        'width:44px;height:44px;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;border-radius:50%;',
        'animation:iv-spin .8s linear infinite;display:none;pointer-events:none}',
        '.iv-root.iv-loading-on .iv-loading{display:block}',
        '@keyframes iv-spin{to{transform:translate(-50%,-50%) rotate(360deg)}}',

        // error card
        '.iv-error{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3;display:none;',
        'flex-direction:column;align-items:center;gap:10px;padding:22px 28px;border-radius:12px;',
        'background:rgba(20,20,20,.92);border:1px solid rgba(255,255,255,.12);text-align:center;max-width:80vw}',
        '.iv-root.iv-error-on .iv-error{display:flex}',
        '.iv-error-title{font-size:14px;font-weight:600}',
        '.iv-error-msg{font-size:12px;color:#aaa;word-break:break-all}',
        '.iv-error-actions{display:flex;gap:8px;margin-top:4px}',
        '.iv-error-actions button{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;',
        'border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px}',
        '.iv-error-actions button:hover{background:rgba(255,255,255,.16)}',
        '.iv-error-actions button.iv-primary{background:#2f81f7;border-color:#2f81f7}',
        '.iv-error-actions button.iv-primary:hover{background:#388bfd}',
        '.iv-error-actions svg{width:14px;height:14px}',

        // transient zoom pill
        '.iv-pill{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:6;pointer-events:none;',
        'background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.14);color:#fff;padding:5px 13px;border-radius:16px;',
        'font-size:13px;font-weight:600;opacity:0;transition:opacity .2s}',
        '.iv-pill.iv-show{opacity:1}',

        // chrome pieces share hide/show behaviour
        '.iv-topbar,.iv-toolbar,.iv-arrow,.iv-strip,.iv-info{transition:opacity .25s}',
        '.iv-root.iv-chrome-hidden .iv-topbar,.iv-root.iv-chrome-hidden .iv-toolbar,',
        '.iv-root.iv-chrome-hidden .iv-arrow,.iv-root.iv-chrome-hidden .iv-strip,',
        '.iv-root.iv-chrome-hidden .iv-info{opacity:0;pointer-events:none}',
        '.iv-root.iv-chrome-hidden,.iv-root.iv-chrome-hidden .iv-stage{cursor:none}',

        // top bar
        '.iv-topbar{position:absolute;top:0;left:0;right:0;z-index:5;display:flex;align-items:center;gap:12px;',
        'padding:10px 14px;background:linear-gradient(to bottom,rgba(0,0,0,.72),rgba(0,0,0,.35) 70%,transparent)}',
        '.iv-titles{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}',
        '.iv-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.iv-sub{font-size:12px;color:rgba(255,255,255,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.iv-btn{flex:none;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);color:#fff;',
        'width:34px;height:34px;padding:7px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;',
        'transition:background .15s,transform .1s}',
        '.iv-btn:hover{background:rgba(255,255,255,.22)}',
        '.iv-btn:active{transform:scale(.92)}',
        '.iv-btn svg{width:100%;height:100%;display:block}',
        '.iv-btn.iv-danger:hover{background:rgba(220,60,60,.85);border-color:transparent}',
        '.iv-btn.iv-on{background:#2f81f7;border-color:#2f81f7}',

        // side arrows
        '.iv-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:5;width:44px;height:44px;',
        'border-radius:50%;border:none;background:rgba(0,0,0,.45);color:#fff;padding:10px;',
        'display:flex;align-items:center;justify-content:center;transition:background .15s,opacity .25s}',
        '.iv-arrow:hover{background:rgba(0,0,0,.75)}',
        '.iv-arrow svg{width:100%;height:100%}',
        '.iv-arrow[disabled]{opacity:0;pointer-events:none}',
        '.iv-prev{left:12px}.iv-next{right:12px}',

        // bottom toolbar
        '.iv-toolbar{position:absolute;left:50%;transform:translateX(-50%);bottom:86px;z-index:5;display:flex;align-items:center;gap:4px;',
        'padding:6px;border-radius:12px;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(6px)}',
        '.iv-root.iv-nostrip .iv-toolbar{bottom:14px}',
        '.iv-sep{width:1px;height:20px;background:rgba(255,255,255,.16);margin:0 3px;flex:none}',
        '.iv-zoom-label{min-width:52px;text-align:center;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;',
        'background:none;border:none;color:#fff;height:34px;border-radius:8px}',
        '.iv-zoom-label:hover{background:rgba(255,255,255,.14)}',

        // filmstrip
        '.iv-strip{position:absolute;left:0;right:0;bottom:0;z-index:5;display:flex;gap:6px;align-items:center;',
        'padding:10px 14px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;touch-action:pan-x;',
        'background:linear-gradient(to top,rgba(0,0,0,.72),transparent)}',
        '.iv-strip::-webkit-scrollbar{height:6px}',
        '.iv-strip::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:3px}',
        '.iv-root.iv-nostrip .iv-strip{display:none}',
        '.iv-thumb{flex:none;width:56px;height:42px;border-radius:6px;overflow:hidden;position:relative;',
        'background:rgba(255,255,255,.08);border:2px solid transparent;padding:0}',
        '.iv-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
        '.iv-thumb-fallback{position:absolute;inset:0;display:none;align-items:center;justify-content:center;',
        'font-size:10px;color:rgba(255,255,255,.55);text-transform:uppercase;font-weight:700}',
        '.iv-thumb.iv-err .iv-thumb-fallback{display:flex}',
        '.iv-thumb.iv-cur{border-color:#2f81f7}',
        '.iv-thumb:hover:not(.iv-cur){border-color:rgba(255,255,255,.4)}',

        // info panel
        '.iv-info{position:absolute;left:14px;bottom:86px;z-index:5;display:none;flex-direction:column;gap:5px;',
        'padding:12px 16px;border-radius:10px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.14);',
        'font-size:12.5px;max-width:min(340px,70vw);backdrop-filter:blur(6px)}',
        '.iv-root.iv-nostrip .iv-info{bottom:64px}',
        '.iv-root.iv-info-on .iv-info{display:flex}',
        '.iv-info-row{display:flex;gap:10px;min-width:0}',
        '.iv-info-k{flex:none;width:58px;color:rgba(255,255,255,.55)}',
        '.iv-info-v{min-width:0;word-break:break-all}',

        '@media (max-width:640px){',
        '.iv-toolbar{bottom:76px;gap:2px;padding:5px}',
        '.iv-btn{width:32px;height:32px;padding:6.5px}',
        '.iv-flip{display:none}',
        '.iv-info{bottom:70px;left:8px;right:8px;max-width:none}',
        '}'
    ];

    function fmtBytes(n) {
        if (!n || n <= 0) return '';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(n) / Math.log(1024));
        return (n / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }

    function ImageViewer(host, opts) {
        this.host = host;
        this.opts = opts || {};
        this.items = (this.opts.items || []).filter(function (it) { return it && it.src; });
        if (!this.items.length) { this.items = [{ src: '', name: '(empty)' }]; }
        this.index = Math.min(Math.max(0, this.opts.index || 0), this.items.length - 1);
        // transform state — scale is relative to natural pixel size
        this.scale = 1; this.tx = 0; this.ty = 0;
        this.rot = 0; this.flipH = false; this.flipV = false;
        this.fitScale = 1; this.nw = 0; this.nh = 0;
        this.bgModes = ['', 'iv-bg-white', 'iv-bg-checker'];
        this.bgIdx = 0;
        this._ptrs = new Map();
        this._ls = [];           // tracked listeners for destroy()
        this._loadSeq = 0;
        this._lastClick = 0; this._lastClickXY = [0, 0];
        this._slideshowTimer = null;
        this._idleTimer = null;
        this._pillTimer = null;
        this._dragging = false;
        this._gest = null;
        this._stripIdx = -1;

        this._injectCss();
        this._buildDom();
        this._bindEvents();

        // reshape the preview modal while alive
        this._modal = this.host.closest ? this.host.closest('.preview-modal') : null;
        if (this._modal) this._modal.classList.add('iv-mode');
        if (this.items.length < 2) this.root.classList.add('iv-nostrip');

        this._buildStrip();
        this._load(this.index, 0);
        this._wake();
    }

    ImageViewer.prototype._injectCss = function () {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS.join('');
        document.head.appendChild(s);
    };

    // ---- DOM -------------------------------------------------------------
    ImageViewer.prototype._buildDom = function () {
        var r = this.root = document.createElement('div');
        r.className = 'iv-root';
        r.innerHTML =
            '<div class="iv-stage">' +
                '<div class="iv-frame"><img class="iv-img" alt="" draggable="false" decoding="async"></div>' +
            '</div>' +
            '<div class="iv-loading"></div>' +
            '<div class="iv-error">' +
                '<div class="iv-error-title">图片加载失败</div>' +
                '<div class="iv-error-msg"></div>' +
                '<div class="iv-error-actions">' +
                    '<button type="button" class="iv-primary" data-iv-act="retry">' + ICONS.refresh + '重试</button>' +
                    '<button type="button" data-iv-act="dl">' + ICONS.download + '下载</button>' +
                '</div>' +
            '</div>' +
            '<div class="iv-pill"></div>' +
            '<div class="iv-topbar">' +
                '<div class="iv-titles">' +
                    '<div class="iv-name"></div>' +
                    '<div class="iv-sub"></div>' +
                '</div>' +
                '<button type="button" class="iv-btn" data-iv-act="dl" title="下载 (D)">' + ICONS.download + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="tab" title="新标签页打开">' + ICONS.newTab + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="fs" title="全屏 (F)">' + ICONS.fullscreen + '</button>' +
                '<button type="button" class="iv-btn iv-danger" data-iv-act="close" title="关闭 (Esc)">' + ICONS.close + '</button>' +
            '</div>' +
            '<button type="button" class="iv-arrow iv-prev" data-iv-act="prev" title="上一张 (←)">' + ICONS.prev + '</button>' +
            '<button type="button" class="iv-arrow iv-next" data-iv-act="next" title="下一张 (→)">' + ICONS.next + '</button>' +
            '<div class="iv-toolbar">' +
                '<button type="button" class="iv-btn" data-iv-act="zout" title="缩小 (-)">' + ICONS.zoomOut + '</button>' +
                '<button type="button" class="iv-zoom-label" data-iv-act="fit" title="适应窗口 (0)">100%</button>' +
                '<button type="button" class="iv-btn" data-iv-act="zin" title="放大 (+)">' + ICONS.zoomIn + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="fit" title="适应窗口 (0)">' + ICONS.fit + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="one" title="原始尺寸 1:1 (1)">' + ICONS.one2one + '</button>' +
                '<span class="iv-sep"></span>' +
                '<button type="button" class="iv-btn" data-iv-act="rotl" title="向左旋转 (R)">' + ICONS.rotLeft + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="rotr" title="向右旋转 (r)">' + ICONS.rotRight + '</button>' +
                '<button type="button" class="iv-btn iv-flip" data-iv-act="fliph" title="水平翻转 (h)">' + ICONS.flipH + '</button>' +
                '<button type="button" class="iv-btn iv-flip" data-iv-act="flipv" title="垂直翻转 (v)">' + ICONS.flipV + '</button>' +
                '<span class="iv-sep"></span>' +
                '<button type="button" class="iv-btn" data-iv-act="slide" title="幻灯片播放 (p)">' + ICONS.slide + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="bg" title="背景: 黑 / 白 / 棋盘 (b)">' + ICONS.bg + '</button>' +
                '<button type="button" class="iv-btn" data-iv-act="info" title="图片信息 (i)">' + ICONS.info + '</button>' +
            '</div>' +
            '<div class="iv-strip"></div>' +
            '<div class="iv-info"></div>';
        this.host.appendChild(r);

        this.img = r.querySelector('.iv-img');
        this.frame = r.querySelector('.iv-frame');
        this.stage = r.querySelector('.iv-stage');
        this.pill = r.querySelector('.iv-pill');
        this.elName = r.querySelector('.iv-name');
        this.elSub = r.querySelector('.iv-sub');
        this.elZoom = r.querySelector('.iv-zoom-label');
        this.elStrip = r.querySelector('.iv-strip');
        this.elInfo = r.querySelector('.iv-info');
        this.elErrMsg = r.querySelector('.iv-error-msg');
        this.btnPrev = r.querySelector('.iv-prev');
        this.btnNext = r.querySelector('.iv-next');
        this.slideBtn = r.querySelector('[data-iv-act="slide"]');
    };

    ImageViewer.prototype._on = function (target, ev, fn, opts) {
        target.addEventListener(ev, fn, opts);
        this._ls.push({ t: target, e: ev, f: fn, o: opts });
    };

    ImageViewer.prototype._bindEvents = function () {
        var self = this;

        // toolbar / topbar / arrows: delegated clicks
        this._on(this.root, 'click', function (e) {
            var btn = e.target.closest('[data-iv-act]');
            if (!btn || btn.disabled) return;
            self._act(btn.getAttribute('data-iv-act'));
        });

        // strip clicks (delegated); strip has its own touch scrolling
        this._on(this.elStrip, 'click', function (e) {
            var th = e.target.closest('.iv-thumb');
            if (th) { self._stopSlideshowOnManual(); self._setIndex(parseInt(th.dataset.idx, 10), 0); }
        });

        // wheel zoom-to-cursor (trackpad pinch arrives as ctrl+wheel);
        // over the filmstrip let the browser scroll natively instead
        this._on(this.root, 'wheel', function (e) {
            if (e.target.closest('.iv-strip')) return;
            e.preventDefault();
            if (self.root.classList.contains('iv-error-on')) return;
            self._wake();
            var dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= self.stage.clientHeight;
            var k = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0018));
            var p = self._pt(e);
            self._zoomTo(self.scale * k, p.x, p.y, true);
        }, { passive: false });

        // pointer gestures: pan / pinch / swipe / tap / double-click
        this._on(this.root, 'pointerdown', function (e) { self._pd(e); });
        this._on(this.root, 'pointermove', function (e) { self._pm(e); });
        this._on(this.root, 'pointerup', function (e) { self._pu(e); });
        this._on(this.root, 'pointercancel', function (e) { self._pc(e); });
        this._on(this.img, 'dragstart', function (e) { e.preventDefault(); });

        // mouse hover should keep chrome awake (touch pan must not)
        this._on(this.root, 'pointermove', function (e) {
            if (e.pointerType !== 'touch') self._wake();
        });

        // keyboard (document-level, like player.js)
        this._on(document, 'keydown', function (e) { self._key(e); });

        // resize / fullscreen
        this._on(window, 'resize', function () { self._onResize(); });
        this._on(document, 'fullscreenchange', function () { self._onResize(); });
    };

    ImageViewer.prototype._act = function (act) {
        switch (act) {
            case 'close': if (this.opts.onClose) this.opts.onClose(); break;
            case 'dl': if (this.opts.onDownload) this.opts.onDownload(); break;
            case 'tab': if (this.opts.onNewTab) this.opts.onNewTab(); break;
            case 'fs': this._toggleFs(); break;
            case 'zin': { var c = this._center(); this._zoomTo(this.scale * 1.25, c.x, c.y, true); break; }
            case 'zout': { var c2 = this._center(); this._zoomTo(this.scale / 1.25, c2.x, c2.y, true); break; }
            case 'fit': this._fit(true); break;
            case 'one': { var c3 = this._center(); this._zoomTo(1, c3.x, c3.y, true); break; }
            case 'rotl': this._rotate(-1); break;
            case 'rotr': this._rotate(1); break;
            case 'fliph': this.flipH = !this.flipH; this._apply(); break;
            case 'flipv': this.flipV = !this.flipV; this._apply(); break;
            case 'slide': this._toggleSlideshow(); break;
            case 'bg': this._cycleBg(); break;
            case 'info': this.root.classList.toggle('iv-info-on'); break;
            case 'prev': this._go(-1); break;
            case 'next': this._go(1); break;
            case 'retry': this._retry(); break;
        }
    };

    // ---- helpers -----------------------------------------------------------
    ImageViewer.prototype._center = function () { return { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2 }; };
    ImageViewer.prototype._pt = function (e) {
        var rc = this.stage.getBoundingClientRect();
        return { x: e.clientX - rc.left, y: e.clientY - rc.top };
    };
    ImageViewer.prototype._item = function () { return this.items[this.index]; };

    // rendered size on screen at current rotation
    ImageViewer.prototype._rSize = function (s) {
        var swap = (this.rot % 180) !== 0;
        return { w: (swap ? this.nh : this.nw) * s, h: (swap ? this.nw : this.nh) * s };
    };

    ImageViewer.prototype._clampScale = function (s) {
        var min = Math.min(0.05, this.fitScale / 4);
        var max = Math.max(20, this.fitScale * 12);
        return Math.min(max, Math.max(min, s));
    };

    ImageViewer.prototype._clampT = function (tx, ty, s) {
        var st = this._rSize(s || this.scale);
        var mx = Math.max(0, (st.w - this.stage.clientWidth) / 2);
        var my = Math.max(0, (st.h - this.stage.clientHeight) / 2);
        return { x: Math.min(mx, Math.max(-mx, tx)), y: Math.min(my, Math.max(-my, ty)) };
    };

    // ---- transform ---------------------------------------------------------
    ImageViewer.prototype._tfString = function (tx, ty) {
        var fx = this.flipH ? -1 : 1, fy = this.flipV ? -1 : 1;
        // screen-space flip: flip outermost so "horizontal" mirrors on screen
        return 'translate(' + tx + 'px,' + ty + 'px) scale(' + fx + ',' + fy + ')' +
            ' rotate(' + this.rot + 'deg) scale(' + this.scale + ')';
    };

    // zoom so that `scale` lands at stage point (px,py); pill=true shows the % pill
    ImageViewer.prototype._zoomTo = function (scale, px, py, pill) {
        if (!this.nw) return;
        var s2 = this._clampScale(scale);
        var k = s2 / this.scale;
        // keep the image point under the cursor: t' = k·t + (1-k)·d (d = cursor - center)
        this.tx = k * this.tx + (1 - k) * (px - this.stage.clientWidth / 2);
        this.ty = k * this.ty + (1 - k) * (py - this.stage.clientHeight / 2);
        this.scale = s2;
        this._apply();
        if (pill) this._showPill();
    };

    ImageViewer.prototype._fit = function (showPill) {
        if (!this.nw) return;
        var swap = (this.rot % 180) !== 0;
        var rw = (swap ? this.nh : this.nw), rh = (swap ? this.nw : this.nh);
        var s = Math.min((this.stage.clientWidth - 24) / rw, (this.stage.clientHeight - 24) / rh);
        if (s > FIT_UPSCALE_CAP) s = FIT_UPSCALE_CAP;
        this.fitScale = s;
        this.scale = s;
        this.tx = 0; this.ty = 0;
        this._apply();
        if (showPill) this._showPill();
    };

    ImageViewer.prototype._apply = function () {
        var c = this._clampT(this.tx, this.ty);
        this.tx = c.x; this.ty = c.y;
        this.img.style.transform = this._tfString(this.tx, this.ty);
        // grab cursor only when the image can actually be panned
        var rs = this._rSize(this.scale);
        var pannable = rs.w > this.stage.clientWidth + 1 || rs.h > this.stage.clientHeight + 1;
        this.root.classList.toggle('iv-pannable', pannable);
        this._syncUi();
    };

    ImageViewer.prototype._rotate = function (dir) {
        this.rot = (this.rot + 90 * dir + 360) % 360;
        // re-fit when at fit so the rotated image stays fully visible;
        // otherwise keep the zoom level and just re-clamp
        var atFit = Math.abs(this.scale - this.fitScale) < this.fitScale * 0.02;
        if (atFit) this._fit(); else this._apply();
    };

    // ---- loading -----------------------------------------------------------
    ImageViewer.prototype._load = function (idx, dir) {
        var self = this;
        this.index = idx;
        var it = this._item();
        var seq = ++this._loadSeq;
        this.rot = 0; this.flipH = false; this.flipV = false;
        this.nw = 0; this.nh = 0;
        this.scale = 1; this.tx = 0; this.ty = 0;
        this.img.classList.remove('iv-ready', 'iv-spring');
        this.root.classList.remove('iv-error-on');
        this.root.classList.add('iv-loading-on');
        this.img.style.transform = 'none';

        // enter direction animation (restart via reflow)
        this.frame.classList.remove('iv-in-l', 'iv-in-r');
        if (dir) { void this.frame.offsetWidth; this.frame.classList.add(dir > 0 ? 'iv-in-r' : 'iv-in-l'); }

        this.elName.textContent = it.name || '';
        this.elSub.textContent = this._subText();
        this._syncUi();
        // caller syncs its metadata (title/download targets) to the newly shown item
        if (this.opts.onChange) this.opts.onChange(it, idx);

        var onReady = function () {
            if (seq !== self._loadSeq) return;
            self.nw = self.img.naturalWidth || 0;
            self.nh = self.img.naturalHeight || 0;
            self.root.classList.remove('iv-loading-on');
            self.img.classList.add('iv-ready');
            self._fit();
            self._preload();
            self._fillInfo();
            self._fillStripThumb(idx);
        };
        var onError = function () {
            if (seq !== self._loadSeq) return;
            self.root.classList.remove('iv-loading-on');
            self.root.classList.add('iv-error-on');
            self.elErrMsg.textContent = (it.name || '') + (it.size ? ' · ' + fmtBytes(it.size) : '');
            self.img.classList.remove('iv-ready');
        };

        // reset src to trigger a fresh load even when the URL is unchanged (retry)
        this.img.removeAttribute('src');
        if (it.src) {
            this.img.src = it.src;
            if (typeof this.img.decode === 'function') {
                this.img.decode().then(onReady, function () {
                    if (seq !== self._loadSeq) return;
                    // decode() can reject for stale/cancelled loads — re-check reality
                    if (self.img.complete && self.img.naturalWidth > 0) onReady(); else onError();
                });
            } else {
                this.img.onload = onReady;
                this.img.onerror = onError;
            }
        } else onError();
    };

    ImageViewer.prototype._retry = function () {
        var it = this._item();
        if (!it.src) return;
        // strip any old buster and append a fresh one (broken cached responses)
        it.src = it.src.replace(/([?&])_r=\d+/g, '');
        it.src += (it.src.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now();
        this._load(this.index, 0);
    };

    ImageViewer.prototype._preload = function () {
        // neighbours ±1; browser cache makes switching near-instant
        for (var d = -1; d <= 1; d += 2) {
            var it = this.items[this.index + d];
            if (it && it.src) { var im = new Image(); im.src = it.src; }
        }
    };

    // ---- navigation ---------------------------------------------------------
    ImageViewer.prototype._go = function (delta) {
        var n = this.index + delta;
        if (n < 0 || n >= this.items.length) return;
        this._stopSlideshowOnManual();
        this._setIndex(n, delta);
    };

    ImageViewer.prototype._setIndex = function (idx, dir) {
        idx = Math.min(Math.max(0, idx), this.items.length - 1);
        if (idx === this.index && this.nw) return;
        this._load(idx, dir || 0);
    };

    // ---- chrome --------------------------------------------------------------
    ImageViewer.prototype._subText = function () {
        var it = this._item();
        var parts = [];
        if (this.items.length > 1) parts.push((this.index + 1) + ' / ' + this.items.length);
        if (it.size) parts.push(fmtBytes(it.size));
        if (it.mime) parts.push(it.mime.replace('image/', '').toUpperCase());
        return parts.join(' · ');
    };

    ImageViewer.prototype._syncUi = function () {
        this.elZoom.textContent = Math.round(this.scale * 100) + '%';
        this.elSub.textContent = this._subText();
        this.btnPrev.disabled = this.index <= 0;
        this.btnNext.disabled = this.index >= this.items.length - 1;
        if (this.root.classList.contains('iv-info-on')) this._fillInfo();
        // strip highlight + auto-scroll only when the image actually changed
        if (this._stripIdx !== this.index) {
            this._stripIdx = this.index;
            var cur = this.elStrip.querySelector('.iv-thumb.iv-cur');
            if (cur) cur.classList.remove('iv-cur');
            var th = this.elStrip.querySelector('.iv-thumb[data-idx="' + this.index + '"]');
            if (th) {
                th.classList.add('iv-cur');
                var target = th.offsetLeft - (this.elStrip.clientWidth - th.clientWidth) / 2;
                this.elStrip.scrollLeft = Math.max(0, target);
            }
        }
    };

    ImageViewer.prototype._showPill = function () {
        var self = this;
        this.pill.textContent = Math.round(this.scale * 100) + '%';
        this.pill.classList.add('iv-show');
        clearTimeout(this._pillTimer);
        this._pillTimer = setTimeout(function () { self.pill.classList.remove('iv-show'); }, 800);
    };

    ImageViewer.prototype._fillInfo = function () {
        var it = this._item();
        var rows = [];
        rows.push(['名称', it.name || '—']);
        if (this.nw) rows.push(['尺寸', this.nw + ' × ' + this.nh + ' px']);
        if (it.size) rows.push(['大小', fmtBytes(it.size)]);
        if (it.mime) rows.push(['类型', it.mime]);
        if (this.items.length > 1) rows.push(['序号', (this.index + 1) + ' / ' + this.items.length]);
        var html = '';
        for (var i = 0; i < rows.length; i++) {
            html += '<div class="iv-info-row"><span class="iv-info-k">' + rows[i][0] +
                '</span><span class="iv-info-v">' + esc(rows[i][1]) + '</span></div>';
        }
        this.elInfo.innerHTML = html;
    };

    ImageViewer.prototype._buildStrip = function () {
        if (this.items.length < 2) return;
        this.elStrip.innerHTML = '';
        for (var i = 0; i < this.items.length; i++) {
            var it = this.items[i];
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'iv-thumb';
            b.dataset.idx = i;
            b.title = it.name || '';
            var im = document.createElement('img');
            im.loading = 'lazy';
            im.alt = '';
            b.appendChild(im);
            var fb = document.createElement('div');
            var m = (it.name || '').match(/\.([a-z0-9]+)$/i);
            fb.className = 'iv-thumb-fallback';
            fb.textContent = m ? m[1] : 'IMG';
            b.appendChild(fb);
            im.onerror = function () { b.classList.add('iv-err'); im.removeAttribute('src'); };
            if (it.thumb) {
                // stagger the fetches so opening a huge folder does not fire all at once
                (function (img, url, btn) {
                    setTimeout(function () { if (!img.getAttribute('src')) img.src = url; else btn.classList.add('iv-err'); }, 60 + i * 40);
                })(im, it.thumb, b);
            } else {
                b.classList.add('iv-err');
            }
            this.elStrip.appendChild(b);
        }
    };

    // server thumbnail missing → draw one from the fully loaded image (local only)
    ImageViewer.prototype._fillStripThumb = function (idx) {
        if (this.items.length < 2 || !this.nw) return;
        var th = this.elStrip.querySelector('.iv-thumb[data-idx="' + idx + '"]');
        if (!th) return;
        var img = th.querySelector('img');
        if (!img || (img.getAttribute('src') && img.complete && img.naturalWidth)) return;
        try {
            var c = document.createElement('canvas');
            var k = Math.min(112 / this.nw, 84 / this.nh);
            c.width = Math.max(1, Math.round(this.nw * k));
            c.height = Math.max(1, Math.round(this.nh * k));
            c.getContext('2d').drawImage(this.img, 0, 0, c.width, c.height);
            img.src = c.toDataURL('image/jpeg', 0.8);
            th.classList.remove('iv-err');
        } catch (e) { /* tainted canvas etc. — fallback stays */ }
    };

    ImageViewer.prototype._cycleBg = function () {
        var cur = this.bgModes[this.bgIdx];
        if (cur) this.root.classList.remove(cur);   // mode 0 is '' (default black) — must not remove('')
        this.bgIdx = (this.bgIdx + 1) % this.bgModes.length;
        if (this.bgModes[this.bgIdx]) this.root.classList.add(this.bgModes[this.bgIdx]);
    };

    ImageViewer.prototype._toggleFs = function () {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else if (this.root.requestFullscreen) { this.root.requestFullscreen(); }
    };

    ImageViewer.prototype._toggleSlideshow = function () {
        var self = this;
        if (this._slideshowTimer) { this._stopSlideshow(); return; }
        this.slideBtn.innerHTML = ICONS.slideStop;
        this.slideBtn.classList.add('iv-on');
        this._slideshowTimer = setInterval(function () {
            var n = (self.index + 1) % self.items.length;   // wraps for endless playback
            self._setIndex(n, 1);
        }, SLIDESHOW_MS);
    };

    ImageViewer.prototype._stopSlideshow = function () {
        clearInterval(this._slideshowTimer);
        this._slideshowTimer = null;
        this.slideBtn.innerHTML = ICONS.slide;
        this.slideBtn.classList.remove('iv-on');
    };

    ImageViewer.prototype._stopSlideshowOnManual = function () {
        if (this._slideshowTimer) this._stopSlideshow();
    };

    // ---- chrome auto-hide ------------------------------------------------------
    ImageViewer.prototype._wake = function () {
        var self = this;
        this.root.classList.remove('iv-chrome-hidden');
        clearTimeout(this._idleTimer);
        // don't arm the hide timer mid-gesture
        if (this._ptrs.size > 0) return;
        this._idleTimer = setTimeout(function () {
            if (self._ptrs.size === 0) self.root.classList.add('iv-chrome-hidden');
        }, IDLE_MS);
    };

    ImageViewer.prototype._toggleChrome = function () {
        if (this.root.classList.contains('iv-chrome-hidden')) {
            this._wake();
        } else {
            this.root.classList.add('iv-chrome-hidden');
            clearTimeout(this._idleTimer);
        }
    };

    // ---- pointer gestures --------------------------------------------------------
    ImageViewer.prototype._pd = function (e) {
        if (e.button !== undefined && e.button !== 0) return;   // main button only
        if (e.target.closest('[data-iv-act],.iv-strip,.iv-info')) return;  // chrome handles its own
        if (e.pointerType !== 'touch') this._wake();
        this.root.setPointerCapture(e.pointerId);
        this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, downX: e.clientX, downY: e.clientY, t: Date.now() });
        this._dragging = true;
        this.root.classList.add('iv-dragging');
        this.img.classList.remove('iv-spring');

        if (this._ptrs.size === 1) {
            var pannable = this._rSize(this.scale).w > this.stage.clientWidth + 1 || this._rSize(this.scale).h > this.stage.clientHeight + 1;
            this._gest = { mode: pannable ? 'pan' : 'swipe', tx0: this.tx, ty0: this.ty, x0: e.clientX, y0: e.clientY, moved: false };
        } else if (this._ptrs.size === 2) {
            var pts = Array.from(this._ptrs.values());
            var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            this._gest = {
                mode: 'pinch',
                d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
                s0: this.scale,
                lastMid: mid, moved: false
            };
        }
    };

    ImageViewer.prototype._pm = function (e) {
        var p = this._ptrs.get(e.pointerId);
        if (!p || !this._gest) return;
        p.x = e.clientX; p.y = e.clientY;
        var g = this._gest;

        if (g.mode === 'pinch' && this._ptrs.size === 2) {
            var pts = Array.from(this._ptrs.values());
            var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            g.moved = true;
            this._zoomTo(g.s0 * d / g.d0, mid.x - this.stage.getBoundingClientRect().left, mid.y - this.stage.getBoundingClientRect().top, false);
            // two-finger pan on top of the pinch zoom
            var cl = this._clampT(this.tx + (mid.x - g.lastMid.x), this.ty + (mid.y - g.lastMid.y));
            this.tx = cl.x; this.ty = cl.y;
            g.lastMid = mid;
            this._apply();
        } else if (g.mode === 'pan' && this._ptrs.size === 1) {
            var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
            if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
            var cl2 = this._clampT(g.tx0 + dx, g.ty0 + dy);
            this.tx = cl2.x; this.ty = cl2.y;
            this._apply();
        } else if (g.mode === 'swipe' && this._ptrs.size === 1) {
            var dx2 = e.clientX - g.x0, dy2 = e.clientY - g.y0;
            if (Math.abs(dx2) + Math.abs(dy2) > 3) g.moved = true;
            // elastic feedback only (no clamp): visual hint that a swipe navigates
            this.tx = g.tx0 + dx2 * 0.28;
            this.ty = g.ty0 + dy2 * 0.12;
            this.img.style.transform = this._tfString(this.tx, this.ty);
        }
    };

    ImageViewer.prototype._pu = function (e) {
        if (!this._ptrs.has(e.pointerId)) return;
        var p = this._ptrs.get(e.pointerId);
        this._ptrs.delete(e.pointerId);
        try { this.root.releasePointerCapture(e.pointerId); } catch (err) {}

        if (this._ptrs.size === 1) {
            // pinch ended with one finger left on the surface → re-seed as pan
            var left = Array.from(this._ptrs.values())[0];
            this._gest = { mode: 'pan', tx0: this.tx, ty0: this.ty, x0: left.x, y0: left.y, moved: true };
            return;
        }
        if (this._ptrs.size > 1) return;

        this._dragging = false;
        this.root.classList.remove('iv-dragging');
        var g = this._gest;
        this._gest = null;
        var dt = Date.now() - p.t;
        var dist = Math.hypot(e.clientX - p.downX, e.clientY - p.downY);

        if (g && g.mode === 'swipe') {
            var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
            if (g.moved && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
                this._springBack();
                this._go(dx < 0 ? 1 : -1);   // swipe left → next
                return;
            }
            this._springBack();
        } else if (g && g.mode === 'pan') {
            this._apply();
        }
        // pinch: transforms already applied live

        if (p.type === 'touch') {
            if (dt < TAP_MS && dist < TAP_MOVE && (!g || !g.moved)) this._toggleChrome();
        } else if (dt < 600 && dist < 6) {
            // manual double-click detection (desktop)
            var now = Date.now();
            var dxy = Math.hypot(e.clientX - this._lastClickXY[0], e.clientY - this._lastClickXY[1]);
            if (now - this._lastClick < DBL_MS && dxy < 12) {
                this._lastClick = 0;
                this._dblZoom(this._pt(e));
            } else {
                this._lastClick = now;
                this._lastClickXY = [e.clientX, e.clientY];
            }
        }
        if (p.type !== 'touch') this._wake();
    };

    ImageViewer.prototype._pc = function (e) {
        this._ptrs.delete(e.pointerId);
        if (this._ptrs.size === 0) {
            this._dragging = false;
            this.root.classList.remove('iv-dragging');
            this._gest = null;
            this._springBack();
        }
    };

    // smooth return from elastic swipe offset
    ImageViewer.prototype._springBack = function () {
        this.img.classList.add('iv-spring');
        this._apply();
    };

    ImageViewer.prototype._dblZoom = function (p) {
        var atFit = Math.abs(this.scale - this.fitScale) < this.fitScale * 0.02;
        if (atFit || this.scale < this.fitScale) {
            var target = Math.min(Math.max(this.fitScale * 2.5, 1), this._clampScale(Infinity));
            this._zoomTo(target, p.x, p.y, true);
        } else {
            this._fit(true);
        }
    };

    // ---- keyboard ---------------------------------------------------------------
    ImageViewer.prototype._key = function (e) {
        if (!this.root.isConnected) return;
        var t = e.target;
        if (t && t.closest && t.closest('input,textarea,select,[contenteditable="true"]')) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        this._wake();
        var k = e.key;
        var handled = true;
        switch (k) {
            case 'ArrowLeft': this._go(-1); break;
            case 'ArrowRight': this._go(1); break;
            case 'Home': if (this.items.length > 1) { this._stopSlideshowOnManual(); this._setIndex(0, -1); } break;
            case 'End': if (this.items.length > 1) { this._stopSlideshowOnManual(); this._setIndex(this.items.length - 1, 1); } break;
            case '+': case '=': { var c = this._center(); this._zoomTo(this.scale * 1.25, c.x, c.y, true); break; }
            case '-': case '_': { var c2 = this._center(); this._zoomTo(this.scale / 1.25, c2.x, c2.y, true); break; }
            case '0': this._fit(true); break;
            case '1': { var c3 = this._center(); this._zoomTo(1, c3.x, c3.y, true); break; }
            case 'r': case 'R': this._rotate(k === 'R' ? -1 : 1); break;
            case 'h': case 'H': this.flipH = !this.flipH; this._apply(); break;
            case 'v': case 'V': this.flipV = !this.flipV; this._apply(); break;
            case 'f': case 'F': this._toggleFs(); break;
            case 'i': case 'I': this.root.classList.toggle('iv-info-on'); break;
            case 'b': case 'B': this._cycleBg(); break;
            case 'p': case 'P': this._toggleSlideshow(); break;
            case 'd': case 'D': if (this.opts.onDownload) this.opts.onDownload(); break;
            default: handled = false;
        }
        if (handled) e.preventDefault();
    };

    ImageViewer.prototype._onResize = function () {
        if (!this.nw) return;
        var atFit = Math.abs(this.scale - this.fitScale) < this.fitScale * 0.02;
        if (atFit) this._fit(); else this._apply();
    };

    // ---- teardown ------------------------------------------------------------------
    ImageViewer.prototype.destroy = function () {
        this._stopSlideshow();
        clearTimeout(this._idleTimer);
        clearTimeout(this._pillTimer);
        for (var i = 0; i < this._ls.length; i++) {
            var l = this._ls[i];
            l.t.removeEventListener(l.e, l.f, l.o);
        }
        this._ls = [];
        this._ptrs.clear();
        if (this._modal) this._modal.classList.remove('iv-mode');
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    };

    ImageViewer.create = function (container, opts) { return new ImageViewer(container, opts); };

    global.ImageViewer = ImageViewer;
})(window);
