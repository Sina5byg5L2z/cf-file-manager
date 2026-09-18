// ============================================================================
// util.js — 通用工具: MIME 表 / 路径处理 / 缓存助手 / PBKDF2 / 常量
// ============================================================================

// 分片大小: D1 单行上限 2MB, 取 1MB 留足余量 (直传写库用; 分片上传的真实大小由前端决定)
export const CHUNK_SIZE = 1024 * 1024;
// 分片上传可能出现过的真实分片大小 (前端默认/自适应缩片/历史版本)
const CHUNK_CANDIDATES = [32768, 65536, 131072, 262144, 524288, 1048576];
// 由 (size, nchunks) 推导真实分片大小: 候选集内唯一解;
// nchunks<=1 时单分片, 任意候选的 idx 换算都等价, 返回默认值即可
export function deriveChunkSize(size, nchunks) {
  if (!size || !nchunks || nchunks <= 1) return CHUNK_SIZE;
  for (const c of CHUNK_CANDIDATES) {
    if (Math.ceil(size / c) === nchunks) return c;
  }
  return CHUNK_SIZE;
}
// nchunks 未知时 (图床旧数据) 用 blobs 计数兜底, 结果与 nchunks 等价
export async function chunkCount(db, key) {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM blobs WHERE key = ?1').bind(key).first();
  return (r && r.c) || 0;
}
// 边缘缓存中单个文件响应的最大体积(字节), 超过则不缓存只直读
export const CACHE_MAX_FILE = 24 * 1024 * 1024;

// ---------------- MIME ----------------
const MIME_MAP = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  mjs: 'application/javascript', json: 'application/json', xml: 'application/xml',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  tsv: 'text/tab-separated-values', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
  yaml: 'application/x-yaml', yml: 'application/x-yaml', toml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  avif: 'image/avif', tiff: 'image/tiff',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', wma: 'audio/x-ms-wma', m4a: 'audio/mp4', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const TEXT_EXTS = new Set([
  'txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'json', 'xml',
  'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'rb', 'java', 'c', 'cpp',
  'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'php', 'sql', 'sh', 'bash', 'zsh', 'bat',
  'ps1', 'r', 'lua', 'pl', 'pm', 'dart', 'scala', 'groovy', 'less', 'scss', 'sass',
  'md', 'mdx', 'markdown', 'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'env', 'svg',
]);

export function fileExt(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  // 点文件 (.gitignore/.env.local): 取首点后的整体作为 ext
  if (i === 0) return name.slice(1).toLowerCase();
  return name.slice(i + 1).toLowerCase();
}

export function mimeFromName(name) {
  return MIME_MAP[fileExt(name)] || 'application/octet-stream';
}

export function isTextName(name) {
  const mime = mimeFromName(name);
  if (mime.startsWith('text/') || mime === 'application/json' ||
      mime === 'application/xml' || mime === 'application/javascript' ||
      mime === 'application/x-yaml') return true;
  return TEXT_EXTS.has(fileExt(name));
}

export function isImageName(name) { return mimeFromName(name).startsWith('image/'); }
export function isVideoName(name) { return mimeFromName(name).startsWith('video/'); }
export function isAudioName(name) { return mimeFromName(name).startsWith('audio/'); }
export function isPdfName(name)  { return mimeFromName(name) === 'application/pdf'; }
export function isMediaName(name) {
  const m = mimeFromName(name);
  return m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/') || m === 'application/pdf';
}

