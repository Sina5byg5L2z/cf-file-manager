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
import * as settings from './settings.js';
import * as storageApi from './storage.js';
import * as blobops from './blobops.js';
import * as lyrics from './lyrics.js';
import * as trackmeta from './trackmeta.js';
import * as translate from './translate.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('unhandled:', e && e.stack || e);
      return jerr('服务器内部错误', 500);
    }
  },

  // 每日清理: 长期未活动的孤儿上传暂存分片与会话
  // 判据用 updated_at (而非 created_at): 断点续传的会话可能创建很久但仍在续传,
  // 只要有分片写入就会刷新 updated_at, 不会被误删。
  // 旧数据 updated_at = 0 → 回退用 created_at 判断。
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const stale = await env.DB.prepare(
      'SELECT id, db_id FROM upload_sessions WHERE (updated_at > 0 AND updated_at < ?1) OR (updated_at = 0 AND created_at < ?1)',
    ).bind(cutoff).all();
    for (const row of stale.results || []) {
      // 暂存分片在会话钉住的库里, 会话行在主库 —— 分两处删
      const vdb = storageApi.dbById(env, row.db_id || 1) || env.DB;
      await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('u:' + row.id).run();
      await env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(row.id).run();
    }
    // 跨库改名/删除失败留下的待办: 重试到收敛 (孤儿字节与回滚失败的半改名都在这里消化)
    const retry = await blobops.journalRetry(env.DB, env, 200);
    if (retry.processed) console.log('blob_journal retry:', JSON.stringify(retry));
    // 容量校准: 用 Cloudflare API 的真实 file_size 覆盖累加值 (未配置 CF_API_TOKEN 时自动跳过)
    const cal = await storageApi.calibrate(env.DB, env);
    if (!cal.ok) console.log('calibrate skipped:', cal.reason);
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
    // inline = 页内预览通道 (图片/视频/PDF 等), 必须回 inline 型 Content-Disposition,
    // 与 download 的 attachment 区分开; 缺了它请求会被当成纯页面返回 share.html
    // lyrics/cover = 分享页播放器的歌词与封面接口 (无需登录, 但沿用分享链接的鉴权与密码)
    const actionable = ['data', 'download', 'inline', 'thumb', 'sub_path', 'quality', 'prepare', 'qualities', 'lyrics', 'cover']
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

  // ---------- 应用参数设置读取 (公开: 仅 UI 参数, 无敏感信息; 分享页未登录也要用) ----------
  if (path === '/api/settings' && method === 'GET') return settings.getSettings(request, env, db);

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

  // 应用参数设置保存 (读取在上面公开区)
  if (path === '/api/settings' && method === 'PUT') return settings.saveSettings(request, env, db);

  // 存储分库管理 (库注册表 / 一键启用 / 注册新库 / 容量校准)
  if (path === '/api/storage' && method === 'GET') return storageApi.listDbs(request, env, db);
  if (path === '/api/storage/enable' && method === 'POST') return storageApi.enableNextDb(request, env, db);
  if (path === '/api/storage/register' && method === 'POST') return storageApi.registerDb(request, env, db);
  if (path === '/api/storage/calibrate' && method === 'POST') return storageApi.calibrateNow(request, env, db);
  const stMod = path.match(/^\/api\/storage\/(\d+)$/);
  if (stMod && method === 'PUT') return storageApi.updateDb(request, env, db, parseInt(stMod[1], 10));

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
  if (path === '/api/files/upload/status' && method === 'GET') return vfs.uploadStatus(request, env, db, url);
  if (path === '/api/files/upload/chunk' && method === 'POST') return vfs.uploadChunk(request, env, db);
  if (path === '/api/files/upload/complete' && method === 'POST') return vfs.uploadComplete(request, env, db);
  if (path === '/api/files/upload/abort' && method === 'POST') return vfs.uploadAbort(request, env, db);

  // 预览 / 搜索 / 缩略图
  if (path === '/api/preview' && method === 'GET') return vfs.previewFile(request, env, db, url);
  if (path === '/api/thumbnail' && method === 'GET') return vfs.thumbnail(request, env, db, url);
  if (path === '/api/thumbnail' && method === 'POST') return vfs.uploadThumbnail(request, env, db);
  if (path === '/api/search' && method === 'GET') return vfs.searchFiles(request, env, db, url);

  // 音乐: 歌曲元数据 (用户编辑的标题/歌手/歌词, 覆盖内嵌标签与文件名)
  if (path === '/api/track/meta' && method === 'GET') return trackmeta.getMeta(request, env, db, url);
  if (path === '/api/track/meta' && method === 'PUT') return trackmeta.putMeta(request, env, db);
  // 音乐: 歌词代理 (Worker 转发, 统一 UA/超时/降级/缓存)
  if (path === '/api/lyrics' && method === 'GET') return lyrics.getLyrics(request, env, db, url);
  if (path === '/api/lyrics/reject' && method === 'GET') return lyrics.listRejects(request, env, db, url);
  if (path === '/api/lyrics/reject' && method === 'POST') return lyrics.rejectLyrics(request, env, db);
  if (path === '/api/lyrics/reject' && method === 'DELETE') return lyrics.unRejectLyrics(request, env, db, url);
  if (path === '/api/cover' && method === 'GET') return lyrics.getCover(request, env, db, url);
  // 音乐: AI 翻译 (点击按钮触发, 走小模型; 结果写回 track_meta.trans)
  if (path === '/api/lyrics/translate' && method === 'POST') return translate.translateLyrics(request, env, db);

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
  if (path === '/api/image-host/upload/status' && method === 'GET') return vfs.uploadStatus(request, env, db, url);
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
