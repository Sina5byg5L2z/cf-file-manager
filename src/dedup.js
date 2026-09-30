// ============================================================================
// dedup.js — 内容寻址去重 (秒传)
//
// 存储模型 (2026-09-30 起, 见 migrations/2026-09-30-content-dedup.sql):
//   新上传的字节落在 blobs 的内容键 'c:<content_id>' 下, fs_nodes / image_host
//   通过 content_id 列引用同一份字节 —— 多个文件条目共享一份存储。
//   contents 表是 (hash, size) → content_id 的去重索引, 由前端算好的全文件
//   SHA-256 驱动秒传探测。content_id 为 NULL 的行 = 历史数据, 仍按 'f:<path>'
//   旧键读写 (不搬迁, 覆盖后自然转新格式)。
//
// 引用计数:
//   动态统计 fs_nodes + image_host 两张表的 content_id 引用数, 不单独建计数表
//   (避免计数与实际引用漂移)。删除方在元数据行删除**之后**统计, 归零才删字节。
//
// 与删除方的竞态防护:
//   删除方把「删 fs_nodes/image_host 行 + 删 contents 行」放在主库同一个 batch
//   (单事务); 秒传落库的 INSERT..SELECT 带 WHERE EXISTS(contents) 守卫 ——
//   引用行绝不落在已被回收的内容上。
//
// 不变式 (承接 storage.js):
//   I1 t:<path> 缩略图与节点的 db_id 同库 (节点 db_id = 其内容的 db_id)
//   I2 暂存 u:<id> 与合并目标 'c:<cid>' 同库 (upload_sessions.db_id 钉住)
//   I5 字节先落、元数据后写; 删除时元数据先删、字节后删
// ============================================================================

import { randomId } from './util.js';
import { dbById, bumpUsage } from './storage.js';

export function randomCid() { return randomId(16); }

// 节点的字节键: 内容寻址行 → 'c:<id>'; 历史行 → 'f:<path>'
export function blobKeyOf(node) {
  return node.content_id ? 'c:' + node.content_id : 'f:' + node.path;
}

export function isValidHash(s) {
  return /^[0-9a-f]{64}$/.test(String(s || '').toLowerCase());
}

// (hash, size) → contents 行; 查不到返回 null
export async function findContent(db, hash, size) {
  if (!isValidHash(hash)) return null;
  const row = await db.prepare('SELECT id, size, db_id, nchunks FROM contents WHERE hash = ?1 AND size = ?2')
    .bind(String(hash).toLowerCase(), size).first();
  return row || null;
}

// 内容字节是否真实存在 (防御: 索引行在但分片被异常清空的历史数据)
export async function contentBytesExist(env, db, content) {
  const vdb = dbById(env, content.db_id || 1) || db;
  const head = await vdb.prepare('SELECT 1 AS ok FROM blobs WHERE key = ?1 AND idx = 0').bind('c:' + content.id).first();
  return !!head;
}

// content_id 当前的引用数 (fs_nodes + image_host)
export async function contentRefs(db, cid) {
  const a = await db.prepare('SELECT COUNT(*) AS c FROM fs_nodes WHERE content_id = ?1').bind(cid).first();
  const b = await db.prepare('SELECT COUNT(*) AS c FROM image_host WHERE content_id = ?1').bind(cid).first();
  return ((a && a.c) || 0) + ((b && b.c) || 0);
}

// 引用归零时回收内容: 删字节 + 删去重索引行 + 用量记帐。
// 调用方必须**先删完引用方的元数据行**再调这里 (refcount 才会归零)。
// 返回 true = 真的回收了字节 (调用方据此避免重复记帐)。
export async function dropContentIfOrphan(db, env, cid, dbId, size) {
  if (!cid) return false;
  if ((await contentRefs(db, cid)) > 0) return false;
  const vdb = dbById(env, dbId || 1) || db;
  await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind('c:' + cid).run();
  await db.prepare('DELETE FROM contents WHERE id = ?1').bind(cid).run();
  await bumpUsage(db, dbId || 1, -(size || 0));
  return true;
}

// 注册去重索引。唯一索引冲突 (并发上传同内容) 时静默放弃 —— 先到者赢,
// 后到者的字节会因为没有索引行而无法被秒传命中, 由引用计数正常管理。
export async function registerContent(db, { id, hash, size, dbId, nchunks }) {
  if (!isValidHash(hash)) return;
  try {
    await db.prepare('INSERT INTO contents (id, hash, size, db_id, nchunks, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(id, String(hash).toLowerCase(), size, dbId || 1, nchunks || 0, new Date().toISOString()).run();
  } catch (e) { /* 唯一索引冲突: 先到者赢 */ }
}
