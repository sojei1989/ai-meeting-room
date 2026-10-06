import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../server/orchestrator.js';

function fixture(codexReply) {
  const prompts = [];
  const o = new Orchestrator({ timeoutMs: 1000 }, '/tmp', () => {}, {
    ask: { codex: async (cfg, prompt) => { prompts.push(prompt); return codexReply; } }
  });
  o.m.goal = '任務一';
  o.m.options = [
    { id: 'A', title: '先修外掛，再請你跑兩次', desc: '短影音和長片各存各的檔' },
    { id: 'B', title: '不修，先用手上的資料出報告', desc: '' }
  ];
  o.m.actions = [{ id: 'a1', title: '舊卡：備份長片', risk: 'low', status: 'pending' }];
  return { o, prompts };
}

test('選定方案後自動請 Codex 依方案開單，新卡進待處理、階段回到「待你決定」', async () => {
  const { o, prompts } = fixture({ ok: true, data: {
    summary: '照方案 A 要改三個地方',
    actions: [
      { id: 'n1', title: '短影音與長片分檔儲存', say: '', risk: 'mid', files: [] },
      { id: 'n2', title: '抓排程中與不公開影片', say: '', risk: 'mid', files: [] },
      { id: 'n3', title: '舊卡：備份長片', say: '', risk: 'low', files: [] }
    ], deliverables: []
  } });
  const r = await o.choose('A');
  assert.equal(r.planned, true);
  assert.equal(o.m.chosen, 'A');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /先修外掛，再請你跑兩次/);
  assert.match(prompts[0], /短影音和長片各存各的檔/);
  const pending = o.m.actions.filter(a => a.status === 'pending');
  assert.equal(pending.length, 3, '兩張新卡＋一張同名合併，不重複開');
  assert.ok(pending.some(a => a.id === 'o2' || a.id.startsWith('o')));
  assert.equal(o.m.phase, 3);
  assert.ok(o.m.decisions.some(d => /開了 2 項待核准工單/.test(d.text)));
  assert.equal(o.m.busy, false);
});

test('Codex 說不需要新卡時，只記一筆，不報錯', async () => {
  const { o } = fixture({ ok: true, data: { summary: '現有的卡就夠', actions: [], deliverables: [] } });
  await o.choose('B');
  assert.ok(o.m.decisions.some(d => /不需要新工單/.test(d.text)));
  assert.equal(o.m.error, '');
});

test('正在忙的時候只記錄選擇，不呼叫 Codex；找不到方案要回報', async () => {
  const { o, prompts } = fixture({ ok: true, data: { actions: [] } });
  o.m.busy = true;
  const r = await o.choose('A');
  assert.equal(r.planned, false);
  assert.equal(prompts.length, 0);
  assert.equal(o.m.chosen, 'A');
  const r2 = await o.choose('nope');
  assert.equal(r2.ok, false);
});

test('Codex 開單失敗會走統一的錯誤出口，方案選擇仍保留', async () => {
  const { o } = fixture({ ok: false, error: 'boom', code: 1, stdout: 'Error: boom', stderr: '' });
  await o.choose('A');
  assert.equal(o.m.chosen, 'A');
  assert.match(o.m.error, /Codex執行失敗/);
  assert.equal(o.m.busy, false);
});
