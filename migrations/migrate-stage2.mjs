#!/usr/bin/env node
// ============================================================================
// Stage 2 迁移 — fs_nodes 主键规范化 (path → id + parent_id) + 软引用改 node_id
//
// 解决的问题:
//   现状 fs_nodes 用可变自然键 path 当主键, 所有跨表引用 (image_host.src_path /
//   share_links.path / lyrics.path / lyrics_reject.path / track_meta.path) 都是
//   "路径软引用" —— 文件改名/移动就要级联改写这些表, 且引用无稳定性保证。
//   Stage 2 引入稳定代理键 id, 引用一律指向 id。
//
// 采用「渐进冗余」策略保证零停机 (个人网盘无维护窗口):
//   - 新表同时保留 path / parent / src_path 等**旧列作为冗余**, 写入时一并维护;
//     这样迁移与代码部署之间的窗口期内, 旧代码仍能正常读写。
//   - parent_id / node_id / src_node_id 为**权威**列。旧冗余列留待 Stage 3 清理。
//
// 旧表改名保留为 *_old (不 DROP), 便于回滚; 验证稳定后再手工清理。
//
// 幂等: 以 fs_nodes 是否已有 id 列为判据, 已迁移则直接跳过。
// 用法:
//   node migrations/migrate-stage2.mjs --local [--persist-to=DIR] [--dry-run]
//   node migrations/migrate-stage2.mjs --remote [--dry-run]
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
  console.error('用法: node migrations/migrate-stage2.mjs (--local|--remote) [--persist-to=DIR] [--dry-run]');
  process.exit(1);
}

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const MAIN = 'file-manager';
let tmpSeq = 0;

