// ============================================================================
// settings.js — 应用参数设置 (单行存 D1, 前端"参数设置"弹窗读写)
// 分片大小只允许 CHUNK_CANDIDATES 集合内的值: 上传 complete 时服务端靠
// (size, nchunks) 反推真实分片大小, 集合外的值会导致推导失败
// ============================================================================
import { jerr, json, cacheGet, cachePut, cacheDel } from './util.js';

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
};

const DEVICE_KEYS = ['mobile', 'desktop'];
const LIMIT_KEYS = ['upload_limit', 'preview_text', 'preview_markdown', 'preview_html'];
const PREVIEW_MIN = 64 * 1024;
const PREVIEW_MAX = 50 * MB;
const MAX_RULES = 20;
const RANGE_MAX = 2048 * MB; // 范围防御上限 2GB
const DOWNLOAD_RANGE_MIN = 1 * MB;
const DOWNLOAD_RANGE_MAX = 32 * MB;

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
  return out;
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

// GET /api/settings — 公开接口(分享页也读), 走边缘缓存 5 分钟, PUT 时主动失效
export async function getSettings(_req, env, db) {
  const cached = await cacheGet('app-settings');
  if (cached) return cached;
  const stored = await readStored(db);
  const payload = JSON.stringify({ settings: normalize(stored, maxUploadOf(env)), max_upload_size: maxUploadOf(env) });
  // 缓存与响应用各自独立的 Response (cachePut 会消费传入的 body 流)
  await cachePut('app-settings', new Response(payload), 300);
  return new Response(payload, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
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
  return json({ settings: JSON.parse(value) });
}
