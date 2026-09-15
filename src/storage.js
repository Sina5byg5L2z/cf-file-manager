// ============================================================================
// storage.js — 存储分库路由层
//
// 模型: 元数据 (fs_nodes / image_host / upload_sessions / storage_dbs ...) 永在主库;
//       文件字节 (blobs) 按 fs_nodes.db_id / image_host.db_id 分散到多个 D1 库。
//
// 核心约束 (详见 docs/d1-sharding-plan.md):
//   I1 一个文件的全部字节 (f:<path> 与它的 t:<path>) 必须在同一个库
//   I2 暂存 u:<id> 与它转正的 f:/i: 必须在同一个库 —— 由 upload_sessions.db_id 钉住,
//      一旦建了 session 就不再改库 (即使别的库更空)
//   I5 字节先落、元数据后写; 删除时元数据先删、字节后删
//
// id 与 binding 名恒等: 1='DB', 2='DB2', 3='DB3' ...
// 播种/注册时都由 binding 名反解 id, 因此路由不需要查表 (零 D1 读)。
// ============================================================================

import { json, jerr } from './util.js';

// storage_dbs 的进程内记忆窗口 (秒级抖动可接受, 避免每次请求都读一遍注册表)
const MEMO_MS = 30000;
let memo = { at: 0, rows: null };

export function resetStorageMemo() { memo = { at: 0, rows: null }; }

// ---------------- id ↔ binding ----------------
export function bindingOfId(id) { return id === 1 ? 'DB' : 'DB' + id; }

export function idOfBinding(binding) {
  const b = String(binding || '').trim().toUpperCase();
  if (b === 'DB') return 1;
  const m = /^DB(\d+)$/.exec(b);
  return m ? parseInt(m[1], 10) : 0;
}

// id → D1 binding; 取不到返回 null (调用方负责回退主库)
export function dbById(env, id) {
  if (!id || id === 1) return env.DB;
  return env[bindingOfId(id)] || null;
}

// 节点 → 它的字节所在库 (db_id 缺失/无效时回退主库)
export function dbOfNode(env, mainDb, node) {
  if (!node) return mainDb;
  return dbById(env, node.db_id || 1) || mainDb;
}

// ---------------- 注册表读取 ----------------
export async function storageRows(mainDb, force = false) {
  const now = Date.now();
  if (!force && memo.rows && now - memo.at < MEMO_MS) return memo.rows;
  const r = await mainDb.prepare(
    'SELECT id, binding, database_id, label, role, state, limit_bytes, reserve_bytes, used_bytes, calibrated_at, slot_quota FROM storage_dbs ORDER BY id',
  ).all();
  memo = { at: now, rows: r.results || [] };
  return memo.rows;
}

// 单个库的剩余可写字节: 上限 - 已用 - 预留
export function freeOf(row) {
  if (!row) return 0;
  return Math.max(0, (row.limit_bytes || 0) - (row.used_bytes || 0) - (row.reserve_bytes || 0));
}

export function effLimitOf(row) {
  if (!row) return 0;
  return Math.max(0, (row.limit_bytes || 0) - (row.reserve_bytes || 0));
}

// ---------------- 用量记帐 ----------------
// 累加值只作为即时判据; 每天 cron 用 Cloudflare API 的 file_size 校准一次 (calibrate)。
export async function bumpUsage(mainDb, dbId, delta) {
  if (!dbId || !delta) return;
  try {
    await mainDb.prepare('UPDATE storage_dbs SET used_bytes = MAX(0, used_bytes + ?2) WHERE id = ?1')
      .bind(dbId, Math.round(delta)).run();
    if (memo.rows) {
      const r = memo.rows.find((x) => x.id === dbId);
      if (r) r.used_bytes = Math.max(0, (r.used_bytes || 0) + Math.round(delta));
    }
  } catch (e) { /* 记帐失败不影响主流程, 下次校准会纠正 */ }
}

// ---------------- 选库 ----------------
// needBytes: 本次要占用的**净新增字节**。
// 上传时必须包含合并峰值 (MERGE_BATCH × chunk_size): mergeStagingBatch 是
// INSERT..SELECT + DELETE 在同一事务内, 新旧 key 短暂并存, 峰值不足会撞 7500。
export async function pickDb(env, mainDb, needBytes) {
  const rows = await storageRows(mainDb);
  const active = rows.filter((r) => r.state === 'active');
  for (const r of active) {
    if (freeOf(r) >= needBytes) {
      const db = dbById(env, r.id);
      if (db) return { ok: true, row: r, db };
    }
  }
  // 没有库装得下: 回报"最宽裕的那个库"用于告警展示
  const best = active.slice().sort((a, b) => freeOf(b) - freeOf(a))[0] || null;
  return { ok: false, reason: 'capacity', current: best, pool: poolOf(rows) };
}

