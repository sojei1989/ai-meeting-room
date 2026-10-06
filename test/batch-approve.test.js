import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../server/orchestrator.js';

function newRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'batch-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

// 假 Codex：依工單標題決定成功或失敗；成功時真的改一個檔，讓 diff 有東西。
function fixture({ failOn = null } = {}) {
  const ws = newRepo();
  const ran = [];
  const pings = [];
  const notifier = { notify: async (kind, text) => { pings.push([kind, text]); return { ok: true }; } };
  const ask = {
    codex: async (cfg, prompt, workspace, mode) => {
      const a = o.m.actions.find(x => x.status === 'running');
      ran.push([a.id, mode]);
      if (a.title === failOn) return { ok: false, error: 'boom', code: 1, stdout: 'Error: boom', stderr: '' };
      writeFileSync(path.join(ws, a.id + '.txt'), 'done\n');
      return { ok: true, data: { summary: a.title + ' 做完', tests: 'ok', outOfScope: '無' }, prose: '' };
    },
    claude: async () => ({ ok: true, data: { summary: '審查完成' }, prose: '' })
  };
  const o = new Orchestrator({ timeoutMs: 1000 }, ws, () => {}, { notifier, ask });
  o.m.goal = '批次測試';
  o.m.actions = [
    { id: 'a1', title: '第一件', risk: 'low', status: 'pending', files: [{ op: 'add', path: 'a1.txt' }] },
    { id: 'a2', title: '第二件', risk: 'mid', status: 'pending', files: [{ op: 'add', path: 'a2.txt' }] },
    { id: 'a3', title: '第三件', risk: 'low', status: 'pending', files: [{ op: 'add', path: 'a3.txt' }] },
    { id: 'a4', title: '已拒絕的', risk: 'low', status: 'rejected' }
  ];
  return { o, ws, ran, pings };
}

test('批次核准依序執行，每一項都有自己的還原點，全部做完後跑審查', async () => {
  const { o, ran, pings } = fixture();
  const r = await o.approveMany(['a1', 'a2', 'a3', 'a4', 'nope']);
  assert.equal(r.ok, true);
  assert.equal(r.done, 3);
  assert.deepEqual(ran.map(x => x[0]), ['a1', 'a2', 'a3']);
  assert.ok(ran.every(x => x[1] === 'write'));
  assert.deepEqual(o.m.actions.map(a => a.status), ['done', 'done', 'done', 'rejected']);
  // 會議開始的還原點沒有（這裡直接塞資料），所以三張卡就是三個還原點
  assert.equal(o.m.checkpoints.length, 3);
  assert.equal(new Set(o.m.checkpoints.map(c => c.hash)).size, 3, '三個還原點的編號都不一樣');
  assert.equal(o.m.batch, null, '跑完要清掉批次狀態');
  assert.equal(o.m.phase, 6, '沒有待處理就要進審查');
  assert.equal(pings.filter(p => p[0] === 'done').length, 3, '每做完一張推一則');
});

test('中途一張失敗就停下來，後面的留在待處理，失敗那張可重試', async () => {
  const { o, ran, pings } = fixture({ failOn: '第二件' });
  const r = await o.approveMany(['a1', 'a2', 'a3']);
  assert.equal(r.ok, false);
  assert.equal(r.done, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.skipped, ['a3']);
  assert.deepEqual(ran.map(x => x[0]), ['a1', 'a2']);
  assert.deepEqual(o.m.actions.slice(0, 3).map(a => a.status), ['done', 'failed', 'pending']);
  assert.equal(o.m.batch, null);
  assert.ok(o.m.decisions.some(d => /批次核准中止/.test(d.text)));
  assert.ok(pings.some(p => p[0] === 'error'), '失敗要推錯誤通知');
  assert.ok(o.m.phase !== 6, '還有待處理就不該進審查');
});

test('approveAll 可以只挑低風險；批次進行中不接受單張核准', async () => {
  const { o, ran } = fixture();
  let sawBatchReject = false;
  const original = o.ask.codex;
  o.ask.codex = async (...args) => {
    // 批次跑到一半時，從旁邊按單張核准要被擋下
    const r = await o.approve('a2');
    if (r && r.ok === false && /批次核准正在進行/.test(r.msg)) sawBatchReject = true;
    return original(...args);
  };
  const r = await o.approveAll('low');
  assert.equal(r.ok, true);
  assert.deepEqual(ran.map(x => x[0]), ['a1', 'a3']);
  assert.equal(o.m.actions.find(a => a.id === 'a2').status, 'pending', '中風險的不動');
  assert.equal(sawBatchReject, true);
});

test('沒有可核准的工單、或正在忙時，批次核准會好好回報而不是爆炸', async () => {
  const { o } = fixture();
  o.m.actions.forEach(a => { a.status = 'done'; });
  const r = await o.approveMany(['a1']);
  assert.equal(r.ok, false);
  assert.match(r.msg, /沒有可核准/);
  const { o: o2 } = fixture();
  o2.m.busy = true;
  const r2 = await o2.approveMany(['a1']);
  assert.equal(r2.ok, false);
  assert.match(r2.msg, /另一項工作/);
});

test('「其實做完了」：逾時失敗但還原點之後有改動，就標成完成；沒改動就拒絕', async () => {
  const { o, ws } = fixture({ failOn: '第一件' });
  await o.approveMany(['a1']);
  const a1 = o.m.actions.find(a => a.id === 'a1');
  assert.equal(a1.status, 'failed');
  const r0 = await o.markDone('a1');
  assert.equal(r0.ok, false, '沒有改動不能標完成');
  assert.match(r0.msg, /沒有任何檔案改動/);
  writeFileSync(path.join(ws, 'late.txt'), 'codex 其實有寫\n');
  const r1 = await o.markDone('a1');
  assert.equal(r1.ok, true);
  assert.equal(a1.status, 'done');
  assert.match(a1.result.stat, /late\.txt/);
  assert.equal((await o.markDone('a1')).ok, false, '已完成的不能再標');
});
