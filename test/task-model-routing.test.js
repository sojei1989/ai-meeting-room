import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { codexSpec } from '../server/adapters/codex.js';
import { codexSelectionForAction } from '../server/model-config.js';
import { Orchestrator } from '../server/orchestrator.js';

const CFG = {
  timeoutMs: 1_000,
  modelSelection: {
    codex: { model: 'gpt-6-astra', effort: 'xhigh' }
  },
  codexRead: { bin: '/bin/true', args: ['-p', '{PROMPT}'] },
  codexWrite: { bin: '/bin/true', args: ['-p', '{PROMPT}'] }
};

function newRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aimr-task-routing-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('非法模型與超過使用者上限的模型或深度都會在執行前被阻擋', () => {
  const invalid = codexSelectionForAction(CFG, {
    codexModel: 'not-a-real-model', reasoningEffort: 'low'
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'MODEL_NOT_ALLOWED');

  const cappedCfg = {
    ...CFG,
    modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'high' } }
  };
  const modelAboveLimit = codexSelectionForAction(cappedCfg, {
    codexModel: 'gpt-6-astra', reasoningEffort: 'high'
  });
  assert.equal(modelAboveLimit.ok, false);
  assert.equal(modelAboveLimit.code, 'ACTION_MODEL_ABOVE_LIMIT');

  const effortAboveLimit = codexSelectionForAction(cappedCfg, {
    codexModel: 'gpt-5.6-sol', reasoningEffort: 'xhigh'
  });
  assert.equal(effortAboveLimit.ok, false);
  assert.equal(effortAboveLimit.code, 'ACTION_EFFORT_ABOVE_LIMIT');
});

test('每張工單執行時會把自己的模型與思考深度交給 Codex', async t => {
  const workspace = newRepo(t);
  const received = [];
  const orchestrator = new Orchestrator(CFG, workspace, () => {}, {
    ask: {
      codex: async (cfg, prompt, ws, mode, onLog, opts) => {
        received.push(opts.selection);
        return { ok: true, data: { summary: '完成', tests: '測試完成', outOfScope: '無' }, prose: '' };
      }
    }
  });
  orchestrator.m.actions = [
    {
      id: 'a1', title: '簡單工單', status: 'pending', codexModel: 'gpt-5.6-luna', reasoningEffort: 'low',
      files: [{ op: 'add', path: 'simple-result.txt' }]
    },
    {
      id: 'a2', title: '複雜工單', status: 'pending', codexModel: 'gpt-5.6-sol', reasoningEffort: 'high',
      files: [{ op: 'add', path: 'complex-result.txt' }]
    }
  ];

  await orchestrator.approve('a1', { deferReview: true });
  await orchestrator.approve('a2', { deferReview: true });

  assert.deepEqual(received, [
    { model: 'gpt-5.6-luna', effort: 'low' },
    { model: 'gpt-5.6-sol', effort: 'high' }
  ]);
  assert.deepEqual(orchestrator.m.actions.map(action => action.status), ['done', 'done']);
});

test('使用者手動覆寫後，Claude 後續送來的同名舊設定不能蓋回去', () => {
  const orchestrator = new Orchestrator(CFG, '/tmp', () => {});
  orchestrator.m.actions = [{
    id: 'a1', title: '修正手機輸入', status: 'pending',
    codexModel: 'gpt-5.6-sol', reasoningEffort: 'medium'
  }];

  const changed = orchestrator.updateActionModel('a1', {
    model: 'gpt-5.6-luna', effort: 'low'
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.action.modelOverride, true);

  orchestrator.addActions([{
    title: '修正手機輸入', codexModel: 'gpt-5.6-sol', reasoningEffort: 'high',
    assignmentReason: 'Claude 重新評估'
  }], 'a');

  assert.equal(orchestrator.m.actions[0].codexModel, 'gpt-5.6-luna');
  assert.equal(orchestrator.m.actions[0].reasoningEffort, 'low');
  assert.equal(orchestrator.m.actions[0].modelOverride, true);
});

test('舊工單沒有模型欄位時會安全沿用全域設定', () => {
  const selected = codexSelectionForAction(CFG, { id: 'legacy', title: '舊工單' });
  assert.equal(selected.ok, true);
  assert.equal(selected.source, 'global');
  assert.deepEqual(selected.selection, { model: 'gpt-6-astra', effort: 'xhigh' });

  const prepared = codexSpec(CFG, 'write', selected.selection);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.spec.args, [
    '-p', '--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh', '{PROMPT}'
  ]);
});
