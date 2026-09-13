// ============================================================================
// vfs.js — D1 虚拟文件系统 (对应原版 routes/files.rs + preview.rs + search.rs)
// 存储模型: fs_nodes(元数据) + blobs(1MB 分片, key='f:<path>')
// 降耗策略:
//   - 目录列表走边缘缓存 60s, 写操作主动失效 (同 colo 立即生效)
//   - 私有文件响应走边缘缓存 (key 含 mtime, 内容变更自动换键), 命中 0 次 blob 读
//   - 大文件/Range 直读分片, 每次 Range 只读覆盖区间的分片行
// ============================================================================

import {
  CHUNK_SIZE, CACHE_MAX_FILE, deriveChunkSize, chunkCount, json, jerr, sanitizeRel, sanitizeFilename, splitPath,
  mimeFromName, fileExt, isTextName, isImageName, isVideoName, isPdfName,
  contentDisposition, encodeFilename, parseRange, cacheGet, cachePut, cacheDel,
  blobStream, crcOfStream, zipStream, randomId,
} from './util.js';
import { validateToken } from './auth.js';

// ---------------- 元数据访问 ----------------
const NODE_COLS = 'path, parent, name, is_dir, size, mime, created_at, modified_at, nchunks';

export async function getNode(db, path) {
  const clean = sanitizeRel(path);
  if (!clean) return null;
  const row = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE path = ?1`).bind(clean).first();
  return row || null;
}

async function dirExists(db, path) {
  if (!sanitizeRel(path)) return true; // 根
  const row = await db.prepare('SELECT is_dir FROM fs_nodes WHERE path = ?1').bind(sanitizeRel(path)).first();
  return !!(row && row.is_dir);
}

// 列表缓存失效 (排序由前端完成, 每目录单一缓存键)
async function invalidateDir(db, dirPath) {
  await cacheDel(`L:${sanitizeRel(dirPath)}`);
}

// 文件内容缓存失效 (同路径同尺寸覆盖写时防止旧内容命中)
export async function invalidateFileCache(path, size) {
  const k = 'f:' + sanitizeRel(path);
  await Promise.all([
    cacheDel(`F:priv:${k}:${size}`),
    cacheDel(`F:thumb:${k}:${size}`),
    cacheDel(`F:share:${k}:${size}`),
    cacheDel(`F:dav:${k}:${size}`),
  ]);
}

// ---------------- 列表 ----------------
export async function listFiles(req, env, db, url) {
  const rel = sanitizeRel(url.searchParams.get('path') || '');
  if (!(await dirExists(db, rel))) return jerr('不是目录', 400);

  // 边缘缓存 (写操作会失效); 整目录返回(≤1000条), 排序/过滤/分页均由前端完成
  const ck = `L:${rel}`;
  let data;
  const hit = await cacheGet(ck);
  if (hit) {
    data = await hit.json();
  } else {
    // 整目录一次取全 (≤5000), 无静默截断; 排序/过滤/分页由前端完成
    // 上限是防御值: 目录行数 = D1 行读, 5000 行 × 60s 缓存对免费额度安全
    const rows = await db.prepare(
      `SELECT ${NODE_COLS} FROM fs_nodes WHERE parent = ?1 ORDER BY is_dir DESC, name COLLATE NOCASE ASC LIMIT 5000`,
    ).bind(rel).all();
    data = { path: rel, entries: (rows.results || []).map(nodeToEntry) };
    await cachePut(ck, json(data), 60);
  }
  return json(data);
}

function nodeToEntry(n) {
  return {
    name: n.name,
    is_dir: !!n.is_dir,
    size: n.is_dir ? 0 : n.size,
    modified: n.modified_at,
    ext: n.is_dir ? '' : fileExt(n.name),
    mime: n.is_dir ? 'directory' : (n.mime || mimeFromName(n.name)),
  };
}

// ---------------- mkdir / rename / move / copy / delete ----------------
export async function mkdir(req, env, db, url) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const parent = sanitizeRel(body.path || '');
  const name = sanitizeFilename(body.name || '');
  if (!name || name === 'upload') return jerr('无效的目录名');
  if (!(await dirExists(db, parent))) return jerr('目标不是目录', 400);
  const p = splitPath(`${parent}/${name}`);
  const now = new Date().toISOString();
  // 本地 D1 冲突时抛异常, 远端 D1 返回 res.error — 两种都处理
  try {
    await db.prepare(
      'INSERT INTO fs_nodes (path, parent, name, is_dir, size, mime, created_at, modified_at) VALUES (?1,?2,?3,1,0,\'directory\',?4,?4)',
    ).bind(p.path, p.parent, p.name, now).run();
  } catch (e) {
    return jerr('目录已存在', 409);
  }
  await invalidateDir(db, parent);
  return json({ created: body.name });
}

// 递归收集子树所有 blob key 并删除 (单条子查询完成, 避免逐行)
// t: 前缀是前端生成的缩略图 blob, 必须在 fs_nodes 删除前一并清理
async function deleteSubtree(db, path) {
  const clean = sanitizeRel(path);
  const stmts = [
    db.prepare('DELETE FROM blobs WHERE key IN (SELECT \'f:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(clean),
    db.prepare('DELETE FROM blobs WHERE key IN (SELECT \'t:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(clean),
    db.prepare('DELETE FROM fs_nodes WHERE path = ?1 OR path LIKE ?1 || \'/%\'').bind(clean),
  ];
  await db.batch(stmts);
}

export async function deleteFile(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('无法删除根目录');
  const node = await getNode(db, path);
  if (!node) return jerr('文件不存在', 404);
  await deleteSubtree(db, path);
  await invalidateFileCache(path, node.size);
  await invalidateDir(db, node.parent);
  return json({ deleted: path });
}

export async function batchDelete(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const deleted = [];
  const errors = [];
  const parents = new Set();
  for (const raw of paths) {
    const path = sanitizeRel(raw);
    if (!path) { errors.push(`${raw}: invalid path`); continue; }
    const node = await getNode(db, path);
    if (!node) { errors.push(`${path}: not found`); continue; }
    await deleteSubtree(db, path);
    await invalidateFileCache(path, node.size);
    parents.add(node.parent);
    deleted.push(path);
  }
  await Promise.all([...parents].map((p) => invalidateDir(db, p)));
  return json({ deleted, errors });
}

// 移动/重命名共用: 重写子树 path/parent 与对应 blob key
export async function moveNode(db, fromPath, toDir, newName) {
  const from = sanitizeRel(fromPath);
  const node = await getNode(db, from);
  if (!node) return { error: '源不存在', status: 404 };
  const dstDir = sanitizeRel(toDir);
  if (!(await dirExists(db, dstDir))) return { error: '目标不是目录', status: 400 };
  const name = sanitizeFilename(newName || node.name);
  const sp = splitPath(`${dstDir}/${name}`);
  if (sp.path === from) return { ok: true };
  if (node.is_dir && (sp.path === from || sp.path.startsWith(from + '/'))) return { error: '不能移动到自身内部', status: 400 };
  if (await getNode(db, sp.path)) return { error: '目标已存在', status: 409 };

  const offN = from.length + 1; // fs_nodes: 剥离 'from' 前缀
  const offB = from.length + 3; // blobs: 剥离 'f:' + 'from' 前缀
  const now = new Date().toISOString();
  if (node.is_dir) {
    await db.batch([
      db.prepare('UPDATE blobs SET key = \'f:\' || ?2 || substr(key, ?3) WHERE key IN (SELECT \'f:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(from, sp.path, offB),
      db.prepare('UPDATE blobs SET key = \'t:\' || ?2 || substr(key, ?3) WHERE key IN (SELECT \'t:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(from, sp.path, offB),
      db.prepare('UPDATE fs_nodes SET path = ?2 || substr(path, ?3), parent = CASE WHEN path = ?1 THEN ?4 ELSE ?2 || substr(parent, ?3) END, modified_at = ?5 WHERE path = ?1 OR path LIKE ?1 || \'/%\'').bind(from, sp.path, offN, sp.parent, now),
    ]);
  } else {
    await db.batch([
      db.prepare('UPDATE blobs SET key = ?2 WHERE key = ?1').bind('f:' + from, 'f:' + sp.path),
      db.prepare('UPDATE blobs SET key = ?2 WHERE key = ?1').bind('t:' + from, 't:' + sp.path),
      db.prepare('UPDATE fs_nodes SET path = ?2, parent = ?3, name = ?4, modified_at = ?5 WHERE path = ?1').bind(from, sp.path, sp.parent, name, now),
    ]);
  }
  await invalidateDir(db, node.parent);
  await invalidateDir(db, sp.parent);
  return { ok: true };
}

export async function rename(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const node = await getNode(db, body.path || '');
  if (!node) return jerr('文件不存在', 404);
  const r = await moveNode(db, body.path, node.parent, body.new_name);
  if (r.error) return jerr(r.error, r.status);
  return json({ renamed: body.new_name });
}

export async function moveFile(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const r = await moveNode(db, body.from, body.to, null);
  if (r.error) return jerr(r.error, r.status);
  return json({ moved: body.from, to: body.to });
}

export async function copyFile(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const from = sanitizeRel(body.from || '');
  const node = await getNode(db, from);
  if (!node) return jerr('源不存在', 404);
  const dstDir = sanitizeRel(body.to || '');
  if (!(await dirExists(db, dstDir))) return jerr('目标不是目录', 400);
  const sp = splitPath(`${dstDir}/${node.name}`);
  if (sp.path === from) return jerr('源与目标相同');
  if (node.is_dir && sp.path.startsWith(from + '/')) return jerr('不能复制到自身内部');
  if (await getNode(db, sp.path)) return jerr('目标已存在', 409);

  if (node.is_dir) {
    // 复制整棵子树: 元数据行 + 每个文件的 blob 拷贝语句
    const sub = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE path = ?1 OR path LIKE ?1 || '/%'`).bind(from).all();
    const rows = sub.results || [];
    const off = from.length;
    const stmts = [];
    for (const r of rows) {
      const np = sp.path + r.path.slice(off);
      const npParent = r.path === from ? sp.parent : sp.path + r.parent.slice(off);
      const nName = r.path === from ? sp.name : r.name;
      stmts.push(db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
        .bind(np, npParent, nName, r.is_dir, r.size, r.mime, r.created_at, new Date().toISOString(), r.nchunks));
      if (!r.is_dir) {
        stmts.push(db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?, idx, data FROM blobs WHERE key = ?').bind('f:' + np, 'f:' + r.path));
        stmts.push(db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?, idx, data FROM blobs WHERE key = ?').bind('t:' + np, 't:' + r.path));
      }
    }
    await db.batch(stmts);
  } else {
    await db.batch([
      db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('f:' + from, 'f:' + sp.path),
      db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('t:' + from, 't:' + sp.path),
      db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7)')
        .bind(sp.path, sp.parent, sp.name, node.size, node.mime, new Date().toISOString(), node.nchunks),
    ]);
  }
  await invalidateDir(db, sp.parent);
  return json({ copied: body.from, to: body.to });
}

