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
  blobStream, crcOfStream, zipStream, randomId, subtreeMatch, SEC_HEADERS,
} from './util.js';
import { validateToken, checkTokenFresh } from './auth.js';
import { rangeMaxOf } from './settings.js';
import { dbById, dbOfNode, pickDb, capacityResponse, bumpUsage } from './storage.js';
import { collectFileRows, deleteBlobKeys, rewriteBlobKeys, copyBlobKeys } from './blobops.js';

// 整文件(无 Range)单次流式响应的安全上限: 超过它平台会在 CPU 上限处静默截断
// (实测掐断点约 2.0s CPU ≈ 60~90MiB), 取 32MiB (~1.0s CPU) 留一倍余量;
// 超过则明确回 413 报错, 而不是发一个"看起来成功"的残缺文件。
const FULL_STREAM_MAX = 32 * 1024 * 1024;

// ---------------- 元数据访问 ----------------
const NODE_COLS = 'path, parent, name, is_dir, size, mime, created_at, modified_at, nchunks, db_id';

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
    // 'pub' 前缀: 分享直链 + 图床引用型条目都从 'f:<path>' 读, 同一份字节同一缓存键
    cacheDel(`F:pub:${k}:${size}`),
  ]);
}

// ---------------- 图床引用维护 ----------------
// 图床「从文件管理导入」是零拷贝引用: image_host.src_path 指向 'f:<path>',
// 一份字节两个入口。因此源文件的删除/改名/覆盖都必须同步处理引用方,
// 否则 /i/<name> 直链会静默 404 或长时间返回旧内容。

// 反查引用了指定路径(含其整棵子树)的图床条目
export async function ihRefs(db, path) {
  const clean = sanitizeRel(path);
  if (!clean) return [];
  // D1 的 LIKE pattern 上限 48 字节(见 util.js subtreeMatch 注释): 长路径必须用 substr 前缀匹配
  const r = await db.prepare(
    `SELECT filename, original_name FROM image_host WHERE ${subtreeMatch('src_path')}`,
  ).bind(clean).all();
  return r.results || [];
}

// 拒绝删除时给用户的说明
export function ihRefsMessage(refs, isDir) {
  const names = refs.slice(0, 3).map((r) => r.original_name || r.filename).join('、');
  const more = refs.length > 3 ? ` 等 ${refs.length} 项` : '';
  return `该${isDir ? '目录' : '文件'}已被图床引用（${names}${more}），请先删除对应的图床条目`;
}

// 源文件改名/移动: 同步改写引用路径并失效图床缓存
export async function rekeyIhRefs(db, fromPath, toPath) {
  const from = sanitizeRel(fromPath);
  const to = sanitizeRel(toPath);
  if (!from || from === to) return;
  const refs = await ihRefs(db, from);
  if (!refs.length) return;
  // src_path 不含 'f:' 前缀 → 偏移 from.length + 1 (blobs 那边是 +3);
  // 偏移在 SQL 里用 length() 算: SQLite 按字符, JS 的 .length 对 emoji 会多算。
  await db.prepare(
    `UPDATE image_host SET src_path = ?2 || substr(src_path, length(?1) + 1) WHERE ${subtreeMatch('src_path')}`,
  ).bind(from, to).run();
  // 缓存里存着旧的 src_path 与旧的内容键
  await Promise.all(refs.map((r) => invalidateIhCache(r.filename)));
  // 图床列表 (IL:) 缓存里的 src_path 也过期了
  await invalidateIhList();
}

