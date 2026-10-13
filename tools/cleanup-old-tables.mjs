#!/usr/bin/env node
// ============================================================================
// 清理 Stage 2/3 迁移留下的回滚表 (*_old / *_old2)
//
// 这些表只在「迁移刚出问题时回滚」的窗口内有价值; 迁移与后续验证均通过后,
// 它们只是占着 D1 空间。本脚本**先导出为 SQL 冷备**, 再 DROP —— 既释放空间,
// 又保留事后恢复能力 (需要时用导出的 .sql 重建)。
//
// 幂等: 无可清理的表则直接退出。
// 用法:
//   node tools/cleanup-old-tables.mjs --local [--persist-to=DIR] [--dry-run]
//   node tools/cleanup-old-tables.mjs --remote [--dry-run]
// ============================================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isLocal = args.includes('--local');
const dryRun = args.includes('--dry-run');
const persistArg = args.find((a) => a.startsWith('--persist-to='));
const persist = persistArg ? persistArg.slice('--persist-to='.length) : '.wrangler/state';
if (!isRemote && !isLocal) {
  console.error('用法: node tools/cleanup-old-tables.mjs (--local|--remote) [--persist-to=DIR] [--dry-run]');
  process.exit(1);
}

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const MAIN = 'file-manager';
const BACKUP_DIR = isRemote ? '.tmp-old-backup-remote' : '.tmp-old-backup-local';

function d1(tail, { json = false } = {}) {
  // tail 形如 ['execute', MAIN, '--command', sql] 或 ['export', MAIN, '--table', t, '--output', p]
  // --remote/--local 必须排在 execute/export 之后
  const t = [WRANGLER, 'd1', ...tail];
  t.push(isRemote ? '--remote' : '--local');
  if (isLocal) t.push('--persist-to', persist);
  if (json) t.push('--json');
  return execFileSync(process.execPath, t, {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function query(sql) {
  const out = d1(['execute', MAIN, '--command', sql], { json: true });
  const arr = JSON.parse(out.slice(out.indexOf('[')));
  return (arr[0] && arr[0].results) || [];
}

function exportTable(t) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const path = `${BACKUP_DIR}/${t}.sql`;
  d1(['export', MAIN, '--table', t, '--output', path]);
  return path;
}

console.log(`[cleanup] 目标: ${isRemote ? '线上 (--remote)' : `本地 (--local, ${persist})`}${dryRun ? ' [DRY-RUN]' : ''}`);

const tables = query(
  "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_old' OR name GLOB '*_old2') ORDER BY name",
).map((r) => r.name);

if (!tables.length) { console.log('  无 *_old / *_old2 表, 无需清理。'); process.exit(0); }
console.log(`  待清理 ${tables.length} 张: ${tables.join(', ')}`);

if (dryRun) {
  console.log(`  [DRY-RUN] 将先导出到 ${BACKUP_DIR}/ 再 DROP TABLE`);
  process.exit(0);
}

// 1) 导出冷备
console.log('  → 导出冷备...');
for (const t of tables) {
  try { exportTable(t); console.log(`    ✅ ${t} → ${BACKUP_DIR}/${t}.sql`); }
  catch (e) { console.error(`    ✗ ${t} 导出失败, 中止 (不 DROP 无备份的表): ${e && e.message}`); process.exit(1); }
}

// 2) DROP
console.log('  → DROP 回滚表...');
d1(['execute', MAIN, '--file', writeSql(tables)]);

// 3) 校验
const left = query(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND (name GLOB '*_old' OR name GLOB '*_old2')",
)[0].n;
const total = query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].n;
console.log(`  剩余回滚表: ${left} (期望 0); 主库表总数: ${total}`);
console.log(Number(left) === 0 ? `[cleanup] ✅ 完成 (冷备在 ${BACKUP_DIR}/)` : '[cleanup] ❌ 仍有残留');
process.exit(Number(left) === 0 ? 0 : 2);

// 把 DROP 语句写成临时文件 (走 --file, 避免命令行过长)
function writeSql(ts) {
  const p = `.tmp-drop-${process.pid}.sql`;
  writeFileSync(p, ts.map((t) => `DROP TABLE IF EXISTS "${t}";`).join('\n'));
  return p;
}
