// hljs-async.js — highlight.js Worker 化封装: 正则扫描移到子线程, 主线程只做结果写入
// 高亮是渐进增强: 纯文本先上屏, 结果回来后原位替换, 阅读不受影响
// 移动 CPU 慢 5-10 倍: 同步 fallback 只对极小文本启用, 否则宁可纯文本也不卡主线程
const HLA_MOBILE = /Mobi|Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

const HljsAsync = {
    worker: null,
    seq: 0,
    pending: new Map(), // id -> {el}

    ensure() {
        if (!this.worker) {
            this.worker = new Worker('/static/js/highlight-worker.js');
            this.worker.onmessage = (e) => {
                const job = this.pending.get(e.data.id);
                if (!job) return; // 超时/清理后迟到的结果
                this.pending.delete(e.data.id);
                // 元素可能已被切换预览/重新渲染丢弃
                if (job.el.isConnected && e.data.html != null) {
                    job.el.innerHTML = e.data.html;
                    job.el.classList.add('hljs');
                }
            };
        }
        return this.worker;
    },

    // 对 <code> 元素异步高亮; Worker 不可用时退回主线程同步
    highlight(el, lang, code) {
        // 200KB 上限 guard 的不是扫描 CPU (那已在 Worker), 而是结果 DOM 规模:
        // 高亮输出是 span 包裹的 HTML, 膨胀 ~8 倍, 大文本会 innerHTML 出几十万~几百万节点直接崩页面
        if (code.length > 200 * 1024) return; // 保留纯文本显示
        if (typeof Worker === 'undefined') {
            if (typeof hljs !== 'undefined' && code.length <= (HLA_MOBILE ? 32 * 1024 : 200 * 1024)) {
                try { el.textContent = code; hljs.highlightElement(el); } catch (e) {}
            }
            return;
        }
        try { this.ensure(); } catch (e) { return; } // Worker 创建失败: 保留纯文本
        const id = ++this.seq;
        if (el.textContent !== code) el.textContent = code; // 纯文本先上屏
        this.pending.set(id, { el });
        this.worker.postMessage({ id: id, code: code, lang: lang || null });
    }
};

// 必须显式挂 window: 顶层 const 不进 window, share.html 用 window.HljsAsync 判断会永远 undefined
window.HljsAsync = HljsAsync;
