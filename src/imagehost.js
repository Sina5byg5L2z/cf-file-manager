// ============================================================================
// imagehost.js — 图床 (对应原版 routes/image_host.rs)
// 存储: image_host(元数据) + 按 src_path 区分两种归属
//   - src_path IS NULL  → 自持: blobs key='i:<filename>' (直传上传的条目)
//   - src_path NOT NULL → 引用: 零拷贝, 字节仍是文件管理的 'f:<src_path>'
// 降耗: 自持条目文件名不可变 → 边缘缓存 1 年 + immutable, 二次访问 0 D1 读;
//       引用条目内容随源文件变, 只能短缓存, 源变更(改名/覆盖/删除)时主动失效。
// ============================================================================

import {
  json, jerr, sanitizeFilename, fileExt, mimeFromName,
  cacheGet, cachePut, cacheDel, randomId,
} from './util.js';
import { serveFileContent, writeBlob, invalidateIhCache, invalidateIhList, buildUploadResponse } from './vfs.js';
import { dbById, pickDb, capacityResponse, bumpUsage } from './storage.js';

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

  // 选库: 图床自持条目的字节同样落在 blobs 里, 一样受分库管辖
  const picked = await pickDb(env, db, data.length);
  if (!picked.ok) return capacityResponse(db, data.length, picked);
  const vdb = picked.db;
  const nchunks = await writeBlob(vdb, 'i:' + filename, data);
  const now = new Date().toISOString();
  const res = await db.prepare('INSERT INTO image_host (filename, original_name, mime_type, size, upload_time, db_id) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(filename, origName, mime, data.length, now, picked.row.id).run();
  if (res.error) {
    await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('i:' + filename).run();
    return jerr(`数据库错误: ${res.error}`, 500);
  }
  await bumpUsage(db, picked.row.id, data.length);
  await invalidateIhList();   // 新条目要立即出现在列表里 (列表缓存 30s)
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
  // 图床文件名随机生成, 同源文件重复上传会各自成一份 (不做跨会话续传匹配):
  // 图床场景通常是小文件, 断点续传价值有限; 但仍支持"同一页面内重试不重传"。
  const target = generateFilename(ext); // 与原版不同: 合并时才定名, 这里提前定名以直写暂存
  const id = randomId(12);
  const now = Date.now();
  const fileSize = parseInt(body.file_size, 10) || 0;
  const chunkSize = parseInt(body.chunk_size, 10) || 0;
  // 与文件上传同样「钉库」: 暂存分片与最终键必须同库, 合并才不跨库 (I2)
  const need = fileSize + 32 * (chunkSize || 1048576);
  const picked = await pickDb(env, db, need);
  if (!picked.ok) return capacityResponse(db, need, picked);
  await db.prepare('INSERT INTO upload_sessions (id, kind, target, filename, total_chunks, mime, file_size, file_key, chunk_size, created_at, updated_at, db_id) VALUES (?1,\'image\',?2,?3,?4,?5,?6,\'\',?7,?8,?8,?9)')
    .bind(id, target, filename, total, mime, fileSize, chunkSize, now, picked.row.id).run();
  return json({ upload_id: id, total_chunks: total, resumed: false, received: [], hashes: [], db_id: picked.row.id });
}

// 分片上传 chunk/complete 与文件管理器共用同一实现 (vfs.js), 由路由按 kind 分发

// ---------------- 从文件管理器导入 (零拷贝引用) ----------------
// 不复制字节: 只写一行元数据, src_path 指向文件管理里的原文件。
// 一份字节两个入口 —— /f 走文件管理器, /i 走图床直链。
// 源文件的生命周期由 vfs.js 维护:
//   删除 → 拒绝(前置校验, 提示先删图床条目)
//   改名/移动 → 同步改写 src_path
//   覆盖上传 → 直链跟随更新, 并失效图床缓存
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
  try {
    await db.prepare(
      'INSERT INTO image_host (filename, original_name, mime_type, size, upload_time, src_path, db_id) VALUES (?1,?2,?3,?4,?5,?6,?7)',
    ).bind(filename, node.name, mime, node.size, new Date().toISOString(), node.path, node.db_id || 1).run();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Exceeded maximum DB size|7500/i.test(msg)) {
      return jerr('图床空间不足：D1 数据库已达存储上限，请先清理数据', 507);
    }
    return jerr(`图床写入失败: ${msg}`, 500);
  }
  await invalidateIhList();   // 新条目要立即出现在列表里 (列表缓存 30s)
  return buildUploadResponse(req, filename, node.name, mime);
}

