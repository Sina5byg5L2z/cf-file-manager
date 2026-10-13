// ============================================================================
// diag.js — 数据完整性诊断 (只读)
//
// 表间引用已全部改为「逻辑外键」(SQLite/D1 不支持跨库物理外键, 且会话级
// PRAGMA foreign_keys 在 Workers 里不可靠), 因此完整性靠**定期诊断**兜底:
// 每日 cron 跑一次, 有异常就打日志 (而不是让坏引用静默存活)。
//
// 只查主库内可判定的项; 跨库的「内容缺字节」不在此列 (blobs 散在从库,
// 主库查不到 —— 那类由 blob_journal 重试与引用计数机制保证)。
// ============================================================================

export async function diagIntegrity(db) {
  const out = [];
  const one = async (name, sql) => {
    try {
      const r = await db.prepare(sql).first();
      const n = r ? Number(Object.values(r)[0]) || 0 : 0;
      if (n) out.push({ check: name, count: n });
    } catch (e) {
      out.push({ check: name, error: String((e && e.message) || e) });
    }
  };

  await one('fs_nodes.parent_id 悬空',
    'SELECT COUNT(*) AS n FROM fs_nodes c WHERE c.parent_id != 0 AND NOT EXISTS (SELECT 1 FROM fs_nodes p WHERE p.id = c.parent_id)');
  await one('fs_nodes 文件行缺 content_id',
    'SELECT COUNT(*) AS n FROM fs_nodes WHERE is_dir = 0 AND content_id IS NULL');
  await one('fs_nodes 路径与 parent_id 不一致',
    `SELECT COUNT(*) AS n FROM fs_nodes c WHERE c.parent_id != 0
       AND (SELECT p.path FROM fs_nodes p WHERE p.id = c.parent_id) || '/' || c.name != c.path`);
  await one('contents 缺 db_id 对应库',
    'SELECT COUNT(*) AS n FROM contents c WHERE NOT EXISTS (SELECT 1 FROM storage_dbs s WHERE s.id = c.db_id)');
  await one('image_host 引用悬空',
    'SELECT COUNT(*) AS n FROM image_host WHERE src_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = image_host.src_node_id)');
  await one('share_links 引用悬空',
    'SELECT COUNT(*) AS n FROM share_links WHERE node_id != 0 AND NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = share_links.node_id)');
  await one('lyrics 引用悬空',
    'SELECT COUNT(*) AS n FROM lyrics WHERE NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = lyrics.node_id)');
  await one('lyrics_reject 引用悬空',
    'SELECT COUNT(*) AS n FROM lyrics_reject WHERE NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = lyrics_reject.node_id)');
  await one('track_meta 引用悬空',
    'SELECT COUNT(*) AS n FROM track_meta WHERE NOT EXISTS (SELECT 1 FROM fs_nodes f WHERE f.id = track_meta.node_id)');

  return out;
}
