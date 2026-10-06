import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMeetingRoomApp } from '../server/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memoryServers = new Map();
let memoryServerId = 0;

class MemoryResponse extends Writable {
  constructor(onHeaders) {
    super();
    this.statusCode = 200;
    this.headers = new Headers();
    this.headersSent = false;
    this.chunks = [];
    this.onHeaders = onHeaders;
    this.completed = new Promise(resolve => {
      this.once('finish', resolve);
      this.once('close', resolve);
    });
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, String(value));
    this.headersSent = true;
    if (this.onHeaders) {
      const notify = this.onHeaders;
      this.onHeaders = null;
      notify(this);
    }
    return this;
  }

  _write(chunk, encoding, callback) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.chunks.push(value);
    this.emit('data', value);
    callback();
  }

  _final(callback) {
    callback();
    queueMicrotask(() => this.emit('end'));
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function memoryRequest(url, options = {}) {
  const parsed = new URL(url);
  const server = memoryServers.get(parsed.protocol + '//' + parsed.host);
  if (!server || !server.listening) throw new Error('memory server is not listening');
  const requestHeaders = new Headers(options.headers || {});
  const body = options.body == null ? null : Buffer.from(String(options.body));
  const req = new Readable({
    read() {
      if (body) this.push(body);
      this.push(null);
    }
  });
  req.method = String(options.method || 'GET').toUpperCase();
  req.url = parsed.pathname + parsed.search;
  req.headers = Object.fromEntries([...requestHeaders].map(([name, value]) => [name.toLowerCase(), value]));
  req.socket = {
    remoteAddress: options.remoteAddress || '127.0.0.1',
    localAddress: options.localAddress
  };
  return { server, req };
}

function createMemoryServer(handler) {
  return {
    handler,
    listening: false,
    origin: '',
    close(callback) {
      this.listening = false;
      if (this.origin) memoryServers.delete(this.origin);
      queueMicrotask(() => callback?.());
    }
  };
}

const http = {
  createServer: createMemoryServer,
  get(url, options, callback) {
    const { server, req } = memoryRequest(url, { ...options, method: 'GET' });
    let response;
    response = new MemoryResponse(value => callback(value));
    server.handler(req, response);
    return {
      destroy() {
        req.destroy();
        response.destroy();
      }
    };
  }
};

async function fetch(url, options = {}) {
  const { server, req } = memoryRequest(url, options);
  const response = new MemoryResponse();
  server.handler(req, response);
  let timeout;
  try {
    await Promise.race([
      response.completed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('memory response timed out')), 2_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return {
    status: response.statusCode,
    headers: response.headers,
    text: async () => response.text(),
    json: async () => JSON.parse(response.text())
  };
}

function fixture(t, passcode = 'phone-safe-passcode') {
  const base = mkdtempSync(path.join(tmpdir(), 'aimr-http-'));
  const workspace = path.join(base, 'workspace');
  const attachments = path.join(base, 'attachments');
  const secrets = path.join(base, '.secrets');
  const publicDir = path.join(base, 'public');
  mkdirSync(path.join(workspace, 'outputs'), { recursive: true });
  mkdirSync(path.join(workspace, '交件區'), { recursive: true });
  mkdirSync(path.join(attachments, '2026-09-09'), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  mkdirSync(path.join(publicDir, 'assets', 'sfx'), { recursive: true });
  writeFileSync(path.join(secrets, 'passcode.txt'), passcode + '\n');
  writeFileSync(path.join(secrets, 'token.txt'), 'do-not-leak');
  writeFileSync(path.join(publicDir, 'index.html'), '<title>三方開發會議室</title>');
  writeFileSync(path.join(publicDir, 'login.html'), '<title>登入</title>');
  writeFileSync(path.join(publicDir, 'assets', 'icon-180.png'), 'icon');
  writeFileSync(path.join(publicDir, 'assets', 'avatar-user.png'), 'avatar');
  writeFileSync(path.join(publicDir, 'assets', 'sfx', 'yes-my-lord.mp3'), 'sound');
  writeFileSync(path.join(workspace, 'outputs', 'ready.png'), 'registered-image');
  writeFileSync(path.join(workspace, 'outputs', 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(path.join(workspace, 'package.json'), 'unregistered-private-file');
  writeFileSync(path.join(attachments, '2026-09-09', 'shown.txt'), 'registered-attachment');
  writeFileSync(path.join(attachments, '2026-09-09', 'page.html'), '<html><script>fetch("/api/state")</script></html>');
  writeFileSync(path.join(attachments, 'old-secret.txt'), 'unregistered-attachment');

  const meeting = {
    marker: 'PRIVATE-MEETING-STATE',
    deliverables: [
      { id: 'd-upload', status: 'waiting', path: '交件區/hero.png', tool: 'manual' },
      { id: 'd-secret', status: 'waiting', path: '.secrets/secret.png', tool: 'manual' },
      { status: 'review', file: { rel: 'outputs/ready.png' } },
      { status: 'review', file: { rel: 'outputs/active.svg' } },
      { status: 'delivered', file: { rel: '.secrets/token.txt' } }
    ],
    transcript: [{ files: [{ rel: '2026-09-09/shown.txt' }, { rel: '2026-09-09/page.html' }] }]
  };
  const restoreCalls = [];
  const openedDirectories = [];
  const orchestrator = {
    m: meeting,
    save: () => null,
    restore: id => {
      restoreCalls.push(id);
      return { ok: true };
    },
    push: () => {},
    note: () => {},
    say: () => {}
  };
  const config = {
    port: 4477,
    workspace,
    autosaveMs: 999_999,
    modelTier: {},
    modelTiers: {}
  };
  let now = 50_000;
  const app = createMeetingRoomApp({
    root: base,
    config,
    workspace,
    attachmentsDir: attachments,
    publicDir,
    passcodeFile: path.join(secrets, 'passcode.txt'),
    forbiddenRoots: [secrets],
    openDirectory: directory => { openedDirectories.push(directory); return true; },
    orchestrator,
    restore: false,
    authOptions: {
      now: () => now,
      sessionTtlMs: 1_000,
      maxFailures: 3,
      blockMs: 5_000
    },
    authSweepMs: 5
  });
  const server = http.createServer(app.handleRequest);
  t.after(async () => {
    app.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  });

  return {
    app,
    server,
    passcode,
    workspace,
    attachments,
    secrets,
    publicDir,
    meeting,
    restoreCalls,
    openedDirectories,
    advance(ms) { now += ms; }
  };
}

async function listen(server) {
  const origin = 'memory://server-' + (++memoryServerId);
  server.origin = origin;
  server.listening = true;
  memoryServers.set(origin, server);
  return origin;
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] || '';
}

async function login(base, passcode, headers = {}) {
  return fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ passcode })
  });
}

test('未登入只公開登入頁與精確的 180 圖示，所有現在及未來 API 都先被拒絕', async t => {
  const f = fixture(t);
  const base = await listen(f.server);

  for (const pathname of ['/', '/index.html']) {
    const response = await fetch(base + pathname, { redirect: 'manual' });
    assert.equal(response.status, 303, pathname);
    assert.equal(response.headers.get('location'), '/login.html');
    assert.equal((await response.text()).includes('PRIVATE-MEETING-STATE'), false);
  }

  for (const pathname of ['/login', '/login.html', '/assets/icon-180.png']) {
    const response = await fetch(base + pathname, { redirect: 'manual' });
    assert.equal(response.status, 200, pathname);
  }

  for (const pathname of ['/assets/avatar-user.png', '/assets/sfx/yes-my-lord.mp3']) {
    assert.equal((await fetch(base + pathname)).status, 401, pathname);
  }

  const apiPaths = [
    '/api/events', '/api/state', '/api/attachment?rel=2026-09-09%2Fshown.txt',
    '/api/asset?path=outputs%2Fready.png', '/api/capabilities', '/api/workspace',
    '/api/browse', '/api/doctor', '/api/deliverable/open-folder',
    '/api/deliverable/upload', '/api/future'
  ];
  for (const pathname of apiPaths) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 401, pathname);
    assert.doesNotMatch(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal((await response.text()).includes('PRIVATE-MEETING-STATE'), false);
  }
  for (const method of ['POST', 'PUT', 'OPTIONS']) {
    assert.equal((await fetch(base + '/api/future', { method })).status, 401, method);
  }
});

