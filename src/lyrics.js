// ============================================================================
// lyrics.js — 歌词代理 (Worker 转发, 统一 UA / 超时 / 降级 / 缓存)
//
// 为什么必须走 Worker 而不是浏览器直连:
//   1) LRCLIB 要求客户端自报 User-Agent, 浏览器改不了 UA;
//   2) 上游 CORS 头不可控(第三方目录标注支持, 但没实测过响应头);
//   3) 缓存与降级策略要跨设备共享。
//
// 来源链: 用户自己贴的歌词 > LRCLIB(/api/get → /api/search) > api.lrc.cx
// 译文只有网易云有(tlyric / romalrc), 是可选项, 默认关闭。
//
// CPU: 转发是 I/O 等待, 不计 CPU 配额(掐断线是 CPU 而非墙钟), 但要设超时。
// ============================================================================
import { json, jerr, cacheGet, cachePut, cacheDel, sanitizeRel } from './util.js';
import { lyricsConfigOf } from './settings.js';

// LRCLIB 要求客户端自报身份: 应用名 + 版本 + 主页(用开源仓库地址)
const UA = 'file-manager/1.0 (+https://github.com/Sina5byg5L2z/cf-file-manager)';
const UPSTREAM_TIMEOUT = 5000;   // 单个上游超时(毫秒)
const HIT_TTL = 30 * 86400;      // 命中缓存 30 天
const MISS_TTL = 6 * 3600;       // 空结果缓存 6 小时, 防止每播一次都打上游

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function jsonResponse(payload) {
  return new Response(payload, { headers: JSON_HEADERS });
}

// ---------------- 上游请求 ----------------
async function fetchUp(url, headers = {}) {
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    if (!res.ok) return null;             // 404 / 429 一视同仁: 交给下一个源
    return res;
  } catch { return null; }                // 超时 / DNS / 网络错误
}

async function fetchJson(url) {
  const res = await fetchUp(url, { Accept: 'application/json' });
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
}

// ---------------- 文件名解析 ----------------
// "周杰伦 - 晴天.mp3" → { artist: '周杰伦', title: '晴天' }
// "01 晴天.mp3"       → { artist: null,    title: '晴天' }
// 解析不出歌手时返回 artist: null —— 调用方据此决定走 /api/get 还是 /api/search
export function parseName(filename) {
  // 容错: 允许传完整路径, 内部先取文件名 —— 调用方若忘了 basename 也不会把目录当歌手
  let s = basename(String(filename || '')).replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  if (!s) return { title: '', artist: null };
  // 去音质/版本类括号后缀: (Official Video) [HQ] 【320K】 (live) ...
  s = s.replace(/[(\[【][^)\]】]*(?:official|mv|m\/v|live|hd|hq|sq|320k|192k|128k|flac|ape|audio|video|lyrics?|instrumental|inst\.|remix|cover|伴奏|现场|高清|无损)[^)\]】]*[)\]】]/gi, '');
  s = s.replace(/_/g, ' ');
  // 去前导序号: "01 " / "01. " / "01-" / "01、" (空格也算分隔符, 否则 "01 晴天" 去不掉)
  s = s.replace(/^\s*\d{1,3}\s*[.\-_、\s]\s*/, '');
  s = s.trim();
  if (!s) return { title: '', artist: null };

  // 先试带空格的分隔符(最可靠), 再试裸 '-'
  for (const sep of [' - ', ' – ', ' — ', '-', '–', '—']) {
    const i = s.indexOf(sep);
    if (i > 0) {
      const a = s.slice(0, i).trim();
      const b = s.slice(i + sep.length).trim();
      if (a && b) return { artist: a, title: b };   // 约定"歌手 - 歌名"
    }
  }
  return { title: s, artist: null };
}

