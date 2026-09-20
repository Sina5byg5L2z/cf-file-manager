// compress-video-worker.mjs — 视频转码 module worker
//
// 为什么放 worker (2026-09-20 定): 解封装/封装的 JS 开销与输出写盘全部离主线程,
// 界面零卡顿; 编解码本身走 WebCodecs (浏览器内部线程 + GPU), 本就不占 JS 线程。
// MediaRecorder 兜底层因依赖 HTMLVideoElement/captureStream 只能留主线程, 见 compress.js。
//
// 协议 (postMessage):
//   入: {cmd:'probe',   id, file}
//       {cmd:'convert', id, file, opts:{maxEdge, quality}, cacheName}
//   出: {id, type:'probe',    data}
//       {id, type:'progress', p}            // 0..1
//       {id, type:'done',     data}         // {size, buffer?, codec, engine, cacheName}
//       {id, type:'error',    message, code}
// 取消: 主线程直接 terminate 本 worker + 清 OPFS 残留, 无需优雅协议。
import { probeVideo, convertVideo } from './compress-core.mjs?v=20260920a';

// OPFS 流式写入。makeWritable 语义: 每次调用返回「从 0 开始的全新 WritableStream」
// (转码内核硬件失败会换软件偏好重试, Output/WritableStream 都不可复用, 所以必须可重开)。
// 失败返回 null → 内核自动走 BufferTarget 内存路径。
async function openOpfsWrite(cacheName) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('compress-cache', { create: true });
    // 重试语义: 每次都从空文件开始 (上一轮尝试可能写过一半)
    try { await dir.removeEntry(cacheName); } catch { /* 不存在即目标状态 */ }
    const fh = await dir.getFileHandle(cacheName, { create: true });
    if (typeof fh.createSyncAccessHandle === 'function') {
        // worker 专属 API, 最快且兼容到 Safari 15.2
        const h = await fh.createSyncAccessHandle();
        let closed = false;
        const closeOnce = () => {
            if (closed) return;
            closed = true;
            try { h.flush(); } catch { /* 已关 */ }
            try { h.close(); } catch { /* 已关 */ }
        };
        return new WritableStream({
            write(chunk) { h.write(chunk.data, { at: chunk.position }); },
            close() { closeOnce(); },
            abort() { closeOnce(); },
        });
    }
    return await fh.createWritable();
}

self.onmessage = async (e) => {
    const { cmd, id, file, opts, cacheName } = e.data || {};
    try {
        if (cmd === 'probe') {
            const data = await probeVideo(file);
            self.postMessage({ id, type: 'probe', data });
            return;
        }
        if (cmd === 'convert') {
            const data = await convertVideo(file, {
                maxEdge: opts.maxEdge || 0,
                quality: opts.quality || 'high',
                // OPFS 打不开 → 返回 null → 内核走内存 BufferTarget, 结果经 buffer 回传
                makeWritable: () => openOpfsWrite(cacheName).catch(() => null),
            }, (p) => {
                self.postMessage({ id, type: 'progress', p });
            }, null);
            data.cacheName = cacheName || null;
            self.postMessage({ id, type: 'done', data }, data.buffer ? [data.buffer] : []);
            return;
        }
    } catch (err) {
        self.postMessage({
            id, type: 'error',
            message: String((err && err.message) || err || '转码失败'),
            code: (err && err.code) || undefined,
        });
    }
};
