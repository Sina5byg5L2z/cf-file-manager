// ============================================================================
// settings.js — 应用参数设置 (单行存 D1, 前端"参数设置"弹窗读写)
// 分片大小只允许 CHUNK_CANDIDATES 集合内的值: 上传 complete 时服务端靠
// (size, nchunks) 反推真实分片大小, 集合外的值会导致推导失败
// ============================================================================
import { jerr, json, cacheGet, cachePut, cacheDel, SEC_HEADERS } from './util.js';
import * as auth from './auth.js';

// 与 util.js deriveChunkSize 的候选集保持一致
const CHUNK_CANDIDATES = [32768, 65536, 131072, 262144, 524288, 1048576];

const MB = 1024 * 1024;
const DEFAULTS = {
  chunk_default: { chunk_size: 524288, concurrent: 4 },     // 未命中任何范围规则时的兜底
  chunk_rules: [],                                          // [{min,max,chunk_size,concurrent}] 按序先命中先用
  upload_limit:    { mobile: 200 * MB, desktop: 200 * MB },   // 单文件上传上限
  preview_text:    { mobile: 512 * 1024, desktop: 1 * MB },   // 文本/代码预览上限
  preview_markdown:{ mobile: 256 * 1024, desktop: 512 * 1024 },// Markdown 预览上限
  preview_html:    { mobile: 1 * MB,     desktop: 5 * MB },   // HTML 预览上限
  // 单次下载窗口(字节): 既是服务端 Range 响应上限, 也是页面内分片下载的每段大小。
  // 代价是 CPU: 实测读 ~25~33ms CPU/MiB(D1 行 → 字节反序列化), 平台掐断点约 2.0s CPU
  // (= 60~90MiB), 故 8MiB 留 ~8x 余量。上限 32MiB 是因为超过它单次响应就接近掐断点。
  download_range:  8 * MB,
  // 歌词: provider 是原文来源, trans_provider 是译文来源(目前只有网易云有译文字段)。
  // netease_base 是自部署 NeteaseCloudMusicApi 的地址 —— 属"用户私有地址",
  // 不随公开的 /api/settings 下发(见 publicOf), 登录态才单独补发。
  // ai_* 是「AI 翻译」用的 OpenAI 兼容接口配置。密钥 ai_key 存配置表（用户在设置里自己填，
  // 任何厂商均可）；留空时回落 env.SILLICONFLOW_API_KEY（部署期兜底）。公开视图会抹掉 ai_key。
  lyrics: {
    enabled: true,
    provider: 'auto',
    trans_provider: 'off',
    netease_base: '',
    ai_enabled: false,
    ai_model: 'Qwen/Qwen3-8B',
    ai_base: 'https://api.siliconflow.cn/v1',
    ai_key: '',
  },
};

const DEVICE_KEYS = ['mobile', 'desktop'];
const LIMIT_KEYS = ['upload_limit', 'preview_text', 'preview_markdown', 'preview_html'];
const PREVIEW_MIN = 64 * 1024;
const PREVIEW_MAX = 50 * MB;
const MAX_RULES = 20;
const RANGE_MAX = 2048 * MB; // 范围防御上限 2GB
const DOWNLOAD_RANGE_MIN = 1 * MB;
const DOWNLOAD_RANGE_MAX = 32 * MB;
const LYRICS_PROVIDERS = ['auto', 'lrclib', 'lrc_cx', 'off'];
const LYRICS_TRANS = ['off', 'netease'];
const AI_MODEL_DEFAULT = 'Qwen/Qwen3-8B';
const AI_BASE_DEFAULT = 'https://api.siliconflow.cn/v1';
const AI_MODEL_MAX = 120;

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function normChunk(v, fallback) {
  const n = parseInt(v, 10);
  return CHUNK_CANDIDATES.includes(n) ? n : fallback;
}
function normConc(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : fallback;
}
// 自部署地址: 只接受 http(s), 去掉尾部斜杠, 长度封顶
function normBase(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\/+$/, '');
  if (!s || !/^https?:\/\/[^\s]+$/i.test(s)) return '';
  return s.slice(0, 300);
}
// AI 接口地址: 合法则用传入值, 非法/为空退回默认(不能留空导致翻译功能失效)
function normAiBase(v) {
  const s = normBase(v);
  return s || AI_BASE_DEFAULT;
}
function normAiModel(v) {
  if (typeof v !== 'string') return AI_MODEL_DEFAULT;
  const s = v.trim().replace(/[\s\u0000-\u001f]/g, '');
  return s ? s.slice(0, AI_MODEL_MAX) : AI_MODEL_DEFAULT;
}

