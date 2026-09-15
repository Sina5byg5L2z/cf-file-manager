-- ============================================================================
-- 2026-09-15 — 歌曲元数据（用户编辑 / 内嵌标签缓存）
--
-- 背景: 播放器要显示歌名/歌手/专辑与歌词。元数据有三个来源,
--       优先级 用户手动编辑 > 音频内嵌标签(ID3/FLAC/MP4) > 文件名解析。
--       其中只有「用户手动编辑」需要持久化 —— 内嵌标签每次读文件头即可,
--       文件名解析是纯函数。所以本表只存用户覆盖过的字段。
--
-- 设计要点
--   - path 主键: 与 fs_nodes.path 对齐。文件改名/移动时本行不跟随
--     (改名后视为新条目, 回落到内嵌标签/文件名解析; 旧行由下面清理)。
--   - 字段可空: NULL 表示「用户没覆盖过」, 读取时按优先级回落到下一来源。
--     不能用空字符串表示未设置, 否则无法区分「用户清空了歌手」和「没设置」。
--   - lyric_offset: 毫秒, 歌词整体偏移(用户微调"歌词快了/慢了")。
--   - lrc / trans: 用户直接粘贴的歌词文本(覆盖在线歌词 / 译文)。
--   - source: 仅作展示用 ('manual' | 'id3' | 'filename'), 不参与优先级判定。
--
-- 体积: 约 300B/首, 5000 首 ≈ 1.5MB, 对主库余量可忽略。
--
-- 幂等: CREATE TABLE IF NOT EXISTS, 可重复执行。
-- 执行: wrangler d1 execute file-manager --remote --file=./migrations/2026-09-15-track-meta.sql
-- ============================================================================

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

-- 核对: 应为 1 表 / 1 索引, 初始 0 行
SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table'  AND name='track_meta') AS has_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index'  AND name='idx_track_meta_updated') AS has_idx,
  (SELECT COUNT(*) FROM track_meta) AS rows;
