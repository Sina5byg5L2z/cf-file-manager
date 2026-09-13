// Share link management
const Share = {
    createModal: null,
    sharesModal: null,
    currentPath: null,

    init() {
        this.createModal = document.getElementById('shareModal');
        this.sharesModal = document.getElementById('sharesModal');

        document.getElementById('btnCloseShare').addEventListener('click', () => {
            this.createModal.style.display = 'none';
            document.getElementById('shareResult').style.display = 'none';
        });

        document.getElementById('btnCloseShares').addEventListener('click', () => {
            this.sharesModal.style.display = 'none';
        });

        document.getElementById('btnCreateShare').addEventListener('click', () => this.create());
        document.getElementById('btnCopyShare').addEventListener('click', () => this.copyLink());
        document.getElementById('btnShares').addEventListener('click', () => this.showShares());
    },

    showCreateDialog(path) {
        this.currentPath = path;
        document.getElementById('sharePassword').value = '';
        document.getElementById('shareExpiry').value = '24';
        document.getElementById('shareResult').style.display = 'none';
        this.createModal.style.display = 'flex';
    },

    async create() {
        const password = document.getElementById('sharePassword').value || null;
        const expireHours = parseInt(document.getElementById('shareExpiry').value) || 0;
        try {
            const data = await API.createShare(this.currentPath, password, expireHours || null);
            if (data && data.url) {
                document.getElementById('shareLink').value = data.url;
                document.getElementById('shareResult').style.display = 'block';
            } else if (data && data.error) {
                Dialog.alert('创建分享失败: ' + data.error);
            } else {
                Dialog.alert('创建分享失败: 未知错误');
            }
        } catch (e) {
            console.error('Share creation error:', e);
            Dialog.alert('创建分享失败: ' + (e.message || '网络错误'));
        }
    },

    copyLink() {
        const input = document.getElementById('shareLink');
        input.select();
        document.execCommand('copy');
        const btn = document.getElementById('btnCopyShare');
        btn.textContent = '已复制';
        setTimeout(() => btn.textContent = '复制', 1500);
    },

    async showShares() {
        this.sharesModal.style.display = 'flex';
        const body = document.getElementById('sharesBody');
        body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary)">加载中...</div>';

        try {
            const data = await API.listShares();
            const shares = data.shares || [];
            if (!shares.length) {
                body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary)">暂无分享链接</div>';
                return;
            }
            body.innerHTML = shares.map(s => {
                const fullUrl = window.location.origin + '/s/' + s.id;
                return `
                <div class="share-item">
                    <div class="share-item-path">${(window.FileIcons && FileIcons.html(s.path, s.is_dir)) || '📁'} ${FM.esc(s.path)}</div>
                    <div class="share-item-link">
                        <input type="text" readonly value="${FM.esc(fullUrl)}" class="share-url-input" onclick="this.select()">
                        <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${FM.esc(fullUrl)}');this.textContent='已复制';setTimeout(()=>this.textContent='复制',1500)">复制</button>
                        <a href="${FM.esc(fullUrl)}" target="_blank" class="btn btn-sm">访问</a>
                    </div>
                    <div style="font-size:11px;color:var(--text-tertiary)">
                        ${s.expires_at ? '过期: ' + new Date(s.expires_at).toLocaleString('zh-CN') : '永久有效'}
                        &nbsp;·&nbsp;访问 ${s.access_count || 0} 次
                        ${s.last_accessed_at ? '&nbsp;·&nbsp;最后: ' + new Date(s.last_accessed_at).toLocaleString('zh-CN') : ''}
                    </div>
                    <button class="btn btn-sm btn-danger" onclick="Share.remove('${s.id}')">删除</button>
                </div>`;
            }).join('');
        } catch (e) {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-error)">加载失败</div>';
        }
    },

    async remove(id) {
        if (!(await Dialog.confirm('确定删除此分享?', { danger: true, okText: '删除' }))) return;
        await API.deleteShare(id);
        this.showShares();
    }
};
