// Upload manager - chunked upload with pause/resume and concurrent chunks
// 免费版 Workers 单请求 10ms CPU 限制: 2026-09-12 线上持续110片实测(当前D1版代码) —
// 256K/512K 全部并发(4/6/8)通过; 1M×4 通过; 1M×6/8 触发 exceededResources(1102)。
// 并发下 CPU 记账被放大(孤立请求真实 ~1-3ms),限流执行阈值高于名义 10ms。
// 历史注释中 8并发×512KB 触发 1102 为偶发，真实存在但测试未复现。
// 分片大小/并发数已改为"参数设置"可调 (AppSettings, 服务端下发), 默认 512KB×4
// 若复现 1102/503 请在设置中降回 256KB

// ---- 缩略图生成 (前端 canvas, 服务端零 CPU) ----
// 仅浏览器可解码的格式: 图片全部尝试; 视频仅 mp4/m4v/mov/webm/mkv
const THUMB_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const THUMB_VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];

// 统一压成最长边 256px 的 JPEG (source 支持 ImageBitmap / video 元素)
function _drawThumb(source, w, h) {
    const scale = Math.min(1, 256 / Math.max(w, h || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) =>
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.8));
}

// 生成缩略图; 不支持/解码失败返回 null (由网格懒生成或图标回退兜底)
async function makeThumbnail(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
        if (THUMB_IMAGE_EXTS.includes(ext)) {
            const bmp = await createImageBitmap(file);
            try { return await _drawThumb(bmp, bmp.width, bmp.height); }
            finally { if (bmp.close) bmp.close(); }
        }
        if (THUMB_VIDEO_EXTS.includes(ext)) {
            return await new Promise((resolve, reject) => {
                const url = URL.createObjectURL(file);
                const v = document.createElement('video');
                v.muted = true;
                v.preload = 'metadata';
                const fail = (e) => { URL.revokeObjectURL(url); v.removeAttribute('src'); reject(e || new Error('decode failed')); };
                v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); };
                v.onseeked = async () => {
                    try {
                        const blob = await _drawThumb(v, v.videoWidth, v.videoHeight);
                        URL.revokeObjectURL(url);
                        resolve(blob);
                    } catch (e) { fail(e); }
                };
                v.onerror = () => fail();
                setTimeout(() => fail(new Error('thumb timeout')), 20000);
                v.src = url;
            });
        }
    } catch (e) { /* 解码失败 → 无缩略图 */ }
    return null;
}

function _fmtSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

