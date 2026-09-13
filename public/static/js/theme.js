// 全站主题切换: 绑定 #themeToggle 按钮, 同步日/月图标, 并让 hljs 代码高亮样式跟随主题
// 主题初始化(防闪烁)在每页 <head> 内联脚本完成, 此处只负责切换
(function () {
    function isLight() { return document.documentElement.dataset.theme === 'light'; }

    function applyHljs(light) {
        var dark = document.getElementById('hljsDark');
        var light_ = document.getElementById('hljsLight');
        if (dark) dark.disabled = light;
        if (light_) light_.disabled = !light;
    }

    // 图标显隐走内联样式, 兼容圆形悬浮按钮与工具栏内嵌按钮两种形态
    function applyIcon(light) {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        var sun = btn.querySelector('.sun');
        var moon = btn.querySelector('.moon');
        if (sun) sun.style.display = light ? 'none' : '';
        if (moon) moon.style.display = light ? '' : 'none';
    }

    function apply(light) { applyHljs(light); applyIcon(light); }

    apply(isLight());

    var btn = document.getElementById('themeToggle');
    if (btn) {
        btn.addEventListener('click', function () {
            var next = isLight() ? 'dark' : 'light';
            document.documentElement.dataset.theme = next;
            try { localStorage.setItem('theme', next); } catch (e) {}
            apply(next === 'light');
        });
    }
})();
