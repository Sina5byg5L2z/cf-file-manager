# cf-file-manager

基于 **Cloudflare Workers + D1** 的自托管文件管理器 / 图床 / 分享盘。单 Worker 部署，零服务器、零运维，Cloudflare 免费额度即可长期使用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sina5byg5L2z/cf-file-manager)

## 功能

- **文件管理**：目录树浏览、分片上传、下载、新建目录、重命名 / 移动 / 复制 / 删除、批量操作、批量打包（zip）下载、全盘搜索
- **在线预览**：图片缩略图、音视频播放（视频多画质转码入口）、文本 / 代码高亮、Markdown / KaTeX 渲染，大文本显示限制防卡死
- **图床**：外链图片托管，支持公开访问 `/i/*`，可从文件管理器导入
- **分享链接**：可选密码（PBKDF2 哈希存储）+ 过期时间 + 访问计数
- **WebDAV**：`/dav` 路径可直接挂载为本地磁盘（RaiDrive / Cyberduck 等客户端）
- **单用户认证**：JWT 登录，PBKDF2 密码哈希，页面内「账号设置」可修改用户名与密码

## 设计要点（面向 Cloudflare 免费额度）

- 不使用 KV、不使用 R2（不用绑定银行卡）：元数据与文件内容（1MB 分片 BLOB）全部存 D1（额度更高）
- 公开图片 `/i/*`、私有预览 / 下载、目录列表、分享元数据全部走边缘 Cache API，命中时 0 次 D1 读取；`immutable` 缓存头让浏览器也不再回源
- 分片上传直接写暂存区，complete 时单条 `INSERT..SELECT` 合并，写放大最小
- D1 免费额度：存储 5GB / 行读 500 万每天 / 行写 10 万每天
- 静态资源命中不进 Worker（不计费、不限流）

## 一键部署（推荐）

点击上方 **Deploy to Cloudflare** 按钮，登录你的 Cloudflare 账号后：

1. 按提示确认仓库名、Worker 名称，Cloudflare 会自动创建仓库副本、**自动创建并绑定 D1 数据库**，并提示你填写 secrets：
   - `JWT_SECRET`：任意长随机串（如 `openssl rand -hex 32` 的输出）
   - `AUTH_PASSWORD`：你的登录密码
2. 部署完成后，**必须初始化数据库表**（二选一）：
   - **控制台方式**：Cloudflare Dashboard → Storage & Databases → D1 → 选中你的数据库 → Console，把 [`schema.sql`](schema.sql) 全部内容粘贴进去执行
   - **命令行方式**：克隆刚才自动创建的仓库到本地，然后在项目目录执行
     ```bash
     npm i
     npx wrangler d1 execute file-manager --remote --file=./schema.sql
     ```
3. 访问你的 Worker 地址，用 `admin` / 你设置的 `AUTH_PASSWORD` 登录即可使用

可选增强：

- **自定义域名**：在 `wrangler.jsonc` 中取消 `routes` 注释并改成你的域名，或直接在 Dashboard 的 Worker 设置里绑定

## 手动部署

```bash
npm i -g wrangler && wrangler login
wrangler d1 create file-manager        # 把输出的 database_id 填入 wrangler.jsonc
wrangler d1 execute file-manager --remote --file=./schema.sql

# 配置 secrets（推荐 hash 方式）:
node tools/hash-password.mjs "你的密码"
wrangler secret put AUTH_PASSWORD_HASH # 粘贴 hash-password 输出
wrangler secret put JWT_SECRET         # 任意长随机串, 如: openssl rand -hex 32
# 或者直接明文（仅个人使用图省事）:
# wrangler secret put AUTH_PASSWORD

wrangler deploy
```

## 本地开发

```bash
npm i
cp .dev.vars.example .dev.vars         # 填入本地测试用 JWT_SECRET / AUTH_PASSWORD
npm run dev                            # http://localhost:8787
```

## 配置说明

**vars**（`wrangler.jsonc`）：

| 项 | 默认值 | 说明 |
|---|---|---|
| `AUTH_USERNAME` | `admin` | 登录用户名 |
| `JWT_EXPIRE_HOURS` | `24` | JWT 有效期（小时） |
| `MAX_UPLOAD_SIZE` | `209715200` | 单文件大小上限（字节），D1 免费 5GB 总存储请按需调整 |
| `ZIP_MAX_TOTAL` | `33554432` | 打包（zip）下载总大小上限，超出返回 413（Worker 内存限制） |

**secrets**：

| 项 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | 是 | JWT 签名密钥，任意长随机串 |
| `AUTH_PASSWORD_HASH` | 二选一 | `node tools/hash-password.mjs "密码"` 输出（推荐） |
| `AUTH_PASSWORD` | 二选一 | 明文密码（图省事） |

首次登录时若用户表为空，会自动从 secrets 播种账号；之后修改用户名 / 密码请直接用页面内「账号设置」（改完 secrets 可删除）。

## 目录结构

```
src/         Worker 后端（纯原生 fetch handler，无框架）
  auth.js      登录 / JWT / 账号设置
  vfs.js       虚拟文件系统（元数据 + 1MB 分片 BLOB）
  imagehost.js 图床
  share.js     分享链接
  webdav.js    WebDAV 服务端
public/      前端（原生 JS；vendored: marked / DOMPurify / KaTeX / highlight.js）
tools/       hash-password.mjs 密码哈希生成；build-fileicons.mjs 文件图标构建
schema.sql   D1 建表脚本
```

## License

[MIT](LICENSE)
