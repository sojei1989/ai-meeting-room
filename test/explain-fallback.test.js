import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../server/orchestrator.js';

function orch(cfg, ask) {
  return new Orchestrator(cfg, '/tmp', () => {}, { ask });
}
const GEMINI_CFG = { explainBy: 'gemini', gemini: { bin: 'gemini', args: ['-p', '{PROMPT}'] } };
const OLLAMA_CFG = { explainBy: 'ollama', ollama: { url: 'http://192.0.2.10:11434', model: '' }, gemini: { bin: 'gemini', args: [] } };
const pick = r => ({ text: r.text, by: r.by, fallback: r.fallback });

test('explainBy=gemini 時先問 Gemini，成功就用它的答案並標示 by=gemini', async () => {
  const calls = [];
  const o = orch(GEMINI_CFG, {
    gemini: async () => { calls.push('gemini'); return { ok: true, prose: '  白話版來了  ' }; },
    claude: async () => { calls.push('claude'); return { ok: true, prose: '不該用到' }; }
  });
  assert.deepEqual(pick(await o.explain('技術內容')), { text: '白話版來了', by: 'gemini', fallback: false });
  assert.deepEqual(calls, ['gemini']);
});

test('Gemini 失敗、吐空白或丟例外時退回 Claude，並標示 fallback', async () => {
  for (const gemini of [
    async () => ({ ok: false, error: 'gemini: command not found' }),
    async () => ({ ok: true, prose: '   ' }),
    async () => { throw new Error('spawn ENOENT'); }
  ]) {
    const o = orch(GEMINI_CFG, { gemini, claude: async () => ({ ok: true, prose: 'Claude 的白話' }) });
    assert.deepEqual(pick(await o.explain('技術內容')), { text: 'Claude 的白話', by: 'claude', fallback: true });
  }
});

test('explainBy=claude 或沒設定 gemini 時完全不碰 Gemini', async () => {
  let geminiCalls = 0;
  const ask = { gemini: async () => { geminiCalls++; return { ok: true, prose: 'x' }; }, claude: async () => ({ ok: true, prose: 'C' }) };
  const r1 = await orch({ explainBy: 'claude', gemini: { bin: 'gemini', args: [] } }, ask).explain('a');
  const r2 = await orch({ explainBy: 'gemini' }, ask).explain('a');
  assert.deepEqual(pick(r1), { text: 'C', by: 'claude', fallback: false });
  assert.deepEqual(pick(r2), { text: 'C', by: 'claude', fallback: false });
  assert.equal(geminiCalls, 0);
});

test('兩邊都失敗時回傳看得懂的失敗訊息，不會丟例外', async () => {
  const o = orch(GEMINI_CFG, {
    gemini: async () => ({ ok: false, error: 'timeout' }),
    claude: async () => ({ ok: false, error: 'claude 結束碼 1' })
  });
  const r = await o.explain('a');
  assert.match(r.text, /解釋失敗/);
  assert.equal(r.by, 'claude');
});

test('explainBy=ollama 的順序是 Ollama → Gemini → Claude，Ollama 成功時帶回模型名', async () => {
  const calls = [];
  const o = orch(OLLAMA_CFG, {
    ollama: async () => { calls.push('ollama'); return { ok: true, prose: 'PC 翻的', model: 'llama3.1:8b' }; },
    gemini: async () => { calls.push('gemini'); return { ok: true, prose: 'G' }; },
    claude: async () => { calls.push('claude'); return { ok: true, prose: 'C' }; }
  });
  assert.deepEqual(o.explainChain(), ['ollama', 'gemini', 'claude']);
  const r = await o.explain('a');
  assert.deepEqual(pick(r), { text: 'PC 翻的', by: 'ollama', fallback: false });
  assert.equal(r.model, 'llama3.1:8b');
  assert.deepEqual(calls, ['ollama']);
});

test('PC 睡著（Ollama 逾時）就退到 Gemini；Gemini 也倒就退到 Claude', async () => {
  const calls = [];
  const dead = async () => { calls.push('ollama'); return { ok: false, error: '逾時，PC 可能睡著' }; };
  const o1 = orch(OLLAMA_CFG, { ollama: dead, gemini: async () => { calls.push('gemini'); return { ok: true, prose: 'G' }; }, claude: async () => ({ ok: true, prose: 'C' }) });
  assert.deepEqual(pick(await o1.explain('a')), { text: 'G', by: 'gemini', fallback: true });
  const o2 = orch(OLLAMA_CFG, { ollama: dead, gemini: async () => ({ ok: false, error: 'x' }), claude: async () => { calls.push('claude'); return { ok: true, prose: 'C' }; } });
  assert.deepEqual(pick(await o2.explain('a')), { text: 'C', by: 'claude', fallback: true });
  assert.deepEqual(calls, ['ollama', 'gemini', 'ollama', 'claude']);
});

test('explainBy=ollama 但沒設 ollama.url 時直接從 Gemini 開始', async () => {
  const o = orch({ explainBy: 'ollama', gemini: { bin: 'gemini', args: [] } }, {
    ollama: async () => { throw new Error('不該被叫到'); },
    gemini: async () => ({ ok: true, prose: 'G' }),
    claude: async () => ({ ok: true, prose: 'C' })
  });
  assert.deepEqual(o.explainChain(), ['gemini', 'claude']);
  assert.deepEqual(pick(await o.explain('a')), { text: 'G', by: 'gemini', fallback: false });
});
