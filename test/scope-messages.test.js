import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvedWriteScope } from '../server/safe-path.js';

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scope-msg-'));
  mkdirSync(path.join(root, 'proj', 'spec'), { recursive: true });
  mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
  writeFileSync(path.join(root, 'proj', 'spec', 'doc.md'), 'x');
  return root;
}

test('新增一個已經存在的檔案時，說清楚是「已經存在」而不是講資料夾', () => {
  const r = approvedWriteScope({ root: workspace(), files: [{ op: 'add', path: 'proj/spec/doc.md' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /操作類型不相符/);
  assert.match(r.error, /已經存在/);
  assert.doesNotMatch(r.error, /資料夾/);
});

test('刪除或修改一個不存在的檔案時，說清楚是「已經不存在」', () => {
  const root = workspace();
  const del = approvedWriteScope({ root, files: [{ op: 'del', path: 'proj/spec/gone.md' }] });
  assert.match(del.error, /刪除.*已經不存在/);
  const mod = approvedWriteScope({ root, files: [{ op: 'mod', path: 'proj/spec/gone.md' }] });
  assert.match(mod.error, /修改.*已經不存在/);
});

test('.git 裡的檔案不能列進核准清單', () => {
  const r = approvedWriteScope({ root: workspace(), files: [{ op: 'del', path: 'proj/.git/index.lock' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /\.git/);
});
