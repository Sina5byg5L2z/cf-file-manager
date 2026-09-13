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
  nchunks     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fs_parent ON fs_nodes(parent);
CREATE INDEX IF NOT EXISTS idx_fs_name   ON fs_nodes(name);

-- 文件内容分片 (1MB/片)。key: 'f:<path>' 文件管理器 / 'i:<filename>' 图床
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, idx)
);

-- 图床元数据（与原版 image_host.db 对应）
CREATE TABLE IF NOT EXISTS image_host (
  filename      TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  upload_time   TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS upload_sessions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,           -- 'file' | 'image'
  target       TEXT NOT NULL,           -- 最终 fs path 或图床 filename
  filename     TEXT NOT NULL,           -- 原始文件名
  total_chunks INTEGER NOT NULL,
  mime         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

-- 登录用户（单用户系统, id 恒为 1; 可在页面"账号设置"中修改用户名与密码;
-- 首次登录时若表为空, 自动从 env secret AUTH_PASSWORD_HASH/AUTH_PASSWORD 播种）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- pbkdf2$<iter>$<saltB64>$<hashB64>
  updated_at    TEXT NOT NULL
);