export function poolOf(rows) {
  const primary = rows.find((r) => r.role === 'primary') || {};
  const live = rows.filter((r) => r.state !== 'retired');
  const active = rows.filter((r) => r.state === 'active');
  const standby = rows.filter((r) => r.state === 'standby');
  const quota = primary.slot_quota || live.length;
  return {
    active: active.length,
    standby: standby.length,
    used_slots: live.length,
    slot_quota: quota,
    slots_left: Math.max(0, quota - live.length),
    next_standby: (standby[0] && standby[0].label) || '',
  };
}

// 507 结构化容量错误: 前端按 pool 决定显示哪一态 (一键启用 / 添加新库 / 名额用尽)
export async function capacityResponse(mainDb, needBytes, picked) {
  const rows = await storageRows(mainDb);
  const pool = (picked && picked.pool) || poolOf(rows);
  const cur = (picked && picked.current) || rows.find((r) => r.role === 'primary') || null;
  const actions = ['cleanup', 'upgrade'];
  if (pool.standby > 0) actions.unshift('enable_next_db');
  else if (pool.slots_left > 0) actions.unshift('register_new_db');
  return json({
    error: '存储空间不足',
    code: 'D1_CAPACITY',
    need_bytes: needBytes,
    current: cur ? {
      db_id: cur.id,
      binding: cur.binding,
      label: cur.label,
      used_bytes: cur.used_bytes,
      limit_bytes: cur.limit_bytes,
      reserve_bytes: cur.reserve_bytes,
      free_bytes: freeOf(cur),
    } : null,
    pool,
    actions,
  }, 507);
}

// ---------------- 建表 / 注册 / 启用 ----------------
// 从库只需要 blobs 一张表 (与主库同结构, 去掉 hash 之外的一切)
const BLOBS_DDL = [
  'CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, hash TEXT, PRIMARY KEY (key, idx))',
];

export async function ensureBlobsTable(db) {
  for (const sql of BLOBS_DDL) await db.prepare(sql).run();
}

// ---------------- 容量校准 ----------------
// 用 Cloudflare REST API 的 file_size 覆盖累加值 (一次调用拿回全部库)。
// 需要同时配置 CF_API_TOKEN 与 CF_ACCOUNT_ID, 缺任一则静默跳过 —— 累加值继续用, 只是不会自我纠正。
export async function calibrate(mainDb, env) {
  const token = env && env.CF_API_TOKEN;
  const acct = env && env.CF_ACCOUNT_ID;
  if (!token || !acct) return { ok: false, reason: 'no_token' };
  let list;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    list = (body && body.result) || [];
  } catch (e) {
    return { ok: false, reason: 'fetch_failed' };
  }
  const byUuid = new Map(list.map((d) => [d.uuid, d]));
  const rows = await storageRows(mainDb, true);
  const now = Date.now();
  const updated = [];
  const stmts = [];
  for (const r of rows) {
    const d = byUuid.get(r.database_id);
    if (!d || typeof d.file_size !== 'number') continue;
    stmts.push(mainDb.prepare('UPDATE storage_dbs SET used_bytes = ?2, calibrated_at = ?3 WHERE id = ?1')
      .bind(r.id, d.file_size, now));
    updated.push({ id: r.id, binding: r.binding, file_size: d.file_size });
  }
  if (stmts.length) await mainDb.batch(stmts);
  resetStorageMemo();
  return { ok: true, updated };
}

// ============================================================================
// 管理接口 (由 index.js 路由到 /api/storage/*)
// ============================================================================

// GET /api/storage —— 库清单 + 名额池 + journal 待办
export async function listDbs(req, env, db) {
  const rows = await storageRows(db, true);
  let pending = 0;
  try {
    const r = await db.prepare('SELECT COUNT(*) AS c FROM blob_journal').first();
    pending = (r && r.c) || 0;
  } catch (e) { pending = 0; }
  const items = rows.map((r) => ({
    id: r.id,
    binding: r.binding,
    label: r.label,
    role: r.role,
    state: r.state,
    limit_bytes: r.limit_bytes,
    reserve_bytes: r.reserve_bytes,
    used_bytes: r.used_bytes,
    free_bytes: freeOf(r),
    calibrated_at: r.calibrated_at,
    live: !!dbById(env, r.id),   // binding 是否真的挂在 env 上 (未绑定/未部署时为 false)
  }));
  return json({
    items,
    pool: poolOf(rows),
    journal_pending: pending,
    calibrate_enabled: !!env.CF_API_TOKEN,
  });
}

