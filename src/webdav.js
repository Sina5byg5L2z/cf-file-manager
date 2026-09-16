// ============================================================================
// webdav.js — WebDAV (对应原版 routes/webdav.rs), 后端替换为 D1 虚拟文件系统
// 支持: OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY
// 认证: Basic (用户名 + AUTH_PASSWORD / AUTH_PASSWORD_HASH)
// ============================================================================

import { sanitizeRel, mimeFromName, subtreeMatch } from './util.js';
import { getNode, serveFileContent, ensureDirs, moveNode, invalidateFileCache,
  ihRefs, ihRefsMessage, syncIhOnOverwrite } from './vfs.js';
import { verifyCredentials } from './auth.js';
import { dbById, pickDb, capacityResponse, bumpUsage } from './storage.js';
import { collectFileRows, deleteBlobKeys, copyBlobKeys } from './blobops.js';

const NODE_COLS = 'path, parent, name, is_dir, size, mime, created_at, modified_at, nchunks, db_id';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Destination 头提取路径 (支持完整 URL / 绝对路径)
function extractDestPath(destHeader) {
  let s = (destHeader || '').trim();
  const scheme = s.indexOf('://');
  if (scheme !== -1) {
    const slash = s.indexOf('/', scheme + 3);
    s = slash === -1 ? '' : s.slice(slash);
  }
  return s.replace(/^\/dav\/?/, '').replace(/^\/+/, '');
}

async function checkBasicAuth(req, env, db) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    // 与登录共用 users 表凭据 (含 60s 内存缓存)
    return !!(await verifyCredentials(db, env, user, pass));
  } catch { return false; }
}

export async function webdavHandler(req, env, db, relPath) {
  const method = req.method;
  // OPTIONS 必须免认证: Windows WebClient 挂载前先发未认证的 OPTIONS 探测 DAV 支持
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND',
        DAV: '1',
        'MS-Author-Via': 'DAV',
      },
    });
  }
  if (!(await checkBasicAuth(req, env, db))) {
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="File Manager"' } });
  }

  const clean = sanitizeRel(decodeURIComponent(relPath || ''));

  switch (method) {
    case 'PROPFIND': return propfind(db, clean);
    case 'GET': {
      if (!clean) return propfind(db, '');
      const node = await getNode(db, clean);
      if (!node) return new Response(null, { status: 404 });
      if (node.is_dir) return propfind(db, clean);
      return serveFileContent(req, env, db, {
        key: 'f:' + node.path, size: node.size, mime: node.mime || mimeFromName(node.name),
        filename: node.name, inline: true, cacheTtl: 60, cacheKeyPrefix: 'dav', nchunks: node.nchunks,
        db_id: node.db_id || 1,
      });
    }
    case 'HEAD': {
      const node = await getNode(db, clean);
      if (!node || node.is_dir) return new Response(null, { status: node && !node.is_dir ? 200 : 404 });
      return new Response(null, {
        headers: {
          'Content-Type': node.mime || mimeFromName(node.name),
          'Content-Length': String(node.size),
        },
      });
    }
    case 'PUT': return davPut(req, env, db, clean);
    case 'DELETE': return davDelete(db, env, clean);
    case 'MKCOL': return davMkcol(db, clean);
    case 'MOVE': return davMoveCopy(req, env, db, clean, true);
    case 'COPY': return davMoveCopy(req, env, db, clean, false);
    default: return new Response(null, { status: 405 });
  }
}

