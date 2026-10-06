import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveDeliverableUpload } from '../server/safe-path.js';

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'aimr-deliverable-upload-'));
  const workspace = path.join(base, 'workspace');
  const secrets = path.join(workspace, '.secrets');
  mkdirSync(path.join(workspace, '交件區', '參考圖'), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, secrets };
}

test('檔案型交件只接受卡片指定的確切檔名', t => {
  const f = fixture(t);
  const accepted = resolveDeliverableUpload({
    root: f.workspace,
    deliverablePath: '交件區/hero.png',
    uploadName: 'hero.png',
    forbiddenRoots: [f.secrets]
  });
  const rejected = resolveDeliverableUpload({
    root: f.workspace,
    deliverablePath: '交件區/hero.png',
    uploadName: 'other.png',
    forbiddenRoots: [f.secrets]
  });

  assert.equal(accepted?.relativePath, '交件區/hero.png');
  assert.equal(rejected, null);
});

test('資料夾型交件接受安全檔名但拒絕路徑、控制字元與隱藏名稱', t => {
  const f = fixture(t);
  const accepted = resolveDeliverableUpload({
    root: f.workspace,
    deliverablePath: '交件區/參考圖',
    uploadName: '正面照 01.png',
    forbiddenRoots: [f.secrets]
  });
  assert.equal(accepted?.relativePath, '交件區/參考圖/正面照 01.png');

  for (const uploadName of ['../outside.png', '子目錄/file.png', '.secrets', '.env', 'bad\0name.png']) {
    assert.equal(resolveDeliverableUpload({
      root: f.workspace,
      deliverablePath: '交件區/參考圖',
      uploadName,
      forbiddenRoots: [f.secrets]
    }), null, uploadName);
  }
});

test('交件目的地拒絕越界路徑、密碼資料夾與捷徑資料夾', t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.workspace, '交件區', '捷徑'));

  for (const deliverablePath of ['../outside', '.secrets', '交件區/捷徑']) {
    assert.equal(resolveDeliverableUpload({
      root: f.workspace,
      deliverablePath,
      uploadName: 'file.png',
      forbiddenRoots: [f.secrets]
    }), null, deliverablePath);
  }
});

test('既有同名檔回報衝突且不提供可覆寫目的地', t => {
  const f = fixture(t);
  const existing = path.join(f.workspace, '交件區', 'hero.png');
  writeFileSync(existing, 'keep-me');

  const result = resolveDeliverableUpload({
    root: f.workspace,
    deliverablePath: '交件區/hero.png',
    uploadName: 'hero.png',
    forbiddenRoots: [f.secrets]
  });

  assert.deepEqual(result, {
    conflict: true,
    relativePath: '交件區/hero.png',
    fileName: 'hero.png'
  });
});