// ---------------- blob 写入助手 ----------------
// 将完整字节流写入 blobs (自动按 1MB 分片), 返回分片数
export async function writeBlob(db, key, data) {
  const stmts = [];
  for (let i = 0, off = 0; off < data.length || i === 0; i++, off += CHUNK_SIZE) {
    const slice = data.subarray(off, Math.min(off + CHUNK_SIZE, data.length));
    stmts.push(db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1, ?2, ?3)').bind(key, i, slice));
    if (off + CHUNK_SIZE > data.length) break;
  }
  await db.batch(stmts);
  return Math.ceil(data.length / CHUNK_SIZE) || 1;
}

async function upsertFileNode(db, path, size, mime, nchunks) {
  const sp = splitPath(path);
  const now = new Date().toISOString();
  await db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7)')
    .bind(sp.path, sp.parent, sp.name, size, mime, now, nchunks).run();
}

// 逐级补齐缺失的祖先目录 (WebDAV MKCOL/PUT 需要自动建目录)
export async function ensureDirs(db, dirPath) {
  const parts = sanitizeRel(dirPath).split('/').filter(Boolean);
  let cur = '';
  const now = new Date().toISOString();
  for (const part of parts) {
    const parent = cur;
    cur = cur ? `${cur}/${part}` : part;
    await db.prepare('INSERT OR IGNORE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at) VALUES (?1,?2,?3,1,0,\'directory\',?4,?4)')
      .bind(cur, parent, part, now).run();
  }
  return cur;
}

