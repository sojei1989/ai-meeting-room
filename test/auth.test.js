import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAuthService, SESSION_COOKIE_NAME } from '../server/auth.js';
import * as SafePath from '../server/safe-path.js';

const {
  collectRegisteredAssetPaths,
  collectRegisteredAttachmentPaths,
  resolveWritablePath,
  resolveRegisteredFile
} = SafePath;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePasscode(root, value = 'correct horse battery staple\n') {
  const secrets = path.join(root, '.secrets');
  mkdirSync(secrets, { recursive: true });
  const file = path.join(secrets, 'passcode.txt');
  writeFileSync(file, value, 'utf8');
  return file;
}

test('密碼檔缺少、不是檔案或只有空白時一律保持關閉', t => {
  const root = fixture(t);
  const missing = createAuthService({ passcodeFile: path.join(root, 'missing.txt') });
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.login('anything', 'client-a'), { ok: false, status: 503 });

  const directory = path.join(root, 'directory');
  mkdirSync(directory);
  const notAFile = createAuthService({ passcodeFile: directory });
  assert.equal(notAFile.configured, false);

  const blank = createAuthService({ passcodeFile: writePasscode(root, ' \r\n\t\n') });
  assert.equal(blank.configured, false);
});

test('密碼檔若是 symlink，即使目標有內容也保持關閉', t => {
  const root = fixture(t);
  const secrets = path.join(root, '.secrets');
  const outside = path.join(root, 'outside-passcode.txt');
  mkdirSync(secrets);
  writeFileSync(outside, 'must-not-become-the-passcode');
  const linkedPasscode = path.join(secrets, 'passcode.txt');
  symlinkSync(outside, linkedPasscode);

  const auth = createAuthService({ passcodeFile: linkedPasscode });
  assert.equal(auth.configured, false);
  assert.deepEqual(auth.login('must-not-become-the-passcode', 'client-a'), { ok: false, status: 503 });
});

test('密碼資料夾若是 symlink，即使檔案本身正常也保持關閉', t => {
  const root = fixture(t);
  const actualSecrets = path.join(root, 'actual-secrets');
  mkdirSync(actualSecrets);
  writeFileSync(path.join(actualSecrets, 'passcode.txt'), 'must-not-follow-parent-link');
  symlinkSync(actualSecrets, path.join(root, '.secrets'));

  const auth = createAuthService({ passcodeFile: path.join(root, '.secrets', 'passcode.txt') });
  assert.equal(auth.configured, false);
  assert.deepEqual(auth.login('must-not-follow-parent-link', 'client-a'), { ok: false, status: 503 });
});

test('正確密碼只換得 HttpOnly 隨機 session，回傳資料不含密碼或 token', t => {
  const root = fixture(t);
  const passcode = 'sentinel-passcode-92';
  const auth = createAuthService({ passcodeFile: writePasscode(root, passcode + '\n') });

  const first = auth.login(passcode, 'client-a');
  const second = auth.login(passcode, 'client-a');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.setCookie, second.setCookie);
  assert.match(first.setCookie, new RegExp('^' + SESSION_COOKIE_NAME + '=[A-Za-z0-9_-]{43};'));
  assert.match(first.setCookie, /; HttpOnly/);
  assert.match(first.setCookie, /; SameSite=Strict/);
  assert.match(first.setCookie, /; Path=\//);
  assert.match(first.setCookie, /; Max-Age=\d+/);
  assert.doesNotMatch(first.setCookie, /; Domain=/i);
  assert.doesNotMatch(first.setCookie, /; Secure/i);
  assert.equal(JSON.stringify(first).includes(passcode), false);
  assert.equal(Object.hasOwn(first, 'token'), false);

  assert.equal(auth.authenticate(first.setCookie).ok, true);
  assert.equal(auth.authenticate('not-a-cookie').ok, false);
  assert.equal(auth.authenticate(SESSION_COOKIE_NAME + '=invalid').ok, false);
});

test('錯誤密碼會依實際連線來源限速，鎖定期間正確密碼也不能穿過', t => {
  const root = fixture(t);
  let now = 1_000;
  const auth = createAuthService({
    passcodeFile: writePasscode(root, 'right\n'),
    now: () => now,
    maxFailures: 3,
    failureWindowMs: 1_000,
    blockMs: 5_000
  });

  assert.equal(auth.login('wrong', '127.0.0.1').status, 401);
  assert.equal(auth.login('wrong', '127.0.0.1').status, 401);
  const blocked = auth.login('wrong', '127.0.0.1');
  assert.equal(blocked.status, 429);
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(auth.login('right', '127.0.0.1').status, 429);
  assert.equal(auth.login('right', '100.64.0.2').ok, true);

  now += 5_001;
  assert.equal(auth.login('right', '127.0.0.1').ok, true);

  assert.equal(auth.login('wrong', 'client-reset').status, 401);
  assert.equal(auth.login('right', 'client-reset').ok, true);
  assert.equal(auth.login('wrong', 'client-reset').status, 401);
});

