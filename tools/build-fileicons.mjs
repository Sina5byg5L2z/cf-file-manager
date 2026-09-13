// 构建 public/static/js/fileicons.js — vendor vscode-icons 文件图标 (映射 + SVG 打包为单文件)
// 数据源: vscode-icons-js@11.6.1 (映射) + vscode-icons 仓库 icons/*.svg (图标)
// 用法: node tools/build-fileicons.mjs [--force]   (--force 忽略本地缓存重新下载)
// 重新生成后需重新部署 Worker (静态资产随 ASSETS 发布)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VSI_VER = '11.6.1';
const NPM_BASE = `https://cdn.jsdelivr.net/npm/vscode-icons-js@${VSI_VER}/dist/generated/`;
const GH_SOURCES = [
  'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@master/icons/',
  `https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@v${VSI_VER}/icons/`,
];
const MAPPING_FILES = [
  'FileExtensions1ToIcon', 'FileExtensions2ToIcon',
  'FileNamesToIcon', 'FolderNamesToIcon', 'LanguagesToIcon',
];
const DEFAULTS = { file: 'default_file.svg', folder: 'default_folder.svg' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'public', 'static', 'js', 'fileicons.js');
const cacheDir = path.join(root, 'node_modules', '.cache', 'fileicons');
const force = process.argv.includes('--force');

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 解析 dist/generated/*.js 的 `exports.X = {...};` 对象字面量 (键无需引号, 非严格 JSON)
function parseObj(text, name) {
  const marker = `exports.${name} =`;
  const i = text.lastIndexOf(marker); // 前面可能有 `exports.X = void 0;` 声明, 取最后一次赋值
  if (i < 0) throw new Error(`${name} 未找到`);
  let s = text.slice(i + marker.length).trim().replace(/;\s*$/, '');
  return new Function(`"use strict";return (${s})`)();
}

async function downloadMapping(name) {
  const url = NPM_BASE + name + '.js';
  try {
    return parseObj(await fetchText(url), name);
  } catch (e) {
    throw new Error(`下载映射 ${name} 失败: ${e.message}`);
  }
}

function minSvg(svg) {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sstyle="fill:([^;"]+)"/g, ' fill="$1"') // 单属性 style 转属性 (只留颜色值), 减体积
    .replace(/\sstyle="opacity:([\d.]+)"/g, ' opacity="$1"')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function downloadIcon(name) {
  const dir = path.join(cacheDir, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const cached = path.join(dir, name);
  if (!force && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  for (const base of GH_SOURCES) {
    try {
      const svg = minSvg(await fetchText(base + name));
      fs.writeFileSync(cached, svg);
      return svg;
    } catch { /* 换下一个源 */ }
  }
  return null;
}

