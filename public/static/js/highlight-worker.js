// highlight-worker.js — highlight.js 在 Worker 线程执行扫描, 主线程零阻塞
// 输入: {id, code, lang}; 输出: {id, html} — html=null 表示扫描失败, 主线程保留纯文本
// hljs 输出已转义, 仅含 span/文本节点, 主线程可安全 innerHTML
importScripts('/static/vendor/hljs/highlight@11.9.0.min.js');

self.onmessage = function(e) {
    var id = e.data.id, code = e.data.code, lang = e.data.lang;
    var html = null;
    try {
        if (lang && hljs.getLanguage(lang)) {
            html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } else {
            html = hljs.highlightAuto(code).value;
        }
    } catch (err) {
        html = null;
    }
    self.postMessage({ id: id, html: html });
};