// 源文件被覆盖写: 直链内容跟随变化 → 同步 size 并失效图床缓存
export async function syncIhOnOverwrite(db, path, newSize, oldSize) {
  const clean = sanitizeRel(path);
  if (!clean) return;
  const refs = await ihRefs(db, clean);
  if (!refs.length) return;
  await db.prepare('UPDATE image_host SET size = ?2 WHERE src_path = ?1').bind(clean, newSize).run();
  const keys = new Set([`F:pub:f:${clean}:${newSize}`]);
  if (oldSize != null && oldSize !== newSize) keys.add(`F:pub:f:${clean}:${oldSize}`);
  await Promise.all(refs.map((r) => invalidateIhCache(r.filename, [...keys])));
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

// 递归删除子树。分库后不能用「一条子查询搞定」的写法: 字节可能分散在多个库,
// 而 fs_nodes 只在主库。按 I5「元数据先删、字节后删」执行 ——
// 先取回子树全部文件行(含归属库), 再删元数据, 最后按库删字节。
// 中途失败只留下孤儿字节(用户不可见), blob_journal + cron 会重试收敛。
async function deleteSubtree(db, env, path) {
  const clean = sanitizeRel(path);
  const files = await collectFileRows(db, clean);
  await db.prepare(`DELETE FROM fs_nodes WHERE ${subtreeMatch('path')}`).bind(clean).run();
  if (!files.length) return;
  await deleteBlobKeys(db, env, files);
  // 用量记帐: 按归属库分别扣减
  const per = new Map();
  for (const f of files) {
    const id = f.db_id || 1;
    per.set(id, (per.get(id) || 0) + (f.size || 0));
  }
  for (const [id, delta] of per) await bumpUsage(db, id, -delta);
}

export async function deleteFile(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  if (!path) return jerr('无法删除根目录');
  const node = await getNode(db, path);
  if (!node) return jerr('文件不存在', 404);
  // 图床零拷贝引用: 字节只有这一份, 删了直链就没了 → 先要求解除引用
  const refs = await ihRefs(db, path);
  if (refs.length) return jerr(ihRefsMessage(refs, node.is_dir), 409);
  await deleteSubtree(db, env, path);
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
    // 被图床引用的路径跳过 (不阻断其余项), 逐条把原因回传前端
    const refs = await ihRefs(db, path);
    if (refs.length) { errors.push(`${path}: ${ihRefsMessage(refs, node.is_dir)}`); continue; }
    await deleteSubtree(db, env, path);
    await invalidateFileCache(path, node.size);
    parents.add(node.parent);
    deleted.push(path);
  }
  await Promise.all([...parents].map((p) => invalidateDir(db, p)));
  return json({ deleted, errors });
}

// 移动/重命名共用: 重写子树 path/parent 与对应 blob key
export async function moveNode(db, env, fromPath, toDir, newName) {
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

  // offN/offB 一律在 SQL 里用 length(): SQLite 按字符计数, JS 的 .length 对 emoji(surrogate pair)
  // 会计成 2 —— 用错会把名字切坏。
  const SUBTREE = subtreeMatch('path');
  const now = new Date().toISOString();
  const fsStmt = node.is_dir
    ? db.prepare(`UPDATE fs_nodes SET path = ?2 || substr(path, length(?1) + 1), parent = CASE WHEN path = ?1 THEN ?3 ELSE ?2 || substr(parent, length(?1) + 1) END, modified_at = ?4 WHERE ${SUBTREE}`).bind(from, sp.path, sp.parent, now)
    : db.prepare('UPDATE fs_nodes SET path = ?2, parent = ?3, name = ?4, modified_at = ?5 WHERE path = ?1').bind(from, sp.path, sp.parent, name, now);

  // 受影响的文件行与其归属库 (分库后字节可能不在主库)
  const fr = await db.prepare(`SELECT path, db_id FROM fs_nodes WHERE (${SUBTREE}) AND is_dir = 0`).bind(from).all();
  const files = fr.results || [];
  const dbIds = new Set(files.map((r) => r.db_id || 1));

  if (dbIds.size === 0 || (dbIds.size === 1 && dbIds.has(1))) {
    // 快路径 (上线初期的常态: 字节都在主库): 与原实现完全一致 ——
    // blobs 与元数据放进同一个 batch, 单库事务, 要么全成要么全败
    const bStmts = node.is_dir
      ? [
          db.prepare(`UPDATE blobs SET key = 'f:' || ?2 || substr(key, length(?1) + 3) WHERE key IN (SELECT 'f:' || path FROM fs_nodes WHERE (${SUBTREE}) AND is_dir = 0)`).bind(from, sp.path),
          db.prepare(`UPDATE blobs SET key = 't:' || ?2 || substr(key, length(?1) + 3) WHERE key IN (SELECT 't:' || path FROM fs_nodes WHERE (${SUBTREE}) AND is_dir = 0)`).bind(from, sp.path),
        ]
      : [
          db.prepare('UPDATE blobs SET key = ?2 WHERE key = ?1').bind('f:' + from, 'f:' + sp.path),
          db.prepare('UPDATE blobs SET key = ?2 WHERE key = ?1').bind('t:' + from, 't:' + sp.path),
        ];
    await db.batch([...bStmts, fsStmt]);
  } else {
    // 跨库: 没有跨库事务。先改字节(失败会自动回滚), 成功后再改元数据;
    // 元数据失败则把字节改回去 —— 保证最终与 fs_nodes 保持一致, 不留坏引用。
    const r = await rewriteBlobKeys(db, env, files, from, sp.path);
    if (!r.ok) return { error: r.error, status: 500 };
    try {
      await fsStmt.run();
    } catch (e) {
      await rewriteBlobKeys(db, env, files, sp.path, from);
      return { error: '改名失败（已回滚）', status: 500 };
    }
  }
  // 图床零拷贝引用: 源文件/目录换了路径, 必须同步改写 src_path, 否则直链 404
  await rekeyIhRefs(db, from, sp.path);
  await invalidateDir(db, node.parent);
  await invalidateDir(db, sp.parent);
  return { ok: true };
}

