// ============================================================================
// blobops.js — 跨库 blob 操作 (删除 / 改名 / 复制)
//
// 为什么单独一层: 单库时这些操作是一条 SQL 子查询搞定的, 分库后必须
// ① 按 db_id 分组, ② 受 D1「单查询最多 100 个绑定参数」限制分批,
// ③ 无跨库事务 → 改名失败必须补偿回滚, 补偿失败写 blob_journal 由 cron 收敛。
//
// 不变式 (与 storage.js 一致):
//   I1 一个文件的 f: 与 t: 永远同库
//   I5 删除: 元数据先删、字节后删 (失败只留孤儿); 改名: 字节先成、元数据后改
// ============================================================================

import { subtreeMatch } from './util.js';
import { dbById } from './storage.js';

// D1 单查询绑定参数上限 100; 每个路径贡献 2 个 key (f: / t:)
const PATH_BATCH = 40;

function groupByDb(rows) {
  const m = new Map();
  for (const r of rows) {
    const id = r.db_id || 1;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(r.path);
  }
  return m;
}

async function runBatched(vdb, paths, fn) {
  for (let i = 0; i < paths.length; i += PATH_BATCH) {
    await fn(paths.slice(i, i + PATH_BATCH));
  }
}

function placeholders(n, from = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('?' + (from + i));
  return out.join(',');
}

// ---------------- journal ----------------
// op='delete': old_key 待删; op='rename': old_key → new_key
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

// ---------------- 元数据查询 (主库) ----------------
// 收集一条路径(含整棵子树)下所有文件行: [{path, db_id, size}]
// size 用于调用方按归属库做用量记帐
export async function collectFileRows(mainDb, cleanPath) {
  const r = await mainDb.prepare(
    `SELECT path, db_id, size FROM fs_nodes WHERE (${subtreeMatch('path')}) AND is_dir = 0`,
  ).bind(cleanPath).all();
  return r.results || [];
}

// 显式给定路径列表 (只查这几条, 不递归)
export async function fileRowsOf(mainDb, paths) {
  if (!paths.length) return [];
  const out = [];
  for (let i = 0; i < paths.length; i += 40) {
    const slice = paths.slice(i, i + 40);
    const r = await mainDb.prepare(
      `SELECT path, db_id FROM fs_nodes WHERE is_dir = 0 AND path IN (${placeholders(slice.length)})`,
    ).bind(...slice).all();
    out.push(...(r.results || []));
  }
  return out;
}

// ---------------- 删除 ----------------
// 按库分组删除 f: 与 t:; 失败的写 journal 等 cron 重试 (删除幂等)
export async function deleteBlobKeys(mainDb, env, fileRows) {
  if (!fileRows || !fileRows.length) return 0;
  const byDb = groupByDb(fileRows);
  let failedCount = 0;
  for (const [dbId, paths] of byDb) {
    const vdb = dbById(env, dbId) || mainDb;
    await runBatched(vdb, paths, async (slice) => {
      const keys = slice.flatMap((p) => ['f:' + p, 't:' + p]);
      try {
        await vdb.prepare(`DELETE FROM blobs WHERE key IN (${placeholders(keys.length)})`).bind(...keys).run();
      } catch (e) {
        failedCount += keys.length;
        await journalAdd(mainDb, 'delete', dbId, keys);
      }
    });
  }
  return failedCount;
}

// ---------------- 改名 / 移动 ----------------
// key = 'f:'|'t:' + 路径 ; 子树改名 = 保留前 2 字符前缀 + 新前缀 + 剩余部分
function renameStmts(vdb, paths, fromP, toP) {
  const off = 3 + fromP.length;   // 'f:' 占 1-2, fromP 占 3..(2+len), 剩余从 3+len 开始
  const keys = paths.flatMap((p) => ['f:' + p, 't:' + p]);
  const sql = `UPDATE blobs SET key = substr(key, 1, 2) || ?1 || substr(key, ?2) WHERE key IN (${placeholders(keys.length, 3)})`;
  return vdb.prepare(sql).bind(toP, off, ...keys);
}