// ---------------- 简单上传 (multipart, 多文件) ----------------
export async function uploadFile(req, env, db, url) {
  const max = parseInt(env.MAX_UPLOAD_SIZE || '209715200', 10);
  const cl = parseInt(req.headers.get('Content-Length') || '0', 10);
  // formData 会整体驻留内存; 超大文件请走分片上传接口
  if (cl > 64 * 1024 * 1024) return jerr('文件过大，请使用分片上传', 413);

  const dir = sanitizeRel(url.searchParams.get('path') || '');
  if (!(await dirExists(db, dir))) return jerr('目标不是目录', 400);

  let form;
  try { form = await req.formData(); } catch { return jerr('multipart 解析失败'); }
  const uploaded = [];
  const parents = new Set([dir]);
  for (const [, value] of form.entries()) {
    if (typeof value === 'string') continue;
    const name = sanitizeFilename(value.name || 'upload');
    if (value.size > max) return jerr(`文件超过最大上传限制 (${Math.floor(max / 1024 / 1024)}MB)`, 413);
    const sp = splitPath(`${dir}/${name}`);
    const old = await getNode(db, sp.path);
    const data = new Uint8Array(await value.arrayBuffer());
    // 覆盖写时内容已变, 旧缩略图作废
    await db.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + sp.path).run();
    const n = await writeBlob(db, 'f:' + sp.path, data);
    await upsertFileNode(db, sp.path, data.length, mimeFromName(name), n);
    if (old && !old.is_dir) await invalidateFileCache(sp.path, old.size);
    uploaded.push(name);
  }
  for (const p of parents) await invalidateDir(db, p);
  return json({ uploaded });
}

