import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator } from '../server/orchestrator.js';

function fixture(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'aimr-deliverable-folder-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, orchestrator: new Orchestrator({}, workspace, () => {}) };
}

test('建立資料夾型交件卡時會立即準備指定的空資料夾', t => {
  const { workspace, orchestrator } = fixture(t);

  const result = orchestrator.addDeliverables([{
    title: '提供參考資料',
    path: '交件區/品牌參考'
  }], 'd');

  assert.deepEqual(result, { added: 1, merged: 0 });
  assert.equal(existsSync(path.join(workspace, '交件區', '品牌參考')), true);
});

test('單一檔名交件卡只建立上層資料夾並保留卡片指定檔名', t => {
  const { workspace, orchestrator } = fixture(t);
  const requestedPath = '交件區/主視覺/hero.png';

  orchestrator.addDeliverables([{
    title: '活動主視覺',
    specs: [['尺寸', '1200x628 px'], ['格式', 'PNG'], ['數量', '1 張']],
    path: requestedPath
  }], 'd');

  assert.equal(existsSync(path.join(workspace, '交件區', '主視覺')), true);
  assert.equal(existsSync(path.join(workspace, requestedPath)), false);
  assert.equal(orchestrator.m.deliverables[0].path, requestedPath);
});

test('已存在的交件資料夾直接沿用且不改動其中檔案', t => {
  const { workspace, orchestrator } = fixture(t);
  const directory = path.join(workspace, '交件區', '既有資料');
  const existingFile = path.join(directory, '保留.txt');
  mkdirSync(directory, { recursive: true });
  writeFileSync(existingFile, '原有內容', 'utf8');

  orchestrator.addDeliverables([{
    title: '補充既有資料',
    path: '交件區/既有資料'
  }], 'd');

  assert.equal(existsSync(directory), true);
  assert.equal(existsSync(existingFile), true);
  assert.equal(readFileSync(existingFile, 'utf8'), '原有內容');
});

test('路徑跳出工作區時不建立資料夾也不建立交件卡', t => {
  const { workspace, orchestrator } = fixture(t);
  const outsideName = path.basename(workspace) + '-越界交件';
  const outside = path.join(path.dirname(workspace), outsideName);

  const result = orchestrator.addDeliverables([{
    title: '越界資料',
    path: '../' + outsideName
  }], 'd');

  assert.equal(result.added, 0);
  assert.equal(result.invalid, 1);
  assert.equal(orchestrator.m.deliverables.length, 0);
  assert.equal(existsSync(outside), false);
});
