#!/usr/bin/env node
// ============================================================================
// Stage 1 迁移 — 消灭 blobs 的 f:/i: 前缀键, 历史行全部回填 content_id
//
// 原理 (为什么这是轻量迁移):
//   blobs 的主键是 (key, idx)。把 'f:<path>' 改名为 'c:<content_id>' 只是
//   **改主键值**, 不搬运任何 data —— 所以单行成本是元数据更新, 与文件大小无关。
//   D1 上一条 UPDATE 即可, 不触发 CPU 上限 (对比: INSERT..SELECT 搬字节会)。
//
// 迁移后效果:
//   - blobs 只剩 c:(内容) / t:(缩略图) / u:(暂存) 三类键, f:/i: 消失
//   - blobKeyOf() 退化为常量映射 'c:'+content_id, 不再有历史行分支
//   - 改名/移动不再需要改写 blob 键 (键与 path 解耦) —— 见 Stage 2
//
// 幂等: content_id 由 path/filename 确定性推导 (sha256), 重跑生成同一 cid;
//       已迁移行 (content_id 非空) 会被跳过。中途失败可直接重跑。
//
// 用法:
//   node migrations/migrate-stage1.mjs --local [--persist-to=.tmp-norm] [--dry-run]
//   node migrations/migrate-stage1.mjs --remote [--dry-run]
// ============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';

const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isLocal = args.includes('--local');
const dryRun = args.includes('--dry-run');
const persistArg = args.find((a) => a.startsWith('--persist-to='));
const persist = persistArg ? persistArg.slice('--persist-to='.length) : '.wrangler/state';

