#!/usr/bin/env node
// ============================================================================
// Stage 3 迁移 — 清理 Stage 2 的过渡冗余 + 加约束
//
// Stage 2 为「零停机」保留了冗余列 (parent / src_path / lyrics.path / ...) 与
// 同步触发器。代码已全面改用权威列 (parent_id / src_node_id / node_id), 冗余列
// 不再需要 —— 本阶段删除它们并加上 CHECK 约束, 让 schema 回到单一事实源。
//
// 保留项 (刻意不删):
//   fs_nodes.path —— 物化路径列, 前端契约 (entries[].name / results[].path) 与
//   子树前缀查询 (subtreeMatch) 依赖它, 属正当设计而非冗余债。
//
// 全部用「重建表」方式 (SQLite 不支持 ALTER TABLE 加 CHECK)。旧表改名 *_old 保留。
// 幂等: 以 fs_nodes 是否仍含 parent 列为判据。
// 用法:
//   node migrations/migrate-stage3.mjs --local [--persist-to=DIR] [--dry-run]
//   node migrations/migrate-stage3.mjs --remote [--dry-run]
// ============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isLocal = args.includes('--local');
const dryRun = args.includes('--dry-run');
const persistArg = args.find((a) => a.startsWith('--persist-to='));
const persist = persistArg ? persistArg.slice('--persist-to='.length) : '.wrangler/state';
if (!isRemote && !isLocal) {
  console.error('用法: node migrations/migrate-stage3.mjs (--local|--remote) [--persist-to=DIR] [--dry-run]');
  process.exit(1);
}

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const MAIN = 'file-manager';
let tmpSeq = 0;

