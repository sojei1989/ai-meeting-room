import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { createMeetingRoomApp } from '../server/index.js';

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Headers();
    this.chunks = [];
    this.completed = new Promise(resolve => this.once('finish', resolve));
  }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, String(value));
    return this;
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); }
}

function request(app, pathname, { body, cookie } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
  req.method = payload ? 'POST' : 'GET';
  req.url = pathname;
  req.headers = { host: 'localhost', ...(payload ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new MemoryResponse();
  app.handleRequest(req, res);
  return res.completed.then(() => res);
}

function discovery(detectedAt, version, extra = {}) {
  return {
    detectedAt,
    providers: {
      claude: { ok: true, source: 'claude --help', detectedAt, cliVersion: version, models: [], efforts: [], reason: '' },
      codex: { ok: true, source: 'codex debug models', detectedAt, cliVersion: 'codex-cli 0.153.4', models: [], efforts: [], reason: '', ...extra }
    }
  };
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-model-discovery-'));
  const workspace = path.join(root, 'workspace');
  const publicDir = path.join(root, 'public');
  const secretsDir = path.join(root, '.secrets');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(path.join(publicDir, 'index.html'), '<title>test</title>');
  writeFileSync(path.join(publicDir, 'login.html'), '<title>login</title>');
  writeFileSync(path.join(secretsDir, 'passcode.txt'), 'secret\n');
  const config = {
    workspace,
    listen: { local: '127.0.0.1' },
    autosaveMs: 999999,
    claude: { bin: '/bin/true' },
    codexRead: { bin: '/bin/true' },
    modelSelection: { claude: { model: 'opus', effort: 'medium' }, codex: { model: 'gpt-5.6-sol', effort: 'low' } }
  };
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const results = [
    discovery('2026-09-15T06:00:00.000Z', '2.1.266'),
    discovery('2026-09-15T06:05:00.000Z', '2.1.267', {
      models: [{ id: 'gpt-new', label: 'GPT New', efforts: ['low'], status: 'detected', reason: '新模型尚未經使用者同意' }]
    }),
    {
      detectedAt: '2026-09-15T06:10:00.000Z',
      providers: {
        claude: { ok: false, source: 'claude --help', detectedAt: '2026-09-15T06:10:00.000Z', models: [], efforts: [], reason: '指令逾時' },
        codex: { ok: false, source: 'codex debug models', detectedAt: '2026-09-15T06:10:00.000Z', models: [], efforts: [], reason: '指令逾時' }
      }
    }
  ];
  let calls = 0;
  const app = createMeetingRoomApp({
    root, configFile, config, workspace, publicDir,
    attachmentsDir: path.join(root, 'attachments'),
    passcodeFile: path.join(secretsDir, 'passcode.txt'),
    restore: false,
    discoverModels: () => results[Math.min(calls++, results.length - 1)]
  });
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }); });
  return { app, calls: () => calls };
}

async function login(app) {
  const response = await request(app, '/api/login', { body: { passcode: 'secret' } });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('重新檢查會更新檢查時間與 CLI 版本，並把新模型列出但鎖住', async t => {
  const { app, calls } = fixture(t);
  const cookie = await login(app);
  const refreshed = await request(app, '/api/modelDiscovery/refresh', { body: {}, cookie });
  assert.equal(refreshed.statusCode, 200);
  const body = refreshed.json();
  assert.equal(calls(), 2);
  assert.equal(body.discovery.detectedAt, '2026-09-15T06:05:00.000Z');
  assert.equal(body.discovery.providers.claude.cliVersion, '2.1.267');
  assert.equal(body.discovery.providers.codex.cliVersion, 'codex-cli 0.153.4');
  assert.deepEqual(body.pendingApproval, [{ provider: 'codex', id: 'gpt-new', label: 'GPT New', reason: '新模型尚未經使用者同意' }]);
  assert.equal(body.models.codex.some(model => model.id === 'gpt-new' && model.selectable === false), true);
});

test('偵測失敗要顯示本次檢查時間與失敗原因，不能把舊結果冒充成本次結果', async t => {
  const { app } = fixture(t);
  const cookie = await login(app);
  await request(app, '/api/modelDiscovery/refresh', { body: {}, cookie });
  const second = await request(app, '/api/modelDiscovery/refresh', { body: {}, cookie });
  const body = second.json();
  assert.equal(body.discovery.detectedAt, '2026-09-15T06:10:00.000Z');
  assert.equal(body.discovery.providers.codex.ok, false);
  assert.equal(body.discovery.providers.codex.reason, '指令逾時');
  assert.equal(body.pendingApproval.length, 0);
});

test('模型 API 要把 Spark 保留為不可選說明項目並回傳本次未提供原因', async t => {
  const { app } = fixture(t);
  const cookie = await login(app);
  const response = await request(app, '/api/modelConfig', { cookie });
  const spark = response.json().models.codex.find(model => model.id === 'gpt-5.3-codex-spark');

  assert.equal(response.statusCode, 200);
  assert.equal(spark.label, 'GPT-5.3 Codex Spark');
  assert.equal(spark.selectable, false);
  assert.equal(spark.status, 'unavailable');
  assert.equal(spark.note, 'OpenAI 已於 2026-09-14 退役這個模型，無法再選用');
});
