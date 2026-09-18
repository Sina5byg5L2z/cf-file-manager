// ============================================================================
// auth.js — JWT (HS256) 登录/校验 + 登录限流 (对应原版 auth.rs)
// 说明: Workers 上没有 bcrypt; 密码用 PBKDF2-SHA256 (见 util.js / tools/hash-password.mjs)
// 限流为单 isolate 内存实现, 属尽力而为; 免费 10ms CPU 也无法承受 bcrypt
// ============================================================================

import { json, jerr, verifyPassword, safeEqual, hashPassword } from './util.js';

const b64url = (buf) => {
  let s = '';
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
};

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createToken(username, secret, expireHours, tokenVersion = 0) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const exp = Math.floor(Date.now() / 1000) + expireHours * 3600;
  // tv = 签发时的 users.token_version; 校验时比对, 改密码/改用户名即作废
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub: username, exp, tv: tokenVersion | 0 })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function validateToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const key = await hmacKey(secret);
  const sigBytes = new Uint8Array(b64urlDecode(parts[2]).length);
  {
    const bin = b64urlDecode(parts[2]);
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  }
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const bin = b64urlDecode(parts[1]);
    const payloadBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) payloadBytes[i] = bin.charCodeAt(i);
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch { return null; }
}

// ---------------- 凭据提取 ----------------
// 两条通道:
//  1) Authorization: Bearer <jwt> —— 所有 fetch/XHR 调用与写操作的唯一通道
//  2) 只读 Cookie (fm_ro) —— 供 <img>/<video>/<audio>/<iframe>/<a download> 这类
//     浏览器不允许自定义请求头的子资源使用。**仅接受 GET**:
//     本项目的写操作全是 POST/PUT/DELETE, 因此 Cookie 永远无法授权一次写请求, 天然排除 CSRF;
//     SameSite=Lax 再收一层 —— 跨站发起的子资源请求根本不会带上它。
//
// 历史: 这两类子资源此前走 `?token=` 查询参数, 使 JWT 进入 URL ——
// 会落到 Workers Logs(含完整 URL)/浏览器地址栏/可复制链接里。该通道已移除, 不再兼容。
const RO_COOKIE = 'fm_ro';

