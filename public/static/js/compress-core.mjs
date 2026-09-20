// compress-core.mjs — 视频转码内核 (mediabunny / WebCodecs), worker 与主线程兜底共用
//
// 选型依据 (2026-09-20):
//   * 编码走 WebCodecs VideoEncoder —— 真正的压缩由浏览器/系统硬件编码器执行,
//     JS/WASM 只是编排层, 所以第一级不用 ffmpeg.wasm (纯软件编码, 慢且 core 30MB)。
//   * 编码器探测用 getFirstEncodableVideoCodec(codecs, {width,height,bitrate,frameRate})
//     —— 其内部即 VideoEncoder.isConfigSupported 具体配置探测, 而非仅查 API 存在。
//   * 全程流式: Input 逐包解 → 逐帧编 → StreamTarget 增量写 OPFS, 输出字节不进 JS 堆;
//     仅 OPFS 不可用/主线程老浏览器时回落 BufferTarget(内存)。
//   * fastStart: 预估输出 ≤128MB 用 'in-memory'(moov 前置, 播放体验最好, 但 media chunks
//     攒内存); 更大用 false(moov 在尾部, 单调写, 内存最省)。'reserve' 需要
//     maximumPacketCount(事先未知总帧数)故不用; 'fragmented' 兼容性弱于普通 MP4 故不用。
//   * 硬件加速两级尝试: 'prefer-hardware' 失败(个别怪尺寸/驱动)自动重试 'no-preference',
//     仍失败才抛给上层降级链。注意 Output 是一次性状态机、WritableStream 只能锁一次,
//     所以每次尝试都通过 opts.makeWritable() 全新构建 sink, 绝不复用。
//
// API 均按 mediabunny 1.58.1 的 dist/mediabunny.d.ts 核对, 非凭记忆。
import {
    Input, Output, BlobSource, BufferTarget, StreamTarget,
    Mp4OutputFormat, ALL_FORMATS, Conversion,
    getFirstEncodableVideoCodec,
} from '/static/vendor/mediabunny.min.mjs';

// 质量档位 → 每像素每帧比特数 (bpp): 1080p30 高质量 ≈ 7.5Mbps, 均衡 ≈ 5Mbps, 高压缩 ≈ 3.1Mbps
export const VIDEO_QUALITY_BPP = { high: 0.12, medium: 0.08, low: 0.05 };
export const AUDIO_BITRATE = 128000; // 音频统一 128kbps

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function even(n) { const r = Math.round(n); return r - (r % 2); }

// 元数据探测: 不解帧, 只读容器头。返回 {ok:true,...} 或 {ok:false, reason}
export async function probeVideo(file) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
        const fmt = await input.getFormat();
        const vt = await input.getPrimaryVideoTrack();
        if (!vt) return { ok: false, reason: 'no-video-track' };
        const [codec, w, h, stats] = await Promise.all([
            vt.getCodec(), vt.getDisplayWidth(), vt.getDisplayHeight(), vt.computePacketStats(48),
        ]);
        const at = await input.getPrimaryAudioTrack();
        const audioCodec = at ? await at.getCodec() : null;
        const duration = await input.getDurationFromMetadata().catch(() => null);
        return {
            ok: true,
            format: (fmt && fmt.name) || '',
            codec, width: w, height: h,
            fps: clamp(Math.round(stats.averagePacketRate || 30), 1, 60),
            srcBitrate: stats.averageBitrate || 0,
            durationSec: duration || (stats.packetCount / (stats.averagePacketRate || 30)),
            hasAudio: !!at, audioCodec,
        };
    } catch (e) {
        return { ok: false, reason: (e && e.message) || 'parse-failed' };
    }
}

// 视频分辨率目标: 约束「短边」到 maxEdge (横屏压高度、竖屏压宽度, 与 720P/1080P 习惯一致), 只降不升。
// 返回 {} 表示保持原尺寸。(图片压缩用「长边」约定, 与此处不同, 见 compress.js。)
export function videoTargetDims(width, height, maxEdge) {
    if (!maxEdge || maxEdge <= 0) return {};
    if (width <= height) {
        const w = even(Math.min(width, maxEdge));
        return w < width ? { width: w } : {};
    }
    const h = even(Math.min(height, maxEdge));
    return h < height ? { height: h } : {};
}

