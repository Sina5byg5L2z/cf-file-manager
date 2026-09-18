// ============================================================================
// share.js — 分享链接 (对应原版 routes/share.rs)
// 降耗: 分享元数据边缘缓存 2min; 访问计数用 60s 标记节流, 刷新不产生 D1 写
// ============================================================================

import {
  json, jerr, sanitizeRel, hashPassword, verifyPassword,
  cacheGet, cachePut, cacheDel, randomId,
  mimeFromName, isImageName,
} from './util.js';
import { getNode, serveFileContent, collectZipEntries, zipStreamResponse } from './vfs.js';
import { shareLyrics, shareCover } from './lyrics.js';
import { cookieValue, cookieHeader, isSecureReq, signPayload, verifyPayload } from './auth.js';

const SHARE_COLS = 'id, path, password, expires_at, created_at, access_count, last_accessed_at';

async function getShareCached(db, id) {
  const ck = `SM:${id}`;
  const hit = await cacheGet(ck);
  if (hit) {
    try { return await hit.json(); } catch { /* fallthrough */ }
  }
  const row = await db.prepare(`SELECT ${SHARE_COLS} FROM share_links WHERE id = ?1`).bind(id).first();
  if (row) await cachePut(ck, json(row), 120);
  return row || null;
}

// ---------------- 分享会话 (密码换签名 Cookie) ----------------
// 分享密码不再进 URL: 首次输入 → POST /s/<id> 校验 → 换一个 HMAC 签名的短 TTL Cookie。
// 之后所有子资源(缩略图/图片/音频/视频/歌词/打包下载)只带 Cookie, URL 里不再出现密码。
//
// 为什么必须这么改: 密码进 URL 会落到访问日志、浏览器历史、Referer 和"复制链接"里;
// 而 share_links 只存 password hash, 没有改密入口 —— 密码一旦泄漏就无法轮换, 只能删掉分享重建。
const SESSION_TTL = 2 * 3600;   // 2 小时: 够连续浏览目录与播放, 又不至于长期驻留

function sessionCookieName(id) { return 'fm_s_' + id; }

async function makeSession(id, env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `s1:${id}:${exp}`;     // s1 = 分享会话 v1, 与 JWT 的用途隔离, 不可互换
  const sig = await signPayload(payload, env.JWT_SECRET);
  return `${exp}.${sig}`;
}