// 返回 { ok:true } 或 { ok:false, error }
// fileRows 必须是"以 fromPath 为根"的文件行 (path 以 fromPath 开头)
export async function rewriteBlobKeys(mainDb, env, fileRows, fromPath, toPath) {
  if (!fileRows || !fileRows.length) return { ok: true };
  if (fromPath === toPath) return { ok: true };
  const byDb = groupByDb(fileRows);
  const entries = [...byDb.entries()];

  // 单库 (含上线初期的常态): 与改造前的行为等价, batch 原子, 无补偿需求
  if (entries.length === 1) {
    const [dbId, paths] = entries[0];
    const vdb = dbById(env, dbId) || mainDb;
    try {
      await runBatched(vdb, paths, async (slice) => {
        await vdb.batch([renameStmts(vdb, slice, fromPath, toPath)]);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '改名失败' };
    }
  }

  // 跨库: 逐库执行; 任一失败立即把已成功的库改回去, 保证与 fs_nodes 仍然一致
  const done = [];
  for (const [dbId, paths] of entries) {
    const vdb = dbById(env, dbId) || mainDb;
    try {
      await runBatched(vdb, paths, async (slice) => {
        await vdb.batch([renameStmts(vdb, slice, fromPath, toPath)]);
      });
      done.push({ dbId, paths, vdb });
    } catch (e) {
      for (const d of done) {
        try {
          await runBatched(d.vdb, d.paths, async (slice) => {
            await d.vdb.batch([renameStmts(d.vdb, slice, toPath, fromPath)]);
          });
        } catch (e2) {
          // 回滚也失败 → 交给 cron 收敛回旧 key (与 fs_nodes 保持一致)
          const pairs = d.paths.flatMap((p) => ['f:' + p, 't:' + p]);
          await journalAdd(mainDb, 'rename', d.dbId, pairs.map((k) => ({
            old_key: k.replace(/^([ft]:)(.+)$/, (_, pfx, rest) => pfx + toPath + rest.slice(fromPath.length)),
            new_key: k,
          })));
        }
      }
      return { ok: false, error: '跨库改名失败（已回滚，请重试）' };
    }
  }
  return { ok: true };
}

// ---------------- 复制 ----------------
// pairs: [{ src, dst, db_id }] —— 复制的目标是新文件, 刻意留在**源文件所在的库**,
// 这样 INSERT..SELECT 是同库搬运 (字节不过 Worker 内存, 零成本)。
export async function copyBlobKeys(mainDb, env, pairs) {
  if (!pairs || !pairs.length) return;
  const byDb = new Map();
  for (const p of pairs) {
    const id = p.db_id || 1;
    if (!byDb.has(id)) byDb.set(id, []);
    byDb.get(id).push(p);
  }
  const done = [];
  try {
    for (const [dbId, items] of byDb) {
      const vdb = dbById(env, dbId) || mainDb;
      for (let i = 0; i < items.length; i += 20) {
        const slice = items.slice(i, i + 20);
        const stmts = slice.flatMap((it) => [
          vdb.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('f:' + it.src, 'f:' + it.dst),
          vdb.prepare('INSERT INTO blobs (key, idx, data) SELECT ?2, idx, data FROM blobs WHERE key = ?1').bind('t:' + it.src, 't:' + it.dst),
        ]);
        await vdb.batch(stmts);
      }
      done.push({ dbId, vdb, dsts: items.map((it) => it.dst) });
    }
  } catch (e) {
    // 补偿: 复制出来的目标 key 全是新建的, 删掉不会伤及原有数据。
    // 不做补偿的话, 失败会留下没有元数据引用的孤儿字节 —— 而空间正是这里的稀缺资源。
    for (const d of done) {
      const keys = d.dsts.flatMap((x) => ['f:' + x, 't:' + x]);
      for (let i = 0; i < keys.length; i += 40) {
        const slice = keys.slice(i, i + 40);
        try {
          await d.vdb.prepare(`DELETE FROM blobs WHERE key IN (${placeholders(slice.length)})`).bind(...slice).run();
        } catch (e2) {
          await journalAdd(mainDb, 'delete', d.dbId, slice);
        }
      }
    }
    throw e;
  }
}
