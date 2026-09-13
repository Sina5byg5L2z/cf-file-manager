// ============================================================================
// index.js — 路由总装 (对应原版 main.rs)
// 静态资源由 Workers Assets 直接命中(不进 Worker); 其余请求进入本路由
// ============================================================================

import { json, jerr } from './util.js';
import * as auth from './auth.js';
import * as vfs from './vfs.js';
import * as ih from './imagehost.js';
import * as share from './share.js';
import * as dav from './webdav.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('unhandled:', e && e.stack || e);
      return jerr('服务器内部错误', 500);
    }
  },

  // 每日清理: 24h 前的孤儿上传暂存分片与会话
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const stale = await env.DB.prepare('SELECT id FROM upload_sessions WHERE created_at < ?1').bind(cutoff).all();
    for (const row of stale.results || []) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM blobs WHERE key = ?1').bind('u:' + row.id),
        env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(row.id),
      ]);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  // ---------- 健康检查 ----------
  if (path === '/api/health' && method === 'GET') {
    return json({ status: 'ok', version: '1.0.0-cf' });
  }

  // ---------- 认证 ----------
  if (path === '/api/login' && method === 'POST') return auth.login(request, env, db);
  if (path === '/api/me' && method === 'GET') return auth.me(request, env);

  // ---------- 分享公开页 (无需登录) ----------
  const shareMatch = path.match(/^\/s\/([A-Za-z0-9]+)$/);
  if (shareMatch && method === 'GET') {
    const url2 = new URL(request.url);
    const actionable = ['data', 'download', 'thumb', 'sub_path', 'quality', 'prepare', 'qualities']
      .some((k) => url2.searchParams.has(k));
    if (!actionable) return assets(request, env, '/share.html');
    return share.accessShare(request, env, db, shareMatch[1], url2);
  }

  // ---------- 图床公开直链 (无需登录) ----------
  if (path.startsWith('/i/') && method === 'GET') {
    return ih.serveImage(request, env, db, decodeURIComponent(path.slice(3)));
  }

  // ---------- WebDAV (Basic 认证, 自行鉴权) ----------
  if (path === '/dav' || path.startsWith('/dav/')) {
    return dav.webdavHandler(request, env, db, path.slice(4));
  }

  // ---------- 页面入口 ----------
  if (method === 'GET') {
    if (path === '/') return assets(request, env, '/index.html');
    if (path === '/app') return assets(request, env, '/app.html');
  }

  // ---------- 以下 API 均需 JWT ----------
  // 表单提交的打包下载无法携带 Authorization 头, 由 handler 校验表单 token 字段
  const isFormBatchDl = path === '/api/files/batch-download' && method === 'POST'
    && !(request.headers.get('Content-Type') || '').includes('application/json');
  if (!isFormBatchDl) {
    const denied = await auth.checkAuth(request, env);
    if (denied) return denied;
  }

  // 账号设置 (改用户名/密码)
  if (path === '/api/account/password' && method === 'POST') return auth.changePassword(request, env, db);
  if (path === '/api/account/username' && method === 'POST') return auth.changeUsername(request, env, db);

  // 文件管理器
  if (path === '/api/files' && method === 'GET') return vfs.listFiles(request, env, db, url);
  if (path === '/api/files/download' && method === 'GET') return vfs.downloadFile(request, env, db, url);
  if (path === '/api/files/upload' && method === 'POST') return vfs.uploadFile(request, env, db, url);
  if (path === '/api/files/mkdir' && method === 'POST') return vfs.mkdir(request, env, db, url);
  if (path === '/api/files' && method === 'DELETE') return vfs.deleteFile(request, env, db, url);
  if (path === '/api/files/rename' && method === 'PUT') return vfs.rename(request, env, db);
  if (path === '/api/files/move' && method === 'PUT') return vfs.moveFile(request, env, db);
  if (path === '/api/files/copy' && method === 'PUT') return vfs.copyFile(request, env, db);
  if (path === '/api/files/batch-delete' && method === 'POST') return vfs.batchDelete(request, env, db);
  if (path === '/api/files/batch-download' && method === 'POST') return vfs.batchDownload(request, env, db);
  if (path === '/api/files/upload/init' && method === 'POST') return vfs.uploadInit(request, env, db);
  if (path === '/api/files/upload/chunk' && method === 'POST') return vfs.uploadChunk(request, env, db);
  if (path === '/api/files/upload/complete' && method === 'POST') return vfs.uploadComplete(request, env, db);

  // 预览 / 搜索 / 缩略图
  if (path === '/api/preview' && method === 'GET') return vfs.previewFile(request, env, db, url);
  if (path === '/api/thumbnail' && method === 'GET') return vfs.thumbnail(request, env, db, url);
  if (path === '/api/thumbnail' && method === 'POST') return vfs.uploadThumbnail(request, env, db);
  if (path === '/api/search' && method === 'GET') return vfs.searchFiles(request, env, db, url);

  // 视频清晰度 (降级: 仅原片)
  if (path === '/api/video/qualities' && method === 'GET') return vfs.videoQualities(request, env, db, url);
  if (path === '/api/video/prepare' && method === 'GET') return vfs.videoPrepare(request, env, db, url);
  if (path === '/api/video' && method === 'GET') return vfs.videoServe(request, env, db, url);

  // 分享管理
  if (path === '/api/share' && method === 'POST') return share.createShare(request, env, db);
  if (path === '/api/shares' && method === 'GET') return share.listShares(request, env, db);
  const shareDel = path.match(/^\/api\/share\/([A-Za-z0-9]+)$/);
  if (shareDel && method === 'DELETE') return share.deleteShare(request, env, db, shareDel[1]);

  // 图床
  if (path === '/api/image-host/upload' && method === 'POST') return ih.upload(request, env, db);
  if (path === '/api/image-host/upload/init' && method === 'POST') return ih.uploadInit(request, env, db);
  if (path === '/api/image-host/upload/chunk' && method === 'POST') return vfs.uploadChunk(request, env, db); // 与文件分片共用
  if (path === '/api/image-host/upload/complete' && method === 'POST') return vfs.uploadComplete(request, env, db);
  if (path === '/api/image-host/import' && method === 'POST') return ih.importFromFiles(request, env, db);
  if (path === '/api/image-host/list' && method === 'GET') return ih.list(request, env, db, url);
  const ihDel = path.match(/^\/api\/image-host\/(.+)$/);
  if (ihDel && method === 'DELETE') return ih.deleteImage(request, env, db, decodeURIComponent(ihDel[1]));

  return jerr('Not found', 404);
}

// 经 Assets 绑定取内部页面 (assets 目录下真实文件名)
function assets(_req, env, assetPath) {
  return env.ASSETS.fetch(new Request('https://assets.internal' + assetPath));
}
