// ============================================================================
// webdav.js — WebDAV (对应原版 routes/webdav.rs), 后端替换为 D1 虚拟文件系统
// 支持: OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / MOVE / COPY
// 认证: Basic (用户名 + AUTH_PASSWORD / AUTH_PASSWORD_HASH)
// ============================================================================

import { sanitizeRel, mimeFromName } from './util.js';
import { getNode, serveFileContent, ensureDirs, moveNode, invalidateFileCache,
  ihRefs, ihRefsMessage, syncIhOnOverwrite } from './vfs.js';
import { verifyCredentials } from './auth.js';

const NODE_COLS = 'path, parent, name, is_dir, size, mime, created_at, modified_at, nchunks';

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
    case 'PUT': return davPut(req, db, clean);
    case 'DELETE': return davDelete(db, clean);
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

async function davPut(req, db, clean) {
  if (!clean) return new Response(null, { status: 400 });
  const sp = { path: clean };
  const i = clean.lastIndexOf('/');
  const parent = i === -1 ? '' : clean.slice(0, i);
  const name = clean.slice(i + 1);
  // 覆盖写前取旧元数据, 供内容缓存失效
  const old = await getNode(db, clean);
  // 自动补齐父目录 (与原版 create_dir_all 一致)
  await ensureDirs(db, parent);

  // 流式分片写入, 内存占用恒定
  const max = 200 * 1024 * 1024;
  const reader = req.body.getReader();
  const stmts = [];
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
      stmts.push(db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1,?2,?3)').bind('f:' + sp.path, idx++, buf.slice(0, 1024 * 1024)));
      buf = buf.slice(1024 * 1024);
    }
  }
  if (buf.length || idx === 0) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO blobs (key, idx, data) VALUES (?1,?2,?3)').bind('f:' + sp.path, idx++, buf));
  }
  const now = new Date().toISOString();
  stmts.push(db.prepare('DELETE FROM blobs WHERE key = ?1 AND idx >= ?2').bind('f:' + sp.path, idx));
  // 覆盖写时内容已变, 旧缩略图作废
  stmts.push(db.prepare('DELETE FROM blobs WHERE key = ?1').bind('t:' + sp.path));
  stmts.push(db.prepare('INSERT OR REPLACE INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7)')
    .bind(clean, parent, name, size, mimeFromName(name), now, idx));
  await db.batch(stmts);
  if (old && !old.is_dir) await invalidateFileCache(clean, old.size);
  // 被图床引用的源文件被覆盖: 直链内容跟随变化
  if (old && !old.is_dir) await syncIhOnOverwrite(db, clean, size, old.size);
  return new Response(null, { status: 201 });
}

async function davDelete(db, clean) {
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
  await db.batch([
    db.prepare('DELETE FROM blobs WHERE key IN (SELECT \'f:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(clean),
    db.prepare('DELETE FROM blobs WHERE key IN (SELECT \'t:\' || path FROM fs_nodes WHERE (path = ?1 OR path LIKE ?1 || \'/%\') AND is_dir = 0)').bind(clean),
    db.prepare('DELETE FROM fs_nodes WHERE path = ?1 OR path LIKE ?1 || \'/%\'').bind(clean),
  ]);
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
    const r = await moveNode(db, srcClean, destParent, destName);
    if (r.error) return new Response(null, { status: 400 });
  } else {
    // COPY: 元数据 + blob 各一条 SELECT..INSERT
    const now = new Date().toISOString();
    if (src.is_dir) {
      const sub = await db.prepare(`SELECT ${NODE_COLS} FROM fs_nodes WHERE path = ?1 OR path LIKE ?1 || '/%'`).bind(srcClean).all();
      const off = srcClean.length;
      const stmts = [];
      for (const r of sub.results || []) {
        const np = dest + r.path.slice(off);
        const npParent = r.path === srcClean ? destParent : dest + r.parent.slice(off);
        const nName = r.path === srcClean ? destName : r.name;
        stmts.push(db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
          .bind(np, npParent, nName, r.is_dir, r.size, r.mime, r.created_at, now, r.nchunks));
        if (!r.is_dir) {
          stmts.push(db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?, idx, data FROM blobs WHERE key = ?').bind('f:' + np, 'f:' + r.path));
          stmts.push(db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?, idx, data FROM blobs WHERE key = ?').bind('t:' + np, 't:' + r.path));
        }
      }
      await db.batch(stmts);
    } else {
      await db.batch([
        db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('f:' + srcClean, 'f:' + dest),
        db.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('t:' + srcClean, 't:' + dest),
        db.prepare('INSERT INTO fs_nodes (path,parent,name,is_dir,size,mime,created_at,modified_at,nchunks) VALUES (?1,?2,?3,0,?4,?5,?6,?6,?7)')
          .bind(dest, destParent, destName, src.size, src.mime, now, src.nchunks),
      ]);
    }
  }
  return new Response(null, { status: 201 });
}
