import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../server/orchestrator.js';

// Codex 每次啟動都會把這串寫進 stderr。它不是錯誤，不該被當成失敗原因。
const BANNER = [
  'Reading additional input from stdin...',
  '2026-09-09T02:04:46.598274Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 132 column 5',
  'OpenAI Codex v0.144.6',
  '--------',
  'workdir: /Users/x/proj',
  'model: gpt-5.6-sol',
  'provider: openai',
  'approval: never',
  'sandbox: workspace-write [workdir, /tmp, $TMPDIR]',
  'reasoning effort: ultra',
  'reasoning summaries: none',
  'session id: 01a08442-010e-7411-976f-66db00b5ae2c',
  '--------',
].join('\n');

test('橫幅不會被當成失敗原因', () => {
  const out = Orchestrator.explainCliFailure({ code: 1, stdout: '', stderr: BANNER });
  assert.ok(!out.includes('workdir:'), '不該出現 workdir');
  assert.ok(!out.includes('session id'), '不該出現 session id');
  assert.ok(!out.includes('base_instructions'), '不該出現 models cache 雜訊');
});

test('沒有任何訊息時要說清楚，而不是給一個空白紅框', () => {
  const out = Orchestrator.explainCliFailure({ code: 143, stdout: '', stderr: BANNER });
  assert.match(out, /結束碼 143/);
  assert.match(out, /沒有留下任何訊息/);
});

test('真正的錯誤在 stdout 時要顯示出來', () => {
  const out = Orchestrator.explainCliFailure({
    code: 1,
    stdout: BANNER + '\nError: ENOSPC: no space left on device, write',
    stderr: BANNER,
  });
  assert.match(out, /ENOSPC/);
  assert.match(out, /結束碼 1/);
});

test('stderr 裡的真錯誤也要留下來', () => {
  const out = Orchestrator.explainCliFailure({
    code: 2, stdout: '', stderr: BANNER + '\nfatal: authentication required',
  });
  assert.match(out, /authentication required/);
});

test('結束碼缺漏時不會印出 undefined', () => {
  const out = Orchestrator.explainCliFailure({ stdout: '', stderr: '' });
  assert.match(out, /結束碼 未知/);
});
