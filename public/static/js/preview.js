// File preview module
// 移动端内存/CPU 更紧, 预览阈值全面收紧
const IS_MOBILE = /Mobi|Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

const Preview = {
    modal: null,
    body: null,
    title: null,
    info: null,
    currentPath: null,
    mediaPlayer: null,

    // 可预览的文本格式（纯文本显示）
    textExtensions: new Set([
        'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml',
        'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'vue',
        'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift',
        'kt', 'php', 'sql', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'r', 'lua',
        'pl', 'pm', 'dart', 'scala', 'groovy', 'less', 'scss', 'sass',
        'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'env',
        'env.local', 'env.development', 'env.production'
    ]),

    // 需要特殊渲染的格式
    markdownExtensions: new Set(['md', 'mdx', 'markdown']),
    htmlExtensions: new Set(['html', 'htm']),
    svgExtensions: new Set(['svg']),
    codeExtensions: new Set([
        'json', 'xml', 'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'rb', 'java',
        'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'php', 'sql',
        'sh', 'bash', 'css', 'less', 'scss', 'sass'
    ]),

    // highlight.js 语言映射
    hljsLangMap: {
        'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript',
        'tsx': 'typescript', 'py': 'python', 'rb': 'ruby',
        'rs': 'rust', 'kt': 'kotlin', 'sh': 'bash',
        'yml': 'yaml', 'md': 'markdown', 'htm': 'html',
        'hpp': 'cpp', 'h': 'c', 'scss': 'scss', 'sass': 'sass',
        'less': 'less', 'cs': 'csharp', 'vue': 'html',
        'dockerfile': 'dockerfile', 'makefile': 'makefile',
        'bat': 'bat', 'ps1': 'powershell', 'r': 'r',
        'pl': 'perl', 'pm': 'perl', 'lua': 'lua',
        'dart': 'dart', 'scala': 'scala', 'groovy': 'groovy',
        'cfg': 'ini', 'conf': 'ini', 'env': 'ini',
        'env.local': 'ini', 'env.development': 'ini', 'env.production': 'ini',
        'gitignore': 'ini', 'editorconfig': 'ini'
    },

    // 大文本预览上限: 超限不做预览, 直接引导下载 (流畅优先; 全量拉取+渲染会卡死主线程)
    // 数值在「参数设置」中按移动端/电脑端分别配置 (AppSettings, 服务端下发), 这里只兜底
    // md 阈值更严: marked+KaTeX 渲染后 DOM 膨胀数倍; HTML 走 iframe 子框架异步解析可放宽;
    // 查看源码视图是单文本节点 textContent, 同样安全 (源码高亮由 HljsAsync 的 200KB 结果 DOM guard 拦截)
    get TEXT_PREVIEW_LIMIT() { return AppSettings.previewLimit('preview_text'); },
    get MARKDOWN_PREVIEW_LIMIT() { return AppSettings.previewLimit('preview_markdown'); },
    get HTML_PREVIEW_LIMIT() { return AppSettings.previewLimit('preview_html'); },
    // 显示层截断: 预览内文本只渲染前一小段 (保证渲染/滚动绝对流畅), 完整内容下载查看
    TEXT_DISPLAY_LIMIT: IS_MOBILE ? 64 * 1024 : 128 * 1024,

    init() {
        this.modal = document.getElementById('previewModal');
        this.body = document.getElementById('previewBody');
        this.title = document.getElementById('previewTitle');
        this.info = document.getElementById('previewInfo');
        document.getElementById('btnClosePreview').addEventListener('click', () => this.hide());
        // 不做"点击遮罩/空白处关闭": 播放音视频时误点弹窗外会直接打断播放,
        // 关闭只走右上角 ✕ 按钮和 ESC 键

        // 新标签页打开
        document.getElementById('btnPreviewNewTab').addEventListener('click', () => {
            if (this.currentPath) window.open(API.previewUrl(this.currentPath), '_blank');
        });
        // 下载
        document.getElementById('btnPreviewDownload').addEventListener('click', () => {
            if (this.currentPath) API.downloadFile(this.currentPath);
        });

        // ESC 关闭 (浏览器全屏中先退出全屏, 不直接关弹窗)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.fullscreenElement) return;
            if (e.key === 'Escape' && this.modal.style.display !== 'none') {
                this.hide();
            }
        });
    },

    // Markdown 渲染：marked 解析 + DOMPurify 消毒 (vendor: /static/vendor/)
    renderMarkdown(text) {
        // vendor 库缺失时回退纯文本显示
        if (typeof marked === 'undefined') {
            return `<pre class="preview-text">${FM.esc(text)}</pre>`;
        }
        // 全局配置只需一次
        if (!this._markedReady) {
            marked.use({
                breaks: true, // 保持旧行为: 段内单换行也渲染为 <br>
                renderer: {
                    code({ text }) {
                        return `<pre class="md-code-block"><code>${FM.esc(text)}</code></pre>`;
                    },
                    codespan({ text }) {
                        return `<code class="md-inline-code">${FM.esc(text)}</code>`;
                    },
                    image({ href, title, text }) {
                        const t = title ? ` title="${FM.esc(title)}"` : '';
                        return `<img src="${FM.esc(href)}" alt="${FM.esc(text)}" class="md-image"${t}>`;
                    }
                }
            });
            if (typeof DOMPurify !== 'undefined') {
                DOMPurify.addHook('afterSanitizeAttributes', (node) => {
                    if (node.tagName === 'A') {
                        node.setAttribute('target', '_blank');
                        node.setAttribute('rel', 'noopener noreferrer');
                    }
                });
            }
            this._markedReady = true;
        }

        // 先提取数学公式，避免被 markdown 处理
        const mathBlocks = [];
        let md = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
            const index = mathBlocks.length;
            mathBlocks.push({ type: 'block', formula: formula.trim() });
            return `MATH_BLOCK_${index}_END`;
        });

        // 行内数学公式 $...$
        md = md.replace(/\$([^\$]+?)\$/g, (match, formula) => {
            if (formula.trim() === '') return match;
            const index = mathBlocks.length;
            mathBlocks.push({ type: 'inline', formula: formula.trim() });
            return `MATH_INLINE_${index}_END`;
        });

        let html = marked.parse(md);
        if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);

        // 还原数学公式并用 KaTeX 渲染
        html = html.replace(/MATH_BLOCK_(\d+)_END/g, (match, index) => {
            const math = mathBlocks[parseInt(index)];
            if (typeof katex !== 'undefined') {
                try {
                    return katex.renderToString(math.formula, { displayMode: true, throwOnError: false });
                } catch (e) {
                    return `<span class="math-error" title="${e.message}">${FM.esc(math.formula)}</span>`;
                }
            }
            return `<span class="math-block">${FM.esc(math.formula)}</span>`;
        });

        html = html.replace(/MATH_INLINE_(\d+)_END/g, (match, index) => {
            const math = mathBlocks[parseInt(index)];
            if (typeof katex !== 'undefined') {
                try {
                    return katex.renderToString(math.formula, { displayMode: false, throwOnError: false });
                } catch (e) {
                    return `<span class="math-error" title="${e.message}">${FM.esc(math.formula)}</span>`;
                }
            }
            return `<span class="math-inline">${FM.esc(math.formula)}</span>`;
        });

        return html;
    },

    // 获取文件扩展名分类
    getFileCategory(ext) {
        ext = ext.toLowerCase();
        if (this.markdownExtensions.has(ext)) return 'markdown';
        if (this.htmlExtensions.has(ext)) return 'html';
        if (this.svgExtensions.has(ext)) return 'svg';
        if (this.codeExtensions.has(ext)) return 'code';
        if (this.textExtensions.has(ext)) return 'text';
        return 'unknown';
    },

    // 截断提示条
    truncatedNote() {
        return `<div style="padding:10px 12px;font-size:12px;color:var(--text-tertiary);border-top:1px solid var(--border-color);text-align:center;flex-shrink:0">内容过长，已仅显示前 ${this.formatSize(this.TEXT_DISPLAY_LIMIT)} · 完整内容请下载查看</div>`;
    },

    // 生成纯文本预览的 HTML (显示层截断到 TEXT_DISPLAY_LIMIT)
    renderTextPreview(content, ext) {
        const shown = content.length > this.TEXT_DISPLAY_LIMIT ? content.slice(0, this.TEXT_DISPLAY_LIMIT) : content;
        const note = content.length > this.TEXT_DISPLAY_LIMIT ? this.truncatedNote() : '';
        return `<div class="preview-content" style="display:flex;flex-direction:column;min-height:0"><pre class="preview-text">${FM.esc(shown)}</pre>${note}</div>`;
    },

    // 生成代码预览的 HTML（带语法高亮, 显示层截断到 TEXT_DISPLAY_LIMIT）
    renderCodePreview(content, ext) {
        const shown = content.length > this.TEXT_DISPLAY_LIMIT ? content.slice(0, this.TEXT_DISPLAY_LIMIT) : content;
        const note = content.length > this.TEXT_DISPLAY_LIMIT ? this.truncatedNote() : '';
        const lang = this.hljsLangMap[ext] || ext;
        return `<div class="preview-content" style="display:flex;flex-direction:column;min-height:0"><pre class="preview-code"><code class="language-${lang}">${FM.esc(shown)}</code></pre>${note}</div>`;
    },

    // 生成 Markdown 预览的 HTML
    renderMarkdownPreview(content) {
        const html = this.renderMarkdown(content);
        return `<div class="preview-content preview-markdown">${html}</div>`;
    },

    // 生成 HTML 文件预览（沙盒 iframe 渲染）
    // 大文件不能把内容拼进 innerHTML 的 srcdoc 属性（等于让父页 HTML 解析器再吃一遍全文，1MB+ 直接卡死），
    // 只插入空 iframe，随后用 srcdoc 属性赋值交给子框架异步解析；源码视图也改为懒填充。
    // sandbox 只给 allow-scripts（不给 allow-same-origin）：文件内脚本能运行，
    // 但处于 opaque origin，访问不到父页的 localStorage/token/cookie。
    renderHtmlPreview(content) {
        this._htmlContent = content;
        // 源码视图属于文本阅读: 超过文本上限 (1MB) 直接不提供入口, 只留 iframe 渲染
        const hasSource = content.length <= this.TEXT_PREVIEW_LIMIT;
        return `<div class="preview-content preview-html">
            ${hasSource ? `<div class="preview-html-toolbar">
                <button class="btn" onclick="Preview.toggleHtmlSource()" id="btnToggleSource">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                    </svg>
                    查看源码
                </button>
            </div>` : ''}
            <iframe sandbox="allow-scripts" class="preview-html-frame"></iframe>
            ${hasSource ? `<pre class="preview-code preview-html-source" style="display:none"><code class="language-html"></code></pre>` : ''}
        </div>`;
    },

    // 切换 HTML 预览的源码/渲染视图
    toggleHtmlSource() {
        const frame = this.body.querySelector('.preview-html-frame');
        const source = this.body.querySelector('.preview-html-source');
        const btn = document.getElementById('btnToggleSource');
        if (!frame || !source) return;
        if (frame.style.display === 'none') {
            frame.style.display = '';
            source.style.display = 'none';
            // 重载 iframe 内容 (切到源码视图时被清空以停掉子框架脚本)
            if (!frame.getAttribute('srcdoc') && this._htmlContent != null) {
                frame.srcdoc = '<!DOCTYPE html>' + this._htmlContent;
            }
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg> 查看源码`;
        } else {
            frame.style.display = 'none';
            source.style.display = '';
            // 卸载 iframe 内容: iframe 脚本即使 display:none 也在主线程跑, 手机上会冻结页面;
            // 清空 srcdoc 彻底停掉子框架脚本, 切回渲染视图时重载
            try { frame.srcdoc = ''; } catch (e) {}
            // 源码懒填充（大文件不在首屏渲染/高亮）+ 显示层截断
            const code = source.querySelector('code');
            if (code && !code.textContent && this._htmlContent != null) {
                code.textContent = this._htmlContent.length > this.TEXT_DISPLAY_LIMIT
                    ? this._htmlContent.slice(0, this.TEXT_DISPLAY_LIMIT) + '\n\n… 已截断，完整内容请下载查看'
                    : this._htmlContent;
            }
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg> 渲染预览`;
            this.applyHighlight();
        }
    },

    // 对已渲染的代码块执行高亮 (hljs 扫描在 Worker 线程, 主线程只收结果写 DOM, 不阻塞)
    applyHighlight() {
        this.body.querySelectorAll('pre code').forEach(block => {
            // 跳过已高亮的、md 行内代码、空块
            if (block.classList.contains('hljs') || block.classList.contains('md-inline-code') || !block.textContent) return;
            const m = block.className.match(/language-([\w+-]+)/);
            const code = block.textContent;
            if (typeof HljsAsync !== 'undefined') {
                HljsAsync.highlight(block, m ? m[1] : null, code);
            } else if (typeof hljs !== 'undefined' && code.length <= (IS_MOBILE ? 32 * 1024 : 200 * 1024)) {
                // 兜底: Worker 封装不可用时直接主线程同步高亮 (移动 CPU 慢, 仅小文本, 否则卡秒级)
                try { hljs.highlightElement(block); } catch (e) {}
            }
        });
    },

    // 文件过大: 不做预览, 引导下载 (大文本全量渲染会卡死页面, 下载比预览有价值)
    showTooLarge() {
        this.body.innerHTML = `
            <div class="preview-not-supported">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.5">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                    <polyline points="13 2 13 9 20 9"/>
                </svg>
                <p class="preview-not-supported-title">文件过大，已停用在线预览</p>
                <p class="preview-not-supported-hint">${FM.esc(this.formatSize(this.currentSize))} · 预览大文本会导致页面卡顿，请下载后查看</p>
                <button class="btn btn-primary" onclick="Preview.download()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    下载文件
                </button>
            </div>`;
    },

    // 下载当前预览文件 (带大小, 大文件走分片续传)
    download() {
        if (this.currentPath) API.downloadFile(this.currentPath, this.currentSize);
    },

    // 格式化文件大小
    formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    },

    // 图片扩展名兜底: 服务端 mime 缺失时也能进画廊
    imageExtensions: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']),

    isImageEntry(e) {
        if (!e || e.is_dir) return false;
        if ((e.mime || '').startsWith('image/')) return true;
        return this.imageExtensions.has((e.ext || '').toLowerCase());
    },

    async show(path, entry, siblings) {
        this.currentPath = path;
        this.currentSize = entry.size || 0;
        // Tear down any previous custom video player before rendering the next file
        if (this.mediaPlayer) { try { this.mediaPlayer.destroy(); } catch (e) {} this.mediaPlayer = null; }
        this.title.textContent = entry.name;

        // 显示文件信息
        const sizeStr = entry.is_dir ? '' : this.formatSize(entry.size);
        const mimeStr = entry.mime || '';
        const infoParts = [sizeStr, mimeStr].filter(Boolean);
        this.info.textContent = infoParts.join(' · ');

        // 新标签页按钮：仅对二进制流文件（图片/视频/音频/PDF）有意义
        const newTabBtn = document.getElementById('btnPreviewNewTab');
        const ext = (entry.ext || '').toLowerCase();
        const mime = entry.mime || '';
        const isBinaryPreview = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf';
        newTabBtn.style.display = isBinaryPreview ? '' : 'none';

        this.body.innerHTML = '<div class="preview-loading"><div class="spinner"></div><span>加载中...</span></div>';
        this.modal.style.display = 'flex';

        const url = API.previewUrl(path);

        // Images — 沉浸式看图模式 (ImageViewer): 缩放/平移/旋转/画廊切换, 见 imageviewer.js。
        // SVG 也走 <img> 渲染 (不注入 DOM, 脚本不可执行), 且矢量放大依然清晰。
        if (mime.startsWith('image/')) {
            // 同目录画廊: 调用方 (filemanager) 传入当前目录 entries; 由当前 path 反推目录
            const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            const join = (n) => dir ? dir + '/' + n : n;
            let items = (siblings || []).filter((s) => this.isImageEntry(s)).map((s) => ({
                path: join(s.name),
                src: API.previewUrl(join(s.name)),
                thumb: API.thumbnailUrl(join(s.name)),
                name: s.name,
                size: s.size || 0,
                mime: s.mime || '',
            }));
            let index = items.findIndex((it) => it.name === entry.name);
            if (index < 0) {
                // 当前文件不在列表里 (搜索结果等场景) → 画廊只含当前一张
                items = [{ path, src: url, thumb: API.thumbnailUrl(path), name: entry.name, size: entry.size || 0, mime: entry.mime || '' }];
                index = 0;
            }
            this.body.innerHTML = `<div class="preview-image-host"></div>`;
            const host = this.body.querySelector('.preview-image-host');
            const self = this;
            this.mediaPlayer = ImageViewer.create(host, {
                items,
                index,
                onChange(item) {
                    // 内部切换时同步弹窗元数据 (下载/新标签页跟随当前图)
                    self.currentPath = item.path;
                    self.currentSize = item.size || 0;
                    self.title.textContent = item.name || '';
                    self.info.textContent = [self.formatSize(item.size || 0), item.mime || ''].filter(Boolean).join(' · ');
                },
                onClose: () => this.hide(),
                onDownload: () => this.download(),
                onNewTab: () => { if (this.currentPath) window.open(API.previewUrl(this.currentPath), '_blank'); },
            });
            return;
        }

        // Video — custom player (Bilibili-style skin + gestures + resolution)
        if (mime.startsWith('video/')) {
            this.body.innerHTML = `<div class="preview-content preview-video-host"></div>`;
            const host = this.body.querySelector('.preview-video-host');
            const vpath = path;
            this.mediaPlayer = VideoPlayer.create(host, url, {
                onDownload: () => this.download(),
                quality: {
                    fetchOptions: async () => {
                        try { const d = await API.videoQualities(vpath); return d.options || []; }
                        catch (e) { return []; }
                    },
                    srcFor: (v) => v === 'original' ? API.previewUrl(vpath) : API.videoUrl(vpath, v),
                    prepare: (v) => API.videoPrepare(vpath, v),
                }
            });
            return;
        }

        // Audio — 交给全局播放器: 关掉弹窗也能继续播放, 还能带歌词与队列。
        // 弹窗里不再内嵌播放器(它会随弹窗关闭而停止)。MusicPlayer 缺失时回退到旧卡片。
        if (mime.startsWith('audio/')) {
            if (typeof MusicPlayer !== 'undefined') {
                this.hide();
                MusicPlayer.open(path, entry.name);
                return;
            }
            this.body.innerHTML = `<div class="preview-content preview-audio-host"></div>`;
            const host = this.body.querySelector('.preview-audio-host');
            this.mediaPlayer = AudioPlayer.create(host, url, { title: entry.name, onDownload: () => this.download() });
            return;
        }

        // PDF
        if (mime === 'application/pdf') {
            this.body.innerHTML = `<div class="preview-content"><iframe src="${url}"></iframe></div>`;
            return;
        }

        // 获取文件分类
        const category = this.getFileCategory(ext);

        // 未知格式直接显示无法预览
        if (category === 'unknown') {
            this.body.innerHTML = `
                <div class="preview-not-supported">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.5">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                        <polyline points="13 2 13 9 20 9"/>
                    </svg>
                    <p class="preview-not-supported-title">此文件类型不支持预览</p>
                    <p class="preview-not-supported-hint">文件格式: ${ext || '未知'}</p>
                    <button class="btn btn-primary" onclick="Preview.download()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        下载文件
                    </button>
                </div>`;
            return;
        }

        // 大文本不做预览: 全量拉取+渲染卡死主线程, 直接引导下载 (不发请求)
        const limit = category === 'markdown' ? this.MARKDOWN_PREVIEW_LIMIT
            : category === 'html' ? this.HTML_PREVIEW_LIMIT
            : this.TEXT_PREVIEW_LIMIT;
        if (this.currentSize > limit) { this.showTooLarge(); return; }

        // 文本/代码/Markdown 文件 - 尝试加载
        try {
            const data = await API.preview(path);
            if (data.type === 'text') {
                let previewHtml;
                switch (category) {
                    case 'html':
                        previewHtml = this.renderHtmlPreview(data.content);
                        break;
                    case 'markdown':
                        previewHtml = this.renderMarkdownPreview(data.content);
                        break;
                    case 'code':
                        previewHtml = this.renderCodePreview(data.content, ext);
                        break;
                    default:
                        previewHtml = this.renderTextPreview(data.content, ext);
                }
                this.body.innerHTML = previewHtml;
                // HTML 预览：iframe 插入后再赋 srcdoc，由子框架异步解析，避免大字符串阻塞父页
                const htmlFrame = this.body.querySelector('.preview-html-frame');
                if (htmlFrame) htmlFrame.srcdoc = '<!DOCTYPE html>' + data.content;
                // 应用语法高亮
                this.applyHighlight();
                return;
            }
            // Binary response for a file frontend thinks is text — show as unsupported
            if (data.type === 'binary') {
                this.body.innerHTML = `
                    <div class="preview-not-supported">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.5">
                            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                            <polyline points="13 2 13 9 20 9"/>
                        </svg>
                        <p class="preview-not-supported-title">此文件类型不支持预览</p>
                        <p class="preview-not-supported-hint">文件格式: ${ext || '未知'}</p>
                        <button class="btn btn-primary" onclick="Preview.download()">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            下载文件
                        </button>
                    </div>`;
                return;
            }
        } catch (e) {
            const msg = e.message || '未知错误';
            this.body.innerHTML = `
                <div class="preview-not-supported">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p class="preview-not-supported-title">加载失败</p>
                    <p class="preview-not-supported-hint">${FM.esc(msg)}</p>
                    <button class="btn btn-primary" onclick="Preview.download()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        下载文件
                    </button>
                </div>`;
            return;
        }

        // 兜底
        this.body.innerHTML = `<div class="empty-state"><p>加载失败</p><br><button class="btn btn-primary" onclick="Preview.download()">下载文件</button></div>`;
    },

    hide() {
        this.modal.style.display = 'none';
        this.currentPath = null;
        // Destroy custom video player if present (frees its global listeners)
        if (this.mediaPlayer) { try { this.mediaPlayer.destroy(); } catch (e) {} this.mediaPlayer = null; }
        // Stop video/audio
        this.body.querySelectorAll('video,audio').forEach(el => el.pause());
        this.body.innerHTML = '';
        this._htmlContent = null;
    }
};
