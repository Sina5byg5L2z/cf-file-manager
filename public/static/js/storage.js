// ============================================================================
// storage.js (前端) — 存储分库的界面层
//
//   1. 容量告警: 后端 507 {code:'D1_CAPACITY'} 的统一出口, 按名额池分三态引导
//   2. 存储库面板: 「参数设置 → 存储库」里的库清单与一键扩容
//   3. 主库高危横幅: 主库**实际剩余** (limit_bytes - used_bytes) < 20MB 时常驻提示
//      (主库满了连 fs_nodes / storage_dbs 都写不了, 用户会失去「删文件腾空间」的能力)
// ============================================================================

// 主库高危横幅阈值: 主库实际剩余空间低于此值就常驻提示。
// 注意判据是 limit_bytes - used_bytes, 不是后端返回的 free_bytes —— 见 StorageUI.boot 注释。
const PRIMARY_ALERT_BYTES = 20 * 1024 * 1024;

const StorageUI = {
    _busy: false,
    _panelLoading: false,
    _bannerShown: false,

    // ---------------- 工具 ----------------
    fmt(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return '0';
        const KB = 1024, MB = 1048576, GB = 1073741824;
        const t = (x) => String(Math.round(x * 10) / 10);
        if (n >= GB) return t(n / GB) + ' GB';
        if (n >= MB) return t(n / MB) + ' MB';
        return t(n / KB) + ' KB';
    },
    esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    },
    copy(text, btn) {
        const done = () => {
            if (!btn) return;
            const old = btn.textContent;
            btn.textContent = '已复制';
            setTimeout(() => { btn.textContent = old; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => this._copyFallback(text, done));
        } else {
            this._copyFallback(text, done);
        }
    },
    _copyFallback(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
        ta.remove();
    },
    _code(text) {
        return '<div class="st-codewrap"><code class="st-code">' + this.esc(text) + '</code></div>';
    },

    // ---------------- 弹窗骨架 ----------------
    _modal(title, bodyHtml, actions) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML =
            '<div class="modal" style="max-width:680px">' +
              '<div class="modal-header"><span>' + this.esc(title) + '</span>' +
              '<button class="modal-close" data-close>&#10005;</button></div>' +
              '<div class="modal-body">' + bodyHtml + '</div>' +
              '<div class="modal-actions"></div>' +
            '</div>';
        const bar = overlay.querySelector('.modal-actions');
        const close = () => { overlay.remove(); this._busy = false; };
        for (const a of (actions || [])) {
            const b = document.createElement('button');
            b.className = 'btn' + (a.primary ? ' btn-primary' : '');
            b.textContent = a.text;
            if (a.onClick) b.addEventListener('click', () => a.onClick(b, close));
            bar.appendChild(b);
        }
        overlay.querySelector('[data-close]').addEventListener('click', close);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
        document.body.appendChild(overlay);
        return { el: overlay, close };
    },

    // ---------------- 容量告警 ----------------
    // 统一错误入口: 由 API.json() 在收到 {code:'D1_CAPACITY'} 时调用。
    // 返回 true 表示这是容量问题, 调用方照常抛错即可。
    handleError(e) {
        const d = e && e.data;
        if (!d || d.code !== 'D1_CAPACITY') return false;
        this.showCapacity(d);
        return true;
    },

    showCapacity(d) {
        if (this._busy) return;
        this._busy = true;
        const pool = d.pool || {};
        const cur = d.current || {};
        const need = this.fmt(d.need_bytes);
        let body = '';
        let actions = [];

        if (pool.standby > 0) {
            // ---- A 态: 还有已就绪的存储库, 一键即用 ----
            const next = pool.next_standby || '下一个存储库';
            body =
              '<p class="st-lead">「' + this.esc(cur.label || '主库') + '」已使用 <b>' + this.fmt(cur.used_bytes) +
              '</b>（上限 ' + this.fmt(cur.limit_bytes) + '），本次上传需要 <b>' + need + '</b>。</p>' +
              '<p class="st-muted">该库还需保留约 ' + this.fmt(cur.reserve_bytes) +
              ' 用于存放目录结构、图床信息、分享链接等元数据，因此无法继续写入。</p>' +
              '<div class="st-box"><div class="st-box-title">推荐：启用下一个存储库</div>' +
              '<p>你还有 <b>' + pool.standby + '</b> 个已就绪的存储库。点击下方按钮，系统会自动初始化「' +
              this.esc(next) + '」并把它设为新文件的目标库。</p>' +
              '<p class="st-muted">已上传的分片不会丢失，启用后直接重试上传即可。</p></div>';
            actions = [
                { text: '存储详情', onClick: (b, close) => { close(); this.openStoragePanel(); } },
                {
                    text: '一键启用 ' + next,
                    primary: true,
                    onClick: async (b, close) => {
                        b.disabled = true;
                        b.textContent = '正在启用…';
                        try {
                            await API.enableStorage();
                            close();
                            Dialog.alert('已启用「' + next + '」，现在重新上传即可，之前传好的分片会被复用。', { title: '扩容完成' });
                        } catch (e2) {
                            b.disabled = false;
                            b.textContent = '一键启用 ' + next;
                            Dialog.alert((e2 && e2.message) || '启用失败', { title: '启用失败' });
                        }
                    },
                },
            ];
        } else if (pool.slots_left > 0) {
            // ---- B 态: 预置库已用尽, 但账号还有名额 → 引导手工加库 ----
            const idx = (pool.used_slots || 0) + 1;
            const dbName = 'file-manager-' + idx;
            const binding = 'DB' + idx;
            const cmd1 = 'npx wrangler d1 create ' + dbName;
            const jsonLine = '{ "binding": "' + binding + '", "database_name": "' + dbName + '", "database_id": "<第 1 步输出的 id>" }';
            const cmd3 = 'npx wrangler deploy';
            body =
              '<p class="st-lead">已就绪的存储库全部写满，本次上传需要 <b>' + need + '</b>。</p>' +
              '<p class="st-muted">本项目还能再添加 <b>' + pool.slots_left + '</b> 个存储库' +
              '（账号最多 ' + (pool.slot_quota || 0) + ' 个，其他项目占用其余名额，本项目已用 ' +
              (pool.used_slots || 0) + ' 个）。</p>' +
              '<div class="st-box"><div class="st-box-title">添加一个存储库（需要执行一次部署，约 1 分钟）</div>' +
              '<ol class="st-steps">' +
              '<li><div class="st-step-h">创建一个空数据库（空库不占存储额度，只占账号的库数量名额）</div>' +
                '<div class="st-cmd"><code>' + this.esc(cmd1) + '</code><button class="st-copy" data-copy="' + this.esc(cmd1) + '">复制</button></div></li>' +
              '<li><div class="st-step-h">把输出的 database_id 追加到 <code>wrangler.jsonc</code> 的 <code>d1_databases</code> 里</div>' +
                '<div class="st-cmd"><code>' + this.esc(jsonLine) + '</code><button class="st-copy" data-copy="' + this.esc(jsonLine) + '">复制</button></div></li>' +
              '<li><div class="st-step-h">重新部署</div>' +
                '<div class="st-cmd"><code>' + this.esc(cmd3) + '</code><button class="st-copy" data-copy="' + this.esc(cmd3) + '">复制</button></div></li>' +
              '<li><div class="st-step-h">回到「参数设置 → 存储库」，点「注册新库」，填 binding 名 <code>' + this.esc(binding) + '</code></div>' +
                '<div class="st-muted">建表由系统自动完成，不需要手工执行 SQL。</div></li>' +
              '</ol></div>';
            actions = [
                { text: '存储详情', onClick: (b, close) => { close(); this.openStoragePanel(); } },
                { text: '我知道了', primary: true, onClick: (b, close) => close() },
            ];
        } else {
            // ---- C 态: 名额也用尽 ----
            body =
              '<p class="st-lead">本项目可用的 ' + (pool.slot_quota || 0) + ' 个存储库全部写满，本次上传需要 <b>' + need + '</b>。</p>' +
              '<p class="st-muted">D1 免费版账号最多 10 个数据库，其他项目已占用其余名额，本项目已用满自己的 ' +
              (pool.slot_quota || 0) + ' 个，<b>无法再通过增加数据库扩容</b>。</p>' +
              '<div class="st-box"><div class="st-box-title">可以这样做</div>' +
              '<ul class="st-list">' +
              '<li><b>删除不需要的文件</b> —— 在「文件管理」中删除后立即释放容量。</li>' +
              '<li><b>升级到 Workers Paid</b> —— 单库上限 500MB → 10GB，同时解除库数量限制。</li>' +
              '</ul></div>';
            actions = [{ text: '我知道了', primary: true, onClick: (b, close) => close() }];
        }

        const m = this._modal('存储空间不足', body, actions);
        m.el.querySelectorAll('[data-copy]').forEach((btn) => {
            btn.addEventListener('click', () => this.copy(btn.getAttribute('data-copy'), btn));
        });
    },

    // ---------------- 存储库面板 ----------------
    openStoragePanel() {
        if (typeof SettingsUI !== 'undefined' && SettingsUI.show) SettingsUI.show();
        setTimeout(() => {
            this.loadPanel();
            const el = document.getElementById('storagePanel');
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
    },

    async loadPanel() {
        const el = document.getElementById('storagePanel');
        if (!el || this._panelLoading) return;
        this._panelLoading = true;
        // 面板已有内容 → 本次属于刷新, 期间给出可见反馈 (首次加载由 app.html 的"加载中…"占位)
        const refreshing = !!el.querySelector('.st-table');
        if (refreshing) {
            const tip = document.createElement('div');
            tip.className = 'storage-loading';
            tip.textContent = '刷新中…';
            el.insertBefore(tip, el.firstChild);
        }
        try {
            const d = await API.getStorage();
            el.innerHTML = this._panelHtml(d);
            this._bindPanel(el);
        } catch (e) {
            el.innerHTML = '<div class="st-err">' + this.esc((e && e.message) || '加载失败') + '</div>';
        } finally {
            this._panelLoading = false;
        }
    },

    _panelHtml(d) {
        const p = d.pool || {};
        const STATE = { active: '使用中', standby: '待启用', full: '已满', retired: '已停用' };
        const rows = (d.items || []).map((it) => (
            '<tr>' +
              '<td>' + this.esc(it.label) + '</td>' +
              '<td><code>' + this.esc(it.binding) + '</code>' + (it.live ? '' : ' <span class="st-warn">未绑定</span>') + '</td>' +
              '<td>' + this.esc(STATE[it.state] || it.state) + '</td>' +
              '<td>' + this.fmt(it.used_bytes) + ' / ' + this.fmt(it.limit_bytes) + '</td>' +
              '<td>' + this.fmt(it.free_bytes) + '</td>' +
            '</tr>'
        )).join('');
        return '<div class="st-summary">已用 <b>' + (p.used_slots || 0) + ' / ' + (p.slot_quota || 0) + '</b> 个库名额' +
            (d.journal_pending ? ' · 待处理任务 <b>' + d.journal_pending + '</b> 条' : '') +
            (d.calibrate_enabled ? '' : ' · 未配置 CF_API_TOKEN，容量为累加估算值') +
            '</div>' +
            '<table class="st-table"><thead><tr><th>存储库</th><th>Binding</th><th>状态</th><th>已用 / 上限</th><th>可写</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' +
            '<div class="st-actions">' +
            (p.standby > 0 ? '<button class="btn btn-primary" data-act="enable">启用 ' + this.esc(p.next_standby || '下一个存储库') + '</button>' : '') +
            '<button class="btn" data-act="register">注册新库</button>' +
            '<button class="btn" data-act="calibrate">校准容量</button>' +
            '</div>';
    },

    _bindPanel(el) {
        const enable = el.querySelector('[data-act="enable"]');
        if (enable) enable.addEventListener('click', async () => {
            enable.disabled = true;
            try { await API.enableStorage(); await this.loadPanel(); }
            catch (e) {
                enable.disabled = false;
                Dialog.alert((e && e.message) || '启用失败', { title: '启用失败' });
            }
        });
        const reg = el.querySelector('[data-act="register"]');
        if (reg) reg.addEventListener('click', async () => {
            const binding = await Dialog.prompt(
                '填写已经在 wrangler.jsonc 的 d1_databases 中声明、且已重新部署生效的 binding 名。若还没声明，请先添加并部署。',
                '', { title: '注册新存储库', placeholder: 'DB5' });
            if (!binding) return;
            try { await API.registerStorage(binding.trim()); await this.loadPanel(); }
            catch (e) { Dialog.alert((e && e.message) || '注册失败', { title: '注册失败' }); }
        });
        const cal = el.querySelector('[data-act="calibrate"]');
        if (cal) cal.addEventListener('click', async () => {
            cal.disabled = true;
            cal.textContent = '校准中…';
            try { await API.calibrateStorage(); await this.loadPanel(); }
            catch (e) { Dialog.alert((e && e.message) || '校准失败', { title: '容量校准' }); }
            finally { cal.disabled = false; }
        });
    },

    // ---------------- 主库高危横幅 ----------------
    // 主库满 = 整个应用不可用 (连 fs_nodes / storage_dbs 都写不了)。
    // 这个告警的级别高于普通容量不足, 所以常驻显示而不是一次性弹窗。
    //
    // 判据: 主库**实际剩余** = limit_bytes - used_bytes。
    //   不能拿后端返回的 free_bytes 当判据 —— free_bytes = limit - used - reserve,
    //   它回答的是「这个库还能再塞多少文件字节」, 已经扣掉了给元数据预留的 reserve_bytes。
    //   拿它来判断"主库快满了"会整整提前一个 reserve 报错: 主库 reserve=100MB,
    //   于是 380MB 就误报 (500-380-100=20MB < 阈值)。预留本来就是留给元数据的,
    //   它被占用是正常现象, 不是危险信号; 真正危险的是整个库只剩不到 20MB。
    async boot() {
        try {
            const d = await API.getStorage();
            const primary = (d.items || []).find((i) => i.role === 'primary');
            if (!primary) return;
            const headroom = Math.max(0, (primary.limit_bytes || 0) - (primary.used_bytes || 0));
            if (headroom < PRIMARY_ALERT_BYTES) {
                this._banner('主库实际剩余空间仅 ' + this.fmt(headroom) +
                    '（预留的 ' + this.fmt(primary.reserve_bytes) + ' 元数据空间已基本被占用）。' +
                    '主库负责保存目录结构等元数据，写满后将无法新建目录或上传文件，请尽快清理。');
            }
        } catch (e) { /* 忽略: 不影响页面 */ }
    },

    _banner(text) {
        if (this._bannerShown) return;
        this._bannerShown = true;
        const bar = document.createElement('div');
        bar.className = 'st-banner';
        bar.innerHTML = '<span class="st-banner-text">' + this.esc(text) + '</span>' +
            '<button class="st-banner-btn" type="button">存储详情</button>' +
            '<button class="st-banner-close" type="button" aria-label="关闭">&#10005;</button>';
        bar.querySelector('.st-banner-btn').addEventListener('click', () => this.openStoragePanel());
        bar.querySelector('.st-banner-close').addEventListener('click', () => bar.remove());
        document.body.appendChild(bar);
    },
};

// 必须显式挂 window: 顶层 const 不进 window (与 fileicons.js / hljs-async.js 同理)。
// 否则 settings.js / api.js 里的 window.StorageUI 判断永远为假 →
// 存储面板停在"加载中…", 507 三态告警也不会弹出。
window.StorageUI = StorageUI;

document.addEventListener('DOMContentLoaded', () => {
    if (window.API && API.getStorage) setTimeout(() => StorageUI.boot(), 800);
});
