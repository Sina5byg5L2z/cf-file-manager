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
        return res.json();
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

    // Files
    listFiles(path = '') {
        return this.json('GET', `/api/files?path=${encodeURIComponent(path)}`);
    },
    async downloadFile(path, size, onProgress) {
        // 免费版 10ms CPU: 服务端 Range 窗口封顶 1MB, 大文件无法单请求下载
        // 策略: 并发分块 + 逐块自动重试 (边缘连接长链路串行会被掐断, 任何一段抖动只重试该段)
        const BIG = 4 * 1024 * 1024;
        if (!size || size <= BIG) {
            const a = document.createElement('a');
            a.href = `/api/files/download?path=${encodeURIComponent(path)}&token=${this.token}`;
            a.download = '';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            return;
        }
        const url = `/api/files/download?path=${encodeURIComponent(path)}&token=${this.token}`;
        const W = 1024 * 1024; // 预期窗口 1MB; 服务端窗口更小时按 Content-Range 实际返回自适应补拉
        const map = new Map(); // start -> Uint8Array
        const pending = [];
        for (let s = 0; s < size; s += W) pending.push(s);
        let nextIdx = 0;
        const total = pending.length;

        const worker = async () => {
            for (;;) {
                const i = nextIdx++;
                if (i >= pending.length) return;
                const s = pending[i];
                for (let attempt = 0; ; attempt++) {
                    try {
                        const res = await fetch(url, { headers: { Range: `bytes=${s}-` } });
                        if (res.status !== 206 && !res.ok) throw new Error(`HTTP ${res.status}`);
                        const buf = new Uint8Array(await res.arrayBuffer());
                        if (!buf.length) throw new Error('空响应');
                        const cr = res.headers.get('Content-Range'); // bytes s-e/total
                        if (!cr) throw new Error('缺少 Content-Range');
                        const seg = cr.split(/[-/ ]/); // [bytes, start, end, total]
                        if (parseInt(seg[1], 10) !== s) throw new Error('范围错位');
                        const end = parseInt(seg[2], 10);
                        map.set(s, buf);
                        if (onProgress) onProgress(map.size / total);
                        if (end + 1 < s + W && end + 1 < size) pending.push(end + 1); // 服务端窗口被封顶得更小 → 补拉余量
                        break;
                    } catch (e) {
                        if (attempt >= 4) throw new Error(`下载中断 (bytes=${s}, ${e.message})`);
                        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: 3 }, worker)); // 并发 3, 避免触发限流

        const parts = [];
        for (let s = 0; s < size;) {
            const buf = map.get(s);
            if (!buf) throw new Error('下载数据缺失');
            parts.push(buf);
            s += buf.length;
        }
        const blob = new Blob(parts);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = path.split('/').pop() || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
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
    deleteFile(path) { return this.request('DELETE', `/api/files?path=${encodeURIComponent(path)}`); },
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

    // Chunked upload
    async uploadInit(path, filename, totalChunks) {
        const res = await this.request('POST', '/api/files/upload/init', { path, filename, total_chunks: totalChunks });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Upload init failed');
        }
        return res.json();
    },
    async uploadChunk(uploadId, chunkIndex, chunkData) {
        const fd = new FormData();
        fd.append('upload_id', uploadId);
        fd.append('chunk_index', String(chunkIndex));
        fd.append('data', new Blob([chunkData]));
        const res = await this.request('POST', '/api/files/upload/chunk', fd);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Chunk upload failed');
        }
        return res.json();
    },
    async uploadComplete(uploadId) {
        const res = await this.request('POST', '/api/files/upload/complete', { upload_id: uploadId });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Upload complete failed');
        }
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

    // Search
    search(q, path = '') { return this.json('GET', `/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(path)}`); },

    // Image Host
    importToImageHost(path) { return this.json('POST', '/api/image-host/import', { path }); },
    async ihUploadInit(filename, totalChunks) {
        const res = await this.request('POST', '/api/image-host/upload/init', { filename, total_chunks: totalChunks });
        if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); throw new Error(err.error || 'Upload init failed'); }
        return res.json();
    },
    async ihUploadChunk(uploadId, chunkIndex, chunkData) {
        const fd = new FormData();
        fd.append('upload_id', uploadId);
        fd.append('chunk_index', String(chunkIndex));
        fd.append('data', new Blob([chunkData]));
        const res = await this.request('POST', '/api/image-host/upload/chunk', fd);
        if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); throw new Error(err.error || 'Chunk upload failed'); }
        return res.json();
    },
    async ihUploadComplete(uploadId) {
        const res = await this.request('POST', '/api/image-host/upload/complete', { upload_id: uploadId });
        if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); throw new Error(err.error || 'Upload complete failed'); }
        return res.json();
    },

    // Shares
    createShare(path, password, expireHours) { return this.json('POST', '/api/share', { path, password, expire_hours: expireHours }); },
    listShares() { return this.json('GET', '/api/shares'); },
    deleteShare(id) { return this.request('DELETE', `/api/share/${id}`); },
};
