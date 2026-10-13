-- ============================================================================
-- 2026-10-13 — Stage 0: 基线固化（规范化重构第一步）
--
-- 目标: 让 schema 状态可追溯、可重建。含三件事:
--   1) 建立迁移版本表 schema_migrations, 回填历史迁移为「已应用」
--   2) 补齐 schema.sql 长期缺失的漂移: track_meta 表、idx_ih_src_path 索引
--   3) 为后续 Stage 1/2/3 提供幂等的登记基础
--
-- 幂等: 全部为 CREATE ... IF NOT EXISTS / INSERT OR IGNORE, 可重复执行。
-- 风险: 无。只加表/索引/登记行, 不改任何既有列与数据。
-- 执行: wrangler d1 execute file-manager --remote --file=./migrations/2026-10-13-stage0-baseline.sql
-- 回滚: 不部署新代码即可 (新增对象不被旧代码引用)。
-- ============================================================================

-- ---------------- 1. 迁移版本表 ----------------
-- 此前 11 个迁移靠人工 wrangler d1 execute 执行, 无任何台账 ——
-- 无法回答「这个库到哪一版了」, 也无法让迁移脚本安全地判断是否需要执行。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,     -- 迁移文件名 (去 .sql), 与 migrations/ 一一对应
  applied_at INTEGER NOT NULL      -- 应用时刻 (毫秒)
);

-- 回填历史迁移 (这些结构已在库中, 由 schema.sql 快照可证)。
-- 时间取各迁移的发布日期, 仅作台账用途, 不参与逻辑。
INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES
  ('2026-09-15-db-sharding',           1757904000000),
  ('2026-09-15-resumable-upload',      1757904000000),
  ('2026-09-15-complete-batching',     1757904000000),
  ('2026-09-15-cleanup-orphan-sessions', 1757904000000),
  ('2026-09-15-ih-reference',          1757904000000),
  ('2026-09-15-track-meta',            1757904000000),
  ('2026-09-16-lyrics-store',          1757990400000),
  ('2026-09-16-lyrics-reject',         1757990400000),
  ('2026-09-18-token-version',         1758163200000),
  ('2026-09-30-content-dedup',         1759161600000);
-- 注: 2026-09-15-slave-blobs 是从库(DB2+)专用迁移, 不在主库登记。

-- ---------------- 2. 补齐 schema.sql 漂移 ----------------
-- 2a. track_meta: 此前只存在于 migrations/2026-09-15-track-meta.sql,
--     schema.sql 全文没有它 —— 重建脚本会漏掉这张表, 代码只能靠运行时自愈。
CREATE TABLE IF NOT EXISTS track_meta (
  path         TEXT PRIMARY KEY,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  lyric_offset INTEGER NOT NULL DEFAULT 0,
  lrc          TEXT,
  trans        TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_meta_updated ON track_meta(updated_at);

-- 2b. image_host 的引用反查索引: 此前只在 ih-reference.sql 里建过, schema.sql 漏了。
CREATE INDEX IF NOT EXISTS idx_ih_src_path ON image_host(src_path);

-- 2c. idx_image_host_content: schema.sql 原先把这条 CREATE INDEX 排在
--     image_host 建表语句之前(见修复后的 schema.sql)。对已存在的库, 这里
--     幂等重建一次, 确保索引确实存在。
CREATE INDEX IF NOT EXISTS idx_image_host_content ON image_host(content_id);

-- ---------------- 3. 核对 ----------------
SELECT
  (SELECT COUNT(*) FROM schema_migrations)                                     AS migrations_logged,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='track_meta') AS has_track_meta,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ih_src_path')      AS has_ih_src_idx,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_image_host_content') AS has_ih_content_idx;
