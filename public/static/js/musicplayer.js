// ============================================================================
// musicplayer.js — 全局常驻音乐播放器
//
// 与预览弹窗里的 AudioPlayer 的区别: 那个关掉弹窗就停, 这个是全局单例 ——
// 底部常驻条 + 全屏歌词页 + 播放队列, 切页面/关弹窗都不中断播放。
//
// Media Session API 让系统媒体键、锁屏与通知栏也能控制(浏览器原生支持)。
//
// 顶层 const 不进 window —— 必须显式挂 (项目既有约定)
// ============================================================================
(function (global) {
    'use strict';

    var AUDIO_RE = /^audio\//i;
    var AUDIO_EXT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma'];

    // 控件图标: 内联 SVG, 跟随 currentColor。文字符号(▶ ☰ ⤢)在不同系统字体下渲染不一
    var ICONS = {
        prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2v12H7zM17 6v12l-8-6z"/></svg>',
        next: '<svg viewBox="0 0 24 24"><path d="M15 6h2v12h-2zM7 6l8 6-8 6z"/></svg>',
        play: '<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72L19 12z"/></svg>',
        pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
        order: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
        single: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 .5V11h1v4h2z"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
        queue: '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4zm12-1v6l5-3z"/></svg>',
        expand: '<svg viewBox="0 0 24 24"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>',
        collapse: '<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
    };

    var el = {};
    var audio = null;
    var state = {
        queue: [],        // [{ path, name, title, artist, album }]
        index: -1,
        current: null,    // TrackMeta.resolve 的结果
        mode: 'order',    // order | single | shuffle
        lines: [],        // 合并后的歌词单元
        rejectedSources: null,  // 服务端返回的已拉黑来源列表(决定"其余来源也拉黑"按钮)
        lyricIndex: -2,
        lyricMode: 'both',// both | orig | trans
        rates: [0.75, 1, 1.25, 1.5, 2],
        rateIdx: 1,
        seeking: false,
    };
    var booted = false;

    // ---------------- 工具 ----------------
    function q(sel, root) { return (root || document).querySelector(sel); }
    function fmt(sec) { return global.Lyrics ? global.Lyrics.formatTime(sec) : '00:00'; }
    function isAudioEntry(e) {
        if (!e || e.is_dir) return false;
        if (e.mime && AUDIO_RE.test(e.mime)) return true;
        var ext = String(e.ext || e.name || '').split('.').pop().toLowerCase();
        return AUDIO_EXT.indexOf(ext) >= 0;
    }
    function dirname(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i === -1 ? '' : s.slice(0, i);
    }

    // ---------------- DOM ----------------
    function buildDom() {
        var wrap = document.createElement('div');
        wrap.innerHTML = [
            '<div class="mp-bar" id="mpBar" style="display:none">',
            '  <div class="mp-bar-left">',
            '    <div class="mp-cover" id="mpCover"></div>',
            '    <div class="mp-titles"><div class="mp-title" id="mpTitle"></div><div class="mp-sub" id="mpSub"></div></div>',
            '  </div>',
            '  <div class="mp-bar-center">',
            '    <div class="mp-btns">',
            '      <button class="mp-btn" data-act="mode" title="播放模式"></button>',
            '      <button class="mp-btn" data-act="prev" title="上一首">' + ICONS.prev + '</button>',
            '      <button class="mp-btn mp-play" data-act="toggle" title="播放/暂停"></button>',
            '      <button class="mp-btn" data-act="next" title="下一首">' + ICONS.next + '</button>',
            '    </div>',
            '    <div class="mp-prog">',
            '      <span class="mp-time" id="mpCur">00:00</span>',
            '      <div class="mp-track" id="mpTrack"><div class="mp-fill" id="mpFill"></div><div class="mp-knob" id="mpKnob"></div></div>',
            '      <span class="mp-time" id="mpDur">00:00</span>',
            '    </div>',
            '  </div>',
            '  <div class="mp-bar-right">',
            '    <button class="mp-btn" data-act="rate" id="mpRate">1.0x</button>',
            '    <button class="mp-btn mp-ic" data-act="queue" title="播放队列">' + ICONS.queue + '</button>',
            '    <button class="mp-btn mp-ic" data-act="expand" title="展开歌词页">' + ICONS.expand + '</button>',
            '    <input type="range" class="mp-vol" id="mpVol" min="0" max="1" step="0.01" value="1">',
            '  </div>',
            '</div>',
            '<div class="mp-full" id="mpFull" style="display:none">',
            '  <div class="mp-full-head">',
            '    <button class="mp-btn mp-ic" data-act="collapse" title="收起">' + ICONS.collapse + '</button>',
            '    <button class="mp-btn" data-act="info">歌曲信息</button>',
            '    <span class="mp-note" id="mpSource"></span>',
            '    <button class="mp-btn" data-act="reject" id="mpReject" style="display:none">歌词不对？拉黑</button>',
            '  </div>',
            '  <div class="mp-full-body">',
            '    <div class="mp-full-left">',
            '      <div class="mp-bigcover" id="mpBigCover"></div>',
            '      <div class="mp-meta-title" id="mpFtitle"></div>',
            '      <div class="mp-meta-sub" id="mpFsub"></div>',
            '      <div class="mp-full-ctrls">',
            '        <button class="mp-btn mp-ic" data-act="mode" title="播放模式"></button>',
            '        <button class="mp-btn mp-ic mp-big" data-act="prev" title="上一首">' + ICONS.prev + '</button>',
            '        <button class="mp-btn mp-ic mp-big mp-playmain" data-act="toggle" title="播放/暂停">' + ICONS.play + '</button>',
            '        <button class="mp-btn mp-ic mp-big" data-act="next" title="下一首">' + ICONS.next + '</button>',
            '      </div>',
            '    </div>',
            '    <div class="mp-full-right">',
            '      <div class="mp-modes" id="mpModes"></div>',
            '      <div class="mp-lyrics" id="mpLyrics"></div>',
            '      <div class="mp-offset">',
            '        <span>歌词偏移</span>',
            '        <button class="mp-btn" data-act="ofs-">−0.5s</button>',
            '        <span id="mpOfsVal">0ms</span>',
            '        <button class="mp-btn" data-act="ofs+">+0.5s</button>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>',
            '<div class="mp-panel" id="mpQueue" style="display:none"><div class="mp-panel-head">播放队列</div><div class="mp-panel-list" id="mpQueueList"></div></div>',
            '<div class="mp-panel mp-info" id="mpInfo" style="display:none">',
            '  <div class="mp-panel-head">歌曲信息</div>',
            '  <div class="mp-panel-body">',
            '    <label>标题<input id="mpITitle" type="text"></label>',
            '    <label>歌手<input id="mpIArtist" type="text"></label>',
            '    <label>专辑<input id="mpIAlbum" type="text"></label>',
            '    <label>歌词(可粘贴LRC)<textarea id="mpILrc" rows="6"></textarea></label>',
            '    <label>译文(可粘贴LRC)<textarea id="mpITrans" rows="4"></textarea></label>',
            '    <div class="mp-info-actions">',
            '      <button class="mp-btn" data-act="reparse">从文件名重新解析</button>',
            '      <button class="mp-btn" data-act="refetch">重新联网获取</button>',
            '      <button class="mp-btn mp-primary" data-act="saveinfo">保存</button>',
            '    </div>',
            '  </div>',
            '</div>',
        ].join('');
        document.body.appendChild(wrap);

        el.bar = q('#mpBar');
        el.cover = q('#mpCover');
        el.title = q('#mpTitle');
        el.sub = q('#mpSub');
        el.cur = q('#mpCur');
        el.dur = q('#mpDur');
        el.track = q('#mpTrack');
        el.fill = q('#mpFill');
        el.knob = q('#mpKnob');
        el.rate = q('#mpRate');
        el.vol = q('#mpVol');
        el.full = q('#mpFull');
        el.big = q('#mpBigCover');
        el.ftitle = q('#mpFtitle');
        el.fsub = q('#mpFsub');
        el.modes = q('#mpModes');
        el.lyrics = q('#mpLyrics');
        el.source = q('#mpSource');
        el.reject = q('#mpReject');
        el.ofsVal = q('#mpOfsVal');
        el.queue = q('#mpQueue');
        el.queueList = q('#mpQueueList');
        el.info = q('#mpInfo');

        audio = new Audio();
        audio.preload = 'metadata';
        audio.volume = parseFloat(localStorage.getItem('mp-volume') || '1') || 1;
        el.vol.value = String(audio.volume);

        bind();
    }

    function bind() {
        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('[data-act]') : null;
            if (!t) return;
            var act = t.getAttribute('data-act');
            if (act === 'toggle') togglePlay();
            else if (act === 'prev') prev();
            else if (act === 'next') next();
            else if (act === 'mode') cycleMode();
            else if (act === 'rate') cycleRate();
            else if (act === 'queue') togglePanel('queue');
            else if (act === 'expand') openFull();
            else if (act === 'collapse') closeFull();
            else if (act === 'info') openInfo();
            else if (act === 'saveinfo') saveInfo();
            else if (act === 'reparse') reparseFromName();
            else if (act === 'refetch') refetchLyrics();
            else if (act === 'ofs-') adjustOffset(-500);
            else if (act === 'ofs+') adjustOffset(500);
            else if (act === 'reject') rejectLyric();
            else if (act === 'unreject') unRejectLyric();
        });

        el.vol.addEventListener('input', function () {
            audio.volume = parseFloat(el.vol.value);
            try { localStorage.setItem('mp-volume', el.vol.value); } catch (e) {}
        });

        // 进度条拖拽
        var scrub = function (e) {
            if (!audio.duration) return;
            var r = el.track.getBoundingClientRect();
            var p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            audio.currentTime = p * audio.duration;
            renderProgress();
        };
        el.track.addEventListener('mousedown', function (e) { state.seeking = true; scrub(e); });
        document.addEventListener('mousemove', function (e) { if (state.seeking) scrub(e); });
        document.addEventListener('mouseup', function () { state.seeking = false; });

        audio.addEventListener('timeupdate', function () { renderProgress(); syncLyric(); });
        audio.addEventListener('loadedmetadata', function () { renderProgress(); loadLyrics(true); });
        audio.addEventListener('play', function () { renderBar(); });
        audio.addEventListener('pause', function () { renderBar(); });
        audio.addEventListener('ended', function () { if (state.mode === 'single') { audio.currentTime = 0; audio.play(); } else next(); });

        el.lyrics.addEventListener('click', function (e) {
            var row = e.target.closest ? e.target.closest('[data-t]') : null;
            if (!row) return;
            audio.currentTime = (parseInt(row.getAttribute('data-t'), 10) || 0) / 1000;
        });

        document.addEventListener('keydown', function (e) {
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if (!state.current) return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
            else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
            else if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
            else if (e.key === 'n' || e.key === 'N') next();
            else if (e.key === 'p' || e.key === 'P') prev();
        });
    }

    // ---------------- 播放控制 ----------------
    function playAt(i) {
        if (i < 0 || i >= state.queue.length) return;
        state.index = i;
        var item = state.queue[i];
        state.current = null;
        state.lines = [];
        state.lyricIndex = -2;
        el.lyrics.innerHTML = '<div class="mp-lyric-empty">加载中…</div>';
        renderBar();

        audio.src = global.API.previewUrl(item.path);
        audio.play().catch(function () { /* 自动播放被拦截时等用户点 */ });

        (global.TrackMeta ? global.TrackMeta.resolve({ path: item.path, name: item.name }) : Promise.resolve(null))
            .then(function (meta) {
                if (!meta || state.index !== i) return;      // 已经切歌了就丢弃
                state.current = meta;
                item.title = meta.title;
                item.artist = meta.artist;
                renderBar();
                renderFull();
                renderQueue();
                updateMediaSession();
                loadLyrics(true);
            });
    }

    function togglePlay() {
        if (!audio.src) return;
        if (audio.paused) audio.play(); else audio.pause();
    }
    function next() {
        if (!state.queue.length) return;
        var i;
        if (state.mode === 'shuffle') {
            i = state.queue.length === 1 ? 0 : Math.floor(Math.random() * state.queue.length);
        } else {
            i = (state.index + 1) % state.queue.length;
        }
        playAt(i);
    }
    function prev() {
        if (!state.queue.length) return;
        playAt((state.index - 1 + state.queue.length) % state.queue.length);
    }
    function cycleMode() {
        var order = ['order', 'single', 'shuffle'];
        state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
        renderBar();
    }
    function cycleRate() {
        state.rateIdx = (state.rateIdx + 1) % state.rates.length;
        audio.playbackRate = state.rates[state.rateIdx];
        el.rate.textContent = state.rates[state.rateIdx].toFixed(2).replace(/0$/, '') + 'x';
    }

    // ---------------- 歌词 ----------------
    function lyricKey() {
        var c = state.current || {};
        var d = Number.isFinite(audio.duration) ? Math.round(audio.duration) : 0;
        return (c.artist || '') + '|' + (c.title || '') + '|' + d;
    }

    // ---------------- 歌词拉黑 ----------------
    // 按钮状态由 applyLyric 后的 syncRejectBtn 决定:
    //   在线源(lrclib/lrc.cx) → "歌词不对？拉黑"   拉黑当前源, 服务端降级到下一源
    //   无歌词但有剩余源       → "其余来源也拉黑"   链上剩余源全部拉黑
    //   已全拉黑              → 按钮隐藏, 空态里给"撤销拉黑"
    function syncRejectBtn() {
        if (!el.reject) return;
        var src = state.source;
        var label;
        if (src === 'lrclib' || src === 'lrc.cx') label = '歌词不对？拉黑';
        else if (src === 'none' && state.rejectedSources && state.rejectedSources.length) label = '其余来源也拉黑';
        else label = null;
        el.reject.style.display = label ? '' : 'none';
        if (label) el.reject.textContent = label;
    }

    function rejectLyric() {
        var c = state.current;
        if (!c || !global.API) return;
        var src = state.source;
        var opts = { duration: Number.isFinite(audio.duration) ? audio.duration : 0, title: c.title || '', artist: c.artist || '' };
        var call;
        if (src === 'lrclib' || src === 'lrc.cx') {
            opts.source = src;
            call = global.API.lyricsReject(c.path, opts);
        } else {
            call = global.API.lyricsReject(c.path, Object.assign({ all: true }, opts));
        }
        call.then(function () {
            state.rejectedSources = null;
            loadLyrics(true);   // force: 绕过本地缓存, 服务端已跳过被拉黑的源
        }).catch(function () {});
    }

    function unRejectLyric() {
        var c = state.current;
        if (!c || !global.API) return;
        global.API.lyricsUnreject(c.path, {
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
            title: c.title || '', artist: c.artist || '',
        }).then(function () {
            loadLyrics(true);
        }).catch(function () {});
    }

    function applyLyric(synced, trans, roma, source) {
        var L = global.Lyrics;
        var orig = L.parse(synced);
        state.lines = L.merge(orig, L.parse(trans), L.parse(roma));
        state.source = source || 'online';
        syncRejectBtn();
        renderModes();
        renderLyrics();
        if (source === 'rejected') {
            el.lyrics.innerHTML = '<div class="mp-lyric-empty">歌词已拉黑，此曲不再联网获取<br>'
                + '<button class="mp-btn" data-act="unreject">撤销拉黑</button></div>';
        } else if (source === 'none') {
            el.lyrics.innerHTML = '<div class="mp-lyric-empty">没有找到歌词，可在「歌曲信息」里补充歌名或手动粘贴</div>';
        }
    }

    function loadLyrics(force) {
        if (!state.current) return;
        var c = state.current;
        // 1) 用户粘贴 / 内嵌歌词 —— 不用联网
        var synced = c.lrc || c.embeddedLrc;
        if (synced && global.Lyrics.hasTimestamps(synced)) {
            applyLyric(synced, c.trans, null, c.lrc ? 'manual' : 'id3');
            return;
        }
        if (!global.API) return;
        var key = lyricKey();
        var TM = global.TrackMeta;
        var dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        var fetchRemote = function () {
            return global.API.lyrics(c.path, {
                duration: dur,
                title: c.source === 'manual' ? c.title : '',
                artist: c.source === 'manual' ? c.artist : '',
            }).then(function (r) {
                state.rejectedSources = (r && r.sources) || null;
                if (!r || !r.found) {
                    if (TM) TM.cache.negativePut(key);
                    applyLyric(null, null, null, r && r.rejected ? 'rejected' : 'none');
                    return;
                }
                if (TM) TM.cache.put(key, { synced: r.synced, trans: r.trans, roma: r.roma, source: r.source, ts: Date.now() });
                applyLyric(r.synced, r.trans || c.trans, r.roma, r.source);
            }).catch(function () { applyLyric(null, null, null, 'none'); });
        };
        if (!TM) { fetchRemote(); return; }
        TM.cache.get(key).then(function (hit) {
            if (hit && !force) { applyLyric(hit.synced, hit.trans, hit.roma, hit.source || 'cache'); return; }
            return TM.cache.negative(key).then(function (neg) {
                if (neg && !force && Date.now() - neg < TM.LOCAL_TTL) { applyLyric(null, null, null, 'none'); return; }
                return fetchRemote();
            });
        });
    }

    function syncLyric() {
        if (!state.lines.length || !global.Lyrics) return;
        var t = audio.currentTime * 1000 - (state.current ? state.current.lyricOffset : 0);
        var i = global.Lyrics.indexAt(state.lines, t);
        if (i === state.lyricIndex) return;
        state.lyricIndex = i;
        var rows = el.lyrics.querySelectorAll('[data-i]');
        for (var k = 0; k < rows.length; k++) {
            rows[k].classList.toggle('active', parseInt(rows[k].getAttribute('data-i'), 10) === i);
        }
        var cur = el.lyrics.querySelector('[data-i="' + i + '"]');
        if (cur) {
            // 歌词页收起时 scrollHeight/clientHeight 都是 0, 算了也白算; 展开时 openFull 会再调一次
            if (el.full.style.display !== 'none') {
                // 居中: 当前行顶部 - 容器半高 + 行高一半。
                // 前提: .mp-lyrics 设了 position:relative, offsetTop 才是相对滚动容器而非全屏页
                var target = Math.max(0, cur.offsetTop - el.lyrics.clientHeight / 2 + (cur.offsetHeight || 0) / 2);
                if (typeof el.lyrics.scrollTo === 'function') el.lyrics.scrollTo({ top: target, behavior: 'smooth' });
                else el.lyrics.scrollTop = target;
            }
        }
    }

    function adjustOffset(delta) {
        if (!state.current) return;
        var v = Math.max(-30000, Math.min(30000, (state.current.lyricOffset || 0) + delta));
        state.current.lyricOffset = v;
        el.ofsVal.textContent = v + 'ms';
        state.lyricIndex = -2;
        syncLyric();
        // 偏移属于播放体验微调, 随手改随手存, 不打扰用户
        if (global.TrackMeta && global.API) {
            global.API.saveTrackMeta({
                path: state.current.path, title: state.current.title, artist: state.current.artist,
                album: state.current.album, lyric_offset: v, lrc: state.current.lrc, trans: state.current.trans,
            }).catch(function () {});
        }
    }

    // ---------------- 渲染 ----------------
    function renderBar() {
        var c = state.current;
        var item = state.queue[state.index];
        var title = (c && c.title) || (item && item.title) || (item && item.name) || '';
        var artist = (c && c.artist) || '';
        el.title.textContent = title;
        el.sub.textContent = artist;
        el.bar.style.display = state.queue.length ? 'flex' : 'none';
        el.cover.style.backgroundImage = c && c.coverUrl ? 'url("' + c.coverUrl + '")' : '';
        // play/mode 是动态图标, 底栏与歌词页各一处, 一起刷
        var playIc = audio.paused ? ICONS.play : ICONS.pause;
        var modeIc = state.mode === 'order' ? ICONS.order : (state.mode === 'single' ? ICONS.single : ICONS.shuffle);
        [el.bar, el.full].forEach(function (root) {
            if (!root) return;
            var t = root.querySelector('[data-act="toggle"]');
            if (t) t.innerHTML = playIc;
            var m = root.querySelector('[data-act="mode"]');
            if (m) m.innerHTML = modeIc;
        });
    }

    function renderProgress() {
        var d = Number.isFinite(audio.duration) ? audio.duration : 0;
        var p = d ? audio.currentTime / d : 0;
        el.fill.style.width = (p * 100) + '%';
        el.knob.style.left = (p * 100) + '%';
        el.cur.textContent = fmt(audio.currentTime);
        el.dur.textContent = fmt(d);
    }

    function renderFull() {
        var c = state.current;
        if (!c) return;
        el.ftitle.textContent = c.title || '';
        el.fsub.textContent = [c.artist, c.album].filter(Boolean).join(' · ');
        el.big.style.backgroundImage = c.coverUrl ? 'url("' + c.coverUrl + '")' : '';
        el.source.textContent = c.source === 'manual' ? '信息来自你的编辑'
            : (c.source === 'id3' ? '信息来自音频内嵌标签' : '信息来自文件名，可在「歌曲信息」补充');
        syncRejectBtn();
        el.ofsVal.textContent = (c.lyricOffset || 0) + 'ms';
    }

    function renderModes() {
        var hasTrans = state.lines.some(function (l) { return !!l.trans; });
        var modes = [['both', '双语'], ['orig', '仅原文']];
        if (hasTrans) modes.push(['trans', '仅译文']);
        if (!hasTrans && state.lyricMode === 'trans') state.lyricMode = 'both';
        el.modes.innerHTML = modes.map(function (m) {
            return '<button class="mp-chip' + (state.lyricMode === m[0] ? ' on' : '') + '" data-mode="' + m[0] + '">' + m[1] + '</button>';
        }).join('');
        el.modes.querySelectorAll('[data-mode]').forEach(function (b) {
            b.addEventListener('click', function () {
                state.lyricMode = b.getAttribute('data-mode');
                renderModes();
                renderLyrics();
                state.lyricIndex = -2;
                syncLyric();
            });
        });
    }

    function renderLyrics() {
        if (!state.lines.length) {
            el.lyrics.innerHTML = '<div class="mp-lyric-empty">暂无歌词</div>';
            return;
        }
        var html = state.lines.map(function (l, i) {
            var showOrig = state.lyricMode !== 'trans';
            var showTrans = state.lyricMode !== 'orig' && l.trans;
            if (state.lyricMode === 'trans' && !l.trans) return '';
            var inner = '';
            if (showOrig) inner += '<div class="mp-line">' + escapeHtml(l.text || '') + '</div>';
            if (showTrans) inner += '<div class="mp-line mp-trans">' + escapeHtml(l.trans) + '</div>';
            if (state.lyricMode === 'both' && l.roma) inner += '<div class="mp-line mp-roma">' + escapeHtml(l.roma) + '</div>';
            if (!inner) inner = '<div class="mp-line">&nbsp;</div>';
            return '<div class="mp-row" data-i="' + i + '" data-t="' + l.time + '">' + inner + '</div>';
        }).join('');
        el.lyrics.innerHTML = html;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function renderQueue() {
        el.queueList.innerHTML = state.queue.map(function (it, i) {
            return '<div class="mp-qitem' + (i === state.index ? ' on' : '') + '" data-i="' + i + '">'
                + '<span class="mp-qidx">' + (i + 1) + '</span>'
                + '<span class="mp-qname">' + escapeHtml(it.title || it.name) + '</span>'
                + '<span class="mp-qartist">' + escapeHtml(it.artist || '') + '</span></div>';
        }).join('');
        el.queueList.querySelectorAll('[data-i]').forEach(function (n) {
            n.addEventListener('click', function () { playAt(parseInt(n.getAttribute('data-i'), 10)); });
        });
    }

    function togglePanel(which) {
        var panel = which === 'queue' ? el.queue : el.info;
        var show = panel.style.display === 'none';
        el.queue.style.display = 'none';
        el.info.style.display = 'none';
        panel.style.display = show ? 'block' : 'none';
        if (which === 'queue' && show) renderQueue();
    }

    function openFull() { el.full.style.display = 'flex'; renderFull(); state.lyricIndex = -2; syncLyric(); }
    function closeFull() { el.full.style.display = 'none'; }

    // ---------------- 歌曲信息编辑 ----------------
    function openInfo() {
        if (!state.current) return;
        var c = state.current;
        q('#mpITitle').value = c.title || '';
        q('#mpIArtist').value = c.artist || '';
        q('#mpIAlbum').value = c.album || '';
        q('#mpILrc').value = c.lrc || '';
        q('#mpITrans').value = c.trans || '';
        togglePanel('info');
    }

    function saveInfo() {
        if (!state.current || !global.API) return;
        var c = state.current;
        var payload = {
            path: c.path,
            title: q('#mpITitle').value.trim(),
            artist: q('#mpIArtist').value.trim() || null,
            album: q('#mpIAlbum').value.trim() || null,
            lrc: q('#mpILrc').value || null,
            trans: q('#mpITrans').value || null,
            lyric_offset: c.lyricOffset || 0,
        };
        global.API.saveTrackMeta(payload).then(function (r) {
            var m = (r && r.meta) || payload;
            c.title = m.title; c.artist = m.artist; c.album = m.album;
            c.lrc = m.lrc; c.trans = m.trans; c.source = 'manual';
            if (global.TrackMeta) {
                global.TrackMeta.cache.del(lyricKey());       // 曲名变了, 歌词缓存作废
                global.TrackMeta.cache.metaPut(c.path, { manual: m, ts: Date.now() });
            }
            renderBar(); renderFull();
            loadLyrics(true);
            togglePanel('info');
        }).catch(function (e) {
            var msg = '保存失败：' + ((e && e.message) || '未知错误');
            if (global.Dialog && global.Dialog.alert) global.Dialog.alert(msg); else alert(msg);
        });
    }

    function reparseFromName() {
        if (!state.current || !global.TrackMeta) return;
        var p = global.TrackMeta.parseName(state.current.name);
        q('#mpITitle').value = p.title || '';
        q('#mpIArtist').value = p.artist || '';
    }

    function refetchLyrics() {
        if (!state.current || !global.TrackMeta) return;
        global.TrackMeta.cache.del(lyricKey());
        loadLyrics(true);
    }

    // ---------------- Media Session ----------------
    function updateMediaSession() {
        if (!('mediaSession' in navigator) || !state.current) return;
        var c = state.current;
        try {
            navigator.mediaSession.metadata = new window.MediaMetadata({
                title: c.title || '',
                artist: c.artist || '',
                album: c.album || '',
                artwork: c.coverUrl ? [{ src: c.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
            });
        } catch (e) { /* 部分浏览器不支持 artwork */ }
        var acts = [
            ['play', function () { audio.play(); }],
            ['pause', function () { audio.pause(); }],
            ['previoustrack', prev],
            ['nexttrack', next],
        ];
        acts.forEach(function (a) {
            try { navigator.mediaSession.setActionHandler(a[0], a[1]); } catch (e) {}
        });
    }

    // ---------------- 对外 ----------------
    function ensure() { if (!booted) { buildDom(); booted = true; } }

    // 单曲播放: 自动把同目录其它音频编成队列
    function open(path, name) {
        ensure();
        var parent = dirname(path);
        var mine = { path: path, name: name || global.TrackMeta.basename(path) };
        state.queue = [mine];
        state.index = 0;
        if (global.API) {
            global.API.listFiles(parent).then(function (r) {
                var list = ((r && r.entries) || (r && r.files) || []).filter(isAudioEntry);
                if (list.length) {
                    state.queue = list.map(function (e) {
                        return { path: (parent ? parent + '/' : '') + e.name, name: e.name };
                    });
                    var idx = state.queue.findIndex(function (it) { return it.path === path; });
                    state.index = idx >= 0 ? idx : 0;
                    if (idx < 0) state.queue.unshift(mine);
                }
                renderQueue();
                playAt(state.index);
            }).catch(function () { playAt(0); });
        } else {
            playAt(0);
        }
    }

    // 多选播放
    function playAll(entries) {
        ensure();
        var list = (entries || []).filter(isAudioEntry).map(function (e) {
            return { path: e.path, name: e.name };
        });
        if (!list.length) return;
        state.queue = list;
        playAt(0);
    }

    global.MusicPlayer = {
        open: open,
        playAll: playAll,
        isAudio: isAudioEntry,
        current: function () { return state.current; },
        audio: function () { return audio; },
    };
})(window);