// --- 1.5 补充: 上游未收录的常见类型 (apk/iso/dmg/msi/deb...), 挂到语义相近的图标 ---
// 手绘补充图标 (上游只有 folder_type_android, 无文件版)
const EXTRA_SVGS = {
  // Android 机器人头 (官方绿 #3DDC84, 深色主题友好)
  'file_type_android.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M10.9 12.3 8.6 8.7" stroke="#3ddc84" stroke-width="1.7" stroke-linecap="round"/><path d="M21.1 12.3 23.4 8.7" stroke="#3ddc84" stroke-width="1.7" stroke-linecap="round"/><path d="M7.5 21.5a8.5 8.5 0 0 1 17 0z" fill="#3ddc84"/><circle cx="12.4" cy="17.9" r="1.15" fill="#1b2430"/><circle cx="19.6" cy="17.9" r="1.15" fill="#1b2430"/></svg>',
  // BT 种子磁铁 (上游无 torrent 图标, 手绘补)
  'file_type_torrent.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M9 5v10a7 7 0 0 0 14 0V5" fill="none" stroke="#e53935" stroke-width="6"/><rect x="6" y="5" width="7" height="5" fill="#b0bec5"/><rect x="19" y="5" width="7" height="5" fill="#b0bec5"/></svg>',
};
const SUPPLEMENT = {
  // 安装包 (上游无 android 文件图标, 手绘补)
  apk: 'file_type_android.svg', xapk: 'file_type_android.svg', aab: 'file_type_android.svg', apks: 'file_type_android.svg',
  ipa: 'file_type_zip.svg', msi: 'file_type_package.svg', msix: 'file_type_package.svg', appx: 'file_type_package.svg',
  cab: 'file_type_package.svg', deb: 'file_type_package.svg', rpm: 'file_type_package.svg', appimage: 'file_type_package.svg',
  snap: 'file_type_package.svg', flatpak: 'file_type_package.svg', pkg: 'file_type_package.svg',
  // 磁盘镜像 / 虚拟机
  iso: 'file_type_binary.svg', img: 'file_type_binary.svg', dmg: 'file_type_binary.svg', wim: 'file_type_binary.svg',
  vhd: 'file_type_binary.svg', vhdx: 'file_type_binary.svg', ova: 'file_type_binary.svg', ovf: 'file_type_binary.svg', bin: 'file_type_binary.svg', bak: 'file_type_binary.svg',
  // 字体
  ttf: 'file_type_font.svg', otf: 'file_type_font.svg', woff: 'file_type_font.svg', woff2: 'file_type_font.svg', eot: 'file_type_font.svg', ttc: 'file_type_font.svg', fon: 'file_type_font.svg',
  // 数据库
  db: 'file_type_db.svg', sqlite3: 'file_type_db.svg', dbf: 'file_type_db.svg', mdb: 'file_type_db.svg', mdf: 'file_type_db.svg', ldf: 'file_type_db.svg',
  // 证书 / 密钥
  pem: 'file_type_cert.svg', crt: 'file_type_cert.svg', cer: 'file_type_cert.svg', der: 'file_type_cert.svg',
  key: 'file_type_key.svg', p12: 'file_type_key.svg', pfx: 'file_type_key.svg', jks: 'file_type_key.svg', keystore: 'file_type_key.svg',
  // 电子书 (epub 图标为书本)
  mobi: 'file_type_epub.svg', azw3: 'file_type_epub.svg', fb2: 'file_type_epub.svg', djvu: 'file_type_epub.svg',
  // 字幕 → 归入视频
  srt: 'file_type_video.svg', ass: 'file_type_video.svg', ssa: 'file_type_video.svg', sub: 'file_type_video.svg', vtt: 'file_type_video.svg', idx: 'file_type_video.svg', sup: 'file_type_video.svg',
  // 3D / CAD → 归入图片 (上游无 3D 图标)
  stl: 'file_type_image.svg', obj3d: 'file_type_image.svg', fbx: 'file_type_image.svg', dae: 'file_type_image.svg', '3ds': 'file_type_image.svg',
  usdz: 'file_type_image.svg', gltf: 'file_type_image.svg', glb: 'file_type_image.svg', step: 'file_type_image.svg', stp: 'file_type_image.svg',
  dwg: 'file_type_image.svg', dxf: 'file_type_image.svg',
  // Windows 注册表 / 日志
  reg: 'file_type_registry.svg', log: 'file_type_log.svg',
  // LibreOffice / Office 文档 (上游仅 ods 有, 其余漏)
  odt: 'file_type_libreoffice_writer.svg', rtf: 'file_type_libreoffice_writer.svg', odp: 'file_type_libreoffice_impress.svg', epub: 'file_type_epub.svg',
  // 构建 / 杂项 (上游漏映射)
  ini: 'file_type_config.svg', cjs: 'file_type_js.svg', makefile: 'file_type_gnu.svg', blend: 'file_type_blender.svg', torrent: 'file_type_torrent.svg',
};
// 家族兜底: 上游映射遗漏的常见扩展, 按类型归入语义图标 (不覆盖上游已有条目)
const FAMILY_FILL = {
  'file_type_audio.svg': ['oga', 'm4b', 'au', 'amr', 'ape', 'mid', 'midi', 'ac3', 'dts', 'cda', 'ra', 'aif', 'mka', 'w64', 'voc', 'opus'],
  'file_type_video.svg': ['mpg', 'mpeg', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'f4v', 'mxf', 'm2v'],
  'file_type_image.svg': ['tiff', 'tif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'heic', 'heif', 'avif', 'tga', 'pcx', 'exr', 'dds', 'svgz', 'pic', 'webp', 'xcf'],
  'file_type_zip.svg': ['bz2', 'xz', 'zst', 'lz4', 'lzma', 'z', 'br', 'arj', 'lzh', 'taz', 'txz'],
};

console.log('下载映射数据 (vscode-icons-js@' + VSI_VER + ') ...');
const maps = {};
for (const f of MAPPING_FILES) maps[f] = await downloadMapping(f);
for (const [ext, icon] of Object.entries(SUPPLEMENT)) {
  if (!maps.FileExtensions1ToIcon[ext]) maps.FileExtensions1ToIcon[ext] = icon;
}
for (const [icon, exts] of Object.entries(FAMILY_FILL)) {
  for (const ext of exts) if (!maps.FileExtensions1ToIcon[ext]) maps.FileExtensions1ToIcon[ext] = icon;
}

// --- 2. 收集引用到的图标并下载 (手绘图标不进下载队列) ---
const used = new Set(Object.values(DEFAULTS));
for (const m of Object.values(maps)) for (const v of Object.values(m)) if (!EXTRA_SVGS[v]) used.add(v);
console.log(`映射覆盖: 扩展名 ${Object.keys(maps.FileExtensions1ToIcon).length} + 复合 ${Object.keys(maps.FileExtensions2ToIcon).length} + 文件名 ${Object.keys(maps.FileNamesToIcon).length} + 文件夹 ${Object.keys(maps.FolderNamesToIcon).length} + 语言 ${Object.keys(maps.LanguagesToIcon).length}, 唯一图标 ${used.size}`);

console.log('下载图标 SVG ...');
const svgMap = new Map();
const missing = new Set();
const queue = [...used];
const total = queue.length;
let done = 0;
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    const svg = await downloadIcon(name);
    if (svg === null) missing.add(name); else svgMap.set(name, svg);
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${total}`);
  }
}
await Promise.all(Array.from({ length: 10 }, worker));
for (const [n, svg] of Object.entries(EXTRA_SVGS)) svgMap.set(n, svg); // 手绘补充图标 (无需下载)

// --- 3. 剔除指向缺失图标的映射条目 (以最终 svgMap 为准, 含手绘图标) ---
if (missing.size) {
  for (const key of Object.keys(maps)) {
    for (const k of Object.keys(maps[key])) {
      if (!svgMap.has(maps[key][k])) delete maps[key][k];
    }
  }
}
// --- 3.5 drop 后重应用补充: 上游条目可能因图标缺失被剔除 (如 webp/makefile), 此处真正补上 ---
const needIcons = new Set();
for (const [ext, icon] of Object.entries(SUPPLEMENT)) {
  const cur = maps.FileExtensions1ToIcon[ext];
  if (!cur || !svgMap.has(cur)) { maps.FileExtensions1ToIcon[ext] = icon; needIcons.add(icon); }
}
for (const [icon, exts] of Object.entries(FAMILY_FILL)) {
  for (const ext of exts) {
    const cur = maps.FileExtensions1ToIcon[ext];
    if (!cur || !svgMap.has(cur)) { maps.FileExtensions1ToIcon[ext] = icon; needIcons.add(icon); }
  }
}
// 补充引用的图标可能从未进入下载队列 (3.5 才首次出现, 如 makefile→gnu), 此处补下载
const unfetched = [...needIcons].filter((n) => !svgMap.has(n) && !EXTRA_SVGS[n]);
for (const n of unfetched) {
  const svg = await downloadIcon(n);
  if (svg !== null) svgMap.set(n, svg); else missing.add(n);
}
if (unfetched.length) console.log(`补下载图标: ${unfetched.join(', ')}`);
if (missing.size) {
  console.warn(`缺失 ${missing.size} 个图标 (master 与 v${VSI_VER} 均无): ${[...missing].join(', ')}`);
}

// --- 4. 生成单文件 ---
const lit = (o) => '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(',') + '}';
const svgsLit = '{' + [...svgMap.keys()].sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(svgMap.get(k))}`).join(',') + '}';