test('交件開啟資料夾與上傳都要登入，且只操作卡片登記的安全位置', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const request = (pathname, payload, cookie = '') => fetch(base + pathname, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal((await request('/api/deliverable/upload', {
    id: 'd-upload', files: [{ name: 'hero.png', data: Buffer.from('image').toString('base64') }]
  })).status, 401);
  const cookie = cookieFrom(await login(base, f.passcode));

  const opened = await request('/api/deliverable/open-folder', { id: 'd-upload' }, cookie);
  assert.equal(opened.status, 200);
  assert.deepEqual(f.openedDirectories, [realpathSync(path.join(f.workspace, '交件區'))]);

  const uploaded = await request('/api/deliverable/upload', {
    id: 'd-upload', files: [{ name: 'hero.png', type: 'image/png', data: Buffer.from('image').toString('base64') }]
  }, cookie);
  assert.equal(uploaded.status, 200);
  assert.equal(readFileSync(path.join(f.workspace, '交件區', 'hero.png'), 'utf8'), 'image');

  const conflict = await request('/api/deliverable/upload', {
    id: 'd-upload', files: [{ name: 'hero.png', data: Buffer.from('replacement').toString('base64') }]
  }, cookie);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'FILE_EXISTS');
  assert.equal(readFileSync(path.join(f.workspace, '交件區', 'hero.png'), 'utf8'), 'image');

  for (const payload of [
    { id: 'unknown', files: [{ name: 'hero.png', data: 'aQ==' }] },
    { id: 'd-upload', files: [{ name: '../hero.png', data: 'aQ==' }] },
    { id: 'd-secret', files: [{ name: 'secret.png', data: 'aQ==' }] }
  ]) {
    assert.equal((await request('/api/deliverable/upload', payload, cookie)).status, 400);
  }
  assert.equal(existsSync(path.join(f.workspace, 'hero.png')), false);

  rmSync(path.join(f.workspace, '交件區', 'hero.png'));
  const oversized = await request('/api/deliverable/upload', {
    id: 'd-upload',
    files: [{ name: 'hero.png', data: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64') }]
  }, cookie);
  assert.equal(oversized.status, 413);
  assert.equal(existsSync(path.join(f.workspace, '交件區', 'hero.png')), false);
});

test('登入錯誤不洩密，正確登入只設 HttpOnly cookie 並開放受保護內容', async t => {
  const f = fixture(t);
  const base = await listen(f.server);

  const wrong = await login(base, 'sentinel-wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.has('set-cookie'), false);
  assert.equal((await wrong.text()).includes('sentinel-wrong-password'), false);

  const good = await login(base, f.passcode);
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie') || '', /HttpOnly/);
  const payload = await good.json();
  assert.deepEqual(payload, { ok: true });
  const cookie = cookieFrom(good);

  const root = await fetch(base + '/', { headers: { Cookie: cookie } });
  assert.equal(root.status, 200);
  assert.match(root.headers.get('cache-control') || '', /no-store/);
  assert.equal(root.headers.get('x-frame-options'), 'DENY');
  assert.equal(root.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await root.text(), /三方開發會議室/);

  const state = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  assert.match(state.headers.get('cache-control') || '', /no-store/);
  assert.equal((await state.json()).marker, 'PRIVATE-MEETING-STATE');

  const avatar = await fetch(base + '/assets/avatar-user.png', { headers: { Cookie: cookie } });
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get('cache-control'), 'private, max-age=3600');
  const sfx = await fetch(base + '/assets/sfx/yes-my-lord.mp3', { headers: { Cookie: cookie } });
  assert.equal(sfx.status, 200);
  assert.equal(sfx.headers.get('cache-control'), 'private, max-age=3600');

  assert.equal((await fetch(base + '/api/state?aimr_session=fake')).status, 401);
});

test('跨站、錯誤 Host、非 JSON 與破損 JSON 都不會消耗登入失敗額度', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const sameSite = { Host: '127.0.0.1:4477', Origin: 'http://127.0.0.1:4477' };

  const wrongHost = await fetch(base + '/login.html', {
    headers: { Host: 'attacker.example' },
    localAddress: '127.0.0.1'
  });
  assert.equal(wrongHost.status, 403);

  const textPlain = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...sameSite, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ passcode: 'wrong' })
  });
  assert.equal(textPlain.status, 415);

  const crossSite = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { Host: '127.0.0.1:4477', Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'wrong' })
  });
  assert.equal(crossSite.status, 403);

  const malformed = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...sameSite, 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(malformed.status, 400);

  const good = await login(base, f.passcode, sameSite);
  assert.equal(good.status, 200);
});

