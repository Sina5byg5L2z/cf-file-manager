// App entry - init all modules
(async () => {
    // Check auth
    if (!API.token) {
        window.location.href = '/';
        return;
    }

    try {
        const me = await API.me();
        document.getElementById('usernameDisplay').textContent = me.username;
    } catch (e) {
        window.location.href = '/';
        return;
    }

    // Init modules
    FM.init();
    Upload.init();
    Preview.init();
    Share.init();

    // Navigate to root
    FM.navigate('');

    // Image Host
    document.getElementById('btnImageHost').addEventListener('click', () => ImageHost.show());

    // Logout
    document.getElementById('btnLogout').addEventListener('click', () => {
        API.clearToken();
        window.location.href = '/';
    });

    // Account settings (change username / password)
    const accountModal = document.getElementById('accountModal');
    const accError = document.getElementById('accError');
    const openAccount = () => {
        accError.style.display = 'none';
        document.getElementById('accUsername').value = '';
        document.getElementById('accOldPassword').value = '';
        document.getElementById('accNewPassword').value = '';
        document.getElementById('accNewPassword2').value = '';
        accountModal.style.display = 'flex';
    };
    document.getElementById('btnAccount').addEventListener('click', openAccount);
    document.getElementById('btnCloseAccount').addEventListener('click', () => {
        accountModal.style.display = 'none';
    });
    accountModal.addEventListener('click', (e) => {
        if (e.target === accountModal) accountModal.style.display = 'none';
    });
    document.getElementById('btnAccSave').addEventListener('click', async () => {
        const newName = document.getElementById('accUsername').value.trim();
        const oldPw = document.getElementById('accOldPassword').value;
        const newPw = document.getElementById('accNewPassword').value;
        const newPw2 = document.getElementById('accNewPassword2').value;
        accError.style.display = 'none';
        if (!oldPw) { accError.textContent = '请输入当前密码'; accError.style.display = 'block'; return; }
        if (newPw || newPw2) {
            if (newPw.length < 6) { accError.textContent = '新密码至少 6 位'; accError.style.display = 'block'; return; }
            if (newPw !== newPw2) { accError.textContent = '两次输入的新密码不一致'; accError.style.display = 'block'; return; }
        }
        if (!newName && !newPw) { accError.textContent = '没有需要修改的内容'; accError.style.display = 'block'; return; }
        try {
            let renamed = false;
            if (newName) {
                const r = await API.changeUsername(newName);
                if (r && r.error) { accError.textContent = r.error; accError.style.display = 'block'; return; }
                renamed = true;
            }
            if (newPw) {
                const r = await API.changePassword(oldPw, newPw);
                if (r && r.error) { accError.textContent = r.error; accError.style.display = 'block'; return; }
            }
            accountModal.style.display = 'none';
            await Dialog.alert(renamed ? '修改成功，请重新登录' : '修改成功');
            API.clearToken();
            window.location.href = '/';
        } catch (e) {
            accError.textContent = (e && e.message) || '修改失败';
            accError.style.display = 'block';
        }
    });

    // Batch actions
    document.getElementById('btnBatchDelete').addEventListener('click', () => FM.batchDeleteSelected());
    document.getElementById('btnBatchDownload').addEventListener('click', () => FM.batchDownloadSelected());
    document.getElementById('btnClearSelection').addEventListener('click', () => {
        FM.selected.clear();
        FM.updateSelection();
    });
    document.getElementById('btnBatchMove').addEventListener('click', () => {
        if (FM.selected.size === 1) {
            FM.showMoveDialog([...FM.selected][0]);
        } else {
            // For multi-select, use first selected
            Dialog.alert('批量移动请逐个操作');
        }
    });

    // New folder
    document.getElementById('btnMkdir').addEventListener('click', async () => {
        const name = await Dialog.prompt('文件夹名称:', '', { title: '新建文件夹' });
        if (name) {
            await API.mkdir(FM.currentPath, name);
            FM.navigate(FM.currentPath);
        }
    });

    // Go up
    document.getElementById('btnGoUp').addEventListener('click', () => {
        const parts = FM.currentPath.split('/');
        parts.pop();
        FM.navigate(parts.join('/'));
    });

    // Refresh
    document.getElementById('btnRefresh').addEventListener('click', () => {
        FM.navigate(FM.currentPath);
    });

    // Paste
    document.getElementById('btnPaste').addEventListener('click', () => FM.paste());

    // Search
    let searchTimer;
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = searchInput.value.trim();
        if (!q) {
            searchResults.style.display = 'none';
            return;
        }
        searchTimer = setTimeout(async () => {
            try {
                const data = await API.search(q, FM.currentPath);
                const results = data.results || [];
                if (!results.length) {
                    searchResults.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-tertiary);font-size:13px">无结果</div>';
                } else {
                    searchResults.innerHTML = results.map((r, i) => {
                        const icon = (window.FileIcons && FileIcons.html(r.name, r.is_dir)) || (r.is_dir ? '📁' : '📄');
                        const div = document.createElement('div');
                        div.className = 'search-result-item';
                        div.setAttribute('data-path', r.path);
                        div.setAttribute('data-isdir', String(r.is_dir));
                        div.innerHTML = '<span class="search-result-icon">' + icon + '</span><div><div class="search-result-name"></div><div class="search-result-path"></div></div>';
                        div.querySelector('.search-result-name').textContent = r.name;
                        div.querySelector('.search-result-path').textContent = r.path;
                        return div.outerHTML;
                    }).join('');
                }
                searchResults.style.display = 'block';
            } catch (e) { console.error('Search error:', e); }
        }, 300);
    });

    // Event delegation for search result clicks
    searchResults.addEventListener('click', async (e) => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-isdir') === 'true';
        searchResults.style.display = 'none';
        searchInput.value = '';
        if (isDir) {
            FM.navigate(path);
        } else {
            const slash = path.lastIndexOf('/');
            const dir = slash >= 0 ? path.substring(0, slash) : '';
            const name = slash >= 0 ? path.substring(slash + 1) : path;
            // Wait for navigation to finish rendering before locating the card.
            // navigate() is async (fetch + re-render); a fixed timeout races it and
            // navigate()'s render() would replace the grid, wiping the highlight.
            await FM.navigate(dir);
            const idx = FM.entries.findIndex(en => en.name === name);
            if (idx < 0) return;
            FM.selected.clear();
            FM.selected.add(idx);
            FM.updateSelection();
            const el = FM.grid.querySelector('[data-idx="' + idx + '"]');
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Restart the animation cleanly in case the class still lingers.
                el.classList.remove('highlight-flash');
                void el.offsetWidth;
                el.classList.add('highlight-flash');
                setTimeout(() => el.classList.remove('highlight-flash'), 2000);
            }
        }
    });

    // Close search on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) searchResults.style.display = 'none';
    });
})();
