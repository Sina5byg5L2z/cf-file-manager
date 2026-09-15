// ============================================================================
// lyrics.js — LRC 解析 / 原文·译文·罗马音配对 / 时间定位
// 纯逻辑无 DOM 依赖, 便于单独测试; 结尾挂 window (项目既有约定)
// ============================================================================
(function (global) {
    'use strict';

    var TS_RE = '\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]';
    var PAIR_TOLERANCE = 1200;   // 译文与原文时间戳对不上时的容差(毫秒)

    function toMs(min, sec, frac) {
        var ms = (parseInt(min, 10) || 0) * 60000 + (parseInt(sec, 10) || 0) * 1000;
        if (frac) {
            var f = String(frac);
            while (f.length < 3) f += '0';
            ms += parseInt(f.slice(0, 3), 10);
        }
        return ms;
    }

    // 解析 LRC 文本 → [{ time(ms), text }] 按时间升序
    //   - 支持一行多个时间戳: [00:29.36][01:24.81] 副歌
    //   - 忽略 [ti:] [ar:] [al:] [by:] 等元信息行
    //   - 支持 [offset:+500] / [offset:-500] 整体偏移(毫秒)
    //   - 空文本行保留: 间奏需要留白
    function parse(text) {
        if (!text) return [];
        var lines = String(text).split(/\r?\n/);
        var out = [];
        var offset = 0;
        var meta = /^\[(ti|ar|al|by|re|ve|au|length|kana|total):/i;
        for (var i = 0; i < lines.length; i++) {
            var line = String(lines[i] || '').trim();
            if (!line) continue;

            var off = /^\[offset:([+-]?\d+)\]/i.exec(line);
            if (off) { offset += parseInt(off[1], 10) || 0; continue; }
            if (meta.test(line)) continue;

            var re = new RegExp(TS_RE, 'g');
            var stamps = [];
            var m;
            while ((m = re.exec(line)) !== null) {
                stamps.push(toMs(m[1], m[2], m[3]));
                if (m[0].length === 0) break;      // 防御: 零宽匹配导致死循环
            }
            if (!stamps.length) continue;
            var body = line.replace(new RegExp(TS_RE, 'g'), '').trim();
            for (var j = 0; j < stamps.length; j++) {
                out.push({ time: Math.max(0, stamps[j] + offset), text: body });
            }
        }
        out.sort(function (a, b) { return a.time - b.time; });
        return out;
    }

    // 时间戳 → 行号映射(取第一条), 用于译文配对
    function timeMap(lines) {
        var map = {};
        var keys = [];
        for (var i = 0; i < lines.length; i++) {
            var t = lines[i].time;
            if (map[t] === undefined) { map[t] = lines[i].text; keys.push(t); }
        }
        keys.sort(function (a, b) { return a - b; });
        return { map: map, keys: keys };
    }

    // 在有序 keys 里找离 t 最近的(≤ 容差), 找不到返回 null
    function nearest(idx, t) {
        if (!idx || !idx.keys.length) return null;
        var keys = idx.keys;
        var lo = 0, hi = keys.length - 1;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (keys[mid] < t) lo = mid + 1; else hi = mid;
        }
        var best = null, bestDiff = Infinity;
        for (var i = Math.max(0, lo - 1); i <= Math.min(keys.length - 1, lo + 1); i++) {
            var d = Math.abs(keys[i] - t);
            if (d < bestDiff) { bestDiff = d; best = keys[i]; }
        }
        if (best === null || bestDiff > PAIR_TOLERANCE) return null;
        return idx.map[best];
    }

    // 原文 + 译文 + 罗马音 → [{ time, text, trans, roma }]
    // 译文行数与原文对不上是常态(网易云常见), 配不上就留 null, 不错位显示
    function merge(orig, trans, roma) {
        var ti = trans && trans.length ? timeMap(trans) : null;
        var ri = roma && roma.length ? timeMap(roma) : null;
        return orig.map(function (l) {
            return {
                time: l.time,
                text: l.text,
                trans: ti ? nearest(ti, l.time) : null,
                roma: ri ? nearest(ri, l.time) : null,
            };
        });
    }

    // 当前时间对应的行下标; 没有命中返回 -1(开头前奏)
    function indexAt(lines, t) {
        if (!lines || !lines.length) return -1;
        var lo = 0, hi = lines.length - 1, res = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lines[mid].time <= t) { res = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return res;
    }

    function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        var s = Math.floor(sec % 60);
        var m = Math.floor(sec / 60) % 60;
        var h = Math.floor(sec / 3600);
        var mm = String(m).padStart(2, '0');
        var ss = String(s).padStart(2, '0');
        return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    }

    global.Lyrics = {
        parse: parse,
        merge: merge,
        indexAt: indexAt,
        formatTime: formatTime,
        hasTimestamps: function (t) { return new RegExp(TS_RE).test(String(t || '')); },
    };
})(window);
