import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../server/orchestrator.js';
import { approvedWriteScope } from '../server/safe-path.js';

function newRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'approved-scope-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  mkdirSync(path.join(dir, 'app'));
  writeFileSync(path.join(dir, 'app', 'allowed.txt'), '原本\n');
  writeFileSync(path.join(dir, 'private.txt'), '不可改\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

test('核准清單拒絕工作區外、.secrets、捷徑與不存在的修改目標', () => {
  const ws = newRepo();
  mkdirSync(path.join(ws, '.secrets'));
  const outside = mkdtempSync(path.join(tmpdir(), 'scope-outside-'));
  symlinkSync(outside, path.join(ws, 'shortcut'));

  for (const file of [
    { op: 'mod', path: '../outside.txt' },
    { op: 'add', path: '.secrets/token.txt' },
    { op: 'add', path: 'shortcut/new.txt' },
    { op: 'mod', path: 'app/missing.txt' }
  ]) {
    const scope = approvedWriteScope({ root: ws, files: [file] });
    assert.equal(scope.ok, false, JSON.stringify(file));
  }
});

test('核准清單只接受明列且操作型態正確的檔案', () => {
  const ws = newRepo();
  const scope = approvedWriteScope({ root: ws, files: [
    { op: 'mod', path: 'app/allowed.txt' },
    { op: 'add', path: 'app/new.txt' }
  ] });
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.paths, ['app/allowed.txt', 'app/new.txt']);
});

test('Codex 只改核准檔案時工單完成，且會收到允許清單', async () => {
  const ws = newRepo();
  let receivedScope;
  const o = fixture(ws, async (_cfg, _prompt, _workspace, _mode, _log, opts) => {
    receivedScope = opts.approvedWritePaths;
    writeFileSync(path.join(ws, 'app', 'allowed.txt'), '已修改\n');
    return okResult();
  });

  await o.approve('a1', { deferReview: true });

  assert.equal(o.m.actions[0].status, 'done');
  assert.deepEqual(receivedScope, ['app/allowed.txt']);
  assert.equal(readFileSync(path.join(ws, 'app', 'allowed.txt'), 'utf8'), '已修改\n');
});

test('Codex 碰到未核准檔案時停止工單並回復這次全部變更', async () => {
  const ws = newRepo();
  const o = fixture(ws, async () => {
    writeFileSync(path.join(ws, 'app', 'allowed.txt'), '這次也要回復\n');
    writeFileSync(path.join(ws, 'private.txt'), '越界修改\n');
    writeFileSync(path.join(ws, 'unapproved-new.txt'), '越界新檔\n');
    return okResult();
  });

  await o.approve('a1', { deferReview: true });

  const action = o.m.actions[0];
  assert.equal(action.status, 'failed');
  assert.match(action.lastError, /private\.txt/);
  assert.match(action.lastError, /unapproved-new\.txt/);
  assert.equal(readFileSync(path.join(ws, 'app', 'allowed.txt'), 'utf8'), '原本\n');
  assert.equal(readFileSync(path.join(ws, 'private.txt'), 'utf8'), '不可改\n');
  assert.equal(existsSync(path.join(ws, 'unapproved-new.txt')), false);
});

test('子專案內未列在核准卡的完整路徑會被攔下並復原', async () => {
  const ws = newRepo();
  const child = path.join(ws, 'child');
  mkdirSync(child);
  const runChild = (...args) => execFileSync('git', args, { cwd: child, stdio: 'pipe' });
  runChild('init', '-q');
  runChild('config', 'user.email', 'test@example.com');
  runChild('config', 'user.name', 'test');
  writeFileSync(path.join(child, 'inside.txt'), '子專案原文\n');
  runChild('add', '-A');
  runChild('commit', '-qm', 'init child');
  execFileSync('git', ['add', 'child'], { cwd: ws });
  execFileSync('git', ['commit', '-qm', 'add child'], { cwd: ws });
  const o = fixture(ws, async () => {
    writeFileSync(path.join(ws, 'app', 'allowed.txt'), '合法修改也要一起復原\n');
    writeFileSync(path.join(child, 'inside.txt'), '越界修改\n');
    return okResult();
  });

  await o.approve('a1', { deferReview: true });

  assert.equal(o.m.actions[0].status, 'failed');
  assert.match(o.m.actions[0].lastError, /child\/inside\.txt/);
  assert.equal(readFileSync(path.join(child, 'inside.txt'), 'utf8'), '子專案原文\n');
  assert.equal(readFileSync(path.join(ws, 'app', 'allowed.txt'), 'utf8'), '原本\n');
  assert.equal(runChild('status', '--porcelain').toString(), '');
});