// 把任意输入(部分字段)归一成合法完整设置; maxUpload = 服务端 MAX_UPLOAD_SIZE
function normalize(input, maxUpload) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const dflt = src.chunk_default && typeof src.chunk_default === 'object' ? src.chunk_default : {};
  out.chunk_default = {
    chunk_size: normChunk(dflt.chunk_size, DEFAULTS.chunk_default.chunk_size),
    concurrent: normConc(dflt.concurrent, DEFAULTS.chunk_default.concurrent),
  };
  // 分片规则: 按数组顺序先命中先用, 允许范围重叠; 无效条目丢弃, 条目数封顶
  const rules = Array.isArray(src.chunk_rules) ? src.chunk_rules.slice(0, MAX_RULES) : [];
  out.chunk_rules = rules.map((r) => {
    if (!r || typeof r !== 'object') return null;
    const min = clampInt(r.min, 0, RANGE_MAX, 0);
    const max = clampInt(r.max, 0, RANGE_MAX, 0);
    if (max < min) return null;
    return {
      min,
      max,
      chunk_size: normChunk(r.chunk_size, out.chunk_default.chunk_size),
      concurrent: normConc(r.concurrent, out.chunk_default.concurrent),
    };
  }).filter(Boolean);
  for (const k of LIMIT_KEYS) {
    const group = src[k] && typeof src[k] === 'object' ? src[k] : {};
    out[k] = {};
    for (const d of DEVICE_KEYS) {
      if (k === 'upload_limit') {
        // 不允许超过服务端上限, 否则上传到 complete 才报 413
        out[k][d] = clampInt(group[d], MB, maxUpload, DEFAULTS[k][d]);
      } else {
        out[k][d] = clampInt(group[d], PREVIEW_MIN, PREVIEW_MAX, DEFAULTS[k][d]);
      }
    }
  }
  out.download_range = clampInt(src.download_range, DOWNLOAD_RANGE_MIN, DOWNLOAD_RANGE_MAX, DEFAULTS.download_range);
  const lyr = src.lyrics && typeof src.lyrics === 'object' ? src.lyrics : {};
  out.lyrics = {
    enabled: lyr.enabled !== false,
    provider: LYRICS_PROVIDERS.includes(lyr.provider) ? lyr.provider : DEFAULTS.lyrics.provider,
    trans_provider: LYRICS_TRANS.includes(lyr.trans_provider) ? lyr.trans_provider : DEFAULTS.lyrics.trans_provider,
    netease_base: normBase(lyr.netease_base),
    ai_enabled: lyr.ai_enabled === true,
    ai_model: normAiModel(lyr.ai_model),
    ai_base: normAiBase(lyr.ai_base),
    ai_key: String(lyr.ai_key || '').trim().slice(0, 300),
  };
  return out;
}

// 公开视图: 抹掉私有字段。/api/settings 是公开接口(分享页未登录也读),
// 不能把用户自部署的地址发给任何人。
function publicOf(s) {
  const o = JSON.parse(JSON.stringify(s));
  if (o.lyrics) { o.lyrics.netease_base = ''; o.lyrics.ai_key = ''; }
  return o;
}

async function readStored(db) {
  try {
    const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?1').bind('ui').first();
    return row ? JSON.parse(row.value) : {};
  } catch { /* 表不存在等情况按默认处理 */ }
  return {};
}

function maxUploadOf(env) {
  return parseInt(env.MAX_UPLOAD_SIZE || '209715200', 10);
}

