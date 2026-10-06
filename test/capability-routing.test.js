import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CAPABILITIES } from '../server/capabilities.js';
import {
  claudePlanPrompt,
  claudeReplyPrompt,
  codexAssessPrompt,
  codexReplyPrompt
} from '../server/prompts.js';
import { Orchestrator } from '../server/orchestrator.js';
import { createMeetingRoomApp } from '../server/index.js';

class TestResponse extends Writable {
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
    this.headersSent = true;
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function request(app, pathname, { body, cookie } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = new Readable({
    read() {
      if (payload) this.push(payload);
      this.push(null);
    }
  });
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = pathname;
  req.headers = {
    host: 'localhost',
    ...(payload ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {})
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new TestResponse();
  app.handleRequest(req, res);
  await res.completed;
  return {
    status: res.statusCode,
    headers: res.headers,
    json: () => JSON.parse(res.text())
  };
}

async function httpFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-capability-'));
  const workspace = path.join(root, 'workspace');
  const secrets = path.join(root, '.secrets');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(secrets, 'passcode.txt'), 'capability-test-passcode\n');

  const calls = { setImageBy: 0, generateAsset: 0 };
  const deliverable = {
    id: 'd-image',
    title: '活動主視覺',
    status: 'waiting',
    tool: 'manual',
    path: 'public/assets/campaign/hero.png'
  };
  const orchestrator = {
    m: { deliverables: [deliverable], transcript: [], actions: [] },
    save: () => null,
    restore: () => false,
    push: () => {},
    note: () => {},
    setImageBy: () => { calls.setImageBy++; return { ok: true }; },
    generateAsset: async () => { calls.generateAsset++; return { ok: true }; }
  };
  const app = createMeetingRoomApp({
    root,
    workspace,
    config: {
      workspace,
      listen: { local: '127.0.0.1' },
      autosaveMs: 999_999,
      modelTier: {},
      modelTiers: {}
    },
    orchestrator,
    restore: false,
    passcodeFile: path.join(secrets, 'passcode.txt')
  });
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const login = await request(app, '/api/login', { body: { passcode: 'capability-test-passcode' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return { app, calls, cookie, deliverable };
}

test('Claude 與 Codex 的能力契約不得宣稱可產圖', () => {
  for (const key of ['claude', 'codex']) {
    const participant = CAPABILITIES.find(item => item.key === key);
    assert.ok(participant, `缺少 ${key} 的能力定義`);
    assert.doesNotMatch(participant.can.join('、'), /產圖|生成圖片|Magnific/i, `${participant.name} 不得被標示為產圖者`);
    assert.match(participant.cant.join('、'), /產圖|生成圖片/, `${participant.name} 必須明列不負責產圖`);
  }

  const externalTool = CAPABILITIES.find(item => item.key === 'tool');
  assert.ok(externalTool, '缺少外部工具的能力定義');
  assert.match(externalTool.can.join('、'), /產圖/, '產圖能力應歸在外部工具');
  assert.doesNotMatch(externalTool.can.join('、'), /會議室自動呼叫|自動產圖/, '尚未授權前不得宣稱會自動產圖');
});

test('規劃與會中回覆只能建立規格完整的人工圖片交件卡', () => {
  const prompts = [
    ['Claude 規劃', claudePlanPrompt('需要一張主視覺', '', [])],
    ['Claude 回覆', claudeReplyPrompt('需要一張主視覺', '會議紀錄', [])],
    ['Codex 評估', codexAssessPrompt('需要一張主視覺', '會議紀錄', [])],
    ['Codex 回覆', codexReplyPrompt('需要一張主視覺', '會議紀錄', [])]
  ];

  for (const [name, prompt] of prompts) {
    assert.match(prompt, /"deliverables"/, `${name} 必須能建立交件項目`);
    for (const field of ['尺寸', '格式', '數量', '存放路徑']) {
      assert.match(prompt, new RegExp(field), `${name} 的圖片交件規格缺少「${field}」`);
    }
    assert.match(prompt, /"tool"\s*:\s*"manual"/, `${name} 必須固定走人工交件`);
    assert.doesNotMatch(prompt, /magnific\s*或\s*manual|Magnific（自動）|交給\s*Magnific.*自動/i, `${name} 不得宣稱自動產圖`);
  }
});

test('圖片交件入列時固定改成人工交件並保留完整規格與路徑', () => {
  const orchestrator = new Orchestrator({}, process.cwd(), () => {});
  const incoming = {
    title: '社群主視覺',
    say: '需要一張活動主視覺',
    specs: [['尺寸', '1200x628 px'], ['格式', 'PNG'], ['數量', '1 張']],
    path: 'public/assets/campaign/hero.png',
    tool: 'magnific'
  };

  const result = orchestrator.addDeliverables([incoming], 'd');
  assert.deepEqual(result, { added: 1, merged: 0 });
  const [deliverable] = orchestrator.m.deliverables;
  assert.equal(deliverable.status, 'waiting');
  assert.equal(deliverable.tool, 'manual');
  assert.equal(deliverable.deliveryMode, 'manual');
  assert.deepEqual(deliverable.specs, incoming.specs);
  assert.equal(deliverable.path, incoming.path);
  assert.match(deliverable.blockedReason, /外部產圖工具.*尚未.*授權|尚未.*授權.*外部產圖工具/);
  assert.equal('producer' in deliverable, false, '不得把 Claude、Codex 或 Magnific 寫成已指派的製作者');
});

test('缺少尺寸、格式、數量或路徑的圖片需求不得建立交件卡', () => {
  const complete = {
    title: '社群主視覺圖片',
    specs: [['尺寸', '1200x628 px'], ['格式', 'PNG'], ['數量', '1 張']],
    path: 'public/assets/campaign/hero.png'
  };
  const cases = [
    { name: '尺寸', value: { ...complete, specs: complete.specs.filter(([key]) => key !== '尺寸') } },
    { name: '格式', value: { ...complete, specs: complete.specs.filter(([key]) => key !== '格式') } },
    { name: '數量', value: { ...complete, specs: complete.specs.filter(([key]) => key !== '數量') } },
    { name: '存放路徑', value: { ...complete, path: '' } }
  ];

  for (const item of cases) {
    const orchestrator = new Orchestrator({}, process.cwd(), () => {});
    const result = orchestrator.addDeliverables([item.value], 'd');
    assert.equal(result.added, 0, `缺少${item.name}時不得入列`);
    assert.equal(result.invalid, 1, `缺少${item.name}時要明確回報規格不完整`);
    assert.match(result.issues[0], new RegExp(item.name));
    assert.equal(orchestrator.m.deliverables.length, 0);
  }
});

test('Claude 與 Codex 都不能被設成圖片製作者', () => {
  for (const who of ['claude', 'codex']) {
    const orchestrator = new Orchestrator({}, process.cwd(), () => {});
    const result = orchestrator.setImageBy(who);
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'AI_IMAGE_PRODUCER_FORBIDDEN');
    assert.match(result.msg, /人工交件/);
    assert.equal(orchestrator.m.imageBy, undefined);
  }
});

test('舊的自動產圖入口只回報人工交件阻塞且不啟動 AI', async () => {
  const orchestrator = new Orchestrator({
    imageBy: 'codex',
    imageTimeoutMs: 20,
    codexImage: { bin: '__this_ai_command_must_not_run__', args: [], cwd: '{WORKSPACE}' }
  }, process.cwd(), () => {});
  orchestrator.addDeliverables([{
    title: '活動主視覺',
    specs: [['尺寸', '1200x628 px'], ['格式', 'PNG'], ['數量', '1 張']],
    path: 'public/assets/campaign/hero.png',
    tool: 'manual'
  }], 'd');
  const deliverable = orchestrator.m.deliverables[0];

  const result = await orchestrator.generateAsset(deliverable.id, '請重做');

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'MANUAL_DELIVERY_REQUIRED');
  assert.match(result.msg, /尚未.*授權|未.*授權/);
  assert.match(result.msg, /public\/assets\/campaign\/hero\.png/);
  assert.equal(deliverable.status, 'waiting');
  assert.equal(deliverable.attempts, undefined);
  assert.equal(deliverable.tool, 'manual');
  assert.equal(deliverable.by, undefined);
  assert.equal(orchestrator.m.error, '');
});

test('舊素材按重做只退回人工交件且不再次呼叫產圖', () => {
  const orchestrator = new Orchestrator({}, process.cwd(), () => {});
  orchestrator.m.deliverables.push({
    id: 'legacy-review',
    title: '舊版主視覺',
    status: 'review',
    file: { name: 'hero.png', rel: 'public/assets/hero.png', size: 128 },
    by: 'Claude',
    tool: 'magnific'
  });
  let generateCalls = 0;
  orchestrator.generateAsset = () => { generateCalls++; };

  const result = orchestrator.assetDecide('legacy-review', false, '顏色太暗');

  assert.equal(result.ok, true);
  assert.equal(result.manual, true);
  assert.equal(generateCalls, 0);
  const deliverable = orchestrator.m.deliverables[0];
  assert.equal(deliverable.status, 'waiting');
  assert.equal(deliverable.tool, 'manual');
  assert.equal(deliverable.deliveryMode, 'manual');
  assert.equal(deliverable.feedback, '顏色太暗');
  assert.equal(deliverable.file, undefined);
  assert.equal(deliverable.by, undefined);
});

test('HTTP 不允許把圖片製作者切成 Claude 或 Codex', async t => {
  const fixture = await httpFixture(t);
  for (const who of ['claude', 'codex']) {
    const response = await request(fixture.app, '/api/imageBy', { body: { who }, cookie: fixture.cookie });
    assert.equal(response.status, 409);
    const result = response.json();
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'AI_IMAGE_PRODUCER_FORBIDDEN');
  }
  assert.equal(fixture.calls.setImageBy, 0);
});

test('HTTP 自動產圖入口停在人工交件且不呼叫製作流程', async t => {
  const fixture = await httpFixture(t);
  const response = await request(fixture.app, '/api/genAsset', {
    body: { id: fixture.deliverable.id },
    cookie: fixture.cookie
  });

  assert.equal(response.status, 409);
  const result = response.json();
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'MANUAL_DELIVERY_REQUIRED');
  assert.match(result.msg, /尚未.*授權|未.*授權/);
  assert.match(result.msg, /public\/assets\/campaign\/hero\.png/);
  assert.equal(fixture.calls.generateAsset, 0);
  assert.equal(fixture.deliverable.status, 'waiting');
  assert.equal(fixture.deliverable.attempts, undefined);
  assert.equal(fixture.deliverable.by, undefined);
});

test('發行用設定範本只保留人工圖片交件且沒有 Claude 或 Codex 產圖權限', () => {
  const config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  for (const key of ['claudeImage', 'codexImage', 'imageBy', 'imageTimeoutMs']) {
    assert.equal(Object.hasOwn(config, key), false, `config.example.json 不得保留 ${key}`);
  }
  assert.deepEqual(config.imageDelivery, {
    mode: 'manual',
    externalTool: { configured: false, authorized: false }
  });
});