test('一鍵回復會同時復原外層與子專案的追蹤內容', async () => {
  const ws = newRepo();
  const child = path.join(ws, 'child');
  mkdirSync(child);
  const runChild = (...args) => execFileSync('git', args, { cwd: child, stdio: 'pipe' });
  runChild('init', '-q');
  runChild('config', 'user.email', 'test@example.com');
  runChild('config', 'user.name', 'test');
  writeFileSync(path.join(child, 'inside.txt'), '子專案原文\n');
  runChild('add', '-A');
  runChild('commit', '-qm', 'init child');
  execFileSync('git', ['add', 'child'], { cwd: ws });
  execFileSync('git', ['commit', '-qm', 'add child'], { cwd: ws });
  const o = fixture(ws, async () => {
    writeFileSync(path.join(ws, 'app', 'allowed.txt'), '外層修改\n');
    return okResult();
  });
  o.m.actions[0].files.push({ op: 'mod', path: 'child/inside.txt' });

  await o.approve('a1', { deferReview: true });
  writeFileSync(path.join(child, 'inside.txt'), '子專案修改\n');
  const result = await o.undo(o.m.checkpoints.at(-1).hash);

  assert.equal(result.ok, true);
  assert.equal(readFileSync(path.join(ws, 'app', 'allowed.txt'), 'utf8'), '原本\n');
  assert.equal(readFileSync(path.join(child, 'inside.txt'), 'utf8'), '子專案原文\n');
  assert.equal(runChild('status', '--porcelain').toString(), '');
});

test('工單建立還原點時只提交核准檔案所屬子專案', async () => {
  const ws = newRepo();
  const meeting = path.join(ws, 'ai-meeting-room');
  const social = path.join(ws, '品牌社群貼文');
  for (const child of [meeting, social]) {
    mkdirSync(child);
    const runChild = (...args) => execFileSync('git', args, { cwd: child, stdio: 'pipe' });
    runChild('init', '-q');
    runChild('config', 'user.email', 'test@example.com');
    runChild('config', 'user.name', 'test');
    writeFileSync(path.join(child, 'allowed.txt'), '原本\n');
    runChild('add', '-A');
    runChild('commit', '-qm', 'init child');
  }
  execFileSync('git', ['add', 'ai-meeting-room', '品牌社群貼文'], { cwd: ws });
  execFileSync('git', ['commit', '-qm', 'add children'], { cwd: ws });
  writeFileSync(path.join(social, 'allowed.txt'), '既有工作\n');
  const socialHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: social }).toString().trim();
  const socialStatus = execFileSync('git', ['status', '--porcelain'], { cwd: social }).toString();
  const cfg = { timeoutMs: 1000, modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'low' } } };
  const o = new Orchestrator(cfg, ws, () => {}, { ask: { codex: async () => {
    writeFileSync(path.join(meeting, 'allowed.txt'), '已修改\n');
    return okResult();
  } } });
  o.m.actions = [{
    id: 'a1', title: '只改會議室', risk: 'high', status: 'pending',
    files: [{ op: 'mod', path: 'ai-meeting-room/allowed.txt' }],
    codexModel: 'gpt-5.6-sol', reasoningEffort: 'low'
  }];

  await o.approve('a1', { deferReview: true });

  assert.equal(o.m.actions[0].status, 'done');
  assert.deepEqual(o.m.checkpoints.at(-1).repos.map(repo => repo.prefix), ['ai-meeting-room']);
  assert.equal(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: social }).toString().trim(), socialHead);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: social }).toString(), socialStatus);
});

test('核准清單本身不安全時在呼叫 Codex 前停止', async () => {
  const ws = newRepo();
  let called = false;
  const o = fixture(ws, async () => { called = true; return okResult(); });
  o.m.actions[0].files = [{ op: 'add', path: '.secrets/key.txt' }];

  await o.approve('a1', { deferReview: true });

  assert.equal(called, false);
  assert.equal(o.m.actions[0].status, 'failed');
  assert.match(o.m.actions[0].lastError, /核准路徑/);
});

function fixture(ws, codex) {
  const cfg = {
    timeoutMs: 1000,
    modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'low' } }
  };
  const o = new Orchestrator(cfg, ws, () => {}, { ask: { codex } });
  o.m.actions = [{
    id: 'a1', title: '限制寫入', risk: 'mid', status: 'pending',
    files: [{ op: 'mod', path: 'app/allowed.txt' }],
    codexModel: 'gpt-5.6-sol', reasoningEffort: 'low'
  }];
  return o;
}

function okResult() {
  return { ok: true, data: { summary: '完成', outOfScope: '無', tests: '通過' }, prose: '' };
}
