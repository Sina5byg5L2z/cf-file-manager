// 验证: 缺 hashes / received / inflight 的 task 经 doUpload 兜底后,
// 不再抛 "Cannot set properties of undefined (setting '0')"。
//
// 背景: 三条任务构造路径中, restoreFromStorage (刷新后恢复) 与 markFailed
// (创建阶段失败) 原先不构造这三个字段, 用户在"重试/重选文件"时命中
// uploadOne 的 `task.hashes[idx] = h`, 报出该错误。
import fs from 'fs';

const src = fs.readFileSync(new URL('../public/static/js/upload.js', import.meta.url), 'utf8');

function makeTask(extra = {}) {
  return Object.assign({
    id: 1, name: 'a.mp4', path: '', size: 300, chunkSize: 100,
    totalChunks: 3, sentChunks: 0, uploadId: 'u1',
    file: { slice: () => ({}) },
    // 故意不给 received / inflight / hashes (模拟 restoreFromStorage / markFailed)
  }, extra);
}

// 复刻 doUpload 入口的兜底三行
function guard(task) {
  if (!task.received) task.received = new Array(task.totalChunks).fill(false);
  if (!task.inflight) task.inflight = new Set();
  if (!task.hashes) task.hashes = {};
  return task;
}

let fail = 0;
const t = (n, f) => {
  try { f(); console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + ' → ' + e.message); }
};

console.log('[1] 未兜底时写 hashes 会抛 (复现原报错)');
t("task.hashes[0] = 'x' 抛 TypeError setting '0'", () => {
  const task = makeTask();
  let err = null;
  try { task.hashes[0] = 'x'; } catch (e) { err = e; }
  if (!err) throw new Error('预期抛错但没有');
  if (!/setting '0'/.test(err.message)) throw new Error('错误文本不符: ' + err.message);
});

console.log('[2] 兜底后写入正常');
t('received[0]=true 不抛', () => { const k = guard(makeTask()); k.received[0] = true; });
t('inflight.add(0) 不抛', () => { const k = guard(makeTask()); k.inflight.add(0); });
t("hashes[0]='h' 不抛", () => { const k = guard(makeTask()); k.hashes[0] = 'h'; });
t('totalChunks=0 时 received 为空数组不抛', () => {
  const k = guard(makeTask({ totalChunks: 0 }));
  if (k.received.length !== 0) throw new Error('应为空数组');
});

console.log('[3] 兜底不覆盖已有数据');
t('已有 received 保持', () => {
  const k = guard(makeTask({ received: [true, false, false] }));
  if (k.received[0] !== true) throw new Error('被覆盖');
});
t('已有 hashes 保持', () => {
  const k = guard(makeTask({ hashes: { 1: 'z' } }));
  if (k.hashes[1] !== 'z') throw new Error('被覆盖');
});

console.log('[4] 源码层面: 三处构造点 + 入口兜底均已带 hashes');
const srcChecks = [
  ['markFailed task 含 hashes', /size: file\.size, lastModified: file\.lastModified \|\| 0,\s*\n\s*received: null, inflight: null, hashes: \{\},/],
  ['restoreFromStorage task 含 hashes', /needsFile: true,\s*\n\s*received: null, inflight: null, hashes: \{\},/],
  ['addFile 新建 task 含 hashes', /fileKey, received: null, inflight: null, hashes: \{\},/],
  ['doUpload 入口兜底 hashes', /if \(!task\.hashes\) task\.hashes = \{\};/],
];
for (const [n, re] of srcChecks) t(n, () => { if (!re.test(src)) throw new Error('源码未匹配'); });

console.log(fail === 0 ? '\n=== 11 通过, 0 失败 ===' : `\n=== ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
