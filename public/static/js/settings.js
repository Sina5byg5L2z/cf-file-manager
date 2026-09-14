// 应用参数设置: 服务端 D1 存储, 所有设备共享一份配置;
// 每项限制分"移动端/电脑端"两档, 运行时按当前设备类型取值
// 分片大小候选必须与服务端 deriveChunkSize 的集合一致
const AppSettings = {
    defaults: {
        chunk_default: { chunk_size: 524288, concurrent: 4 },
        chunk_rules: [],   // [{min,max,chunk_size,concurrent}] 按序先命中先用
        upload_limit:     { mobile: 209715200, desktop: 209715200 },
        preview_text:     { mobile: 524288,   desktop: 1048576 },
        preview_markdown: { mobile: 262144,   desktop: 524288 },
        preview_html:     { mobile: 1048576,  desktop: 5242880 },
    },

    data: null,        // 服务端加载成功后的完整设置; null = 未加载(用默认)
    ready: null,       // load() 的 Promise, 页面可在首次预览前 await
    serverMaxUpload: 209715200,

    isMobile: /Mobi|Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)),

    deviceKey() { return this.isMobile ? 'mobile' : 'desktop'; },
    merged() { return this.data || this.defaults; },

    // ---- 同步取值 (upload.js / preview.js 用) ----
    // 按文件大小找分片规则: 数组顺序先命中先用, 都未命中走 DEFAULT
    chunkRuleFor(size) {
        const m = this.merged();
        for (const r of (m.chunk_rules || [])) {
            if (size >= r.min && size <= r.max) return r;
        }
        return m.chunk_default;
    },
    uploadLimit() { return this.merged().upload_limit[this.deviceKey()]; },
    previewLimit(kind) { return this.merged()[kind][this.deviceKey()]; }, // kind: preview_text / preview_markdown / preview_html

    // 用原生 fetch (管理页/分享页通用; 分享页无 api.js 与 token, GET 本就是公开接口)
    load() {
        this.ready = (async () => {
            try {
                const res = await fetch('/api/settings');
                if (!res.ok) return;
                const r = await res.json();
                if (r && r.settings) { this.data = r.settings; this.serverMaxUpload = r.max_upload_size || this.serverMaxUpload; }
            } catch (e) { /* 加载失败用内置默认, 不阻塞页面 */ }
        })();
        return this.ready;
    },

    async save(settings) {
        const r = await API.saveSettings(settings);
        if (r && r.error) throw new Error(r.error);
        this.data = r.settings;
        return r;
    }
};

