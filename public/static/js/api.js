// API wrapper with JWT management
const API = {
    token: localStorage.getItem('token'),

    setToken(t) { this.token = t; localStorage.setItem('token', t); },
    clearToken() { this.token = null; localStorage.removeItem('token'); localStorage.removeItem('username'); },

    headers(extra = {}) {
        const h = { ...extra };
        if (this.token) h['Authorization'] = 'Bearer ' + this.token;
        return h;
    },

    async request(method, url, body, extraHeaders = {}) {
        const opts = { method, headers: this.headers(extraHeaders) };
        if (body !== undefined) {
            if (body instanceof FormData) {
                opts.body = body; // multipart
            } else {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(body);
            }
        }
        const res = await fetch(url, opts);
        if (res.status === 401) {
            this.clearToken();
            window.location.href = '/';
            throw new Error('Unauthorized');
        }
        return res;
    },

    async json(method, url, body) {
        const res = await this.request(method, url, body);
        let data = null;
        try {
            data = await res.json();
        } catch {
            // 非 JSON 响应 (边缘错误页 1102/5xx 等): 统一成 Error 并在 message 里带状态码
            const e = new Error(`${method} ${url} 请求失败 (HTTP ${res.status})`);
            e.status = res.status;
            throw e;
        }
        // 后端错误一律以 {error: "..."} 形式返回, 状态码非 2xx:
        // 必须在这里抛出, 否则调用方拿到的是 {error} 对象而不是预期数据,
        // 后续取值会抛 "Cannot read properties of undefined" 这类二次错误, 掩盖真实原因。
        if (!res.ok) {
            const e = new Error((data && data.error) || `${method} ${url} 请求失败 (HTTP ${res.status})`);
            e.status = res.status;
            e.data = data;
            // 存储容量不足 (分库): 交给统一告警按「名额池」做三态引导。
            // 不吞异常 —— 调用方的 catch 照常收到, 这里只是多挂一个引导入口。
            if (data && data.code === 'D1_CAPACITY' && window.StorageUI) {
                try { StorageUI.handleError(e); } catch (err) { /* 告警失败不影响主流程 */ }
            }
            throw e;
        }
        return data;
    },

    // Auth
    login(username, password) { return this.json('POST', '/api/login', { username, password }); },
    me() { return this.json('GET', '/api/me'); },

    // Account
    changePassword(oldPassword, newPassword) {
        return this.json('POST', '/api/account/password', { old_password: oldPassword, new_password: newPassword });
    },
    changeUsername(newUsername) {
        return this.json('POST', '/api/account/username', { new_username: newUsername });
    },

    // App parameter settings (chunk size / concurrency / per-device limits)
    getSettings() { return this.json('GET', '/api/settings'); },
    saveSettings(settings) { return this.json('PUT', '/api/settings', settings); },

    // Storage sharding (库注册表 / 一键扩容 / 注册新库 / 容量校准)
    getStorage() { return this.json('GET', '/api/storage'); },
    enableStorage() { return this.json('POST', '/api/storage/enable', {}); },
    registerStorage(binding, databaseId) { return this.json('POST', '/api/storage/register', { binding, database_id: databaseId || '' }); },
    calibrateStorage() { return this.json('POST', '/api/storage/calibrate', {}); },
    updateStorage(id, patch) { return this.json('PUT', `/api/storage/${id}`, patch); },

    // Files
    listFiles(path = '') {
        return this.json('GET', `/api/files?path=${encodeURIComponent(path)}`);
    },
    // ---- 下载 ----
    // 单次 Range 窗口: 服务端按「参数设置 → 单次下载窗口」封顶, 这里取同一值切段
    _dlWindow() {
        try {
            // 顶层 const 不进 window, 用 typeof 判断 (window.AppSettings 恒为 undefined)
            const v = (typeof AppSettings !== 'undefined' && AppSettings.downloadRange) ? AppSettings.downloadRange() : null;
            if (Number.isFinite(v) && v >= 1048576) return v;
        } catch (e) { /* 未加载设置时用默认 */ }
        return 8 * 1024 * 1024;
    },
    // 用 1 字节 Range 探测总大小 (Content-Range: bytes 0-0/<total>)
    async probeSize(url) {
        const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        const cr = res.headers.get('Content-Range');
        if (cr && cr.includes('/')) {
            const t = parseInt(cr.split('/')[1], 10);
            if (Number.isFinite(t)) return t;
        }
        const len = res.headers.get('Content-Length');
        return len ? parseInt(len, 10) : NaN;
    },
    _saveBlob(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    },
    _directDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    },
    // 分片下载。完整性一律以"文件总大小"为准, 三道校验:
    //   ① 响应声明总长 (Content-Range 的 /total) = 已知总长;
    //   ② 每段实际字节数 = 该段承诺长度;
    //   ③ 拼装后 blob.size = 已知总长 —— 不等就报错, 绝不当成功交出残缺文件。
    // 单段失败折半窗口重试(最小 1MiB): 平台在 CPU 上限处会静默截断, 只有小窗口能救回来。
    async _rangeDownload(url, total, onProgress) {
        const MAX_W = this._dlWindow(), MIN_W = 1024 * 1024, CONC = 3;
        const chunks = [];
        for (let s = 0; s < total; s += MAX_W) chunks.push({ start: s, end: Math.min(s + MAX_W, total) });
        const parts = new Array(chunks.length);
        let got = 0, next = 0;

        const worker = async () => {
            for (;;) {
                const i = next++;
                if (i >= chunks.length) return;
                const c = chunks[i];
                const piece = [];
                let p = c.start, len = MAX_W;
                while (p < c.end) {
                    for (let attempt = 0; ; attempt++) {
                        try {
                            const want = Math.min(p + len, c.end);
                            const res = await fetch(url, { headers: { Range: `bytes=${p}-${want - 1}` } });
                            if (res.status !== 206 && !res.ok) throw new Error(`HTTP ${res.status}`);
                            const buf = new Uint8Array(await res.arrayBuffer());
                            const cr = res.headers.get('Content-Range'); // bytes start-end/total
                            if (!cr) throw new Error('缺少 Content-Range');
                            const seg = cr.split(/[-/ ]/); // [bytes, start, end, total]
                            const declared = parseInt(seg[3], 10);
                            if (Number.isFinite(declared) && declared !== total) {
                                throw new Error(`文件大小与预期不符（服务端 ${declared} / 预期 ${total} 字节）`);
                            }
                            if (parseInt(seg[1], 10) !== p) throw new Error('范围错位');
                            const end = Math.min(parseInt(seg[2], 10), c.end - 1);
                            if (buf.length !== end - p + 1) throw new Error(`响应被截断（${buf.length}/${end - p + 1} 字节）`);
                            piece.push(buf);
                            got += buf.length;
                            if (onProgress) onProgress(got / total);
                            p = end + 1; // 服务端窗口更小时也照此续拉
                            break;
                        } catch (e) {
                            if (attempt >= 4) throw new Error(`从第 ${p} 字节起下载失败：${e.message}`);
                            len = Math.max(MIN_W, len >> 1); // 折半窗口, 降低单次 CPU
                            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                        }
                    }
                }
                parts[i] = piece;
            }
        };
        await Promise.all(Array.from({ length: CONC }, worker));

        const blob = new Blob(parts.flat());
        if (blob.size !== total) throw new Error(`下载不完整：实收 ${blob.size} / 应有 ${total} 字节，已放弃保存`);
        return blob;
    },
    async downloadFile(path, size, onProgress) {
        const url = `/api/files/download?path=${encodeURIComponent(path)}&token=${this.token}`;
        const name = path.split('/').pop() || 'download';
        try {
            let total = parseInt(size, 10);
            if (!Number.isFinite(total) || total <= 0) total = await this.probeSize(url); // 调用方没带大小时先探测
            if (!Number.isFinite(total)) throw new Error('读不到文件大小，无法校验完整性');
            if (total <= 4 * 1024 * 1024) { this._directDownload(url); return; } // 小文件走浏览器原生下载
            this._saveBlob(await this._rangeDownload(url, total, onProgress), name);
        } catch (e) {
            // 下载失败必须让用户看见 (之前未捕获的 Promise 会静默吞掉, 只留下半个文件)
            const msg = `下载失败：${(e && e.message) || '未知错误'}`;
            if (window.Dialog && window.Dialog.alert) window.Dialog.alert(msg); else window.alert(msg);
        }
    },
    uploadFile(path, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/files/upload?path=${encodeURIComponent(path)}`);
            xhr.setRequestHeader('Authorization', 'Bearer ' + this.token);
            xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
            xhr.onload = () => resolve(JSON.parse(xhr.responseText));
            xhr.onerror = () => reject(new Error('Upload failed'));
            xhr.send(formData);
        });
    },
    mkdir(path, name) { return this.json('POST', '/api/files/mkdir', { path, name }); },
    // 删除被图床引用的文件时后端返回 409 {error}, 必须走 json() 才不会被当成成功吞掉
    deleteFile(path) { return this.json('DELETE', `/api/files?path=${encodeURIComponent(path)}`); },
    rename(path, newName) { return this.json('PUT', '/api/files/rename', { path, new_name: newName }); },
    moveFile(from, to) { return this.json('PUT', '/api/files/move', { from, to }); },
    copyFile(from, to) { return this.json('PUT', '/api/files/copy', { from, to }); },
    batchDelete(paths) { return this.json('POST', '/api/files/batch-delete', { paths }); },
    batchDownload(paths) {
        // Use form submission for streaming download (avoids buffering entire zip in memory)
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/api/files/batch-download';
        form.style.display = 'none';
        // Auth token
        const tokenInput = document.createElement('input');
        tokenInput.type = 'hidden';
        tokenInput.name = 'token';
        tokenInput.value = this.token || '';
        form.appendChild(tokenInput);
        // Paths
        const pathsInput = document.createElement('input');
        pathsInput.type = 'hidden';
        pathsInput.name = 'paths';
        pathsInput.value = JSON.stringify(paths);
        form.appendChild(pathsInput);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    },

    // 上传类请求的统一错误构造: 边缘 1102/502/524 等返回的是 HTML 错误页而非项目 JSON,
    // res.json() 会失败。此时必须保留 HTTP 状态码, 否则前端只看到一句
    // "Chunk upload failed", 无法判断该重试还是该报错。
    async _uploadError(res, fallback) {
        let msg = '';
        try {
            const j = await res.json();
            msg = (j && j.error) || '';
        } catch { /* 非 JSON: 边缘错误页 */ }
        const e = new Error(msg || `${fallback} (HTTP ${res.status})`);
        e.status = res.status;
        return e;
    },
    // Chunked upload (支持断点续传: 传 file_key/chunk_size, 服务端命中则复用已传分片)
    async uploadInit(path, filename, totalChunks, opts = {}) {
        const body = { path, filename, total_chunks: totalChunks };
        if (opts.fileKey) body.file_key = opts.fileKey;
        if (opts.fileSize) body.file_size = opts.fileSize;
        if (opts.chunkSize) body.chunk_size = opts.chunkSize;
        const res = await this.request('POST', '/api/files/upload/init', body);
        if (!res.ok) throw await this._uploadError(res, '初始化上传失败');
        return res.json();
    },
    // 查询会话已传分片 (页面刷新/换设备后恢复进度)
    uploadStatus(uploadId) {
        return this.json('GET', `/api/files/upload/status?upload_id=${encodeURIComponent(uploadId)}`);
    },
    async uploadChunk(uploadId, chunkIndex, chunkData, chunkHash) {
        const fd = new FormData();
        fd.append('upload_id', uploadId);
        fd.append('chunk_index', String(chunkIndex));
        if (chunkHash) fd.append('chunk_hash', chunkHash);
        fd.append('data', new Blob([chunkData]));
        const res = await this.request('POST', '/api/files/upload/chunk', fd);
        if (!res.ok) throw await this._uploadError(res, '分片上传失败');
        return res.json();
    },
    // 分批合并: 首次不传 batch, 之后回传上一次的 next, 直到 done:true
    async uploadComplete(uploadId, batch) {
        const body = { upload_id: uploadId };
        if (batch) body.batch = batch;
        const res = await this.request('POST', '/api/files/upload/complete', body);
        if (!res.ok) throw await this._uploadError(res, '合并分片失败');
        return res.json();
    },
    // 放弃一个未完成的上传 (清服务端暂存分片 + 会话); 幂等
    async uploadAbort(uploadId) {
        const res = await this.request('POST', '/api/files/upload/abort', { upload_id: uploadId });
        if (!res.ok) throw await this._uploadError(res, '取消上传失败');
        return res.json();
    },

    // Preview — returns JSON for text files, throws for binary
    async preview(path) {
        const res = await this.request('GET', `/api/preview?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Preview failed');
        }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            return res.json();
        }
        // Binary response — return structured object for caller to handle
        const blob = await res.blob();
        return { type: 'binary', url: URL.createObjectURL(blob), mime: ct };
    },
    previewUrl(path) { return `/api/preview?path=${encodeURIComponent(path)}&token=${this.token}`; },
    thumbnailUrl(path) { return `/api/thumbnail?path=${encodeURIComponent(path)}&token=${this.token}`; },
    // 回写前端生成的缩略图 (canvas 压缩的小 JPEG)
    async uploadThumbnail(path, blob) {
        const fd = new FormData();
        fd.append('path', path);
        fd.append('data', blob, 'thumb.jpg');
        const res = await this.request('POST', '/api/thumbnail', fd);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '缩略图上传失败');
        return res.json();
    },

    // Video transcoding (resolution selection)
    videoQualities(path) { return this.json('GET', `/api/video/qualities?path=${encodeURIComponent(path)}`); },
    videoPrepare(path, quality) { return this.json('GET', `/api/video/prepare?path=${encodeURIComponent(path)}&quality=${quality}`); },
    videoUrl(path, quality) { return `/api/video?path=${encodeURIComponent(path)}&quality=${quality}&token=${this.token}`; },

    // Music — 歌曲元数据 (用户编辑的标题/歌手/歌词, 覆盖内嵌标签与文件名)
    trackMeta(path) { return this.json('GET', `/api/track/meta?path=${encodeURIComponent(path)}`); },
    saveTrackMeta(payload) { return this.json('PUT', '/api/track/meta', payload); },
    // Music — 歌词代理 (Worker 转发, 前端另有 IndexedDB 缓存)
    lyrics(path, opts = {}) {
        const p = new URLSearchParams({ path });
        if (opts.duration) p.set('duration', String(Math.round(opts.duration)));
        if (opts.title) p.set('title', opts.title);
        if (opts.artist) p.set('artist', opts.artist);
        return this.json('GET', `/api/lyrics?${p}`);
    },
    // 歌词拉黑: source 省略且 all=true → 链上剩余来源全部拉黑; duration/title/artist 供服务端清缓存定位键
    lyricsReject(path, opts = {}) {
        return this.json('POST', '/api/lyrics/reject', {
            path,
            source: opts.source || '',
            all: !!opts.all,
            duration: opts.duration || 0,
            title: opts.title || '',
            artist: opts.artist || '',
        });
    },
    lyricsUnreject(path, opts = {}) {
        const p = new URLSearchParams({ path });
        if (opts.duration) p.set('duration', String(Math.round(opts.duration)));
        if (opts.title) p.set('title', opts.title);
        if (opts.artist) p.set('artist', opts.artist);
        return this.request('DELETE', `/api/lyrics/reject?${p}`);
    },
    // 专辑封面在线查找(内嵌封面缺失时的兜底): 网易云(自部署) > Deezer > iTunes, Worker 侧缓存
    cover(path, opts = {}) {
        const p = new URLSearchParams({ path });
        if (opts.title) p.set('title', opts.title);
        if (opts.artist) p.set('artist', opts.artist);
        return this.json('GET', `/api/cover?${p}`);
    },

    // Search
    search(q, path = '') { return this.json('GET', `/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(path)}`); },

    // Image Host
    importToImageHost(path) { return this.json('POST', '/api/image-host/import', { path }); },
    async ihUploadInit(filename, totalChunks, opts = {}) {
        const body = { filename, total_chunks: totalChunks };
        if (opts.fileSize) body.file_size = opts.fileSize;
        if (opts.chunkSize) body.chunk_size = opts.chunkSize;
        const res = await this.request('POST', '/api/image-host/upload/init', body);
        if (!res.ok) throw await this._uploadError(res, '初始化上传失败');
        return res.json();
    },
    ihUploadStatus(uploadId) {
        return this.json('GET', `/api/image-host/upload/status?upload_id=${encodeURIComponent(uploadId)}`);
    },
    async ihUploadChunk(uploadId, chunkIndex, chunkData, chunkHash) {
        const fd = new FormData();
        fd.append('upload_id', uploadId);
        fd.append('chunk_index', String(chunkIndex));
        if (chunkHash) fd.append('chunk_hash', chunkHash);
        fd.append('data', new Blob([chunkData]));
        const res = await this.request('POST', '/api/image-host/upload/chunk', fd);
        if (!res.ok) throw await this._uploadError(res, '分片上传失败');
        return res.json();
    },
    // 分批合并 (同 uploadComplete)
    async ihUploadComplete(uploadId, batch) {
        const body = { upload_id: uploadId };
        if (batch) body.batch = batch;
        const res = await this.request('POST', '/api/image-host/upload/complete', body);
        if (!res.ok) throw await this._uploadError(res, '合并分片失败');
        return res.json();
    },

    // Shares
    createShare(path, password, expireHours) { return this.json('POST', '/api/share', { path, password, expire_hours: expireHours }); },
    listShares() { return this.json('GET', '/api/shares'); },
    deleteShare(id) { return this.request('DELETE', `/api/share/${id}`); },
};

// 顶层 const 不进 window —— 跨文件(trackmeta.js / musicplayer.js 里的 global.API)
// 必须靠这里显式挂载, 否则永远 undefined
window.API = API;