function runSql(dbName, sql) {
  const tmp = `.tmp-stage2-${process.pid}-${tmpSeq++}.sql`;
  writeFileSync(tmp, sql, 'utf8');
  const tail = [isRemote ? '--remote' : '--local', '--file', tmp];
  if (isLocal) tail.push('--persist-to', persist);
  try {
    return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', dbName, ...tail], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { try { unlinkSync(tmp); } catch { /* noop */ } }
}

// 注意: 读数据必须用 --command (--file 在 --remote 下只回执行摘要, 见 stage1 踩坑)
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
-- ---------- 1. fs_nodes: id + parent_id (path/parent 留作冗余) ----------
CREATE TABLE IF NOT EXISTS fs_nodes_v2 (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER NOT NULL DEFAULT 0,
  parent      TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  is_dir      INTEGER NOT NULL CHECK (is_dir IN (0,1)),
  size        INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  mime        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  nchunks     INTEGER NOT NULL DEFAULT 0 CHECK (nchunks >= 0),
  db_id       INTEGER NOT NULL DEFAULT 1,
  content_id  TEXT
);
DELETE FROM fs_nodes_v2;
INSERT INTO fs_nodes_v2 (id, parent_id, parent, name, path, is_dir, size, mime, created_at, modified_at, nchunks, db_id, content_id)
SELECT o.rowid,
       COALESCE((SELECT p.rowid FROM fs_nodes p WHERE p.path = o.parent), 0),
       o.parent, o.name, o.path, o.is_dir, o.size, o.mime, o.created_at, o.modified_at, o.nchunks, o.db_id, o.content_id
FROM fs_nodes o;

DROP INDEX IF EXISTS idx_fs_parent;
DROP INDEX IF EXISTS idx_fs_name;
DROP INDEX IF EXISTS idx_fs_nodes_content;
ALTER TABLE fs_nodes RENAME TO fs_nodes_old;
ALTER TABLE fs_nodes_v2 RENAME TO fs_nodes;
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_path    ON fs_nodes(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_sibling ON fs_nodes(parent_id, name);
CREATE INDEX        IF NOT EXISTS ix_fs_parent  ON fs_nodes(parent_id);
CREATE INDEX        IF NOT EXISTS ix_fs_content ON fs_nodes(content_id);

-- ---------- 2. image_host: src_path → src_node_id (src_path 留作冗余) ----------
CREATE TABLE IF NOT EXISTS image_host_v2 (
  filename      TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  upload_time   TEXT NOT NULL,
  src_path      TEXT,
  src_node_id   INTEGER,
  db_id         INTEGER NOT NULL DEFAULT 1,
  content_id    TEXT
);
DELETE FROM image_host_v2;
INSERT INTO image_host_v2 (filename, original_name, mime_type, size, upload_time, src_path, src_node_id, db_id, content_id)
SELECT m.filename, m.original_name, m.mime_type, m.size, m.upload_time, m.src_path,
       (SELECT f.id FROM fs_nodes f WHERE f.path = m.src_path), m.db_id, m.content_id
FROM image_host m;

DROP INDEX IF EXISTS idx_ih_src_path;
DROP INDEX IF EXISTS idx_image_host_content;
ALTER TABLE image_host RENAME TO image_host_old;
ALTER TABLE image_host_v2 RENAME TO image_host;
CREATE INDEX IF NOT EXISTS ix_ih_src_node ON image_host(src_node_id);
CREATE INDEX IF NOT EXISTS ix_ih_content  ON image_host(content_id);

-- ---------- 3. share_links: path → node_id (path 留作冗余; 根分享 node_id=0) ----------
CREATE TABLE IF NOT EXISTS share_links_v2 (
  id               TEXT PRIMARY KEY,
  node_id          INTEGER NOT NULL DEFAULT 0,
  path             TEXT NOT NULL DEFAULT '',
  password         TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at TEXT
);
DELETE FROM share_links_v2;
INSERT INTO share_links_v2 (id, node_id, path, password, expires_at, created_at, access_count, last_accessed_at)
SELECT s.id,
       COALESCE((SELECT f.id FROM fs_nodes f WHERE f.path = s.path), 0),
       s.path, s.password, s.expires_at, s.created_at, s.access_count, s.last_accessed_at
FROM share_links s;

ALTER TABLE share_links RENAME TO share_links_old;
ALTER TABLE share_links_v2 RENAME TO share_links;
CREATE INDEX IF NOT EXISTS ix_share_node ON share_links(node_id);

-- ---------- 4. lyrics: path → node_id (丢弃指向已不存在文件的孤儿行) ----------
CREATE TABLE IF NOT EXISTS lyrics_v2 (
  node_id    INTEGER PRIMARY KEY,
  path       TEXT,
  found      INTEGER NOT NULL DEFAULT 0,
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
DELETE FROM lyrics_v2;
INSERT INTO lyrics_v2 (node_id, path, found, source, synced, plain, trans, roma, title, artist, duration, fetched_at)
SELECT (SELECT f.id FROM fs_nodes f WHERE f.path = l.path), l.path,
       l.found, l.source, l.synced, l.plain, l.trans, l.roma, l.title, l.artist, l.duration, l.fetched_at
FROM lyrics l
WHERE EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = l.path);

DROP INDEX IF EXISTS idx_lyrics_fetched_at;
ALTER TABLE lyrics RENAME TO lyrics_old;
ALTER TABLE lyrics_v2 RENAME TO lyrics;
CREATE INDEX IF NOT EXISTS ix_lyrics_fetched_at ON lyrics(fetched_at);

-- ---------- 5. lyrics_reject: path → node_id ----------
CREATE TABLE IF NOT EXISTS lyrics_reject_v2 (
  node_id INTEGER PRIMARY KEY,
  path    TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  ts      INTEGER NOT NULL
);
DELETE FROM lyrics_reject_v2;
INSERT INTO lyrics_reject_v2 (node_id, path, sources, ts)
SELECT (SELECT f.id FROM fs_nodes f WHERE f.path = r.path), r.path, r.sources, r.ts
FROM lyrics_reject r
WHERE EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = r.path);

ALTER TABLE lyrics_reject RENAME TO lyrics_reject_old;
ALTER TABLE lyrics_reject_v2 RENAME TO lyrics_reject;

-- ---------- 6. track_meta: path → node_id ----------
CREATE TABLE IF NOT EXISTS track_meta_v2 (
  node_id      INTEGER PRIMARY KEY,
  path         TEXT,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  lyric_offset INTEGER NOT NULL DEFAULT 0,
  lrc          TEXT,
  trans        TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL
);
DELETE FROM track_meta_v2;
INSERT INTO track_meta_v2 (node_id, path, title, artist, album, lyric_offset, lrc, trans, source, updated_at)
SELECT (SELECT f.id FROM fs_nodes f WHERE f.path = t.path), t.path,
       t.title, t.artist, t.album, t.lyric_offset, t.lrc, t.trans, t.source, t.updated_at
FROM track_meta t
WHERE EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = t.path);

