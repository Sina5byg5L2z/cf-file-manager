// Image Host (图床) module — chunked upload with pause/resume
const IH_CHUNK_SIZE = 512 * 1024; // 512KB
const IH_CONCURRENT = 4; // 与 upload.js 一致; 8 曾实测触发免费版 CPU 超限(1102)

// 未完成的图床上传任务 (只存元数据, 不含文件内容) —— 刷新/关页面后据此恢复"待继续"。
// 与文件上传的 uploadTasks 分开存, 两者互不干扰。
const IH_STORE_KEY = 'ihUploadTasks';

const ImageHost = (function() {
    let currentPage = 1;
    let pageSize = 24;
    let searchQuery = '';
    let items = [];
    let uploadTasks = [];

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    function getMimeIcon(mime) {
        if (mime.startsWith('image/')) return '🖼️';
        if (mime.startsWith('video/')) return '🎬';
        if (mime.startsWith('audio/')) return '🎵';
        if (mime === 'application/pdf') return '📄';
        return '📎';
    }

    return {
        show: function() {
            this.createModal();
            this.restoreFromStorage();
            this.loadPage(1);
        },

        createModal: function() {
            let overlay = document.getElementById('ihOverlay');
            if (overlay) {
                overlay.style.display = 'flex';
                this.restoreFromStorage();
                this.loadPage(1);
                return;
            }

            overlay = document.createElement('div');
            overlay.id = 'ihOverlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal ih-modal">
                    <div class="modal-header">
                        <span>📷 图床管理</span>
                        <div class="ih-header-actions">
                            <input type="text" id="ihSearch" placeholder="搜索文件名..." class="ih-search-input" />
                            <button id="ihUploadBtn" class="btn btn-sm btn-primary">⬆ 上传</button>
                            <button class="modal-close" id="ihCloseBtn">✕</button>
                        </div>
                    </div>
                    <div class="ih-body">
                        <!-- Drop zone -->
                        <div id="ihDropZone" class="ih-dropzone">
                            <div class="ih-dropzone-icon">📁</div>
                            <div class="ih-dropzone-text">拖拽文件到此处，或 <label for="ihFileInput" class="ih-link">点击选择</label></div>
                            <div class="ih-dropzone-hint">支持粘贴截图 (Ctrl+V)</div>
                            <input type="file" id="ihFileInput" multiple accept="image/*,video/*,audio/*,.pdf" style="display:none" />
                        </div>

                        <!-- Upload list (chunked upload progress) -->
                        <div id="ihUploadList" class="ih-upload-list" style="display:none"></div>

                        <!-- Grid -->
                        <div id="ihGrid" class="ih-grid"></div>

                        <!-- Pagination -->
                        <div id="ihPagination" class="ih-pagination"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            // Events
            document.getElementById('ihCloseBtn').addEventListener('click', () => this.close());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });

            document.getElementById('ihFileInput').addEventListener('change', (e) => {
                if (e.target.files.length) this.handleFiles(e.target.files);
                e.target.value = '';
            });

            document.getElementById('ihUploadBtn').addEventListener('click', () => {
                document.getElementById('ihFileInput').click();
            });

            // Drag & drop
            const dz = document.getElementById('ihDropZone');
            dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('ih-drag-over'); });
            dz.addEventListener('dragleave', () => dz.classList.remove('ih-drag-over'));
            dz.addEventListener('drop', (e) => {
                e.preventDefault();
                dz.classList.remove('ih-drag-over');
                if (e.dataTransfer.files.length) this.handleFiles(e.dataTransfer.files);
            });

            // Paste
            overlay.addEventListener('paste', (e) => {
                const clipItems = e.clipboardData && e.clipboardData.items;
                if (!clipItems) return;
                for (const item of clipItems) {
                    if (item.type.startsWith('image/')) {
                        e.preventDefault();
                        const file = item.getAsFile();
                        if (file) this.handleFiles([file]);
                        break;
                    }
                }
            });

            // Search
            let searchTimer;
            document.getElementById('ihSearch').addEventListener('input', (e) => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    searchQuery = e.target.value.trim();
                    this.loadPage(1);
                }, 300);
            });

            // Keyboard
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.close();
            });
        },

        close: function() {
            const overlay = document.getElementById('ihOverlay');
            if (overlay) overlay.style.display = 'none';
        },

        // ===== Data =====
        loadPage: async function(page) {
            currentPage = page;
            try {
                const res = await API.request('GET', `/api/image-host/list?page=${page}&page_size=${pageSize}${searchQuery ? '&search=' + encodeURIComponent(searchQuery) : ''}`);
                if (!res.ok) return;
                const data = await res.json();
                items = data.items || [];
                this.renderGrid(items);
                this.renderPagination(data.total, data.page, data.page_size);
            } catch (err) {
                console.error('加载图床列表失败:', err);
            }
        },

        // ===== Render =====
        renderGrid: function(list) {
            const grid = document.getElementById('ihGrid');
            if (!list.length) {
                grid.innerHTML = '<div class="ih-empty">暂无文件，拖拽或点击上传</div>';
                return;
            }

            const base = location.origin;
            grid.innerHTML = list.map(item => {
                const url = `${base}/i/${item.filename}`;
                // src_path 非空 = 零拷贝引用文件管理里的原文件 (不额外占空间)
                const isRef = !!item.src_path;
                const isImage = item.mime_type.startsWith('image/');
                const isVideo = item.mime_type.startsWith('video/');
                const preview = isImage
                    ? `<img src="${url}" loading="lazy" alt="${esc(item.original_name)}" />`
                    : isVideo
                    ? `<video src="${url}#t=0.1" preload="metadata" muted></video>`
                    : `<div class="ih-file-icon">${(window.FileIcons && FileIcons.html(item.original_name, false)) || getMimeIcon(item.mime_type)}</div>`;

                return `
                    <div class="ih-card" data-filename="${esc(item.filename)}">
                        <div class="ih-card-preview">${preview}</div>
                        <div class="ih-card-info">
                            ${isRef ? `<span class="ih-card-ref" title="引用自文件管理：${esc(item.src_path)}（不额外占用空间，删源文件会被拒绝）">引用</span>` : ''}
                            <span class="ih-card-name" title="${esc(item.original_name)}">${esc(item.original_name)}</span>
                            <span class="ih-card-size">${formatSize(item.size)}</span>
                        </div>
                        <div class="ih-card-actions">
                            <button class="ih-btn" title="复制链接" onclick="ImageHost.copyUrl('${esc(url)}')">🔗</button>
                            <button class="ih-btn" title="Markdown" onclick="ImageHost.copyEmbed('markdown','${esc(item.original_name)}','${esc(url)}','${esc(item.mime_type)}')">MD</button>
                            <button class="ih-btn" title="HTML" onclick="ImageHost.copyEmbed('html','${esc(item.original_name)}','${esc(url)}','${esc(item.mime_type)}')">HTML</button>
                            <button class="ih-btn ih-btn-del" title="删除" onclick="ImageHost.deleteOne('${esc(item.filename)}')">🗑</button>
                        </div>
                    </div>
                `;
            }).join('');
        },

        renderPagination: function(total, page, ps) {
            const el = document.getElementById('ihPagination');
            const totalPages = Math.ceil(total / ps);
            if (totalPages <= 1) { el.innerHTML = total > 0 ? `<span class="ih-page-info">共 ${total} 项</span>` : ''; return; }

            let html = '';
            if (page > 1) html += `<button class="btn btn-sm" onclick="ImageHost.loadPage(${page - 1})">◀ 上一页</button>`;
            html += `<span class="ih-page-info">${page} / ${totalPages}（共 ${total} 项）</span>`;
            if (page < totalPages) html += `<button class="btn btn-sm" onclick="ImageHost.loadPage(${page + 1})">下一页 ▶</button>`;
            el.innerHTML = html;
        },

        // ===== Chunked Upload =====
        // 与 upload.js 同一套协议: 算 file_key 指纹 → 服务端命中未完成会话则复用, 只补缺失分片。
        // 关键差异: 任务与 File 句柄解耦 —— 句柄只活在内存里, 元数据落 localStorage。
        // 刷新/关页面后任务是"待继续"状态, 重选同一个文件就能接着传 (不是从头传)。
        handleFiles: async function(fileList) {
            const listEl = document.getElementById('ihUploadList');
            if (!listEl) return;
            // 上传前压缩 (绝不静默): 与文件上传同一套弹窗, 取消 = 整批不上传。
            // await 期间用户可能重复触发, maybeCompress 内部有 _activePromise 排队。
            let picked = [...fileList];
            if (window.CompressUI) {
                picked = await window.CompressUI.maybeCompress(picked);
                if (!picked || !picked.length) return;
            }
            listEl.style.display = 'block';
            this.syncListDom();          // 不清空已有任务: 命中同源文件就复用, 其余保留
            for (const file of picked) {
                // 必须 await + catch: addFile 里要算指纹 (依赖 crypto.subtle),
                // 一旦抛错没人接, 任务既不在列表里也无提示, 用户只看到"点了没反应"
                this.addFile(file, listEl, picked.length).catch((e) => this.markFailed(file, e));
            }
        },

        async addFile(file, list, batchSize) {
            const totalChunks = Math.max(1, Math.ceil(file.size / IH_CHUNK_SIZE));
            const fileKey = await Upload.fileKey(file, IH_CHUNK_SIZE);

            // 同一文件 (同名+同大小+同修改时间+同分片大小) 已有未完成任务 → 复用, 只补缺失分片
            const dup = uploadTasks.find((t) => !t.done && t.fileKey === fileKey && t.name === file.name);
            if (dup) {
                dup.file = file;            // 补上新句柄
                dup.needsFile = false;
                dup.paused = false;
                dup.failed = false;
                dup.batchSize = batchSize;
                this.renderUploadItem(list, dup);
                this.doChunkedUpload(dup).catch((e) => this.markTaskError(dup, e));
                return;
            }

            const task = {
                id: Date.now() + Math.random(), name: file.name, file,
                size: file.size, lastModified: file.lastModified || 0,
                progress: 0, paused: false, aborted: false, uploadId: null,
                totalChunks, sentChunks: 0, received: null, inflight: null, hashes: {},
                result: null, chunkSize: IH_CHUNK_SIZE, concurrent: IH_CONCURRENT,
                timeoutRetries: 0, fileKey, needsFile: false, failed: false, done: false,
                batchSize: batchSize || 1,
                // 压缩产物标记: 非空 = 本地压缩产物, 内容同时缓存在 OPFS (刷新后可恢复)
                compressCache: file.compressCache || null,
                cType: file.type || '',
            };
            uploadTasks.push(task);
            this.renderUploadItem(list, task);
            this.doChunkedUpload(task).catch((e) => this.markTaskError(task, e));
        },

        // 任务创建阶段就失败 (指纹计算/编码等) → 也要留一条可见记录
        markFailed: function(file, e) {
            const listEl = document.getElementById('ihUploadList');
            const task = {
                id: Date.now() + Math.random(), name: file.name, file,
                size: file.size, lastModified: file.lastModified || 0,
                progress: 0, paused: true, aborted: false, uploadId: null,
                totalChunks: 0, sentChunks: 0, received: null, inflight: null, hashes: {},
                result: null, chunkSize: 0, concurrent: 1, timeoutRetries: 0,
                fileKey: '', needsFile: false, failed: true, done: false, batchSize: 1,
            };
            uploadTasks.push(task);
            if (listEl) {
                this.renderUploadItem(listEl, task);
                this.markTaskError(task, e);
            }
            this.saveState();
            this.refreshHeader();
        },

        // 把卡片切到"✗ 原因 + 重试"
        markTaskError: function(task, e) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            const msg = (e && e.message) || '未知错误';
            const status = el.querySelector('.ih-upload-status');
            const btn = el.querySelector('.ih-upload-pause-btn');
            if (status) {
                status.textContent = '✗ ' + msg;
                status.style.color = 'var(--color-error)';
                status.title = msg;
            }
            if (btn) {
                btn.textContent = '重试';
                btn.style.display = '';
                btn.onclick = () => {
                    task.failed = false;
                    task.paused = false;
                    // 同 upload.js 的手动重试: 重置自动重试预算 (耗尽后不重置会秒失败)
                    // 并强制重新 init 与服务端对账 (本地 received 可能与服务端不一致,
                    // 这正是"点重试没用、重选文件才行"的根因)
                    task.timeoutRetries = 0;
                    task.needSync = true;
                    if (status) { status.style.color = ''; status.textContent = task.progress + '%'; }
                    btn.textContent = '暂停';
                    btn.onclick = () => this.togglePause(task.id);
                    this.refreshHeader();
                    this.doChunkedUpload(task).catch((e2) => this.markTaskError(task, e2));
                };
            }
            this.refreshHeader();
        },

        // 传成功的任务直接从列表与任务集合摘掉: 列表里只留"没传成功"的
        // (失败 / 暂停 / 待续传), 用户看到的就是还需要处理的那几条。
        dropDoneTask: function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (el) el.remove();
            uploadTasks = uploadTasks.filter((t) => t !== task);
        },

        // 删除未完成任务: 停止上传 + 清服务端暂存分片与会话 + 从列表/本地记录移除
        removeTask: async function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            const ok = await Dialog.confirm(
                `删除未完成的上传「${task.name}」？\n已上传的临时分片会一并清除，之后需要重传。`,
                { title: '删除上传任务', okText: '删除', danger: true },
            ).catch(() => false);
            if (!ok) return;

            task.aborted = true;          // 让正在跑的 while 循环尽快退出
            task.paused = true;
            uploadTasks = uploadTasks.filter((t) => t !== task);
            if (el) el.remove();
            if (task.compressCache && window.Compress) {
                window.Compress.deleteCachedFile(task.compressCache); // OPFS 压缩产物一并清掉
            }
            this.saveState();
            this.refreshHeader();
            // 清服务端会话与暂存分片 (失败不阻塞 UI: 24h 后定时任务也会回收)
            if (task.uploadId) {
                try { await API.ihUploadAbort(task.uploadId); } catch { /* 忽略 */ }
            }
        },

        renderUploadItem: function(list, task) {
            const old = document.getElementById('ih-upload-' + task.id);
            if (old) old.remove();       // 重绘 (如恢复后重新选文件) 不能留旧卡片
            const div = document.createElement('div');
            div.className = 'ih-upload-item';
            div.id = 'ih-upload-' + task.id;
            div.innerHTML = `
                <div class="ih-upload-row">
                    <span class="ih-upload-name" title="${esc(task.name)}">${esc(task.name)}</span>
                    <span class="ih-upload-status">${task.progress}%</span>
                    <button class="btn btn-xs ih-upload-pause-btn">暂停</button>
                    <button class="btn btn-xs ih-upload-del-btn" title="从列表移除并丢弃已上传分片">删除</button>
                </div>
                <div class="ih-upload-bar"><div class="ih-upload-bar-fill" style="width:${task.progress}%"></div></div>
                <div class="ih-upload-detail"></div>
            `;
            // 用 onclick 属性而非 addEventListener: 后面 markNeedsFile/markTaskError
            // 要靠覆盖 onclick 换按钮语义, 监听器形式的旧回调是摘不掉的。
            const pauseBtn = div.querySelector('.ih-upload-pause-btn');
            pauseBtn.onclick = () => this.togglePause(task.id);
            div.querySelector('.ih-upload-del-btn').onclick = () => this.removeTask(task);
            list.appendChild(div);
            this.updateUploadUI(task);
            this.refreshHeader();
        },

        // 列表 DOM 与 uploadTasks 对齐: 摘掉任务集合里已不存在的卡片 (防残留/计数错乱)
        syncListDom: function() {
            const listEl = document.getElementById('ihUploadList');
            if (!listEl) return;
            for (const el of [...listEl.querySelectorAll('.ih-upload-item')]) {
                const id = el.id.replace('ih-upload-', '');
                if (!uploadTasks.some((t) => String(t.id) === id)) el.remove();
            }
        },

        // 列表头文案跟随真实状态; 一条未完成任务都不剩时整块收起并清空
        refreshHeader: function() {
            const listEl = document.getElementById('ihUploadList');
            if (!listEl) return;
            const pending = uploadTasks.filter((t) => !t.done);
            if (!pending.length) {
                listEl.style.display = 'none';
                listEl.innerHTML = '';
                return;
            }
            listEl.style.display = 'block';
            let header = listEl.querySelector('.ih-upload-header');
            if (!header) {
                header = document.createElement('div');
                header.className = 'ih-upload-header';
                header.innerHTML = '<span class="ih-upload-header-text"></span><span class="ih-upload-header-toggle">▼</span>';
                header.addEventListener('click', () => this.toggleUploadList());
                listEl.insertBefore(header, listEl.firstChild);
            }
            const active = pending.some((t) => !t.failed && !t.paused && !t.needsFile);
            const text = header.querySelector('.ih-upload-header-text');
            if (text) text.textContent = (active ? '上传中... ' : '待处理 ') + `(${pending.length})`;
        },

        // ---------------- 持久化 (只存元数据, 文件内容不进 localStorage) ----------------
        saveState: function() {
            try {
                const snap = uploadTasks.filter((t) => !t.done).map((t) => ({
                    id: t.id, name: t.name, size: t.size, lastModified: t.lastModified,
                    uploadId: t.uploadId, totalChunks: t.totalChunks, sentChunks: t.sentChunks,
                    chunkSize: t.chunkSize, concurrent: t.concurrent, fileKey: t.fileKey,
                    // 压缩产物: OPFS 缓存名 + mime (恢复时按 lastModified 重建 File 保指纹)
                    cacheName: t.compressCache || null,
                    cType: t.cType || (t.file ? (t.file.type || '') : ''),
                    needsFile: !t.file, failed: !!t.failed, paused: !!t.paused,
                }));
                localStorage.setItem(IH_STORE_KEY, JSON.stringify(snap));
            } catch (e) { /* 隐私模式 / 超额 → 忽略 */ }
            this.notifyLauncher();
        },

        loadState: function() {
            try {
                const raw = localStorage.getItem(IH_STORE_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch { return []; }
        },

        clearState: function() {
            try { localStorage.removeItem(IH_STORE_KEY); } catch { /* noop */ }
            this.notifyLauncher();
        },

        // 未完成任务数 (悬浮入口角标要用): 以内存任务为准, 页面刚加载、面板没展开过时
        // 内存为空 → 用本地记录兜底, 否则刷新后入口按钮不显示。
        pendingCount: function() {
            const mem = uploadTasks.filter((t) => !t.done).length;
            return mem > 0 ? mem : this.loadState().length;
        },

        // 图床任务变化要刷新共用的悬浮入口按钮 (角标 = 文件上传 + 图床)。
        // window.Upload 是 upload.js 末尾显式挂载的; 兜底再试全局 Upload,
        // 少一处挂载也不至于让按钮永远不刷新。
        notifyLauncher: function() {
            const U = window.Upload || (typeof Upload !== 'undefined' ? Upload : null);
            if (U && typeof U.updateLauncher === 'function') U.updateLauncher();
        },

        // 从 localStorage 恢复未完成任务卡片 (无 File 句柄 → 标"待继续", 等用户重选文件)
        restoreFromStorage: function() {
            const listEl = document.getElementById('ihUploadList');
            if (!listEl) return;
            for (const s of this.loadState()) {
                if (uploadTasks.some((t) => String(t.id) === String(s.id))) continue;
                const task = {
                    id: s.id, name: s.name, file: null, size: s.size, lastModified: s.lastModified,
                    progress: Math.round((s.sentChunks / Math.max(1, s.totalChunks)) * 100),
                    paused: true, aborted: false, uploadId: s.uploadId,
                    totalChunks: s.totalChunks, sentChunks: s.sentChunks,
                    chunkSize: s.chunkSize || IH_CHUNK_SIZE, concurrent: s.concurrent || IH_CONCURRENT,
                    timeoutRetries: 0, fileKey: s.fileKey || '', needsFile: true,
                    failed: !!s.failed, done: false, batchSize: 0,
                    received: null, inflight: null, hashes: {}, result: null,
                    compressCache: s.cacheName || null, cType: s.cType || '',
                };
                uploadTasks.push(task);
                this.renderUploadItem(listEl, task);
                if (s.cacheName && window.Compress) {
                    // 压缩产物缓存在 OPFS: 直接取回, 重选原文件对不上指纹 (大小/时间都变了)
                    window.Compress.restoreCachedFile(s.name, s.cacheName, s.cType, s.lastModified).then((f) => {
                        if (f && f.size === (s.size || 0)) {
                            task.file = f;
                            task.needsFile = false;
                            const el = document.getElementById('ih-upload-' + task.id);
                            const btn = el && el.querySelector('.ih-upload-pause-btn');
                            if (btn) { btn.textContent = '继续'; btn.onclick = () => this.togglePause(task.id); }
                        } else {
                            this.markCacheLost(task);
                        }
                    });
                } else {
                    this.markNeedsFile(task);
                }
            }
            this.syncListDom();
            this.refreshHeader();
            this.notifyLauncher();
        },

        // 恢复的任务: 无 File 句柄, 按钮变"选择文件"
        markNeedsFile: function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            const status = el.querySelector('.ih-upload-status');
            const btn = el.querySelector('.ih-upload-pause-btn');
            if (status) {
                status.textContent = '待继续';
                status.title = '需要重新选择同一文件以继续上传';
            }
            if (btn) {
                btn.textContent = '选择文件';
                btn.onclick = () => this.pickFileFor(task);
            }
        },

        // 压缩任务的 OPFS 缓存丢失 (浏览器清理存储): 压缩产物在磁盘上不存在,
        // 用户重选任何文件都无法匹配指纹, 只能提示重新上传。保留删除按钮清理残留。
        markCacheLost: function(task) {
            task.failed = true;
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            const status = el.querySelector('.ih-upload-status');
            const btn = el.querySelector('.ih-upload-pause-btn');
            if (status) {
                status.textContent = '✗ 压缩缓存已丢失';
                status.style.color = 'var(--color-error)';
                status.title = '浏览器本地缓存已被清除，请重新选择原文件上传（会重新压缩）';
            }
            if (btn) btn.style.display = 'none';
            this.refreshHeader();
        },

        // 为恢复的任务重新指定文件 (必须选同一个文件, 否则与已传分片对不上)
        pickFileFor: function(task) {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = false;
            input.accept = 'image/*,video/*,audio/*,.pdf';
            input.onchange = () => {
                const f = input.files && input.files[0];
                if (!f) return;
                if (f.name !== task.name || f.size !== (task.size || 0)) {
                    Dialog.alert(`请选择原文件「${task.name}」(${formatSize(task.size)})，当前选择不匹配。`, { title: '文件不匹配' });
                    return;
                }
                task.file = f;
                task.needsFile = false;
                task.paused = false;
                task.failed = false;
                // 关键: 恢复的任务带着旧 uploadId, 但本地 received 没持久化。
                // 必须强制重新 init 一次, 让服务端告诉我们已收哪些分片,
                // 否则会把整个文件重传一遍 (file_key 命中会话 → 服务端回 resumed+received)。
                task.needSync = true;
                const el = document.getElementById('ih-upload-' + task.id);
                const btn = el && el.querySelector('.ih-upload-pause-btn');
                if (btn) { btn.textContent = '暂停'; btn.onclick = () => this.togglePause(task.id); }
                this.refreshHeader();
                this.doChunkedUpload(task).catch((e) => this.markTaskError(task, e));
            };
            input.click();
        },

        toggleUploadList: function() {
            const listEl = document.getElementById('ihUploadList');
            if (!listEl) return;
            const isCollapsed = listEl.classList.contains('collapsed');
            listEl.classList.toggle('collapsed');
            const toggle = listEl.querySelector('.ih-upload-header-toggle');
            if (toggle) {
                toggle.classList.toggle('collapsed', !isCollapsed);
            }
        },

        togglePause: function(id) {
            const task = uploadTasks.find(t => String(t.id) === String(id));
            if (!task) return;
            if (task.needsFile) { this.pickFileFor(task); return; }
            task.paused = !task.paused;
            const el = document.getElementById('ih-upload-' + id);
            if (!el) return;
            const btn = el.querySelector('.ih-upload-pause-btn');
            const status = el.querySelector('.ih-upload-status');
            if (task.paused) {
                btn.textContent = '继续';
                status.textContent = '已暂停';
                this.saveState();
            } else {
                btn.textContent = '暂停';
                status.textContent = task.progress + '%';
                this.doChunkedUpload(task).catch((e) => this.markTaskError(task, e));
            }
            this.refreshHeader();
        },

        updateUploadUI: function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            // 恢复的任务没有 file 句柄, 总量只能读持久化的 size
            const total = task.size || (task.file && task.file.size) || 0;
            el.querySelector('.ih-upload-bar-fill').style.width = task.progress + '%';
            el.querySelector('.ih-upload-status').textContent = task.progress + '%';
            const uploaded = Math.min(task.sentChunks * task.chunkSize, total);
            el.querySelector('.ih-upload-detail').textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${formatSize(uploaded)}/${formatSize(total)})`;
        },

        // Check if error is timeout-related
        // 边缘 1102/502-504 等返回 HTML 错误页时拿不到 error 文案, 需靠 api.js 挂的 status
        isTimeoutError: function(e) {
            const msg = (e.message || '').toLowerCase();
            const st = e && e.status;
            if (st === 502 || st === 503 || st === 504 || st === 521 || st === 522
                || st === 523 || st === 524 || st === 525 || st === 526 || st === 530) return true;
            if (st === 500 && /1102|exceededCpu|exceeded cpu/.test(msg)) return true;
            return msg.includes('1102') || msg.includes('exceededcpu')
                || msg.includes('524') || msg.includes('timeout') || msg.includes('network') || msg.includes('failed to fetch')
                || msg.includes('502') || msg.includes('503') || msg.includes('504');
        },

        // 遇到 1102/524 的降级手段: 降并发, 不动分片大小。
        // 缩分片会改 fileKey (含 chunkSize) → 换服务端会话 → 已传分片全部作废, 代价过高;
        // 1102 的决定量是「分片大小 × 并发数」的乘积, 只降并发即可同样降压。
        reduceConcurrency: function(task) {
            const cur = task.concurrent || 1;
            if (cur <= 1) return false;
            task.concurrent = Math.max(1, Math.floor(cur / 2));
            return true;
        },

        doChunkedUpload: async function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            const status = el.querySelector('.ih-upload-status');
            const btn = el.querySelector('.ih-upload-pause-btn');

            try {
                const totalSize = task.size || (task.file && task.file.size) || 0;

                // 统一兜底: 任务对象可能来自 localStorage 恢复或 markFailed, 那两条路径
                // 不构造 received/inflight/hashes (缺 hashes 时 uploadOne 里赋值会抛错)
                if (!task.received) task.received = new Array(task.totalChunks).fill(false);
                if (!task.inflight) task.inflight = new Set();
                if (!task.hashes) task.hashes = {};

                // Step 1: Init (带 file_key; 服务端命中未完成会话则返回已传分片)
                // 两种情况都必须走一次:
                //   - 没有 uploadId: 全新任务
                //   - task.needSync: 从 localStorage 恢复后重选了文件, 本地 received 不可信,
                //     必须让服务端告诉我们已收哪些分片, 否则会把整个文件重传一遍
                if (!task.uploadId || task.needSync) {
                    const uploaded = Math.min(task.sentChunks * task.chunkSize, totalSize);
                    status.textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${formatSize(uploaded)}/${formatSize(totalSize)})`;
                    if (!task.fileKey && task.file) task.fileKey = await Upload.fileKey(task.file, task.chunkSize);
                    const initRes = await API.ihUploadInit(task.name, task.totalChunks, {
                        fileSize: totalSize, chunkSize: task.chunkSize, fileKey: task.fileKey,
                    });
                    const oldUploadId = task.uploadId;
                    task.uploadId = initRes.upload_id;
                    task.needSync = false;
                    // 服务端换了会话 (旧会话已被回收/参数变了) → 本地进度作废
                    if (oldUploadId && oldUploadId !== task.uploadId) {
                        task.received = new Array(task.totalChunks).fill(false);
                        task.hashes = {};
                        task.inflight = new Set();
                    }
                    // 以服务端返回的分片清单为准重建进度
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
                    this.updateUploadUI(task);
                    this.saveState();
                }

                if (!task.received) task.received = new Array(task.totalChunks).fill(false);
                if (!task.inflight) task.inflight = new Set();

                const uploadOne = async (idx) => {
                    const start = idx * task.chunkSize;
                    const end = Math.min(start + task.chunkSize, totalSize);
                    const chunk = task.file.slice(start, end);
                    // 分片 hash 可选: 无 crypto.subtle 时 hashChunk 返回 null, 跳过校验
                    let h = task.hashes[idx] || null;
                    if (!h && task.chunkSize <= 2 * 1024 * 1024) h = await Upload.hashChunk(chunk);
                    await API.ihUploadChunk(task.uploadId, idx, chunk, h);
                    if (h) task.hashes[idx] = h;
                    task.received[idx] = true;
                    task.sentChunks = task.received.filter(Boolean).length;
                    task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                    this.updateUploadUI(task);
                    this.saveState();       // 每片落库即持久化进度, 崩溃/关页面后可续
                };

                while (true) {
                    if (task.paused || task.aborted) return;

                    const batch = [];
                    // 并发取 task.concurrent (可运行时降级), 缺省回落常量
                    const conc = task.concurrent || IH_CONCURRENT;
                    for (let i = 0; i < task.totalChunks && batch.length < conc; i++) {
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

                    // 瞬态错误降级: 第 1 次原样重试; 第 2 次起降并发 (绝不缩分片, 见 reduceConcurrency 注释)
                    if (timeoutHit && task.timeoutRetries < 5) {
                        task.timeoutRetries++;
                        if (task.timeoutRetries <= 1) {
                            status.textContent = `网络抖动，重试 (${task.timeoutRetries}/1)`;
                            this.updateUploadUI(task);
                            continue;
                        }
                        if (this.reduceConcurrency(task)) {
                            status.textContent = `边缘超限，并发降至 ${task.concurrent}`;
                            this.updateUploadUI(task);
                            continue;
                        }
                        status.textContent = `重试中 (${task.timeoutRetries}/5)`;
                        this.updateUploadUI(task);
                        continue;
                    }
                }

                if (task.paused || task.aborted) return;

                // Step 3: Complete (服务端分批合并, 单请求开销恒定)
                status.textContent = '合并中...';
                btn.style.display = 'none';
                let batch = null;
                for (;;) {
                    if (task.paused || task.aborted) return;
                    const r = await API.ihUploadComplete(task.uploadId, batch);
                    if (r.done) { task.result = r; break; }
                    batch = r.next;
                    status.textContent = `合并中... ${r.merged}/${r.total}`;
                }

                status.textContent = '✓';
                status.style.color = 'var(--color-success)';
                btn.style.display = 'none';
                task.done = true;
                task.progress = 100;

                // 传成功的不再占列表位置: 摘卡片 + 出任务集合 + 从本地记录移除
                this.dropDoneTask(task);
                this.saveState();
                this.refreshHeader();
                this.loadPage(currentPage);

                // 本次只选了这一个文件 → 直接给嵌入代码 (图床的主要用途就是拿直链)
                if (task.batchSize === 1 && task.result) {
                    this.showEmbedDialog(task.result);
                }
            } catch (e) {
                task.failed = true;
                this.markTaskError(task, e);
                this.saveState();   // 失败态也持久化, 刷新后仍可重试
            }
        },

        // ===== Embed dialog =====
        showEmbedDialog: function(result) {
            // 防御: 任何非预期返回 (后端 error 对象 / 字段缺失) 都不该把详情页整个搞崩。
            const url = result && typeof result.url === 'string' ? result.url : '';
            if (!url) {
                window.Dialog
                    ? Dialog.alert('上传结果异常: ' + ((result && result.error) || '服务端未返回文件地址'))
                    : alert('上传结果异常');
                return;
            }
            result = Object.assign({ markdown: '', html: '', bbcode: '' }, result);
            const dialog = document.createElement('div');
            dialog.className = 'modal-overlay';
            dialog.innerHTML = `
                <div class="modal ih-embed-dialog">
                    <div class="modal-header">
                        <span>上传成功</span>
                        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
                    </div>
                    <div class="modal-body">
                        <div class="ih-embed-preview">
                            ${url.match(/\.(mp4|webm|mov)$/i)
                                ? `<video src="${esc(url)}" controls style="max-width:100%;max-height:200px"></video>`
                                : url.match(/\.(mp3|wav|ogg|flac)$/i)
                                ? `<audio src="${esc(url)}" controls></audio>`
                                : `<img src="${esc(url)}" style="max-width:100%;max-height:200px" />`
                            }
                        </div>
                        <div class="ih-embed-codes">
                            <label>直链</label>
                            <div class="ih-copy-row">
                                <input type="text" value="${esc(url)}" readonly />
                                <button class="btn btn-sm" onclick="ImageHost.copyText(this.previousElementSibling.value)">复制</button>
                            </div>
                            <label>Markdown</label>
                            <div class="ih-copy-row">
                                <input type="text" value="${esc(result.markdown)}" readonly />
                                <button class="btn btn-sm" onclick="ImageHost.copyText(this.previousElementSibling.value)">复制</button>
                            </div>
                            <label>HTML</label>
                            <div class="ih-copy-row">
                                <input type="text" value="${esc(result.html)}" readonly />
                                <button class="btn btn-sm" onclick="ImageHost.copyText(this.previousElementSibling.value)">复制</button>
                            </div>
                            <label>BBCode</label>
                            <div class="ih-copy-row">
                                <input type="text" value="${esc(result.bbcode)}" readonly />
                                <button class="btn btn-sm" onclick="ImageHost.copyText(this.previousElementSibling.value)">复制</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(dialog);
            dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
        },

        // ===== Clipboard =====
        copyText: function(text) {
            navigator.clipboard.writeText(text).then(() => {
                this.showToast('已复制到剪贴板');
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                this.showToast('已复制到剪贴板');
            });
        },

        copyUrl: function(url) {
            this.copyText(url);
        },

        copyEmbed: function(type, name, url, mime) {
            let text = '';
            if (type === 'markdown') {
                text = mime.startsWith('image/') ? `![${name}](${url})` : `[${name}](${url})`;
            } else if (type === 'html') {
                text = mime.startsWith('image/') ? `<img src="${url}" alt="${name}" />` : `<a href="${url}">${name}</a>`;
            }
            this.copyText(text);
        },

        showToast: function(msg) {
            const toast = document.createElement('div');
            toast.className = 'ih-toast';
            toast.textContent = msg;
            document.body.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('ih-toast-show'));
            setTimeout(() => {
                toast.classList.remove('ih-toast-show');
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        },

        // ===== Delete =====
        deleteOne: async function(filename) {
            const item = items.find(i => i.filename === filename);
            const isRef = !!(item && item.src_path);
            // 引用型不持有字节: 这里删的只是图床入口, 源文件必须先去文件管理删
            const msg = isRef
                ? '确定移除这条图床记录？\n源文件不会被删除，但此直链将失效。'
                : '确定删除此文件？删除后链接将失效。';
            if (!(await Dialog.confirm(msg, { danger: true, okText: isRef ? '移除' : '删除' }))) return;
            try {
                const res = await API.request('DELETE', `/api/image-host/${encodeURIComponent(filename)}`);
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || '删除失败');
                }
                this.loadPage(currentPage);
                this.showToast('已删除');
            } catch (err) {
                Dialog.alert('删除失败: ' + err.message);
            }
        },
    };
})();

// 顶层 const 不进 window —— upload.js 的悬浮入口角标要读图床待办数 (window.ImageHost),
// 分享页等其它脚本也可能引用, 必须显式挂载。
window.ImageHost = ImageHost;
