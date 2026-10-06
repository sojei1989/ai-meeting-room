import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { createMeetingRoomApp } from '../server/index.js';
import { claudeSpec, claudeSpec as createClaudeSpec } from '../server/adapters/claude.js';
import { codexSpec } from '../server/adapters/codex.js';
import { discoverModels, parseClaudeHelp } from '../server/model-discovery.js';
import { modelCatalogInfo, validateModelSelection } from '../server/model-config.js';

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

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  json() {
    return JSON.parse(this.text());
  }
}

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-model-config-'));
  const workspace = path.join(root, 'workspace');
  const publicDir = path.join(root, 'public');
  const attachmentsDir = path.join(root, 'attachments');
  const secrets = path.join(root, '.secrets');
  const configFile = path.join(root, 'config.json');

  mkdirSync(workspace, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(publicDir, 'index.html'), '<title>test</title>');
  writeFileSync(path.join(publicDir, 'login.html'), '<title>login</title>');
  writeFileSync(path.join(publicDir, 'assets/icon-180.png'), 'icon');
  writeFileSync(path.join(secrets, 'passcode.txt'), 'secret-passcode\n');
  writeFileSync(path.join(secrets, 'token.txt'), 'do-not-read');

  const config = {
    workspace,
    listen: { local: '127.0.0.1' },
    autosaveMs: 999_999,
    modelTier: {},
    modelTiers: {},
    claude: { bin: '/bin/true', args: ['-p', '{PROMPT}'] },
    codexRead: { bin: '/bin/true', args: ['-p', '{PROMPT}'] },
    codexWrite: { bin: '/bin/true', args: ['-p', '{PROMPT}'] },
    timeoutMs: 10_000,
    modelSelection: {
      claude: { model: 'opus', effort: 'medium' },
      codex: { model: 'gpt-5.6-sol', effort: 'high' }
    }
  };
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');

  const app = createMeetingRoomApp({
    root,
    config: config,
    configFile,
    workspace,
    attachmentsDir,
    publicDir,
    passcodeFile: path.join(secrets, 'passcode.txt'),
    restore: false,
    authOptions: { sessionTtlMs: 5 * 60_000, maxFailures: 3, blockMs: 10_000 }
  });

  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { app, root, workspace, configFile };
}

function createRequest(app, pathname, options = {}) {
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  const req = new Readable({
    read() {
      if (payload) this.push(payload);
      this.push(null);
    }
  });
  req.method = options.body === undefined ? 'GET' : 'POST';
  req.url = pathname;
  req.headers = {
    host: 'localhost',
    ...(payload ? { 'content-type': 'application/json' } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {})
  };
  req.socket = { remoteAddress: '127.0.0.1' };

  const res = new MemoryResponse();
  app.handleRequest(req, res);
  return res.completed.then(() => res);
}

