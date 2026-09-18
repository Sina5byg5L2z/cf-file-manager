// Upload manager - chunked upload with pause/resume, cross-session resumable chunks
// 免费版 Workers 单请求 10ms CPU 限制: 2026-09-12 线上持续110片实测(当前D1版代码) —
// 256K/512K 全部并发(4/6/8)通过; 1M×4 通过; 1M×6/8 触发 exceededResources(1102)。
// 并发下 CPU 记账被放大(孤立请求真实 ~1-3ms),限流执行阈值高于名义 10ms。
// 历史注释中 8并发×512KB 触发 1102 为偶发，真实存在但测试未复现。
// 分片大小/并发数已改为"参数设置"可调 (AppSettings, 服务端下发), 默认 512KB×4
// 若复现 1102/503 请在设置中降级 256KB
//
// ---- 断点续传设计 (2026-09-15) ----
// 1. 文件指纹 fileKey: SHA-256(name|size|lastModified|chunkSize) — 轻量, 不读文件内容
// 2. 分片 hash: SHA-256(chunk 字节); 随分片一起上传, 存 blobs.hash
//    * 用于"上传到一半退出/换页面后重选同一文件"时确认分片内容一致
//    * 分片大小变化会导致 hash 全部失效 → fileKey 含 chunkSize, 天然不匹配旧会话
// 3. 任务持久化: localStorage 存元数据 (不含文件内容); 刷新页面后仍能看到未完成任务
// 4. 右下角悬浮按钮: 存在未完成任务时显示, 点击打开上传列表面板; 全部完成则隐藏

// ---- 缩略图生成 (前端 canvas, 服务端零 CPU) ----
// 仅浏览器可解码的格式: 图片全部尝试; 视频仅 mp4/m4v/mov/webm/mkv
const THUMB_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const THUMB_VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];

const UPLOAD_STORE_KEY = 'uploadTasks';

// ---- SHA-256 工具 (hex 输出) ----
// crypto.subtle 只在安全上下文 (https / localhost) 存在; http 访问自定义域或内嵌 WebView
// 下为 undefined。此时 hash 降级为"不可用"——跨会话匹配由 file_key 承担, 服务端
// blobs.hash 允许 NULL, 上传主链路不受影响 (绝不能因 hash 算不出就整条上传失败)。
const SUBTLE_OK = typeof crypto !== 'undefined' && !!(crypto.subtle && crypto.subtle.digest);

async function sha256Hex(data) {
    if (!SUBTLE_OK) return null;
    // data: ArrayBuffer | Uint8Array | Blob
    let buf;
    if (data instanceof Blob) buf = await data.arrayBuffer();
    else buf = data;
    const bits = await crypto.subtle.digest('SHA-256', buf);
    const u = new Uint8Array(bits);
    let s = '';
    for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
    return s;
}

// 文件指纹: 只依赖元数据, 不读内容 (大文件零开销); chunkSize 参与计算,
// 保证"分片大小不同的旧会话"不会被误复用。
// 无 subtle 时退化为 FNV-1a 弱指纹 (仅用于本机会话等值匹配, 不做安全校验)。
async function fileFingerprint(file, chunkSize) {
    const raw = `${file.name}|${file.size}|${file.lastModified || 0}|${chunkSize}`;
    const h = await sha256Hex(new TextEncoder().encode(raw));
    if (h) return h;
    let x = 2166136261;
    for (let i = 0; i < raw.length; i++) { x ^= raw.charCodeAt(i); x = Math.imul(x, 16777619); }
    return 'fnv' + (x >>> 0).toString(16);
}

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

// 图床 (imagehost.js) 的待办数。该模块在 upload.js 之后加载、也可能整体不存在,
// 统一走 window.ImageHost 探测 (imagehost.js 末尾显式挂载), 拿不到就当 0。
// 悬浮入口是两处共用的, 所以角标 = 文件上传 + 图床 合计。
function ihPending() {
    const ih = window.ImageHost;
    return (ih && typeof ih.pendingCount === 'function') ? (ih.pendingCount() || 0) : 0;
}