// ---- 服务端读取"单次下载窗口" ----
// 优先级: 用户在「参数设置」里存的值 → env.RANGE_MAX(部署期兜底) → 内置默认 8MiB。
// 进程内记忆 30s: 取文件是热路径, 不能每次请求都读 D1; 保存设置后立即清掉这份记忆。
let RANGE_MEMO = { v: 0, exp: 0 };
export function resetRangeMemo() {
  RANGE_MEMO = { v: 0, exp: 0 };
}
export async function rangeMaxOf(env, db) {
  const now = Date.now();
  if (RANGE_MEMO.v && now < RANGE_MEMO.exp) return RANGE_MEMO.v;
  let v;
  try {
    const stored = await readStored(db);
    if (stored && stored.download_range != null) {
      v = normalize(stored, maxUploadOf(env)).download_range;
    }
  } catch { /* 表缺失等情况退回 env / 默认值 */ }
  if (!Number.isFinite(v)) {
    const e = parseInt(env && env.RANGE_MAX, 10);
    v = Number.isFinite(e) && e > 0 ? Math.min(e, DOWNLOAD_RANGE_MAX) : DEFAULTS.download_range;
  }
  v = Math.min(DOWNLOAD_RANGE_MAX, Math.max(DOWNLOAD_RANGE_MIN, v));
  RANGE_MEMO = { v, exp: now + 30000 };
  return v;
}

// ---- 服务端读取歌词配置 ----
// 同样记忆 30s。注意: 这里读到的是含 netease_base 的完整配置, 只供 Worker 内部使用。
let LYRICS_MEMO = { v: null, exp: 0 };
export function resetLyricsMemo() {
  LYRICS_MEMO = { v: null, exp: 0 };
}
export async function lyricsConfigOf(env, db) {
  const now = Date.now();
  if (LYRICS_MEMO.v && now < LYRICS_MEMO.exp) return LYRICS_MEMO.v;
  let v = DEFAULTS.lyrics;
  try {
    v = normalize(await readStored(db), maxUploadOf(env)).lyrics;
  } catch { /* 表缺失等情况用默认 */ }
  LYRICS_MEMO = { v, exp: now + 30000 };
  return v;
}

// ---- 服务端读取 AI 翻译配置 ----
// 复用 LYRICS_MEMO(同一份 lyrics 对象), 只挑翻译需要的字段, 顺带判定"密钥是否就绪"。
export async function lyricsAiOf(env, db) {
  const lyr = await lyricsConfigOf(env, db);
  return {
    enabled: lyr.ai_enabled === true,
    model: lyr.ai_model || AI_MODEL_DEFAULT,
    base: lyr.ai_base || AI_BASE_DEFAULT,
    key: lyr.ai_key || '',
    // 用户在设置里填了密钥 → 用配置里的; 否则回落部署期 env 兜底
    hasKey: !!(lyr.ai_key || (env && env.SILLICONFLOW_API_KEY)),
  };
}

// GET /api/settings — 公开接口(分享页也读), 走边缘缓存 5 分钟, PUT 时主动失效。
// 缓存里存的是"脱敏版本"; 已登录时再单独补上私有字段, 否则设置页回填不出地址,
// 用户改任一设置后全量提交就会把地址清空。
export async function getSettings(req, env, db) {
  const cached = await cacheGet('app-settings');
  let payload = null;
  if (cached) {
    payload = await cached.text();
  } else {
    const stored = await readStored(db);
    payload = JSON.stringify({ settings: publicOf(normalize(stored, maxUploadOf(env))), max_upload_size: maxUploadOf(env) });
    await cachePut('app-settings', new Response(payload), 300);
  }
  try {
    // 登录态(Header 或只读 Cookie)才能拿到私有字段; 未登录只下发公开部分
    const denied = await auth.checkAuth(req, env, db);
    if (!denied) {
      const stored = await readStored(db);
      const lyr = normalize(stored, maxUploadOf(env)).lyrics;
      if (lyr.netease_base || lyr.ai_key) {
        const o = JSON.parse(payload);
        if (o.settings && o.settings.lyrics) {
          o.settings.lyrics.netease_base = lyr.netease_base;
          o.settings.lyrics.ai_key = lyr.ai_key;
        }
        payload = JSON.stringify(o);
      }
    }
  } catch { /* 鉴权异常按未登录处理, 不下发私有字段 */ }
  return new Response(payload, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS } });
}

// PUT /api/settings — body 为完整设置对象(前端始终全量提交)
export async function saveSettings(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const value = JSON.stringify(normalize(body, maxUploadOf(env)));
  try {
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('ui', value).run();
  } catch (e) {
    // 线上库缺表(建库早于此功能)时自愈: 建表后重试一次
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await db.prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
    await db.prepare('INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('ui', value).run();
  }
  await cacheDel('app-settings');
  resetRangeMemo(); // 新窗口立即生效, 不必等 30s 记忆过期
  resetLyricsMemo();
  return json({ settings: JSON.parse(value) });
}