// POST /api/storage/enable —— 把下一个 standby 库建表并启用 (一键扩容)
export async function enableNextDb(req, env, db) {
  const rows = await storageRows(db, true);
  const next = rows.filter((r) => r.state === 'standby').sort((a, b) => a.id - b.id)[0];
  if (!next) return jerr('没有可用的存储库了', 409);
  const vdb = dbById(env, next.id);
  if (!vdb) {
    return jerr(`存储库 「${next.label}」(${next.binding}) 尚未生效：请先在 wrangler.jsonc 的 d1_databases 里声明该 binding 并重新部署`, 400);
  }
  await ensureBlobsTable(vdb);
  await db.prepare("UPDATE storage_dbs SET state = 'active' WHERE id = ?1").bind(next.id).run();
  resetStorageMemo();
  return json({ ok: true, db_id: next.id, binding: next.binding, label: next.label });
}

// POST /api/storage/register —— 用户自行建库并部署后, 在应用内登记并立即启用
// 注意: binding 是部署期固定的, 运行时无法凭空新增 —— 这里只能登记「配置里已声明的」binding。
export async function registerDb(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const binding = String(body.binding || '').trim().toUpperCase();
  const id = idOfBinding(binding);
  if (!id) return jerr('binding 名无效（应为 DB、DB2、DB3 …）');
  const vdb = dbById(env, id);
  if (!vdb) {
    return jerr(`binding ${binding} 未生效：请先写入 wrangler.jsonc 的 d1_databases 并重新部署`, 400);
  }
  const rows = await storageRows(db, true);
  const exists = rows.find((r) => r.id === id);
  const pool = poolOf(rows);
  if (!exists && pool.slots_left <= 0) {
    return jerr(`已达到本项目可用库数上限（${pool.slot_quota} 个）`, 409);
  }
  await ensureBlobsTable(vdb);
  const now = Date.now();
  await db.prepare(
    "INSERT OR REPLACE INTO storage_dbs (id, binding, database_id, label, role, state, limit_bytes, reserve_bytes, used_bytes, calibrated_at, slot_quota, created_at) VALUES (?1,?2,?3,?4,'slave','active',?5,?6,0,0,0,?7)",
  ).bind(id, binding, String(body.database_id || ''), `存储库 ${id}`, 524288000, 33554432, now).run();
  resetStorageMemo();
  return json({ ok: true, db_id: id, binding, label: `存储库 ${id}` });
}

// PUT /api/storage/:id —— 调整预留 / 停用 / 恢复
export async function updateDb(req, env, db, id) {
  if (!id) return jerr('无效的库 id');
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误'); }
  const rows = await storageRows(db, true);
  const row = rows.find((r) => r.id === id);
  if (!row) return jerr('存储库不存在', 404);
  const sets = [];
  const binds = [];
  if (body.state && ['active', 'standby', 'full', 'retired'].includes(body.state)) {
    sets.push(`state = ?${sets.length + 1}`);
    binds.push(body.state);
  }
  if (Number.isFinite(body.reserve_bytes) && body.reserve_bytes >= 0) {
    sets.push(`reserve_bytes = ?${sets.length + 1}`);
    binds.push(Math.round(body.reserve_bytes));
  }
  if (Number.isFinite(body.limit_bytes) && body.limit_bytes > 0) {
    sets.push(`limit_bytes = ?${sets.length + 1}`);
    binds.push(Math.round(body.limit_bytes));
  }
  if (!sets.length) return jerr('没有可更新的字段');
  await db.prepare(`UPDATE storage_dbs SET ${sets.join(', ')} WHERE id = ?${sets.length + 1}`).bind(...binds, id).run();
  resetStorageMemo();
  return json({ ok: true, db_id: id });
}

// POST /api/storage/calibrate —— 手动触发容量校准
export async function calibrateNow(req, env, db) {
  const r = await calibrate(db, env);
  if (!r.ok) {
    const msg = r.reason === 'no_token'
      ? '未配置 CF_API_TOKEN，无法读取真实容量（当前显示的是应用累加值）'
      : `校准失败：${r.reason}`;
    return jerr(msg, 400);
  }
  return json({ ok: true, updated: r.updated });
}
