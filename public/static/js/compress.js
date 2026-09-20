// compress.js — 上传前本地压缩 (图片 canvas 重编码 / 视频 WebCodecs → MediaRecorder → FFmpeg.wasm)
//
// 设计约定 (2026-09-20 与用户对齐):
//   * 绝不静默压缩: 只要有可压缩文件, 上传前必弹窗让用户选分辨率/画质, 压缩结果逐文件
//     确认后才进入上传; 「跳过压缩，直接上传」永远可用。
//   * 视频引擎降级链: WebCodecs(硬件优先) → MediaRecorder(兼容模式, 实时重录)
//     → FFmpeg.wasm(功能兜底, 按需加载 ~30MB core, 仅解浏览器解不动的输入时才有机会走到)
//     → 不可压缩(原样上传或超限标记)。FFmpeg 放最后: 它唯一不可替代的价值是解码
//     浏览器媒体栈解不动的容器(HEVC 无扩展/avi/wmv/flv), 那类文件 MediaRecorder 本就
//     无能为力, 顺序不影响覆盖面; 而「能解码」的场景原生引擎更快更省电。
//   * 重计算离主线程: WebCodecs 管线跑在 module worker (compress-video-worker.mjs);
//     MediaRecorder 是 DOM 播放式重录, 只能主线程, 主线程开销仅为每帧 drawImage。
//   * 流式与内存: 转码输出经 StreamTarget 直写 OPFS(不占 JS 堆), 同时作为刷新后
//     断点续传的文件缓存; OPFS 不可用回落 BufferTarget(内存)。
//   * 分辨率档位: 图片按「长边」, 视频按「短边」(720P/1080P 习惯), 只降不升。
//     码率 = 短边目标宽×高×fps×bpp, 与 compress-core.mjs 的公式保持一致。
(function () {
    'use strict';

    // ---------------- 常量 ----------------
    const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];
    const VID_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
    const IMG_MIN_SIZE = 64 * 1024;      // 小图重编码无收益
    const VID_MIN_SIZE = 1024 * 1024;    // <1MB 的视频不值得重编
    const IMG_RES_TIERS = [
        ['original', '原图'], ['4096', '长边 4K'], ['2560', '长边 2K'],
        ['1920', '长边 1080P'], ['1280', '长边 720P'], ['854', '长边 480P'],
    ];
    const VID_RES_TIERS = [
        ['original', '原图'], ['1080', '1080P'], ['720', '720P'],
        ['480', '480P'], ['360', '360P'],
    ];
    const IMG_QUALITY = { high: 0.88, medium: 0.8, low: 0.68 };
    const FFMPEG_CORE_MAX = 300 * 1024 * 1024; // MEMFS 限制: ffmpeg 兜底只处理 ≤300MB
    // 与 compress-core.mjs 的 VIDEO_QUALITY_BPP / estimateBitrate 保持一致
    const VID_QUALITY_BPP = { high: 0.12, medium: 0.08, low: 0.05 };

    function extOf(name) {
        const i = String(name || '').lastIndexOf('.');
        return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    }
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }
    function fmtSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }
    function even(n) { const r = Math.round(n); return r - (r % 2); }
    function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

    // 视频短边约束 (横屏压高度/竖屏压宽度), 与 compress-core.mjs videoTargetDims 一致
    function vidDims(w, h, maxEdge) {
        if (!maxEdge || maxEdge <= 0) return null;
        if (w <= h) { const t = even(Math.min(w, maxEdge)); return t < w ? { width: t } : null; }
        const t = even(Math.min(h, maxEdge));
        return t < h ? { height: t } : null;
    }
    function vidBitrate(w, h, fps, quality) {
        const bpp = VID_QUALITY_BPP[quality] || VID_QUALITY_BPP.high;
        return clamp(Math.round(w * h * fps * bpp), 200000, 24000000);
    }

    // 预估压缩后大小 (视频): 探测到的尺寸/帧率/时长套输出码率公式,
    // 与 compress-core.mjs convertVideo 的 estOut 完全同源 (视频轨公式码率 + 128k 音轨),
    // probe 数据齐全时估算相当准; probe 失败或缺时长返回 null (不显示)。
    const AUDIO_BITRATE = 128000;
    function estimateVideoBytes(probe, vidMaxEdge, quality) {
        if (!probe || !probe.ok || !probe.width || !probe.height || !(probe.durationSec > 0)) return null;
        const d = vidDims(probe.width, probe.height, vidMaxEdge | 0);
        const tw = d ? (d.width || probe.width) : probe.width;
        const th = d ? (d.height || probe.height) : probe.height;
        const fps = clamp(Math.round(probe.fps || 30), 1, 60);
        const vBit = vidBitrate(tw, th, fps, quality);
        const aBit = probe.hasAudio ? AUDIO_BITRATE : 0;
        return Math.round((vBit + aBit) / 8 * probe.durationSec);
    }

    // ---------------- 设置 ----------------
    function getCfg() {
        try {
            if (window.AppSettings && typeof AppSettings.compressCfg === 'function') {
                const c = AppSettings.compressCfg();
                if (c && c.enabled === false) return null;
                if (c) return c;
            }
        } catch { /* 设置未加载 → 用内置默认 */ }
        return { enabled: true, img_res: 'original', vid_res: 'original', quality: 'high' };
    }

    // ---------------- 候选判定 ----------------
    function isImageCandidate(f) {
        const ext = extOf(f.name);
        if (IMG_EXTS.includes(ext)) return f.size >= IMG_MIN_SIZE;
        const m = f.type || '';
        if (m.startsWith('image/') && !/gif|svg/i.test(m)) return f.size >= IMG_MIN_SIZE;
        return false;
    }
    function isVideoCandidate(f) {
        const ext = extOf(f.name);
        if (VID_EXTS.includes(ext)) return f.size >= VID_MIN_SIZE;
        return (f.type || '').startsWith('video/') && f.size >= VID_MIN_SIZE;
    }
    function kindOf(f) {
        if (isImageCandidate(f)) return 'image';
        if (isVideoCandidate(f)) return 'video';
        return null;
    }

    // ---------------- 能力探测 ----------------
    let hwHintPromise = null;
    function hardwareHint() {
        if (!hwHintPromise) {
            hwHintPromise = (async () => {
                try {
                    if (typeof VideoEncoder === 'undefined') return 'none';
                    // require-hardware 是严格信号: 探测通过才标「GPU 加速」
                    const r = await VideoEncoder.isConfigSupported({
                        codec: 'avc1.640028', width: 1280, height: 720,
                        bitrate: 4000000, framerate: 30, hardwareAcceleration: 'require-hardware',
                    });
                    return (r && r.supported) ? 'gpu' : 'software';
                } catch { return 'software'; }
            })();
        }
        return hwHintPromise;
    }
    function canWebCodecs() { return typeof VideoEncoder !== 'undefined'; }

    // ---------------- worker (WebCodecs 管线) ----------------
    let vidWorker = null, workerBroken = false, jobSeq = 0;
    const jobs = new Map(); // id → {resolve, reject, onProgress}

    function getWorker() {
        if (workerBroken) return null;
        if (vidWorker) return vidWorker;
        try {
            vidWorker = new Worker('/static/js/compress-video-worker.mjs?v=20260920d', { type: 'module' });
            vidWorker.onmessage = (e) => {
                const { id, type, data, p, message, code } = e.data || {};
                const job = jobs.get(id);
                if (!job) return;
                if (type === 'progress') { try { job.onProgress && job.onProgress(p); } catch { /* 忽略 */ } return; }
                jobs.delete(id);
                if (type === 'done') job.resolve(data);
                else job.reject(Object.assign(new Error(message || '转码失败'), { code }));
            };
            vidWorker.onerror = () => {
                // 脚本加载失败等致命错误: 所有在途任务报错, 之后不再用 worker
                workerBroken = true;
                for (const [, job] of jobs) job.reject(new Error('压缩 worker 不可用'));
                jobs.clear();
                try { vidWorker.terminate(); } catch { /* 已死 */ }
                vidWorker = null;
            };
        } catch { workerBroken = true; }
        return vidWorker;
    }
    function workerCall(msg, onProgress) {
        const w = getWorker();
        if (!w) return null;
        const id = ++jobSeq;
        return new Promise((resolve, reject) => {
            jobs.set(id, { resolve, reject, onProgress });
            w.postMessage(Object.assign({ id }, msg));
        });
    }
    function killWorker() {
        if (vidWorker) { try { vidWorker.terminate(); } catch { /* 已死 */ } }
        vidWorker = null;
        for (const [, job] of jobs) job.reject(new Error('已取消'));
        jobs.clear();
    }

    // 主线程兜底 (无 module worker 的老浏览器): 动态 import 同一份内核
    let corePromise = null;
    function loadCore() {
        if (!corePromise) corePromise = import('/static/js/compress-core.mjs?v=20260920d');
        return corePromise;
    }

    // ---------------- OPFS 缓存 (压缩结果跨刷新续传) ----------------
    async function opfsDir() {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle('compress-cache', { create: true });
    }
    async function opfsReadBlob(cacheName) {
        try {
            const dir = await opfsDir();
            const fh = await dir.getFileHandle(cacheName);
            return await fh.getFile();
        } catch { return null; }
    }
    async function opfsWriteBlob(cacheName, blob) {
        try {
            const dir = await opfsDir();
            try { await dir.removeEntry(cacheName); } catch { /* 目标状态即不存在 */ }
            const fh = await dir.getFileHandle(cacheName, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
            return true;
        } catch { return false; }
    }
    async function opfsDelete(cacheName) {
        if (!cacheName) return;
        try {
            const dir = await opfsDir();
            await dir.removeEntry(cacheName);
        } catch { /* 不存在即目标状态 */ }
    }
    function newCacheName(name) {
        const safe = String(name || 'video').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-60);
        return 'cv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
    }

    // 刷新恢复: 按 cacheName 取回压缩文件 (lastModified 必须用保存值重建,
    // 否则 fileFingerprint 对不上, 服务端续传会话失配)
    async function restoreCachedFile(name, cacheName, type, lastModified) {
        const blob = await opfsReadBlob(cacheName);
        if (!blob) return null;
        try {
            return new File([blob], name, {
                type: type || blob.type || 'application/octet-stream',
                lastModified: lastModified || 0,
            });
        } catch { return null; }
    }

    // ---------------- 图片压缩 (主线程 canvas) ----------------
    async function compressImage(file, opts) {
        const ext = extOf(file.name);
        const wantAlpha = ['png', 'webp'].includes(ext) || /png|webp/i.test(file.type || '');
        let bmp;
        try {
            // EXIF 方向烘焙进像素 (旋转的 iPhone 照片不会转错); 老浏览器不支持该选项时退回普通解码
            bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch {
            bmp = await createImageBitmap(file);
        }
        try {
            let tw = bmp.width, th = bmp.height;
            const maxEdge = opts.imgMaxEdge | 0;
            if (maxEdge > 0) {
                const s = Math.min(1, maxEdge / Math.max(tw, th));
                tw = Math.max(1, Math.round(tw * s));
                th = Math.max(1, Math.round(th * s));
            }
            const canvas = document.createElement('canvas');
            canvas.width = tw; canvas.height = th;
            const ctx = canvas.getContext('2d');
            const mime = wantAlpha ? 'image/webp' : 'image/jpeg';
            if (!wantAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th); } // JPEG 无 alpha, 白底防黑
            ctx.drawImage(bmp, 0, 0, tw, th);
            const q = IMG_QUALITY[opts.quality] || IMG_QUALITY.high;
            const blob = await new Promise((res, rej) =>
                canvas.toBlob((b) => (b ? res(b) : rej(new Error('图片编码失败'))), mime, q));
            // Safari 老版本 toBlob('image/webp') 会静默落 PNG → 以实际类型为准
            const outMime = blob.type || mime;
            const extFor = { 'image/jpeg': ext === 'jpeg' ? 'jpeg' : 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
            const base = file.name.replace(/\.[^.]+$/, '');
            const outExt = extFor[outMime] || ext;
            return {
                blob, mime: outMime,
                name: outExt === ext ? file.name : `${base}.${outExt}`,
                engine: 'canvas', size: blob.size,
            };
        } finally {
            if (bmp.close) bmp.close(); // 显式释放位图内存
        }
    }

    // ---------------- 视频引擎 1: WebCodecs (worker 优先, 主线程兜底) ----------------
    async function compressVideoWebCodecs(file, opts, onProgress, signal, cacheName) {
        // worker 路径: 管线全在 worker 内, 输出直写 OPFS
        if (getWorker()) {
            const data = await workerCall({ cmd: 'convert', file, opts: { maxEdge: opts.vidMaxEdge || 0, quality: opts.quality }, cacheName }, onProgress);
            if (data.buffer) {
                // OPFS 不可用的内存路径: 组 blob + 尽力补写 OPFS 供续传
                const blob = new Blob([data.buffer], { type: 'video/mp4' });
                opfsWriteBlob(cacheName, blob).catch(() => {});
                return { blob, mime: 'video/mp4', engine: 'webcodecs', size: data.size, cacheName };
            }
            const f = await opfsReadBlob(cacheName);
            if (!f || f.size === 0) throw new Error('压缩输出丢失');
            return { blob: f, mime: 'video/mp4', engine: 'webcodecs', size: data.size, cacheName };
        }
        // 主线程路径 (无 module worker 的老浏览器)
        const core = await loadCore();
        const cancelRef = {};
        const p = core.convertVideo(file, {
            maxEdge: opts.vidMaxEdge || 0, quality: opts.quality,
            makeWritable: async () => {
                const dir = await opfsDir();
                try { await dir.removeEntry(cacheName); } catch { /* 目标状态即不存在 */ }
                const fh = await dir.getFileHandle(cacheName, { create: true });
                return await fh.createWritable();
            },
        }, onProgress, cancelRef);
        signal.onCleanup(() => { try { cancelRef.cancel && cancelRef.cancel(); } catch { /* 已结束 */ } });
        const data = await p;
        const base = file.name.replace(/\.[^.]+$/, '');
        const name = extOf(file.name) === 'mp4' ? file.name : `${base}.mp4`;
        let blob;
        if (data.buffer) {
            blob = new Blob([data.buffer], { type: 'video/mp4' });
            opfsWriteBlob(cacheName, blob).catch(() => {});
        } else {
            blob = await opfsReadBlob(cacheName);
            if (!blob || blob.size === 0) throw new Error('压缩输出丢失');
        }
        return { blob, mime: 'video/mp4', engine: 'webcodecs', size: data.size, name, cacheName };
    }

    // ---------------- 视频引擎 2: MediaRecorder 兼容模式 (实时重录) ----------------
    function mediaRecorderMime() {
        if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
        const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
            'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
    }
    async function compressVideoMediaRecorder(file, opts, onProgress, signal) {
        const mime = mediaRecorderMime();
        if (!mime) throw new Error('MediaRecorder 不可用');
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.playsInline = true;
        const cleanups = [];
        try {
            await Promise.race([
                new Promise((res, rej) => {
                    v.onloadedmetadata = () => res();
                    v.onerror = () => rej(new Error('浏览器无法解码该视频'));
                    setTimeout(() => rej(new Error('读取视频元数据超时')), 8000);
                    v.src = url;
                }),
                signal.cancelPromise,
            ]);
            const vw = v.videoWidth || 640, vh = v.videoHeight || 360;
            const dims = vidDims(vw, vh, opts.vidMaxEdge | 0);
            const tw = dims ? (dims.width || vw) : vw;
            const th = dims ? (dims.height || vh) : vh;
            // 无时长元数据时拿不到 fps → 按 30 估码率 (与 core 公式一致)
            const fps = 30;
            const bitrate = vidBitrate(tw, th, fps, opts.quality);

            const canvas = document.createElement('canvas');
            canvas.width = tw; canvas.height = th;
            const ctx = canvas.getContext('2d');
            const stream = canvas.captureStream(30);

            // 音频: 经 WebAudio 采进录制流, 不接扬声器 → 用户听不到
            let audioOk = false;
            try {
                const ac = new (window.AudioContext || window.webkitAudioContext)();
                const src = ac.createMediaElementSource(v);
                const dest = ac.createMediaStreamDestination();
                src.connect(dest);
                dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
                audioOk = true;
                cleanups.push(() => { try { ac.close(); } catch { /* 已关 */ } });
            } catch { audioOk = false; }

            const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
            const chunks = [];
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            const stopped = new Promise((res, rej) => {
                rec.onstop = () => res();
                rec.onerror = () => rej(new Error('录制失败'));
            });
            rec.start(1000);
            cleanups.push(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* 已停 */ } });

            // 自动播放策略: 无手势被拦 → 静音重试(WebAudio 取到静音, 输出无声)
            try { await v.play(); } catch { v.muted = true; try { await v.play(); } catch { throw new Error('浏览器阻止了视频播放'); } audioOk = false; }

            const draw = () => {
                try { ctx.drawImage(v, 0, 0, tw, th); } catch { /* 帧未就绪, 下一帧再画 */ }
                try { if (v.duration) onProgress(clamp(v.currentTime / v.duration, 0, 1)); } catch { /* 忽略 */ }
            };
            if (v.requestVideoFrameCallback) {
                const loop = () => { if (v.ended || signal.canceled) return; draw(); v.requestVideoFrameCallback(loop); };
                v.requestVideoFrameCallback(loop);
            } else {
                const loop = () => { if (v.ended || signal.canceled) return; draw(); requestAnimationFrame(loop); };
                requestAnimationFrame(loop);
            }
            await Promise.race([new Promise((res) => { v.onended = () => res(); }), signal.cancelPromise]);
            if (signal.canceled) throw new Error('已取消');
            if (rec.state !== 'inactive') rec.stop();
            await stopped;
            const outMime = mime.split(';')[0];
            const blob = new Blob(chunks, { type: outMime });
            if (!blob.size) throw new Error('录制结果为空');
            const ext = outMime.includes('mp4') ? 'mp4' : 'webm';
            const base = file.name.replace(/\.[^.]+$/, '');
            return {
                blob, mime: outMime, engine: 'mediarecorder', size: blob.size,
                name: ext === extOf(file.name) ? file.name : `${base}.${ext}`,
                noAudio: !audioOk,
            };
        } finally {
            try { v.pause(); } catch { /* 未播 */ }
            v.removeAttribute('src');
            try { v.load(); } catch { /* 已清 */ }
            URL.revokeObjectURL(url);
            cleanups.forEach((fn) => { try { fn(); } catch { /* 忽略 */ } });
        }
    }

    // ---------------- 视频引擎 3: FFmpeg.wasm 功能兜底 (按需加载 core) ----------------
    let ffmpegInst = null, ffmpegLoading = null, ffmpegOnProgress = null;
    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            const timer = setTimeout(() => reject(new Error('脚本加载超时')), 20000);
            s.onload = () => { clearTimeout(timer); resolve(); };
            s.onerror = () => { clearTimeout(timer); reject(new Error('脚本加载失败: ' + src)); };
            s.src = src;
            document.head.appendChild(s);
        });
    }
    function withTimeout(promise, ms, msg) {
        return Promise.race([
            promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error(msg || '超时')), ms)),
        ]);
    }
    async function loadFfmpeg() {
        if (ffmpegInst) return ffmpegInst;
        if (!ffmpegLoading) {
            ffmpegLoading = (async () => {
                await loadScriptOnce('/static/vendor/ffmpeg/ffmpeg.js');
                const FF = window.FFmpegWASM && window.FFmpegWASM.FFmpeg;
                if (!FF) throw new Error('FFmpeg 组件加载失败');
                const ff = new FF();
                ff.on('progress', ({ progress }) => {
                    try { if (ffmpegOnProgress) ffmpegOnProgress(clamp(progress || 0, 0, 1)); } catch { /* 忽略 */ }
                });
                // core 30.7MB 超过 Workers 静态资源单文件 25MiB 上限, 只能 CDN 按需加载
                const bases = [
                    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
                    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd',
                ];
                let lastErr = null;
                for (const base of bases) {
                    try {
                        await withTimeout(ff.load({
                            coreURL: base + '/ffmpeg-core.js',
                            wasmURL: base + '/ffmpeg-core.wasm',
                        }), 90000, 'FFmpeg core 加载超时');
                        ffmpegInst = ff;
                        return ff;
                    } catch (e) { lastErr = e; }
                }
                ffmpegLoading = null; // 允许下次重试
                throw lastErr || new Error('FFmpeg core 加载失败');
            })();
        }
        return ffmpegLoading;
    }
    async function compressVideoFfmpeg(file, opts, onProgress, signal) {
        if (file.size > FFMPEG_CORE_MAX) throw new Error('文件超过 300MB，FFmpeg 兜底不适用');
        const ff = await Promise.race([loadFfmpeg(), signal.cancelPromise]);
        if (signal.canceled) throw new Error('已取消');
        const inName = 'in.' + (extOf(file.name) || 'mp4');
        const outName = 'out.mp4';
        ffmpegOnProgress = onProgress;
        signal.onCleanup(() => { try { ff.terminate(); } catch { /* 已死 */ } ffmpegInst = null; ffmpegLoading = null; });
        await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
        try {
            // 元数据探测失败才轮到这里 → 尺寸从 <video> 兜底读取 (可能失败, 失败则原尺寸)
            const dims = await new Promise((res) => {
                const v = document.createElement('video');
                v.preload = 'metadata';
                const done = (d) => { v.removeAttribute('src'); res(d); };
                setTimeout(() => done(null), 6000);
                v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight });
                v.onerror = () => done(null);
                v.src = URL.createObjectURL(file);
            });
            const args = ['-i', inName];
            if (dims && opts.vidMaxEdge) {
                const d = vidDims(dims.w, dims.h, opts.vidMaxEdge | 0);
                if (d) args.push('-vf', `scale=${d.width || dims.w}:${d.height || dims.h}`);
            }
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v',
                String(vidBitrate(dims ? dims.w : 1280, dims ? dims.h : 720, 30, opts.quality)),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', // 无音轨时 ffmpeg 自动忽略该编码器
                '-movflags', '+faststart', outName);
            const code = await ff.exec(args);
            if (code !== 0) throw new Error('FFmpeg 转码失败 (exit ' + code + ')');
            const data = await ff.readFile(outName);
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (!u8.length) throw new Error('FFmpeg 输出为空');
            return { blob: new Blob([u8], { type: 'video/mp4' }), mime: 'video/mp4', engine: 'ffmpeg', size: u8.length };
        } finally {
            ffmpegOnProgress = null;
            try { await ff.deleteFile(inName); } catch { /* 忽略 */ }
            try { await ff.deleteFile(outName); } catch { /* 忽略 */ }
        }
    }

    // ---------------- 视频调度: 按引擎链降级 ----------------
    async function compressVideoAuto(entry, opts, onProgress, signal) {
        const file = entry.file;
        const cacheName = entry.cacheName || (entry.cacheName = newCacheName(file.name));
        const engines = [];
        if (canWebCodecs()) engines.push('webcodecs');
        if (mediaRecorderMime()) engines.push('mediarecorder');
        engines.push('ffmpeg'); // 可用性到加载时才确定, 先进链
        let lastErr = null;
        for (const engine of engines) {
            if (signal.canceled) throw new Error('已取消');
            try {
                let r;
                if (engine === 'webcodecs') r = await compressVideoWebCodecs(file, opts, onProgress, signal, cacheName);
                else if (engine === 'mediarecorder') r = await compressVideoMediaRecorder(file, opts, onProgress, signal);
                else r = await compressVideoFfmpeg(file, opts, onProgress, signal);
                if (r.name) entry.outName = r.name;
                if (r.noAudio) entry.note = '兼容模式未能采集音频，输出无声';
                return r;
            } catch (e) {
                if (signal.canceled) throw new Error('已取消');
                lastErr = e;
                entry.engineTried = entry.engineTried || [];
                entry.engineTried.push(engine);
            }
        }
        throw lastErr || new Error('没有可用的压缩引擎');
    }

    // ---------------- 探测 (弹窗展示用) ----------------
    // 兜底: <video> 元素探测。下载工具/录屏软件产出的 "mp4" 常是非标准封装
    // (ts/flv/m4s 拼接改名), JS 解封装层 (mediabunny) 读不动, 但浏览器 media stack
    // 可能仍能播 → 能拿到宽高/时长就足够出预估 (帧率拿不到, 按 30 估)。
    function probeViaVideoElement(file) {
        return new Promise((res) => {
            const url = URL.createObjectURL(file);
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.playsInline = true;
            let settled = false;
            let timer = null;
            const done = (r) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                v.removeAttribute('src');
                try { v.load(); } catch { /* 已清 */ }
                URL.revokeObjectURL(url);
                res(r);
            };
            timer = setTimeout(() => done(null), 8000);
            v.onloadedmetadata = () => {
                const w = v.videoWidth, h = v.videoHeight, dur = v.duration;
                if (!w || !h || !isFinite(dur) || !(dur > 0)) { done(null); return; }
                done({
                    ok: true, via: 'video-element',
                    width: w, height: h,
                    fps: 30,        // 元数据层无帧率, 按 30 估 (仅用于码率公式, 偏差有限)
                    durationSec: dur,
                    hasAudio: true, // 元数据层判不出音轨, 按有音轨估 (偏差上限 16KB/s)
                    codec: '', srcBitrate: 0,
                });
            };
            v.onerror = () => done(null);
            v.src = url;
        });
    }
    async function probeVideoMeta(file) {
        // worker 在 → worker 探; 否则主线程 core 探。两者都失败 = JS 解封装层不支持该容器
        const w = getWorker();
        let r;
        if (w) {
            try {
                r = await workerCall({ cmd: 'probe', file }, null);
            } catch { r = { ok: false, reason: 'probe-failed' }; }
        } else {
            try {
                const core = await loadCore();
                r = await core.probeVideo(file);
            } catch { r = { ok: false, reason: 'probe-failed' }; }
        }
        if (r && r.ok) return r;
        const v = await probeViaVideoElement(file);
        return v || r; // <video> 也解不动 → 维持失败结论
    }

    // ---------------- 压缩入口 ----------------
    async function compressOne(entry, opts, onProgress, signal) {
        if (entry.kind === 'image') {
            // 弹窗阶段已在同档位下真实预压过 → 直接复用结果, 不重复算
            if (entry.preview && entry.previewOpts
                && entry.previewOpts.imgMaxEdge === opts.imgMaxEdge
                && entry.previewOpts.quality === opts.quality) {
                return entry.preview;
            }
            return compressImage(entry.file, opts);
        }
        return compressVideoAuto(entry, opts, onProgress, signal);
    }

    // 取消信号
    function makeSignal() {
        const s = {
            canceled: false,
            _cleanups: [],
            onCleanup(fn) { this._cleanups.push(fn); },
            runCleanup() { this._cleanups.forEach((fn) => { try { fn(); } catch { /* 忽略 */ } }); this._cleanups = []; },
        };
        let rej = null;
        s.cancelPromise = new Promise((_, r) => { rej = r; });
        // 空消费兜底: 没人 Promise.race 它时 (如纯图片路径), cancel() 的 reject 不会变成 unhandled rejection
        s.cancelPromise.catch(() => { /* 已在别处处理 */ });
        s.cancel = () => {
            if (s.canceled) return;
            s.canceled = true;
            try { if (rej) rej(new Error('已取消')); } catch { /* 已决议 */ }
            s.runCleanup();
        };
        return s;
    }

    // ---------------- 弹窗 UI ----------------
    const CompressUI = {
        _activePromise: null,

        // 返回: 最终文件数组 (用户确认后) / 原数组 (无需压缩或跳过) / null (取消)
        async maybeCompress(fileList) {
            const files = [...fileList];
            const cfg = getCfg();
            if (!cfg || cfg.enabled === false) return files;
            if (!files.some((f) => kindOf(f))) return files;
            if (this._activePromise) { await this._activePromise.catch(() => {}); }
            this._activePromise = this._open(files, cfg);
            const r = await this._activePromise.finally(() => { this._activePromise = null; });
            return r;
        },

        _open(files, cfg) {
            return new Promise((resolve) => {
                const limit = (window.AppSettings && AppSettings.uploadLimit) ? AppSettings.uploadLimit() : Infinity;
                const entries = [];
                const entryByFile = new Map();
                for (const f of files) {
                    const kind = kindOf(f);
                    if (!kind) continue;
                    const en = { file: f, kind, probe: null, result: null, error: null, checked: true, cacheName: null, row: null };
                    entries.push(en);
                    entryByFile.set(f, en);
                }

                // ---- 骨架 ----
                const overlay = document.createElement('div');
                overlay.className = 'compress-overlay';
                overlay.innerHTML = `
                    <div class="modal compress-modal">
                        <div class="modal-header">
                            <span>上传前压缩</span>
                            <button class="modal-close" id="cmpClose">✕</button>
                        </div>
                        <div class="modal-body">
                            <div class="cmp-settings" id="cmpSettings">
                                <div class="form-row2">
                                    <div class="form-group">
                                        <label>图片分辨率</label>
                                        <select id="cmpImgRes"></select>
                                    </div>
                                    <div class="form-group">
                                        <label>视频分辨率</label>
                                        <select id="cmpVidRes"></select>
                                    </div>
                                </div>
                                <div class="form-row2">
                                    <div class="form-group">
                                        <label>画质</label>
                                        <select id="cmpQuality">
                                            <option value="high">高质量</option>
                                            <option value="medium">均衡</option>
                                            <option value="low">高压缩</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="settings-hint">压缩完全在浏览器本地完成，不会静默替换：确认后逐个文件执行，完成后可逐个决定是否采用压缩版。视频优先使用 GPU 硬件编码（WebCodecs），不可用时自动降级。</div>
                            </div>
                            <div class="cmp-list" id="cmpList"></div>
                        </div>
                        <div class="compress-footer" id="cmpFooter"></div>
                    </div>`;
                document.body.appendChild(overlay);

                const $ = (id) => overlay.querySelector('#' + id);
                const listEl = $('cmpList');
                const footer = $('cmpFooter');
                let phase = 'settings';   // settings → running → result
                const signal = makeSignal();

                // ---- 设置控件 ----
                const imgSel = $('cmpImgRes'), vidSel = $('cmpVidRes'), qSel = $('cmpQuality');
                imgSel.innerHTML = IMG_RES_TIERS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
                vidSel.innerHTML = VID_RES_TIERS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
                imgSel.value = IMG_RES_TIERS.some(([v]) => v === cfg.img_res) ? cfg.img_res : 'original';
                vidSel.value = VID_RES_TIERS.some(([v]) => v === cfg.vid_res) ? cfg.vid_res : 'original';
                qSel.value = ['high', 'medium', 'low'].includes(cfg.quality) ? cfg.quality : 'high';

                // ---- 预估 ----
                // 视频: estimateVideoBytes 纯公式 (probe 数据到位即可算);
                // 图片: 真实预压缩 (canvas 毫秒级), 比 CMYK/EXIF 等公式猜测准得多,
                //       "开始压缩"时若档位未变直接复用预压结果 (见 compressOne)。
                function currentOpts() {
                    return {
                        imgMaxEdge: imgSel.value === 'original' ? 0 : parseInt(imgSel.value, 10),
                        vidMaxEdge: vidSel.value === 'original' ? 0 : parseInt(vidSel.value, 10),
                        quality: qSel.value,
                    };
                }
                let previewSeq = 0;      // 代次: 档位变更/开始压缩时 +1, 在途预压结果作废
                let previewBusy = false;
                let previewOpts = null;  // 预压使用的档位快照 {imgMaxEdge, quality}
                const previewQueue = [];
                function schedulePreview(en) {
                    en.preview = null;
                    en.previewOpts = null; // null = 预压排队/进行中
                    en.previewFailed = false;
                    en.previewSeq = previewSeq;
                    previewQueue.push(en);
                    pumpPreview();
                }
                async function pumpPreview() {
                    if (previewBusy) return;
                    previewBusy = true;
                    try {
                        while (previewQueue.length) {
                            const en = previewQueue.shift();
                            if (en.previewSeq !== previewSeq) continue; // 档位已变, 作废
                            try {
                                const r = await compressImage(en.file, previewOpts);
                                if (en.previewSeq !== previewSeq) continue; // 完成时已换档, 丢弃
                                en.preview = r;
                                en.previewOpts = { imgMaxEdge: previewOpts.imgMaxEdge, quality: previewOpts.quality };
                            } catch {
                                if (en.previewSeq === previewSeq) en.previewFailed = true; // 预压失败 → 明示, 不留空白
                            }
                            renderEstimate(en);
                        }
                    } finally {
                        previewBusy = false;
                    }
                }
                function estText(fileSize, outSize) {
                    const pct = fileSize ? Math.round((fileSize - outSize) / fileSize * 100) : 0;
                    return `预估 ≈ ${fmtSize(outSize)}（${pct > 0 ? `省 ${pct}%` : '压缩无收益'}）`;
                }
                // 只更新 .cmp-row-est; running/result 阶段 sub 被接管 (查不到该 span) → 直接返回
                function renderEstimate(en) {
                    if (phase !== 'settings' || !en.row || !en.row.isConnected) return;
                    const est = en.row.querySelector('.cmp-row-sub .cmp-row-est');
                    if (!est) return;
                    if (en.kind === 'image') {
                        if (en.preview) est.textContent = estText(en.file.size, en.preview.size);
                        else if (en.previewFailed) est.textContent = '无法预估';
                        else if (en.previewOpts === null) est.textContent = '预估中…';
                        else est.textContent = '';
                        return;
                    }
                    // 视频: 探测失败 (浏览器/mediabunny 解不动的容器) → 明示无法预估, 不留空白
                    if (en.probe && en.probe.ok === false) { est.textContent = '无法预估'; return; }
                    const o = currentOpts();
                    const bytes = estimateVideoBytes(en.probe, o.vidMaxEdge, o.quality);
                    est.textContent = bytes != null ? estText(en.file.size, bytes) : '';
                }
                function onTierChange() {
                    previewSeq++;
                    previewQueue.length = 0;
                    const o = currentOpts();
                    previewOpts = { imgMaxEdge: o.imgMaxEdge, quality: o.quality };
                    for (const en of entries) {
                        if (en.kind === 'image') schedulePreview(en);
                        renderEstimate(en); // 视频行估算随档位即时刷新
                    }
                }
                imgSel.addEventListener('change', onTierChange);
                vidSel.addEventListener('change', onTierChange);
                qSel.addEventListener('change', onTierChange);
                {
                    const o0 = currentOpts();
                    previewOpts = { imgMaxEdge: o0.imgMaxEdge, quality: o0.quality };
                }

                // ---- 行渲染 ----
                function badgeFor(en) {
                    if (en.kind === 'image') return '<span class="cmp-badge cmp-badge-ok">本地重编码</span>';
                    const p = en.probe;
                    if (p && p.ok === false) {
                        // mediabunny 解不了的容器 (avi/wmv/flv/HEVC 无扩展)
                        if (canWebCodecs()) return '<span class="cmp-badge cmp-badge-warn">FFmpeg 兜底（较慢）</span>';
                        return '<span class="cmp-badge cmp-badge-warn">FFmpeg 兜底（需加载约 30MB）</span>';
                    }
                    if (p && p.via === 'video-element') {
                        // JS 解封装不支持 → WebCodecs 管线 (走 mediabunny) 必然失败,
                        // 实际引擎只会是 <video> 重录或 FFmpeg, 徽标如实反映
                        if (mediaRecorderMime()) return '<span class="cmp-badge cmp-badge-warn">兼容模式（实时重录）</span>';
                        return '<span class="cmp-badge cmp-badge-warn">FFmpeg 兜底（需加载约 30MB）</span>';
                    }
                    if (canWebCodecs()) return '<span class="cmp-badge cmp-badge-ok">WebCodecs</span>';
                    if (mediaRecorderMime()) return '<span class="cmp-badge cmp-badge-warn">兼容模式（实时重录）</span>';
                    return '<span class="cmp-badge cmp-badge-warn">FFmpeg 兜底（较慢）</span>';
                }
                function renderRow(en) {
                    const row = document.createElement('div');
                    row.className = 'cmp-row';
                    const overLimit = en.file.size > limit;
                    row.innerHTML = `
                        <div class="cmp-row-main">
                            <span class="cmp-row-name" title="${esc(en.file.name)}">${esc(en.file.name)}</span>
                            <span class="cmp-row-size">${fmtSize(en.file.size)}</span>
                            ${badgeFor(en)}
                            ${overLimit ? '<span class="cmp-badge cmp-badge-err">超过上传上限</span>' : ''}
                        </div>
                        <div class="cmp-row-sub"><span class="cmp-row-meta"></span><span class="cmp-row-est"></span></div>
                        <div class="cmp-row-bar" style="display:none"><div class="cmp-row-bar-fill"></div></div>`;
                    en.row = row;
                    listEl.appendChild(row);
                    if (en.kind === 'video' && !en.probe && !en.probing) {
                        en.probing = true;
                        probeVideoMeta(en.file).then((p) => {
                            en.probe = p;
                            if (phase === 'settings') {
                                // 徽标按探测结果刷新 (WebCodecs 探测通过与否要到压缩时才知道)
                                const main = row.querySelector('.cmp-row-main');
                                if (main) {
                                    main.querySelectorAll('.cmp-badge-ok,.cmp-badge-warn').forEach((b) => { if (!b.classList.contains('cmp-badge-err')) b.remove(); });
                                    main.insertAdjacentHTML('beforeend', badgeFor(en));
                                }
                                if (p && p.ok) {
                                    const meta = row.querySelector('.cmp-row-meta');
                                    if (meta) meta.textContent = p.via === 'video-element'
                                        ? `约 ${p.width}×${p.height} · 时长 ${Math.round(p.durationSec)} 秒（按 30fps 估）`
                                        : `${p.width}×${p.height} · ${p.fps}fps · ${p.codec || '?'}${p.hasAudio ? ' · 有音频' : ' · 无音频'}`;
                                }
                                renderEstimate(en); // 估算依赖 probe 数据, 到位后补显示
                            }
                        }).catch(() => {});
                    }
                }
                entries.forEach(renderRow);
                // 弹窗打开即开始图片预压 (初始档位), est 随结果逐行补上
                entries.forEach((en) => { if (en.kind === 'image') schedulePreview(en); });

                // ---- 底部按钮 ----
                function footerHtml() {
                    if (phase === 'settings') {
                        return `<button class="btn" id="cmpSkip">跳过压缩，直接上传</button>
                                <button class="btn" id="cmpCancel">取消</button>
                                <button class="btn btn-primary" id="cmpGo">开始压缩</button>`;
                    }
                    if (phase === 'running') {
                        return `<button class="btn" id="cmpCancel">取消</button>`;
                    }
                    return `<button class="btn" id="cmpCancel">取消</button>
                            <button class="btn btn-primary" id="cmpUpload">开始上传</button>`;
                }
                function renderFooter() {
                    footer.innerHTML = footerHtml();
                    const go = footer.querySelector('#cmpGo');
                    if (go) go.addEventListener('click', () => runAll());
                    const skip = footer.querySelector('#cmpSkip');
                    if (skip) skip.addEventListener('click', () => finish(files.slice()));
                    const upload = footer.querySelector('#cmpUpload');
                    if (upload) upload.addEventListener('click', () => finish(collectFinal()));
                    const cancel = footer.querySelector('#cmpCancel');
                    if (cancel) cancel.addEventListener('click', () => cancelAll());
                }
                function close() {
                    signal.cancel();
                    overlay.remove();
                    document.removeEventListener('keydown', onKey, true);
                }
                function finish(list) { close(); resolve(list); }
                function cancelAll() { finish(null); }
                function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); cancelAll(); } }
                document.addEventListener('keydown', onKey, true);
                overlay.querySelector('#cmpClose').addEventListener('click', () => cancelAll());

                // ---- 执行 ----
                async function runAll() {
                    phase = 'running';
                    previewSeq++;            // 在途图片预压作废: 回调不得再触碰 UI;
                    previewQueue.length = 0; // 已完成的结果由 compressOne 按档位决定是否复用
                    $('cmpSettings').style.display = 'none';
                    renderFooter();
                    const opts = {
                        imgMaxEdge: imgSel.value === 'original' ? 0 : parseInt(imgSel.value, 10),
                        vidMaxEdge: vidSel.value === 'original' ? 0 : parseInt(vidSel.value, 10),
                        quality: qSel.value,
                    };
                    for (const en of entries) {
                        if (signal.canceled) return;
                        const sub = en.row.querySelector('.cmp-row-sub');
                        const bar = en.row.querySelector('.cmp-row-bar');
                        const fill = en.row.querySelector('.cmp-row-bar-fill');
                        bar.style.display = 'block';
                        sub.textContent = '等待处理…';
                        try {
                            const r = await compressOne(en, opts, (p) => {
                                fill.style.width = Math.round(clamp(p || 0, 0, 1) * 100) + '%';
                                sub.textContent = '压缩中 ' + Math.round(clamp(p || 0, 0, 1) * 100) + '%';
                            }, signal);
                            if (signal.canceled) return;
                            // 图片结果是纯内存 blob, 没有 OPFS 缓存 → 补写一份, 让压缩产物
                            // 与视频一样具备"刷新后恢复续传"的能力 (写失败则退化原样)
                            if (r && r.blob && !r.cacheName) {
                                const cn = newCacheName(en.file.name);
                                if (await opfsWriteBlob(cn, r.blob)) r.cacheName = cn;
                            }
                            en.result = r;
                            en.checked = r.size < en.file.size; // 无收益默认不采用
                        } catch (e) {
                            if (signal.canceled) return;
                            en.error = (e && e.message) || '压缩失败';
                        }
                    }
                    if (signal.canceled) return;
                    phase = 'result';
                    renderResults();
                    renderFooter();
                }

                function renderResults() {
                    for (const en of entries) {
                        const row = en.row;
                        const sub = row.querySelector('.cmp-row-sub');
                        const bar = row.querySelector('.cmp-row-bar');
                        bar.style.display = 'none';
                        if (en.result) {
                            const saved = en.file.size - en.result.size;
                            const pct = en.file.size ? Math.round(saved / en.file.size * 100) : 0;
                            const engineName = { canvas: '重编码', webcodecs: 'WebCodecs', mediarecorder: '兼容模式', ffmpeg: 'FFmpeg' }[en.result.engine] || en.result.engine;
                            sub.innerHTML = `<label class="cmp-check"><input type="checkbox" ${en.checked ? 'checked' : ''}> 使用压缩版</label>`
                                + `<span class="cmp-result">${fmtSize(en.file.size)} → ${fmtSize(en.result.size)}（省 ${pct}%）· ${engineName}</span>`;
                            if (en.note) sub.innerHTML += `<span class="cmp-warn">${esc(en.note)}</span>`;
                            const cb = sub.querySelector('input');
                            cb.addEventListener('change', () => { en.checked = cb.checked; });
                        } else {
                            sub.innerHTML = `<label class="cmp-check"><input type="checkbox" checked disabled> 原样上传</label>`
                                + `<span class="cmp-err">${esc(en.error || '无法压缩')}</span>`;
                        }
                    }
                }

                function collectFinal() {
                    const out = [];
                    for (const f of files) {
                        const en = entryByFile.get(f);
                        if (en && en.result && en.checked) {
                            const file = new File([en.result.blob], en.outName || en.result.name || f.name, {
                                type: en.result.mime || 'application/octet-stream',
                                lastModified: Date.now(),
                            });
                            if (en.result.cacheName) file.compressCache = en.result.cacheName;
                            out.push(file);
                        } else {
                            out.push(f);
                        }
                    }
                    return out;
                }

                renderFooter();
            });
        },
    };

    // ---------------- 挂载 ----------------
    window.Compress = {
        // 供 upload.js / imagehost.js 的刷新恢复使用
        restoreCachedFile,
        deleteCachedFile: opfsDelete,
        compressible: (f) => !!kindOf(f),
    };
    window.CompressUI = CompressUI;
})();