// ---------------- 分片上传 ----------------
export async function uploadInit(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const total = parseInt(body.total_chunks, 10);
  if (!Number.isFinite(total) || total <= 0 || total > 10000) return jerr('无效的分片数量');
  const dir = sanitizeRel(body.path || '');
  if (!(await dirExists(db, dir))) return jerr('目标不是目录', 400);
  const filename = sanitizeFilename(body.filename || 'upload');
  const target = splitPath(`${dir}/${filename}`).path;
  const id = randomId(12);
  await db.prepare('INSERT INTO upload_sessions (id, kind, target, filename, total_chunks, mime, created_at) VALUES (?1,\'file\',?2,?3,?4,\'\',?5)')
    .bind(id, target, filename, total, Date.now()).run();
  return json({ upload_id: id, total_chunks: total });
}

export async function uploadChunk(req, env, db) {
  let form;
  try { form = await req.formData(); } catch { return jerr('multipart 解析失败'); }
  const uploadId = form.get('upload_id');
  const idx = parseInt(form.get('chunk_index'), 10);
  const dataField = [...form.values()].find((v) => typeof v !== 'string');
  if (!uploadId || !Number.isFinite(idx) || !dataField) return jerr('缺少 upload_id 或数据');

  const session = await db.prepare('SELECT total_chunks FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return jerr('上传会话不存在', 404);
  if (idx < 0 || idx >= session.total_chunks) return jerr('分片索引超出范围');
  const data = new Uint8Array(await dataField.arrayBuffer());
  if (data.length > 2 * 1024 * 1024) return jerr('分片过大');

  await db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1, ?2, ?3)').bind('u:' + uploadId, idx, data).run();
  const c = await db.prepare('SELECT COUNT(*) AS c FROM blobs WHERE key = ?1').bind('u:' + uploadId).first();
  return json({ chunk_index: idx, received: c.c, total: session.total_chunks });
}