// ---------------- 路径处理 ----------------
// 与原版 utils::sanitize_path 一致: 去空段/./.., 反斜杠归一, 防穿越
export function sanitizeRel(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

// 原版 utils::sanitize_filename: 只取末段、去控制字符、去空
export function sanitizeFilename(name) {
  const cleaned = String(name == null ? '' : name).replace(/\0/g, '');
  const last = cleaned.split(/[\\/]/).pop() || '';
  if (last === '..' || last === '.') return 'upload';
  const result = Array.from(last).filter((c) => {
    const code = c.charCodeAt(0);
    return !(code < 0x20 || code === 0x7f);
  }).join('');
  return result || 'upload';
}

// 由相对路径拆出 (parent, name); 根目录返回 null
export function splitPath(p) {
  const clean = sanitizeRel(p);
  if (!clean) return null;
  const i = clean.lastIndexOf('/');
  return { parent: i === -1 ? '' : clean.slice(0, i), name: clean.slice(i + 1), path: clean };
}

// ---------------- 子树前缀匹配 (替代 LIKE 'path/%') ----------------
// D1 的 LIKE pattern 有硬上限: 实测 pattern ≥ 49 字节即报
//   "D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR" (SQLITE_MAX_LIKE_PATTERN_LENGTH
//  在 D1 侧被设成 50, 而非标准 SQLite 的 50000)。
//   → 路径只要 ≥ 47 字节(≈16 个汉字) 的移动/复制/删除/图床反查全部 500。
// 另外 LIKE 会把路径里的 '%' '_' 当通配符 (文件名合法字符), 语义也是错的。
// 统一改成 substr 精确前缀匹配: <col> = ?1 OR substr(<col>, 1, length(?1)+1) = ?1 || '/'
// 注意: SQLite 的 length()/substr() 按字符数而非字节数, 多字节路径自动对齐。
export const subtreeMatch = (col, param = '?1') =>
  `${col} = ${param} OR substr(${col}, 1, length(${param}) + 1) = ${param} || '/'`;

// RFC5987 Content-Disposition 文件名编码
export function encodeFilename(name) {
  let out = '';
  for (const b of new TextEncoder().encode(name)) {
    out += (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
      b === 0x5f || b === 0x2e || b === 0x2d ? String.fromCharCode(b)
      : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function contentDisposition(kind, filename) {
  return `${kind}; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeFilename(filename)}`;
}

// ---------------- 响应助手 ----------------
// 全站安全响应头。静态资源由 public/_headers 覆盖; 凡本文件/vfs.js 构造的响应都带上,
// index.js 的 harden() 再对兜底路径补一次。
//   Referrer-Policy: no-referrer —— 不把当前 URL(可能带查询参数)经 Referer 传给第三方。
//     注: Chrome 85+ 默认已是 strict-origin-when-cross-origin, 这里显式声明不依赖浏览器默认值。
//   X-Content-Type-Options: nosniff —— 禁止按内容嗅探类型。
export const SEC_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...headers },
  });
}
export const jerr = (msg, status = 400) => json({ error: msg }, status);

// ---------------- 边缘缓存助手 (免费且不占 KV/D1 额度) ----------------
const CACHE_NS = 'https://fm-cache.internal/';
export function cacheKey(key) { return new Request(CACHE_NS + key, { method: 'GET' }); }

export async function cacheGet(key) {
  try { return await caches.default.match(cacheKey(key)); } catch { return null; }
}

export async function cachePut(key, response, ttlSec) {
  try {
    const res = new Response(response.body, response);
    res.headers.set('Cache-Control', `public, max-age=${ttlSec}`);
    // Cache API 要求 URL 为 http(s); 用内部命名空间 + 唯一键
    await caches.default.put(cacheKey(key), res);
  } catch { /* 缓存失败不影响业务 */ }
}

export async function cacheDel(key) {
  try { await caches.default.delete(cacheKey(key)); } catch { /* noop */ }
}

// ---------------- PBKDF2 密码哈希 ----------------
// 格式: pbkdf2$<iter>$<saltB64>$<hashB64>; 登录口令同样适用
const PBKDF2_ITER = 25000;

function b64(buf) {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
export function b64decode(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10) || PBKDF2_ITER;
  const salt = b64decode(parts[2]);
  const expect = b64decode(parts[3]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, expect.length * 8);
  const got = new Uint8Array(bits);
  let diff = got.length ^ expect.length;
  for (let i = 0; i < got.length && i < expect.length; i++) diff |= got[i] ^ expect[i];
  return diff === 0;
}

// 常数时间字符串比较 (用于明文口令回退)
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------- 随机 ID ----------------
export function randomId(len) {
  const alphabet = '0123456789abcdef';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % 16];
  return s;
}

// ---------------- SHA-256 (hex) ----------------
// 用于分片 hash 校验; 仅在前端未提供 hash 时由服务端兜底计算
export async function sha256Hex(buf) {
  const bits = await crypto.subtle.digest('SHA-256', buf);
  const u = new Uint8Array(bits);
  let s = '';
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
  return s;
}

