// 歌词 AI 翻译 —— 调用 OpenAI 兼容接口（默认 SiliconFlow）把 LRC 译文补上。
//
// 设计前提：调用方是小模型（默认 Qwen/Qwen3-8B），能力弱、爱自由发挥，
// 所以把"翻译"这件开放性任务压缩成"逐行字符替换"这种确定性任务：
//   1. 只在服务端拆掉时间戳，模型看到的永远是纯正文，行间以 \n 分隔；
//   2. 要求 JSON 数组进、JSON 数组出，不用 [mm:ss] 这种带数字的结构去干扰它；
//   3. few-shot 里用"行数必须相等""不要合并/拆分/增删行"把自由度压到最低；
//   4. 返回后严格校验行数，不等则对半劈开重试（劈到 1 行还失败就放弃那一段）。
// 时间戳由服务端按索引原位拼回，模型碰不到，也就不可能改坏时间轴。

import { json, jerr, sanitizeRel } from './util.js';
import { lyricsAiOf } from './settings.js';
import { resolveLyrics } from './lyrics.js';

export const DEFAULT_MODEL = 'Qwen/Qwen3-8B';
export const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';

// 单批行数上限。实测 Qwen/Qwen3-8B（enable_thinking:false）:
//   40 行/批 → 生成 40 行中文要 45s+，会撞 REQ_TIMEOUT，然后劈半重试，
//              白白浪费两次 45s 超时等待（68 行歌词实测总耗时 126s / 6 次请求）
//   20 行/批 → 单批 ~15-25s，一次到位（估算总耗时 ~80s / 4 次请求）
// 行数太多小模型还容易漏行，劈半是兜底而不是常规路径 —— 别把上限调回去。
const MAX_LINES_PER_BATCH = 20;
const REQ_TIMEOUT = 45000;        // 单次请求超时
const MAX_LINE_CHARS = 400;       // 单行送翻的长度上限，超长直接截断保护
const TEMPERATURE = 0.2;
const MAX_TOKENS = 4096;

// Qwen3 系列默认开启"思考模式"(reasoning)，实测同一请求（1 行歌词翻译）:
//   默认                   → 23.4s，reasoning_tokens=369（占 completion 的 98%）
//   enable_thinking: false →  2.5s，reasoning_tokens=0
// 翻译是逐行映射任务，思考纯属浪费；68 行歌词分两批时更是直接顶穿上游超时。
// 该字段是 Qwen3 在 OpenAI 兼容层上的扩展参数，不支持的模型会忽略未知字段，
// 但仍然只在模型名含 "qwen3" 时才下发，避免给别的模型塞无意义参数。
function thinkingOff(cfg) {
  const m = String((cfg && cfg.model) || '').toLowerCase();
  return /qwen3/.test(m);
}

// 歌词行是"可唱的"，翻译要顺口、简洁，不能变成书面语注释。
const SYSTEM_PROMPT = `你是专业的歌词译者。用户会给你一段 JSON 数组，每个元素是一行歌词。
你的任务是逐行翻译成简体中文，并严格按下面的规则输出：

1. 输出必须是 JSON 数组，元素个数与输入数组**完全相等**，顺序一一对应。
2. 每一行独立翻译，**禁止合并相邻行、禁止拆分成多行、禁止增删任何行**。
3. 如果某一行是纯语气词、拟声词、人名、或本身就是中文，原样返回该行内容。
4. 如果某一行是空的或只有标点，返回空字符串。
5. 译文要自然、口语化、适合跟唱，不要加注释、不要加解释、不要加引号包裹。
6. 不要输出任何 JSON 数组之外的内容，不要用代码块包裹。

示例：
输入：["Hello darkness my old friend","I've come to talk with you again","再见"]
输出：["你好，黑暗，我的老朋友","我又来和你交谈了","再见"]`;

