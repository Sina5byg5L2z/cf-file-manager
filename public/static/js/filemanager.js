// File Manager - core UI logic
const FM = {
    currentPath: '',
    entries: [],
    selected: new Set(),
    viewMode: localStorage.getItem('viewMode') || 'grid',
    showHidden: false,
    sortBy: 'name',
    sortOrder: 'asc',
    page: 1,
    PAGE_SIZE: 100,
    contextTarget: null,
    clipboardPath: null,

    init() {
        this.grid = document.getElementById('fileGrid');
        this.breadcrumb = document.getElementById('breadcrumb');
        this.batchBar = document.getElementById('batchBar');
        this.selectedCount = document.getElementById('selectedCount');
        this.setupViewToggle();
        this.setupSort();
        this.setupContextMenu();
        this.setupKeyboard();
        this.setupDragDrop();
        this.setupHiddenToggle();
    },

    async navigate(path) {
        this.currentPath = path;
        this.page = 1;
        this.selected.clear();
        this.updateBatchBar();
        this.renderBreadcrumb();
        const goUpBtn = document.getElementById('btnGoUp');
        if (goUpBtn) goUpBtn.style.display = path ? 'inline-flex' : 'none';

        try {
            const data = await API.listFiles(path);
            this.entries = data.entries || [];
            this.render();
        } catch (e) {
            console.error('Failed to list files:', e);
        }
        return this;
    },

    render() {
        if (this.viewMode === 'grid') {
            this.grid.className = 'file-grid';
            this.renderGrid();
        } else {
            this.grid.className = 'file-list';
            this.renderList();
        }
    },

    renderGrid() {
        const filtered = this.getFilteredEntries();
        if (!filtered.length) {
            this.grid.innerHTML = `<div class="empty-state"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>这里空空如也</p><p class="empty-hint">把文件拖进来，或点上方「上传」开始</p></div>`;
            return;
        }
        const entriesWithIdx = this.sortEntries(this.entries.map((e, i) => ({ ...e, _idx: i })));
        const visible = this.showHidden ? entriesWithIdx : entriesWithIdx.filter(e => !e.name.startsWith('.'));
        const { slice, pagerHtml } = this.paginate(visible);
        this.grid.innerHTML = slice.map(e => `
            <div class="file-card${this.selected.has(e._idx) ? ' selected' : ''}" data-idx="${e._idx}">
                <div class="file-icon">${this.getIconHtml(e)}</div>
                <div class="file-name" title="${this.esc(e.name)}">${this.esc(e.name)}</div>
                ${e.is_dir ? '' : `<div class="file-meta">${this.formatSize(e.size)}</div>`}
            </div>
        `).join('') + pagerHtml;
        this._loadVisibleThumbs();
        this.bindFileEvents();
        this.bindPager();
    },

    renderList() {
        const filtered = this.getFilteredEntries();
        if (!filtered.length) {
            this.grid.innerHTML = `<div class="empty-state"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>这里空空如也</p><p class="empty-hint">把文件拖进来，或点上方「上传」开始</p></div>`;
            return;
        }
        const entriesWithIdx = this.sortEntries(this.entries.map((e, i) => ({ ...e, _idx: i })));
        const visible = this.showHidden ? entriesWithIdx : entriesWithIdx.filter(e => !e.name.startsWith('.'));
        const { slice, pagerHtml } = this.paginate(visible);
        this.grid.innerHTML = `
            <div class="file-list-header">
                <span></span>
                <span data-sort="name">名称 ${this.sortBy==='name'?(this.sortOrder==='asc'?'↑':'↓'):''}</span>
                <span data-sort="size">大小 ${this.sortBy==='size'?(this.sortOrder==='asc'?'↑':'↓'):''}</span>
                <span data-sort="modified">修改时间 ${this.sortBy==='modified'?(this.sortOrder==='asc'?'↑':'↓'):''}</span>
            </div>
            ${slice.map(e => `
                <div class="file-row${this.selected.has(e._idx) ? ' selected' : ''}" data-idx="${e._idx}">
                    <div class="icon">${this.getIconHtml(e)}</div>
                    <div class="name" title="${this.esc(e.name)}">${this.esc(e.name)}</div>
                    <div class="meta">${e.is_dir ? '-' : this.formatSize(e.size)}</div>
                    <div class="meta">${e.modified ? new Date(e.modified).toLocaleString('zh-CN') : '-'}</div>
                </div>
            `).join('')}
            ${pagerHtml}
        `;

        // Sort header clicks
        this.grid.querySelectorAll('.file-list-header span[data-sort]').forEach(el => {
            el.addEventListener('click', () => {
                const field = el.dataset.sort;
                if (this.sortBy === field) {
                    this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortBy = field;
                    this.sortOrder = 'asc';
                }
                document.getElementById('sortSelect').value = `${this.sortBy}:${this.sortOrder}`;
                this.render();
            });
        });

        this.bindFileEvents();
        this._loadVisibleThumbs();
        this.bindPager();
    },

    bindFileEvents() {
        const items = this.grid.querySelectorAll('[data-idx]');
        items.forEach(el => {
            const idx = parseInt(el.dataset.idx);

            // Mobile long-press support
            let longPressTimer = null;
            let touchMoved = false;

            el.addEventListener('touchstart', (e) => {
                touchMoved = false;
                longPressTimer = setTimeout(() => {
                    if (!touchMoved) {
                        e.preventDefault();
                        if (!this.selected.has(idx)) {
                            this.selected.clear();
                            this.selected.add(idx);
                            this.updateSelection();
                        }
                        this.contextTarget = idx;
                        const touch = e.touches[0];
                        this.showContextMenu(touch.clientX, touch.clientY);
                    }
                }, 500);
            }, { passive: false });

            el.addEventListener('touchmove', () => {
                touchMoved = true;
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            });

            el.addEventListener('touchend', () => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            });

            // Delayed select — cancelled if dblclick fires within 250ms
            let clickTimer = null;

            el.addEventListener('click', (e) => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                if (e.ctrlKey || e.metaKey) {
                    if (this.selected.has(idx)) this.selected.delete(idx);
                    else this.selected.add(idx);
                    this.updateSelection();
                } else if (e.shiftKey && this.selected.size > 0) {
                    const last = Math.max(...this.selected);
                    const [a, b] = [Math.min(last, idx), Math.max(last, idx)];
                    for (let i = a; i <= b; i++) this.selected.add(i);
                    this.updateSelection();
                } else {
                    clickTimer = setTimeout(() => {
                        clickTimer = null;
                        this.selected.clear();
                        this.selected.add(idx);
                        this.updateSelection();
                    }, 250);
                }
            });

            el.addEventListener('dblclick', () => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                this.selected.clear();
                this.updateSelection();
                const entry = this.entries[idx];
                if (entry.is_dir) {
                    const newPath = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;
                    this.navigate(newPath);
                } else {
                    this.previewFile(idx);
                }
            });

            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!this.selected.has(idx)) {
                    this.selected.clear();
                    this.selected.add(idx);
                    this.updateSelection();
                }
                this.contextTarget = idx;
                this.showContextMenu(e.clientX, e.clientY);
            });
        });
    },

    updateSelection() {
        this.grid.querySelectorAll('[data-idx]').forEach(el => {
            const idx = parseInt(el.dataset.idx);
            el.classList.toggle('selected', this.selected.has(idx));
        });
        this.updateBatchBar();
    },

    updateBatchBar() {
        const count = this.selected.size;
        if (count > 1) {
            this.batchBar.style.display = 'flex';
            this.selectedCount.textContent = `${count} 项已选`;
        } else {
            this.batchBar.style.display = 'none';
        }
    },

    // Breadcrumb
    renderBreadcrumb() {
        const parts = this.currentPath ? this.currentPath.split('/') : [];
        let html = `<span class="breadcrumb-item${parts.length===0?' active':''}" data-path="">根目录</span>`;
        let accumulated = '';
        parts.forEach((p, i) => {
            accumulated = accumulated ? `${accumulated}/${p}` : p;
            html += `<span class="breadcrumb-sep">›</span>`;
            html += `<span class="breadcrumb-item${i===parts.length-1?' active':''}" data-path="${this.esc(accumulated)}">${this.esc(p)}</span>`;
        });
        this.breadcrumb.innerHTML = html;
        this.breadcrumb.querySelectorAll('.breadcrumb-item:not(.active)').forEach(el => {
            el.addEventListener('click', () => this.navigate(el.dataset.path));
        });
    },

    // View toggle
    setupViewToggle() {
        const gridBtn = document.getElementById('btnGridView');
        const listBtn = document.getElementById('btnListView');
        gridBtn.addEventListener('click', () => {
            this.viewMode = 'grid';
            localStorage.setItem('viewMode', 'grid');
            gridBtn.classList.add('active');
            listBtn.classList.remove('active');
            this.render();
        });
        listBtn.addEventListener('click', () => {
            this.viewMode = 'list';
            localStorage.setItem('viewMode', 'list');
            listBtn.classList.add('active');
            gridBtn.classList.remove('active');
            this.render();
        });
        // Init
        if (this.viewMode === 'list') { listBtn.classList.add('active'); gridBtn.classList.remove('active'); }
    },

    // Sort
    setupSort() {
        document.getElementById('sortSelect').addEventListener('change', (e) => {
            const [by, order] = e.target.value.split(':');
            this.sortBy = by;
            this.sortOrder = order;
            this.render();
        });
    },

    // Context menu
    setupContextMenu() {
        const menu = document.getElementById('contextMenu');
        const hideMenu = () => { menu.style.display = 'none'; };
        document.addEventListener('click', hideMenu);
        document.addEventListener('touchstart', (e) => {
            if (!menu.contains(e.target)) hideMenu();
        });

        menu.querySelectorAll('.context-item').forEach(el => {
            el.addEventListener('click', () => {
                const action = el.dataset.action;
                menu.style.display = 'none';
                if (this.contextTarget !== null) this.handleAction(action, this.contextTarget);
            });
        });
    },

    showContextMenu(x, y) {
        const menu = document.getElementById('contextMenu');
        // Show/hide "上传到图床" based on file type
        const ihItem = menu.querySelector('[data-action="imagehost"]');
        if (ihItem) {
            const entry = this.contextTarget !== null ? this.entries[this.contextTarget] : null;
            const ihExts = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','svg','mp4','webm','mov','mkv','avi','flv','wmv','mp3','wav','flac','aac','ogg','wma','pdf']);
            ihItem.style.display = (entry && !entry.is_dir && ihExts.has((entry.ext || '').toLowerCase())) ? '' : 'none';
        }
        menu.style.display = 'block';
        const rect = menu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    },

    async handleAction(action, idx) {
        const entry = this.entries[idx];
        const path = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;

        switch (action) {
            case 'open':
                if (entry.is_dir) this.navigate(path);
                else this.previewFile(idx);
                break;
            case 'preview':
                this.previewFile(idx);
                break;
            case 'rename':
                const newName = await Dialog.prompt('重命名为:', entry.name, { title: '重命名' });
                if (newName && newName !== entry.name) {
                    await API.rename(path, newName);
                    this.navigate(this.currentPath);
                }
                break;
            case 'download':
                if (entry.is_dir) {
                    await API.batchDownload([path]);
                } else {
                    API.downloadFile(path, entry.size);
                }
                break;
            case 'delete':
                if (await Dialog.confirm(`确定删除 "${entry.name}"?`, { danger: true, okText: '删除' })) {
                    await API.deleteFile(path);
                    this.navigate(this.currentPath);
                }
                break;
            case 'copy':
                this.clipboardPath = path;
                document.getElementById('btnPaste').style.display = 'inline-flex';
                break;
            case 'move':
                this.showMoveDialog(idx);
                break;
            case 'share':
                Share.showCreateDialog(path);
                break;
            case 'imagehost':
                if (!entry.is_dir) this.importToImageHost(path);
                break;
        }
    },

    previewFile(idx) {
        const entry = this.entries[idx];
        const path = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;
        Preview.show(path, entry);
    },

    _moveSelectedPath: '',

    showMoveDialog(idx) {
        const entry = this.entries[idx];
        this._moveSourceIdx = idx;
        const modal = document.getElementById('moveModal');
        const tree = document.getElementById('moveTree');
        const targetInput = document.getElementById('moveTarget');
        this._moveSelectedPath = '';
        targetInput.value = '';
        modal.style.display = 'flex';

        // Build tree with root node
        tree.innerHTML = '';
        const rootItem = this._createTreeNode('', '根目录', true);
        tree.appendChild(rootItem);
        // Auto-expand root
        this._expandTreeNode(rootItem);

        document.getElementById('btnCloseMove').onclick = () => modal.style.display = 'none';
        document.getElementById('btnConfirmMove').onclick = async () => {
            const target = this._moveSelectedPath;
            const src = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;
            if (src === target || (!target && !this.currentPath)) return;
            try {
                await API.moveFile(src, target);
                modal.style.display = 'none';
                this.navigate(this.currentPath);
            } catch (e) {
                Dialog.alert('移动失败: ' + (e.message || '未知错误'));
            }
        };
    },

    _createTreeNode(path, name, isRoot = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'move-tree-node';

        const row = document.createElement('div');
        row.className = 'move-tree-item';
        row.dataset.path = path;

        const arrow = document.createElement('span');
        arrow.className = 'move-tree-arrow';
        arrow.textContent = '▶';

        const icon = document.createElement('span');
        icon.className = 'move-tree-icon';
        icon.innerHTML = (window.FileIcons && FileIcons.html(name, true)) || '📁';

        const label = document.createElement('span');
        label.className = 'move-tree-label';
        label.textContent = isRoot ? '根目录' : name;

        row.appendChild(arrow);
        row.appendChild(icon);
        row.appendChild(label);
        wrapper.appendChild(row);

        // Children container (hidden by default)
        const children = document.createElement('div');
        children.className = 'move-tree-children';
        wrapper.appendChild(children);

        // Click arrow to expand/collapse
        arrow.addEventListener('click', (e) => {
            e.stopPropagation();
            if (wrapper.classList.contains('expanded')) {
                wrapper.classList.remove('expanded');
                arrow.textContent = '▶';
            } else {
                wrapper.classList.add('expanded');
                arrow.textContent = '▼';
                if (!wrapper.dataset.loaded) {
                    wrapper.dataset.loaded = 'true';
                    this._loadTreeChildren(children, path);
                }
            }
        });

        // Click row to select this folder as target
        row.addEventListener('click', () => {
            // Deselect all
            document.querySelectorAll('#moveTree .move-tree-item.selected').forEach(el => el.classList.remove('selected'));
            row.classList.add('selected');
            this._moveSelectedPath = path;
            document.getElementById('moveTarget').value = path || '/';
        });

        return wrapper;
    },

    async _loadTreeChildren(container, path) {
        container.innerHTML = '<div class="move-tree-loading">加载中...</div>';
        try {
            const data = await API.listFiles(path);
            const dirs = data.entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
            container.innerHTML = '';
            if (dirs.length === 0) {
                container.innerHTML = '<div class="move-tree-empty">无子目录</div>';
                return;
            }
            for (const d of dirs) {
                const childPath = path ? `${path}/${d.name}` : d.name;
                const node = this._createTreeNode(childPath, d.name);
                container.appendChild(node);
            }
        } catch (e) {
            container.innerHTML = '<div class="move-tree-empty">加载失败</div>';
        }
    },

    _expandTreeNode(node) {
        node.classList.add('expanded');
        const arrow = node.querySelector(':scope > .move-tree-item .move-tree-arrow');
        if (arrow) arrow.textContent = '▼';
        if (!node.dataset.loaded) {
            node.dataset.loaded = 'true';
            const children = node.querySelector(':scope > .move-tree-children');
            if (children) this._loadTreeChildren(children, node.querySelector(':scope > .move-tree-item').dataset.path);
        }
    },

    // Keyboard shortcuts
    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;
            if (e.key === 'Delete' && this.selected.size > 0) {
                this.batchDeleteSelected();
            }
            if (e.key === 'F2' && this.selected.size === 1) {
                const idx = [...this.selected][0];
                this.handleAction('rename', idx);
            }
            if (e.ctrlKey && e.key === 'a') {
                e.preventDefault();
                this.selected = new Set(this.entries.map((_, i) => i));
                this.updateSelection();
            }
            if (e.ctrlKey && e.key === 'v' && this.clipboardPath) {
                e.preventDefault();
                this.paste();
            }
            if (e.key === 'Escape') {
                this.selected.clear();
                this.updateSelection();
                document.getElementById('contextMenu').style.display = 'none';
            }
        });
    },

    // Drag & drop files into the browser
    setupDragDrop() {
        const overlay = document.getElementById('uploadOverlay');
        let dragCounter = 0;

        const isExternalFiles = (e) => {
            const t = e.dataTransfer.types;
            return t.includes ? t.includes('Files') : t.indexOf('Files') >= 0;
        };

        document.addEventListener('dragenter', (e) => {
            if (!isExternalFiles(e)) return;
            e.preventDefault();
            dragCounter++;
            overlay.style.display = 'flex';
        });
        document.addEventListener('dragleave', (e) => {
            if (!isExternalFiles(e)) return;
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) { overlay.style.display = 'none'; dragCounter = 0; }
        });
        document.addEventListener('dragover', (e) => {
            if (!isExternalFiles(e)) return;
            e.preventDefault();
        });
        document.addEventListener('drop', (e) => {
            if (!isExternalFiles(e)) return;
            e.preventDefault();
            overlay.style.display = 'none';
            dragCounter = 0;
            if (e.dataTransfer.files.length > 0) {
                Upload.uploadFiles(e.dataTransfer.files, this.currentPath);
            }
        });
    },

    setupHiddenToggle() {
        const btn = document.getElementById('btnToggleHidden');
        if (!btn) return;
        const eyeOpen = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
        const eyeOff = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
        btn.addEventListener('click', () => {
            this.showHidden = !this.showHidden;
            const label = document.getElementById('hiddenLabel');
            const icon = document.getElementById('hiddenIcon');
            if (label) label.textContent = this.showHidden ? '隐藏隐藏' : '显示隐藏';
            if (icon) icon.innerHTML = this.showHidden ? eyeOpen : eyeOff;
            btn.classList.toggle('active', this.showHidden);
            this.render();
        });
    },

    // 客户端分页: 数据已整目录在内存, 按页切片渲染; 超页时自动收敛页码
    paginate(list) {
        const totalPages = Math.max(1, Math.ceil(list.length / this.PAGE_SIZE));
        if (this.page > totalPages) this.page = totalPages;
        if (this.page < 1) this.page = 1;
        const start = (this.page - 1) * this.PAGE_SIZE;
        const slice = list.slice(start, start + this.PAGE_SIZE);
        let pagerHtml = '';
        if (totalPages > 1) {
            let btns = '';
            for (let p = 1; p <= totalPages; p++) {
                btns += `<button class="fm-pager-btn${p === this.page ? ' active' : ''}" data-page="${p}">${p}</button>`;
            }
            pagerHtml = `<div class="fm-pager"><span class="fm-pager-info">共 ${list.length} 项 · 第 ${this.page}/${totalPages} 页</span><button class="fm-pager-btn" data-page="${this.page - 1}"${this.page === 1 ? ' disabled' : ''}>‹</button>${btns}<button class="fm-pager-btn" data-page="${this.page + 1}"${this.page === totalPages ? ' disabled' : ''}>›</button></div>`;
        }
        return { slice, pagerHtml };
    },

    bindPager() {
        this.grid.querySelectorAll('.fm-pager-btn[data-page]:not([disabled])').forEach(el => {
            el.addEventListener('click', () => {
                this.page = parseInt(el.dataset.page);
                this.render();
                this.grid.scrollTop = 0;
            });
        });
    },

    getFilteredEntries() {
        if (this.showHidden) return this.entries;
        return this.entries.filter(e => !e.name.startsWith('.'));
    },

    // 前端本地排序: 文件夹在前, 主键 asc/desc, 名称升序兜底; 返回副本不动原数组, _idx 保持原始下标
    sortEntries(arr) {
        const key = {
            name: (e) => e.name.toLowerCase(),
            size: (e) => e.size,
            modified: (e) => e.modified || 0,
            ext: (e) => (e.ext || '').toLowerCase(),
        }[this.sortBy] || ((e) => e.name.toLowerCase());
        const dirFirst = (a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0);
        const nameAsc = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return [...arr].sort((a, b) => {
            const x = key(a), y = key(b);
            const r = x < y ? -1 : x > y ? 1 : 0;
            return dirFirst(a, b) || (this.sortOrder === 'desc' ? -r : r) || nameAsc(a, b);
        });
    },

    // Batch operations
    async batchDeleteSelected() {
        const paths = [...this.selected].map(i => {
            const e = this.entries[i];
            return this.currentPath ? `${this.currentPath}/${e.name}` : e.name;
        });
        if (await Dialog.confirm(`确定删除 ${paths.length} 个项目?`, { danger: true, okText: '删除' })) {
            await API.batchDelete(paths);
            this.selected.clear();
            this.navigate(this.currentPath);
        }
    },

    async batchDownloadSelected() {
        const paths = [...this.selected].map(i => {
            const e = this.entries[i];
            return this.currentPath ? `${this.currentPath}/${e.name}` : e.name;
        });
        await API.batchDownload(paths);
    },

    async paste() {
        if (!this.clipboardPath) return;
        try {
            await API.copyFile(this.clipboardPath, this.currentPath);
            this.clipboardPath = null;
            document.getElementById('btnPaste').style.display = 'none';
            this.navigate(this.currentPath);
        } catch (e) {
            Dialog.alert('粘贴失败: ' + (e.message || '未知错误'));
        }
    },

    async importToImageHost(path) {
        try {
            const result = await API.importToImageHost(path);
            ImageHost.showEmbedDialog(result);
        } catch (e) {
            Dialog.alert('上传到图床失败: ' + (e.message || '未知错误'));
        }
    },

    // Helpers
    // 图片 + 浏览器可解码视频走缩略图接口 (预存缩略图 t: blob 优先; 无则图片回退原图 / 视频 404 → 懒生成)
    _thumbExts: new Set(['png','jpg','jpeg','gif','webp','bmp','ico','mp4','m4v','mov','webm','mkv']),
    // 懒生成仅针对浏览器可解码的视频 (avi/wmv/flv 解不了, 直接图标不浪费流量)
    _lazyVideoExts: new Set(['mp4','m4v','mov','webm','mkv']),
    _lazyQueue: [],
    _lazyActive: 0,
    _lazyTried: new Set(),

    // emoji 兜底映射 (仅 fileicons.js 未加载时使用)
    _emojiIcons: {
        // Video (无 ffmpeg 无法抽帧, 直接显示图标)
        mp4:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',wmv:'🎬',flv:'🎬',webm:'🎬',m4v:'🎬',
        // Images (SVG can't be thumbnailed by ffmpeg)
        svg:'🖼️',
        // Audio
        mp3:'🎵',wav:'🎵',flac:'🎵',aac:'🎵',ogg:'🎵',wma:'🎵',
        // Docs
        pdf:'📄',doc:'📝',docx:'📝',txt:'📝',md:'📝',rtf:'📝',
        // Spreadsheets
        xls:'📊',xlsx:'📊',csv:'📊',
        // Presentations
        ppt:'📽️',pptx:'📽️',
        // Code
        js:'💻',ts:'💻',py:'💻',rs:'💻',go:'💻',java:'💻',c:'💻',cpp:'💻',h:'💻',
        html:'💻',css:'💻',json:'💻',xml:'💻',yaml:'💻',yml:'💻',toml:'💻',
        sh:'💻',bat:'💻',ps1:'💻',
        // Archives
        zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',bz2:'📦',
        // Executables
        exe:'⚙️',msi:'⚙️',dll:'⚙️',deb:'⚙️',rpm:'⚙️',
    },

    // vendored vscode-icons SVG 图标 (fileicons.js), 未加载返回 null
    _iconSvgHtml(entry) {
        if (!window.FileIcons) return null;
        return entry.is_dir ? FileIcons.folder(entry.name) : FileIcons.file(entry.name);
    },

    getIcon(entry) {
        if (entry.is_dir) return '📁';
        const ext = (entry.ext || '').toLowerCase();
        return this._emojiIcons[ext] || '📄';
    },

    getIconHtml(entry) {
        if (entry.is_dir) return this._iconSvgHtml(entry) || '📁';
        const ext = (entry.ext || '').toLowerCase();
        if (this._thumbExts.has(ext)) {
            const path = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;
            return '<img class="thumb-icon" data-src="' + this.esc(API.thumbnailUrl(path)) + '" alt="" loading="lazy">';
        }
        return this._iconSvgHtml(entry) || this.esc(this.getIcon(entry));
    },

    formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    },

    _loadVisibleThumbs() {
        const imgs = this.grid.querySelectorAll('img.thumb-icon[data-src]');
        if (!imgs.length) return;
        if (!this._thumbObserver) {
            this._thumbObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.classList.add('thumb-loading');
                        img.onload = () => img.classList.remove('thumb-loading');
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        img.onerror = () => {
                            img.classList.remove('thumb-loading');
                            // 404 → 可解码视频尝试懒生成抓帧, 其他回退 emoji
                            const card = img.closest('[data-idx]');
                            const entry = card ? this.entries[parseInt(card.dataset.idx)] : null;
                            const ext = entry && !entry.is_dir ? (entry.ext || '').toLowerCase() : '';
                            if (this._lazyVideoExts.has(ext)) {
                                this._lazyThumb(img, entry);
                            } else {
                                this._fallbackIcon(img, card);
                            }
                        };
                        this._thumbObserver.unobserve(img);
                    }
                });
            }, { rootMargin: '200px' });
        }
        imgs.forEach(img => this._thumbObserver.observe(img));
    },

    _fallbackIcon(img, card) {
        const entry = card ? this.entries[parseInt(card.dataset.idx)] : null;
        if (img.parentElement && entry) img.parentElement.innerHTML = this._iconSvgHtml(entry) || this.esc(this.getIcon(entry));
    },

    // 旧视频无预存缩略图: 用预览流抓帧 → 回写服务端 → 直接显示 (限并发 2, 会话内失败去重)
    _lazyThumb(img, entry) {
        const path = this.currentPath ? `${this.currentPath}/${entry.name}` : entry.name;
        if (this._lazyTried.has(path)) { this._fallbackIcon(img, img.closest('[data-idx]')); return; }
        this._lazyTried.add(path);
        this._lazyQueue.push({ img, path });
        this._pumpLazy();
    },

    async _pumpLazy() {
        if (this._lazyActive >= 2 || !this._lazyQueue.length) return;
        const job = this._lazyQueue.shift();
        this._lazyActive++;
        try {
            const dataUrl = await this._grabFrame(API.previewUrl(job.path));
            const blob = await (await fetch(dataUrl)).blob();
            await API.uploadThumbnail(job.path, blob);
            if (job.img.isConnected) { job.img.onerror = null; job.img.src = dataUrl; }
        } catch (e) {
            if (job.img.isConnected) this._fallbackIcon(job.img, job.img.closest('[data-idx]'));
        } finally {
            this._lazyActive--;
            this._pumpLazy();
        }
    },

    // video + canvas 抓帧 (浏览器按需 Range 拉流, 只拉 moov 与目标帧所需字节)
    _grabFrame(url) {
        return new Promise((resolve, reject) => {
            const v = document.createElement('video');
            v.muted = true;
            v.preload = 'metadata';
            const fail = (e) => { v.removeAttribute('src'); reject(e || new Error('decode failed')); };
            v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); };
            v.onseeked = () => {
                try {
                    const scale = Math.min(1, 256 / Math.max(v.videoWidth, v.videoHeight || 1));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(v.videoWidth * scale));
                    c.height = Math.max(1, Math.round(v.videoHeight * scale));
                    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                    resolve(c.toDataURL('image/jpeg', 0.8));
                } catch (e) { fail(e); }
            };
            v.onerror = () => fail();
            setTimeout(() => fail(new Error('thumb timeout')), 20000);
            v.src = url;
        });
    },

    esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
};
