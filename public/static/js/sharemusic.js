// ============================================================================
// sharemusic.js — 分享页的全局音乐播放器 (只读版)
//
// 为什么单独一份而不复用 musicplayer.js:
//   管理页那份深度依赖登录态 —— window.API(带 JWT)、TrackMeta(可写 D1)、IndexedDB 缓存、
//   StorageUI/队列来自文件管理器。分享页只有无登录的 /s/<id> 通道, 强行复用会把整套后端依赖搬过来。
//   所以这里只做"播放"这一件事, 但视觉与交互复用同一套 .mp-* 样式(style.css)与 window.Lyrics 解析,
//   观感与管理页一致, 包括 ≤640px 的移动端布局。
//
// 只读边界: 不能改歌曲信息、不能拉黑歌词。歌词偏移/字号只是本地显示偏好(不落库)。
//
// 数据来源: /s/<id>?inline=1 播放、?lyrics=1 取歌词、?cover=1 取封面 —— 都沿用分享链接自身的
// 鉴权(密码/过期), 歌词与服务端 /api/lyrics 读的是同一份 D1 数据。
//
// 顶层 const 不进 window —— 必须显式挂 (项目既有约定)
// ============================================================================
(function (global) {
    'use strict';

    var AUDIO_RE = /^audio\//i;
    var AUDIO_EXT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape', 'aiff', 'amr'];

    var ICONS = {
        prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2v12H7zM17 6v12l-8-6z"/></svg>',
        next: '<svg viewBox="0 0 24 24"><path d="M15 6h2v12h-2zM7 6l8 6-8 6z"/></svg>',
        play: '<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72L19 12z"/></svg>',
        pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
        queue: '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 4h12v2H4zm0 4h8v2H4zm12-1v6l5-3z"/></svg>',
        expand: '<svg viewBox="0 0 24 24"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>',
        collapse: '<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6 6z"/></svg>',
    };

    var cfg = null;          // { shareId, subPath() }  —— 鉴权靠签名 Cookie, 不再需要 password()
    var audio = null;
    var el = {};
    var booted = false;
    var fonts = 15, ofs = 0;

    var state = {
        queue: [],           // [{ name, subPath }]
        index: -1,
        cur: null,           // { name, subPath, title, artist, coverUrl }
        lines: [],           // [{ time, text, trans, roma }]
        timed: true,         // 纯文本歌词(无时间轴)时为 false, 不参与滚动高亮
        lyricsOn: true,
        lyricIndex: -2,
        dragging: false,
        gen: 0,              // 播放代次: 异步回调据此判断结果是否已过期
        origLrc: '',         // 当前曲的纯原文(带时间戳), 供「复制歌词」使用
    };

    // ---------------- 工具 ----------------
    function q(sel, root) { return (root || document).querySelector(sel); }
    function fmt(sec) { return global.Lyrics ? global.Lyrics.formatTime(sec) : '00:00'; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // 分享页读不到 track_meta, 先按文件名粗解析 "歌手 - 歌名"; 服务端返回的 title/artist 到了会覆盖
    function parseName(name) {
        var s = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
        s = s.replace(/^\s*\d{1,3}\s*[.\-_、\s]\s*/, '');
        var i = s.indexOf(' - ');
        if (i > 0) return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() };
        return { artist: '', title: s };
    }

    function isAudioEntry(e) {
        if (!e || e.is_dir) return false;
        if (e.mime && AUDIO_RE.test(e.mime)) return true;
        var ext = String(e.ext || e.name || '').split('.').pop().toLowerCase();
        return AUDIO_EXT.indexOf(ext) >= 0;
    }

    // ---------------- URL 构造 ----------------
    // 分享鉴权靠解锁时下发的签名 Cookie (fm_s_<id>, HttpOnly), 浏览器会自动带上。
    // 密码不再进 URL —— 那会落进访问日志、浏览器历史和"复制链接"里, 而分享密码无法更换。
    function withAuth(url, obj) {
        var parts = [];
        for (var k in obj) {
            if (obj[k] === undefined || obj[k] === null || obj[k] === '') continue;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
        }
        return url + (url.indexOf('?') < 0 ? '?' : '&') + parts.join('&');
    }
    function base() { return '/s/' + cfg.shareId; }
    function mediaUrl(item) { return withAuth(base(), { inline: '1', name: item.name, sub_path: item.subPath }); }
    function lyricsUrl(item, duration) {
        return withAuth(base(), { lyrics: '1', name: item.name, sub_path: item.subPath, duration: duration ? Math.round(duration) : '' });
    }
    function coverUrl(item) { return withAuth(base(), { cover: '1', name: item.name, sub_path: item.subPath }); }

    // ---------------- DOM ----------------
    function buildDom() {
        var wrap = document.createElement('div');
        wrap.innerHTML = [
            '<div class="mp-bar" id="smBar" style="display:none">',
            '  <div class="mp-bar-left">',
            '    <div class="mp-cover" id="smCover"></div>',
            '    <div class="mp-titles"><div class="mp-title" id="smTitle"></div><div class="mp-sub" id="smSub"></div></div>',
            '  </div>',
            '  <div class="mp-bar-center">',
            '    <div class="mp-btns">',
            '      <button class="mp-btn" data-act="prev" title="上一首">' + ICONS.prev + '</button>',
            '      <button class="mp-btn mp-play" data-act="toggle" title="播放/暂停">' + ICONS.play + '</button>',
            '      <button class="mp-btn" data-act="next" title="下一首">' + ICONS.next + '</button>',
            '    </div>',
            '    <div class="mp-prog">',
            '      <span class="mp-time" id="smCur">00:00</span>',
            '      <div class="mp-track" id="smTrack"><div class="mp-fill" id="smFill"></div><div class="mp-knob" id="smKnob"></div></div>',
            '      <span class="mp-time" id="smDur">00:00</span>',
            '    </div>',
            '  </div>',
            '  <div class="mp-bar-right">',
            '    <button class="mp-btn mp-ic" data-act="queue" title="播放列表">' + ICONS.queue + '</button>',
            '    <button class="mp-btn mp-ic" data-act="expand" title="展开歌词页">' + ICONS.expand + '</button>',
            '    <input type="range" class="mp-vol" id="smVol" min="0" max="1" step="0.01" value="1">',
            '  </div>',
            '</div>',
            '<div class="mp-full" id="smFull" style="display:none">',
            '  <div class="mp-full-head">',
            '    <button class="mp-btn mp-ic" data-act="collapse" title="收起">' + ICONS.collapse + '</button>',
            // 全屏页盖住了底栏, 所以列表入口这里也要有一个
            '    <button class="mp-btn mp-ic" data-act="queue" title="播放列表">' + ICONS.queue + '</button>',
            '    <button class="mp-btn" data-act="copy" id="smCopy" style="display:none" title="复制带时间戳的原文歌词">复制歌词</button>',
            '    <span class="mp-note" id="smSource"></span>',
            '  </div>',
            '  <div class="mp-full-body">',
            '    <div class="mp-full-left">',
            '      <div class="mp-bigcover" id="smBigCover"></div>',
            '      <div class="mp-meta-title" id="smFtitle"></div>',
            '      <div class="mp-meta-sub" id="smFsub"></div>',
            '      <div class="mp-full-ctrls">',
            '        <button class="mp-btn mp-ic mp-big" data-act="prev" title="上一首">' + ICONS.prev + '</button>',
            '        <button class="mp-btn mp-ic mp-big mp-playmain" data-act="toggle" title="播放/暂停">' + ICONS.play + '</button>',
            '        <button class="mp-btn mp-ic mp-big" data-act="next" title="下一首">' + ICONS.next + '</button>',
            '      </div>',
            '    </div>',
            '    <div class="mp-full-right">',
            '      <div class="mp-lyrics" id="smLyrics"></div>',
            '      <div class="mp-offset">',
            '        <span>歌词偏移</span>',
            '        <button class="mp-btn" data-act="ofs-">−0.5s</button>',
            '        <span id="smOfsVal">0ms</span>',
            '        <button class="mp-btn" data-act="ofs+">+0.5s</button>',
            '        <span class="mp-ofs-gap"></span>',
            '        <span class="mp-ofs-label">字号</span>',
            '        <button class="mp-btn" data-act="font-" title="缩小歌词">T−</button>',
            '        <span id="smFontVal">15px</span>',
            '        <button class="mp-btn" data-act="font+" title="放大歌词">T+</button>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>',
            '<div class="mp-panel" id="smQueue" style="display:none"><div class="mp-panel-head"><span>播放列表</span>'
            + '<button class="mp-btn mp-clear" data-act="clear" title="清空播放列表并关闭播放器">清空</button></div>'
            + '<div class="mp-panel-list" id="smQueueList"></div></div>',
        ].join('');
        while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

        // 占位块: 高度跟随 --mp-bar-h, 给 fixed 底栏让出文档流空间(见 setBarSpace 注释)
        el.dock = document.createElement('div');
        el.dock.className = 'mp-dock';
        el.dock.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el.dock);

        el.bar = q('#smBar'); el.full = q('#smFull'); el.qpanel = q('#smQueue');
        el.cover = q('#smCover'); el.bigcover = q('#smBigCover');
        el.title = q('#smTitle'); el.sub = q('#smSub');
        el.ftitle = q('#smFtitle'); el.fsub = q('#smFsub');
        el.lyrics = q('#smLyrics'); el.source = q('#smSource');
        el.copy = q('#smCopy');
        el.cur = q('#smCur'); el.dur = q('#smDur'); el.fill = q('#smFill'); el.knob = q('#smKnob');
        el.track = q('#smTrack'); el.vol = q('#smVol'); el.ofsVal = q('#smOfsVal'); el.fontVal = q('#smFontVal');
        el.qlist = q('#smQueueList');
    }

    // ---------------- 歌词 ----------------
    function renderLyrics() {
        if (!state.lyricsOn) { el.lyrics.innerHTML = '<div class="mp-lyric-empty">歌词功能未开启</div>'; return; }
        var lines = state.lines;
        if (!lines.length) { el.lyrics.innerHTML = '<div class="mp-lyric-empty">没有找到歌词</div>'; return; }
        var html = '';
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            // 原文为空时不占位(分享者只填了译文的情形), 否则每行译文上方会多出一条空行
            html += '<div class="mp-row" data-i="' + i + '">'
                + (l.text ? '<div class="mp-line">' + esc(l.text) + '</div>' : '')
                + (l.trans ? '<div class="mp-trans">' + esc(l.trans) + '</div>' : '')
                + (l.roma ? '<div class="mp-roma">' + esc(l.roma) + '</div>' : '')
                + '</div>';
        }
        el.lyrics.innerHTML = html;
        if (state.timed) bindRowSeek();
        state.lyricIndex = -2;
        syncLyric(true);
    }

    // 点歌词行跳到对应时间点
    function bindRowSeek() {
        var rows = el.lyrics.querySelectorAll('[data-i]');
        for (var i = 0; i < rows.length; i++) {
            (function (row) {
                row.onclick = function () {
                    var line = state.lines[parseInt(row.getAttribute('data-i'), 10)];
                    if (!line) return;
                    try { audio.currentTime = Math.max(0, (line.time + ofs) / 1000); } catch (e) {}
                    state.lyricIndex = -2;
                    syncLyric(true);
                };
            })(rows[i]);
        }
    }

    function syncLyric(force) {
        if (!state.timed || !state.lines.length || !global.Lyrics) return;
        var i = global.Lyrics.indexAt(state.lines, audio.currentTime * 1000 - ofs);
        if (i === state.lyricIndex && !force) return;
        state.lyricIndex = i;
        var rows = el.lyrics.querySelectorAll('[data-i]');
        for (var k = 0; k < rows.length; k++) {
            rows[k].classList.toggle('active', parseInt(rows[k].getAttribute('data-i'), 10) === i);
        }
        var cur = el.lyrics.querySelector('[data-i="' + i + '"]');
        // 歌词页收起时容器高度为 0, 算了也白算; 展开时 openFull 会再调一次
        if (cur && el.full.style.display !== 'none') {
            // 前提: .mp-lyrics 有 position:relative, offsetTop 才是相对滚动容器而非全屏页
            var target = Math.max(0, cur.offsetTop - el.lyrics.clientHeight / 2 + (cur.offsetHeight || 0) / 2);
            if (typeof el.lyrics.scrollTo === 'function') el.lyrics.scrollTo({ top: target, behavior: 'smooth' });
            else el.lyrics.scrollTop = target;
        }
    }

    function loadLyrics(item, gen) {
        var dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        return fetch(lyricsUrl(item, dur)).then(function (r) { return r.json(); }).then(function (d) {
            if (gen !== state.gen) return;                     // 已经切歌, 丢弃
            d = d || {};
            state.lyricsOn = d.reason !== 'disabled';
            // 服务端解析出的 title/artist 比前端文件名解析准, 用它刷新显示
            var title = d.title || (state.cur && state.cur.title) || '';
            var artist = d.artist || (state.cur && state.cur.artist) || '';
            if (state.cur && (d.title || d.artist)) {
                state.cur.title = title;
                state.cur.artist = artist;
                renderTitles();
            }
            el.source.textContent = d.source === 'manual' ? '歌词由分享者提供'
                : (d.found ? ('歌词来源: ' + (d.source || '在线')) : (d.rejected ? '歌词已停用' : ''));

            var L = global.Lyrics;
            // 纯原文(带时间戳)单独留一份给「复制歌词」——复制给外部大模型翻译的必须是
            // 纯原文, 不能是 state.lines(经过显示模式过滤, 且混着译文)。
            state.origLrc = (d.found && d.synced && L && L.hasTimestamps(d.synced)) ? d.synced : '';
            if (d.found && d.synced && L) {
                state.timed = L.hasTimestamps(d.synced);
                state.lines = state.timed ? L.merge(L.parse(d.synced), L.parse(d.trans), L.parse(d.roma))
                    : L.parse(d.synced).map(function (l) { return { time: -1, text: l.text, trans: null, roma: null }; });
                if (!state.lines.length) {
                    // 有译文但原文只有纯文本时, 直接把纯文本按行铺开
                    state.lines = String(d.synced).split(/\r?\n/).filter(function (s) { return s.trim(); })
                        .map(function (s) { return { time: -1, text: s, trans: null, roma: null }; });
                    state.timed = false;
                }
            } else if (d.found && d.trans && L) {
                // 手填了译文但联网没拿到原文(源头没这首歌/全被拉黑): 以译文为骨架,
                // 否则界面会没有任何歌词。有原文时走上面分支, 译文是叠加在原文上的, 不会吃掉原文。
                state.lines = L.transOnly ? L.transOnly(d.trans) : [];
                state.timed = state.lines.length ? state.lines[0].time >= 0 : true;
            } else if (d.found && d.plain) {
                state.timed = false;
                state.lines = String(d.plain).split(/\r?\n/).filter(function (s) { return s.trim(); })
                    .map(function (s) { return { time: -1, text: s, trans: null, roma: null }; });
            } else {
                state.timed = true;
                state.lines = [];
            }
            renderLyrics();
            syncCopyBtn();
        }).catch(function () {
            if (gen !== state.gen) return;
            state.lines = [];
            state.origLrc = '';
            renderLyrics();
            syncCopyBtn();
        });
    }

    // 「复制歌词」只在有带时间轴原文时出现(分享页为只读: 不提供 AI 翻译, 避免无鉴权通道消耗 API 额度)
    function syncCopyBtn() {
        if (!el.copy) return;
        el.copy.style.display = (state.origLrc && state.origLrc.trim()) ? '' : 'none';
    }

    function copyLyrics() {
        var src = (state.origLrc || '').trim();
        if (!src) { if (global.Dialog) Dialog.alert('这首歌没有带时间轴的原文歌词'); return; }
        // 同管理页: 复制内容自带翻译指令, 模型回复可整段粘回译文框
        var text = (global.Lyrics && global.Lyrics.copyPrompt ? global.Lyrics.copyPrompt + '\n' : '') + src;
        var done = function (ok) {
            if (global.Dialog) Dialog.alert(ok ? '已复制歌词与翻译指令，粘贴到网页版大模型即可翻译' : '复制失败，请手动选择歌词复制');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        } else {
            done(fallbackCopy(text));
        }
    }

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    // ---------------- 渲染 ----------------
    function renderTitles() {
        var c = state.cur;
        if (!c) return;
        var title = c.title || c.name;
        var artist = c.artist || '';
        el.title.textContent = title;
        el.sub.textContent = artist;
        el.ftitle.textContent = title;
        el.fsub.textContent = artist;
    }

    function renderCover() {
        var c = state.cur;
        var url = c && c.coverUrl ? 'url("' + c.coverUrl + '")' : '';
        el.cover.style.backgroundImage = url;
        el.bigcover.style.backgroundImage = url;
    }

    function renderQueue() {
        var html = '';
        for (var i = 0; i < state.queue.length; i++) {
            var p = parseName(state.queue[i].name);
            html += '<div class="mp-qitem' + (i === state.index ? ' on' : '') + '" data-qi="' + i + '">'
                + '<span class="mp-qidx">' + (i + 1) + '</span>'
                + '<span class="mp-qname">' + esc(p.title) + '</span>'
                + (p.artist ? '<span class="mp-qartist">' + esc(p.artist) + '</span>' : '')
                + '</div>';
        }
        el.qlist.innerHTML = html || '<div class="mp-lyric-empty">列表为空</div>';
        var items = el.qlist.querySelectorAll('[data-qi]');
        for (var k = 0; k < items.length; k++) {
            (function (node) {
                node.onclick = function () {
                    var idx = parseInt(node.getAttribute('data-qi'), 10);
                    toggleQueue(false);
                    if (idx !== state.index) playAt(idx);
                };
            })(items[k]);
        }
    }

    function renderPlayIcons() {
        var ic = audio.paused ? ICONS.play : ICONS.pause;
        [el.bar, el.full].forEach(function (root) {
            var b = root && root.querySelector('[data-act="toggle"]');
            if (b) b.innerHTML = ic;
        });
    }

    function renderProgress() {
        var d = Number.isFinite(audio.duration) ? audio.duration : 0;
        var c = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        var ratio = d > 0 ? c / d : 0;
        el.fill.style.width = (ratio * 100) + '%';
        el.knob.style.left = (ratio * 100) + '%';
        if (!state.dragging) el.cur.textContent = fmt(c);
        el.dur.textContent = d > 0 ? fmt(d) : '--:--';
    }

    // 底栏是 fixed 定位, 不占文档流: 把实际高度写进 --mp-bar-h, 由 body 末尾的 .mp-dock
    // 占位块按这个高度撑出空间(见 buildDom), 否则会盖住分享页最后一行内容。
    // 高度会随窄屏换行/字号变化, 所以交给 ResizeObserver 重算, 不是一次性快照。
    var lastBarH = -1;   // 高度没变就不重复写, 顺带杜绝 ResizeObserver 自激
    function setBarSpace() {
        var h = el.bar.style.display === 'none' ? 0 : (el.bar.offsetHeight || 0);
        if (h === lastBarH) return;
        lastBarH = h;
        document.documentElement.style.setProperty('--mp-bar-h', h + 'px');
        document.body.classList.toggle('mp-on', h > 0);
    }
    function showBar(on) {
        el.bar.style.display = on ? 'flex' : 'none';
        setBarSpace();
    }

    function openFull(on) {
        // 必须用 flex(与样式表一致): 用 block 会打断高度链, 歌词区就不可滚了
        el.full.style.display = on ? 'flex' : 'none';
        if (on) { state.lyricIndex = -2; syncLyric(true); }
    }

    function toggleQueue(on) {
        el.qpanel.style.display = on ? 'block' : 'none';
        if (on) renderQueue();
    }

    // 清空播放列表: 停止播放并彻底收起播放器(底栏/歌词页/列表都消失, 回到分享页原样)
    function clearQueue() {
        state.gen++;                 // 让在途的歌词/封面回调失效
        state.queue = [];
        state.index = -1;
        state.cur = null;
        state.lines = [];
        state.origLrc = '';
        syncCopyBtn();
        state.timed = true;
        state.lyricIndex = -2;
        try { audio.pause(); } catch (e) {}
        try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
        el.cover.style.backgroundImage = '';
        el.bigcover.style.backgroundImage = '';
        el.lyrics.innerHTML = '';
        toggleQueue(false);
        openFull(false);
        showBar(false);
        renderPlayIcons();
    }

    function applyFont(px) {
        fonts = Math.min(30, Math.max(11, px));
        el.lyrics.style.fontSize = fonts + 'px';
        el.fontVal.textContent = fonts + 'px';
        // 与管理页共用同一个键: 分享页调过的字号, 回到管理页也是这个字号
        try { localStorage.setItem('mp-lyric-font', String(fonts)); } catch (e) {}
    }

    function adjustOffset(delta) {
        ofs = Math.max(-30000, Math.min(30000, ofs + delta));
        el.ofsVal.textContent = ofs + 'ms';
        state.lyricIndex = -2;
        syncLyric(true);
    }

    // ---------------- 播放 ----------------
    function playAt(idx) {
        if (idx < 0 || idx >= state.queue.length) return;
        var item = state.queue[idx];
        var gen = ++state.gen;
        state.index = idx;
        var p = parseName(item.name);
        state.cur = { name: item.name, subPath: item.subPath, title: p.title, artist: p.artist, coverUrl: null };
        state.lines = [];
        state.origLrc = '';       // 必须先清: 否则新歌在新歌词到达前, 「复制歌词」给的是上一首的
        syncCopyBtn();
        state.timed = true;
        state.lyricIndex = -3;
        ofs = 0;
        el.ofsVal.textContent = '0ms';
        el.source.textContent = '';
        showBar(true);
        renderTitles();
        renderCover();
        renderPlayIcons();
        renderProgress();
        el.lyrics.innerHTML = '<div class="mp-lyric-empty">歌词加载中…</div>';
        if (el.qpanel.style.display !== 'none') renderQueue();

        audio.src = mediaUrl(item);
        var started = audio.play();
        if (started && started.catch) started.catch(function () { renderPlayIcons(); });

        // 时长是歌词匹配质量的关键(上游按 artist+title+duration 精确匹配): 等元数据最多 2.5s,
        // 拿不到就先按没有时长请求 —— 不让歌词卡住播放
        var sent = false;
        var send = function () {
            if (sent || gen !== state.gen) return;
            sent = true;
            loadLyrics(item, gen);
            fetch(coverUrl(item)).then(function (r) { return r.json(); }).then(function (d) {
                if (gen !== state.gen) return;
                if (d && d.found && d.url && state.cur) { state.cur.coverUrl = d.url; renderCover(); }
            }).catch(function () {});
        };
        var onMeta = function () { audio.removeEventListener('loadedmetadata', onMeta); send(); };
        audio.addEventListener('loadedmetadata', onMeta);
        setTimeout(send, 2500);
    }

    function togglePlay() {
        if (!state.cur) return;
        if (audio.paused) audio.play().catch(function () {}); else audio.pause();
    }

    function step(delta) {
        if (!state.queue.length) return;
        if (state.queue.length === 1) { playAt(0); return; }
        playAt((state.index + delta + state.queue.length) % state.queue.length);
    }

    function bindSeek() {
        function ratioFrom(e) {
            var r = el.track.getBoundingClientRect();
            var x = (e.clientX !== undefined ? e.clientX : 0) - r.left;
            return Math.max(0, Math.min(1, r.width ? x / r.width : 0));
        }
        function paint(ratio) {
            el.fill.style.width = (ratio * 100) + '%';
            el.knob.style.left = (ratio * 100) + '%';
            el.cur.textContent = fmt(ratio * (Number.isFinite(audio.duration) ? audio.duration : 0));
        }
        el.track.addEventListener('pointerdown', function (e) {
            if (!state.cur) return;
            state.dragging = true;
            if (el.track.setPointerCapture) el.track.setPointerCapture(e.pointerId);
            paint(ratioFrom(e));
        });
        el.track.addEventListener('pointermove', function (e) { if (state.dragging) paint(ratioFrom(e)); });
        var end = function (e) {
            if (!state.dragging) return;
            state.dragging = false;
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                audio.currentTime = ratioFrom(e) * audio.duration;
                state.lyricIndex = -2;
                syncLyric(true);
            }
            renderProgress();
        };
        el.track.addEventListener('pointerup', end);
        el.track.addEventListener('pointercancel', function () { state.dragging = false; });
    }

    function bindActs() {
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
            // 播放列表面板也是播放器的一部分(它挂在 body 上, 不在底栏/歌词页里)
            var inPlayer = btn && ((el.bar && el.bar.contains(btn)) || (el.full && el.full.contains(btn))
                || (el.qpanel && el.qpanel.contains(btn)));
            var act = inPlayer ? btn.getAttribute('data-act') : null;
            // 点播放列表/底栏之外的地方 → 收起播放列表
            if (el.qpanel.style.display !== 'none' && act !== 'queue' && !el.qpanel.contains(e.target)) toggleQueue(false);
            if (!act) return;
            if (act === 'toggle') togglePlay();
            else if (act === 'prev') step(-1);
            else if (act === 'next') step(1);
            else if (act === 'expand') openFull(true);
            else if (act === 'collapse') openFull(false);
            else if (act === 'queue') toggleQueue(el.qpanel.style.display === 'none');
            else if (act === 'clear') clearQueue();
            else if (act === 'font-') applyFont(fonts - 1);
            else if (act === 'font+') applyFont(fonts + 1);
            else if (act === 'ofs-') adjustOffset(-500);
            else if (act === 'ofs+') adjustOffset(500);
            else if (act === 'copy') copyLyrics();
        });

        document.addEventListener('keydown', function (e) {
            // 可编辑控件里不能抢键(输入框/文本域/下拉/富文本)
            var tag = ((e.target && e.target.tagName) || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            if (e.target && e.target.closest && e.target.closest('[contenteditable="true"]')) return;
            if (e.key === 'Escape') {
                if (el.qpanel.style.display !== 'none') toggleQueue(false);
                else if (el.full.style.display !== 'none') openFull(false);
            } else if (e.key === ' ' && state.cur) { e.preventDefault(); togglePlay(); }
        });

        el.vol.addEventListener('input', function () { audio.volume = parseFloat(el.vol.value); });
    }

    function bindAudio() {
        audio.addEventListener('timeupdate', function () {
            renderProgress();
            if (!state.dragging) syncLyric(false);
        });
        audio.addEventListener('durationchange', renderProgress);
        audio.addEventListener('play', renderPlayIcons);
        audio.addEventListener('pause', renderPlayIcons);
        audio.addEventListener('ended', function () {
            if (state.queue.length > 1) step(1);
            else { try { audio.currentTime = 0; } catch (e) {} renderProgress(); renderPlayIcons(); }
        });
        audio.addEventListener('error', function () {
            if (!state.cur) return;
            el.lyrics.innerHTML = '<div class="mp-lyric-empty">播放失败：文件不可访问或分享链接已失效</div>';
        });
    }

    function init(options) {
        cfg = options || cfg || {};
        if (booted) return global.ShareMusic;
        booted = true;
        if (!global.Lyrics) console.warn('ShareMusic: window.Lyrics 未加载, 歌词无法渲染');
        audio = new Audio();
        audio.preload = 'metadata';
        buildDom();
        bindAudio();
        bindSeek();
        bindActs();
        var f = 15;
        try { f = parseInt(localStorage.getItem('mp-lyric-font'), 10) || 15; } catch (e) {}
        applyFont(f);
        if (global.ResizeObserver) new global.ResizeObserver(setBarSpace).observe(el.bar);
        return global.ShareMusic;
    }

    global.ShareMusic = {
        init: init,
        // 播放某个文件; list 为所在目录的音频列表(播放列表), 缺省则单曲队列
        play: function (item, list) {
            if (!booted) init(cfg);
            var queue = (list && list.length) ? list.slice() : [item];
            var idx = -1;
            for (var i = 0; i < queue.length; i++) {
                if (queue[i].name === item.name && (queue[i].subPath || '') === (item.subPath || '')) { idx = i; break; }
            }
            if (idx < 0) { queue = [item]; idx = 0; }
            state.queue = queue;
            playAt(idx);
        },
        toggle: togglePlay,
        step: step,
        openFull: openFull,
        clear: clearQueue,
        isAudioEntry: isAudioEntry,
        // 目录 entries → 播放队列 [{ name, subPath }]
        audioList: function (entries, subPath) {
            var out = [];
            for (var i = 0; i < (entries || []).length; i++) {
                if (isAudioEntry(entries[i])) out.push({ name: entries[i].name, subPath: subPath || '' });
            }
            return out;
        },
        state: state,
        audio: function () { return audio; },
        // 仅供测试探针: 播放器内部函数不对外暴露
        _t: { clearQueue: clearQueue, playAt: playAt, renderQueue: renderQueue, showBar: showBar },
    };
})(window);
