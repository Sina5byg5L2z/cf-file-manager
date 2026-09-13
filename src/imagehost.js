// ============================================================================
// imagehost.js — 图床 (对应原版 routes/image_host.rs)
// 存储: image_host(元数据) + blobs(key='i:<filename>')
// 降耗: /i/<filename> 文件名不可变 → 边缘缓存 1 年 + immutable,
//       二次访问 0 D1 读、浏览器也不再回源; 删除时主动失效
// ============================================================================

import {
  json, jerr, sanitizeFilename, fileExt, mimeFromName,
  cacheGet, cachePut, cacheDel, randomId,
} from './util.js';
import { serveFileContent, writeBlob, invalidateIhCache, buildUploadResponse } from './vfs.js';

const ALLOWED = (mime) => mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf';

function generateFilename(ext) {
  const id = randomId(16);
  return ext ? `${id}.${ext}` : id;
}

// ---------------- 简单上传 ----------------
export async function upload(req, env, db) {
  let form;
  try { form = await req.formData(); } catch { return jerr('multipart 解析失败'); }
  const fileField = [...form.values()].find((v) => typeof v !== 'string');
  if (!fileField) return jerr('未提供文件');

  const origName = fileField.name || 'upload';
  const mime = mimeFromName(origName);
  if (!ALLOWED(mime)) return jerr('不支持的文件类型，仅支持图片、视频、音频和 PDF');

  const ext = fileExt(origName);
  const filename = generateFilename(ext);
  const data = new Uint8Array(await fileField.arrayBuffer());
  const max = parseInt(env.MAX_UPLOAD_SIZE || '209715200', 10);
  if (data.length > max) return jerr(`文件超过最大上传限制 (${Math.floor(max / 1024 / 1024)}MB)`, 413);

  const nchunks = await writeBlob(db, 'i:' + filename, data);
  const now = new Date().toISOString();
  const res = await db.prepare('INSERT INTO image_host (filename, original_name, mime_type, size, upload_time) VALUES (?1,?2,?3,?4,?5)')
    .bind(filename, origName, mime, data.length, now).run();
  if (res.error) {
    await db.prepare('DELETE FROM blobs WHERE key = ?1').bind('i:' + filename).run();
    return jerr(`数据库错误: ${res.error}`, 500);
  }
  return buildUploadResponse(req, filename, origName, mime);
}

// ---------------- 分片上传 ----------------
export async function uploadInit(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const total = parseInt(body.total_chunks, 10);
  if (!Number.isFinite(total) || total <= 0 || total > 10000) return jerr('无效的分片数量');
  const filename = sanitizeFilename(body.filename || 'upload');
  const mime = mimeFromName(filename);
  if (!ALLOWED(mime)) return jerr('不支持的文件类型，仅支持图片、视频、音频和 PDF');
  const ext = fileExt(filename);
  const target = generateFilename(ext); // 与原版不同: 合并时才定名, 这里提前定名以直写暂存
  const id = randomId(12);
  await db.prepare('INSERT INTO upload_sessions (id, kind, target, filename, total_chunks, mime, created_at) VALUES (?1,\'image\',?2,?3,?4,?5,?6)')
    .bind(id, target, filename, total, mime, Date.now()).run();
  return json({ upload_id: id, total_chunks: total });
}

// 分片上传 chunk/complete 与文件管理器共用同一实现 (vfs.js), 由路由按 kind 分发

// ---------------- 从文件管理器导入 ----------------
export async function importFromFiles(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const { getNode } = await import('./vfs.js');
  const node = await getNode(db, body.path || '');
  if (!node || node.is_dir) return jerr('文件不存在');

  const mime = node.mime || mimeFromName(node.name);
  if (!ALLOWED(mime)) return jerr('不支持的文件类型，仅支持图片、视频、音频和 PDF');

  const ext = fileExt(node.name);
  const filename = generateFilename(ext);
  // 服务端复制: 单条 INSERT..SELECT, 不经浏览器
  await db.batch([
    db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('f:' + node.path, 'i:' + filename),
    db.prepare('INSERT INTO image_host (filename, original_name, mime_type, size, upload_time) VALUES (?1,?2,?3,?4,?5)')
      .bind(filename, node.name, mime, node.size, new Date().toISOString()),
  ]);
  return buildUploadResponse(req, filename, node.name, mime);
}

// ---------------- 公开访问 /i/<filename> ----------------
export async function serveImage(req, env, db, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return jerr('无效文件名');
  }
  // 元数据走边缘缓存 5 分钟; 文件体不可变 → 缓存 1 年
  let meta = null;
  const ck = `IH:${filename}`;
  const hit = await cacheGet(ck);
  if (hit) meta = await hit.json();
  if (!meta) {
    meta = await db.prepare('SELECT filename, mime_type, size FROM image_host WHERE filename = ?1').bind(filename).first();
    if (meta) await cachePut(ck, json(meta), 300);
  }
  if (!meta) {
    return json({ error: '文件不存在' }, 404, { 'Access-Control-Allow-Origin': '*' });
  }
  return serveFileContent(req, env, db, {
    key: 'i:' + filename, size: meta.size, mime: meta.mime_type,
    filename, inline: true, cacheTtl: 31536000, immutable: true, cacheKeyPrefix: 'pub',
  });
}

// ---------------- 列表 ----------------
export async function list(req, env, db, url) {
  const q = url.searchParams;
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.get('page_size') || '24', 10) || 24));
  const search = q.get('search') || '';

  // 列表页缓存 30s (搜索词参与键); 失效由上传/删除触发
  const ck = `IL:${page}:${pageSize}:${search}`;
  const hit = await cacheGet(ck);
  if (hit) return hit;

  const offset = (page - 1) * pageSize;
  const where = search ? 'WHERE original_name LIKE ?1' : '';
  const binds = search ? [`%${search.replace(/([%_\\])/g, '\\$1')}%`] : [];
  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM image_host ${where}`).bind(...binds).first();
  const rows = await db.prepare(
    `SELECT filename, original_name, mime_type, size, upload_time FROM image_host ${where} ORDER BY upload_time DESC LIMIT ?${search ? 2 : 1} OFFSET ?${search ? 3 : 2}`,
  ).bind(...binds, pageSize, offset).all();
  const res = json({ items: rows.results || [], total: totalRow.c, page, page_size: pageSize });
  await cachePut(ck, res.clone(), 30);
  return res;
}

// ---------------- 删除 ----------------
export async function deleteImage(req, env, db, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return jerr('无效文件名');
  }
  await db.batch([
    db.prepare('DELETE FROM blobs WHERE key = ?1').bind('i:' + filename),
    db.prepare('DELETE FROM image_host WHERE filename = ?1').bind(filename),
  ]);
  await invalidateIhCache(filename);
  // 失效列表缓存 (页数未知, 刷常见前几页)
  await Promise.all([1, 2, 3].flatMap((p) => [24, 100].map((ps) => cacheDel(`IL:${p}:${ps}:`))));
  return json({ success: true });
}
