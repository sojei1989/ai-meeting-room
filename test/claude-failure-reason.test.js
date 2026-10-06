import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverModels } from '../server/model-discovery.js';
import { validateModelSelection } from '../server/model-config.js';
import { claudeEnvelopeError, parseClaudeEnvelope } from '../server/adapters/claude-envelope.js';
import { approvedWriteScope, withinApprovedScope } from '../server/safe-path.js';
import { isNoisePath } from '../server/git.js';

const usage = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0 } };
const failedEnvelope = JSON.stringify({
  duration_api_ms: 0, stop_reason: 'stop_sequence', session_id: 'x', total_cost_usd: 0, usage,
  type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login'
});

function fakeExec(validationResults) {
  let n = 0;
  return (bin, args) => {
    if (args[0] === '--version') return { status: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '' };
    if (args[0] === '--help') return { status: 0, stdout: "--effort <level> Effort (low, medium, high)\n--model <model> Alias such as 'opus'\n", stderr: '' };
    if (args[0] === 'debug') return { status: 1, stdout: '', stderr: 'no codex' };
    const r = validationResults[Math.min(n, validationResults.length - 1)];
    n += 1;
    return r;
  };
}

test('驗證失敗時顯示信封裡的真正原因，而不是 usage 統計', () => {
  const env = parseClaudeEnvelope(failedEnvelope);
  assert.equal(claudeEnvelopeError(env), 'Not logged in · Please run /login');
  const result = discoverModels({ exec: fakeExec([{ status: 1, stdout: failedEnvelope, stderr: '' }]), claudeCandidates: ['opus'], verifyClaudeModels: ['opus'] });
  const opus = result.providers.claude.models[0];
  assert.equal(opus.status, 'unknown');
  assert.match(opus.reason, /Not logged in/);
  assert.match(opus.reason, /\/login/);
  assert.doesNotMatch(opus.reason, /duration_api_ms/);
});

test('結束碼 0 但信封標示錯誤，不能當成驗證成功', () => {
  const result = discoverModels({ exec: fakeExec([{ status: 0, stdout: failedEnvelope, stderr: '' }]), claudeCandidates: ['opus'], verifyClaudeModels: ['opus'] });
  assert.notEqual(result.providers.claude.models[0].status, 'verified');
});

test('暫時性失敗會重試一次，第二次成功就算驗證通過', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
  const result = discoverModels({
    exec: fakeExec([{ status: 1, stdout: '', stderr: 'fetch failed' }, { status: 0, stdout: ok, stderr: '' }]),
    claudeCandidates: ['opus'], verifyClaudeModels: ['opus']
  });
  assert.equal(result.providers.claude.models[0].status, 'verified');
});

test('驗證結果不確定時不鎖死 Claude；明確不可用或從未驗證仍然擋', () => {
  const make = status => ({ providers: { claude: { ok: true, models: [{ id: 'opus', efforts: ['medium'], status, reason: 'r' }] } } });
  assert.equal(validateModelSelection('claude', { model: 'opus', effort: 'medium' }, make('unknown')).ok, true);
  assert.equal(validateModelSelection('claude', { model: 'opus', effort: 'medium' }, make('unavailable')).ok, false);
  assert.equal(validateModelSelection('claude', { model: 'opus', effort: 'medium' }, make('cli_supported')).ok, false);
});

test('核准資料夾時，資料夾底下的檔案不算越界；旁邊的同名前綴仍算越界', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-scope-'));
  mkdirSync(path.join(root, 'Claude outputs'));
  writeFileSync(path.join(root, 'Claude outputs', 'A_001M.jpg'), 'x');
  writeFileSync(path.join(root, 'README.md'), 'x');
  const scope = approvedWriteScope({ root, files: [{ op: 'mod', path: 'Claude outputs' }, { op: 'mod', path: 'README.md' }] });
  assert.equal(scope.ok, true);
  assert.equal(withinApprovedScope('Claude outputs/A_001M.jpg', scope), true);
  assert.equal(withinApprovedScope('README.md', scope), true);
  assert.equal(withinApprovedScope('Claude outputs 2/A.jpg', scope), false);
  assert.equal(withinApprovedScope('README.md.bak', scope), false);
});

test('雲端同步與設計軟體暫存檔不算工單改動', () => {
  for (const f of ['.tmp.driveupload/58038', 'a/.DS_Store', '客服素材/000-logo/~ai-312a_.tmp', '.~lock.x.xlsx#', 'docs/~$報告.docx'])
    assert.equal(isNoisePath(f), true, f);
  for (const f of ['outputs/a.jpg', 'tmp.driveupload.md', 'ai-x.tmp'])
    assert.equal(isNoisePath(f), false, f);
});

test('還原點不收暫存檔，回復越界工單時也不刪暫存檔', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { checkpoint, changedPathsSince, restoreTaskChanges } = await import('../server/git.js');
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-noise-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); writeFileSync(path.join(root, 'a.txt'), '1'); g('add', '-A'); g('commit', '-qm', 'init');
  mkdirSync(path.join(root, '.tmp.driveupload'));
  writeFileSync(path.join(root, '.tmp.driveupload', '1'), 'sync');
  writeFileSync(path.join(root, 'a.txt'), '2');
  const cp = await checkpoint(root, 't', ['a.txt']);
  assert.equal(cp.ok, true, cp.error);
  const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(committed, /driveupload/);
  writeFileSync(path.join(root, '.tmp.driveupload', '2'), 'sync2');
  writeFileSync(path.join(root, 'b.txt'), 'new');
  const changed = await changedPathsSince(root, cp);
  assert.deepEqual(changed.paths, ['b.txt']);
  const r = await restoreTaskChanges(root, cp, changed.untracked);
  assert.equal(r.ok, true);
  assert.equal(existsSync(path.join(root, 'b.txt')), false);
  assert.equal(existsSync(path.join(root, '.tmp.driveupload', '2')), true);
});