function apiUrl(base, path) {
  const b = String(base || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return b + path;
}

// 把一批纯文本行发给模型，期望拿回等长的译文数组。
async function requestBatch(env, cfg, lines) {
  // 密钥优先级: 用户在设置里填的 ai_key → 部署期 env 兜底
  const key = (cfg && cfg.key) || (env && env.SILLICONFLOW_API_KEY);
  if (!key) throw new Error('未配置翻译接口密钥（请在设置 → AI 翻译中填写）');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT);
  let res;
  const payload = {
    model: cfg.model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(lines) }
    ],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false
  };
  if (thinkingOff(cfg)) payload.enable_thinking = false;
  try {
    res = await fetch(apiUrl(cfg.base, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify(payload),
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
    throw new Error(`翻译接口 ${res.status}${detail ? '：' + detail : ''}`);
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('翻译接口返回为空');

  const arr = extractJsonArray(content);
  if (!arr) throw new Error('翻译结果不是合法 JSON 数组');
  if (arr.length !== lines.length) throw new Error(`行数不匹配：期望 ${lines.length}，实际 ${arr.length}`);
  return arr.map(v => (v == null ? '' : String(v)));
}

// 配置类错误（密钥缺失/地址非法）属于"整条链路都跑不了"，不该被行级容错吃掉，
// 否则用户看到的是"每行都没翻出来"而不是"你没配密钥"。
function isConfigError(e) {
  const m = String((e && e.message) || '');
  return /SILLICONFLOW_API_KEY|未配置翻译接口密钥/.test(m);
}

// 小模型常把 JSON 包在 ```json 里，或在前后加一句废话，这里尽量捞出来。
function extractJsonArray(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Qwen3 思考模型可能带 思考 或  thinking 段，先剥掉
  s = s.replace(/<think[\s\S]*?<\/think>/gi, '').trim();

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try {
    const v = JSON.parse(slice);
    if (Array.isArray(v)) return v;
  } catch (_) { /* 下面再抢救一次 */ }

  // 常见崩法：模型用单引号、或漏了逗号前后。逐行粗暴兜底。
  const inner = slice.slice(1, -1);
  if (!inner.trim()) return [];
  const parts = inner.split(/\n/).map(l =>
    l.replace(/^\s*[",]?\s*/, '').replace(/\s*[",]?\s*$/, '').trim()
  ).filter(l => l !== '');
  return parts.length ? parts : null;
}

// 分批 + 失败对半劈开重试。返回 { lines: 译文数组, failed: 失败区间数, lastErr }
async function translateLines(env, cfg, lines) {
  const out = new Array(lines.length).fill(null);
  let failed = 0;
  let calls = 0;
  let lastErr = '';

  const task = async (from, to) => {
    const slice = lines.slice(from, to).map(l =>
      l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l
    );
    try {
      calls++;
      const got = await requestBatch(env, cfg, slice);
      for (let i = 0; i < got.length; i++) out[from + i] = got[i];
    } catch (e) {
      if (isConfigError(e)) throw e;      // 配置错: 劈半也没用, 直接上抛
      lastErr = String((e && e.message) || e).slice(0, 200);
      const len = to - from;
      if (len === 1) {
        failed++;
        out[from] = '';       // 单行都翻不了，留空，拼回后该行无译文
        return;
      }
      const mid = from + Math.floor(len / 2);
      await task(from, mid);
      await task(mid, to);
    }
  };

  for (let i = 0; i < lines.length; i += MAX_LINES_PER_BATCH) {
    await task(i, Math.min(i + MAX_LINES_PER_BATCH, lines.length));
  }
  return { lines: out, failed, calls, lastErr };
}

// ---------- LRC 拆装 ----------

// 数字时间戳: [mm:ss.xx] / [m:ss] / [hh:mm:ss] 等
const TS_RE = /^(\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)/;
// LRC 元信息标签: [ar:歌手] [ti:标题] [al:专辑] [by:] [offset:] [re:] [ve:] [length:]
// 这类行没有正文, 绝不能送去翻译 —— 模型会给它套上译文前缀, 把 LRC 头改坏。
const META_RE = /^\s*\[(ar|ti|al|by|offset|re|ve|length|au|encoding|tool|kana):[^\]]*\]\s*$/i;

const MAX_LRC_CHARS = 300 * 1024;

function hasTimestamp(text) {
  return TS_RE.test(String(text || ''));
}

// 元信息行 [ar:...] 无正文, 不翻译也不参与行数校验
function isMetaLine(line) {
  return META_RE.test(String(line || ''));
}

function optLrcText(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > MAX_LRC_CHARS ? s.slice(0, MAX_LRC_CHARS) : s;
}

// 拆成 [{ ts, text, keep }]。
// keep=true 表示这一行不需要翻译（元信息行），拼回时原样输出。
// 注意：元信息行必须排除在送翻列表之外并保留原位索引 —— 否则模型会给
// `[ar:周杰伦]` 也套一个译文前缀，把 LRC 头改坏（已踩）。
export function splitLrc(lrc) {
  const raw = String(lrc || '').split(/\r?\n/);
  return raw.map(line => {
    if (isMetaLine(line)) return { ts: '', text: line, keep: true };
    const m = line.match(TS_RE);
    if (!m) return { ts: '', text: line, keep: false };
    return { ts: m[1], text: line.slice(m[1].length), keep: false };
  });
}

export async function translateLrc(env, cfg, lrc) {
  const rows = splitLrc(lrc);
  // 只把"需要翻译的行"送出去，其余（元信息/空行）原地保留
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].keep && rows[i].text.trim()) idx.push(i);
  }
  if (!idx.length) {
    return { trans: '', calls: 0, failed: 0, note: '歌词没有可翻译的正文' };
  }

  const texts = idx.map(i => rows[i].text);
  const { lines: got, failed, calls, lastErr } = await translateLines(env, cfg, texts);

  // 译文按"送翻时的顺序"回填到原始行号上；没翻出来的行保留原文
  // （宁可留原文也不要留空 —— 空行会让前端双语显示错位）
  const byRow = new Map();
  idx.forEach((rowIdx, k) => {
    const t = got[k];
    if (t != null && t !== '') byRow.set(rowIdx, t);
  });

  const merged = rows.map((r, i) => {
    if (r.keep) return r.text;
    const t = byRow.get(i);
    if (t == null) return r.ts + r.text;
    return r.ts + t;
  });

  // 失败时带上最后一次的错误信息（多半是上游限流/抖动），劈半重试已自愈，给用户一个解释
  let note = '';
  if (failed) {
    note = `有 ${failed} 行未能翻译，已保留原文` + (lastErr ? `（最后错误：${lastErr}）` : '');
  }
  if (lastErr && !failed) {
    note = `中途出错但已自动重试成功（${lastErr}）`;
  }

  return {
    trans: merged.join('\n'),
    calls,
    failed,
    note,
  };
}