const SettingsUI = {
    modal: null,
    CHUNK_OPTS: [[65536, '64 KB'], [131072, '128 KB'], [262144, '256 KB'], [524288, '512 KB'], [1048576, '1 MB']],
    CONC_OPTS: [1, 2, 3, 4, 6, 8],

    init() {
        if (this._inited) return; // 幂等: 防重复绑定监听器
        this._inited = true;
        this.modal = document.getElementById('settingsModal');
        document.getElementById('btnSettings').addEventListener('click', () => this.show());
        document.getElementById('btnCloseSettings').addEventListener('click', () => this._close());
        this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this._close(); });
        document.getElementById('btnSetSave').addEventListener('click', () => this.save());
        document.getElementById('btnAddRule').addEventListener('click', () => {
            const row = this.buildRuleRow({ min: 0, max: 1048576, chunk_size: 524288, concurrent: 4 });
            document.getElementById('chunkRules').appendChild(row);
            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                row.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
                    { duration: 160, easing: 'ease-out' });
            }
            row.querySelector('.rule-min').focus();
        });
    },

    _mb(id) { return document.getElementById(id); },

    // 关闭弹窗: 兜底清扫可能残留的拖拽幽灵行 (正常拖拽结束时已由 endDrag 清理)
    _close() {
        this.modal.style.display = 'none';
        document.querySelectorAll('.rule-ghost').forEach((g) => g.remove());
    },

    // ---- 分片规则编辑器 (DOM 即编辑状态: 拖动排序只移动节点, 保存时按 DOM 顺序收集) ----
    _chunkOptions(sel) {
        sel.innerHTML = this.CHUNK_OPTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    },
    _concOptions(sel) {
        sel.innerHTML = this.CONC_OPTS.map((v) => `<option value="${v}">${v}</option>`).join('');
    },
    _fmtSize(bytes) {
        if (!bytes) return '0';
        const KB = 1024, MB = 1048576, GB = 1073741824;
        const trim = (n) => String(parseFloat(n.toFixed(2)));
        if (bytes >= GB) return trim(bytes / GB) + 'GB';
        if (bytes >= MB) return trim(bytes / MB) + 'MB';
        return trim(bytes / KB) + 'KB';
    },
    _parseSize(text) { // 空=0; 裸数字按 MB; 支持 512KB / 1MB / 2GB; 非法返回 NaN
        const t = String(text || '').trim().toUpperCase();
        if (!t) return 0;
        const m = t.match(/^([\d.]+)\s*(B|KB|MB|GB)?$/);
        if (!m) return NaN;
        const n = parseFloat(m[1]);
        if (!Number.isFinite(n) || n < 0) return NaN;
        const unit = m[2] || 'MB';
        return Math.round(n * { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[unit]);
    },

    buildRuleRow(rule) {
        const div = document.createElement('div');
        div.className = 'chunk-rule-row';
        div.innerHTML =
            '<span class="rule-drag" title="拖动排序"><span class="rule-idx"></span><span class="rule-grip">⠿</span></span>' +
            '<input type="text" class="rule-min" placeholder="0">' +
            '<span class="rule-sep">~</span>' +
            '<input type="text" class="rule-max" placeholder="如 2GB">' +
            '<select class="rule-chunk"></select>' +
            '<select class="rule-conc"></select>' +
            '<button type="button" class="rule-del" title="删除规则">✕</button>';
        this._chunkOptions(div.querySelector('.rule-chunk'));
        this._concOptions(div.querySelector('.rule-conc'));
        div.querySelector('.rule-min').value = this._fmtSize(rule.min);
        div.querySelector('.rule-max').value = this._fmtSize(rule.max);
        div.querySelector('.rule-chunk').value = String(rule.chunk_size);
        div.querySelector('.rule-conc').value = String(rule.concurrent);
        div.querySelector('.rule-del').addEventListener('click', () => {
            if (div.classList.contains('removing')) return;
            div.classList.add('removing');
            const done = () => div.remove();
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
            else div.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }],
                { duration: 130, easing: 'ease-in' }).onfinish = done;
        });
        this.dragBind(div);
        return div;
    },

    // 指针拖动排序: 幽灵行跟随指针 + FLIP 让位动画 (虚线占位框与其余行都平滑滑入新槽;
    // prefers-reduced-motion 时退化为直接换位)。
    // 结束信号多重兜底: 正常松开 / 系统取消 / 捕获丢失 / 窗口失焦 / Esc — 幽灵行必被清理
    dragBind(row) {
        const handle = row.querySelector('.rule-drag');
        const container = document.getElementById('chunkRules');
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无法捕获, 不影响排序 */ }
            const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            // 幽灵行: 克隆当前行跟随指针 (cloneNode 不带运行时值, 手动回填), 原行变为虚线占位框
            const rect = row.getBoundingClientRect();
            const ghost = row.cloneNode(true);
            ['input', 'select'].forEach((sel) => {
                const src = row.querySelectorAll(sel), dst = ghost.querySelectorAll(sel);
                src.forEach((el, i) => { if (dst[i]) dst[i].value = el.value; });
            });
            ghost.classList.add('rule-ghost');
            // counter-reset 让幽灵行编号与原位一致 (脱离 #chunkRules 后计数器会归零)
            ghost.style.cssText = `counter-reset:rule-idx ${[...container.children].indexOf(row)};`
                + `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;margin:0;`
                + 'pointer-events:none;transform:translate(0,0)';
            document.body.appendChild(ghost);
            const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
            row.classList.add('dragging');
            let ended = false;

            const onMove = (ev) => {
                ghost.style.transform = `translate(${ev.clientX - offX - rect.left}px, ${ev.clientY - offY - rect.top}px)`;
                const hit = document.elementFromPoint(ev.clientX, ev.clientY);
                const over = hit && hit.closest ? hit.closest('.chunk-rule-row') : null;
                if (!over || over === row || over.parentElement !== container) return;
                const r2 = over.getBoundingClientRect();
                const before = ev.clientY < r2.top + r2.height / 2;
                // 无操作守卫: 目标位置与当前位置相同才跳过 (before=插到 over 前, after=插到 over 后)
                if ((before && over.previousElementSibling === row) || (!before && over.nextElementSibling === row)) return;
                if (reduceMotion) {
                    container.insertBefore(row, before ? over : over.nextSibling);
                    return;
                }
                // FLIP: 先记录各行位置, 换位后从位移差动画归位 (占位框也滑入目标槽, 对齐参考 demo)
                const all = [...container.children]
                    .map((el) => ({ el, top: el.getBoundingClientRect().top }));
                container.insertBefore(row, before ? over : over.nextSibling);
                all.forEach(({ el, top }) => {
                    const d = top - el.getBoundingClientRect().top;
                    if (Math.abs(d) > 1) el.animate(
                        [{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }],
                        { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' });
                });
                // Chrome 在 insertBefore 移动节点时会视作移除而丢失 pointer capture, 需重新捕获
                try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* 丢失也不影响: 监听器在 window 上 */ }
            };

            const endDrag = () => {
                if (ended) return;
                ended = true;
                ghost.remove();
                row.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', endDrag);
                window.removeEventListener('pointercancel', endDrag);
                window.removeEventListener('blur', endDrag);
                window.removeEventListener('keydown', onKey, true);
            };
            const onKey = (ev) => { if (ev.key === 'Escape') endDrag(); };

            // 监听器挂 window 而非 handle: 换位导致 capture 丢失时事件依然可达 (拖动不中断);
            // 不把 lostpointercapture 当结束信号 — insertBefore 换位会触发它, 不能据此终止拖动
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', endDrag);
            window.addEventListener('pointercancel', endDrag);
            window.addEventListener('blur', endDrag);
            window.addEventListener('keydown', onKey, true);
        });
    },

    renderRules(rules, dflt) {
        const container = document.getElementById('chunkRules');
        container.innerHTML = '';
        for (const r of rules) container.appendChild(this.buildRuleRow(r));
        const drow = document.getElementById('chunkDefault');
        drow.innerHTML = '<span class="rule-drag" style="visibility:hidden"></span>' +
            '<span class="rule-default-tag"><b>DEFAULT</b> · 未命中任何规则时</span>' +
            '<select class="rule-chunk"></select><select class="rule-conc"></select>';
        this._chunkOptions(drow.querySelector('.rule-chunk'));
        this._concOptions(drow.querySelector('.rule-conc'));
        drow.querySelector('.rule-chunk').value = String(dflt.chunk_size);
        drow.querySelector('.rule-conc').value = String(dflt.concurrent);
    },

    show() {
        document.querySelectorAll('.rule-ghost').forEach((g) => g.remove()); // 防御: 清掉历史残留
        const s = AppSettings.merged();
        const maxMB = Math.floor(AppSettings.serverMaxUpload / 1048576);
        this._mb('setUploadMobile').max = maxMB;
        this._mb('setUploadDesktop').max = maxMB;
        this._mb('setUploadMobile').value = String(Math.round(s.upload_limit.mobile / 1048576 * 100) / 100);
        this._mb('setUploadDesktop').value = String(Math.round(s.upload_limit.desktop / 1048576 * 100) / 100);
        this.renderRules(s.chunk_rules || [], s.chunk_default);
        for (const kind of ['preview_text', 'preview_markdown', 'preview_html']) {
            for (const d of ['mobile', 'desktop']) {
                const el = this._mb(`set_${kind}_${d}`);
                el.value = String(Math.round(s[kind][d] / 1024 / 1024 * 1000) / 1000);
            }
        }
        document.getElementById('setDeviceHint').textContent =
            AppSettings.isMobile ? '当前设备按「移动端」档生效' : '当前设备按「电脑端」档生效';
        document.getElementById('setError').style.display = 'none';
        this.modal.style.display = 'flex';
    },

    collectRules() {
        const out = [];
        for (const row of document.querySelectorAll('#chunkRules .chunk-rule-row:not(.removing)')) {
            const min = this._parseSize(row.querySelector('.rule-min').value);
            const max = this._parseSize(row.querySelector('.rule-max').value);
            if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('分片范围格式无效，请用如 512KB / 1MB / 2GB');
            if (max < min) throw new Error('分片范围无效（上限小于下限）');
            out.push({
                min, max,
                chunk_size: parseInt(row.querySelector('.rule-chunk').value, 10),
                concurrent: parseInt(row.querySelector('.rule-conc').value, 10),
            });
        }
        return out;
    },

    async save() {
        const err = document.getElementById('setError');
        err.style.display = 'none';
        const readMB = (id) => parseFloat(this._mb(id).value);
        try {
            const settings = {
                chunk_default: {
                    chunk_size: parseInt(this._mb('chunkDefault').querySelector('.rule-chunk').value, 10),
                    concurrent: parseInt(this._mb('chunkDefault').querySelector('.rule-conc').value, 10),
                },
                chunk_rules: this.collectRules(),
                upload_limit: { mobile: readMB('setUploadMobile') * 1048576, desktop: readMB('setUploadDesktop') * 1048576 },
                preview_text:     { mobile: readMB('set_preview_text_mobile') * 1048576, desktop: readMB('set_preview_text_desktop') * 1048576 },
                preview_markdown: { mobile: readMB('set_preview_markdown_mobile') * 1048576, desktop: readMB('set_preview_markdown_desktop') * 1048576 },
                preview_html:     { mobile: readMB('set_preview_html_mobile') * 1048576, desktop: readMB('set_preview_html_desktop') * 1048576 },
            };
            if (!Number.isFinite(settings.upload_limit.mobile) || !Number.isFinite(settings.upload_limit.desktop)
                || Object.values(settings.preview_text).concat(Object.values(settings.preview_markdown), Object.values(settings.preview_html))
                    .some((v) => !Number.isFinite(v) || v <= 0)) {
                throw new Error('请填写有效的数值');
            }
            await AppSettings.save(settings);
            this._close();
        } catch (e) {
            err.textContent = (e && e.message) || '保存失败';
            err.style.display = 'block';
        }
    }
};