test('登入後的高權限 POST 仍拒絕跨站與非 JSON 請求', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const host = '127.0.0.1:4477';
  const origin = 'http://127.0.0.1:4477';
  const cookie = cookieFrom(await login(base, f.passcode, { Host: host, Origin: origin }));

  const crossSite = await fetch(base + '/api/save', {
    method: 'POST',
    headers: { Cookie: cookie, Host: host, Origin: 'http://127.0.0.1:9999', 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(crossSite.status, 403);

  const formLogout = await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Host: host, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: ''
  });
  assert.equal(formLogout.status, 415);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 200);

  const logout = await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Host: host, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(logout.status, 200);
});

test('缺少有效密碼檔時登入回 503 且主畫面保持關閉', async t => {
  const f = fixture(t);
  f.app.close();
  const closedApp = createMeetingRoomApp({
    root: REPO_ROOT,
    config: { workspace: f.workspace, modelTier: {}, modelTiers: {} },
    workspace: f.workspace,
    attachmentsDir: f.attachments,
    passcodeFile: path.join(f.secrets, 'missing.txt'),
    forbiddenRoots: [f.secrets],
    orchestrator: { m: f.meeting, save: () => null },
    restore: false
  });
  const closedServer = http.createServer(closedApp.handleRequest);
  t.after(async () => {
    closedApp.close();
    if (closedServer.listening) await new Promise(resolve => closedServer.close(resolve));
  });
  const base = await listen(closedServer);

  assert.equal((await login(base, f.passcode)).status, 503);
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(base + '/api/state')).status, 401);
});

