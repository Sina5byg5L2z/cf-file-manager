// AI 翻译 —— 本地模型直连核心（纯逻辑，无 DOM 依赖，node 可直接加载测试）。
//
// mode=local 时模型请求由浏览器发起（Worker 够不着用户的 localhost）：
// 服务端 /api/lyrics/translate op=split 下发全部调用参数（base/model/key/prompt/
// batch/temperature/max_tokens/thinking_off 与待翻文本 texts），本模块只负责：
//   1. 逐批调用 OpenAI 兼容接口（POST {base}/chat/completions）；
//   2. JSON 容错提取（小模型爱包 ```json、加废话、带思考段）；
//   3. 行数校验失败对半劈开重试，单行失败保留原文（绝不留空，防双语错位）。
// 算法与 src/translate.js 的服务端同名逻辑保持一致（改一边记得改另一边）。
(function (root) {
    'use strict';

    // 单次请求超时。服务端路径是 45s（受平台 CPU/时长限制），本地无此限制，
    // 但 CPU 推理/冷启动加载模型可能很慢，放宽到 120s 防止永久挂起。
    var DEFAULT_TIMEOUT = 120000;

    function apiUrl(base) {
        return String(base || '').trim().replace(/\/+$/, '') + '/chat/completions';
    }

    // 小模型常把 JSON 包在 ```json 里，或在前后加一句废话，这里尽量捞出来。
    // 与 src/translate.js extractJsonArray 保持一致。
    function extractJsonArray(text) {
        var s = String(text == null ? '' : text).trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        // Qwen3 思考模型可能带 <think> 或思考段，先剥掉
        s = s.replace(/<think[\s\S]*?<\/think>/gi, '').trim();

        var start = s.indexOf('[');
        var end = s.lastIndexOf(']');
        if (start < 0 || end <= start) return null;
        var slice = s.slice(start, end + 1);
        try {
            var v = JSON.parse(slice);
            if (Array.isArray(v)) return v;
        } catch (_) { /* 下面再抢救一次 */ }

        // 常见崩法：模型用单引号、或漏了逗号前后。逐行粗暴兜底。
        var inner = slice.slice(1, -1);
        if (!inner.trim()) return [];
        var parts = inner.split(/\n/).map(function (l) {
            return l.replace(/^\s*[",]?\s*/, '').replace(/\s*[",]?\s*$/, '').trim();
        }).filter(function (l) { return l !== ''; });
        return parts.length ? parts : null;
    }

    // 把一批纯文本行发给模型，期望拿回等长的译文数组。
    async function requestBatch(cfg, lines) {
        var headers = { 'Content-Type': 'application/json' };
        // 密钥可选（Ollama 等通常不需要）；为空时不带 Authorization 头
        if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;

        var payload = {
            model: cfg.model,
            messages: [
                { role: 'system', content: cfg.prompt },
                { role: 'user', content: JSON.stringify(lines) }
            ],
            temperature: cfg.temperature,
            max_tokens: cfg.max_tokens,
            stream: false
        };
        if (cfg.thinking_off) payload.enable_thinking = false;

        var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ac ? setTimeout(function () { ac.abort(); }, cfg.timeout || DEFAULT_TIMEOUT) : null;
        var res;
        try {
            res = await fetch(apiUrl(cfg.base), {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: ac ? ac.signal : undefined
            });
        } catch (e) {
            // 网络层失败（连接拒绝/地址不对/CORS 拦截）对每一批都会发生，
            // 劈半重试没有意义，直接上抛带排查提示的错误（调用方不再重试）
            var err = new Error(
                '无法连接 ' + apiUrl(cfg.base) + '：' + ((e && e.message) || e) +
                '。常见原因：本地服务未启动、地址或端口不对、或未允许跨域 —— ' +
                'Ollama 需设置环境变量 OLLAMA_ORIGINS=* 后重启，LM Studio 需在开发者设置里打开 Enable CORS'
            );
            err.configError = true;
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }

        if (!res.ok) {
            var detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
            throw new Error('翻译接口 ' + res.status + (detail ? '：' + detail : ''));
        }

        var data = await res.json();
        var choice = data && data.choices && data.choices[0];
        var content = choice && choice.message && choice.message.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('翻译接口返回为空');

        var arr = extractJsonArray(content);
        if (!arr) throw new Error('翻译结果不是合法 JSON 数组');
        if (arr.length !== lines.length) {
            throw new Error('行数不匹配：期望 ' + lines.length + '，实际 ' + arr.length);
        }
        return arr.map(function (v) { return (v == null ? '' : String(v)); });
    }

    // 分批 + 失败对半劈开重试。返回 { lines: 译文数组, failed: 失败行数, calls, lastErr }。
    // cfg: { base, model, key, prompt, batch, temperature, max_tokens, thinking_off, timeout? }
    // texts: 待翻文本数组（来自 op=split 的响应，一一对应）。
    async function translateLines(cfg, texts) {
        var perBatch = parseInt(cfg && cfg.batch, 10);
        if (!Number.isFinite(perBatch) || perBatch < 1) perBatch = 20;

        var out = new Array(texts.length).fill(null);
        var failed = 0;
        var calls = 0;
        var lastErr = '';

        var task = async function (from, to) {
            var slice = texts.slice(from, to);
            try {
                calls++;
                var got = await requestBatch(cfg, slice);
                for (var i = 0; i < got.length; i++) out[from + i] = got[i];
            } catch (e) {
                if (e && e.configError) throw e;    // 配置/网络错: 劈半也没用, 直接上抛
                lastErr = String((e && e.message) || e).slice(0, 200);
                var len = to - from;
                if (len === 1) {
                    failed++;
                    out[from] = '';   // 单行都翻不了，留空，拼回后该行无译文
                    return;
                }
                var mid = from + Math.floor(len / 2);
                await task(from, mid);
                await task(mid, to);
            }
        };

        for (var i = 0; i < texts.length; i += perBatch) {
            await task(i, Math.min(i + perBatch, texts.length));
        }
        return { lines: out, failed: failed, calls: calls, lastErr: lastErr };
    }

    root.AITranslate = {
        translateLines: translateLines,
        extractJsonArray: extractJsonArray,
        DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    };
})(typeof window !== 'undefined' ? window : globalThis);