export function cookieValue(req, name) {
  const raw = req.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Secure 只对 https 下发: 本地 wrangler dev 走 http://localhost, 带 Secure 会被浏览器丢弃
export function isSecureReq(req) {
  try { return new URL(req.url).protocol === 'https:'; } catch { return true; }
}

export function cookieHeader(name, value, ttlSec, path, secure) {
  return `${name}=${value}; Path=${path}; Max-Age=${ttlSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function roCookieHeader(token, ttlSec, secure) {
  return cookieHeader(RO_COOKIE, token, ttlSec, '/', secure);
}

// 让浏览器立刻丢弃只读 Cookie: HttpOnly 的 Cookie 无法由 JS 删除, 只能靠这个响应头
export function roCookieClear(secure) {
  return cookieHeader(RO_COOKIE, '', 0, '/', secure);
}

export function extractToken(req) {
  const auth = req.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.method === 'GET') return cookieValue(req, RO_COOKIE);
  return null;
}

// ---------------- 通用 HMAC 签名 (分享会话等复用; 与 JWT 用途隔离, payload 自带类型前缀) ----------------
export async function signPayload(payload, secret) {
  const key = await hmacKey(secret);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

export async function verifyPayload(payload, sig, secret) {
  if (!sig) return false;
  let bytes;
  try {
    const bin = b64urlDecode(sig);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return false; }
  const key = await hmacKey(secret);
  try {
    return await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(payload));
  } catch { return false; }
}

// 令牌版本比对: 改密码/改用户名会把 users.token_version +1, 旧令牌立即失效。
// 复用 60s isolate 用户缓存, 不额外产生 D1 读取。
export async function checkTokenFresh(claims, db) {
  const row = await getUserRow(db);
  const cur = row ? (row.token_version | 0) : 0;
  return (claims.tv | 0) === cur;
}

export async function checkAuth(req, env, db) {
  const token = extractToken(req);
  if (!token) return jerr('未提供令牌', 401);
  const claims = await validateToken(token, env.JWT_SECRET).catch(() => null);
  if (!claims) return jerr('无效的令牌', 401);
  if (!(await checkTokenFresh(claims, db))) return jerr('令牌已失效，请重新登录', 401);
  return null;
}

// ---------------- 用户表 (单用户, users.id=1) ----------------
// isolate 内存缓存 60s: 登录/WebDAV 认证每分钟至多 1 次 D1 读, 省额度
let userCache = null; // { row: {username, password_hash} | null, at }
const USER_TTL = 60_000;
function invalidateUserCache() { userCache = null; }

async function getUserRow(db) {
  if (userCache && Date.now() - userCache.at < USER_TTL) return userCache.row;
  let row = null;
  try {
    row = await db.prepare('SELECT username, password_hash, token_version FROM users WHERE id = 1').first();
  } catch {
    // 迁移 2026-09-18-token-version.sql 尚未落地时的降级: 没有版本号 → 撤销能力失效,
    // 但登录与鉴权照常工作。宁可少一个(新增的)能力, 也不要让整个站点因为少一列而全站 401。
    row = await db.prepare('SELECT username, password_hash FROM users WHERE id = 1').first();
    if (row) row.token_version = 0;
  }
  userCache = { row: row || null, at: Date.now() };
  return userCache.row;
}

// 表为空时从 env secret 播种 (兼容旧部署, 无需手工迁移凭据)
async function seedUser(db, env) {
  const hash = env.AUTH_PASSWORD_HASH
    || (env.AUTH_PASSWORD ? await hashPassword(env.AUTH_PASSWORD) : null);
  if (!hash) return;
  await db.prepare(
    'INSERT INTO users (id, username, password_hash, updated_at) VALUES (1, ?1, ?2, ?3) ON CONFLICT (id) DO NOTHING',
  ).bind(env.AUTH_USERNAME || 'admin', hash, new Date().toISOString()).run();
  invalidateUserCache();
}

// 统一凭据校验: users 表优先, 为空则回退 env 并播种
export async function verifyCredentials(db, env, username, password) {
  let row = await getUserRow(db);
  if (!row) { await seedUser(db, env); row = await getUserRow(db); }
  if (row) {
    if (username !== row.username) return null;
    return (await verifyPassword(password, row.password_hash)) ? { username: row.username } : null;
  }
  if (username !== env.AUTH_USERNAME) return null;
  let ok = false;
  if (env.AUTH_PASSWORD_HASH) ok = await verifyPassword(password, env.AUTH_PASSWORD_HASH);
  else if (env.AUTH_PASSWORD) ok = safeEqual(password, env.AUTH_PASSWORD);
  return ok ? { username } : null;
}

// ---------------- 登录 ----------------
// 内存限流: 5 分钟内 5 次失败锁 15 分钟 (isolate 生命周期内有效)
const attempts = new Map(); // ip -> {count, first}
const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

function clientIp(req) {
  const xff = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For');
  return (xff || 'unknown').split(',')[0].trim();
}

function isRateLimited(ip) {
  const e = attempts.get(ip);
  if (!e) return false;
  const elapsed = Date.now() - e.first;
  if (e.count >= MAX_FAILURES && elapsed < WINDOW_MS + LOCKOUT_MS) return true;
  if (elapsed > WINDOW_MS + LOCKOUT_MS) attempts.delete(ip);
  return false;
}
function recordFailure(ip) {
  const e = attempts.get(ip);
  if (!e || Date.now() - e.first >= WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else e.count++;
}
function clearFailures(ip) { attempts.delete(ip); }

export async function login(req, env, db) {
  const ip = clientIp(req);
  if (isRateLimited(ip)) return jerr('登录尝试过多，请稍后再试', 429);

  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误', 400); }
  const { username, password } = body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return jerr('用户名或密码错误', 401);

  const user = await verifyCredentials(db, env, username, password);
  if (!user) { recordFailure(ip); return jerr('用户名或密码错误', 401); }

  clearFailures(ip);
  const expireHours = parseInt(env.JWT_EXPIRE_HOURS || '24', 10) || 24;
  const row = await getUserRow(db);
  const token = await createToken(user.username, env.JWT_SECRET, expireHours, row ? (row.token_version | 0) : 0);
  // 同时下发只读 Cookie: 页面里的 <img>/<video>/<audio>/<iframe>/<a download> 靠它鉴权,
  // 从而不必再把 token 拼进 URL。有效期与 JWT 一致。
  return json({ token, username: user.username }, 200, {
    'Set-Cookie': roCookieHeader(token, expireHours * 3600, isSecureReq(req)),
  });
}

// 校验令牌并回显用户名。**顺带刷新只读 Cookie** ——
// fm_ro 只在登录时下发, 于是有两种会话会缺它: 部署前就已登录的浏览器, 以及被单独清掉
// 该 Cookie 的浏览器。缺了它的表现是"接口都正常, 但所有 <img>/<audio>/<video>/<a download>
// 静默 401"(既无提示也不会跳登录页), 用户会以为文件坏了。
// 前端每次进管理页都会调这个接口, 借它把 Cookie 补回来, 老会话无需重新登录。
// 有效期取 JWT 的剩余寿命, 保证 Cookie 不会比令牌活得更久。
export async function me(req, env, db) {
  const token = extractToken(req);
  if (!token) return jerr('未提供令牌', 401);
  const claims = await validateToken(token, env.JWT_SECRET).catch(() => null);
  if (!claims) return jerr('无效的令牌', 401);
  if (!(await checkTokenFresh(claims, db))) return jerr('令牌已失效，请重新登录', 401);
  const ttl = Math.max(60, (claims.exp | 0) - Math.floor(Date.now() / 1000));
  return json({ username: claims.sub }, 200, {
    'Set-Cookie': roCookieHeader(token, ttl, isSecureReq(req)),
  });
}

// 退出登录: 只读 Cookie 是 HttpOnly 的, 前端删不掉, 必须由服务端下发过期指令 ——
// 否则"退出"之后直接访问 /api/preview?path=... 依然拿得到文件。
// 刻意不校验令牌: 令牌已过期/无效时同样应该能把 Cookie 清干净。
export function logout(req, env) {
  return json({ ok: true }, 200, { 'Set-Cookie': roCookieClear(isSecureReq(req)) });
}

// ---------------- 账号设置 (均需 JWT) ----------------
// 修改密码: 校验旧密码 → PBKDF2 新哈希落库, 并把 token_version +1
// → 本次之前签发的所有 JWT(含已泄漏的)立即失效, 用户需重新登录。
export async function changePassword(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误', 400); }
  const { old_password, new_password } = body || {};
  if (typeof old_password !== 'string' || typeof new_password !== 'string') return jerr('参数不完整', 400);
  if (new_password.length < 6) return jerr('新密码至少 6 位', 400);

  let row = await getUserRow(db);
  if (!row) { await seedUser(db, env); row = await getUserRow(db); }
  if (!row) return jerr('凭据未初始化', 500);
  if (!(await verifyPassword(old_password, row.password_hash))) return jerr('旧密码错误', 401);

  await db.prepare(
    'UPDATE users SET password_hash = ?1, updated_at = ?2, token_version = token_version + 1 WHERE id = 1',
  ).bind(await hashPassword(new_password), new Date().toISOString()).run();
  invalidateUserCache();
  return json({ ok: true, message: '密码已修改，其他登录态已失效' }, 200, {
    'Set-Cookie': roCookieClear(isSecureReq(req)),
  });
}

// 修改用户名: 改后需用新用户名重新登录 (WebDAV 客户端配置也要同步更新); 同样作废旧令牌
export async function changeUsername(req, env, db) {
  let body;
  try { body = await req.json(); } catch { return jerr('请求格式错误', 400); }
  const { new_username } = body || {};
  if (typeof new_username !== 'string' || !new_username.trim()) return jerr('用户名不能为空', 400);
  const name = new_username.trim();
  if (name.length > 64 || /[\s/\\]/.test(name)) return jerr('用户名不合法', 400);

  let row = await getUserRow(db);
  if (!row) { await seedUser(db, env); row = await getUserRow(db); }
  if (!row) return jerr('凭据未初始化', 500);
  if (name === row.username) return json({ ok: true, username: name, message: '用户名未变化' });

  await db.prepare(
    'UPDATE users SET username = ?1, updated_at = ?2, token_version = token_version + 1 WHERE id = 1',
  ).bind(name, new Date().toISOString()).run();
  invalidateUserCache();
  return json({ ok: true, username: name, message: '用户名已修改, 请重新登录' }, 200, {
    'Set-Cookie': roCookieClear(isSecureReq(req)),
  });
}