test('登入內容有大小上限，限速只採 socket 位址而不信任轉送標頭', async t => {
  const f = fixture(t);
  const base = await listen(f.server);

  const oversized = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'x'.repeat(20_000) })
  });
  assert.equal(oversized.status, 413);

  for (let i = 0; i < 2; i++) {
    const response = await login(base, 'wrong', { 'X-Forwarded-For': '203.0.113.' + i });
    assert.equal(response.status, 401);
  }
  const blocked = await login(base, 'wrong', { 'X-Forwarded-For': '198.51.100.200' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await login(base, f.passcode, { 'X-Forwarded-For': '192.0.2.50' })).status, 429);
});

test('登出會清 cookie、立刻撤銷 session，且同一條 SSE 連線會被關閉', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const good = await login(base, f.passcode);
  const cookie = cookieFrom(good);

  let resolveOpen;
  let resolveClosed;
  const opened = new Promise(resolve => { resolveOpen = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const request = http.get(base + '/api/events', { headers: { Cookie: cookie } }, response => {
    assert.equal(response.statusCode, 200);
    response.once('data', chunk => {
      assert.match(chunk.toString(), /connected/);
      resolveOpen();
    });
    response.once('close', resolveClosed);
    response.once('end', resolveClosed);
  });
  t.after(() => request.destroy());
  await opened;

  const logout = await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 未在登出後關閉')), 500))
  ]);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(base + '/api/logout', { method: 'POST' })).status, 401);
});

test('session 逾時會主動切斷 SSE，重新建立伺服器後舊 cookie 也無效', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const good = await login(base, f.passcode);
  const cookie = cookieFrom(good);

  let resolveOpen;
  let resolveClosed;
  const opened = new Promise(resolve => { resolveOpen = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const request = http.get(base + '/api/events', { headers: { Cookie: cookie } }, response => {
    response.once('data', () => resolveOpen());
    response.once('close', resolveClosed);
    response.once('end', resolveClosed);
  });
  t.after(() => request.destroy());
  await opened;

  f.advance(1_001);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 未在逾時後關閉')), 500))
  ]);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 401);

  const restarted = createMeetingRoomApp({
    root: REPO_ROOT,
    config: { workspace: f.workspace, modelTier: {}, modelTiers: {} },
    workspace: f.workspace,
    attachmentsDir: f.attachments,
    passcodeFile: path.join(f.secrets, 'passcode.txt'),
    forbiddenRoots: [f.secrets],
    orchestrator: { m: f.meeting, save: () => null },
    restore: false
  });
  t.after(() => restarted.close());
  const probe = http.createServer(restarted.handleRequest);
  t.after(async () => { if (probe.listening) await new Promise(resolve => probe.close(resolve)); });
  const restartedBase = await listen(probe);
  assert.equal((await fetch(restartedBase + '/api/state', { headers: { Cookie: cookie } })).status, 401);
});

