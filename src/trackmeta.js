// ============================================================================
// trackmeta.js — 歌曲元数据读写 (D1 track_meta)
//
// 元数据有三个来源, 优先级: 用户手动编辑 > 音频内嵌标签 > 文件名解析。
// 只有"用户手动编辑"需要落库 —— 内嵌标签每次读文件头即可, 文件名解析是纯函数。
// 所以本表只存用户覆盖过的字段:
//   NULL = 用户没设置过, 读取时回落到下一来源
//   空字符串与 NULL 不同: 前端用 null 表示"清空", 不传表示"不动"
//
// 注意: 文件改名/移动时本行不跟随(以 path 为主键)。改名后视为新条目,
// 自动回落到内嵌标签/文件名解析, 旧行留着无害(不参与任何查询)。
// ============================================================================
import { json, jerr, sanitizeRel } from './util.js';

const MAX_FIELD = 400;        // title/artist/album 最大长度
const MAX_LRC = 300 * 1024;   // 单段歌词文本上限 300KB
const OFFSET_LIMIT = 30000;   // 歌词偏移上限 ±30 秒

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS track_meta (
  path         TEXT PRIMARY KEY,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  lyric_offset INTEGER NOT NULL DEFAULT 0,
  lrc          TEXT,
  trans        TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL
)`;

function emptyOf(path) {
  return {
    path,
    title: null,
    artist: null,
    album: null,
    lyric_offset: 0,
    lrc: null,
    trans: null,
    source: null,
    updated_at: 0,
  };
}

// null / undefined / 非字符串 → null(未设置); 否则去空白并截断, 空串也视为未设置
function optStr(v, max) {
  if (v === undefined || v === null || typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
}

// 歌词文本: 保留原始换行, 只做长度封顶
function optLrc(v) {
  if (v === undefined || v === null || typeof v !== 'string') return null;
  return v.length > MAX_LRC ? v.slice(0, MAX_LRC) : v;
}

function normOffset(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, n));
}

// GET /api/track/meta?path= — 取该文件的用户覆盖元数据; 没有记录时返回全 null 的空壳
export async function getMeta(_req, _env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('缺少 path');
  let row;
  try {
    row = await db.prepare(
      'SELECT title, artist, album, lyric_offset, lrc, trans, source, updated_at FROM track_meta WHERE path = ?1',
    ).bind(path).first();
  } catch (e) {
    // 未执行迁移时自愈建表, 然后按"无记录"返回(不影响播放)
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await db.prepare(CREATE_SQL).run();
    row = null;
  }
  if (!row) return json({ meta: emptyOf(path) });
  return json({ meta: { path, ...row } });
}

// PUT /api/track/meta — 整体覆盖(前端始终提交完整对象, null 表示清空该字段)
export async function putMeta(req, _env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const path = sanitizeRel(body && body.path);
  if (!path) return jerr('缺少 path');

  const title = optStr(body.title, MAX_FIELD);
  const artist = optStr(body.artist, MAX_FIELD);
  const album = optStr(body.album, MAX_FIELD);
  const lrc = optLrc(body.lrc);
  const trans = optLrc(body.trans);
  const offset = normOffset(body.lyric_offset);
  // source 只用于 UI 展示来源标记, 不参与优先级判定
  const source = ['manual', 'id3', 'filename'].includes(body.source) ? body.source : 'manual';
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO track_meta (path, title, artist, album, lyric_offset, lrc, trans, source, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title, artist = excluded.artist, album = excluded.album,
         lyric_offset = excluded.lyric_offset, lrc = excluded.lrc, trans = excluded.trans,
         source = excluded.source, updated_at = excluded.updated_at`,
    ).bind(path, title, artist, album, offset, lrc, trans, source, now).run();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await db.prepare(CREATE_SQL).run();
    await db.prepare(
      `INSERT INTO track_meta (path, title, artist, album, lyric_offset, lrc, trans, source, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(path, title, artist, album, offset, lrc, trans, source, now).run();
  }

  return json({ meta: { path, title, artist, album, lyric_offset: offset, lrc, trans, source, updated_at: now } });
}
