// ============================================================================
// trackmeta.js — 歌曲元数据: 内嵌标签解析 + IndexedDB 缓存 + D1 同步
//
// 来源优先级: 用户编辑(D1) > 音频内嵌标签 > 文件名解析
//
// 为什么要读内嵌标签: 用户上传的 mp3/flac/m4a 大多自带准确的标题/歌手/专辑/封面,
// 部分还带内嵌歌词(USLT)。这条路径零网络请求、不泄露隐私、比文件名解析准得多。
// 代价是一次 Range 请求读文件头(512KB, 服务端 CPU 约 10ms, 远低于掐断线)。
//
// 顶层 const 不进 window —— 必须显式挂 (项目既有约定)
// ============================================================================
(function (global) {
    'use strict';

    var HEAD_BYTES = 512 * 1024;   // 只拉文件头: 封面可能几百 KB, 再大就不划算了
    var LOCAL_TTL = 7 * 86400 * 1000;

    // ---------------- IndexedDB ----------------
    var DB_NAME = 'fm-music';
    var DB_VER = 1;
    var _dbp = null;

    function open() {
        if (_dbp) return _dbp;
        _dbp = new Promise(function (resolve, reject) {
            var req;
            try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
                if (!db.objectStoreNames.contains('lyrics')) db.createObjectStore('lyrics');
                if (!db.objectStoreNames.contains('negative')) db.createObjectStore('negative');
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
        }).catch(function (e) { _dbp = null; throw e; });
        return _dbp;
    }

    function idbPut(store, key, value) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(value, key);
                tx.oncomplete = resolve;
                tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () { /* 缓存失败不影响播放 */ });
    }

    function idbGet(store, key) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, 'readonly');
                var r = tx.objectStore(store).get(key);
                r.onsuccess = function () { resolve(r.result); };
                r.onerror = function () { reject(r.error); };
            });
        }).catch(function () { return null; });
    }

    function idbDel(store, key) {
        return open().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        }).catch(function () {});
    }

    // ---------------- 文本解码 ----------------
    function decodeText(bytes, encoding) {
        var enc = encoding || 0;
        try {
            if (enc === 1) {                                  // UTF-16 with BOM
                var be = bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF;
                return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(2));
            }
            if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
            if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
            return new TextDecoder('iso-8859-1').decode(bytes);
        } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
    }

    function cstring(view, start) {                            // 以 0 结尾的 latin1 字符串
        var end = start;
        while (end < view.length && view[end] !== 0) end++;
        var s = '';
        for (var i = start; i < end; i++) s += String.fromCharCode(view[i]);
        return s;
    }

    function u32be(view, off) {
        return ((view[off] << 24) | (view[off + 1] << 16) | (view[off + 2] << 8) | view[off + 3]) >>> 0;
    }
    function u32le(view, off) {
        return ((view[off + 3] << 24) | (view[off + 2] << 16) | (view[off + 1] << 8) | view[off]) >>> 0;
    }

    // ---------------- ID3v2 (mp3 / wav / aiff) ----------------
    function parseId3(buf) {
        var view = new Uint8Array(buf);
        if (view.length < 10) return null;
        if (!(view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33)) return null;   // 'ID3'
        var major = view[3];
        if (major < 2 || major > 4) return null;
        // size 是 syncsafe(每字节 7 位有效)
        var size = ((view[6] & 0x7f) << 21) | ((view[7] & 0x7f) << 14) | ((view[8] & 0x7f) << 7) | (view[9] & 0x7f);
        var end = Math.min(10 + size, view.length);
        var pos = 10;
        var out = {};
        var idLen = major >= 3 ? 4 : 3;

        while (pos + 10 <= end) {
            var id = '';
            for (var k = 0; k < idLen; k++) id += String.fromCharCode(view[pos + k]);
            if (!/^[A-Z0-9]+$/.test(id)) break;                // 遇到 padding 或垃圾数据
            var fpos = pos + idLen;
            var fsize;
            if (major >= 4) {
                fsize = ((view[fpos] & 0x7f) << 21) | ((view[fpos + 1] & 0x7f) << 14) | ((view[fpos + 2] & 0x7f) << 7) | (view[fpos + 3] & 0x7f);
            } else {
                fsize = u32be(view, fpos);
            }
            var hlen = idLen + (major >= 3 ? 10 : 6) - (major >= 3 ? 4 : 0) - (major >= 3 ? 2 : 0) + (major >= 3 ? 6 : 0);
            // v2.3/2.4: id(4) + size(4) + flags(2) = 10 字节头; v2.2: id(3) + size(3) = 6 字节头
            hlen = major >= 3 ? 10 : 6;
            if (!Number.isFinite(fsize) || fsize <= 0 || fsize > end) break;
            var body = fpos + hlen;
            if (body + fsize > end) break;

            var raw = view.subarray(body, body + fsize);
            try {
                if (id === 'TIT2' || id === 'TT2') out.title = decodeText(raw.subarray(1), raw[0]);
                else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(raw.subarray(1), raw[0]);
                else if (id === 'TALB' || id === 'TAL') out.album = decodeText(raw.subarray(1), raw[0]);
                else if (id === 'USLT' || id === 'ULT') {
                    var enc = raw[0];
                    var p = 1 + 3;                              // encoding + language
                    // description 以 0(或 0x0000 for utf16) 结尾, 之后是歌词正文
                    var step = (enc === 1 || enc === 2) ? 2 : 1;
                    while (p + step <= raw.length) {
                        if (step === 1 ? raw[p] === 0 : (raw[p] === 0 && raw[p + 1] === 0)) { p += step; break; }
                        p += step;
                    }
                    out.lyric = decodeText(raw.subarray(p), enc);
                } else if (id === 'APIC' || id === 'PIC') {
                    var e2 = raw[0];
                    var q = 1;
                    var mime = cstring(raw, q);
                    q += mime.length + 1;
                    q += 1;                                      // picture type
                    while (q < raw.length && raw[q] !== 0) q++;  // description 到 0 为止(latin1/utf16 混用, 够用)
                    q += 1;
                    if (q < raw.length) {
                        out.cover = new Blob([raw.subarray(q)], { type: mime || 'image/jpeg' });
                    }
                }
            } catch (e) { /* 单个帧解析失败不影响其它帧 */ }

            pos = body + fsize;
        }
        return out;
    }

    // ---------------- FLAC ----------------
    function parseFlac(buf) {
        var view = new Uint8Array(buf);
        if (view.length < 4 + 4) return null;
        if (!(view[0] === 0x66 && view[1] === 0x4C && view[2] === 0x61 && view[3] === 0x43)) return null; // 'fLaC'
        var p = 4;
        var out = {};
        for (var guard = 0; guard < 32; guard++) {
            if (p + 4 > view.length) break;
            var last = view[p] & 0x80;
            var type = view[p] & 0x7F;
            var len = (view[p + 1] << 16) | (view[p + 2] << 8) | view[p + 3];
            p += 4;
            if (p + len > view.length) break;
            var block = view.subarray(p, p + len);
            try {
                if (type === 4) {                                // VORBIS_COMMENT
                    var q = 4 + u32le(block, 0);                 // vendor length + vendor
                    if (q + 4 <= block.length) {
                        var n = u32le(block, q); q += 4;
                        for (var i = 0; i < n && q + 4 <= block.length; i++) {
                            var cl = u32le(block, q); q += 4;
                            if (q + cl > block.length) break;
                            var s = new TextDecoder('utf-8').decode(block.subarray(q, q + cl));
                            q += cl;
                            var eq = s.indexOf('=');
                            if (eq <= 0) continue;
                            var key = s.slice(0, eq).toUpperCase();
                            var val = s.slice(eq + 1);
                            if (key === 'TITLE') out.title = val;
                            else if (key === 'ARTIST') out.artist = val;
                            else if (key === 'ALBUM') out.album = val;
                        }
                    }
                } else if (type === 6) {                         // PICTURE
                    var r = 4 + u32le(block, 4);                 // picture type + mime len + mime
                    r += 4 + u32le(block, r);                    // description
                    r += 16;                                     // w/h/depth/colors
                    var dlen = u32le(block, r); r += 4;
                    if (r + dlen <= block.length) {
                        out.cover = new Blob([block.subarray(r, r + dlen)], { type: 'image/jpeg' });
                    }
                }
            } catch (e) { /* 忽略坏块 */ }
            p += len;
            if (last) break;
        }
        return out;
    }

    // ---------------- MP4 / M4A ----------------
    function findBox(view, start, end, path) {
        var p = start;
        while (p + 8 <= end) {
            var size = u32be(view, p);
            var type = '';
            for (var i = 0; i < 4; i++) type += String.fromCharCode(view[p + 4 + i]);
            var head = 8;
            if (size === 1) { size = u32be(view, p + 8); head = 16; }
            if (size < head || p + size > end) break;
            if (type === path[0]) {
                if (path.length === 1) return { start: p + head, end: p + size };
                var inner = findBox(view, p + head, p + size, path.slice(1));
                if (inner) return inner;
            }
            p += size;
        }
        return null;
    }

    function parseMp4(buf) {
        var view = new Uint8Array(buf);
        // meta box 头部有 4 字节 version/flags, 需要先定位 udta.meta 再跳过
        var udta = findBox(view, 0, view.length, ['moov', 'udta']);
        if (!udta) return null;
        var metaBox = findBox(view, udta.start, udta.end, ['meta']);
        var ilst = null;
        if (metaBox) {
            var q = metaBox.start + 4;                          // 跳过 version/flags
            ilst = findBox(view, q, metaBox.end, ['ilst']);
        }
        if (!ilst) return null;

        var out = {};
        var p = ilst.start;
        while (p + 8 <= ilst.end) {
            var size = u32be(view, p);
            var type = '';
            for (var i = 0; i < 4; i++) type += String.fromCharCode(view[p + 4 + i]);
            if (size < 8 || p + size > ilst.end) break;
            var body = p + 8;
            // ilst 里的条目是 <size><'data'><size><type><locale><value>
            var dataBox = null;
            var dp = body;
            while (dp + 8 <= p + size) {
                var dsize = u32be(view, dp);
                var dtype = '';
                for (var j = 0; j < 4; j++) dtype += String.fromCharCode(view[dp + 4 + j]);
                if (dtype === 'data') { dataBox = { start: dp, end: dp + dsize }; break; }
                if (dsize < 8) break;
                dp += dsize;
            }
            if (dataBox && dataBox.end <= p + size) {
                var val = view.subarray(dataBox.start + 16, dataBox.end);   // 8 头 + 4 type + 4 locale
                try {
                    if (type === '©nam') out.title = new TextDecoder('utf-8').decode(val);
                    else if (type === '©ART') out.artist = new TextDecoder('utf-8').decode(val);
                    else if (type === '©alb') out.album = new TextDecoder('utf-8').decode(val);
                    else if (type === 'covr') {
                        var isPng = val.length > 8 && val[0] === 0x89 && val[1] === 0x50;
                        out.cover = new Blob([val], { type: isPng ? 'image/png' : 'image/jpeg' });
                    }
                } catch (e) { /* ignore */ }
            }
            p += size;
        }
        return out;
    }

    // ---------------- 读取文件头并解析 ----------------
    function readTags(path, ext) {
        var API = global.API;
        if (!API || !API.token) return Promise.resolve(null);
        var url = '/api/files/download?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(API.token);
        return fetch(url, { headers: { Range: 'bytes=0-' + (HEAD_BYTES - 1) } })
            .then(function (r) { return r.ok || r.status === 206 ? r.arrayBuffer() : null; })
            .then(function (buf) {
                if (!buf) return null;
                var e = String(ext || '').toLowerCase();
                if (e === 'mp3' || e === 'wav' || e === 'aiff' || e === 'aif') return parseId3(buf) || parseFlac(buf);
                if (e === 'flac') return parseFlac(buf) || parseId3(buf);
                if (e === 'm4a' || e === 'mp4' || e === 'aac') return parseMp4(buf);
                return parseId3(buf) || parseFlac(buf) || parseMp4(buf);
            })
            .catch(function () { return null; });
    }

    // ---------------- 文件名解析(与后端 parseName 保持一致的约定) ----------------
    function parseName(filename) {
        // 容错: 允许传完整路径, 内部先取文件名 (与后端 parseName 行为一致)
        var s = String(filename || '').replace(/\\/g, '/');
        var slash = s.lastIndexOf('/');
        if (slash !== -1) s = s.slice(slash + 1);
        s = s.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
        if (!s) return { title: '', artist: null };
        s = s.replace(/[(\[【][^)\]】]*(?:official|mv|m\/v|live|hd|hq|sq|320k|192k|128k|flac|ape|audio|video|lyrics?|instrumental|inst\.|remix|cover|伴奏|现场|高清|无损)[^)\]】]*[)\]】]/gi, '');
        s = s.replace(/_/g, ' ');
        s = s.replace(/^\s*\d{1,3}\s*[.\-_、\s]\s*/, '').trim();   // 与后端 parseName 保持一致
        if (!s) return { title: '', artist: null };
        var seps = [' - ', ' – ', ' — ', '-', '–', '—'];
        for (var i = 0; i < seps.length; i++) {
            var idx = s.indexOf(seps[i]);
            if (idx > 0) {
                var a = s.slice(0, idx).trim();
                var b = s.slice(idx + seps[i].length).trim();
                if (a && b) return { artist: a, title: b };
            }
        }
        return { title: s, artist: null };
    }

    function basename(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i === -1 ? s : s.slice(i + 1);
    }

    // ---------------- 对外: 解析一首歌的完整元数据 ----------------
    // opts: { path, name, ext, force }
    // 返回 { title, artist, album, lyricOffset, lrc, trans, coverUrl, embeddedLrc, source }
    function resolve(opts) {
        var path = opts && opts.path;
        if (!path) return Promise.resolve(null);
        var name = (opts && opts.name) || basename(path);
        var ext = (opts && opts.ext) || (String(name).split('.').pop() || '').toLowerCase();

        // 1) D1 里的用户编辑 —— 权威来源, 直接覆盖
        var remoteP = (global.API ? global.API.trackMeta(path) : Promise.resolve(null))
            .catch(function () { return null; });

        // manual(用户编辑) 与 tags(内嵌标签) 必须分开存:
        // 存成同一条记录时, 保存编辑会把标签解析结果冲掉, 下次又得重读文件头。
        return idbGet('meta', path).then(function (local) {
            return idbGet('meta', 'tags:' + path).then(function (tagRec) {
                return { local: local, tags: (tagRec && tagRec.tags) || null, remote: remoteP };
            });
        }).then(function (r) {
            return r.remote.then(function (remote) { return { local: r.local, tags: r.tags, remote: remote }; });
        }).then(function (r) {
            var remote = (r.remote && r.remote.meta) || null;
            var tags = r.tags || null;                           // 内嵌标签只解析一次, 之后复用
            var needTags = !(remote && remote.title) && !tags;
            var tagsP = needTags ? readTags(path, ext) : Promise.resolve(null);
                return tagsP.then(function (t) {
                    if (t && t.title) {
                        // 封面是 Blob, IndexedDB 存得住; 下次直接用, 不必再读一次文件头
                        idbPut('meta', 'tags:' + path, {
                            tags: { title: t.title, artist: t.artist, album: t.album, lyric: t.lyric, cover: t.cover || null },
                            ts: Date.now(),
                        });
                    }
                    var src = t || tags || {};
                    var lowered = {
                        title: null, artist: null, album: null,
                        lyricOffset: 0, lrc: null, trans: null,
                    };
                    if (remote) {
                        lowered.title = remote.title;
                        lowered.artist = remote.artist;
                        lowered.album = remote.album;
                        lowered.lyricOffset = remote.lyric_offset || 0;
                        lowered.lrc = remote.lrc;
                        lowered.trans = remote.trans;
                    }
                    var fallback = parseName(name);
                    var out = {
                        path: path,
                        name: name,
                        title: lowered.title || src.title || fallback.title || name,
                        artist: lowered.artist || src.artist || null,
                        album: lowered.album || src.album || null,
                        lyricOffset: lowered.lyricOffset || 0,
                        lrc: lowered.lrc || null,
                        trans: lowered.trans || null,
                        embeddedLrc: src.lyric || null,
                        coverUrl: null,
                        // 用户填了标题/歌手/原文/译文任一即视为手动 —— 只看 title 会让"只填译文"被误判成文件名来源
                        source: (remote && (remote.title || remote.artist || remote.lrc || remote.trans))
                            ? 'manual' : (src.title ? 'id3' : 'filename'),
                    };
                    if (src.cover) {
                        try { out.coverUrl = URL.createObjectURL(src.cover); } catch (e) { out.coverUrl = null; }
                        return out;
                    }
                    // 无内嵌封面 → 联网查一张(网易云/Deezer/iTunes, Worker 侧缓存 30 天); 失败静默, 灰底兜底
                    if (global.API && global.API.cover) {
                        return global.API.cover(path, { title: out.title, artist: out.artist })
                            .then(function (r) {
                                if (r && r.found && r.url) out.coverUrl = r.url;
                                return out;
                            })
                            .catch(function () { return out; });
                    }
                    return out;
                });
            })
            .catch(function () {
                var fb = parseName(name);
                return {
                    path: path, name: name,
                    title: fb.title || name, artist: fb.artist, album: null,
                    lyricOffset: 0, lrc: null, trans: null, embeddedLrc: null, coverUrl: null,
                    source: 'filename',
                };
            });
    }

    // 保存用户编辑: 先写本地镜像(离线也能用), 再写 D1
    function save(payload) {
        var path = payload && payload.path;
        if (!path) return Promise.reject(new Error('缺少 path'));
        return (global.API ? global.API.saveTrackMeta(payload) : Promise.resolve(null))
            .then(function (r) {
                return idbPut('meta', path, { manual: r && r.meta ? r.meta : payload, ts: Date.now() })
                    .then(function () { return (r && r.meta) || payload; });
            });
    }

    global.TrackMeta = {
        resolve: resolve,
        save: save,
        parseName: parseName,
        basename: basename,
        cache: {
            get: function (k) { return idbGet('lyrics', k); },
            put: function (k, v) { return idbPut('lyrics', k, v); },
            del: function (k) { return idbDel('lyrics', k); },
            negative: function (k) { return idbGet('negative', k); },
            negativePut: function (k) { return idbPut('negative', k, Date.now()); },
            metaGet: function (k) { return idbGet('meta', k); },
            metaPut: function (k, v) { return idbPut('meta', k, v); },
        },
        LOCAL_TTL: LOCAL_TTL,
    };
})(window);