export function basename(path) {
  const s = String(path || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

// 至少含一个 [mm:ss] 时间戳才算"有同步歌词"
function hasTimestamp(text) {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(String(text || ''));
}

// ---------------- 各来源 ----------------
const EMPTY = () => ({ found: false, synced: null, plain: null, trans: null, roma: null, source: null });

async function fromLrclib(artist, title, duration) {
  const dur = Number.isFinite(duration) ? duration : 0;
  // 有歌手时走 /api/get: 它按 (artist, title, duration±2s) 精确匹配, 命中质量最高
  if (artist) {
    const u = new URL('https://lrclib.net/api/get');
    u.searchParams.set('artist_name', artist);
    u.searchParams.set('track_name', title);
    if (dur > 0 && dur <= 3600) u.searchParams.set('duration', String(Math.round(dur)));
    const r = await fetchJson(u);
    if (r) {
      if (r.syncedLyrics) return { ...EMPTY(), found: true, synced: r.syncedLyrics, plain: r.plainLyrics || null, source: 'lrclib' };
      if (r.plainLyrics) return { ...EMPTY(), found: true, plain: r.plainLyrics, source: 'lrclib' };
    }
  }
  // 兜底: 搜索后按时长挑最接近的一条
  const s = new URL('https://lrclib.net/api/search');
  s.searchParams.set('q', artist ? `${artist} ${title}` : title);
  const list = await fetchJson(s);
  if (!Array.isArray(list) || !list.length) return EMPTY();
  let best = null;
  let bestDiff = Infinity;
  for (const it of list) {
    if (!it || (!it.syncedLyrics && !it.plainLyrics)) continue;
    const diff = dur > 0 && Number.isFinite(it.duration) ? Math.abs(it.duration - dur) : 0;
    if (diff < bestDiff) { bestDiff = diff; best = it; }
  }
  // 有 duration 且最接近的也差 5 秒以上 → 判定不是这首歌, 宁可交给下一个源
  if (!best) return EMPTY();
  if (dur > 0 && bestDiff > 5) return EMPTY();
  return { ...EMPTY(), found: true, synced: best.syncedLyrics || null, plain: best.plainLyrics || null, source: 'lrclib' };
}

async function fromLrcCx(artist, title) {
  const u = new URL('https://api.lrc.cx/lyrics');
  u.searchParams.set('artist', artist || '');
  u.searchParams.set('title', title);
  const res = await fetchUp(u, { Accept: 'text/plain' });
  if (!res) return EMPTY();
  let text = '';
  try { text = (await res.text()).trim(); } catch { return EMPTY(); }
  // 该源在无结果时可能返回空或纯文本歌词; 没有时间戳就当没命中
  if (!text || !hasTimestamp(text)) return EMPTY();
  return { ...EMPTY(), found: true, synced: text, source: 'lrc.cx' };
}

// 网易云搜索(歌词与封面共用): 返回歌曲数组, 每首含 id / duration / al.picUrl
async function neteaseSearchSongs(base, artist, title) {
  const su = new URL(`${base}/search`);
  su.searchParams.set('keywords', artist ? `${artist} ${title}` : title);
  su.searchParams.set('type', '1');
  su.searchParams.set('limit', '8');
  const sr = await fetchJson(su);
  return sr && sr.result && Array.isArray(sr.result.songs) ? sr.result.songs : [];
}

// 网易云: 目前唯一有译文(tlyric)与罗马音(romalrc)的源, 需用户自部署 NeteaseCloudMusicApi
async function fromNetease(base, artist, title, duration) {
  const dur = Number.isFinite(duration) ? duration : 0;
  const songs = await neteaseSearchSongs(base, artist, title);
  if (!songs.length) return null;

  let pick = songs[0];
  if (dur > 0) {
    let bestDiff = Infinity;
    for (const s of songs) {
      const d = Number.isFinite(s.duration) ? Math.abs(s.duration / 1000 - dur) : Infinity;
      if (d < bestDiff) { bestDiff = d; pick = s; }
    }
    if (bestDiff > 5) return null;   // 时长对不上就不要, 免得配上错歌的译文
  }

  // 2) 取歌词(含译文与罗马音)
  const lu = new URL(`${base}/lyric`);
  lu.searchParams.set('id', String(pick.id));
  const lr = await fetchJson(lu);
  if (!lr) return null;
  const pickText = (o) => (o && typeof o.lyric === 'string' && o.lyric.trim()) ? o.lyric : null;
  const trans = pickText(lr.tlyric);
  const roma = pickText(lr.romalrc);
  if (!trans && !roma) return null;
  return { trans, roma };
}

// ---------------- 专辑封面 ----------------
// 实测结论(2026-09-15): iTunes CN 区搜不到中文歌(返回 0 或播客), US 区只有英文艺名偶尔命中;
// Deezer 只认拉丁艺名; 网易云对中文曲库命中最好 —— 所以网易云排第一(配置了地址才启用)。
async function fromNeteaseCover(base, artist, title) {
  const songs = await neteaseSearchSongs(base, artist, title);
  for (const s of songs) {
    const pic = s && s.al && typeof s.al.picUrl === 'string' && s.al.picUrl;
    if (pic) return pic + (pic.indexOf('?') < 0 ? '?param=500y500' : '');   // 网易云图片 CDN 的尺寸参数
  }
  return null;
}

async function fromDeezerCover(artist, title) {
  const u = new URL('https://api.deezer.com/search');
  u.searchParams.set('q', artist ? `${artist} ${title}` : title);
  u.searchParams.set('limit', '5');
  const r = await fetchJson(u);
  const list = r && Array.isArray(r.data) ? r.data : [];
  for (const it of list) {
    const c = it && it.album && (it.album.cover_big || it.album.cover_medium);
    if (c) return c;
  }
  return null;
}

async function fromItunesCover(artist, title) {
  const u = new URL('https://itunes.apple.com/search');
  u.searchParams.set('term', artist ? `${artist} ${title}` : title);
  u.searchParams.set('entity', 'song');
  u.searchParams.set('limit', '5');
  const r = await fetchJson(u);
  const list = r && Array.isArray(r.results) ? r.results : [];
  for (const it of list) {
    // 中文关键词会混入播客/有声书/电影, 只留真正的音乐曲目
    if (!it || it.wrapperType !== 'track' || it.kind !== 'song' || !it.artworkUrl100) continue;
    return it.artworkUrl100.replace('100x100bb', '600x600bb');   // 苹果 CDN 支持改尺寸占位符
  }
  return null;
}

// GET /api/cover?path=&title=&artist=  →  { found, url?, source? }
// 只返回热链 URL, 不代理图片字节 —— mzstatic/126.net/dzcdn 都允许直链, Worker 零带宽成本
export async function getCover(_req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('缺少 path');
  return resolveCover(env, db, {
    path,
    title: url.searchParams.get('title') || '',
    artist: url.searchParams.get('artist') || '',
  });
}

// 封面解析核心(管理页 / 分享页共用)。分享页拿不到曲名时返回 found:false, 不抛 4xx。
async function resolveCover(env, db, opts) {
  const cfg = await lyricsConfigOf(env, db);
  if (!cfg.enabled || cfg.provider === 'off') {
    return json({ found: false, reason: 'disabled' });
  }
  const path = opts.path;

  // 曲名优先级与歌词一致: 参数 > 用户编辑 > 文件名解析
  let title = String(opts.title || '').trim();
  let artist = String(opts.artist || '').trim();
  let meta = null;
  try {
    meta = await db.prepare('SELECT title, artist FROM track_meta WHERE path = ?1').bind(path).first();
  } catch { /* 未执行迁移时忽略 */ }
  if (!title && meta && meta.title) title = meta.title;
  if (!artist && meta && meta.artist) artist = meta.artist;
  if (!title) {
    const p = parseName(basename(path));
    title = p.title;
    if (!artist) artist = p.artist || '';
  }
  if (!title) return json({ found: false, reason: 'no-title' });

  // 缓存键带 netease_base: 换实例后旧结果不串
  const key = `cover:${cfg.netease_base || ''}:${(artist || '').toLowerCase()}:${title.toLowerCase()}`;
  const cached = await cacheGet(key);
  if (cached) {
    try { return jsonResponse(await cached.text()); } catch { /* 缓存体损坏则重查 */ }
  }

  let coverUrl = null;
  let source = null;
  if (cfg.netease_base) {
    coverUrl = await fromNeteaseCover(cfg.netease_base, artist, title);
    if (coverUrl) source = 'netease';
  }
  if (!coverUrl) {
    coverUrl = await fromDeezerCover(artist, title);
    if (coverUrl) source = 'deezer';
  }
  if (!coverUrl) {
    coverUrl = await fromItunesCover(artist, title);
    if (coverUrl) source = 'itunes';
  }

  const payload = JSON.stringify(coverUrl ? { found: true, url: coverUrl, source } : { found: false });
  await cachePut(key, new Response(payload), coverUrl ? HIT_TTL : MISS_TTL);
  return jsonResponse(payload);
}

// ---------------- 歌词持久化到 D1 ----------------
// 为什么不再只靠 Cache API: 边缘缓存会被淘汰、有过期时间, 且分享页(无登录)也要读同一份歌词。
// 写入语义见 migrations/2026-09-16-lyrics-store.sql:
//   只有"真的取到歌词"(found=1)才落库, 长期有效 —— 只在"拉黑来源/撤销拉黑/改歌曲信息"时删除。
//   "没找到"不入库: 边缘缓存的 MISS_TTL(6 小时)足够挡住重复上游请求, 也不会把"当时没找到"长期钉死。
const DUR_TOLERANCE = 2;                   // 时长容忍: 库内时长与请求时长差 >2s 视为不是同一版本

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS lyrics (
  path       TEXT PRIMARY KEY,
  found      INTEGER NOT NULL DEFAULT 0,
  source     TEXT,
  synced     TEXT,
  plain      TEXT,
  trans      TEXT,
  roma       TEXT,
  title      TEXT,
  artist     TEXT,
  duration   REAL NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
)`;

async function ensureStore(db) {
  try { await db.prepare(CREATE_SQL).run(); } catch { /* 已存在 / 只读连接 */ }
}

// 读一条; 表不存在时自愈建表并当作未命中
async function storeGet(db, path) {
  try {
    return await db.prepare(
      'SELECT path, found, source, synced, plain, trans, roma, title, artist, duration, fetched_at FROM lyrics WHERE path = ?1',
    ).bind(path).first() || null;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) return null;   // 读失败不影响播放
    await ensureStore(db);
    return null;
  }
}

// 写一条。只写"取到歌词"的结果; 写失败只记日志, 不影响本次返回 —— 歌词是可选增强, 不能拖垮播放。
async function storePut(db, path, result, meta) {
  if (!result || !result.found) return;   // 空结果不落库(交给边缘缓存 6 小时)
  const args = [
    path,
    1,
    result.source || null,
    result.synced || null,
    result.plain || null,
    result.trans || null,
    result.roma || null,
    (meta && meta.title) || null,
    (meta && meta.artist) || null,
    Number.isFinite(meta && meta.duration) ? meta.duration : 0,
    Date.now(),
  ];
  const sql = `INSERT INTO lyrics (path, found, source, synced, plain, trans, roma, title, artist, duration, fetched_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    ON CONFLICT(path) DO UPDATE SET
      found = excluded.found, source = excluded.source, synced = excluded.synced, plain = excluded.plain,
      trans = excluded.trans, roma = excluded.roma, title = excluded.title, artist = excluded.artist,
      duration = excluded.duration, fetched_at = excluded.fetched_at`;
  try {
    await db.prepare(sql).bind(...args).run();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) {
      await ensureStore(db);
      try { await db.prepare(sql).bind(...args).run(); return; } catch (e2) { console.error('lyrics store put:', e2 && e2.message); return; }
    }
    console.error('lyrics store put:', e && e.message);
  }
}

// 删除(=失效)。拉黑来源、撤销拉黑、修改歌曲信息时调用; 也用于清理历史遗留的空结果行。
export async function clearStoredLyrics(db, path) {
  if (!path) return;
  try { await db.prepare('DELETE FROM lyrics WHERE path = ?1').bind(path).run(); } catch { /* 表缺失无需处理 */ }
}

function rowToResult(row) {
  return {
    found: !!row.found,
    synced: row.synced || null,
    plain: row.plain || null,
    trans: row.trans || null,
    roma: row.roma || null,
    source: row.source || null,
    cached: true,
  };
}

// D1 行是否可用于本次请求。只有 found=1 的行才算命中(found=0 是旧版本留下的, 视同无效)。
function storeUsable(row, duration, rejected) {
  if (!row || !row.found) return false;
  if (row.source && rejected.indexOf(row.source) >= 0) return false;        // 该来源已被拉黑
  const stored = Number(row.duration) || 0;
  const asked = Number(duration) || 0;
  // 库内没记时长(0)时不重取: 否则每首歌都要双次上游。时长对不上才判定为"另一个版本"
  if (asked > 0 && stored > 0 && Math.abs(stored - asked) > DUR_TOLERANCE) return false;
  return true;
}

// ---------------- 歌词解析主链路 (管理页 / 分享页共用) ----------------
// 优先级: 用户手动贴的歌词 > D1 已存 > 边缘缓存 > 上游 > 写回(D1 + 边缘缓存)
// 返回对象可能带 rejected / disabled / reason 等标记, 调用方原样透出。
export async function resolveLyrics(env, db, opts) {
  const path = opts.path;
  const cfg = await lyricsConfigOf(env, db);
  if (!cfg.enabled || cfg.provider === 'off') return { found: false, reason: 'disabled' };

  const duration = Number(opts.duration) || 0;

  // 1) 用户自己贴的歌词优先级最高(顺便拿到手填的 title/artist)
  let meta = null;
  try {
    meta = await db.prepare('SELECT title, artist, lrc, trans FROM track_meta WHERE path = ?1').bind(path).first();
  } catch { /* 未执行迁移时忽略, 回落到在线源 */ }
  if (meta && meta.lrc) {
    return {
      found: true, synced: meta.lrc, plain: null, trans: meta.trans || null, roma: null,
      source: 'manual', title: meta.title || null, artist: meta.artist || null,
    };
  }

  // 2) 曲名优先级: 请求参数覆盖 > 用户编辑的元数据 > 文件名解析
  let title = String(opts.title || '').trim();
  let artist = String(opts.artist || '').trim();
  if (!title && meta && meta.title) title = meta.title;
  if (!artist && meta && meta.artist) artist = meta.artist;
  if (!title) {
    const p = parseName(basename(path));
    title = p.title;
    if (!artist) artist = p.artist || '';
  }
  // 分享页拿不到曲名时不该报错 —— 只返回"没歌词", 页面照常播放
  if (!title) return { found: false, reason: 'no-title' };

  // 3) 拉黑检查: 链上全被拉黑 → 直接"暂无歌词", 不读缓存不打上游
  const chain = chainOf(cfg);
  let rejected = [];
  try { rejected = await rejectsOf(db, path); } catch { /* 表缺失视为无 */ }
  const remaining = chain.filter((s) => rejected.indexOf(s) < 0);
  if (!remaining.length) return { found: false, rejected: true, sources: rejected };

  // 4) D1 命中(长期有效)
  const row = await storeGet(db, path);
  if (storeUsable(row, duration, rejected)) {
    return { ...rowToResult(row), title, artist };
  }
  // 早期版本把"没找到"也写过库(found=0): 现在不再那样存, 顺手清掉, 免得多一次无效查询
  if (row && !row.found) await clearStoredLyrics(db, path);

  // 5) 边缘缓存(含拉黑记录时跳过读 —— 缓存里可能还留着被拉黑源的旧结果)
  const key = lyricsCacheKey(cfg, artist, title, duration);
  if (!rejected.length) {
    const cached = await cacheGet(key);
    if (cached) {
      try {
        const parsed = JSON.parse(await cached.text());
        await storePut(db, path, parsed, { title, artist, duration });   // 顺手补进 D1
        return { ...parsed, title, artist };
      } catch { /* 缓存体损坏则重查 */ }
    }
  }

  // 6) 上游
  let result = EMPTY();
  if (remaining.indexOf('lrclib') >= 0) {
    result = await fromLrclib(artist, title, duration);
  }
  if (!result.found && remaining.indexOf('lrc.cx') >= 0) {
    result = await fromLrcCx(artist, title);
  }
  if (result.found && cfg.trans_provider === 'netease' && cfg.netease_base) {
    const t = await fromNetease(cfg.netease_base, artist, title, duration);
    if (t) { result.trans = t.trans; result.roma = t.roma; }
  }

  // 7) 写回: 取到歌词才落 D1(长期); 边缘缓存无论空否都写(空结果 6 小时, 挡重复上游)
  await storePut(db, path, result, { title, artist, duration });
  await cachePut(key, new Response(JSON.stringify(result)), result.found ? HIT_TTL : MISS_TTL);
  return { ...result, title, artist };
}

// ---------------- 主入口 ----------------
// GET /api/lyrics?path=&duration=&title=&artist=
export async function getLyrics(_req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('缺少 path');
  const r = await resolveLyrics(env, db, {
    path,
    duration: parseFloat(url.searchParams.get('duration') || '') || 0,
    title: url.searchParams.get('title') || '',
    artist: url.searchParams.get('artist') || '',
  });
  return json(r);
}

// 分享页(无需登录): 按分享目标文件解析歌词。
// 与 /api/lyrics 同一套链路与数据 —— 手动歌词、D1 缓存、拉黑记录全部一致生效。
export async function shareLyrics(_req, env, db, target, url) {
  const r = await resolveLyrics(env, db, {
    path: target.path,
    duration: parseFloat(url.searchParams.get('duration') || '') || 0,
    title: url.searchParams.get('title') || '',
    artist: url.searchParams.get('artist') || '',
  });
  // 分享页不需要暴露"缺 path/未登录"这类内部原因, 统一降级为 found:false
  const out = (r && (r.found || r.rejected)) ? r : { found: false };
  return json({ ...out, name: target.name });
}

// 分享页封面: 与 /api/cover 同一套来源与缓存键(按曲名, 跨文件复用)
export async function shareCover(_req, env, db, target, url) {
  return resolveCover(env, db, {
    path: target.path,
    title: url.searchParams.get('title') || '',
    artist: url.searchParams.get('artist') || '',
  });
}


// ---------------- 歌词拉黑 ----------------
// 有的源返回的歌词是错的。用户一键拉黑当前来源后:
//   部分拉黑 → 下次获取跳过该源(即"降级重新获取"), 结果仍写缓存;
//   全部拉黑 → 直接返回 rejected, 不读缓存不打上游 —— 即"暂无歌词"。
// 按文件路径记录: "这首歌词是错的"是针对具体文件的判断。
const CHAIN_OF = { auto: ['lrclib', 'lrc.cx'], lrclib: ['lrclib'], lrc_cx: ['lrc.cx'] };

function chainOf(cfg) {
  return CHAIN_OF[cfg.provider] || CHAIN_OF.auto;
}

async function ensureRejectTable(db) {
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS lyrics_reject (path TEXT PRIMARY KEY, sources TEXT NOT NULL DEFAULT '[]', ts INTEGER NOT NULL)").run();
  } catch { /* 表已存在 / 只读连接: 后续读写各自容错 */ }
}

async function rejectsOf(db, path) {
  try {
    const row = await db.prepare('SELECT sources FROM lyrics_reject WHERE path = ?1').bind(path).first();
    const arr = row && row.sources ? JSON.parse(row.sources) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// 缓存键与 getLyrics 完全一致 —— 拉黑/撤销时清掉, 否则 30 天 HIT 会把错误歌词又端回来
function lyricsCacheKey(cfg, artist, title, duration) {
  return `lyrics:${cfg.provider}:${(artist || '').toLowerCase()}:${title.toLowerCase()}:${Math.round(duration || 0)}`;
}

// POST /api/lyrics/reject  body: { path, source?, all?, duration?, title?, artist? }
// source 省略 + all=true → 把链上剩余来源全部拉黑
export async function rejectLyrics(req, env, db) {
  let body = null;
  try { body = await req.json(); } catch { return jerr('invalid json'); }
  const path = sanitizeRel((body && body.path) || '');
  if (!path) return jerr('缺少 path');
  const cfg = await lyricsConfigOf(env, db);
  const chain = chainOf(cfg);

  let sources;
  if (body && body.all) {
    sources = chain.slice();                       // 全部拉黑
  } else {
    const source = String((body && body.source) || '').trim();
    if (chain.indexOf(source) < 0) return jerr('该来源不支持拉黑');
    const cur = await rejectsOf(db, path);
    if (cur.indexOf(source) < 0) cur.push(source);
    sources = cur;
  }
  await ensureRejectTable(db);
  await db.prepare(
    'INSERT INTO lyrics_reject (path, sources, ts) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET sources = ?2, ts = ?3'
  ).bind(path, JSON.stringify(sources), Date.now()).run();

  // D1 歌词一并失效: 库里可能存着刚被拉黑那个源的结果, 不清掉下次就直接端回来了
  await clearStoredLyrics(db, path);

  // 拉黑即清缓存(用户会传 duration/title/artist 供定位键; 缺了就按文件名兜底解析)
  let title = String((body && body.title) || '').trim();
  let artist = String((body && body.artist) || '').trim();
  const duration = parseFloat((body && body.duration) || '') || 0;
  if (!title) {
    const p = parseName(basename(path));
    title = p.title;
    if (!artist) artist = p.artist || '';
  }
  if (title) await cacheDel(lyricsCacheKey(cfg, artist, title, duration));
  return json({ ok: true, sources });
}

// DELETE /api/lyrics/reject?path=  → 撤销拉黑(恢复联网获取)
export async function unRejectLyrics(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('缺少 path');
  await ensureRejectTable(db);
  await db.prepare('DELETE FROM lyrics_reject WHERE path = ?1').bind(path).run();
  // 撤销拉黑 = 允许重新联网获取: D1 里的空结果也要清掉, 否则 7 天窗口内一直不重试
  await clearStoredLyrics(db, path);
  const cfg = await lyricsConfigOf(env, db);
  let title = (url.searchParams.get('title') || '').trim();
  let artist = (url.searchParams.get('artist') || '').trim();
  const duration = parseFloat(url.searchParams.get('duration') || '') || 0;
  if (!title) {
    const p = parseName(basename(path));
    title = p.title;
    if (!artist) artist = p.artist || '';
  }
  if (title) await cacheDel(lyricsCacheKey(cfg, artist, title, duration));
  return json({ ok: true });
}
