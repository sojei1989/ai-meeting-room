import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askOllama, ollamaTags } from '../server/adapters/ollama.js';

const CFG = { ollama: { url: 'http://192.0.2.10:11434/', model: '' }, ollamaTimeoutMs: 5000 };

function fakeServer({ models = ['llama3.1:8b', 'qwen2.5:7b'], response = '這是白話版', status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: models.map(name => ({ name })) }) };
    if (url.endsWith('/api/generate')) return { ok: status === 200, status, json: async () => (status === 200 ? { response } : { error: 'model not found' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
}

test('model 留空時先問 /api/tags，用第一個模型呼叫 /api/generate（不串流）', async () => {
  const { fetch, calls } = fakeServer();
  const r = await askOllama(CFG, '請翻成白話', '/tmp', null, { fetch });
  assert.equal(r.ok, true);
  assert.equal(r.prose, '這是白話版');
  assert.equal(r.model, 'llama3.1:8b');
  assert.equal(calls[0].url, 'http://192.0.2.10:11434/api/tags');
  assert.equal(calls[1].url, 'http://192.0.2.10:11434/api/generate');
  assert.equal(calls[1].body.model, 'llama3.1:8b');
  assert.equal(calls[1].body.stream, false);
  assert.equal(calls[1].body.think, false, '要關掉思考模式');
  assert.equal(calls[1].body.prompt, '請翻成白話');
});

test('指定 model 時不問 tags；模型沒拉（404）要講清楚', async () => {
  const { fetch, calls } = fakeServer({ status: 404 });
  const r = await askOllama({ ...CFG, ollama: { url: CFG.ollama.url, model: 'gemma3:4b' } }, 'x', '/tmp', null, { fetch });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.match(r.error, /404/);
  assert.match(r.error, /gemma3:4b/);
});

test('PC 上沒有模型、或連線被拒絕、或逾時，都回看得懂的原因而不是丟例外', async () => {
  const empty = fakeServer({ models: [] });
  const r1 = await askOllama(CFG, 'x', '/tmp', null, { fetch: empty.fetch });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /沒拉任何模型/);

  const refused = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const r2 = await askOllama(CFG, 'x', '/tmp', null, { fetch: refused });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /OLLAMA_HOST/);

  const timeout = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
  const r3 = await ollamaTags(CFG, { fetch: timeout });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /睡著|Tailscale/);
});

test('模型還是吐出 <think> 思考過程時會被剪掉', async () => {
  const { fetch } = fakeServer({ response: '<think>先想一下…</think>\n真正的白話版' });
  const r = await askOllama(CFG, 'x', '/tmp', null, { fetch });
  assert.equal(r.prose, '真正的白話版');
});

test('沒設 ollama.url 時直接回未設定', async () => {
  const r = await askOllama({}, 'x', '/tmp', null, { fetch: async () => { throw new Error('不該連'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ollama\.url/);
});
