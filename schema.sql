-- file-manager (Workers 版) D1 schema
-- 执行: wrangler d1 execute file-manager --remote --file=./schema.sql

-- 虚拟文件系统: 目录与文件统一存一张表
-- path 形如 ""(根) / "docs" / "docs/a.txt"; parent 是父目录 path; name 是自身名
CREATE TABLE IF NOT EXISTS fs_nodes (
  path        TEXT PRIMARY KEY,
  parent      TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  is_dir      INTEGER NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  nchunks     INTEGER NOT NULL DEFAULT 0,
  db_id       INTEGER NOT NULL DEFAULT 1   -- 字节所在库 (1=主库 DB, 2=DB2 ...); 见 storage_dbs
);
CREATE INDEX IF NOT EXISTS idx_fs_parent ON fs_nodes(parent);
CREATE INDEX IF NOT EXISTS idx_fs_name   ON fs_nodes(name);

-- 文件内容分片 (1MB/片)。key: 'f:<path>' 文件管理器 / 'i:<filename>' 图床
-- hash: 分片内容 SHA-256 十六进制 (前端计算); 用于断点续传时校验同名分片内容一致
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  hash TEXT,
  PRIMARY KEY (key, idx)
);

-- 图床元数据（与原版 image_host.db 对应）
CREATE TABLE IF NOT EXISTS image_host (
  filename      TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  upload_time   TEXT NOT NULL,
  db_id         INTEGER NOT NULL DEFAULT 1  -- 字节所在库 (仅自持模式有效; 引用模式字节归源文件)
);

-- 分享链接（与原版 share_data.db 对应; password 为 pbkdf2$salt$hash）
CREATE TABLE IF NOT EXISTS share_links (
  id               TEXT PRIMARY KEY,
  path             TEXT NOT NULL,
  password         TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT
);

-- 分片上传会话（分片先写入 blobs 的 'u:<id>' 暂存键，complete 时合并）
-- file_key: 文件指纹 (前端计算: 文件名+大小+最后修改时间+首尾分片hash 的 SHA-256);
--           用于"重新选同一文件"时跨会话匹配到未完成的 session, 复用已传分片
-- chunk_size: 该 session 使用的分片大小 (字节); 续传要求前后分片大小一致
-- updated_at: 最近一次有分片写入的时间; 定时清理据此判断 (活跃续传不会被误删)
CREATE TABLE IF NOT EXISTS upload_sessions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,           -- 'file' | 'image'
  target       TEXT NOT NULL,           -- 最终 fs path 或图床 filename
  filename     TEXT NOT NULL,           -- 原始文件名
  total_chunks INTEGER NOT NULL,
  mime         TEXT NOT NULL DEFAULT '',
  file_size    INTEGER NOT NULL DEFAULT 0,
  file_key     TEXT NOT NULL DEFAULT '',
  chunk_size   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  b2_key       TEXT NOT NULL DEFAULT '',   -- 预留 (B2 方案未落地)
  merged_upto  INTEGER NOT NULL DEFAULT 0, -- complete 分批合并: 已合并进最终键的分片数
  db_id        INTEGER NOT NULL DEFAULT 1  -- 钉库: 暂存分片与转正后的字节必须在同一个库
);
CREATE INDEX IF NOT EXISTS idx_us_file_key ON upload_sessions(file_key);

-- 应用参数设置（单行, key='ui', value=JSON; 由页面"参数设置"维护: 分片大小/
-- 并发数/移动端与电脑端的上传与预览大小上限。缺省值在 src/settings.js 中兜底）
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 登录用户（单用户系统, id 恒为 1; 可在页面"账号设置"中修改用户名与密码;
-- 首次登录时若表为空, 自动从 env secret AUTH_PASSWORD_HASH/AUTH_PASSWORD 播种）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- pbkdf2$<iter>$<saltB64>$<hashB64>
  updated_at    TEXT NOT NULL
);

-- ---------------- 存储分库（元数据永在主库, 文件字节按"文件"分散到各库） ----------------
-- 库注册表。id 与 binding 名恒等: 1='DB', 2='DB2', 3='DB3' ...（代码由 binding 名反解 id, 路由不查表）
-- state: 'active' 接新文件 / 'standby' 已登记未启用 / 'full' 装满 / 'retired' 退役(只读, 不搬迁)
-- slot_quota 仅主库行有效: 本账号可用于本项目的库数上限（Cloudflare 免费版每账号 10 个 D1 库）
CREATE TABLE IF NOT EXISTS storage_dbs (
  id            INTEGER PRIMARY KEY,
  binding       TEXT    NOT NULL UNIQUE,
  database_id   TEXT    NOT NULL DEFAULT '',
  label         TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'slave',     -- 'primary' | 'slave'
  state         TEXT    NOT NULL DEFAULT 'standby',
  limit_bytes   INTEGER NOT NULL DEFAULT 524288000,   -- 单库硬上限 (免费版 500MiB)
  reserve_bytes INTEGER NOT NULL DEFAULT 33554432,    -- 预留: 页开销/索引/操作余量
  used_bytes    INTEGER NOT NULL DEFAULT 0,           -- 当前占用 (累加值, 每日 cron 校准)
  calibrated_at INTEGER NOT NULL DEFAULT 0,
  slot_quota    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 跨库操作日志: 跨库改名/删除没有事务保护, 失败的字节操作写进这里, 由每日 cron 重试
CREATE TABLE IF NOT EXISTS blob_journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL,          -- 'delete' | 'rename'
  db_id      INTEGER NOT NULL,
  old_key    TEXT NOT NULL,
  new_key    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bj_db ON blob_journal(db_id);

-- 播种主库行（IGNORE: 已有注册表的库重跑本文件不会被覆盖。database_id 留空不影响使用,
-- 配置了 CF_API_TOKEN + CF_ACCOUNT_ID 后由每日校准自动回填; slot_quota=10 为免费版
-- 账号总名额, 可按需调小）
INSERT OR IGNORE INTO storage_dbs (id, binding, label, role, state, slot_quota, created_at)
VALUES (1, 'DB', '主库', 'primary', 'active', 10, 1757904000000);
