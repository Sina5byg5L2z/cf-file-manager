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

export async function createToken(username, secret, expireHours) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const exp = Math.floor(Date.now() / 1000) + expireHours * 3600;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub: username, exp })));
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

// Header 优先, ?token= 兜底 (与原版一致, 供 <a>/<video> 场景)
export function extractToken(req) {
  const auth = req.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url);
  return url.searchParams.get('token') || null;
}

export function checkAuth(req, env) {
  const token = extractToken(req);
  if (!token) return Promise.resolve(jerr('未提供令牌', 401));
  return validateToken(token, env.JWT_SECRET).then(
    (c) => (c ? null : jerr('无效的令牌', 401)),
    () => jerr('无效的令牌', 401),
  );
}

// ---------------- 用户表 (单用户, users.id=1) ----------------
// isolate 内存缓存 60s: 登录/WebDAV 认证每分钟至多 1 次 D1 读, 省额度
let userCache = null; // { row: {username, password_hash} | null, at }
const USER_TTL = 60_000;
function invalidateUserCache() { userCache = null; }

async function getUserRow(db) {
  if (userCache && Date.now() - userCache.at < USER_TTL) return userCache.row;
  const row = await db.prepare('SELECT username, password_hash FROM users WHERE id = 1').first();
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
  const token = await createToken(user.username, env.JWT_SECRET, expireHours);
  return json({ token, username: user.username });
}

export async function me(req, env) {
  const token = extractToken(req);
  if (!token) return jerr('未提供令牌', 401);
  const claims = await validateToken(token, env.JWT_SECRET).catch(() => null);
  if (!claims) return jerr('无效的令牌', 401);
  return json({ username: claims.sub });
}

// ---------------- 账号设置 (均需 JWT) ----------------
// 修改密码: 校验旧密码 → PBKDF2 新哈希落库; 旧 JWT 保持有效至自然过期 (无状态)
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

  await db.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = 1')
    .bind(await hashPassword(new_password), new Date().toISOString()).run();
  invalidateUserCache();
  return json({ ok: true, message: '密码已修改' });
}

// 修改用户名: 改后需用新用户名重新登录 (WebDAV 客户端配置也要同步更新)
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

  await db.prepare('UPDATE users SET username = ?1, updated_at = ?2 WHERE id = 1')
    .bind(name, new Date().toISOString()).run();
  invalidateUserCache();
  return json({ ok: true, username: name, message: '用户名已修改, 请重新登录' });
}
