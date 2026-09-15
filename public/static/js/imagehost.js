// Image Host (图床) module — chunked upload with pause/resume
const IH_CHUNK_SIZE = 512 * 1024; // 512KB
const IH_CONCURRENT = 4; // 与 upload.js 一致; 8 曾实测触发免费版 CPU 超限(1102)

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
            this.loadPage(1);
        },

        createModal: function() {
            let overlay = document.getElementById('ihOverlay');
            if (overlay) {
                overlay.style.display = 'flex';
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
        handleFiles: function(fileList) {
            const listEl = document.getElementById('ihUploadList');
            listEl.style.display = 'block';
            uploadTasks = [];

            for (const file of fileList) {
                const id = Date.now() + Math.random();
                const totalChunks = Math.max(1, Math.ceil(file.size / IH_CHUNK_SIZE));
                const task = { id, name: file.name, file, progress: 0, paused: false, aborted: false, uploadId: null, totalChunks, sentChunks: 0, received: null, inflight: null, result: null, chunkSize: IH_CHUNK_SIZE, concurrent: IH_CONCURRENT, timeoutRetries: 0 };
                uploadTasks.push(task);
                this.renderUploadItem(listEl, task);
                // 补一层 catch 保险: 异常必须可见, 不能静默消失
                this.doChunkedUpload(task).catch((e) => {
                    const el = document.getElementById('ih-upload-' + task.id);
                    if (!el) return;
                    const status = el.querySelector('.ih-upload-status');
                    if (status) {
                        status.textContent = '✗ ' + ((e && e.message) || '');
                        status.style.color = 'var(--color-error)';
                    }
                });
            }
        },

        renderUploadItem: function(list, task) {
            // 如果是第一个上传项，添加标题和折叠按钮
            if (list.children.length === 0) {
                const header = document.createElement('div');
                header.className = 'ih-upload-header';
                header.innerHTML = `
                    <span class="ih-upload-header-text">上传进度 (${list.children.length + 1})</span>
                    <span class="ih-upload-header-toggle">▼</span>
                `;
                header.addEventListener('click', () => this.toggleUploadList());
                list.appendChild(header);
            } else {
                // 更新标题中的计数
                const header = list.querySelector('.ih-upload-header-text');
                if (header) {
                    header.textContent = `上传进度 (${list.children.length})`;
                }
            }

            const div = document.createElement('div');
            div.className = 'ih-upload-item';
            div.id = 'ih-upload-' + task.id;
            div.innerHTML = `
                <div class="ih-upload-row">
                    <span class="ih-upload-name" title="${esc(task.name)}">${esc(task.name)}</span>
                    <span class="ih-upload-status">0%</span>
                    <button class="btn btn-xs ih-upload-pause-btn" onclick="ImageHost.togglePause(${task.id})">暂停</button>
                </div>
                <div class="ih-upload-bar"><div class="ih-upload-bar-fill" style="width:0%"></div></div>
                <div class="ih-upload-detail">0/${task.totalChunks} 分片 (0/${formatSize(task.file.size)})</div>
            `;
            list.appendChild(div);
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
            const task = uploadTasks.find(t => t.id === id);
            if (!task) return;
            task.paused = !task.paused;
            const el = document.getElementById('ih-upload-' + id);
            if (!el) return;
            const btn = el.querySelector('.ih-upload-pause-btn');
            const status = el.querySelector('.ih-upload-status');
            if (task.paused) {
                btn.textContent = '继续';
                status.textContent = '已暂停';
            } else {
                btn.textContent = '暂停';
                status.textContent = task.progress + '%';
                this.doChunkedUpload(task);
            }
        },

        updateUploadUI: function(task) {
            const el = document.getElementById('ih-upload-' + task.id);
            if (!el) return;
            el.querySelector('.ih-upload-bar-fill').style.width = task.progress + '%';
            el.querySelector('.ih-upload-status').textContent = task.progress + '%';
            const uploaded = Math.min(task.sentChunks * task.chunkSize, task.file.size);
            el.querySelector('.ih-upload-detail').textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${formatSize(uploaded)}/${formatSize(task.file.size)})`;
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
                // Step 1: Init
                if (!task.uploadId) {
                    const uploaded = Math.min(task.sentChunks * task.chunkSize, task.file.size);
                    status.textContent = `${task.sentChunks}/${task.totalChunks} 分片 (${formatSize(uploaded)}/${formatSize(task.file.size)})`;
                    const initRes = await API.ihUploadInit(task.name, task.totalChunks, {
                        fileSize: task.file.size, chunkSize: task.chunkSize,
                    });
                    task.uploadId = initRes.upload_id;
                    // 服务端已有分片 (同页面重试场景) → 跳过已传
                    if (!task.received) task.received = new Array(task.totalChunks).fill(false);
                    if (Array.isArray(initRes.received) && initRes.received.length) {
                        for (const i of initRes.received) if (i >= 0 && i < task.totalChunks) task.received[i] = true;
                        task.sentChunks = task.received.filter(Boolean).length;
                        task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                        this.updateUploadUI(task);
                    }
                }

                if (!task.received) task.received = new Array(task.totalChunks).fill(false);
                if (!task.inflight) task.inflight = new Set();

                const uploadOne = async (idx) => {
                    const start = idx * task.chunkSize;
                    const end = Math.min(start + task.chunkSize, task.file.size);
                    const chunk = task.file.slice(start, end);
                    // 分片 hash 可选: 无 crypto.subtle 时 hashChunk 返回 null, 跳过校验
                    const h = await Upload.hashChunk(chunk);
                    await API.ihUploadChunk(task.uploadId, idx, chunk, h);
                    task.received[idx] = true;
                    task.sentChunks = task.received.filter(Boolean).length;
                    task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                    this.updateUploadUI(task);
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

                this.loadPage(currentPage);
                this.autoHideUploadList();

                // Show embed dialog for single file
                if (uploadTasks.length === 1 && task.result) {
                    this.showEmbedDialog(task.result);
                }
            } catch (e) {
                status.textContent = '✗ ' + (e.message || '');
                status.style.color = 'var(--color-error)';
                btn.textContent = '重试';
                btn.style.display = '';
                btn.onclick = () => {
                    task.paused = false;
                    task.progress = Math.round((task.sentChunks / task.totalChunks) * 100);
                    status.style.color = '';
                    status.textContent = task.progress + '%';
                    btn.textContent = '暂停';
                    btn.onclick = () => ImageHost.togglePause(task.id);
                    this.doChunkedUpload(task).catch(() => {});
                };
            }
        },

        autoHideUploadList: function() {
            const allDone = uploadTasks.every(t => {
                const el = document.getElementById('ih-upload-' + t.id);
                const s = el ? el.querySelector('.ih-upload-status') : null;
                return s && (s.textContent === '✓' || s.textContent.startsWith('✗'));
            });
            if (allDone) {
                setTimeout(() => {
                    const listEl = document.getElementById('ihUploadList');
                    if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
                    uploadTasks = [];
                }, 5000);
            } else {
                // 更新进行中的计数
                const pendingCount = uploadTasks.filter(t => {
                    const el = document.getElementById('ih-upload-' + t.id);
                    const s = el ? el.querySelector('.ih-upload-status') : null;
                    return s && s.textContent !== '✓' && !s.textContent.startsWith('✗');
                }).length;
                const header = document.querySelector('.ih-upload-header-text');
                if (header) {
                    header.textContent = `上传进度 (${pendingCount})`;
                }
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
