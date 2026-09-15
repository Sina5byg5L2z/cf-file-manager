-- 歌词拉黑: 用户对某文件的在线歌词一键"拒绝", 记录被拉黑的来源。
-- sources 为 JSON 数组(如 ["lrclib"]); 链上全部来源被拉黑时 /api/lyrics 直接返回 rejected。
-- path 为主键: "这首歌词是错的"是针对具体文件的判断; 撤销即删行。
CREATE TABLE IF NOT EXISTS lyrics_reject (
  path    TEXT PRIMARY KEY,
  sources TEXT NOT NULL DEFAULT '[]',
  ts      INTEGER NOT NULL
);