const Upload = {
    tasks: [],
    closeTimer: null,
    progressEl: null,

    // 供图床等模块复用的分片 hash (SHA-256 hex; 无 subtle 时返回 null = 跳过校验)
    hashChunk(blob) { return sha256Hex(blob); },

    // 供图床等模块复用的文件指纹 (与文件上传同一算法: 名字|大小|修改时间|分片大小)。
    // 两处必须同算法, 否则服务端 file_key 复用匹配不上。
    fileKey(file, chunkSize) { return fileFingerprint(file, chunkSize); },

    // ---------------- 持久化 ----------------
    // 只存元数据: 文件内容不进 localStorage, 刷新后需用户重新选择同一文件
    saveState() {
        try {
            const snap = this.tasks.map(t => ({
                id: t.id,
                name: t.name,
                path: t.path,
                size: t.file ? t.file.size : (t.size || 0),
                lastModified: t.file ? (t.file.lastModified || 0) : (t.lastModified || 0),
                uploadId: t.uploadId,
                totalChunks: t.totalChunks,
                sentChunks: t.sentChunks,
                chunkSize: t.chunkSize,
                concurrent: t.concurrent,
                fileKey: t.fileKey,
                needsFile: !t.file,     // 刷新后无 File 句柄, 需要用户重新选择
                done: !!t.done,
                failed: !!t.failed,
            })).filter(t => !t.done);  // 已完成的不再持久化
            localStorage.setItem(UPLOAD_STORE_KEY, JSON.stringify(snap));
        } catch (e) { /* 隐私模式 / 超额 → 忽略 */ }
        this.updateLauncher();
    },

    loadState() {
        try {
            const raw = localStorage.getItem(UPLOAD_STORE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    },

    clearState() {
        try { localStorage.removeItem(UPLOAD_STORE_KEY); } catch { /* noop */ }
        this.updateLauncher();
    },

    // 还有未完成 (非 done) 的任务?
    hasPending() {
        return this.tasks.some(t => !t.done);
    },

    // 上传面板是否已展开 (面板开合只由 openPanel/closePanel 改内联 display)
    isPanelOpen() {
        const panel = document.getElementById('uploadProgress');
        if (!panel) return false;
        const d = panel.style.display;
        return d !== 'none' && d !== '';
    },

    // 没传成功的任务数 = 文件上传 + 图床 (两者共用一个悬浮入口, 角标是合计)。
    // 各自以内存任务为准; 页面刚加载、面板没展开过时内存为空, 用 localStorage 里的
    // 待续传记录兜底, 否则刷新后入口按钮不显示。
    pendingCount() {
        const mem = this.tasks.filter(t => !t.done).length;
        const filePending = mem > 0 ? mem : this.loadState().length;
        return filePending + ihPending();
    },

    // 面板头部文案 (列表空了不能还写"上传中...")
    setHeader(text) {
        const panel = document.getElementById('uploadProgress');
        const h = panel && panel.querySelector('.upload-progress-header > span');
        if (h) h.textContent = text;
    },

    // 头文案跟随真实状态: 还有在传的 → 上传中; 只剩失败/暂停/待续传 → 待处理;
    // 一条不剩 → 全部完成。(成功项会被摘掉, 所以"列表有内容"不等于"还在传")
    refreshHeader() {
        const active = this.tasks.some(t => !t.done && !t.failed && !t.paused && !t.needsFile);
        if (active) this.setHeader('上传中...');
        else if (this.hasPending()) this.setHeader('待处理');
        else this.setHeader('全部完成');
    },

    // 右下角悬浮入口按钮: 只在「面板已收起」且「还有没传成功的文件」时显示。
    // 面板展开时按钮必须隐藏 —— 否则两个入口同时出现, 按钮还压在面板上。
    updateLauncher() {
        const btn = document.getElementById('uploadLauncher');
        this.renderIhEntry();
        if (!btn) return;
        const pending = this.pendingCount();
        if (pending > 0 && !this.isPanelOpen()) {
            btn.style.display = 'flex';
            document.body.classList.add('has-upload-launcher');
            const badge = btn.querySelector('.upload-launcher-badge');
            if (badge) badge.textContent = String(pending);
        } else {
            btn.style.display = 'none';
            document.body.classList.remove('has-upload-launcher');
        }
    },

    // 上传面板里的图床入口: 角标是"文件上传 + 图床"合计, 但本面板只列文件上传的任务,
    // 不给出图床入口的话, 用户会看到"角标 2、列表里只有 1 条"的矛盾。
    renderIhEntry() {
        const panel = document.getElementById('uploadProgress');
        if (!panel) return;
        const n = ihPending();
        const old = document.getElementById('uploadIhEntry');
        if (!n) { if (old) old.remove(); return; }
        let el = old;
        if (!el) {
            el = document.createElement('div');
            el.id = 'uploadIhEntry';
            el.className = 'upload-ih-entry';
            el.title = '点击打开图床';
            el.addEventListener('click', () => {
                this.closePanel();                       // 先收上传面板, 两个浮层别叠着
                if (window.ImageHost) window.ImageHost.show();
            });
            const list = document.getElementById('uploadList');
            if (list) panel.insertBefore(el, list); else panel.appendChild(el);
        }
        el.textContent = `图床还有 ${n} 个未完成的上传，点此打开 ›`;
    },

    // ---------------- 打开 / 关闭面板 ----------------
    openPanel() {
        const panel = document.getElementById('uploadProgress');
        if (!panel) return;
        panel.style.display = 'block';
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
        const bar = panel.querySelector('.auto-close-bar');
        if (bar) bar.style.display = 'none';
        // 面板已展开 → 收起悬浮入口按钮
        this.updateLauncher();
        // 恢复历史任务 (刷新后 localStorage 里还有的)
        this.restoreFromStorage();
        this.refreshHeader();
    },

    closePanel() {
        const panel = document.getElementById('uploadProgress');
        if (panel) panel.style.display = 'none';
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
        // 面板收起后, 若还有没传成功的文件, 重新露出悬浮入口按钮
        this.updateLauncher();
    },

    // 从 localStorage 恢复任务卡片 (无 File 句柄的标为"需重新选择文件")
    restoreFromStorage() {
        const saved = this.loadState();
        const list = document.getElementById('uploadList');
        if (!list) return;
        for (const s of saved) {
            if (this.tasks.some(t => t.id === s.id)) continue;
            const task = {
                id: s.id, name: s.name, file: null, path: s.path,
                size: s.size, lastModified: s.lastModified,
                progress: Math.round((s.sentChunks / Math.max(1, s.totalChunks)) * 100),
                paused: true, aborted: false, uploadId: s.uploadId,
                totalChunks: s.totalChunks, sentChunks: s.sentChunks,
                failed: false, done: false, chunkSize: s.chunkSize,
                concurrent: s.concurrent, timeoutRetries: 0,
                fileKey: s.fileKey, needsFile: true,
                received: null, inflight: null, hashes: {},
            };
            this.tasks.push(task);
            this.renderItem(list, task);
            this.markNeedsFile(task);
        }
        this.updateLauncher();
    },

    // ---------------- 入口: 选择文件上传 ----------------
    async uploadFiles(fileList, path) {
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
        // 关键: 不清空已有任务, 同文件命中历史任务则复用而不是重头再传
        progress.style.display = 'block';
        if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
        const bar = progress.querySelector('.auto-close-bar');
        if (bar) bar.style.display = 'none';
        this.setHeader('上传中...');
        this.updateLauncher();       // 面板展开 → 悬浮入口按钮隐藏

        for (const file of files) {
            // 必须 await + try/catch: addFile 内部会算指纹 (依赖 crypto.subtle),
            // 一旦抛错而没人接, 任务既不会进 tasks 也不会显示, 用户看到的只是"点了没反应"
            this.lastPath = path;
            try {
                await this.addFile(file, path, list);
            } catch (e) {
                this.markFailed(file, e);
            }
        }
        this.saveState();
    },

    // 任务创建阶段就失败 (指纹计算/规则读取等) → 也要留一条可见记录
    markFailed(file, e) {
        const list = document.getElementById('uploadList');
        const task = {
            id: Date.now() + Math.random(), name: file.name, file, path: this.lastPath || '',
            progress: 0, paused: true, aborted: false, uploadId: null,
            totalChunks: 0, sentChunks: 0, failed: true, done: false,
            chunkSize: 0, concurrent: 1, timeoutRetries: 0, fileKey: '',
            size: file.size, lastModified: file.lastModified || 0,
            received: null, inflight: null, hashes: {},
        };
        this.tasks.push(task);
        const msg = (e && e.message) || '未知错误';
        if (list) {
            this.renderItem(list, task);
            this.markTaskError(task, msg);
        }
    },

    // 把卡片切到"✗ 原因 + 重试"
    markTaskError(task, msg) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        const status = el.querySelector('.upload-item-status');
        const btn = el.querySelector('.upload-pause-btn');
        if (status) {
            status.textContent = '✗ ' + msg;
            status.style.color = 'var(--color-error)';
            status.title = msg;
        }
        if (btn) {
            btn.textContent = '重试';
            btn.style.display = '';
            btn.onclick = () => {
                task.failed = false; task.paused = false;
                if (status) { status.style.color = ''; status.textContent = task.progress + '%'; }
                btn.textContent = '暂停';
                btn.onclick = () => Upload.togglePause(task.id);
                this.doUpload(task).catch((e2) => this.markTaskError(task, (e2 && e2.message) || '未知错误'));
            };
        }
        this.refreshHeader();
    },

    async addFile(file, path, list) {
        const rule = AppSettings.chunkRuleFor(file.size);
        const chunkSize = rule.chunk_size;
        const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
        const fileKey = await fileFingerprint(file, chunkSize);

        // 同一文件 (同名+同大小+同修改时间+同分片大小) 已有未完成任务 → 复用, 只补缺失分片
        const dup = this.tasks.find(t => !t.done && t.fileKey === fileKey && t.name === file.name);
        if (dup) {
            dup.file = file;            // 补上新的 File 句柄
            dup.needsFile = false;
            dup.paused = false;
            dup.failed = false;
            this.renderItem(list, dup, true); // 重绘 (状态可能从"需选择文件"变回正常)
            this.doUpload(dup).catch((e) => this.markTaskError(dup, (e && e.message) || '未知错误'));
            return;
        }

        const id = Date.now() + Math.random();
        const task = {
            id, name: file.name, file, path,
            progress: 0, paused: false, aborted: false,
            uploadId: null, totalChunks, sentChunks: 0, failed: false, done: false,
            chunkSize, concurrent: rule.concurrent, timeoutRetries: 0,
            fileKey, received: null, inflight: null, hashes: {},
        };
        this.tasks.push(task);
        this.renderItem(list, task);
        this.doUpload(task).catch((e) => this.markTaskError(task, (e && e.message) || '未知错误'));
    },

    renderItem(list, task, replace) {
        const old = document.getElementById('upload-' + task.id);
        if (old) old.remove();
        const div = document.createElement('div');
        div.className = 'upload-item';
        div.id = 'upload-' + task.id;
        div.innerHTML = `
            <div class="upload-item-row">
                <span class="upload-item-name" title="${FM.esc(task.name)}">${FM.esc(task.name)}</span>
                <span class="upload-item-status">${task.progress}%</span>
                <button class="btn btn-xs upload-pause-btn" onclick="Upload.togglePause('${task.id}')">暂停</button>
                <button class="btn btn-xs upload-del-btn" title="从列表移除并丢弃已上传分片">删除</button>
            </div>
            <div class="upload-bar"><div class="upload-bar-fill" style="width:${task.progress}%"></div></div>
            <div class="upload-item-detail" style="font-size:11px;color:var(--text-tertiary)"></div>
        `;
        const delBtn = div.querySelector('.upload-del-btn');
        if (delBtn) delBtn.onclick = () => this.removeTask(task);
        list.appendChild(div);
        this.updateUI(task);
    },

    // 删除未完成任务: 停止上传 + 清服务端暂存分片与会话 + 从列表/本地记录移除
    async removeTask(task) {
        const el = document.getElementById('upload-' + task.id);
        const name = task.name;
        const ok = await Dialog.confirm(
            `删除未完成的上传「${name}」？\n已上传的临时分片会一并清除，之后需要重传。`,
            { title: '删除上传任务', okText: '删除', danger: true },
        ).catch(() => false);
        if (!ok) return;

        task.aborted = true;          // 让正在跑的 while 循环尽快退出
        task.paused = true;
        this.tasks = this.tasks.filter((t) => t !== task);
        if (el) el.remove();
        this.saveState();             // saveState 会把已移除的任务从 localStorage 去掉
        // 面板里已无任务 → 自动收起。先收面板再刷入口按钮: 反过来的话
        // updateLauncher 会以为面板还开着, 把按钮一起藏掉。
        if (!this.hasPending()) {
            const panel = document.getElementById('uploadProgress');
            if (panel) panel.style.display = 'none';
        }
        this.updateLauncher();
        // 清服务端会话与暂存分片 (失败不阻塞 UI: 24h 后定时任务也会回收)
        if (task.uploadId) {
            try { await API.uploadAbort(task.uploadId); } catch { /* 忽略 */ }
        }
    },

    // 上传成功的任务直接从列表和任务集合里摘掉: 列表里只保留"没传成功"的
    // (失败 / 暂停 / 待续传), 用户看到的就是还需要处理的那几条。
    dropDoneTask(task) {
        const el = document.getElementById('upload-' + task.id);
        if (el) el.remove();
        this.tasks = this.tasks.filter((t) => t !== task);
    },

    // 刷新页面后恢复的任务: 无 File 句柄, 提示用户重新选择
    markNeedsFile(task) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        const status = el.querySelector('.upload-item-status');
        const btn = el.querySelector('.upload-pause-btn');
        status.textContent = '待继续';
        status.title = '需要重新选择同一文件以继续上传';
        btn.textContent = '选择文件';
        btn.onclick = () => this.pickFileFor(task);
    },

    // 为恢复的任务重新指定文件 (用户需选同一文件)
    pickFileFor(task) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = false;
        input.onchange = async () => {
            const f = input.files && input.files[0];
            if (!f) return;
            if (f.name !== task.name || f.size !== (task.size || 0)) {
                Dialog.alert(`请选择原文件「${task.name}」(${_fmtSize(task.size)})，当前选择不匹配。`, { title: '文件不匹配' });
                return;
            }
            task.file = f;
            task.needsFile = false;
            task.paused = false;
            task.failed = false;
            // 关键: 恢复的任务带着旧 uploadId, 但本地 received 是空的 (没持久化到 localStorage)。
            // 必须强制重新向服务端 init 一次拿真实已传分片, 否则会从头重传整个文件。
            task.needSync = true;
            const el = document.getElementById('upload-' + task.id);
            const btn = el && el.querySelector('.upload-pause-btn');
            if (btn) { btn.textContent = '暂停'; btn.onclick = () => Upload.togglePause(task.id); }
            this.doUpload(task);
        };
        input.click();
    },

    togglePause(id) {
        const task = this.tasks.find(t => String(t.id) === String(id));
        if (!task) return;
        if (task.needsFile) { this.pickFileFor(task); return; }
        task.paused = !task.paused;
        const el = document.getElementById('upload-' + id);
        if (!el) return;
        const btn = el.querySelector('.upload-pause-btn');
        const status = el.querySelector('.upload-item-status');
        if (task.paused) {
            btn.textContent = '继续';
            status.textContent = '已暂停';
            this.saveState();
        } else {
            btn.textContent = '暂停';
            status.textContent = task.progress + '%';
            this.doUpload(task);
        }
        this.refreshHeader();
    },

    updateUI(task) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        el.querySelector('.upload-bar-fill').style.width = task.progress + '%';
        el.querySelector('.upload-item-status').textContent = task.progress + '%';
        const uploaded = Math.min(task.sentChunks * task.chunkSize, task.size || (task.file && task.file.size) || 0);
        const totalSize = task.size || (task.file && task.file.size) || 0;
        el.querySelector('.upload-item-detail').textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${_fmtSize(uploaded)}/${_fmtSize(totalSize)})`;
    },

    // 判定"可重试的瞬态错误": 网络抖动 / 边缘超时 / CPU 超限(1102)
    // 1102 (exceededCpu) 时 Cloudflare 返回的是 HTML 错误页而非项目 JSON,
    // 前端拿不到 error 文案 —— 只能靠 HTTP 状态码识别。因此 api.js 会在
    // 错误对象上挂 `status`, 这里必须一并判断, 否则大文件失败后不会自动重试。
    isTimeoutError(e) {
        const msg = (e.message || '').toLowerCase();
        const st = e && e.status;
        if (st === 502 || st === 503 || st === 504 || st === 521 || st === 522
            || st === 523 || st === 524 || st === 525 || st === 526 || st === 530) return true;
        // 免费版 10ms CPU 超限: 边缘 500/503 + HTML 错误页, 正文常含 1102
        if (st === 500 && /1102|exceededCpu|exceeded cpu/.test(msg)) return true;
        // 网络超时 + Cloudflare 边缘瞬态错误(部署版本切换/源站波动): 缩小分片并自动重试
        return msg.includes('1102') || msg.includes('exceededcpu')
            || msg.includes('524') || msg.includes('timeout') || msg.includes('network') || msg.includes('failed to fetch')
            || msg.includes('502') || msg.includes('503') || msg.includes('504')
            || msg.includes('521') || msg.includes('522') || msg.includes('523')
            || msg.includes('525') || msg.includes('526') || msg.includes('530')
            || msg.includes('service unavailable') || msg.includes('bad gateway') || msg.includes('gateway timeout');
    },

    // 遇到 1102(CPU 超限)/524 时的降级手段: 降低并发, 不动分片大小。
    //
    // 为什么不再缩分片:
    //   fileKey = SHA256(name|size|lastModified|chunkSize) 含 chunkSize,
    //   一旦改分片大小 → fileKey 变 → 服务端 uploadInit 匹配不到旧会话 → 建新会话,
    //   已传分片全部作废 (160MB 文件传到 95 片时缩分片 = 95 片白传, 从 0 重来)。
    //   而 1102 的决定量是「分片大小 × 并发数」的乘积, 单降并发即可达成同样的降压效果,
    //   且并发只是 task 上的运行时字段, 改它不影响服务端会话与已传进度。
    reduceConcurrency(task) {
        const cur = task.concurrent || 1;
        if (cur <= 1) return false;                 // 已到下限
        // 4 → 2 → 1; 奇数向上取整保证一定收敛
        const next = Math.max(1, Math.floor(cur / 2));
        if (next === cur) return false;
        task.concurrent = next;
        this.updateUI(task);
        this.saveState();                            // 并发数持久化, 刷新后仍按降级后跑
        return true;
    },

    async doUpload(task) {
        const el = document.getElementById('upload-' + task.id);
        if (!el) return;
        const status = el.querySelector('.upload-item-status');
        const btn = el.querySelector('.upload-pause-btn');

        try {
            const totalSize = task.size || (task.file && task.file.size) || 0;

            // 统一兜底: 任务对象可能来自 localStorage 恢复 (restoreFromStorage) 或
            // markFailed, 那两条路径不构造 received/inflight/hashes。
            // 缺 hashes 时 uploadOne 里 `task.hashes[idx] = h` 会抛
            // "Cannot set properties of undefined (setting '0')"。
            if (!task.received) task.received = new Array(task.totalChunks).fill(false);
            if (!task.inflight) task.inflight = new Set();
            if (!task.hashes) task.hashes = {};

            // Step 1: Init (带 file_key/chunk_size; 服务端命中未完成会话则返回已传分片)
            // 两种情况都必须走一次:
            //   - 没有 uploadId: 全新任务
            //   - task.needSync: 从 localStorage 恢复后重选了文件, 本地 received 不可信,
            //     必须让服务端告诉我们哪些分片已在 (否则会把整个文件重传一遍)
            if (!task.uploadId || task.needSync) {
                status.textContent = '初始化...';
                this.refreshHeader();
                if (!task.fileKey && task.file) task.fileKey = await fileFingerprint(task.file, task.chunkSize);
                const initRes = await API.uploadInit(task.path, task.name, task.totalChunks, {
                    fileKey: task.fileKey, fileSize: totalSize, chunkSize: task.chunkSize,
                });
                const oldUploadId = task.uploadId;
                task.uploadId = initRes.upload_id;
                task.needSync = false;
                // 服务端换了会话 (旧会话已过期/被清理, 或分片参数变了) → 本地进度作废
                if (oldUploadId && oldUploadId !== task.uploadId) {
                    task.received = new Array(task.totalChunks).fill(false);
                    task.hashes = {};
                    task.inflight = new Set();
                }
                // 以服务端返回的 received 为准重建进度 (不用 else 分支, 空数组也要归零)
                const got = new Set(Array.isArray(initRes.received) ? initRes.received : []);
                for (const i of got) if (i >= 0 && i < task.totalChunks) task.received[i] = true;
                // 服务端回传的分片 hash → 本地缓存, 避免重算
                if (Array.isArray(initRes.hashes)) for (const { idx, hash } of initRes.hashes) {
                    if (idx >= 0 && idx < task.totalChunks && hash) task.hashes[idx] = hash;
                }
                task.sentChunks = task.received.filter(Boolean).length;
                task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                if (initRes.resumed && task.sentChunks > 0) {
                    status.textContent = `续传 (已有 ${task.sentChunks}/${task.totalChunks} 片)`;
                }
                this.updateUI(task);
                this.saveState();
            }

            const uploadOne = async (idx) => {
                const start = idx * task.chunkSize;
                const end = Math.min(start + task.chunkSize, totalSize);
                const chunk = task.file.slice(start, end);
                // 分片 hash 是"可选校验": 无 subtle 直接跳过 (服务端 blobs.hash 允许 NULL);
                // 超 2MB 的分片也算不动, 同样跳过
                let h = null;
                if (SUBTLE_OK && task.chunkSize <= 2 * 1024 * 1024) h = await sha256Hex(chunk);
                await API.uploadChunk(task.uploadId, idx, chunk, h);
                if (h) task.hashes[idx] = h;
                task.received[idx] = true;
                task.sentChunks = task.received.filter(Boolean).length;
                task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                this.updateUI(task);
                // 每片落库即持久化进度, 崩溃/关闭后可续
                this.saveState();
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

                // 瞬态错误 (1102 / 524 / 502-504...) 的降级策略:
                //   第 1 次 → 原样重试 (多为边缘抖动, 换个时刻同一片就能过)
                //   第 2 次起 → 降并发 (分片大小与 uploadId 不变, 已传进度全部保住)
                // 绝不缩分片: 那会改 fileKey → 换服务端会话 → 已传分片全废。
                if (timeoutHit && task.timeoutRetries < 5) {
                    task.timeoutRetries++;
                    if (task.timeoutRetries <= 1) {
                        status.textContent = `网络抖动，重试 (${task.timeoutRetries}/1)`;
                        this.updateUI(task);
                        continue;
                    }
                    if (this.reduceConcurrency(task)) {
                        status.textContent = `边缘超限，并发降至 ${task.concurrent}`;
                        this.updateUI(task);
                        continue;
                    }
                    // 并发已到 1 仍失败: 原样再试, 由 timeoutRetries 上限兜底
                    status.textContent = `重试中 (${task.timeoutRetries}/5)`;
                    this.updateUI(task);
                    continue;
                }
            }

            if (task.paused || task.aborted) return;

            // Step 3: Complete (服务端分批合并; 单请求开销恒定, 与文件总大小解耦)
            status.textContent = '合并中...';
            btn.style.display = 'none';
            let batch = null;
            for (;;) {
                if (task.paused || task.aborted) return;
                const r = await API.uploadComplete(task.uploadId, batch);
                if (r.done) { task.result = r; break; }
                batch = r.next;
                status.textContent = `合并中... ${r.merged}/${r.total}`;
                this.saveState();   // 合并阶段中断也能续
            }

            task.done = true;
            task.progress = 100;
            status.textContent = '✓';
            status.style.color = 'var(--color-success)';
            btn.style.display = 'none';
            FM.navigate(FM.currentPath);
            // 传成功的文件不再占列表位置 → 立即摘掉卡片 (saveState 会把它从 localStorage 去掉)
            this.dropDoneTask(task);
            this.saveState();
            this.refreshHeader();
            this.updateLauncher();
            this.scheduleAutoClose();
            // 后台生成缩略图并回传 (不阻塞 UI; 失败由网格懒生成兜底)
            makeThumbnail(task.file).then((t) => {
                if (!t) return null;
                const full = task.path ? `${task.path}/${task.name}` : task.name;
                return API.uploadThumbnail(full, t);
            }).catch(() => {});
        } catch (e) {
            task.failed = true;
            this.refreshHeader();
            status.textContent = '✗ ' + (e.message || '');
            status.style.color = 'var(--color-error)';
            status.title = e.message || '';
            btn.textContent = '重试';
            btn.style.display = '';
            btn.onclick = () => {
                task.paused = false;
                task.failed = false;
                task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                status.style.color = '';
                status.textContent = task.progress + '%';
                btn.textContent = '暂停';
                btn.onclick = () => Upload.togglePause(task.id);
                this.doUpload(task).catch((e2) => this.markTaskError(task, (e2 && e2.message) || '未知错误'));
            };
            this.saveState(); // 失败态也持久化, 刷新后仍可重试
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
            // 只在没有未完成任务时自动收起面板
            if (!this.hasPending()) {
                panel.style.display = 'none';
            }
            this.updateLauncher();
        }, 5000);
    },

    init() {
        document.getElementById('btnCloseProgress').addEventListener('click', () => this.closePanel());

        // 右下角悬浮入口按钮
        const launcher = document.getElementById('uploadLauncher');
        if (launcher) {
            launcher.addEventListener('click', () => this.openPanel());
        }

        document.getElementById('btnUpload').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.onchange = () => {
                if (input.files.length > 0) this.uploadFiles(input.files, FM.currentPath);
            };
            input.click();
        });

        // 刷新后恢复按钮显示状态 (有待续传任务才显示)
        this.updateLauncher();
    }
};

// 顶层 const 不进 window —— imagehost.js 要通过 window.Upload 反过来刷新共用的
// 悬浮入口按钮 (角标 = 文件上传 + 图床), 不挂载这里会静默失效。
window.Upload = Upload;