test('登出、逾時與新伺服器實例都會讓舊 session 失效並中斷既有連線', t => {
  const root = fixture(t);
  const file = writePasscode(root, 'right\n');
  let now = 10_000;
  const auth = createAuthService({ passcodeFile: file, now: () => now, sessionTtlMs: 1_000 });
  const login = auth.login('right', 'client-a');
  const session = auth.authenticate(login.setCookie);
  let closed = 0;
  auth.registerConnection(session.sessionId, () => { closed += 1; });

  now += 1_001;
  auth.sweepExpired();
  assert.equal(closed, 1);
  assert.equal(auth.authenticate(login.setCookie).ok, false);

  const again = auth.login('right', 'client-a');
  const againSession = auth.authenticate(again.setCookie);
  auth.registerConnection(againSession.sessionId, () => { closed += 1; });
  assert.equal(auth.logout(again.setCookie), true);
  assert.equal(closed, 2);
  assert.equal(auth.authenticate(again.setCookie).ok, false);

  const restarted = createAuthService({ passcodeFile: file, now: () => now });
  assert.equal(restarted.authenticate(again.setCookie).ok, false);
});

test('SSE 連線會依 session 的精確到期時間排程關閉，不等待定期掃描', t => {
  const root = fixture(t);
  let now = 25_000;
  let scheduled;
  const cancelled = [];
  const auth = createAuthService({
    passcodeFile: writePasscode(root, 'right\n'),
    now: () => now,
    sessionTtlMs: 1_000,
    schedule: (fn, delay) => {
      scheduled = { fn, delay };
      return { unref() {} };
    },
    cancelSchedule: timer => cancelled.push(timer)
  });
  const login = auth.login('right', 'client-a');
  const session = auth.authenticate(login.setCookie);
  let closed = 0;

  const unregister = auth.registerConnection(session.sessionId, () => { closed += 1; });
  assert.equal(typeof unregister, 'function');
  assert.equal(scheduled?.delay, 1_000);

  now += 1_000;
  scheduled?.fn();
  assert.equal(closed, 1);
  assert.equal(auth.authenticate(login.setCookie).ok, false);
  assert.equal(cancelled.length, 1);
});

test('素材白名單只收實際交件檔，附件白名單只收本場逐字稿附件', () => {
  const meeting = {
    deliverables: [
      { path: 'planned/not-yet-created.png', status: 'waiting' },
      { status: 'review', file: { rel: 'outputs/ready.png' } },
      { status: 'review', file: { rel: 'outputs/../package.json' } },
      { status: 'delivered', file: { rel: '.secrets/token.txt' } }
    ],
    transcript: [
      { files: [{ rel: '2026-09-09/photo.png' }, { rel: '' }] },
      { files: [{ rel: '2026-09-09/brief.pdf' }] }
    ]
  };

  assert.deepEqual([...collectRegisteredAssetPaths(meeting)].sort(), [
    '.secrets/token.txt',
    'outputs/ready.png'
  ]);
  assert.deepEqual([...collectRegisteredAttachmentPaths(meeting)].sort(), [
    '2026-09-09/brief.pdf',
    '2026-09-09/photo.png'
  ]);
});

test('可寫入路徑會拒絕名稱跳脫、密碼資料夾與目錄捷徑', t => {
  const base = fixture(t);
  const workspace = path.join(base, 'workspace');
  const secrets = path.join(base, '.secrets');
  const outside = path.join(base, 'outside.txt');
  mkdirSync(workspace);
  mkdirSync(secrets);
  writeFileSync(outside, 'outside');
  writeFileSync(path.join(secrets, 'token.txt'), 'token');
  writeFileSync(path.join(workspace, 'report.txt'), 'ok');
  const safeLink = path.join(workspace, 'evil-link');
  symlinkSync(outside, safeLink);

  assert.equal(resolveWritablePath({
    root: workspace,
    requestedPath: 'report.txt',
    forbiddenRoots: [secrets]
  }), path.resolve(realpathSync(workspace), 'report.txt'));
  assert.equal(resolveWritablePath({
    root: workspace,
    requestedPath: '../secrets/pass.txt',
    forbiddenRoots: [secrets]
  }), null);
  assert.equal(resolveWritablePath({
    root: workspace,
    requestedPath: '.secrets/token.txt',
    forbiddenRoots: [secrets]
  }), null);
  assert.equal(resolveWritablePath({
    root: workspace,
    requestedPath: 'evil-link/report.txt',
    forbiddenRoots: [secrets]
  }), null);
});