// ---------------- 公开访问 /i/<filename> ----------------
export async function serveImage(req, env, db, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return jerr('无效文件名');
  }
  // 元数据走边缘缓存 5 分钟; 自持条目内容不可变 → 缓存 1 年
  let meta = null;
  const ck = `IH:${filename}`;
  const hit = await cacheGet(ck);
  if (hit) meta = await hit.json();
  if (!meta) {
    meta = await db.prepare('SELECT filename, mime_type, size, src_path, db_id FROM image_host WHERE filename = ?1').bind(filename).first();
    if (meta) await cachePut(ck, json(meta), 300);
  }
  if (!meta) {
    return json({ error: '文件不存在' }, 404, { 'Access-Control-Allow-Origin': '*' });
  }

  // 引用型: 字节在文件管理的 'f:<src_path>'。size/nchunks 实时从 fs_nodes 取,
  // 覆盖上传改了大小也不会读到过期元数据。缓存必须短 + 非 immutable:
  // 内容会随源文件变化, 无法承诺"同名同内容"。
  if (meta.src_path) {
    // 引用型: 字节归源文件所有 → 路由看源文件的 db_id
    const src = await db.prepare('SELECT size, mime, nchunks, db_id FROM fs_nodes WHERE path = ?1 AND is_dir = 0')
      .bind(meta.src_path).first();
    if (!src) {
      // 正常路径下删除源文件已被拒绝, 这里只是兜底(如历史数据/直连 DB 改动)
      return json({ error: '源文件已不存在' }, 404, { 'Access-Control-Allow-Origin': '*' });
    }
    return serveFileContent(req, env, db, {
      key: 'f:' + meta.src_path, size: src.size, mime: src.mime || meta.mime_type,
      filename, nchunks: src.nchunks, db_id: src.db_id || 1,
      inline: true, cacheTtl: 300, immutable: false, cacheKeyPrefix: 'pub',
    });
  }

  return serveFileContent(req, env, db, {
    key: 'i:' + filename, size: meta.size, mime: meta.mime_type,
    filename, inline: true, cacheTtl: 31536000, immutable: true, cacheKeyPrefix: 'pub',
    db_id: meta.db_id || 1,
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
    `SELECT filename, original_name, mime_type, size, upload_time, src_path, db_id FROM image_host ${where} ORDER BY upload_time DESC LIMIT ?${search ? 2 : 1} OFFSET ?${search ? 3 : 2}`,
  ).bind(...binds, pageSize, offset).all();
  const res = json({ items: rows.results || [], total: totalRow.c, page, page_size: pageSize });
  await cachePut(ck, res.clone(), 30);
  return res;
}

// ---------------- 删除 ----------------
// 引用型: 只删元数据行, 源文件与其字节完全不动 (删的是"图床入口", 不是文件)。
// 自持型: 连 i:<filename> 的字节一起删。
export async function deleteImage(req, env, db, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return jerr('无效文件名');
  }
  const meta = await db.prepare('SELECT src_path, size, db_id FROM image_host WHERE filename = ?1').bind(filename).first();
  const refKey = meta && meta.src_path ? 'f:' + meta.src_path : 'i:' + filename;

  // I5: 元数据先删 (此后直链即 404), 字节后删
  await db.prepare('DELETE FROM image_host WHERE filename = ?1').bind(filename).run();
  if (!meta || !meta.src_path) {
    const vdb = dbById(env, (meta && meta.db_id) || 1) || db;
    await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('i:' + filename).run();
    if (meta) await bumpUsage(db, meta.db_id || 1, -(meta.size || 0));
  }

  // 内容缓存键含 size; 有元数据时按实际 size 精确删除
  await invalidateIhCache(filename, meta ? [`F:pub:${refKey}:${meta.size}`] : []);
  // 失效列表缓存 (页数未知, 刷常见前几页)
  await Promise.all([1, 2, 3].flatMap((p) => [24, 100].map((ps) => cacheDel(`IL:${p}:${ps}:`))));
  return json({ success: true, referenced: !!(meta && meta.src_path) });
}
