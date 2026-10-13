-- file-manager (Workers 版) D1 schema
-- 执行: wrangler d1 execute file-manager --remote --file=./schema.sql

-- 虚拟文件系统: 目录与文件统一存一张表 (Stage 3 规范化)
--   id / parent_id 为唯一事实源 (稳定代理键 + 自引用, parent_id=0 表示根);
--   path 是物化路径 (前端契约与子树前缀查询依赖它, 属正当设计, 刻意保留)。
CREATE TABLE IF NOT EXISTS fs_nodes (
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
  db_id       INTEGER NOT NULL DEFAULT 1 CHECK (db_id >= 1),  -- 字节所在库 (1=主库 DB, 2=DB2 ...)
  content_id  TEXT,                          -- 文件行非空 (字节键 'c:<id>'); 目录行 NULL
  CHECK (is_dir = 1 OR content_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_path    ON fs_nodes(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fs_sibling ON fs_nodes(parent_id, name);
CREATE INDEX        IF NOT EXISTS ix_fs_parent  ON fs_nodes(parent_id);
CREATE INDEX        IF NOT EXISTS ix_fs_content ON fs_nodes(content_id);

-- 文件内容分片 (1MB/片)。key: 'f:<path>' 文件管理器 / 'i:<filename>' 图床
-- hash: 分片内容 SHA-256 十六进制 (前端计算); 用于断点续传时校验同名分片内容一致
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  hash TEXT,
  PRIMARY KEY (key, idx)
);

-- 内容去重索引 (秒传): (hash, size) → content_id; 字节键 = 'c:<id>', 多条目共享一份存储
CREATE TABLE IF NOT EXISTS contents (
  id         TEXT PRIMARY KEY,        -- 随机 content_id, 字节键 = 'c:<id>'
  hash       TEXT NOT NULL,           -- 全文件 SHA-256 hex (前端计算)
  size       INTEGER NOT NULL,
  db_id      INTEGER NOT NULL DEFAULT 1,
  nchunks    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contents_hash_size ON contents(hash, size);
-- 注: idx_image_host_content / idx_ih_src_path 必须排在 image_host 建表语句之后
-- (原脚本把它排在建表之前, 单文件执行会因表不存在而失败)。见下方 image_host 定义后。

-- 图床元数据: src_node_id 为唯一引用 (引用 fs_nodes.id); 自持条目用 content_id
CREATE TABLE IF NOT EXISTS image_host (
  filename      TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  upload_time   TEXT NOT NULL,
  src_node_id   INTEGER,                     -- 非空 = 引用文件管理节点。改名/移动后引用不变; NULL = 自持
  db_id         INTEGER NOT NULL DEFAULT 1 CHECK (db_id >= 1),
  content_id    TEXT,                        -- 自持条目字节键 'c:<content_id>'; 引用型为 NULL
  CHECK (NOT (src_node_id IS NOT NULL AND content_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ih_src_node ON image_host(src_node_id);   -- 引用反查 (删除/覆盖源文件时)
CREATE INDEX IF NOT EXISTS ix_ih_content  ON image_host(content_id);    -- 引用计数动态统计用

-- 分享链接: 引用 fs_nodes.id (0=根); 改名/移动后分享仍有效
CREATE TABLE IF NOT EXISTS share_links (
  id               TEXT PRIMARY KEY,
  node_id          INTEGER NOT NULL DEFAULT 0 CHECK (node_id >= 0),
  password         TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_share_node ON share_links(node_id);

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
  merged_upto  INTEGER NOT NULL DEFAULT 0, -- complete 分批合并: 已合并进最终键的分片数
  db_id        INTEGER NOT NULL DEFAULT 1, -- 钉库: 暂存分片与转正后的字节必须在同一个库
  content_id   TEXT,                       -- 内容键 id (合并目标 'c:<id>'); NULL = 旧会话
  content_hash TEXT                         -- 全文件 SHA-256 (前端算); complete 时注册 contents 去重索引
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
  updated_at    TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0  -- 改密码/改用户名时 +1, 使已签发的 JWT 立即失效
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
-- 配置了 CF_API_TOKEN + CF_ACCOUNT_ID 后由每日校准自动回填。取值与
-- migrations/2026-09-15-db-sharding.sql 对齐: reserve_bytes=100MiB, slot_quota=6
-- = 1 主 + 5 从; 账号 10 库中其余项目占 4。可按需调小/调大）
INSERT OR IGNORE INTO storage_dbs (id, binding, label, role, state, reserve_bytes, slot_quota, created_at)
VALUES (1, 'DB', '主库', 'primary', 'active', 104857600, 6, 1757904000000);

-- 迁移版本台账（见 migrations/2026-10-13-stage0-baseline.sql）
-- 记录已应用的迁移文件名, 让迁移脚本可判断是否重复执行。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 歌词持久化(见 migrations/2026-09-16-lyrics-store.sql)
-- 只写"取到歌词"的结果(found=1), 长期有效(拉黑/改歌曲信息时删); "没找到"不入库, 只走边缘缓存 6 小时
CREATE TABLE IF NOT EXISTS lyrics (
  node_id    INTEGER PRIMARY KEY,   -- fs_nodes.id (改名/移动后歌词跟随)
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
CREATE INDEX IF NOT EXISTS idx_lyrics_fetched_at ON lyrics (fetched_at);

-- 歌词拉黑(见 migrations/2026-09-16-lyrics-reject.sql)
CREATE TABLE IF NOT EXISTS lyrics_reject (
  node_id INTEGER PRIMARY KEY,
  sources TEXT NOT NULL DEFAULT '[]',
  ts      INTEGER NOT NULL
);

-- 歌曲元数据: 用户手动覆盖的歌名/歌手/专辑/歌词偏移(见 migrations/2026-09-15-track-meta.sql)
-- 此前只存在于该迁移文件, schema.sql 漏了 → 按本文件重建会缺表, 代码只能靠运行时自愈。此处补齐。
CREATE TABLE IF NOT EXISTS track_meta (
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
CREATE INDEX IF NOT EXISTS idx_track_meta_updated ON track_meta(updated_at);