async function login(app, passcode) {
  const response = await createRequest(app, '/api/login', {
    body: { passcode }
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

test('未登入不能改模型設定，避免在權限外更改運算參數', async t => {
  const { app } = createFixture(t);
  const response = await createRequest(app, '/api/modelSelection', {
    body: { who: 'claude', model: 'sonnet', effort: 'high' }
  });
  assert.equal(response.statusCode, 401);
});

test('合法模型與思考深度一次更新後，會保存在設定檔並在重新啟動後保留', async t => {
  const { app, configFile } = createFixture(t);
  const cookie = await login(app, 'secret-passcode');

  const before = await createRequest(app, '/api/modelConfig', { cookie });
  const beforeBody = before.json();
  assert.equal(beforeBody.current.claude.model, 'opus');
  assert.equal(beforeBody.current.claude.effort, 'medium');

  const updated = await createRequest(app, '/api/modelSelection', {
    body: { who: 'claude', model: 'sonnet', effort: 'max' },
    cookie
  });
  assert.equal(updated.statusCode, 200);
  const updatedBody = updated.json();
  assert.equal(updatedBody.ok, true);
  assert.equal(updatedBody.current.claude.model, 'sonnet');
  assert.equal(updatedBody.current.claude.effort, 'max');

  const persisted = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(persisted.modelSelection.claude.model, 'sonnet');
  assert.equal(persisted.modelSelection.claude.effort, 'max');

  const afterRestart = createMeetingRoomApp({
    root: path.dirname(configFile),
    configFile,
    attachmentsDir: path.join(path.dirname(configFile), 'attachments'),
    publicDir: path.join(path.dirname(configFile), 'public'),
    passcodeFile: path.join(path.dirname(configFile), '.secrets/passcode.txt'),
    restore: false,
    authOptions: { sessionTtlMs: 5 * 60_000, maxFailures: 3, blockMs: 10_000 }
  });
  t.after(() => afterRestart.close());

  const response = await createRequest(afterRestart, '/api/login', { body: { passcode: 'secret-passcode' } });
  const cookie2 = response.headers.get('set-cookie').split(';', 1)[0];
  const reloaded = await createRequest(afterRestart, '/api/modelConfig', { cookie: cookie2 });
  const reloadedBody = reloaded.json();
  assert.equal(reloadedBody.current.claude.model, 'sonnet');
  assert.equal(reloadedBody.current.claude.effort, 'max');
});

test('非法模型與不支援深度要在送出前阻擋，且不要寫進設定', async t => {
  const { app, configFile } = createFixture(t);
  const cookie = await login(app, 'secret-passcode');
  const original = JSON.parse(readFileSync(configFile, 'utf8')).modelSelection;

  const invalidModel = await createRequest(app, '/api/modelSelection', {
    body: { who: 'claude', model: 'fable', effort: 'medium' },
    cookie
  });
  assert.equal(invalidModel.statusCode, 400);
  const afterInvalidModel = JSON.parse(readFileSync(configFile, 'utf8')).modelSelection;
  assert.deepEqual(afterInvalidModel, original);
  const invalidBody = invalidModel.json();
  assert.equal(invalidBody.ok, false);
  assert.equal(invalidBody.code, 'MODEL_NOT_VERIFIED');

  const invalidEffort = await createRequest(app, '/api/modelSelection', {
    body: { who: 'claude', model: 'haiku', effort: 'low' },
    cookie
  });
  assert.equal(invalidEffort.statusCode, 400);
  const afterInvalidEffort = JSON.parse(readFileSync(configFile, 'utf8')).modelSelection;
  assert.deepEqual(afterInvalidEffort, original);
  const effortBody = invalidEffort.json();
  assert.equal(effortBody.ok, false);
  assert.equal(effortBody.code, 'MODEL_EFFORT_NOT_SUPPORTED');
});

test('錯誤模型會被 model-config 在 CLI 組裝前阻擋，不會產生 CLI 參數', async () => {
  const blockedClaude = createClaudeSpec({
    modelSelection: { claude: { model: 'fable', effort: 'low' } },
    claude: { args: ['-p', '{PROMPT}'] }
  });
  assert.equal(blockedClaude.ok, false);
  assert.equal(blockedClaude.code, 'MODEL_NOT_VERIFIED');

  const blockedCodex = codexSpec({
    modelSelection: { codex: { model: 'gpt-5.6-luna', effort: 'ultra' } },
    codexRead: { args: ['-p', '{PROMPT}'] },
    codexWrite: { args: ['-p', '{PROMPT}'] }
  }, 'read');
  assert.equal(blockedCodex.ok, false);
  assert.equal(blockedCodex.code, 'MODEL_EFFORT_NOT_ALLOWED');
});

test('畫面送出的設定與實際 CLI 參數一致，模型與深度會同時同步到兩邊', () => {
  const cfg = {
    modelSelection: {
      claude: { model: 'sonnet', effort: 'xhigh' },
      codex: { model: 'gpt-5.6-sol', effort: 'ultra' }
    },
    claude: { args: ['-p', '{PROMPT}'] },
    codexRead: { args: ['-p', '{PROMPT}'] },
    codexWrite: { args: ['-p', '{PROMPT}'] }
  };

  const c = claudeSpec(cfg);
  const x = codexSpec(cfg, 'write');
  assert.equal(c.ok, true);
  assert.equal(x.ok, true);
  assert.deepEqual(c.spec.args, ['-p', '--model', 'sonnet', '--effort', 'xhigh', '{PROMPT}']);
  assert.deepEqual(x.spec.args, ['-p', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=ultra', '{PROMPT}']);
});

test('Claude help 只證明 CLI 支援模型與思考深度參數，不代表帳號可用', () => {
  const parsed = parseClaudeHelp(`
    --effort <level>  Effort level (low, medium, high, xhigh, max)
    --model <model>   Alias such as 'fable', 'opus', or 'sonnet'
  `);

  assert.equal(parsed.supports.modelParameter, true);
  assert.equal(parsed.supports.effortParameter, true);
  assert.deepEqual(parsed.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(parsed.aliases, ['fable', 'opus', 'sonnet']);
});

test('Claude 候選模型未實際驗證時只列出且不能執行', () => {
  const discovery = {
    providers: {
      claude: {
        ok: true,
        models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium'], status: 'cli_supported', reason: 'CLI 支援模型參數，但帳號尚未實際驗證' }]
      }
    }
  };

  const listed = modelCatalogInfo(discovery).claude.find(model => model.id === 'opus');
  assert.equal(listed.status, 'cli_supported');
  assert.equal(listed.selectable, false);
  assert.match(listed.note, /尚未實際驗證/);

  const blocked = validateModelSelection('claude', { model: 'opus', effort: 'medium' }, discovery);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'MODEL_NOT_VERIFIED');
});

test('Spark 本次未出現在 Codex CLI 公開清單時要保留名稱並說明不是設定錯誤', () => {
  const discovery = {
    providers: {
      codex: {
        ok: true,
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low'], status: 'detected', reason: '' }]
      }
    }
  };

  const spark = modelCatalogInfo(discovery).codex.find(model => model.id === 'gpt-5.3-codex-spark');
  assert.equal(spark.label, 'GPT-5.3 Codex Spark');
  assert.equal(spark.selectable, false);
  assert.equal(spark.status, 'unavailable');
  assert.equal(spark.note, 'OpenAI 已於 2026-09-14 退役這個模型，無法再選用');

  const blocked = validateModelSelection('codex', { model: spark.id, effort: 'low' }, discovery);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'MODEL_NOT_DETECTED');
  assert.equal(blocked.msg, spark.note);
});

test('Claude 受控驗證記錄結果但不保存模型回覆內容', () => {
  const calls = [];
  const exec = (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === '--version') return { status: 0, stdout: '2.1.266 (Claude Code)\n', stderr: '' };
    if (args[0] === '--help') {
      return {
        status: 0,
        stdout: "--effort <level> Effort level (low, medium, high, xhigh, max)\n--model <model> Alias such as 'opus' or 'sonnet'\n",
        stderr: ''
      };
    }
    return { status: 0, stdout: '這段模型回覆不可被保存', stderr: '' };
  };

  const result = discoverModels({
    exec,
    now: () => new Date('2026-09-15T06:00:00.000Z'),
    claudeCandidates: ['opus', 'sonnet'],
    verifyClaudeModels: ['opus']
  });
  const opus = result.providers.claude.models.find(model => model.id === 'opus');
  const sonnet = result.providers.claude.models.find(model => model.id === 'sonnet');

  assert.equal(result.providers.claude.cliVersion, '2.1.266 (Claude Code)');
  assert.equal(opus.status, 'verified');
  assert.equal(opus.validation.attempted, true);
  assert.equal(opus.validation.consumesQuota, true);
  assert.equal(sonnet.status, 'cli_supported');
  assert.equal(sonnet.validation.attempted, false);
  assert.equal(JSON.stringify(result).includes('這段模型回覆不可被保存'), false);
  assert.equal(calls.filter(call => call.args.includes('--model')).length, 1);
});
