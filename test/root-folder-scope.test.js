import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../server/orchestrator.js';

function gitInit(dir) {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  return run;
}

// 根目錄有兩個子專案，另有一般資料夾「品牌官網」（不是子專案），裡面留著上次回復後的空資料夾殼。
function setup({ withFile = false } = {}) {
  const ws = mkdtempSync(path.join(tmpdir(), 'root-folder-'));
  const root = gitInit(ws);
  for (const name of ['brand-social', 'ai-meeting-room']) {
    const dir = path.join(ws, name);
    mkdirSync(dir);
    const run = gitInit(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    run('add', '-A'); run('commit', '-qm', 'init');
  }
  const site = path.join(ws, '品牌官網');
  mkdirSync(path.join(site, 'shopify-theme-draft', 'assets'), { recursive: true });
  writeFileSync(path.join(site, 'readme.md'), 'x');
  if (withFile) writeFileSync(path.join(site, 'shopify-theme-draft', 'assets', 'a.css'), 'x');
  root('add', '-A'); root('commit', '-qm', 'init');
  return new Orchestrator({ timeoutMs: 1000 }, ws, () => {}, { activeProject: ws });
}

test('根目錄一般資料夾底下的空殼資料夾可以重新新增，不會誤報成多個子專案', async () => {
  const o = setup();
  const r = await o.rootRelativeFiles([{ op: 'add', path: '品牌官網/shopify-theme-draft/' }]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.files, [{ op: 'add', path: '品牌官網/shopify-theme-draft/' }]);
});

test('根目錄資料夾已經有內容時，回報真正原因而不是多個子專案', async () => {
  const o = setup({ withFile: true });
  const r = await o.rootRelativeFiles([{ op: 'add', path: '品牌官網/shopify-theme-draft/' }]);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /多個子專案/);
  assert.match(r.error, /操作類型不相符/);
});

test('子專案裡沒有上一層資料夾時，不算對得上', async () => {
  const o = setup();
  const r = await o.rootRelativeFiles([{ op: 'add', path: 'newdir/sub/file.txt' }]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.files, [{ op: 'add', path: 'newdir/sub/file.txt' }]);
});
