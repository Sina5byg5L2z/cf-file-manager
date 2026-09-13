// 统一风格弹窗组件，替代原生 alert/confirm/prompt
// Dialog.alert(msg, {title, okText})              -> Promise<void>
// Dialog.confirm(msg, {title, okText, danger})    -> Promise<boolean>
// Dialog.prompt(msg, value, {title, placeholder}) -> Promise<string|null>
//
// 设计：意图图标章（danger 红 / accent 蓝 / info 灰）+ 焦点圈定 + 焦点归还 + reduced-motion
(function () {
    'use strict';

    const Z = 1300; // 高于 .modal(600) 与 .context-menu(1000)
    const stack = []; // 多弹窗叠加时仅最上层响应键盘

    const ICONS = {
        danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 19.5h19L12 3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>',
        accent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8.01"/></svg>'
    };

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function build(opts) {
        const overlay = el('div', 'dlg-overlay');
        const box = el('div', 'dlg');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        const chip = el('div', 'dlg-chip ' + opts.kind);
        chip.innerHTML = ICONS[opts.kind]; // 静态字符串，无用户输入
        box.appendChild(chip);

        let titleEl = null;
        if (opts.title) {
            titleEl = el('div', 'dlg-title', opts.title);
            titleEl.id = 'dlg-title-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
            box.appendChild(titleEl);
            box.setAttribute('aria-labelledby', titleEl.id);
        }

        const body = el('div', 'dlg-body', opts.message);
        box.appendChild(body);

        let inputEl = null;
        if (opts.input) {
            inputEl = el('input', 'dlg-input');
            inputEl.type = 'text';
            inputEl.value = opts.input.value || '';
            inputEl.maxLength = opts.input.maxLength || 255;
            if (opts.input.placeholder) inputEl.placeholder = opts.input.placeholder;
            if (opts.input.label) inputEl.setAttribute('aria-label', opts.input.label);
            box.appendChild(inputEl);
        }

        const actions = el('div', 'dlg-actions');
        let cancelBtn = null;
        if (opts.cancelText !== null) {
            cancelBtn = el('button', 'btn', opts.cancelText);
            cancelBtn.type = 'button';
            actions.appendChild(cancelBtn);
        }
        const okBtn = el('button', 'btn btn-primary' + (opts.danger ? ' dlg-danger' : ''), opts.okText);
        okBtn.type = 'button';
        actions.appendChild(okBtn);

        box.appendChild(actions);
        overlay.appendChild(box);
        return { overlay, inputEl, okBtn, cancelBtn };
    }

    function open(opts) {
        return new Promise(resolve => {
            const ui = build(opts);
            let done = false;
            const prevFocus = document.activeElement;
            const finish = value => {
                if (done) return;
                done = true;
                document.removeEventListener('keydown', onKey, true);
                stack.splice(stack.indexOf(self), 1);
                ui.overlay.remove();
                if (prevFocus && prevFocus.isConnected) prevFocus.focus();
                resolve(value);
            };
            const accept = () => finish(opts.input ? ui.inputEl.value : true);
            const cancel = () => finish(opts.input ? null : (ui.cancelBtn ? false : undefined));

            const self = { onKey };
            function onKey(e) {
                if (stack[stack.length - 1] !== self) return; // 非最上层忽略
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancel();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    accept();
                } else if (e.key === 'Tab') {
                    // 焦点圈定：仅在弹窗内控件间循环
                    const items = [ui.inputEl, ui.cancelBtn, ui.okBtn].filter(Boolean);
                    const i = items.indexOf(document.activeElement);
                    e.preventDefault();
                    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 || i < 0 ? 0 : i + 1);
                    items[next].focus();
                }
            }

            ui.okBtn.addEventListener('click', accept);
            if (ui.cancelBtn) ui.cancelBtn.addEventListener('click', cancel);
            ui.overlay.addEventListener('mousedown', e => {
                if (e.target === ui.overlay) cancel();
            });
            document.addEventListener('keydown', onKey, true);

            document.body.appendChild(ui.overlay);
            stack.push(self);
            if (ui.inputEl) {
                ui.inputEl.focus();
                if (ui.inputEl.value) ui.inputEl.select();
            } else {
                ui.okBtn.focus();
            }
        });
    }

    window.Dialog = {
        alert(message, o = {}) {
            return open({ title: o.title || '提示', message, kind: 'info', okText: o.okText || '确定', cancelText: null });
        },
        confirm(message, o = {}) {
            return open({ title: o.title || '确认', message, kind: o.danger ? 'danger' : 'info', danger: !!o.danger, okText: o.okText || '确定', cancelText: o.cancelText || '取消' });
        },
        prompt(message, value = '', o = {}) {
            return open({ title: o.title || '输入', message, kind: 'accent', okText: o.okText || '确定', cancelText: '取消', input: { value, placeholder: o.placeholder } });
        }
    };
})();