export async function rename(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const node = await getNode(db, body.path || '');
  if (!node) return jerr('文件不存在', 404);
  const r = await moveNode(db, env, body.path, node.parent, body.new_name);
  if (r.error) return jerr(r.error, r.status);
  return json({ renamed: body.new_name });
}

export async function moveFile(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const r = await moveNode(db, env, body.from, body.to, null);
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

  const nowIso = new Date().toISOString();
  if (node.is_dir) {
    // 复制整棵子树: 先搬字节(留在源文件各自的库, 同库 INSERT..SELECT 零成本), 再写元数据行。
    // 顺序遵循 I5 (字节先落、元数据后写): 中途失败只会留下孤儿字节, 不会出现"有记录没数据"。
    const sub = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE ${subtreeMatch('path')}`).bind(from).all();
    const rows = sub.results || [];
    const off = from.length;
    const stmts = [];
    const pairs = [];
    for (const r of rows) {
      const np = sp.path + r.path.slice(off);
      const npParent = r.path === from ? sp.parent : sp.path + r.parent.slice(off);
      const nName = r.path === from ? sp.name : r.name;
      stmts.push(db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)')
        .bind(np, npParent, nName, r.is_dir, r.size, r.mime, r.created_at, nowIso, r.nchunks, r.db_id || 1));
      if (!r.is_dir) pairs.push({ src: r.path, dst: np, db_id: r.db_id || 1 });
    }
    if (pairs.length) await copyBlobKeys(db, env, pairs);
    await db.batch(stmts);
  } else {
    await copyBlobKeys(db, env, [{ src: from, dst: sp.path, db_id: node.db_id || 1 }]);
    await db.batch([
      db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7,?8)')
        .bind(sp.path, sp.parent, sp.name, node.size, node.mime, nowIso, node.nchunks, node.db_id || 1),
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

async function upsertFileNode(db, path, size, mime, nchunks, dbId = 1) {
  const sp = splitPath(path);
  const now = new Date().toISOString();
  await db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7,?8)')
    .bind(sp.path, sp.parent, sp.name, size, mime, now, nchunks, dbId).run();
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
    // 选库: 覆盖写沿用原文件所在的库 (不产生跨库搬迁); 新文件按容量挑一个装得下的
    let targetId = old && !old.is_dir ? (old.db_id || 1) : 0;
    let vdb = targetId ? dbById(env, targetId) : null;
    if (!vdb) {
      const need = data.length + CHUNK_SIZE;
      const picked = await pickDb(env, db, need);
      if (!picked.ok) return capacityResponse(db, need, picked);
      targetId = picked.row.id;
      vdb = picked.db;
    }
    // 覆盖写时内容已变, 旧缩略图作废
    await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + sp.path).run();
    const n = await writeBlob(vdb, 'f:' + sp.path, data);
    await upsertFileNode(db, sp.path, data.length, mimeFromName(name), n, targetId);
    await bumpUsage(db, targetId, data.length - (old && !old.is_dir ? old.size : 0));
    if (old && !old.is_dir) await invalidateFileCache(sp.path, old.size);
    // 被图床引用的源文件被覆盖: 直链内容跟随变化 (同步 size + 失效图床缓存)
    if (old && !old.is_dir) await syncIhOnOverwrite(db, sp.path, data.length, old.size);
    uploaded.push(name);
  }
  for (const p of parents) await invalidateDir(db, p);
  return json({ uploaded });
}

// ---------------- 分片上传 (支持断点续传) ----------------
// 续传协议:
//   1. 前端算文件指纹 file_key = SHA256(文件名|大小|lastModified|分片大小) — 只依赖元数据
//   2. init 时带上 file_key/chunk_size/file_size; 服务端若已存在同一 file_key 且未完成
//      的 session 则直接复用, 返回其 upload_id 与已上传分片清单 (received)
//   3. 前端只补齐 received 中缺失的分片; 每片带上前端算好的 chunk_hash
//   4. chunk 写入时同步写 blobs.hash, 并刷新 session.updated_at (定时清理依据)
//   5. complete 分批合并 (每次 MERGE_BATCH 片), 最后一批才写元数据/删 session
export async function uploadInit(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const total = parseInt(body.total_chunks, 10);
  if (!Number.isFinite(total) || total <= 0 || total > 10000) return jerr('无效的分片数量');
  const dir = sanitizeRel(body.path || '');
  if (!(await dirExists(db, dir))) return jerr('目标不是目录', 400);
  const filename = sanitizeFilename(body.filename || 'upload');
  const target = splitPath(`${dir}/${filename}`).path;
  const fileKey = String(body.file_key || '').slice(0, 128);
  const fileSize = parseInt(body.file_size, 10) || 0;
  const chunkSize = parseInt(body.chunk_size, 10) || 0;
  const now = Date.now();

  // 命中未完成的同源会话 → 复用 (要求目标路径/文件名/分片数/分片大小一致)
  if (fileKey) {
    const exist = await db.prepare(
      'SELECT id, target, kind, total_chunks, chunk_size, merged_upto, db_id FROM upload_sessions WHERE kind = \'file\' AND file_key = ?1 AND target = ?2 AND total_chunks = ?3 AND (chunk_size = ?4 OR chunk_size = 0) ORDER BY updated_at DESC LIMIT 1',
    ).bind(fileKey, target, total, chunkSize).first();
    if (exist) {
      // 暂存分片在会话「钉住」的那个库里。必须先按主库里的 db_id 去对应库查,
      // 否则会查错库、误判「分片全丢」, 让用户把已经传完的几个 G 重传一遍。
      const vdb = dbById(env, exist.db_id || 1) || db;
      const received = await vdb.prepare('SELECT idx, hash FROM blobs WHERE key = ?1 ORDER BY idx').bind('u:' + exist.id).all();
      const rows = received.results || [];
      // 已传分片 = 暂存键上的 + 已合并进最终键的 (complete 分批中断后的续传场景)
      const got = new Set(rows.map((r) => r.idx));
      const merged = exist.merged_upto || 0;
      for (let i = 0; i < merged; i++) got.add(i);
      // 刷新活跃时间; 分片可能少于 total (正常的中断状态), 前端据此补齐缺失片
      await db.prepare('UPDATE upload_sessions SET updated_at = ?2 WHERE id = ?1').bind(exist.id, now).run();
      return json({
        upload_id: exist.id,
        total_chunks: exist.total_chunks,
        resumed: true,
        db_id: exist.db_id || 1,
        received: [...got].sort((a, b) => a - b),
        hashes: rows.filter((r) => r.hash).map((r) => ({ idx: r.idx, hash: r.hash })),
      });
    }
  }

  // 新会话: 在这里「钉库」。needBytes 必须包含合并峰值 ——
  // mergeStagingBatch 是 INSERT..SELECT + DELETE, 同一事务内新旧 key 短暂并存,
  // 峰值空间不足会在合并中途撞 7500 (此时文件已经传完, 用户感受最差)。
  const need = fileSize + MERGE_BATCH * (chunkSize || CHUNK_SIZE);
  const picked = await pickDb(env, db, need);
  if (!picked.ok) return capacityResponse(db, need, picked);

  const id = randomId(12);
  await db.prepare(
    'INSERT INTO upload_sessions (id, kind, target, filename, total_chunks, mime, file_size, file_key, chunk_size, created_at, updated_at, db_id) VALUES (?1,\'file\',?2,?3,?4,\'\',?5,?6,?7,?8,?8,?9)',
  ).bind(id, target, filename, total, fileSize, fileKey, chunkSize, now, picked.row.id).run();
  return json({ upload_id: id, total_chunks: total, resumed: false, received: [], hashes: [], db_id: picked.row.id });
}

export async function uploadChunk(req, env, db) {
  let form;
  try { form = await req.formData(); } catch { return jerr('multipart 解析失败'); }
  const uploadId = form.get('upload_id');
  const idx = parseInt(form.get('chunk_index'), 10);
  const dataField = [...form.values()].find((v) => typeof v !== 'string');
  if (!uploadId || !Number.isFinite(idx) || !dataField) return jerr('缺少 upload_id 或数据');

  const session = await db.prepare('SELECT total_chunks, db_id FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return jerr('上传会话不存在', 404);
  if (idx < 0 || idx >= session.total_chunks) return jerr('分片索引超出范围');
  const data = new Uint8Array(await dataField.arrayBuffer());
  if (data.length > 2 * 1024 * 1024) return jerr('分片过大');

  // 暂存分片必须落进会话钉住的那个库 (I2: 与最终键同库, 合并才不跨库)
  const vdb = dbById(env, session.db_id || 1) || db;
  const hash = String(form.get('chunk_hash') || '').slice(0, 64);
  await vdb.prepare('INSERT OR REPLACE INTO blobs (key, idx, data, hash) VALUES (?1, ?2, ?3, ?4)').bind('u:' + uploadId, idx, data, hash || null).run();
  // 刷新活跃时间: 续传中的会话不会被定时清理误删 (会话行在主库)
  await db.prepare('UPDATE upload_sessions SET updated_at = ?2 WHERE id = ?1').bind(uploadId, Date.now()).run();
  // 不再每片做一次 COUNT(*) 全表统计 (片数多时是线性开销); 前端自己维护 sentChunks
  return json({ chunk_index: idx, total: session.total_chunks });
}

// 查询会话已传分片 (页面前端持久化状态丢失时, 用它恢复进度)
export async function uploadStatus(req, env, db, url) {
  const uploadId = url.searchParams.get('upload_id');
  if (!uploadId) return jerr('缺少 upload_id');
  const session = await db.prepare('SELECT id, total_chunks, filename, target, file_size, chunk_size, updated_at, merged_upto, db_id FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return json({ exists: false, received: [] });
  // 同 uploadInit: 先按会话的 db_id 定位库, 再查暂存分片
  const vdb = dbById(env, session.db_id || 1) || db;
  const rows = await vdb.prepare('SELECT idx, hash FROM blobs WHERE key = ?1 ORDER BY idx').bind('u:' + uploadId).all();
  const list = rows.results || [];
  // 已合并进最终键的分片也算已传 (complete 分批中断后的续传场景)
  const got = new Set(list.map((r) => r.idx));
  const merged = session.merged_upto || 0;
  for (let i = 0; i < merged; i++) got.add(i);
  return json({
    exists: true,
    upload_id: session.id,
    total_chunks: session.total_chunks,
    filename: session.filename,
    target: session.target,
    file_size: session.file_size,
    chunk_size: session.chunk_size,
    updated_at: session.updated_at,
    merged_upto: merged,
    db_id: session.db_id || 1,
    received: [...got].sort((a, b) => a - b),
    hashes: list.filter((r) => r.hash).map((r) => ({ idx: r.idx, hash: r.hash })),
  });
}

// 主动放弃一个未完成的上传: 删暂存分片 + 删会话。
// 与定时清理的区别: 立即执行、由用户显式触发 (前端「删除」按钮)。
// 已合并进最终键的部分 (merged_upto > 0) 是半成品文件, 一并清掉, 避免残留孤儿数据。
export async function uploadAbort(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const uploadId = body.upload_id;
  if (!uploadId) return jerr('缺少 upload_id');

  const session = await db.prepare('SELECT id, kind, target, merged_upto, db_id FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return json({ ok: true, deleted: 0 }); // 已不存在 → 视为成功 (幂等)

  const vdb = dbById(env, session.db_id || 1) || db;
  const stmts = [
    vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('u:' + uploadId),
  ];
  // 合并过半的最终键数据也是本次上传的产物 (未写入 fs_nodes, 对用户不可见) → 清掉
  if ((session.merged_upto || 0) > 0) {
    const finalKey = session.kind === 'image' ? 'i:' + session.target : 'f:' + session.target;
    stmts.push(vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind(finalKey));
  }
  await vdb.batch(stmts);
  await db.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(uploadId).run();
  return json({ ok: true, deleted: 1 });
}

// complete 每次合并的分片数: 单请求搬运量 ≈ MERGE_BATCH × 分片大小, 与文件总大小解耦。
// 免费版单请求 10ms CPU, 一次性合并全部分片会随片数线性增长 → 大文件必触发 exceededCpu(1102)。
const MERGE_BATCH = 32;

// 把暂存键 [start, end) 区间的分片搬到最终键, 并删除已搬走的暂存行。
// 不写 fs_nodes / 不删 session —— 那是"全部合并完"之后的事。
async function mergeStagingBatch(db, stageKey, finalKey, start, end) {
  const res = await db.batch([
    db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data, hash) SELECT ?3, idx, data, NULL FROM blobs WHERE key = ?1 AND idx >= ?2 AND idx < ?4')
      .bind(stageKey, start, finalKey, end),
    db.prepare('DELETE FROM blobs WHERE key = ?1 AND idx >= ?2 AND idx < ?3')
      .bind(stageKey, start, end),
  ]);
  return (res && res[0] && res[0].meta && res[0].meta.changes) || 0;
}

export async function uploadComplete(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const uploadId = body.upload_id;
  if (!uploadId) return jerr('缺少 upload_id');

  const session = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?1').bind(uploadId).first();
  if (!session) return jerr('上传会话不存在', 404);

  const total = session.total_chunks;
  const stageKey = 'u:' + uploadId;
  const finalKey = session.kind === 'image' ? 'i:' + session.target : 'f:' + session.target;
  // 会话钉住的库: 暂存分片、最终键、缩略图都在这里; 元数据仍在主库 (I2 / I3)
  const vdb = dbById(env, session.db_id || 1) || db;

  // 批次区间: 首次从 0 开始, 后续由前端回传上一次的 next
  let start = 0;
  if (Array.isArray(body.batch) && body.batch.length === 2) {
    start = Math.max(0, parseInt(body.batch[0], 10) || 0);
  }

  // 只有首次请求做一次全量缺失校验 (后续批次暂存行已被搬走, 扫不出完整信息)
  if (start === 0) {
    const present = await vdb.prepare('SELECT idx FROM blobs WHERE key = ?1').bind(stageKey).all();
    const idxs = new Set((present.results || []).map((r) => r.idx));
    const merged = session.merged_upto || 0;
    for (let i = 0; i < merged; i++) idxs.add(i); // 之前批次已合并的
    const missing = [];
    for (let i = 0; i < total; i++) if (!idxs.has(i)) missing.push(i);
    if (missing.length) {
      return json({ error: '缺失分片', missing: missing.slice(0, 100), missing_count: missing.length }, 400);
    }
  }

  const end = Math.min(start + MERGE_BATCH, total);
  await mergeStagingBatch(vdb, stageKey, finalKey, start, end);
  // 刷新活跃时间: 分批合并可能跨分钟, 防止定时任务把进行中的会话回收
  await db.prepare('UPDATE upload_sessions SET merged_upto = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(uploadId, end, Date.now()).run();

  // 还有剩余分片 → 返回下一批区间, 前端继续调用
  if (end < total) {
    return json({ done: false, next: [end, Math.min(end + MERGE_BATCH, total)], merged: end, total });
  }

  // 全部合并完成: 按最终键统计真实字节数 (暂存键此刻已空)
  const sizeRow = await vdb.prepare('SELECT COALESCE(SUM(LENGTH(data)),0) AS s FROM blobs WHERE key = ?1').bind(finalKey).first();
  const size = sizeRow.s;
  const max = parseInt(env.MAX_UPLOAD_SIZE || '209715200', 10);
  if (size > max) {
    await vdb.batch([
      vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind(finalKey),
      vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind(stageKey),
    ]);
    await db.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(uploadId).run();
    return jerr(`文件超过最大上传限制 (${Math.floor(max / 1024 / 1024)}MB)`, 413);
  }

  const old = session.kind === 'file' ? await getNode(db, session.target) : null;
  const now = new Date().toISOString();

  // ① 字节侧收尾 (在会话的库里, 单库 batch 原子): 清尾部残留 + 旧缩略图
  await vdb.batch([
    // 本次分片数少于同名旧文件时, 最终键尾部会残留多余分片
    vdb.prepare('DELETE FROM blobs WHERE key = ?1 AND idx >= ?2').bind(finalKey, total),
    // 覆盖上传时内容已变, 旧缩略图作废 (新缩略图由前端生成后回写)
    vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + session.target),
  ]);

  // ② 元数据侧 (主库)。字节此刻已经就位, 这里才让文件对用户可见 —— I5 字节先落、元数据后写
  const stmts = [];
  if (session.kind === 'image') {
    stmts.push(db.prepare('INSERT OR REPLACE INTO image_host (filename, original_name, mime_type, size, upload_time, db_id) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(session.target, session.filename, session.mime || mimeFromName(session.filename), size, now, session.db_id || 1));
  } else {
    const sp = splitPath(session.target);
    stmts.push(db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7,?8)')
      .bind(sp.path, sp.parent, sp.name, size, mimeFromName(session.filename), now, total, session.db_id || 1));
  }
  stmts.push(db.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(uploadId));
  await db.batch(stmts);

  // ③ 用量记帐 (覆盖写只计净增: 同 key 的旧字节已被覆盖)
  await bumpUsage(db, session.db_id || 1, size - (old && !old.is_dir ? old.size : 0));

  if (session.kind === 'image') {
    await invalidateIhCache(session.target);
    await invalidateIhList();   // 新条目要立即出现在图床列表里 (列表缓存 30s)
    const r = buildUploadResponse(req, session.target, session.filename, session.mime || mimeFromName(session.filename));
    // 保持与文件上传一致的 done 语义, 同时保留图床原有的嵌入代码字段
    const payload = await r.json();
    return json({ ...payload, done: true });
  }
  const sp = splitPath(session.target);
  if (old && !old.is_dir) await invalidateFileCache(session.target, old.size);
  // 被图床引用的源文件被覆盖: 直链内容跟随变化 (同步 size + 失效图床缓存)
  if (old && !old.is_dir) await syncIhOnOverwrite(db, session.target, size, old.size);
  await invalidateDir(db, sp.parent);
  return json({ done: true, filename: session.filename, path: session.target });
}

// ---------------- 公共文件响应 (Range + 边缘缓存), 供 vfs/图床/分享复用 ----------------
export async function serveFileContent(req, env, db, opts) {
  // opts: {key, size, mime, filename, inline, cacheTtl, immutable, cacheKeyPrefix, nchunks, db_id}
  // db_id = 字节所在库; 缺省或 binding 不存在时回退主库
  // (上线初期所有 db_id 都是 1, 行为与改造前完全一致)
  const { key, size, mime, filename } = opts;
  const vdb = opts.db_id ? (dbById(env, opts.db_id) || db) : db;
  const disposition = contentDisposition(opts.inline ? 'inline' : 'attachment', filename);
  const baseHeaders = {
    'Content-Type': mime,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    ...SEC_HEADERS,
  };

  const range = parseRange(req.headers.get('Range'), size);

  // Range 窗口封顶 = 单次响应的 CPU 预算 (成本主要在 D1 行反序列化成字节, 实测 25~33ms CPU/MiB)。
  // 窗口可在「参数设置」里改, 客户端与播放器按响应里的 Content-Range 逐段续拉。
  // 下限 CHUNK_SIZE (1MiB): 窗口不该小于一个存储行, 否则读了整行只吐一部分, 白花 D1 读 + 裁剪开销。
  const RANGE_MAX = Math.max(CHUNK_SIZE, await rangeMaxOf(env, db));
  if (range && range !== 'unsatisfiable' && range.end - range.start + 1 > RANGE_MAX) {
    range.end = range.start + RANGE_MAX - 1;
  }

  // 整文件请求超过安全预算: 明确 413, 绝不静默截断
  if (!range && size > FULL_STREAM_MAX) {
    return json({
      error: '文件过大，单次完整传输无法保证完整，请使用页面内的下载按钮（分片下载）',
      size,
      full_stream_max: FULL_STREAM_MAX,
    }, 413, { 'Access-Control-Allow-Origin': '*' });
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
    cs = deriveChunkSize(size, await chunkCount(vdb, key));
  }
  const startIdx = Math.floor(start / cs);
  const endIdx = Math.floor(Math.max(end, start) / cs);
  const headTrim = start - startIdx * cs;
  const tailKeep = range ? end - endIdx * cs + 1 : -1;

  let body = blobStream(vdb, key, startIdx, endIdx);
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
    db_id: node.db_id || 1,
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
    const vdb = dbOfNode(env, db, node);
    const res = await vdb.prepare('SELECT idx, data FROM blobs WHERE key = ?1 ORDER BY idx').bind('f:' + node.path).all();
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
    db_id: node.db_id || 1,
  });
}

// ---------------- 缩略图 ----------------
// 仅返回前端 canvas 预生成的缩略图 (blobs key='t:<path>', 约 10-20KB);
// 无预存一律 404 (前端回退 SVG 图标), 不再降级传原图省流量; 视频由前端抓帧后经 uploadThumbnail 回写
export async function thumbnail(req, env, db, url) {
  const path = sanitizeRel(url.searchParams.get('path') || '');
  const node = await getNode(db, path);
  if (!node || node.is_dir) return jerr('文件不存在', 404);
  // 缩略图与文件本体必须同库 (I1)
  const vdb = dbOfNode(env, db, node);
  const row = await vdb.prepare('SELECT LENGTH(data) AS s FROM blobs WHERE key = ?1 AND idx = 0').bind('t:' + node.path).first();
  if (!row) return jerr('缩略图不可用', 404);
  return serveFileContent(req, env, db, {
    key: 't:' + node.path, size: row.s, mime: 'image/jpeg',
    filename: node.name + '.thumb.jpg', inline: true, cacheTtl: 86400, cacheKeyPrefix: 'thumb',
    db_id: node.db_id || 1,
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
  // 缩略图与文件本体同库 (I1)
  const vdb = dbOfNode(env, db, node);
  await vdb.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1, 0, ?2)').bind('t:' + node.path, data).run();
  await invalidateFileCache(node.path, node.size);
  return json({ ok: true, size: data.length });
}

// ---------------- 递归搜索 ----------------
export async function searchFiles(req, env, db, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  if (!q) return json({ query: q, results: [] });
  // 不用 LIKE: D1 的 pattern 上限 48 字节(见 util.js subtreeMatch), 长关键词会直接 500;
  // instr + lower 等价原来的 '%q%' 语义, 还省掉转义。
  const res = await db.prepare(
    'SELECT path, name, is_dir, size FROM fs_nodes WHERE instr(lower(name), lower(?1)) > 0 LIMIT 200',
  ).bind(q).all();
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
        filename: node.name, inline: true, nchunks: node.nchunks, db_id: node.db_id || 1,
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
      ...SEC_HEADERS,
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
    // 表单通道同样要比对令牌版本, 否则改密码后它仍是旧 token 的后门
    if (!(await checkTokenFresh(claims, db))) return jerr('令牌已失效，请重新登录', 401);
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
        filename: node.name, inline: true, nchunks: node.nchunks, db_id: node.db_id || 1,
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
    db_id: node.db_id || 1,
  });
}

// ---------------- 图床缓存失效助手 (被 imagehost.js 使用) ----------------
// extraKeys: 额外的内容缓存键 (F:pub:<dataKey>:<size>)。只有调用方知道内容
// 挂在 'i:<filename>' (自持) 还是 'f:<src_path>' (引用) 上, 故由调用方传入。
export async function invalidateIhCache(filename, extraKeys = []) {
  await Promise.all([
    cacheDel(`I:${filename}`),
    cacheDel(`IH:${filename}`),
    ...extraKeys.map((k) => cacheDel(k)),
  ]);
}

// 失效图床列表缓存 (IL:<page>:<page_size>:<search>)。
// 搜索词参与键无法枚举, 只刷最常见的无搜索前几页 —— 与列表缓存 30s TTL 配合兜底。
export async function invalidateIhList() {
  await Promise.all([1, 2, 3].flatMap((p) => [24, 100].map((ps) => cacheDel(`IL:${p}:${ps}:`))));
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