const Upload = {
    tasks: [],
    closeTimer: null,

    uploadFiles(fileList, path) {
        // 单文件上限按当前设备类型取对应档位 (服务端 MAX_UPLOAD_SIZE 是最终兜底)
        const limit = AppSettings.uploadLimit();
        const oversized = [...fileList].filter(f => f.size > limit);
        const files = [...fileList].filter(f => f.size <= limit);
        if (oversized.length) {
            const names = oversized.map(f => f.name).join('、');
            const mb = Math.round(limit / 1048576 * 100) / 100;
            Dialog.alert(`${names} 超过当前设备上传上限 (${mb} MB)，已跳过。可在「参数设置」中调整。`, { title: '文件过大' });
        }
        if (!files.length) return;

        const list = document.getElementById('uploadList');
        const progress = document.getElementById('uploadProgress');
        list.innerHTML = '';
        this.tasks = [];
        progress.style.display = 'block';
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }

        for (const file of files) {
            const id = Date.now() + Math.random();
            // 按文件大小命中分片规则 (先命中先用, 未命中走 DEFAULT)
            const rule = AppSettings.chunkRuleFor(file.size);
            const totalChunks = Math.max(1, Math.ceil(file.size / rule.chunk_size));
            const task = { id, name: file.name, file, path, progress: 0, paused: false, aborted: false, uploadId: null, totalChunks, sentChunks: 0, failed: false, chunkSize: rule.chunk_size, concurrent: rule.concurrent, timeoutRetries: 0 };
            this.tasks.push(task);
            this.renderItem(list, task);
            this.doUpload(task);
        }
    },

    renderItem(list, task) {
        const div = document.createElement('div');
        div.className = 'upload-item';
        div.id = 'upload-' + task.id;
        div.innerHTML = `
            <div class="upload-item-row">
                <span class="upload-item-name" title="${FM.esc(task.name)}">${FM.esc(task.name)}</span>
                <span class="upload-item-status">0%</span>
                <button class="btn btn-xs upload-pause-btn" onclick="Upload.togglePause(${task.id})">暂停</button>
            </div>
            <div class="upload-bar"><div class="upload-bar-fill" style="width:0%"></div></div>
            <div class="upload-item-detail" style="font-size:11px;color:var(--text-tertiary)">0/${task.totalChunks} 分片 (0/${_fmtSize(task.file.size)})</div>
        `;
        list.appendChild(div);
    },

    togglePause(id) {
        const task = this.tasks.find(t => t.id === id);
        if (!task) return;
        task.paused = !task.paused;
        const el = document.getElementById('upload-' + id);
        if (!el) return;
        const btn = el.querySelector('.upload-pause-btn');
        const status = el.querySelector('.upload-item-status');
        if (task.paused) {
            btn.textContent = '继续';
            status.textContent = '已暂停';
        } else {
            btn.textContent = '暂停';
            status.textContent = task.progress + '%';
            this.doUpload(task);
        }
    },

    updateUI(task) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        el.querySelector('.upload-bar-fill').style.width = task.progress + '%';
        el.querySelector('.upload-item-status').textContent = task.progress + '%';
        const uploaded = Math.min(task.sentChunks * task.chunkSize, task.file.size);
        el.querySelector('.upload-item-detail').textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${_fmtSize(uploaded)}/${_fmtSize(task.file.size)})`;
    },

    // Check if error is timeout-related or transient server error (retryable)
    isTimeoutError(e) {
        const msg = (e.message || '').toLowerCase();
        // 网络超时 + Cloudflare 边缘瞬态错误(部署版本切换/源站波动): 缩小分片并自动重试
        return msg.includes('524') || msg.includes('timeout') || msg.includes('network') || msg.includes('failed to fetch')
            || msg.includes('502') || msg.includes('503') || msg.includes('504')
            || msg.includes('521') || msg.includes('522') || msg.includes('523')
            || msg.includes('525') || msg.includes('526') || msg.includes('530')
            || msg.includes('service unavailable') || msg.includes('bad gateway') || msg.includes('gateway timeout');
    },

    // Reduce chunk size; 新会话不含已传数据, 必须全部重发 (标记 received 全 false)
    shrinkChunks(task) {
        const oldSize = task.chunkSize;
        const newSize = Math.max(oldSize / 2, 32 * 1024); // min 32KB
        if (newSize === oldSize) return false;

        const newTotal = Math.max(1, Math.ceil(task.file.size / newSize));

        task.chunkSize = newSize;
        task.totalChunks = newTotal;
        task.received = new Array(newTotal).fill(false);
        task.inflight = new Set();
        task.sentChunks = 0;
        task.progress = 0;
        task.uploadId = null; // need re-init

        // Update UI detail
        const el = document.getElementById('upload-' + task.id);
        const uploaded = Math.min(task.sentChunks * newSize, task.file.size);
        if (el) el.querySelector('.upload-item-detail').textContent = `${task.sentChunks}/${newTotal} 分片 (${_fmtSize(uploaded)}/${_fmtSize(task.file.size)}, ${Math.round(newSize/1024)}KB/片)`;

        return true;
    },

    async doUpload(task) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        const status = el.querySelector('.upload-item-status');
        const btn = el.querySelector('.upload-pause-btn');

        try {
            // Step 1: Init
            if (!task.uploadId) {
                const uploaded = Math.min(task.sentChunks * task.chunkSize, task.file.size);
                status.textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${_fmtSize(uploaded)}/${_fmtSize(task.file.size)})`;
                const initRes = await API.uploadInit(task.path, task.name, task.totalChunks);
                task.uploadId = initRes.upload_id;
            }

            // Step 2: Upload chunks with concurrency
            if (!task.received) {
                task.received = new Array(task.totalChunks).fill(false);
            }
            if (!task.inflight) {
                task.inflight = new Set();
            }

            const uploadOne = async (idx) => {
                const start = idx * task.chunkSize;
                const end = Math.min(start + task.chunkSize, task.file.size);
                const chunk = task.file.slice(start, end);
                const res = await API.uploadChunk(task.uploadId, idx, chunk);
                task.received[idx] = true;
                task.sentChunks = task.received.filter(Boolean).length;
                task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                this.updateUI(task);
            };

            while (true) {
                if (task.paused || task.aborted) return;

                // Collect up to CONCURRENT pending chunks
                const batch = [];
                for (let i = 0; i < task.totalChunks && batch.length < task.concurrent; i++) {
                    if (!task.received[i] && !task.inflight.has(i)) {
                        task.inflight.add(i);
                        batch.push(i);
                    }
                }
                if (batch.length === 0) break;

                let timeoutHit = false;
                await Promise.all(batch.map(async (idx) => {
                    try { await uploadOne(idx); }
                    catch (e) {
                        if (this.isTimeoutError(e) && task.timeoutRetries < 5) {
                            timeoutHit = true;
                        } else {
                            throw e;
                        }
                    } finally {
                        task.inflight.delete(idx);
                    }
                }));

                if (task.paused || task.aborted) return;

                if (timeoutHit && task.timeoutRetries < 5) {
                    task.timeoutRetries++;
                    const oldSize = task.chunkSize;
                    if (this.shrinkChunks(task)) {
                        status.textContent = `超时，缩小分片 ${Math.round(oldSize/1024)}→${Math.round(task.chunkSize/1024)}KB (${task.timeoutRetries}/5)`;
                        this.updateUI(task);
                        throw { _retry: true };
                    }
                }
            }

            if (task.paused || task.aborted) return;

            // Step 3: Complete
            status.textContent = '合并中...';
            btn.style.display = 'none';
            await API.uploadComplete(task.uploadId);

            status.textContent = '✓';
            status.style.color = 'var(--color-success)';
            btn.style.display = 'none';
            FM.navigate(FM.currentPath);
            this.scheduleAutoClose();
            // 后台生成缩略图并回传 (不阻塞 UI; 失败由网格懒生成兜底)
            makeThumbnail(task.file).then((t) => {
                if (!t) return null;
                const full = task.path ? `${task.path}/${task.name}` : task.name;
                return API.uploadThumbnail(full, t);
            }).catch(() => {});
        } catch (e) {
            // Auto-retry on timeout with smaller chunks
            if (e && e._retry) {
                status.textContent = `重试中 (${Math.round(task.chunkSize/1024)}KB)...`;
                btn.style.display = 'none';
                return this.doUpload(task);
            }
            status.textContent = '✗ ' + (e.message || '');
            status.style.color = 'var(--color-error)';
            status.title = e.message || '';
            btn.textContent = '重试';
            btn.onclick = () => {
                task.paused = false;
                task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                status.style.color = '';
                status.textContent = task.progress + '%';
                btn.textContent = '暂停';
                btn.onclick = () => Upload.togglePause(task.id);
                this.doUpload(task);
            };
        }
    },

    scheduleAutoClose() {
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }

        const panel = document.getElementById('uploadProgress');
        let bar = panel.querySelector('.auto-close-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'auto-close-bar';
            bar.innerHTML = '<div class="auto-close-bar-fill"></div>';
            panel.appendChild(bar);
        }
        const fill = bar.querySelector('.auto-close-bar-fill');
        bar.style.display = 'block';
        fill.style.transition = 'none';
        fill.style.width = '100%';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                fill.style.transition = 'width 5s linear';
                fill.style.width = '0%';
            });
        });

        this.closeTimer = setTimeout(() => {
            this.closeTimer = null;
            bar.style.display = 'none';
            const allDone = this.tasks.every(t => {
                const el = document.getElementById('upload-' + t.id);
                const s = el ? el.querySelector('.upload-item-status') : null;
                return s && (s.textContent === '✓' || s.textContent === '✗');
            });
            if (allDone) {
                panel.style.display = 'none';
            }
        }, 5000);
    },

    init() {
        document.getElementById('btnCloseProgress').addEventListener('click', () => {
            document.getElementById('uploadProgress').style.display = 'none';
        });
        document.getElementById('btnUpload').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.onchange = () => {
                if (input.files.length > 0) this.uploadFiles(input.files, FM.currentPath);
            };
            input.click();
        });
    }
};
