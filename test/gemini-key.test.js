import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { geminiEnv, geminiKeyPresent, askGemini, KEY_FILE } from '../server/adapters/gemini.js';

const FAKE_KEY = 'AIzaFakeKeyForTestsOnly_0123456789abcdef';

function secrets({ key = FAKE_KEY, symlink = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gkey-'));
  const dir = path.join(root, '.secrets');
  mkdirSync(dir);
  if (key !== null) {
    if (symlink) { writeFileSync(path.join(root, 'k.txt'), key + '\n'); symlinkSync(path.join(root, 'k.txt'), path.join(dir, KEY_FILE)); }
    else writeFileSync(path.join(dir, KEY_FILE), key + '\n');
  }
  return { root, dir };
}

test('金鑰只從 .secrets/gemini-api-key.txt 讀；缺檔、捷徑、格式不對都當沒有', () => {
  assert.deepEqual(geminiEnv({ secretsDir: secrets().dir }), { GEMINI_API_KEY: FAKE_KEY });
  assert.equal(geminiEnv({ secretsDir: secrets({ key: null }).dir }), null);
  assert.equal(geminiEnv({ secretsDir: secrets({ symlink: true }).dir }), null);
  assert.equal(geminiEnv({ secretsDir: secrets({ key: 'short' }).dir }), null);
  assert.equal(geminiEnv({}), null);
  assert.equal(geminiKeyPresent({ secretsDir: secrets().dir }), true);
  assert.equal(process.env.GEMINI_API_KEY, undefined, '金鑰不得寫進伺服器自己的環境');
});

test('金鑰只塞給 gemini 子程序，而且輸出裡若含金鑰會被遮掉', async () => {
  const { root, dir } = secrets();
  // 假的 gemini：把收到的環境變數印出來，模擬 CLI 不小心把金鑰回顯的情況
  const fake = path.join(root, 'fake-gemini.sh');
  writeFileSync(fake, '#!/bin/sh\necho "Loaded cached credentials."\necho "白話版 key=$GEMINI_API_KEY"\n');
  chmodSync(fake, 0o755);
  const cfg = { secretsDir: dir, explainTimeoutMs: 5000, gemini: { bin: fake, args: ['-p', '{PROMPT}'], cwd: '{WORKSPACE}' } };
  const r = await askGemini(cfg, '解釋', root, null);
  assert.equal(r.ok, true);
  assert.ok(!r.prose.includes(FAKE_KEY), '輸出不得含金鑰');
  assert.match(r.prose, /白話版 key=\[gemini-key\]/);
  assert.ok(!r.prose.includes('Loaded cached credentials'));
  assert.equal(process.env.GEMINI_API_KEY, undefined);
});

test('沒有金鑰又跑失敗時，錯誤訊息會提醒去放金鑰檔', async () => {
  const { root, dir } = secrets({ key: null });
  const cfg = { secretsDir: dir, gemini: { bin: path.join(root, 'no-such-gemini'), args: ['-p', '{PROMPT}'] } };
  const r = await askGemini(cfg, 'x', root, null);
  assert.equal(r.ok, false);
  assert.match(r.error, /gemini-api-key\.txt/);
});