function propNodeXml(href, node) {
  const isDir = !!node.is_dir;
  const size = isDir ? 0 : node.size;
  return [
    '<D:response>',
    `<D:href>/dav/${xmlEscape(href)}</D:href>`,
    '<D:propstat><D:prop>',
    '<D:resourcetype>',
    isDir ? '<D:collection/>' : '',
    '</D:resourcetype>',
    isDir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`,
    `<D:getcontenttype>${isDir ? 'httpd/unix-directory' : xmlEscape(node.mime || mimeFromName(node.name))}</D:getcontenttype>`,
    `<D:getlastmodified>${xmlEscape(node.modified_at || new Date().toISOString())}</D:getlastmodified>`,
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
    '</D:response>',
  ].join('');
}

const ROOT_NODE = { is_dir: 1, name: '', mime: 'httpd/unix-directory', modified_at: new Date().toISOString() };

async function propfind(db, clean) {
  const parts = [];
  if (clean) {
    const self = await getNode(db, clean);
    if (!self) return new Response(null, { status: 404 });
    parts.push(propNodeXml(clean, self));
  } else {
    parts.push(propNodeXml('', ROOT_NODE));
  }
  // Depth 1: 列子项
  let children = [];
  if (clean) {
    const rows = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE parent = ?1`).bind(clean).all();
    children = rows.results || [];
  } else {
    const rows = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE parent = ''`).all();
    children = rows.results || [];
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
    parts.join('') +
    children.map((c) => propNodeXml(clean ? `${clean}/${c.name}` : c.name, c)).join('') +
    '</D:multistatus>';
  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

async function davPut(req, env, db, clean) {
  if (!clean) return new Response(null, { status: 400 });
  const sp = { path: clean };
  const i = clean.lastIndexOf('/');
  const parent = i === -1 ? '' : clean.slice(0, i);
  const name = clean.slice(i + 1);
  // 覆盖写前取旧元数据, 供内容缓存失效
  const old = await getNode(db, clean);
  // 自动补齐父目录 (与原版 create_dir_all 一致)
  await ensureDirs(db, parent);

  // 选库: 覆盖写沿用原文件所在的库 (不产生跨库搬迁); 新文件按 Content-Length 预检。
  // WebDAV 是流式请求, 长度未知时挑一个装得下的库, 真写满由 D1 的 7500 报错兜底。
  const declared = parseInt(req.headers.get('Content-Length') || '0', 10) || 0;
  let targetId = old && !old.is_dir ? (old.db_id || 1) : 0;
  let vdb = targetId ? dbById(env, targetId) : null;
  if (!vdb) {
    const need = declared + 1024 * 1024;
    const picked = await pickDb(env, db, need);
    if (!picked.ok) return capacityResponse(db, need, picked);
    targetId = picked.row.id;
    vdb = picked.db;
  }

  // 流式分片写入, 内存占用恒定
  const max = 200 * 1024 * 1024;
  const reader = req.body.getReader();
  const blobStmts = [];   // 字节侧: 在目标库上执行
  let size = 0;
  let idx = 0;
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) return new Response(null, { status: 413 });
    const merged = new Uint8Array(buf.length + value.length);
    merged.set(buf); merged.set(value, buf.length);
    buf = merged;
    while (buf.length >= 1024 * 1024) {
      blobStmts.push(vdb.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1,?2,?3)').bind('f:' + sp.path, idx++, buf.slice(0, 1024 * 1024)));
      buf = buf.slice(1024 * 1024);
    }
  }
  if (buf.length || idx === 0) {
    blobStmts.push(vdb.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1,?2,?3)').bind('f:' + sp.path, idx++, buf));
  }
  const now = new Date().toISOString();
  blobStmts.push(vdb.prepare('DELETE FROM blobs WHERE key = ?1 AND idx >= ?2').bind('f:' + sp.path, idx));
  // 覆盖写时内容已变, 旧缩略图作废
  blobStmts.push(vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + sp.path));
  // 字节先落 (单库 batch 原子)
  await vdb.batch(blobStmts);
  // 元数据后写 (I5): 此刻字节已经就位, 才让文件对用户可见
  await db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7,?8)')
    .bind(clean, parent, name, size, mimeFromName(name), now, idx, targetId).run();
  await bumpUsage(db, targetId, size - (old && !old.is_dir ? old.size : 0));
  if (old && !old.is_dir) await invalidateFileCache(clean, old.size);
  // 被图床引用的源文件被覆盖: 直链内容跟随变化
  if (old && !old.is_dir) await syncIhOnOverwrite(db, clean, size, old.size);
  return new Response(null, { status: 201 });
}

async function davDelete(db, env, clean) {
  if (!clean) return new Response(null, { status: 403 });
  const node = await getNode(db, clean);
  if (!node) return new Response(null, { status: 404 });
  // 图床零拷贝引用: 字节只有这一份, 删除前先要求解除引用
  const refs = await ihRefs(db, clean);
  if (refs.length) {
    return new Response(ihRefsMessage(refs, node.is_dir), {
      status: 409,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  // I5: 元数据先删 (此后用户不可见), 再按归属库删字节; 失败只留孤儿, 由 journal 重试收敛
  const files = await collectFileRows(db, clean);
  await db.prepare(`DELETE FROM fs_nodes WHERE ${subtreeMatch('path')}`).bind(clean).run();
  if (files.length) {
    await deleteBlobKeys(db, env, files);
    const per = new Map();
    for (const f of files) {
      const id = f.db_id || 1;
      per.set(id, (per.get(id) || 0) + (f.size || 0));
    }
    for (const [id, delta] of per) await bumpUsage(db, id, -delta);
  }
  if (!node.is_dir) await invalidateFileCache(clean, node.size);
  return new Response(null, { status: 200 });
}

async function davMkcol(db, clean) {
  if (!clean) return new Response(null, { status: 403 });
  if (await getNode(db, clean)) return new Response(null, { status: 405 });
  const i = clean.lastIndexOf('/');
  const parent = i === -1 ? '' : clean.slice(0, i);
  if (parent && !(await getNode(db, parent))) return new Response(null, { status: 409 });
  await ensureDirs(db, clean);
  return new Response(null, { status: 201 });
}

async function davMoveCopy(req, env, db, srcClean, isMove) {
  if (!srcClean) return new Response(null, { status: 403 });
  const src = await getNode(db, srcClean);
  if (!src) return new Response(null, { status: 404 });
  const destRel = extractDestPath(req.headers.get('Destination'));
  const dest = sanitizeRel(destRel);
  if (!dest || dest === srcClean) return new Response(null, { status: 400 });
  const i = dest.lastIndexOf('/');
  const destParent = i === -1 ? '' : dest.slice(0, i);
  const destName = dest.slice(i + 1);
  if (src.is_dir && dest.startsWith(srcClean + '/')) return new Response(null, { status: 400 });
  if (await getNode(db, dest)) return new Response(null, { status: 412 });

  await ensureDirs(db, destParent);

  if (isMove) {
    const r = await moveNode(db, env, srcClean, destParent, destName);
    if (r.error) return new Response(null, { status: 400 });
  } else {
    // COPY: 字节留在源文件各自的库 (同库 INSERT..SELECT, 字节不过 Worker 内存), 元数据最后写 (I5)
    const now = new Date().toISOString();
    if (src.is_dir) {
      const sub = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE ${subtreeMatch('path')}`).bind(srcClean).all();
      const off = srcClean.length;
      const stmts = [];
      const pairs = [];
      for (const r of sub.results || []) {
        const np = dest + r.path.slice(off);
        const npParent = r.path === srcClean ? destParent : dest + r.parent.slice(off);
        const nName = r.path === srcClean ? destName : r.name;
        stmts.push(db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)')
          .bind(np, npParent, nName, r.is_dir, r.size, r.mime, r.created_at, now, r.nchunks, r.db_id || 1));
        if (!r.is_dir) pairs.push({ src: r.path, dst: np, db_id: r.db_id || 1 });
      }
      if (pairs.length) await copyBlobKeys(db, env, pairs);
      await db.batch(stmts);
    } else {
      await copyBlobKeys(db, env, [{ src: srcClean, dst: dest, db_id: src.db_id || 1 }]);
      await db.batch([
        db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks,db_id) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7,?8)')
          .bind(dest, destParent, destName, src.size, src.mime, now, src.nchunks, src.db_id || 1),
      ]);
    }
  }
  return new Response(null, { status: 201 });
}