export async function uploadComplete(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const uploadId = body.upload_id;
  if (!uploadId) return jerr('缺少 upload_id');

  const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return jerr('上传会话不存在', 404);
  const old = session.kind === 'file' ? await getNode(db, session.target) : null;

  const present = await db.prepare('SELECT idx FROM blobs WHERE key = ?1 ORDER BY idx').bind('u:' + uploadId).all();
  const idxs = new Set((present.results || []).map((r) => r.idx));
  const missing = [];
  for (let i = 0; i < session.total_chunks; i++) if (!idxs.has(i)) missing.push(i);
  if (missing.length) return json({ error: '缺失分片', missing }, 400);

  // 在暂存键上统计真实字节数 (只读长度, 不拉数据)
  const sizeRow = await db.prepare('SELECT COALESCE(SUM(LENGTH(data)),0) AS s, COUNT(*) AS c FROM blobs WHERE key = ?1').bind('u:' + uploadId).first();
  const size = sizeRow.s;
  const max = parseInt(env.MAX_UPLOAD_SIZE || '209715200', 10);
  if (size > max) {
    await db.batch([
      db.prepare('DELETE FROM blobs WHERE key = ?1').bind('u:' + uploadId),
      db.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(uploadId),
    ]);
    return jerr(`文件超过最大上传限制 (${Math.floor(max / 1024 / 1024)}MB)`, 413);
  }

  const stageKey = 'u:' + uploadId;
  const finalKey = session.kind === 'image' ? 'i:' + session.target : 'f:' + session.target;
  const now = new Date().toISOString();
  const stmts = [
    db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind(stageKey, finalKey),
    db.prepare('DELETE FROM blobs WHERE key = ?1').bind(stageKey),
    db.prepare('DELETE FROM blobs WHERE key = ?1 AND idx >= ?2').bind(finalKey, session.total_chunks),
    // 覆盖上传时内容已变, 旧缩略图作废 (新缩略图由前端生成后回写)
    db.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + session.target),
  ];
  if (session.kind === 'image') {
    stmts.push(db.prepare('INSERT OR REPLACE INTO image_host (filename, original_name, mime_type, size, upload_time) VALUES (?1,?2,?3,?4,?5)')
      .bind(session.target, session.filename, session.mime || mimeFromName(session.filename), size, now));
  } else {
    const sp = splitPath(session.target);
    stmts.push(db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7)')
      .bind(sp.path, sp.parent, sp.name, size, mimeFromName(session.filename), now, session.total_chunks));
  }
  stmts.push(db.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(uploadId));
  await db.batch(stmts);

  if (session.kind === 'image') {
    await invalidateIhCache(session.target);
    return buildUploadResponse(req, session.target, session.filename, session.mime || mimeFromName(session.filename));
  }
  const sp = splitPath(session.target);
  if (old && !old.is_dir) await invalidateFileCache(session.target, old.size);
  await invalidateDir(db, sp.parent);
  return json({ filename: session.filename, path: session.target });
}