// 生成"时间戳 + 正文"的纯文本，供前端一键复制去网页版翻译
// 与 translateLrc 的输入格式完全一致，粘回来即可原样落库。
export function lrcForCopy(lrc) {
  return String(lrc || '').replace(/\r\n/g, '\n').trim();
}

// ---------------- 路由 ----------------
// POST /api/lyrics/translate  { path, title?, artist?, duration?, lrc? }
//   lrc 传入 → 翻传入的（前端刚拿到的即时代理歌词，避免再走一次上游）
//   不传     → 自己 resolveLyrics 取原文
// 成功 → 写回 track_meta.trans（等价于"手填译文"，走现有的覆盖层语义）+ 返回译文
export async function translateLyrics(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const path = sanitizeRel(body && body.path);
  if (!path) return jerr('缺少 path');

  const ai = await lyricsAiOf(env, db);
  if (!ai.enabled) return jerr('AI 翻译未开启，请先到「参数设置 → 歌词」打开', 400);
  if (!ai.hasKey) return jerr('未配置翻译接口密钥（请在设置 → AI 翻译中填写）', 400);

  // 1) 拿原文：优先用前端传的（它刚刚渲染的就是这份），否则自己解析一遍
  let lrc = optLrcText(body && body.lrc);
  let title = String((body && body.title) || '').trim();
  let artist = String((body && body.artist) || '').trim();
  if (!lrc) {
    try {
      const r = await resolveLyrics(env, db, {
        path,
        title: title || undefined,
        artist: artist || undefined,
        duration: Number(body && body.duration) || 0,
      });
      if (r && r.found && r.synced) {
        lrc = r.synced;
        if (!title) title = r.title || '';
        if (!artist) artist = r.artist || '';
      }
    } catch (e) {
      return jerr('获取原歌词失败：' + (e && e.message || e), 500);
    }
  }
  if (!lrc) return jerr('这首歌还没有原歌词，无法翻译', 400);
  if (!hasTimestamp(lrc)) return jerr('原文没有时间轴，暂不支持翻译（请先取到带时间戳的歌词）', 400);

  // 2) 翻译
  let out;
  try {
    out = await translateLrc(env, { model: ai.model, base: ai.base }, lrc);
  } catch (e) {
    return jerr('翻译失败：' + (e && e.message || e), 502);
  }
  if (!out.trans) return jerr(out.note || '翻译结果为空', 502);

  // 3) 落库：写进 track_meta.trans，语义与"用户手填译文"完全一致（覆盖层，
  //    不改动 lrc，也不影响原文来源）。用 upsert 避免碰到用户已填的 lrc/title 等字段。
  try {
    await db.prepare(
      `INSERT INTO track_meta (path, trans, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(path) DO UPDATE SET trans = excluded.trans, updated_at = excluded.updated_at`,
    ).bind(path, out.trans, Date.now()).run();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) {
      // 落库失败不该让用户白等一次翻译，译文照常返回，只是下次要重翻
      console.error('translate store failed:', e && e.message);
    }
  }
  // 手填译文不写 D1 lyrics / 边缘缓存（那是联网结果的缓存），前端拿返回值直接重渲染即可。
  return json({
    ok: true,
    trans: out.trans,
    title, artist,
    calls: out.calls,
    note: out.note || '',
  });
}