DROP INDEX IF EXISTS idx_track_meta_updated;
ALTER TABLE track_meta RENAME TO track_meta_old;
ALTER TABLE track_meta_v2 RENAME TO track_meta;
CREATE INDEX IF NOT EXISTS ix_track_meta_updated ON track_meta(updated_at);

-- ---------- 7. 同步触发器 ----------
-- 兼容期保险: 迁移与代码部署之间存在窗口, 旧代码写入只带 parent / src_path,
-- 由触发器把权威列 (parent_id / src_node_id) 补齐 —— 新旧代码混跑也不会让结构错乱。
-- 触发条件里比较"当前权威列是否已等于推导值", 一致则不动作, 因此不会递归、也几乎零开销。
CREATE TRIGGER IF NOT EXISTS trg_fs_ins AFTER INSERT ON fs_nodes
WHEN NEW.parent_id IS NOT COALESCE((SELECT id FROM fs_nodes p WHERE p.path = NEW.parent), 0)
BEGIN
  UPDATE fs_nodes SET parent_id = COALESCE((SELECT id FROM fs_nodes p WHERE p.path = NEW.parent), 0) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_fs_upd AFTER UPDATE OF parent ON fs_nodes
WHEN NEW.parent_id IS NOT COALESCE((SELECT id FROM fs_nodes p WHERE p.path = NEW.parent), 0)
BEGIN
  UPDATE fs_nodes SET parent_id = COALESCE((SELECT id FROM fs_nodes p WHERE p.path = NEW.parent), 0) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ih_ins AFTER INSERT ON image_host
WHEN NEW.src_path IS NOT NULL AND NEW.src_node_id IS NOT (SELECT id FROM fs_nodes p WHERE p.path = NEW.src_path)
BEGIN
  UPDATE image_host SET src_node_id = (SELECT id FROM fs_nodes p WHERE p.path = NEW.src_path) WHERE filename = NEW.filename;
END;

CREATE TRIGGER IF NOT EXISTS trg_ih_upd AFTER UPDATE OF src_path ON image_host
WHEN NEW.src_path IS NOT NULL AND NEW.src_node_id IS NOT (SELECT id FROM fs_nodes p WHERE p.path = NEW.src_path)
BEGIN
  UPDATE image_host SET src_node_id = (SELECT id FROM fs_nodes p WHERE p.path = NEW.src_path) WHERE filename = NEW.filename;