// ---------------- 公共文件响应 (Range + 边缘缓存), 供 vfs/图床/分享复用 ----------------
export async function serveFileContent(req, env, db, opts) {
  // opts: {key, size, mime, filename, inline, cacheTtl, immutable, cacheKeyPrefix}
  const { key, size, mime, filename } = opts;
  const disposition = contentDisposition(opts.inline ? 'inline' : 'attachment', filename);
  const baseHeaders = {
    'Content-Type': mime,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };

  const range = parseRange(req.headers.get('Range'), size);

  // 免费版 10ms CPU: Range 窗口封顶 (浏览器播放器按 Content-Range 自动链式续传后续窗口)
  const RANGE_MAX = Math.max(CHUNK_SIZE, parseInt(env.RANGE_MAX || '524288', 10));
  if (range && range !== 'unsatisfiable' && range.end - range.start + 1 > RANGE_MAX) {
    range.end = range.start + RANGE_MAX - 1;
  }

  // 尝试边缘缓存 (仅整文件且体积允许)
  let cacheHit = null;
  if (!range && opts.cacheTtl && size <= CACHE_MAX_FILE) {
    cacheHit = await cacheGet(`F:${opts.cacheKeyPrefix || ''}:${key}:${size}`);
  }
  if (cacheHit) {
    const h = new Headers(baseHeaders);
    h.set('Cache-Control', opts.immutable ? 'public, max-age=31536000, immutable' : `private, max-age=${opts.cacheTtl}`);
    return new Response(cacheHit.body, { status: 200, headers: h });
  }

  if (range === 'unsatisfiable') {
    return new Response(JSON.stringify({ error: '请求范围不符合文件大小' }), {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Content-Type': 'application/json' },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  const headers = new Headers(baseHeaders);
  headers.set('Content-Length', String(length));
  headers.set('Cache-Control',
    opts.immutable ? 'public, max-age=31536000, immutable' : `private, max-age=${opts.cacheTtl || 0}`);
  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  // 分片大小: 由元数据 nchunks 推导 (多分片文件); nchunks 缺失时按 blobs 计数兜底
  // 注意不能用常量: 分片上传的真实分片大小随前端自适应变化 (256KB/128KB/...)
  let cs = CHUNK_SIZE;
  if (opts.nchunks != null) {
    if (opts.nchunks > 1) cs = deriveChunkSize(size, opts.nchunks);
  } else {
    cs = deriveChunkSize(size, await chunkCount(db, key));
  }
  const startIdx = Math.floor(start / cs);
  const endIdx = Math.floor(Math.max(end, start) / cs);
  const headTrim = start - startIdx * cs;
  const tailKeep = range ? end - endIdx * cs + 1 : -1;

  let body = blobStream(db, key, startIdx, endIdx);
  if (headTrim > 0 || tailKeep >= 0) {
    body = trimStream(body, headTrim, tailKeep, endIdx - startIdx + 1);
  }

  const resp = new Response(body, { status: range ? 206 : 200, headers });
  // 整文件小体积 → 写入边缘缓存 (用 waitUntil 后台完成, 不阻塞响应)
  if (!range && opts.cacheTtl && size <= CACHE_MAX_FILE) {
    const [a, b] = resp.body.tee();
    const put = cachePut(`F:${opts.cacheKeyPrefix || ''}:${key}:${size}`, new Response(a, resp), opts.cacheTtl);
    if (env && env._ctx) env._ctx.waitUntil(put); else await put;
    return new Response(b, resp);
  }
  return resp;
}

// 从分片流中裁掉首尾多余字节
function trimStream(src, headTrim, tailKeep, chunksExpected) {
  const reader = src.getReader();
  let first = true;
  let idx = 0;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        let chunk = value;
        if (first) {
          first = false;
          if (headTrim > 0) chunk = chunk.subarray(headTrim);
        }
        idx++;
        if (idx === chunksExpected && tailKeep >= 0) {
          // startIdx === endIdx 时头尾裁剪落在同一分片: tailKeep 是片内偏移, 须扣除已裁掉的头,
          // 否则尾部裁不掉, 实际吐出字节数超过 Content-Range 承诺, 浏览器 media loader 会中止加载
          const keep = chunksExpected === 1 ? tailKeep - headTrim : tailKeep;
          if (chunk.length > keep) chunk = chunk.subarray(0, keep);
        }
        if (chunk.length) { controller.enqueue(chunk); return; }
      }
    },
  });
}

// ---------------- 下载 (认证) ----------------
export async function downloadFile(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);
  const inline = isImageName(node.name) || isVideoName(node.name) || isPdfName(node.name);
  return serveFileContent(req, env, db, {
    key: 'f:' + node.path, size: node.size, mime: node.mime || mimeFromName(node.name),
    filename: node.name, inline, cacheTtl: 300, cacheKeyPrefix: 'priv', nchunks: node.nchunks,
  });
}