function runSql(dbName, sql) {
  const tmp = `.tmp-stage3-${process.pid}-${tmpSeq++}.sql`;
  writeFileSync(tmp, sql, 'utf8');
  const tail = [isRemote ? '--remote' : '--local', '--file', tmp];
  if (isLocal) tail.push('--persist-to', persist);
  try {
    return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', dbName, ...tail], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { try { unlinkSync(tmp); } catch { /* noop */ } }
}

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

const MIGRATION_SQL = `
-- ---------- 0. 删除 Stage 2 兼容触发器 (冗余列即将消失, 触发器失去意义) ----------
DROP TRIGGER IF EXISTS trg_fs_ins;
DROP TRIGGER IF EXISTS trg_fs_upd;
DROP TRIGGER IF EXISTS trg_ih_ins;
DROP TRIGGER IF EXISTS trg_ih_upd;

-- ---------- 1. fs_nodes: 去掉 parent 冗余列, 加 CHECK ----------
CREATE TABLE IF NOT EXISTS fs_nodes_v3 (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER NOT NULL DEFAULT 0 CHECK (parent_id >= 0),
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  is_dir      INTEGER NOT NULL CHECK (is_dir IN (0,1)),
  size        INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  mime        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  nchunks     INTEGER NOT NULL DEFAULT 0 CHECK (nchunks >= 0),
  db_id       INTEGER NOT NULL DEFAULT 1 CHECK (db_id >= 1),
  content_id  TEXT,
  CHECK (is_dir = 1 OR content_id IS NOT NULL)
);
DELETE FROM fs_nodes_v3;
INSERT INTO fs_nodes_v3 (id, parent_id, name, path, is_dir, size, mime, created_at, modified_at, nchunks, db_id, content_id)
SELECT id, parent_id, name, path, is_dir, size, mime, created_at, modified_at, nchunks, db_id, content_id FROM fs_nodes;
DROP INDEX IF EXISTS ux_fs_path;
DROP INDEX IF EXISTS ux_fs_sibling;
DROP INDEX IF EXISTS ix_fs_parent;
DROP INDEX IF EXISTS ix_fs_content;
ALTER TABLE fs_nodes RENAME TO fs_nodes_old2;
ALTER TABLE fs_nodes_v3 RENAME TO fs_nodes;
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_path    ON fs_nodes(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_sibling ON fs_nodes(parent_id, name);
CREATE INDEX        IF NOT EXISTS ix_fs_parent  ON fs_nodes(parent_id);
CREATE INDEX        IF NOT EXISTS ix_fs_content ON fs_nodes(content_id);

-- ---------- 2. image_host: 去掉 src_path 冗余列 ----------
CREATE TABLE IF NOT EXISTS image_host_v3 (
  filename      TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  upload_time   TEXT NOT NULL,
  src_node_id   INTEGER,
  db_id         INTEGER NOT NULL DEFAULT 1 CHECK (db_id >= 1),
  content_id    TEXT,
  CHECK (NOT (src_node_id IS NOT NULL AND content_id IS NOT NULL))
);
DELETE FROM image_host_v3;
INSERT INTO image_host_v3 (filename, original_name, mime_type, size, upload_time, src_node_id, db_id, content_id)
SELECT filename, original_name, mime_type, size, upload_time, src_node_id, db_id, content_id FROM image_host;
DROP INDEX IF EXISTS ix_ih_src_node;
DROP INDEX IF EXISTS ix_ih_content;
ALTER TABLE image_host RENAME TO image_host_old2;
ALTER TABLE image_host_v3 RENAME TO image_host;
CREATE INDEX IF NOT EXISTS ix_ih_src_node ON image_host(src_node_id);
CREATE INDEX IF NOT EXISTS ix_ih_content  ON image_host(content_id);

-- ---------- 3. share_links: 去掉 path 冗余列 ----------
CREATE TABLE IF NOT EXISTS share_links_v3 (
  id               TEXT PRIMARY KEY,
  node_id          INTEGER NOT NULL DEFAULT 0 CHECK (node_id >= 0),
  password         TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at TEXT
);
DELETE FROM share_links_v3;
INSERT INTO share_links_v3 (id, node_id, password, expires_at, created_at, access_count, last_accessed_at)
SELECT id, node_id, password, expires_at, created_at, access_count, last_accessed_at FROM share_links;
DROP INDEX IF EXISTS ix_share_node;
ALTER TABLE share_links RENAME TO share_links_old2;
ALTER TABLE share_links_v3 RENAME TO share_links;
CREATE INDEX IF NOT EXISTS ix_share_node ON share_links(node_id);

-- ---------- 4. lyrics: 去掉 path 冗余列 ----------
CREATE TABLE IF NOT EXISTS lyrics_v3 (
  node_id    INTEGER PRIMARY KEY,
  found      INTEGER NOT NULL DEFAULT 0 CHECK (found IN (0,1)),
  source     TEXT,
  synced     TEXT,
  plain      TEXT,
  trans      TEXT,
  roma       TEXT,
  title      TEXT,
  artist     TEXT,
  duration   REAL NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);
DELETE FROM lyrics_v3;
INSERT INTO lyrics_v3 (node_id, found, source, synced, plain, trans, roma, title, artist, duration, fetched_at)
SELECT node_id, found, source, synced, plain, trans, roma, title, artist, duration, fetched_at FROM lyrics;
DROP INDEX IF EXISTS ix_lyrics_fetched_at;
ALTER TABLE lyrics RENAME TO lyrics_old2;
ALTER TABLE lyrics_v3 RENAME TO lyrics;
CREATE INDEX IF NOT EXISTS ix_lyrics_fetched_at ON lyrics(fetched_at);

-- ---------- 5. lyrics_reject: 去掉 path 冗余列 ----------
CREATE TABLE IF NOT EXISTS lyrics_reject_v3 (
  node_id INTEGER PRIMARY KEY,
  sources TEXT NOT NULL DEFAULT '[]',
  ts      INTEGER NOT NULL
);
DELETE FROM lyrics_reject_v3;
INSERT INTO lyrics_reject_v3 (node_id, sources, ts)
SELECT node_id, sources, ts FROM lyrics_reject;
ALTER TABLE lyrics_reject RENAME TO lyrics_reject_old2;
ALTER TABLE lyrics_reject_v3 RENAME TO lyrics_reject;

-- ---------- 6. track_meta: 去掉 path 冗余列 ----------
CREATE TABLE IF NOT EXISTS track_meta_v3 (
  node_id      INTEGER PRIMARY KEY,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  lyric_offset INTEGER NOT NULL DEFAULT 0,
  lrc          TEXT,
  trans        TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL
);
DELETE FROM track_meta_v3;
INSERT INTO track_meta_v3 (node_id, title, artist, album, lyric_offset, lrc, trans, source, updated_at)
SELECT node_id, title, artist, album, lyric_offset, lrc, trans, source, updated_at FROM track_meta;
DROP INDEX IF EXISTS ix_track_meta_updated;
ALTER TABLE track_meta RENAME TO track_meta_old2;
ALTER TABLE track_meta_v3 RENAME TO track_meta;
CREATE INDEX IF NOT EXISTS ix_track_meta_updated ON track_meta(updated_at);

-- ---------- 7. upload_sessions: 删除死列 b2_key ----------
ALTER TABLE upload_sessions DROP COLUMN b2_key;
`;

console.log(`[Stage 3] 目标: ${isRemote ? '线上 (--remote)' : `本地 (--local, ${persist})`}${dryRun ? ' [DRY-RUN]' : ''}`);

// ---------------- 1. 前置检查 ----------------
const cols = query(MAIN, "SELECT name FROM pragma_table_info('fs_nodes')").map((c) => c.name);
if (!cols.includes('id')) { console.error('  ✗ fs_nodes 无 id 列: 请先执行 Stage 2。'); process.exit(1); }
if (!cols.includes('parent')) { console.log('  fs_nodes 已无 parent 列, 视为已迁移, 跳过。'); process.exit(0); }

const before = query(MAIN,
  `SELECT (SELECT COUNT(*) FROM fs_nodes) AS nodes,
          (SELECT COUNT(*) FROM image_host) AS ih,
          (SELECT COUNT(*) FROM share_links) AS shares,
          (SELECT COUNT(*) FROM lyrics) AS lyrics,
          (SELECT COUNT(*) FROM track_meta) AS metas`)[0];
console.log('  迁移前计数:', JSON.stringify(before));

if (dryRun) {
  console.log('  [DRY-RUN] 将去掉: parent / src_path / share_links.path / lyrics.path / lyrics_reject.path / track_meta.path');
  console.log('  并加 CHECK 约束 + 删触发器 + 删 upload_sessions.b2_key; 旧表保留为 *_old2');
  process.exit(0);
}

// ---------------- 2. 执行 ----------------
console.log('  → 执行重建...');
runSql(MAIN, MIGRATION_SQL);

// ---------------- 3. 校验 ----------------
console.log('  → 校验');
const after = query(MAIN,
  `SELECT (SELECT COUNT(*) FROM fs_nodes) AS nodes,
          (SELECT COUNT(*) FROM image_host) AS ih,
          (SELECT COUNT(*) FROM share_links) AS shares,
          (SELECT COUNT(*) FROM lyrics) AS lyrics,
          (SELECT COUNT(*) FROM track_meta) AS metas,
          (SELECT COUNT(*) FROM fs_nodes WHERE parent_id != 0 AND NOT EXISTS (SELECT 1 FROM fs_nodes p WHERE p.id = fs_nodes.parent_id)) AS bad_parent,
          (SELECT COUNT(*) FROM image_host WHERE src_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = image_host.src_node_id)) AS bad_ref,
          (SELECT COUNT(*) FROM share_links WHERE node_id != 0 AND NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = share_links.node_id)) AS bad_share`)[0];
const colsAfter = query(MAIN, "SELECT name FROM pragma_table_info('fs_nodes')").map((c) => c.name);
const ihColsAfter = query(MAIN, "SELECT name FROM pragma_table_info('image_host')").map((c) => c.name);
console.log('  迁移后计数:', JSON.stringify(after));

let ok = true;
const chk = (n, c) => { console.log(`    ${c ? '✓' : '✗'} ${n}`); if (!c) ok = false; };
chk('fs_nodes 行数不变', Number(after.nodes) === Number(before.nodes));
chk('image_host 行数不变', Number(after.ih) === Number(before.ih));
chk('share_links 行数不变', Number(after.shares) === Number(before.shares));
chk('lyrics 行数不变', Number(after.lyrics) === Number(before.lyrics));
chk('track_meta 行数不变', Number(after.metas) === Number(before.metas));
chk('parent_id 无悬空', Number(after.bad_parent) === 0);
chk('image_host 引用无悬空', Number(after.bad_ref) === 0);
chk('share_links 引用无悬空', Number(after.bad_share) === 0);
chk('fs_nodes 已无 parent 列', !colsAfter.includes('parent'));
chk('image_host 已无 src_path 列', !ihColsAfter.includes('src_path'));

console.log(ok ? '[Stage 3] ✅ 通过 (旧表保留为 *_old2)' : '[Stage 3] ❌ 校验未全通过');
process.exit(ok ? 0 : 2);