END;
`;

console.log(`[Stage 2] 目标: ${isRemote ? '线上 (--remote)' : `本地 (--local, ${persist})`}${dryRun ? ' [DRY-RUN]' : ''}`);

// ---------------- 1. 前置检查 ----------------
const cols = query(MAIN, "SELECT name FROM pragma_table_info('fs_nodes')").map((c) => c.name);
if (cols.includes('id')) { console.log('  fs_nodes 已含 id 列, 视为已迁移, 跳过。'); process.exit(0); }
if (!cols.includes('content_id')) { console.error('  ✗ fs_nodes 缺 content_id: 请先执行 Stage 1 迁移。'); process.exit(1); }

const before = query(MAIN,
  `SELECT (SELECT COUNT(*) FROM fs_nodes) AS nodes,
          (SELECT COUNT(*) FROM image_host WHERE src_path IS NOT NULL AND EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = image_host.src_path)) AS ih_refs,
          (SELECT COUNT(*) FROM share_links WHERE path != '.' AND path != '' AND EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = share_links.path)) AS share_refs,
          (SELECT COUNT(*) FROM lyrics WHERE EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = lyrics.path)) AS lyrics_ok,
          (SELECT COUNT(*) FROM track_meta WHERE EXISTS (SELECT 1 FROM fs_nodes f WHERE f.path = track_meta.path)) AS metas_ok`)[0];
console.log('  迁移前计数:', JSON.stringify(before));

if (dryRun) {
  console.log('  [DRY-RUN] 将重建 fs_nodes / image_host / share_links / lyrics / lyrics_reject / track_meta');
  console.log('  (旧表改名保留为 *_old, 可回滚。孤儿行将被丢弃)');
  process.exit(0);
}

// ---------------- 2. 执行迁移 ----------------
console.log('  → 执行重建...');
runSql(MAIN, MIGRATION_SQL);

// ---------------- 3. 校验 ----------------
console.log('  → 校验');
const after = query(MAIN,
  `SELECT (SELECT COUNT(*) FROM fs_nodes) AS nodes,
          (SELECT COUNT(*) FROM fs_nodes WHERE id IS NULL) AS null_id,
          (SELECT COUNT(*) FROM fs_nodes c WHERE c.parent_id != 0 AND NOT EXISTS (SELECT 1 FROM fs_nodes p WHERE p.id = c.parent_id)) AS bad_parent,
          (SELECT COUNT(*) FROM (SELECT parent_id, name FROM fs_nodes GROUP BY parent_id, name HAVING COUNT(*) > 1)) AS dup_sibling,
          (SELECT COUNT(*) FROM image_host WHERE src_node_id IS NOT NULL) AS ih_refs,
          (SELECT COUNT(*) FROM share_links WHERE node_id != 0) AS share_nodes,
          (SELECT COUNT(*) FROM lyrics) AS lyrics,
          (SELECT COUNT(*) FROM track_meta) AS metas`)[0];
console.log('  迁移后计数:', JSON.stringify(after));

let ok = true;
const chk = (n, c) => { console.log(`    ${c ? '✓' : '✗'} ${n}`); if (!c) ok = false; };
chk(`fs_nodes 行数不变 (${before.nodes} → ${after.nodes})`, Number(after.nodes) === Number(before.nodes));
chk('无 id 为 NULL 的行', Number(after.null_id) === 0);
chk('parent_id 无悬空引用', Number(after.bad_parent) === 0);
chk('(parent_id, name) 无重复', Number(after.dup_sibling) === 0);
chk(`image_host 有效引用全保留 (${before.ih_refs} → ${after.ih_refs})`, Number(after.ih_refs) === Number(before.ih_refs));
chk(`share_links 有效引用全保留 (${before.share_refs} → ${after.share_nodes})`, Number(after.share_nodes) === Number(before.share_refs));
chk(`lyrics 有效行全保留 (${before.lyrics_ok} → ${after.lyrics})`, Number(after.lyrics) === Number(before.lyrics_ok));
chk(`track_meta 有效行全保留 (${before.metas_ok} → ${after.metas})`, Number(after.metas) === Number(before.metas_ok));

console.log(ok ? '[Stage 2] ✅ 通过 (旧表保留为 *_old)' : '[Stage 2] ❌ 校验未全通过, 旧表仍在, 可人工核查');
process.exit(ok ? 0 : 2);