// ---------------- 预览 (文本 / 媒体) ----------------
export async function previewFile(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);

  if (isTextName(node.name)) {
    // HTML 由 iframe 子框架异步解析, 不占主线程, 上限放宽; 其余文本要主线程渲染, 收紧
    const ext = fileExt(node.name);
    const textLimit = (ext === 'html' || ext === 'htm') ? 5 * 1024 * 1024 : 1024 * 1024;
    if (node.size > textLimit) return jerr('文件过大，无法预览，请下载查看');
    // 按 idx 聚合读取全部分片 (分片 512KB, 预览上限 5MB = 最多 10 行; 禁止 LIMIT 硬编码, 分片大小历史上改过)
    const res = await db.prepare('SELECT idx, data FROM blobs WHERE key = ?1 ORDER BY idx').bind('f:' + node.path).all();
    const parts = (res.results || []).map((r) => new Uint8Array(r.data));
    const total = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    return json({
      type: 'text',
      content: new TextDecoder().decode(buf),
      filename: node.name,
      ext: fileExt(node.name),
    });
  }

  return serveFileContent(req, env, db, {
    key: 'f:' + node.path, size: node.size, mime: node.mime || mimeFromName(node.name),
    filename: node.name, inline: true, cacheTtl: 300, cacheKeyPrefix: 'priv', nchunks: node.nchunks,
  });
}

// ---------------- 缩略图 ----------------
// 仅返回前端 canvas 预生成的缩略图 (blobs key='t:<path>', 约 10-20KB);
// 无预存一律 404 (前端回退 SVG 图标), 不再降级传原图省流量; 视频由前端抓帧后经 uploadThumbnail 回写
export async function thumbnail(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);
  const row = await db.prepare('SELECT LENGTH(data) AS s FROM blobs WHERE key = ?1 AND idx = 0').bind('t:' + node.path).first();
  if (!row) return jerr('缩略图不可用', 404);
  return serveFileContent(req, env, db, {
    key: 't:' + node.path, size: row.s, mime: 'image/jpeg',
    filename: node.name + '.thumb.jpg', inline: true, cacheTtl: 86400, cacheKeyPrefix: 'thumb',
  });
}

// 回写前端生成的缩略图 (新上传后 / 旧文件浏览时懒生成)
export async function uploadThumbnail(req, env, db) {
  let form;
  try { form = await req.formData(); } catch { return jerr('multipart 解析失败'); }
  const path = sanitizeRel(form.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);
  const dataField = [...form.values()].find((v) => typeof v !== 'string');
  if (!dataField) return jerr('缺少数据');
  const data = new Uint8Array(await dataField.arrayBuffer());
  if (!data.length) return jerr('缩略图为空');
  if (data.length > 1024 * 1024) return jerr('缩略图过大');
  await db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1, 0, ?2)').bind('t:' + node.path, data).run();
  await invalidateFileCache(node.path, node.size);
  return json({ ok: true, size: data.length });
}

// ---------------- 递归搜索 ----------------
export async function searchFiles(req, env, db, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  if (!q) return json({ query: q, results: [] });
  const pattern = '%' + q.replace(/([%_\\])/g, '\\$1') + '%';
  const res = await db.prepare(
    "SELECT path, name, is_dir, size FROM fs_nodes WHERE name LIKE ?1 ESCAPE '\\' LIMIT 200",
  ).bind(pattern).all();
  const results = (res.results || []).map((r) => ({
    name: r.name,
    path: r.path,
    is_dir: !!r.is_dir,
    size: r.is_dir ? 0 : r.size,
    ext: r.is_dir ? '' : fileExt(r.name),
  }));
  return json({ query: q, results });
}

// ---------------- 打包下载 (ZIP/STORE) ----------------
// 递归收集目录下所有文件的 zip 条目 (预读 + CRC), 供文件管理器/分享页复用
export async function collectZipEntries(env, db, dirNode, zipMax) {
  const entries = [];
  let totalSize = 0;
  async function addNode(node, prefix) {
    if (node.is_dir) {
      const sub = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE parent = ?1 ORDER BY is_dir DESC, name ASC`).bind(node.path).all();
      for (const r of sub.results || []) {
        await addNode(r, prefix ? `${prefix}/${r.name}` : r.name);
        if (totalSize > zipMax) return;
      }
    } else {
      totalSize += node.size;
      if (totalSize > zipMax) return;
      const res = await serveFileContent(new Request('https://internal/fetch'), env, db, {
        key: 'f:' + node.path, size: node.size, mime: 'application/octet-stream',
        filename: node.name, inline: true, nchunks: node.nchunks,
      });
      const { crc, size, replay } = await crcOfStream(res.body);
      entries.push({ name: prefix, size, crc, stream: replay() });
    }
  }
  await addNode(dirNode, dirNode.name || 'share');
  return { entries, totalSize, overflow: totalSize > zipMax };
}

export function zipStreamResponse(entries, filename) {
  return new Response(zipStream(entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="download.zip"; filename*=UTF-8''${encodeFilename(filename || 'download.zip')}`,
    },
  });
}

