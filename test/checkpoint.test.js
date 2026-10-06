import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedPathsSince, checkpoint, restoreTaskChanges } from '../server/git.js';

function newRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

test('正常情況：存得進去，而且編號會往前走', async () => {
  const dir = newRepo();
  const before = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
  writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const cp = await checkpoint(dir, '測試');
  assert.equal(cp.ok, true);
  assert.notEqual(cp.hash, before, '雜湊應該變新');
});

test('.git 被鎖住時要回報失敗，不能假裝成功', async () => {
  const dir = newRepo();
  const before = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
  writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  writeFileSync(path.join(dir, '.git', 'index.lock'), '');   // 模擬今天遇到的狀況
  const cp = await checkpoint(dir, '測試');
  assert.equal(cp.ok, false, '被鎖住就不該回報成功');
  assert.ok(cp.error, '要說明原因');
  assert.equal(cp.hash, before, '雜湊應該停在原地');
});

test('不是 git 資料夾時也要好好回報，不要爆炸', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nogit-'));
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const cp = await checkpoint(dir, '測試');
  assert.equal(cp.ok, false);
  assert.ok(cp.error);
});

test('子專案改動顯示完整路徑，且追蹤檔與新增檔都能逐字復原', async () => {
  const dir = newRepo();
  const child = path.join(dir, 'child');
  mkdirSync(child);
  const runChild = (...a) => execFileSync('git', a, { cwd: child, stdio: 'pipe' });
  runChild('init', '-q');
  runChild('config', 'user.email', 't@t');
  runChild('config', 'user.name', 't');
  writeFileSync(path.join(child, 'inside.txt'), '子專案原文\n');
  runChild('add', '-A');
  runChild('commit', '-qm', 'init child');
  execFileSync('git', ['add', 'child'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'add child'], { cwd: dir });

  const cp = await checkpoint(dir, '破壞復原測試');
  writeFileSync(path.join(child, 'inside.txt'), '故意破壞\n');
  writeFileSync(path.join(child, 'new.txt'), '新增檔\n');
  const changed = await changedPathsSince(dir, cp);
  assert.deepEqual(changed.paths, ['child/inside.txt', 'child/new.txt']);

  const restored = await restoreTaskChanges(dir, cp, changed.untracked);
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(path.join(child, 'inside.txt'), 'utf8'), '子專案原文\n');
  assert.equal(existsSync(path.join(child, 'new.txt')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: child }).toString(), '');
});

test('限定子專案建立還原點時只提交該專案，並列出實際存入檔案', async () => {
  const dir = newRepo();
  const meeting = path.join(dir, 'ai-meeting-room');
  const social = path.join(dir, '品牌社群貼文');
  for (const child of [meeting, social]) {
    mkdirSync(child);
    const runChild = (...a) => execFileSync('git', a, { cwd: child, stdio: 'pipe' });
    runChild('init', '-q');
    runChild('config', 'user.email', 't@t');
    runChild('config', 'user.name', 't');
    writeFileSync(path.join(child, 'inside.txt'), '原文\n');
    runChild('add', '-A');
    runChild('commit', '-qm', 'init child');
  }
  execFileSync('git', ['add', 'ai-meeting-room', '品牌社群貼文'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'add children'], { cwd: dir });
  writeFileSync(path.join(meeting, 'inside.txt'), '會議室改動\n');
  writeFileSync(path.join(meeting, 'new.txt'), '會議室新檔\n');
  writeFileSync(path.join(social, 'inside.txt'), '既有改動\n');
  const socialBefore = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: social }).toString().trim();

  const cp = await checkpoint(dir, '只存會議室', ['ai-meeting-room/server/git.js']);

  assert.equal(cp.ok, true);
  assert.deepEqual(cp.repos.map(repo => repo.prefix), ['ai-meeting-room']);
  assert.deepEqual(cp.files, ['ai-meeting-room/inside.txt', 'ai-meeting-room/new.txt']);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: meeting }).toString(), '');
  assert.equal(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: social }).toString().trim(), socialBefore);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: social }).toString(), /inside\.txt/);

  writeFileSync(path.join(meeting, 'inside.txt'), '故意改壞\n');
  writeFileSync(path.join(meeting, 'after-checkpoint.txt'), '還原後應消失\n');
  const changed = await changedPathsSince(dir, cp);
  assert.deepEqual(changed.paths, [
    'ai-meeting-room/after-checkpoint.txt',
    'ai-meeting-room/inside.txt'
  ]);
  const restored = await restoreTaskChanges(dir, cp, changed.untracked);
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(path.join(meeting, 'inside.txt'), 'utf8'), '會議室改動\n');
  assert.equal(existsSync(path.join(meeting, 'after-checkpoint.txt')), false);
  assert.equal(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: social }).toString().trim(), socialBefore);
  assert.equal(readFileSync(path.join(social, 'inside.txt'), 'utf8'), '既有改動\n');
});
