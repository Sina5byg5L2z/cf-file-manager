-- 歌词持久化到 D1 (2026-09-16)
-- 背景: 此前联网取到的歌词只落在 Cache API (边缘缓存, 会被淘汰, 且分享页无法读取)。
-- 现在歌词统一落 D1, 管理页与分享页共用同一份数据。
--
-- 语义:
--   found = 1 → 取到了歌词, 长期有效。仅在这几种情况下删除: 拉黑来源、撤销拉黑、修改歌曲信息(标题/歌手)。
--   found = 0 → 不写入。"没找到"不进 D1, 只由边缘缓存挡 6 小时(避免把"当时没找到"长期钉死);
--               读取时遇到历史遗留的 found=0 行会被清掉。
--   duration  → 取到歌词时用的时长(可能为 0)。请求带 duration 且与库内相差 >2s 时视为不匹配, 重新取,
--               防止"先按文件名粗查到的错歌词"被长期钉住。库内为 0 时不重取(避免每首歌双次上游)。
-- path 为主键: 与 track_meta / lyrics_reject 一致, 按文件定位。
CREATE TABLE IF NOT EXISTS lyrics (
  path       TEXT PRIMARY KEY,
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