const banner = `/*!
 * fileicons.js — vendored 文件图标库 (由 tools/build-fileicons.mjs 生成, 勿手改)
 * 图标与映射来自 vscode-icons (MIT License, Copyright (c) 2018 Daniel Derevjanik)
 * https://github.com/vscode-icons/vscode-icons  (映射: vscode-icons-js@${VSI_VER})
 *
 * MIT License — Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software.
 */
(function () {
"use strict";
var SVGS=${svgsLit};
`;
const body = `
var DEFAULTS=${lit(DEFAULTS)};
var EXT=${lit(maps.FileExtensions1ToIcon)};
var EXT2=${lit(maps.FileExtensions2ToIcon)};
var NAME=${lit(maps.FileNamesToIcon)};
var FOLDER=${lit(maps.FolderNamesToIcon)};
var LANG=${lit(maps.LanguagesToIcon)};
var dataUrlCache = {};
function dataUrl(name) {
  var svg = SVGS[name];
  if (!svg) return null;
  return dataUrlCache[name] || (dataUrlCache[name] = 'data:image/svg+xml,' + encodeURIComponent(svg));
}
// 解析图标名: 精确文件名 > 复合后缀(a.b.c 取 b.c) > 扩展名 > 语言 id > 默认; 入参统一转小写
function resolve(name, isDir) {
  var n = String(name || '').toLowerCase();
  if (isDir) return FOLDER[n] || DEFAULTS.folder;
  if (!n) return DEFAULTS.file;
  if (NAME[n]) return NAME[n];
  var parts = n.split('.');
  if (parts.length > 2) {
    var e1 = parts[parts.length - 1], e2 = parts[parts.length - 2];
    if (e1 && EXT2[e2 + '.' + e1]) return EXT2[e2 + '.' + e1];
  }
  var ext = parts.pop();
  if (ext && EXT[ext]) return EXT[ext];
  if (ext && LANG[ext]) return LANG[ext];
  return DEFAULTS.file;
}
function icon(name, cls) {
  var u = dataUrl(name);
  return u ? '<img class="' + (cls || 'ficon') + '" src="' + u + '" alt="" draggable="false">' : null;
}
function file(name) { return icon(resolve(name, false)); }
function folder(name) { return icon(resolve(name, true)); }
// 便捷入口: 真实文件名 + isDir 一步输出 <img> html, cls 可自定义类名
function html(fileName, isDir, cls) { return icon(resolve(fileName, !!isDir), cls); }
window.FileIcons = { file: file, folder: folder, icon: icon, html: html };
})();
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, banner + body, 'utf8');
const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`生成 ${path.relative(root, outFile)} (${kb} KB, ${svgMap.size} 个图标)`);

// --- 5. HTML 引用写版本号 ?v=<内容hash> (配合 public/_headers 的 immutable 缓存, 变更即失效) ---
const ver = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex').slice(0, 8);
for (const html of ['public/app.html', 'public/static/index.html', 'public/static/share.html', 'public/share.html']) {
  const p = path.join(root, html);
  const s = fs.readFileSync(p, 'utf8');
  const next = s.replace(/(<script src="\/static\/js\/fileicons\.js)(\?[^"]*)?"/g, `$1?v=${ver}"`);
  if (next !== s) {
    fs.writeFileSync(p, next, 'utf8');
    console.log(`版本号已写入 ${html}: ?v=${ver}`);
  }
}
