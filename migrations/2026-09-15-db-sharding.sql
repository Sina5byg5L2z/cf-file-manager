-- ============================================================================
-- 存储分库 (文件级) 升级迁移 — 适用于已部署旧版本、要升级到分库版的库
--
-- 新装用户不需要本文件: 直接执行 schema.sql 即可 (已包含全部 DDL)。
-- 老用户升级: 原库已有 fs_nodes / image_host / upload_sessions 等表,
-- 无法重跑 schema.sql (CREATE TABLE IF NOT EXISTS 不会补列), 执行本文件补齐。
--
-- 架构: 元数据 (fs_nodes / image_host / upload_sessions / storage_dbs 等) 永在主库;
--       文件字节 (blobs, 1MB 分片) 按「一个文件的全部字节落在同一个库」分散到各库。
-- 不变量:
--   I1 一个文件的全部字节 (f:<path> + t:<path>) 在同一个库
--   I2 暂存 u:<id> 与它转正的 f:/i: 在同一个库 (由 upload_sessions.db_id 钉住)
--   I3 元数据永在主库
--   I4 不做跨库搬迁、不做回收
--   I5 字节先落、元数据后写; 删除时元数据先删、字节后删 (失败只留孤儿, 不留坏引用)
--
-- 执行: npx wrangler d1 execute file-manager --remote --file=./migrations/2026-09-15-db-sharding.sql
-- ============================================================================

-- ---------------- 库注册表 (主库) ----------------
-- id 与 binding 名恒等: 1='DB', 2='DB2', 3='DB3' ... (由 binding 名推导, 路由层无需查表)
CREATE TABLE IF NOT EXISTS storage_dbs (
  id            INTEGER PRIMARY KEY,
  binding       TEXT    NOT NULL UNIQUE,
  database_id   TEXT    NOT NULL DEFAULT '',
  label         TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'slave',     -- 'primary' | 'slave'
  state         TEXT    NOT NULL DEFAULT 'standby',   -- 'active' | 'standby' | 'full' | 'retired'
  limit_bytes   INTEGER NOT NULL DEFAULT 524288000,   -- 单库硬上限 (Free = 500MiB)
  reserve_bytes INTEGER NOT NULL DEFAULT 33554432,    -- 预留: 页开销/索引/操作余量
  used_bytes    INTEGER NOT NULL DEFAULT 0,           -- 当前占用 (file_size 口径)
  calibrated_at INTEGER NOT NULL DEFAULT 0,
  slot_quota    INTEGER NOT NULL DEFAULT 0,           -- 仅主库行有效: 本账号可用于本项目的库数上限
  created_at    INTEGER NOT NULL
);

-- ---------------- 跨库操作日志 (主库) ----------------
-- 跨库改名/删除没有事务保护; 失败的字节操作写进这里, 由每日 cron 重试。
CREATE TABLE IF NOT EXISTS blob_journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT    NOT NULL,          -- 'delete' | 'rename'
  db_id      INTEGER NOT NULL,
  old_key    TEXT    NOT NULL,
  new_key    TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bj_db ON blob_journal(db_id);

-- ---------------- 归属列 ----------------
-- 目录行 (is_dir=1) 的 db_id 恒为 1, 无意义。
-- image_host.db_id 只在自持模式 (src_path IS NULL) 下有效; 引用模式的字节归源文件。
-- 注意: D1(SQLite) 的 ALTER TABLE 没有 IF NOT EXISTS, 列已存在时会报错, 忽略即可。
ALTER TABLE fs_nodes        ADD COLUMN db_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE image_host      ADD COLUMN db_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE upload_sessions ADD COLUMN db_id INTEGER NOT NULL DEFAULT 1;

-- ---------------- 播种主库行 ----------------
-- IGNORE: 重跑不会覆盖已有注册表。database_id 留空不影响使用, 配置了
-- CF_API_TOKEN + CF_ACCOUNT_ID 后由每日校准自动回填; slot_quota=10 为免费版
-- 账号总名额 (每账号 10 个 D1 库), 可按需调小。
INSERT OR IGNORE INTO storage_dbs (id, binding, label, role, state, slot_quota, created_at)
VALUES (1, 'DB', '主库', 'primary', 'active', 10, 1757904000000);
