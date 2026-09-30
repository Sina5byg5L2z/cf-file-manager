-- 秒传 / 内容寻址去重 (2026-09-30)
--
-- 模型: 新上传的文件字节不再按路径落 blobs ('f:<path>'/'i:<filename>'),
--       而是落在内容键 'c:<content_id>' 下; fs_nodes / image_host 通过
--       content_id 引用同一份字节。多表引用由删除方的引用计数保证。
--       contents 表是 (hash, size) → content_id 的去重索引 (秒传探测用)。
--       content_id 为 NULL 的行 = 历史数据, 仍按 'f:<path>' 旧键读写 (无需搬迁)。
--
-- 回滚: 本迁移只加列/加表, 不改任何既有列, 可安全回退代码。

ALTER TABLE fs_nodes ADD COLUMN content_id TEXT;             -- NULL = 旧格式 (字节在 'f:<path>')
ALTER TABLE image_host ADD COLUMN content_id TEXT;           -- NULL = 旧格式 (字节在 'i:<filename>')
ALTER TABLE upload_sessions ADD COLUMN content_id TEXT;      -- 分片上传钉住的内容键 (合并目标 'c:<id>')
ALTER TABLE upload_sessions ADD COLUMN content_hash TEXT;    -- 全文件 SHA-256 (前端算), complete 时注册去重索引

CREATE TABLE IF NOT EXISTS contents (
  id         TEXT PRIMARY KEY,        -- 随机 content_id, 字节键 = 'c:<id>'
  hash       TEXT NOT NULL,           -- 全文件 SHA-256 hex (前端计算)
  size       INTEGER NOT NULL,
  db_id      INTEGER NOT NULL DEFAULT 1,
  nchunks    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contents_hash_size ON contents(hash, size);

-- 引用计数是动态查询 (fs_nodes + image_host), 这两个索引让它不至于扫全表
CREATE INDEX IF NOT EXISTS idx_fs_nodes_content ON fs_nodes(content_id);
CREATE INDEX IF NOT EXISTS idx_image_host_content ON image_host(content_id);