if (!isRemote && !isLocal) {
  console.error('用法: node migrations/migrate-stage1.mjs (--local|--remote) [--persist-to=DIR] [--dry-run]');
  process.exit(1);
}

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const dbNameOf = (id) => (id === 1 ? 'file-manager' : `file-manager-${id}`);
const esc = (s) => String(s).replace(/'/g, "''");
const cidOfFile = (p) => createHash('sha256').update('legacy-file:' + p).digest('hex').slice(0, 32);
const cidOfIh = (f) => createHash('sha256').update('legacy-ih:' + f).digest('hex').slice(0, 32);

let tmpSeq = 0;
function runSql(dbName, sql, { json = false } = {}) {
  const tmp = `.tmp-stage1-${process.pid}-${tmpSeq++}.sql`;
  writeFileSync(tmp, sql, 'utf8');
  const tail = [isRemote ? '--remote' : '--local', '--file', tmp];
  if (isLocal) tail.push('--persist-to', persist);
  if (json) tail.push('--json');
  try {
    return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', dbName, ...tail], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* noop */ }
  }
}

// 读取查询结果。注意: wrangler 的 `--file` 模式在 --remote 下只回「执行摘要」
// (stdout 混有上传日志, results 里是 "Total queries executed" 而非行数据) ——
// 因此读数据必须走 `--command`, 其 stdout 是干净的 JSON 数组。
function query(dbName, sql) {
  const tail = [isRemote ? '--remote' : '--local', '--command', sql];
  if (isLocal) tail.push('--persist-to', persist);
  tail.push('--json');
  const out = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', dbName, ...tail], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const arr = JSON.parse(out.slice(out.indexOf('[')));
  return (arr[0] && arr[0].results) || [];
}

// 按库把语句分批执行 (D1 单请求有体积/CPU 限制, 保守切成 400 条一批)
function execBatched(dbName, stmts) {
  const BATCH = 400;
  let done = 0;
  for (let i = 0; i < stmts.length; i += BATCH) {
    const slice = stmts.slice(i, i + BATCH);
    runSql(dbName, slice.join('\n'));
    done += slice.length;
    process.stdout.write(`    ${dbName}: ${done}/${stmts.length} 条\n`);
  }
  return done;
}

// ---------------- 1. 收集历史行 ----------------
console.log(`[Stage 1] 目标: ${isRemote ? '线上 (--remote)' : `本地 (--local, persist=${persist})`}${dryRun ? ' [DRY-RUN]' : ''}`);

const files = query('file-manager',
  'SELECT path, db_id, size, nchunks FROM fs_nodes WHERE is_dir = 0 AND content_id IS NULL');
const ihs = query('file-manager',
  'SELECT filename, db_id, size FROM image_host WHERE content_id IS NULL AND src_path IS NULL');
console.log(`  待迁移文件行: ${files.length}；待迁移图床自持行: ${ihs.length}`);
if (!files.length && !ihs.length) { console.log('  无历史行, 无需迁移。'); process.exit(0); }

// ---------------- 2. 生成按库分组的 SQL ----------------
// byteStmts[dbId] = ['UPDATE blobs ...', ...]   (字节库: key 改名)
// mainStmts      = ['UPDATE fs_nodes ...', 'INSERT INTO contents ...', ...] (主库: 回填)
const byteStmts = new Map();
const mainStmts = [];
const pushByte = (dbId, sql) => {
  if (!byteStmts.has(dbId)) byteStmts.set(dbId, []);
  byteStmts.get(dbId).push(sql);
};
const nowIso = new Date().toISOString();

for (const f of files) {
  const dbId = f.db_id || 1;
  const cid = cidOfFile(f.path);
  const p = esc(f.path);
  // 字节键: f:<path> → c:<cid>;  缩略图: t:<path> → t:<cid> (纯 key 改名, data 不动)
  pushByte(dbId, `UPDATE blobs SET key = 'c:${cid}' WHERE key = 'f:${p}';`);
  pushByte(dbId, `UPDATE blobs SET key = 't:${cid}' WHERE key = 't:${p}';`);
  // 主库回填 + 去重索引登记 (hash 用 legacy: 前缀, 不污染真实内容的秒传索引)
  mainStmts.push(`UPDATE fs_nodes SET content_id = '${cid}' WHERE path = '${p}' AND content_id IS NULL;`);
  mainStmts.push(`INSERT OR IGNORE INTO contents (id, hash, size, db_id, nchunks, created_at) VALUES ('${cid}', 'legacy:${cid}', ${Number(f.size) || 0}, ${dbId}, ${Number(f.nchunks) || 0}, '${esc(nowIso)}');`);
}

for (const h of ihs) {
  const dbId = h.db_id || 1;
  const cid = cidOfIh(h.filename);
  const fn = esc(h.filename);
  pushByte(dbId, `UPDATE blobs SET key = 'c:${cid}' WHERE key = 'i:${fn}';`);
  mainStmts.push(`UPDATE image_host SET content_id = '${cid}' WHERE filename = '${fn}' AND content_id IS NULL;`);
  mainStmts.push(`INSERT OR IGNORE INTO contents (id, hash, size, db_id, nchunks, created_at) VALUES ('${cid}', 'legacy:${cid}', ${Number(h.size) || 0}, ${dbId}, 0, '${esc(nowIso)}');`);
}

// ---------------- 3. 执行 ----------------
if (dryRun) {
  console.log('  [DRY-RUN] 将执行:');
  for (const [dbId, s] of byteStmts) console.log(`    ${dbNameOf(dbId)}: ${s.length} 条 blob key 改名`);
  console.log(`    file-manager: ${mainStmts.length} 条回填`);
  console.log('  样例:', byteStmts.values().next().value?.[0], '|', mainStmts[0]);
  process.exit(0);
}

console.log('  → 步骤 1/3: 字节库 key 改名 (先字节后元数据, 符合不变式 I5)');
for (const [dbId, stmts] of byteStmts) execBatched(dbNameOf(dbId), stmts);

console.log('  → 步骤 2/3: 主库回填 content_id + 登记 contents');
execBatched('file-manager', mainStmts);

// ---------------- 4. 校验 ----------------
console.log('  → 步骤 3/3: 校验');
const leftFile = query('file-manager', 'SELECT COUNT(*) AS c FROM fs_nodes WHERE is_dir = 0 AND content_id IS NULL')[0].c;
const leftIh = query('file-manager', 'SELECT COUNT(*) AS c FROM image_host WHERE content_id IS NULL AND src_path IS NULL')[0].c;
let leftoverKeys = 0;
for (const dbId of byteStmts.keys()) {
  const c = query(dbNameOf(dbId),
    "SELECT COUNT(*) AS c FROM blobs WHERE substr(key,1,2) = 'f:' OR substr(key,1,2) = 'i:'")[0].c;
  leftoverKeys += Number(c) || 0;
}
console.log(`    剩余未回填文件行: ${leftFile} (期望 0)`);
console.log(`    剩余未回填图床行: ${leftIh} (期望 0)`);
console.log(`    残留 f:/i: 键: ${leftoverKeys} (期望 0)`);
const ok = leftFile === 0 && leftIh === 0 && leftoverKeys === 0;
console.log(ok ? '[Stage 1] ✅ 通过' : '[Stage 1] ❌ 未清零, 可重跑 (幂等)');
process.exit(ok ? 0 : 2);
