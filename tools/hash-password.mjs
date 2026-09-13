// 生成 Workers 登录口令哈希: node tools/hash-password.mjs "你的密码"
// 输出粘贴到: wrangler secret put AUTH_PASSWORD_HASH
import { webcrypto as crypto } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('用法: node tools/hash-password.mjs "你的密码"');
  process.exit(1);
}

const ITER = 25000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
const b64 = (buf) => Buffer.from(buf).toString('base64');
console.log(`pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`);