test('登入後素材與附件仍只開放本場已登記檔，且 .secrets 與 symlink 永久拒絕', async t => {
  const f = fixture(t);
  const outside = path.join(path.dirname(f.workspace), 'outside.txt');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, path.join(f.workspace, 'outputs', 'outside-link.txt'));
  f.meeting.deliverables.push({ status: 'review', file: { rel: 'outputs/outside-link.txt' } });
  symlinkSync(path.join(f.workspace, 'package.json'), path.join(f.workspace, 'outputs', 'inside-link.txt'));
  f.meeting.deliverables.push({ status: 'review', file: { rel: 'outputs/inside-link.txt' } });
  const attachmentOutside = path.join(path.dirname(f.attachments), 'attachment-outside.txt');
  writeFileSync(attachmentOutside, 'outside');
  symlinkSync(attachmentOutside, path.join(f.attachments, '2026-09-09', 'outside-link.txt'));
  f.meeting.transcript[0].files.push({ rel: '2026-09-09/outside-link.txt' });
  symlinkSync(path.join(f.secrets, 'token.txt'), path.join(f.publicDir, 'assets', 'secret-link.txt'));

  const base = await listen(f.server);
  const cookie = cookieFrom(await login(base, f.passcode));
  const headers = { Cookie: cookie };

  const asset = await fetch(base + '/api/asset?path=outputs%2Fready.png', { headers });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'registered-image');

  const attachment = await fetch(base + '/api/attachment?rel=2026-09-09%2Fshown.txt', { headers });
  assert.equal(attachment.status, 200);
  assert.equal(await attachment.text(), 'registered-attachment');
  assert.equal((await fetch(base + '/assets/avatar-user.png', { headers })).status, 200);

  const active = await fetch(base + '/api/asset?path=outputs%2Factive.svg', { headers });
  assert.equal(active.status, 200);
  assert.equal(active.headers.get('content-type'), 'application/octet-stream');
  assert.match(active.headers.get('content-disposition') || '', /^attachment;/);
  assert.match(active.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(await active.text(), /<script>/);

  const htmlAttachment = await fetch(base + '/api/attachment?rel=2026-09-09%2Fpage.html', { headers });
  assert.equal(htmlAttachment.status, 200);
  assert.equal(htmlAttachment.headers.get('content-type'), 'application/octet-stream');
  assert.match(htmlAttachment.headers.get('content-disposition') || '', /^attachment;/);
  assert.match(htmlAttachment.headers.get('content-security-policy') || '', /sandbox/);

  const denied = [
    '/api/asset?path=package.json',
    '/api/asset?path=.secrets%2Ftoken.txt',
    '/api/asset?path=outputs%2Foutside-link.txt',
    '/api/asset?path=outputs%2Finside-link.txt',
    '/api/asset?path=..%2Foutside.txt',
    '/api/asset?path=%252e%252e%252Foutside.txt',
    '/api/attachment?rel=old-secret.txt',
    '/api/attachment?rel=2026-09-09%2Foutside-link.txt',
    '/assets/secret-link.txt',
    '/assets/%E0%A4%A'
  ];
  for (const pathname of denied) {
    assert.equal((await fetch(base + pathname, { headers })).status, 404, pathname);
  }
});

test('restore 只接受目前會議裡真的存在的項目編號，不把未知值當成資料夾', async t => {
  const f = fixture(t);
  const base = await listen(f.server);
  const cookie = cookieFrom(await login(base, f.passcode));

  const unknown = await fetch(base + '/api/restore', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '../../outside-project' })
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(f.restoreCalls, []);

  f.meeting.actions = [{ id: 'a-safe', status: 'dropped' }];
  const known = await fetch(base + '/api/restore', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'a-safe' })
  });
  assert.equal(known.status, 200);
  assert.deepEqual(f.restoreCalls, ['a-safe']);
});

test('正式登入頁可獨立載入，並只把密碼送往伺服器登入端點', async t => {
  const f = fixture(t);
  f.app.close();
  const app = createMeetingRoomApp({
    root: REPO_ROOT,
    config: { workspace: f.workspace, modelTier: {}, modelTiers: {} },
    workspace: f.workspace,
    attachmentsDir: f.attachments,
    publicDir: path.join(REPO_ROOT, 'public'),
    passcodeFile: path.join(f.secrets, 'passcode.txt'),
    forbiddenRoots: [f.secrets],
    orchestrator: { m: f.meeting, save: () => null },
    restore: false
  });
  t.after(() => app.close());
  const server = http.createServer(app.handleRequest);
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const base = await listen(server);

  const response = await fetch(base + '/login.html');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /<form\b/i);
  assert.match(html, /type="password"/i);
  assert.match(html, /\/api\/login/);
  assert.match(html, /\/assets\/icon-180\.png/);
  assert.equal(html.includes(f.passcode), false);
});