// 目标码率 = 宽×高×fps×bpp, 夹在 [200kbps, 24Mbps]
export function estimateBitrate(w, h, fps, quality) {
    const bpp = VIDEO_QUALITY_BPP[quality] || VIDEO_QUALITY_BPP.high;
    return clamp(Math.round(w * h * fps * bpp), 200000, 24000000);
}

// 执行转码。返回 {size, buffer?, codec, engine:'webcodecs'}
// opts: {
//   maxEdge: 0|1080|720|480|360 (0/缺省 = 原尺寸),
//   quality: 'high'|'medium'|'low',
//   makeWritable?: async () => WritableStream<StreamTargetChunk>  // 流式输出; 每次尝试都会调用, 必须返回全新流(位置 0 起)
// }
// onProgress: (0..1) => void
// cancelRef: {cancel} — 会被赋值为可中断函数 (ConversionCanceledError 原样抛出)
export async function convertVideo(file, opts, onProgress, cancelRef) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) { const e = new Error('文件中没有视频轨道'); e.code = 'no-video-track'; throw e; }
    const [w0, h0, stats] = await Promise.all([
        vt.getDisplayWidth(), vt.getDisplayHeight(), vt.computePacketStats(48),
    ]);
    const fps = clamp(Math.round(stats.averagePacketRate || 30), 1, 60);
    const at = await input.getPrimaryAudioTrack();
    const duration = Math.max(0.1,
        (await input.getDurationFromMetadata().catch(() => null)) || (stats.packetCount / (stats.averagePacketRate || 30)));

    const dims = videoTargetDims(w0, h0, opts.maxEdge);
    const tw = dims.width || w0, th = dims.height || h0;
    const vBitrate = estimateBitrate(tw, th, fps, opts.quality);

    // 编码器探测: 具体到 目标分辨率+码率+帧率 (内部即 isConfigSupported 具体配置探测)
    const outCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'av1', 'vp9'], {
        width: tw, height: th, bitrate: vBitrate, frameRate: fps,
    });
    if (!outCodec) { const e = new Error('浏览器缺少可用的视频编码器'); e.code = 'no-encoder'; throw e; }

    const audio = at ? { bitrate: AUDIO_BITRATE } : { discard: true };
    const estOut = ((vBitrate + (at ? AUDIO_BITRATE : 0)) / 8) * duration;
    const fastStart = estOut <= 128 * 1024 * 1024 ? 'in-memory' : false;

    let lastErr = null;
    // 硬件优先, 失败自动重试软件偏好; 两次都失败才交给上层降级链
    for (const ha of ['prefer-hardware', 'no-preference']) {
        try {
            return await runOnce(ha);
        } catch (e) {
            if (isCanceled(e)) throw e;
            lastErr = e;
        }
    }
    throw lastErr || new Error('转码失败');

    async function runOnce(hardwareAcceleration) {
        let written = 0;
        let target;
        // makeWritable 可能返回 null(worker 里 OPFS 打不开) → 回落 BufferTarget 内存路径
        let sink = null;
        if (opts.makeWritable) {
            sink = await opts.makeWritable().catch(() => null);
        }
        if (sink) {
            const writer = sink.getWriter();
            target = new StreamTarget(new WritableStream({
                async write(chunk) { written += chunk.data.byteLength; await writer.write(chunk); },
                async close() { try { await writer.close(); } catch { /* 已关 */ } },
                async abort() { try { await writer.abort(); } catch { /* 已断 */ } },
            }), { chunked: true, chunkSize: 4194304 });
        } else {
            target = new BufferTarget();
        }
        const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target });
        const conversion = await Conversion.init({
            input, output,
            video: { ...dims, bitrate: vBitrate, codec: outCodec, forceTranscode: true, hardwareAcceleration },
            audio,
        });
        if (cancelRef) cancelRef.cancel = () => conversion.cancel();
        conversion.onProgress = (p) => { try { if (onProgress) onProgress(p); } catch { /* 进度回调异常不影响转码 */ } };
        if (!conversion.isValid) {
            const e = new Error('转换配置不可用（轨道/编码不兼容）'); e.code = 'invalid';
            throw e;
        }
        await conversion.execute();
        const size = sink ? written : (target.buffer ? target.buffer.byteLength : 0);
        return { size, buffer: sink ? undefined : target.buffer, codec: outCodec, engine: 'webcodecs' };
    }
}

function isCanceled(e) {
    return !!e && (e.name === 'ConversionCanceledError' || /cancel/i.test(String(e && e.name)) || e.code === 'canceled');
}