// ---------------- Range 解析 (对应原版 media.rs) ----------------
// 返回: null=整文件  {start,end}=区间  'unsatisfiable'=416
export function parseRange(headerValue, size) {
  if (!headerValue || !headerValue.startsWith('bytes=') || size === 0) return null;
  const first = headerValue.slice(6).split(',')[0].trim();
  const dash = first.indexOf('-');
  if (dash === -1) return 'unsatisfiable';
  const startS = first.slice(0, dash).trim();
  const endS = first.slice(dash + 1).trim();
  if (startS === '') {
    // 后缀区间 bytes=-N
    const n = parseInt(endS, 10);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = parseInt(startS, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return start >= size ? 'unsatisfiable' : null;
  let end = size - 1;
  if (endS !== '') {
    const e = parseInt(endS, 10);
    if (!Number.isFinite(e) || e < start) return 'unsatisfiable';
    end = Math.min(e, size - 1);
  }
  return { start, end };
}

export function hasRangeHeader(req) {
  return !!req.headers.get('Range');
}

// ---------------- 流式读取 blob 分片并构造响应 ----------------
// rows 按 (key, idx) 有序读出 data; 分批查询, 内存占用恒定
export function blobStream(db, key, startIdx, endIdx) {
  const BATCH = 8; // 每次查询 8MB, 控制 D1 单次返回体积
  let cur = startIdx;
  return new ReadableStream({
    async pull(controller) {
      if (cur > endIdx) { controller.close(); return; }
      const hi = Math.min(cur + BATCH - 1, endIdx);
      const res = await db.prepare('SELECT idx, data FROM blobs WHERE key = ?1 AND idx BETWEEN ?2 AND ?3 ORDER BY idx')
        .bind(key, cur, hi).all();
      const rows = res.results || [];
      if (!rows.length) { controller.close(); return; }
      for (const r of rows) controller.enqueue(new Uint8Array(r.data));
      cur = rows[rows.length - 1].idx + 1;
    },
  });
}

// ---------------- ZIP 打包 (STORE, 流式) ----------------
// 免费版 Worker CPU 10ms, 故不做 DEFLATE; CRC32 用查表法尽量压缩 CPU 时间
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(u8) {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// entries: [{name, size, stream: ReadableStream}]  → zip 流
export function zipStream(entries) {
  const enc = new TextEncoder();
  let i = 0;
  let offset = 0;
  const centrals = [];
  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);

  return new ReadableStream({
    async pull(controller) {
      if (i >= entries.length) {
        // central directory
        for (const c of centrals) {
          controller.enqueue(enc.encode('PK\x01\x02'));
          controller.enqueue(u16(20)); controller.enqueue(u16(20));
          controller.enqueue(u16(0x0800)); controller.enqueue(u16(0));
          controller.enqueue(u16(0)); controller.enqueue(u16(0));
          controller.enqueue(u32(c.crc)); controller.enqueue(u32(c.size)); controller.enqueue(u32(c.size));
          controller.enqueue(u16(c.nameLen)); controller.enqueue(u16(0)); controller.enqueue(u16(0));
          controller.enqueue(u16(0)); controller.enqueue(u16(0)); controller.enqueue(u32(0));
          controller.enqueue(u32(c.offset));
          controller.enqueue(enc.encode(c.name));
        }
        // end record
        controller.enqueue(enc.encode('PK\x05\x06'));
        controller.enqueue(u16(0)); controller.enqueue(u16(0));
        controller.enqueue(u16(entries.length)); controller.enqueue(u16(entries.length));
        controller.enqueue(u32(centrals.reduce((s, c) => s + 46 + c.nameLen, 0)));
        controller.enqueue(u32(offset));
        controller.enqueue(u16(0));
        controller.close();
        return;
      }
      const e = entries[i++];
      const nameBytes = enc.encode(e.name);
      const crc = e.crc != null ? e.crc : 0;
      controller.enqueue(enc.encode('PK\x03\x04'));
      controller.enqueue(u16(20)); controller.enqueue(u16(0x0800)); controller.enqueue(u16(0));
      controller.enqueue(u16(0)); controller.enqueue(u16(0x21)); // 1980-01-01
      controller.enqueue(u32(crc)); controller.enqueue(u32(e.size)); controller.enqueue(u32(e.size));
      controller.enqueue(u16(nameBytes.length)); controller.enqueue(u16(0));
      controller.enqueue(nameBytes);
      const reader = e.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      centrals.push({ name: e.name, nameLen: nameBytes.length, crc, size: e.size, offset });
      offset += 30 + nameBytes.length + e.size;
    },
  });
}

// 分片下载流 + CRC 计算 (供 zip 使用): 边读边算 CRC
export async function crcOfStream(stream) {
  const reader = stream.getReader();
  let crc = -1;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    for (let i = 0; i < value.length; i++) crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
  }
  return { crc: (crc ^ -1) >>> 0, size: chunks.reduce((s, c) => s + c.length, 0), replay() { return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }); } };
}