async function sessionOk(req, env, id) {
  const raw = cookieValue(req, sessionCookieName(id));
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const exp = parseInt(raw.slice(0, dot), 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return verifyPayload(`s1:${id}:${exp}`, raw.slice(dot + 1), env.JWT_SECRET);
}

// 解锁限流: 分享密码是用户自选的弱口令, 不限流就能被在线爆破 (与 login 同为尽力而为的内存实现)
const tries = new Map();
const TRY_MAX = 8;
const TRY_WINDOW = 5 * 60 * 1000;
const TRY_LOCK = 15 * 60 * 1000;
function tryKey(req, id) {
  const ip = (req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown')
    .split(',')[0].trim();
  return id + '|' + ip;
}
function tryLimited(k) {
  const e = tries.get(k);
  if (!e) return false;
  if (Date.now() - e.first > TRY_WINDOW + TRY_LOCK) { tries.delete(k); return false; }
  return e.count >= TRY_MAX;
}
function tryFail(k) {
  const e = tries.get(k);
  if (!e || Date.now() - e.first >= TRY_WINDOW) tries.set(k, { count: 1, first: Date.now() });
  else e.count++;
}

// POST /s/<id> — 用密码换签名会话 Cookie; 无密码分享直接放行 (不必发 Cookie)
export async function unlockShare(req, env, db, id) {
  const link = await getShareCached(db, id);
  if (!link) return jerr('分享链接不存在', 404);
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return jerr('链接已过期', 410);
  if (!link.password) return json({ ok: true });

  const k = tryKey(req, id);
  if (tryLimited(k)) return jerr('密码尝试过多，请稍后再试', 429);

  let body = null;
  try { body = await req.json(); } catch { /* 非法 JSON 按未提供密码处理 */ }
  const pwd = String((body && body.password) || '');
  if (!pwd) return jerr('请输入密码', 400);
  if (!(await verifyPassword(pwd, link.password))) { tryFail(k); return jerr('密码错误', 401); }

  tries.delete(k);
  const val = await makeSession(id, env);
  return json({ ok: true, expires_in: SESSION_TTL }, 200, {
    'Set-Cookie': cookieHeader(sessionCookieName(id), val, SESSION_TTL, `/s/${id}`, isSecureReq(req)),
  });
}

// ---------------- CRUD (需登录) ----------------
export async function createShare(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const rel = sanitizeRel(body.path || '');
  // 存在性校验 (根目录分享允许空路径)
  if (rel) {
    const node = await getNode(db, rel);
    if (!node) return jerr('Path not found', 404);
  }

  const id = randomId(16);
  const now = new Date().toISOString();
  const expiresAt = body.expire_hours
    ? new Date(Date.now() + Number(body.expire_hours) * 3600 * 1000).toISOString()
    : null;
  const hash = body.password ? await hashPassword(String(body.password)) : null;

  const res = await db.prepare(
    'INSERT INTO share_links (id, path, password, expires_at, created_at) VALUES (?1,?2,?3,?4,?5)',
  ).bind(id, rel || '.', hash, expiresAt, now).run();
  if (res.error) return jerr(`DB error: ${res.error}`, 500);

  const url = new URL(req.url);
  return json({ id, url: `${url.protocol}//${url.host}/s/${id}` });
}

export async function listShares(req, env, db) {
  const rows = await db.prepare(`SELECT ${SHARE_COLS} FROM share_links`).all();
  const shares = (rows.results || []).map((r) => ({
    id: r.id,
    path: r.path,
    has_password: !!r.password,
    expires_at: r.expires_at,
    created_at: r.created_at,
    access_count: r.access_count,
    last_accessed_at: r.last_accessed_at,
  }));
  return json({ shares });
}

export async function deleteShare(req, env, db, id) {
  const res = await db.prepare('DELETE FROM share_links WHERE id = ?1').bind(id).run();
  await cacheDel(`SM:${id}`);
  const meta = res.meta || {};
  if ((meta.changes || 0) > 0) return json({ deleted: true });
  return jerr('Share not found', 404);
}

// ---------------- 公开访问 /s/<id> ----------------
// 仅处理带动作参数的请求; 纯页面由 index.js 直接返回 share.html
export async function accessShare(req, env, db, id, url) {
  const q = url.searchParams;
  const link = await getShareCached(db, id);
  if (!link) return jerr('分享链接不存在', 404);

  // 过期检查
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return jerr('链接已过期', 410);
  }

  // 密码检查: 只认解锁时换来的签名 Cookie。URL 上的 password 参数已不再受理
  // (旧 ?password= 链接会落到 need_password, 页面重新弹密码框换会话)。
  if (link.password) {
    if (!(await sessionOk(req, env, id))) return json({ need_password: true, id });
  }

  // 访问计数节流: 同一分享 60s 内只写一次 D1
  const marker = await cacheGet(`SH:${id}`);
  if (!marker) {
    const now = new Date().toISOString();
    await db.prepare('UPDATE share_links SET access_count = access_count + 1, last_accessed_at = ?1 WHERE id = ?2').bind(now, id).run();
    await cachePut(`SH:${id}`, json({ t: now }), 60);
  }

  const basePath = sanitizeRel(link.path === '.' ? '' : link.path);

  // 解析目标 (支持目录内 sub_path / name 导航); sanitizeRel 已过滤 .., 防穿越
  function resolveWithin(sub, name) {
    let base = basePath;
    if (sub && sub !== '/') {
      const clean = sanitizeRel(sub);
      if (!clean) return null;
      base = base ? `${base}/${clean}` : clean;
    }
    if (name) {
      const n = sanitizeRel(name);
      if (!n || n.includes('/')) return null;
      base = base ? `${base}/${n}` : n;
    }
    return base;
  }

  const sub = q.get('sub_path');
  const name = q.get('name');
  const filePath = resolveWithin(sub, null);
  if (filePath === null) return jerr('无效的路径');
  const node = filePath ? await getNode(db, filePath) : { is_dir: 1, path: '', name: '', size: 0 };

  if (!node) {
    // 分享对象不存在 (或目录名不存在)
    if (sub || name) return jerr('无效的路径');
    return jerr('分享内容已被删除', 404);
  }

  // ---- 歌词 / 封面 (分享页播放器用; 与登录态同一份数据与链路) ----
  // 放最前面: 这两个不涉及字节流, 但都要先定位到目标文件(目录分享时按 name 下钻)。
  if (q.has('lyrics') || q.has('cover')) {
    const target = await resolveFileTarget();
    if (!target) return jerr('无效的文件');
    if (q.has('lyrics')) return shareLyrics(req, env, db, target, url);
    return shareCover(req, env, db, target, url);
  }

  // ---- 清晰度接口: Workers 不支持转码, 返回"仅原片" ----
  if (q.has('qualities')) {
    return json({ original: true, options: [] });
  }
  if (q.has('prepare')) {
    return jerr('Workers 环境不支持视频转码', 501);
  }
  if (q.has('quality') && q.get('download')) {
    // 原片直出 (与原版 download=1&quality= 行为对齐)
    return serveShareNode(req, env, db, node, true);
  }

  // ---- 目录打包下载 ----
  if (q.get('download') === 'zip' && node.is_dir) {
    const zipMax = parseInt(env.ZIP_MAX_TOTAL || '33554432', 10);
    const { entries, totalSize, overflow } = await collectZipEntries(env, db, node, zipMax);
    if (overflow) return jerr(`打包内容过大 (>${Math.floor(zipMax / 1024 / 1024)}MB)`, 413);
    const filename = `${node.name || 'share'}.zip`;
    return zipStreamResponse(entries, filename);
  }

  // ---- 缩略图 ----
  if (q.has('thumb')) {
    let target = node;
    if (node.is_dir && name) {
      const t = resolveWithin(null, name);
      if (!t) return jerr('无效的文件');
      target = await getNode(db, t);
      if (!target || target.is_dir) return jerr('无效的文件');
    } else if (node.is_dir) {
      return jerr('无效的文件');
    }
    if (!isImageName(target.name)) return jerr('缩略图不可用', 404);
    return serveFileContent(req, env, db, {
      key: 'f:' + target.path, size: target.size, mime: target.mime || mimeFromName(target.name),
      filename: target.name, inline: true, cacheTtl: 86400, cacheKeyPrefix: 'pub', nchunks: target.nchunks,
      db_id: target.db_id || 1,
    });
  }

  // 定位单文件目标: 目录分享时按 name 下钻, 其余就是分享对象本身
  async function resolveFileTarget() {
    let target = node;
    if (node.is_dir && name) {
      const t = resolveWithin(null, name);
      if (!t) return null;
      target = await getNode(db, t);
      if (!target || target.is_dir) return null;
    } else if (node.is_dir) {
      return null;
    }
    return target;
  }

  // ---- 内联预览 (图片 / 视频 / 音频 / PDF) ----
  // 与管理页 /api/preview 对齐: 内联展示必须回 inline 型 Content-Disposition,
  // 否则 Chrome 会把 iframe 里的 PDF 当附件下载, 表现为"能看却不给看"。
  if (q.has('inline')) {
    const target = await resolveFileTarget();
    if (!target) return jerr('无效的文件');
    return serveShareNode(req, env, db, target, true);
  }

  // ---- 下载单文件 ----
  if (q.has('download') && q.get('download') !== 'zip') {
    const target = await resolveFileTarget();
    if (!target) return jerr('无效的文件');
    return serveShareNode(req, env, db, target, false);
  }

  // ---- 数据模式 ----
  if (node.is_dir) {
    const { listDirRows } = await import('./vfs.js');
    const rows = await listDirRows(db, node.path);
    return json({
      type: 'directory',
      name: node.name || '',
      path: link.path,
      entries: rows.map((r) => ({ name: r.name, is_dir: !!r.is_dir, size: r.is_dir ? 0 : r.size })),
    });
  }
  return json({
    type: 'file',
    name: node.name,
    path: link.path,
    size: node.size,
    mime: node.mime || mimeFromName(node.name),
    ext: (node.name.split('.').pop() || '').toLowerCase(),
  });
}

async function serveShareNode(req, env, db, node, inline) {
  return serveFileContent(req, env, db, {
    key: 'f:' + node.path, size: node.size, mime: node.mime || mimeFromName(node.name),
    filename: node.name, inline, cacheTtl: 300, cacheKeyPrefix: 'share', nchunks: node.nchunks,
    db_id: node.db_id || 1,
  });
}
