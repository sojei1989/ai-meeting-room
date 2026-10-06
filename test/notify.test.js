import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotifier, loadTelegramSecrets, composeMessage, TOKEN_FILE, CHAT_ID_FILE } from '../server/notify.js';

// 假的 token：格式像真的，但不是任何人的。
const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnopq';
const FAKE_CHAT = '987654321';

function secretsDir({ token = FAKE_TOKEN, chatId = FAKE_CHAT, symlinkToken = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'notify-'));
  const dir = path.join(root, '.secrets');
  mkdirSync(dir, { recursive: true });
  if (token !== null) {
    if (symlinkToken) {
      writeFileSync(path.join(root, 'elsewhere.txt'), token + '\n');
      symlinkSync(path.join(root, 'elsewhere.txt'), path.join(dir, TOKEN_FILE));
    } else {
      writeFileSync(path.join(dir, TOKEN_FILE), token + '\n');
    }
  }
  if (chatId !== null) writeFileSync(path.join(dir, CHAT_ID_FILE), chatId + '\n');
  return dir;
}

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok: status === 200, status }; };
  return { fn, calls };
}

test('token 或 chat id 缺少、是捷徑、格式不對時一律視為未設定，原因只提檔名', () => {
  assert.equal(loadTelegramSecrets(secretsDir({ token: null })).ok, false);
  assert.equal(loadTelegramSecrets(secretsDir({ chatId: null })).ok, false);
  assert.equal(loadTelegramSecrets(secretsDir({ symlinkToken: true })).ok, false);
  assert.equal(loadTelegramSecrets(secretsDir({ token: 'not-a-token' })).ok, false);
  assert.equal(loadTelegramSecrets(secretsDir({ chatId: 'abc' })).ok, false);
  const bad = loadTelegramSecrets(secretsDir({ token: 'not-a-token' }));
  assert.ok(!bad.reason.includes('not-a-token'), '原因不得含 token 內容');
  assert.ok(bad.reason.includes(TOKEN_FILE));
  assert.equal(loadTelegramSecrets(secretsDir()).ok, true);
});

test('送出時打 Telegram sendMessage，帶 chat id 與訊息，訊息含事件與會議主題', async () => {
  const { fn, calls } = fakeFetch();
  const n = createNotifier({ secretsDir: secretsDir(), fetch: fn, log: () => {} });
  assert.equal(n.configured, true);
  const r = await n.notify('done', '「修密碼鎖」執行完成。', { goal: '會議室 V4：把密碼鎖補完\n第二行不要' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://api.telegram.org/bot' + FAKE_TOKEN + '/sendMessage'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, FAKE_CHAT);
  assert.match(body.text, /Codex 做完了/);
  assert.match(body.text, /修密碼鎖/);
  assert.match(body.text, /會議室 V4/);
  assert.ok(!body.text.includes('第二行不要'), '主題只取第一行');
});

test('同一類事情六秒內只推一次，不同類不互相擋；force 可以強制送', async () => {
  const { fn, calls } = fakeFetch();
  let t = 1000;
  const n = createNotifier({ secretsDir: secretsDir(), fetch: fn, now: () => t, log: () => {} });
  assert.equal((await n.notify('decide', 'a')).ok, true);
  assert.equal((await n.notify('decide', 'b')).skipped, 'throttled');
  assert.equal((await n.notify('error', 'c')).ok, true);
  assert.equal((await n.notify('decide', 'd', { force: true })).ok, true);
  t += 7000;
  assert.equal((await n.notify('decide', 'e')).ok, true);
  assert.equal(calls.length, 4);
});

test('未設定時 notify 直接略過，不打任何網路', async () => {
  const { fn, calls } = fakeFetch();
  const n = createNotifier({ secretsDir: secretsDir({ token: null }), fetch: fn, log: () => {} });
  assert.equal(n.configured, false);
  const r = await n.notify('decide', 'x');
  assert.equal(r.skipped, 'unconfigured');
  assert.equal(calls.length, 0);
});

test('失敗時 log 與回傳原因都不含 token；連 fetch 丟出含網址的錯誤也會被遮掉', async () => {
  const logs = [];
  const n401 = createNotifier({ secretsDir: secretsDir(), fetch: fakeFetch(401).fn, log: l => logs.push(l) });
  const r = await n401.notify('error', 'boom');
  assert.equal(r.ok, false);
  assert.match(r.reason, /401/);

  const throwing = async url => { throw new Error('connect failed for ' + url); };
  const nThrow = createNotifier({ secretsDir: secretsDir(), fetch: throwing, log: l => logs.push(l) });
  const r2 = await nThrow.notify('error', 'boom');
  assert.equal(r2.ok, false);
  for (const line of [...logs, r.reason, r2.reason]) {
    assert.ok(!String(line).includes(FAKE_TOKEN), 'token 不得出現：' + line);
  }
  assert.match(r2.reason, /bot\[token\]/);
});

test('訊息本身若不小心含 token 也會被遮掉，且長度有上限', () => {
  const n = createNotifier({ secrets: { ok: true, token: FAKE_TOKEN, chatId: FAKE_CHAT, reason: '' }, fetch: async () => ({ ok: true, status: 200 }) });
  assert.ok(!n.redact('x ' + FAKE_TOKEN + ' y').includes(FAKE_TOKEN));
  const long = composeMessage('info', 'a'.repeat(5000));
  assert.ok(long.length <= 1200);
});