export async function batchDownload(req, env, db) {
  let paths = null;
  const ct = req.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    let body;
    try { body = await req.json(); } catch { return jerr('请求格式错误'); }
    paths = body.paths;
  } else {
    // 表单提交 (token + paths), 与原版一致: HTML form 无法带 Header, 自行校验 token 字段
    let form;
    try { form = await req.formData(); } catch { return jerr('表单解析失败'); }
    const claims = await validateToken(String(form.get('token') || ''), env.JWT_SECRET).catch(() => null);
    if (!claims) return jerr('无效的令牌', 401);
    try { paths = JSON.parse(form.get('paths') || '[]'); } catch { return jerr('无效的路径列表'); }
  }
  if (!Array.isArray(paths)) return jerr('无效的路径列表');

  const zipMax = parseInt(env.ZIP_MAX_TOTAL || '33554432', 10);
  const entries = [];
  let overflow = false;
  for (const raw of paths) {
    const path = sanitizeRel(raw);
    const node = await getNode(db, path);
    if (!node) continue;
    if (node.is_dir) {
      const r = await collectZipEntries(env, db, node, zipMax);
      entries.push(...r.entries);
      if (r.overflow) { overflow = true; break; }
    } else {
      const res = await serveFileContent(new Request('https://internal/fetch'), env, db, {
        key: 'f:' + node.path, size: node.size, mime: 'application/octet-stream',
        filename: node.name, inline: true, nchunks: node.nchunks,
      });
      const { crc, size, replay } = await crcOfStream(res.body);
      entries.push({ name: node.name, size, crc, stream: replay() });
    }
  }
  if (overflow) return jerr(`打包内容过大 (>${Math.floor(zipMax / 1024 / 1024)}MB)，请分批下载`, 413);
  return zipStreamResponse(entries, 'download.zip');
}

// 目录子行 (分享页数据模式复用)
export async function listDirRows(db, parent) {
  const rows = await db.prepare(
    `SELECT ${NODE_COLS} FROM fs_nodes WHERE parent = ?1 ORDER BY is_dir DESC, name COLLATE NOCASE ASC`,
  ).bind(sanitizeRel(parent)).all();
  return rows.results || [];
}

// ---------------- 视频转码降级 ----------------
// Workers 无法运行 ffmpeg; 返回与原版"无可用清晰度"相同的 JSON, 前端自动只用原片
export async function videoQualities(req, env, db, url) {
  return json({ original: true, options: [] });
}
export async function videoPrepare(req, env, db, url) {
  return jerr('Workers 环境不支持视频转码', 501);
}
export async function videoServe(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);
  return serveFileContent(req, env, db, {
    key: 'f:' + node.path, size: node.size, mime: node.mime || mimeFromName(node.name),
    filename: node.name, inline: true, cacheTtl: 300, cacheKeyPrefix: 'priv',
  });
}

// ---------------- 图床缓存失效助手 (被 imagehost.js 使用) ----------------
export async function invalidateIhCache(filename) {
  await cacheDel(`I:${filename}`);
  await cacheDel(`IH:${filename}`);
}

function buildUploadResponse(req, filename, origName, mime) {
  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const fileUrl = `${base}/i/${filename}`;
  const isImg = mime.startsWith('image/');
  return json({
    filename,
    url: fileUrl,
    markdown: isImg ? `![${origName}](${fileUrl})` : `[${origName}](${fileUrl})`,
    html: isImg ? `<img src="${fileUrl}" alt="${origName}" />` : `<a href="${fileUrl}">${origName}</a>`,
    bbcode: isImg ? `[img]${fileUrl}[/img]` : `[url=${fileUrl}]${origName}[/url]`,
  });
}

export { buildUploadResponse };