test('安全素材路徑拒絕未登記、跳脫、目錄、.secrets 與 symlink 繞路', t => {
  const base = fixture(t);
  const workspace = path.join(base, 'work');
  const sibling = path.join(base, 'work-evil');
  const secrets = path.join(base, '.secrets');
  mkdirSync(path.join(workspace, 'outputs'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(workspace, 'outputs', 'ready.png'), 'ready');
  writeFileSync(path.join(workspace, 'package.json'), 'private');
  writeFileSync(path.join(sibling, 'outside.png'), 'outside');
  writeFileSync(path.join(secrets, 'passcode.txt'), 'secret');
  symlinkSync(path.join(sibling, 'outside.png'), path.join(workspace, 'outputs', 'outside-link.png'));
  symlinkSync(path.join(workspace, 'package.json'), path.join(workspace, 'outputs', 'inside-link.png'));
  symlinkSync(secrets, path.join(workspace, 'secret-link'));

  const registered = new Set([
    'outputs/ready.png',
    'outputs/outside-link.png',
    'outputs/inside-link.png',
    'outputs/../package.json',
    'secret-link/passcode.txt',
    '.secrets/passcode.txt'
  ]);
  const options = { root: workspace, registeredPaths: registered, forbiddenRoots: [secrets] };

  assert.equal(
    resolveRegisteredFile({ ...options, requestedPath: 'outputs/ready.png' }),
    realpathSync(path.join(workspace, 'outputs', 'ready.png'))
  );
  for (const requestedPath of [
    'package.json',
    '../work-evil/outside.png',
    path.join(workspace, 'outputs', 'ready.png'),
    'outputs',
    'missing.png',
    '.secrets/passcode.txt',
    'secret-link/passcode.txt',
    'outputs/outside-link.png',
    'outputs/inside-link.png',
    'outputs\\ready.png',
    'outputs/ready.png\0'
  ]) {
    assert.equal(resolveRegisteredFile({ ...options, requestedPath }), null, requestedPath);
  }
});

test('工作區本身位於 .secrets 時，即使相對檔名已登記仍拒絕', t => {
  const base = fixture(t);
  const secrets = path.join(base, '.secrets');
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, 'passcode.txt'), 'secret');

  assert.equal(resolveRegisteredFile({
    root: secrets,
    requestedPath: 'passcode.txt',
    registeredPaths: new Set(['passcode.txt']),
    forbiddenRoots: [secrets]
  }), null);
});

test('素材根目錄本身是 symlink 時一律拒絕，不把捷徑目標當成可信根目錄', t => {
  const base = fixture(t);
  const actualRoot = path.join(base, 'actual-workspace');
  const linkedRoot = path.join(base, 'linked-workspace');
  mkdirSync(path.join(actualRoot, 'outputs'), { recursive: true });
  writeFileSync(path.join(actualRoot, 'outputs', 'ready.png'), 'ready');
  symlinkSync(actualRoot, linkedRoot);

  assert.equal(resolveRegisteredFile({
    root: linkedRoot,
    requestedPath: 'outputs/ready.png',
    registeredPaths: new Set(['outputs/ready.png'])
  }), null);
});

test('安全開檔後即使原路徑被換成秘密捷徑，既有讀取仍固定在原本檔案', t => {
  const base = fixture(t);
  const workspace = path.join(base, 'workspace');
  const secrets = path.join(base, '.secrets');
  const asset = path.join(workspace, 'outputs', 'ready.txt');
  mkdirSync(path.dirname(asset), { recursive: true });
  mkdirSync(secrets);
  writeFileSync(asset, 'registered-safe-content');
  writeFileSync(path.join(secrets, 'token.txt'), 'must-never-be-read');

  const opened = SafePath.openRegisteredFile?.({
    root: workspace,
    requestedPath: 'outputs/ready.txt',
    registeredPaths: new Set(['outputs/ready.txt']),
    forbiddenRoots: [secrets]
  });
  assert.ok(opened, '安全路徑層必須回傳已驗證且已開啟的檔案');
  t.after(() => closeSync(opened.fd));

  renameSync(asset, asset + '.original');
  symlinkSync(path.join(secrets, 'token.txt'), asset);
  assert.equal(readFileSync(opened.fd, 'utf8'), 'registered-safe-content');
});
