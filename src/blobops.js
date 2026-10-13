// ============================================================================
// blobops.js — 跨库字节操作日志 (outbox)
//
// Stage 1 迁移后, 内容键 'c:<content_id>' 与路径彻底解耦:
//   - 改名/移动只更新 fs_nodes 元数据, 不再触碰 blobs
//   - 复制是零拷贝 (多行引用同一 content_id + 缩略图键 't:<cid>' 与路径无关)
// 因此原先的 collectFileRows / deleteBlobKeys / rewriteBlobKeys / copyBlobKeys
// 及其跨库改名补偿回滚机制**全部移除**。
//
// 本模块只剩 outbox: 字节删除失败时记一笔 (blob_journal), 由每日 cron 重试收敛,
// 避免在空间稀缺的 D1 上留下永久孤儿。
// ============================================================================

import { dbById } from './storage.js';

function placeholders(n, from = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('?' + (from + i));
  return out.join(',');
}

// ---------------- journal ----------------
// op='delete': old_key 待删; op='rename': old_key → new_key (Stage 1 后不再产生 rename)
export async function journalAdd(mainDb, op, dbId, pairs) {
  if (!pairs || !pairs.length) return;
  const now = Date.now();
  const stmts = pairs.map((p) => (
    typeof p === 'string'
      ? mainDb.prepare('INSERT INTO blob_journal (op, db_id, old_key, created_at) VALUES (?1,?2,?3,?4)').bind(op, dbId, p, now)
      : mainDb.prepare('INSERT INTO blob_journal (op, db_id, old_key, new_key, created_at) VALUES (?1,?2,?3,?4,?5)').bind(op, dbId, p.old_key, p.new_key || '', now)
  ));
  for (let i = 0; i < stmts.length; i += 40) await mainDb.batch(stmts.slice(i, i + 40));
}

export async function journalCount(mainDb) {
  try {
    const r = await mainDb.prepare('SELECT COUNT(*) AS c FROM blob_journal').first();
    return (r && r.c) || 0;
  } catch (e) { return 0; }
}

// cron 重试: 删除幂等; 改名重试到完成为止 (attempts 只做观测, 不做放弃判据)
export async function journalRetry(mainDb, env, limit = 200) {
  let rows;
  try {
    rows = await mainDb.prepare('SELECT id, op, db_id, old_key, new_key FROM blob_journal ORDER BY id LIMIT ?1').bind(limit).all();
  } catch (e) { return { processed: 0, cleared: 0 }; }
  const items = rows.results || [];
  const done = [];
  for (const it of items) {
    const vdb = dbById(env, it.db_id);
    if (!vdb) { done.push(it.id); continue; }   // binding 已不存在 → 放弃该条
    try {
      if (it.op === 'delete') {
        await vdb.prepare('DELETE FROM blobs WHERE key = ?1').bind(it.old_key).run();
      } else {
        await vdb.prepare('UPDATE blobs SET key = ?2 WHERE key = ?1').bind(it.old_key, it.new_key).run();
      }
      done.push(it.id);
    } catch (e) {
      await mainDb.prepare('UPDATE blob_journal SET attempts = attempts + 1 WHERE id = ?1').bind(it.id).run();
      break;  // 出错即停, 下轮再试 (避免整轮空转)
    }
  }
  if (done.length) {
    for (let i = 0; i < done.length; i += 40) {
      const slice = done.slice(i, i + 40);
      await mainDb.prepare(`DELETE FROM blob_journal WHERE id IN (${placeholders(slice.length)})`).bind(...slice).run();
    }
  }
  return { processed: items.length, cleared: done.length };
}
