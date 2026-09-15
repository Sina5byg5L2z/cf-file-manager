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
- **参数设置**：分片规则、上传上限、预览上限页面内可视化调整，按移动端 / 电脑端两档分别生效
- **存储分库**：空间不足时把文件字节分散到多个 D1 库扩容（每库约 470MB 可用），页面内一键启用 / 注册新库，日常使用无感

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
| `CF_API_TOKEN` + `CF_ACCOUNT_ID` | 否 | 存储分库的每日容量校准（Token 需 D1 只读权限）；不配则面板显示应用内累加值 |

首次登录时若用户表为空，会自动从 secrets 播种账号；之后修改用户名 / 密码请直接用页面内「账号设置」（改完 secrets 可删除）。

## 参数设置

登录后点击顶栏齿轮图标打开「参数设置」。配置存 D1（`app_settings` 表，缺表自动创建），所有设备共享一份；每项分「移动端 / 电脑端」两档，运行时按当前设备类型自动取对应档位。

| 项 | 说明 | 默认值（移动端 / 电脑端） |
|---|---|---|
| 分片规则 | 按文件大小区间匹配（先命中先用，可拖动排序），指定分片大小与并发数；未命中走 DEFAULT 行 | DEFAULT：512KB × 4 并发 |
| 上传上限 | 单文件大小上限，超限文件上传时直接跳过；不能超过服务端 `MAX_UPLOAD_SIZE`（那是最终兜底） | 200MB / 200MB |
| 预览上限 | 文本 / 代码、Markdown、HTML 超过上限不做在线预览，引导下载 | 512KB / 1MB、256KB / 512KB、1MB / 5MB |
| 下载窗口 | 单次 Range 请求搬运的数据量，同时是页面内分片下载的每段大小；越大请求数越少，但单请求 CPU 开销线性增长（实测约 25~33ms/MB），超过平台上限的响应会被平台静默截断。推荐 8~16 | 8MB（限 1~32MB） |

说明：

- 分片大小仅允许 64KB / 128KB / 256KB / 512KB / 1MB（服务端合并分片时需按 `(文件大小, 分片数)` 反推分片大小，集合外的值会导致推导失败）
- 若上传触发 Cloudflare `exceededResources`（1102）或 503，把分片大小调回 256KB 即可
- 小技巧：上传时遇到分片上传失败，这时Cloudflare任何请求基本都会直接503，可以关掉浏览器重新打开，点击右下方的上传按钮重新选择文件，可以续传。

### 大文件下载

- 页面内下载（文件管理器 / 分享页）：大于 4MB 的文件自动走分片下载（3 并发），带三重完整性校验（响应声明总长、每段字节数、拼装总长）+ 单段失败折半窗口重试（最小 1MB），校验不过直接报错，绝不保存残缺文件
- 无 JS 的直链下载（WebDAV / curl / 右键另存为）：超过 32MB 会明确返回 413 报错而非静默截断（平台上整文件流式响应超 CPU 上限会被掐断，客户端无感，宁可报错）；≤32MB 仍可直链下载

## 存储分库（空间扩容）

D1 免费版**单个库硬上限 500MB**。分库把文件字节按「文件」为单位分散到多个库（元数据始终只存主库），容量随库数线性增加；而你在页面上看到的仍是一个普通文件管理器——所有库共用同一目录树、同一批链接，日常使用完全无感。

### 什么时候需要管它

- 平时不用管：新上传的文件自动进剩余空间最大的库
- 库快满时：上传会收到「存储空间不足」提示，面板按剩余名额给出对应引导——有备用库 → 一键启用；名额没用完 → 引导添加新库；名额用尽 → 提醒清理空间
- 「参数设置 → 存储库」面板可随时查看各库用量与状态，支持停用 / 恢复 / 调整预留空间

### 怎么加一个库

1. **建库**：`npx wrangler d1 create file-manager-2`（名字随意，记下输出的 database_id）
2. **声明 binding**：在 `wrangler.jsonc` 的 `d1_databases` 里追加一项，binding 名必须叫 `DB2`（下一个 `DB3`，数字递增）。binding 是部署期固定的，运行时无法新增，文件里有现成的注释示例
3. **重新部署**：`npx wrangler deploy`
4. **注册**：登录 → 参数设置 → 存储库 → **注册新库** → 输入 `DB2`，应用会自动建表并立即启用

此后新文件自动流向新库，无需任何手动迁移。

### 规则与边界（了解即可）

- 一个文件的全部字节（含缩略图、上传暂存分片）永远落在同一个库；单文件大小同时受 `MAX_UPLOAD_SIZE` 和目标库可用空间（约 470MB = 500MB − 预留）约束
- 重命名 / 移动是纯元数据操作，跨库 0 字节搬运；跨库删除 / 改名如遇失败会记入日志，由每日定时任务自动补偿重试
- 明确**不做跨库搬迁**：把库设为「退役」后它只读——里面的文件仍可正常访问，只是不再接新文件
- 面板里的用量默认是应用内累加值；可选配置 secrets `CF_API_TOKEN`（需 D1 只读权限）+ `CF_ACCOUNT_ID`，每日定时校准为 Cloudflare 官方口径的真实占用

### 老版本升级

已部署过旧版本的用户执行一次（新装用户不需要，`schema.sql` 已包含全部表）：

```bash
npx wrangler d1 execute file-manager --remote --file=./migrations/2026-09-15-db-sharding.sql
```

## 目录结构

```
src/         Worker 后端（纯原生 fetch handler，无框架）
  auth.js      登录 / JWT / 账号设置
  vfs.js       虚拟文件系统（元数据 + 1MB 分片 BLOB）
  imagehost.js 图床
  share.js     分享链接
  webdav.js    WebDAV 服务端
  settings.js  应用参数设置（分片规则 / 上传与预览上限 / 下载窗口，D1 单行存储）
  storage.js   存储分库路由（库注册表 / 选库 / 容量告警 / 注册与启用接口）
  blobops.js   跨库字节操作与补偿重试
public/      前端（原生 JS；vendored: marked / DOMPurify / KaTeX / highlight.js）
tools/       hash-password.mjs 密码哈希生成；build-fileicons.mjs 文件图标构建
schema.sql   D1 建表脚本
migrations/  老版本升级用的增量 DDL（新装用户无需关心）
```

## License

[MIT](LICENSE)
