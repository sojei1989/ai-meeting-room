import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  MODEL_CATALOG,
  codexModelRank,
  codexPlanningText,
  codexSelectionForAction,
  modelConfigInfo,
  selectedModel,
  validateModelSelection
} from '../server/model-config.js';
import { parseCodexModels } from '../server/model-discovery.js';
import { askCodex, codexSpec, looksLikeModelRejection } from '../server/adapters/codex.js';
import { claudePlanPrompt } from '../server/prompts.js';
import { createMeetingRoomApp } from '../server/index.js';

// 2026-10-06 `codex debug models`（Codex CLI 0.160.0）實際輸出的節錄：只留會議室用到的欄位。
const REAL_OUTPUT = JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', default_reasoning_level: 'low', visibility: 'list', priority: 2, upgrade: null, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', default_reasoning_level: 'low', visibility: 'list', priority: 1, upgrade: null, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Previous generation workhorse model.', default_reasoning_level: 'medium', visibility: 'list', priority: 3, upgrade: null, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', default_reasoning_level: 'medium', visibility: 'list', priority: 4, upgrade: null, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'Older generation workhorse model.', default_reasoning_level: 'low', visibility: 'list', priority: 5, upgrade: { model: 'gpt-6-sol' }, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.', default_reasoning_level: 'medium', visibility: 'list', priority: 8, upgrade: { model: 'gpt-6-sol' }, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', default_reasoning_level: 'medium', visibility: 'list', priority: 9, upgrade: { model: 'gpt-6-luna' }, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
  { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue', visibility: 'hide', priority: 11, upgrade: null, supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Legacy coding model.', default_reasoning_level: 'medium', visibility: 'list', priority: 13, upgrade: { model: 'gpt-6-sol' }, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })) },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43, upgrade: null, supported_reasoning_levels: [{ effort: 'low' }] }
] });

const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function codexModel(id, label, efforts = ALL, extra = {}) {
  return { id, label, efforts, status: 'detected', reason: '', ...extra };
}
function discoveryWith(codexModels, claude = null) {
  return {
    detectedAt: '2026-10-06T00:00:00.000Z',
    providers: {
      ...(claude ? { claude } : {}),
      codex: { ok: true, source: 'codex debug models', models: codexModels, efforts: [], reason: '' }
    }
  };
}
const realModels = () => parseCodexModels(REAL_OUTPUT);
const withoutModel = id => realModels().filter(model => model.id !== id);

test('實際 CLI 輸出：隱藏模型不列入，並保留預設深度、官方升級建議與說明', () => {
  const models = realModels();
  assert.equal(models.some(model => model.id.includes('daybreak') || model.id === 'codex-auto-review'), false);
  const legacy = models.find(model => model.id === 'gpt-5.6-sol');
  assert.equal(legacy.upgrade, 'gpt-6-sol');
  assert.equal(legacy.defaultEffort, 'low');
  assert.equal(legacy.priority, 5);
  assert.match(legacy.description, /Older generation/);
  // 前面夾警告、JSON 被排版過也要讀得到
  const pretty = 'WARNING: proceeding\n' + JSON.stringify(JSON.parse(REAL_OUTPUT), null, 2);
  assert.equal(parseCodexModels(pretty).length, models.length);
});

test('內建清單的排序和自動推估的高低一致（新模型才能插對位置）', () => {
  const ids = MODEL_CATALOG.codex.map(model => model.id);
  const sorted = [...ids].sort((a, b) => codexModelRank(b) - codexModelRank(a));
  assert.deepEqual(sorted, ids);
  assert.ok(codexModelRank('gpt-7-astra') > codexModelRank('gpt-6-astra'));
  assert.ok(codexModelRank('gpt-6.2-sol') > codexModelRank('gpt-6.1-sol'));
  assert.ok(codexModelRank('gpt-6.2-sol') < codexModelRank('gpt-6-astra'));
  // 不認得的新家族一律當成最高檔
  assert.ok(codexModelRank('gpt-7-nova') > codexModelRank('gpt-7-astra'));
  assert.ok(codexModelRank('o9-mini') > codexModelRank('gpt-6-astra'));
});

test('CLI 新列出的模型會自動出現但先鎖住，等使用者開放；官方升級建議會寫進說明', () => {
  const discovery = discoveryWith([
    ...realModels(),
    codexModel('gpt-6.2-sol', 'GPT-6.2-Sol', ALL, { description: 'Newest workhorse.' }),
    codexModel('gpt-7-nova', 'GPT-7-Nova')
  ]);
  const cfg = { modelDiscovery: discovery, modelSelection: { codex: { model: 'gpt-6.1-sol', effort: 'medium' } } };
  const info = modelConfigInfo(cfg);
  const ids = info.models.codex.map(model => model.id);
  assert.deepEqual(ids.slice(0, 4), ['gpt-7-nova', 'gpt-6-astra', 'gpt-6.2-sol', 'gpt-6.1-sol']);
  const fresh = info.models.codex.find(model => model.id === 'gpt-6.2-sol');
  assert.equal(fresh.label, 'GPT-6.2 Sol');
  assert.equal(fresh.selectable, false);
  assert.equal(fresh.status, 'pending');
  assert.match(fresh.note, /開放/);
  assert.match(fresh.note, /Newest workhorse/);
  assert.deepEqual(info.pendingApproval.map(item => item.id), ['gpt-7-nova', 'gpt-6.2-sol']);
  assert.equal(validateModelSelection('codex', { model: 'gpt-6.2-sol', effort: 'low' }, discovery).code, 'MODEL_NOT_APPROVED');
  const legacy = info.models.codex.find(model => model.id === 'gpt-5.6-terra');
  assert.equal(legacy.selectable, true);
  assert.equal(legacy.note, '舊世代，官方建議改用 GPT-6 Sol');
});

test('開放之後就能選，思考深度以 CLI 回報為準（新出現的深度也能用）', () => {
  const discovery = discoveryWith([...realModels(), codexModel('gpt-6.2-sol', 'GPT-6.2-Sol', [...ALL, 'extreme'])]);
  const approvals = { codex: ['gpt-6.2-sol'] };
  const ok = validateModelSelection('codex', { model: 'gpt-6.2-sol', effort: 'extreme' }, discovery, approvals);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.selection, { model: 'gpt-6.2-sol', effort: 'extreme' });
  const info = modelConfigInfo({ modelDiscovery: discovery, modelApprovals: approvals, modelSelection: {} });
  const entry = info.models.codex.find(model => model.id === 'gpt-6.2-sol');
  assert.equal(entry.selectable, true);
  assert.equal(info.pendingApproval.length, 0);
  // 不安全的代號或深度不會變成指令參數
  const bad = discoveryWith([codexModel('gpt-6-sol', 'GPT-6-Sol', ['low', 'x"; rm -rf /'])]);
  assert.deepEqual(modelConfigInfo({ modelDiscovery: bad }).models.codex.find(model => model.id === 'gpt-6-sol').efforts, ['low']);
});

test('CLI 拿掉你選的模型時，自動改用同家族的可用版本，設定檔不被改寫', () => {
  const cfg = {
    modelSelection: { codex: { model: 'gpt-6.1-sol', effort: 'medium' } },
    modelDiscovery: discoveryWith(withoutModel('gpt-6.1-sol'))
  };
  const result = selectedModel(cfg, 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.substituted, true);
  assert.deepEqual(result.selection, { model: 'gpt-6-sol', effort: 'medium' });
  assert.match(result.notice, /你設定的「GPT-6\.1 Sol（medium）」這次不能用/);
  assert.match(result.notice, /暫時改用「GPT-6 Sol（medium）」/);
  assert.deepEqual(cfg.modelSelection.codex, { model: 'gpt-6.1-sol', effort: 'medium' });

  const spec = codexSpec({ ...cfg, codexRead: { args: ['exec', '{PROMPT}'] } }, 'read');
  assert.deepEqual(spec.spec.args, ['exec', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=medium', '{PROMPT}']);
  assert.match(spec.notice, /暫時改用/);

  const info = modelConfigInfo(cfg);
  assert.deepEqual(info.current.codex, { model: 'gpt-6-sol', effort: 'medium' });
  assert.deepEqual(info.preferred.codex, { model: 'gpt-6.1-sol', effort: 'medium' });
  assert.match(info.notices.codex.msg, /恢復後會自動換回/);
  // 原本的模型回來就自動換回
  const back = selectedModel({ ...cfg, modelDiscovery: discoveryWith(realModels()) }, 'codex');
  assert.equal(back.substituted, undefined);
  assert.deepEqual(back.selection, { model: 'gpt-6.1-sol', effort: 'medium' });
});

test('只有深度被拿掉時換成最接近、不更深的深度；同家族都沒有時改用不更貴的最近一個', () => {
  const effortGone = selectedModel({
    modelSelection: { codex: { model: 'gpt-6-luna', effort: 'ultra' } },
    modelDiscovery: discoveryWith(realModels())
  }, 'codex');
  assert.deepEqual(effortGone.selection, { model: 'gpt-6-luna', effort: 'max' });

  const lunaGone = selectedModel({
    modelSelection: { codex: { model: 'gpt-6-luna', effort: 'low' } },
    modelDiscovery: discoveryWith(realModels().filter(model => !model.id.includes('luna')))
  }, 'codex');
  // Luna 都沒了：只會往下找（GPT-5.5 排在 Luna 之後），不會自己升到 Sol
  assert.equal(lunaGone.selection.model, 'gpt-5.5');

  const terraGone = selectedModel({
    modelSelection: { codex: { model: 'gpt-5.6-terra', effort: 'high' } },
    modelDiscovery: discoveryWith(withoutModel('gpt-5.6-terra'))
  }, 'codex');
  assert.deepEqual(terraGone.selection, { model: 'gpt-6-luna', effort: 'high' });
});

test('自動替代絕不比原本更高階：舊款被拿掉時不會自己升到新一代，剩下的都更高階就停下來讓你選', () => {
  // 你選 GPT-5.6 Sol；CLI 拿掉它，但還有 GPT-6.1 Sol、GPT-6 Sol（都比它高階）
  const legacyGone = selectedModel({
    modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'medium' } },
    modelDiscovery: discoveryWith(withoutModel('gpt-5.6-sol'))
  }, 'codex');
  assert.equal(legacyGone.ok, true);
  assert.deepEqual(legacyGone.selection, { model: 'gpt-5.6-terra', effort: 'medium' });
  // 工單上限跟著實際使用的替代模型，不會因此放寬到 Sol
  const ticket = codexSelectionForAction({
    modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'medium' } },
    modelDiscovery: discoveryWith(withoutModel('gpt-5.6-sol'))
  }, { codexModel: 'gpt-6-sol', reasoningEffort: 'low' });
  assert.equal(ticket.code, 'ACTION_MODEL_ABOVE_LIMIT');

  const onlyHigher = selectedModel({
    modelSelection: { codex: { model: 'gpt-6-luna', effort: 'low' } },
    modelDiscovery: discoveryWith([codexModel('gpt-6-astra', 'GPT-6-Astra'), codexModel('gpt-6-sol', 'GPT-6-Sol')])
  }, 'codex');
  assert.equal(onlyHigher.ok, false);
  assert.match(onlyHigher.msg, /不比它高階/);

  // 原本的深度在替代模型上沒有、也沒有更淺的：不會自己加深
  const noShallower = selectedModel({
    modelSelection: { codex: { model: 'gpt-6-sol', effort: 'low' } },
    modelDiscovery: discoveryWith([codexModel('gpt-6-sol', 'GPT-6-Sol', ['high', 'xhigh'])])
  }, 'codex');
  assert.equal(noShallower.ok, false);
});

test('打錯或不認得的深度是設定錯誤，不會被自動換成最深的深度', () => {
  const discovery = discoveryWith(realModels());
  for (const effort of ['hgih', 'HIGH', 'x"; rm -rf /']) {
    const result = selectedModel({ modelSelection: { codex: { model: 'gpt-6-sol', effort } }, modelDiscovery: discovery }, 'codex');
    assert.equal(result.ok, false, effort);
    assert.equal(result.code, 'MODEL_EFFORT_NOT_ALLOWED', effort);
  }
  const madeUp = codexSelectionForAction({ modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } }, modelDiscovery: discovery },
    { codexModel: 'gpt-6-sol', reasoningEffort: 'mid' });
  assert.equal(madeUp.ok, false);
  assert.equal(madeUp.code, 'MODEL_EFFORT_NOT_ALLOWED');
});

test('兩個都是新出現、無法比較的深度或家族時，一律當成超過上限', () => {
  const efforts = discoveryWith([codexModel('gpt-6-sol', 'GPT-6-Sol', [...ALL, 'extreme', 'insane'])]);
  const cfg = { modelSelection: { codex: { model: 'gpt-6-sol', effort: 'extreme' } }, modelDiscovery: efforts };
  assert.equal(codexSelectionForAction(cfg, { codexModel: 'gpt-6-sol', reasoningEffort: 'insane' }).code, 'ACTION_EFFORT_ABOVE_LIMIT');
  assert.equal(codexSelectionForAction(cfg, { codexModel: 'gpt-6-sol', reasoningEffort: 'extreme' }).ok, true);
  assert.equal(codexSelectionForAction(cfg, { codexModel: 'gpt-6-sol', reasoningEffort: 'ultra' }).ok, true);
  assert.doesNotMatch(codexPlanningText(cfg), /insane/);

  const families = {
    modelSelection: { codex: { model: 'gpt-7-nova', effort: 'high' } },
    modelApprovals: { codex: ['gpt-7-nova', 'gpt-7-orion', 'gpt-6.5-nova'] },
    modelDiscovery: discoveryWith([codexModel('gpt-7-nova', 'GPT-7-Nova'), codexModel('gpt-7-orion', 'GPT-7-Orion'), codexModel('gpt-6.5-nova', 'GPT-6.5-Nova'), ...realModels()])
  };
  assert.equal(codexSelectionForAction(families, { codexModel: 'gpt-7-orion', reasoningEffort: 'low' }).code, 'ACTION_MODEL_ABOVE_LIMIT');
  assert.equal(codexSelectionForAction(families, { codexModel: 'gpt-6.5-nova', reasoningEffort: 'low' }).ok, true);
  assert.equal(codexSelectionForAction(families, { codexModel: 'gpt-6-sol', reasoningEffort: 'low' }).ok, true);
});

test('CLI 表示某個模型不支援思考深度時，工單和執行都可以不帶深度', () => {
  const cfg = {
    modelSelection: { codex: { model: 'gpt-7-mini', effort: null } },
    modelApprovals: { codex: ['gpt-7-mini'] },
    modelDiscovery: discoveryWith([codexModel('gpt-7-mini', 'GPT-7-Mini', [])]),
    codexWrite: { args: ['exec', '{PROMPT}'] }
  };
  const ticket = codexSelectionForAction(cfg, { codexModel: 'gpt-7-mini', reasoningEffort: '' });
  assert.equal(ticket.ok, true);
  assert.deepEqual(ticket.selection, { model: 'gpt-7-mini', effort: null });
  const spec = codexSpec(cfg, 'write', ticket.selection);
  assert.equal(spec.ok, true);
  assert.deepEqual(spec.spec.args, ['exec', '--model', 'gpt-7-mini', '{PROMPT}']);
  assert.match(codexPlanningText(cfg), /gpt-7-mini（GPT-7 Mini）：不設定思考深度/);
});

test('自動替代不會用到還沒開放的新模型，也不會替設定錯誤找台階', () => {
  const discovery = discoveryWith([
    codexModel('gpt-6.2-sol', 'GPT-6.2-Sol'),
    codexModel('gpt-6-luna', 'GPT-6-Luna', ALL.slice(0, 5))
  ]);
  const healed = selectedModel({ modelSelection: { codex: { model: 'gpt-6.1-sol', effort: 'high' } }, modelDiscovery: discovery }, 'codex');
  assert.deepEqual(healed.selection, { model: 'gpt-6-luna', effort: 'high' });

  const nothing = selectedModel({
    modelSelection: { codex: { model: 'gpt-6.1-sol', effort: 'high' } },
    modelDiscovery: discoveryWith([codexModel('gpt-6.2-sol', 'GPT-6.2-Sol')])
  }, 'codex');
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'MODEL_NOT_DETECTED');
  assert.match(nothing.msg, /找不到可以暫時替代/);

  const typo = selectedModel({ modelSelection: { codex: { model: 'gpt-evil', effort: 'low' } }, modelDiscovery: discovery }, 'codex');
  assert.equal(typo.code, 'MODEL_NOT_ALLOWED');
  const locked = selectedModel({ modelSelection: { claude: { model: 'fable', effort: 'low' } } }, 'claude');
  assert.equal(locked.code, 'MODEL_NOT_VERIFIED');
});

test('Claude 帳號實際驗證為不可用時，改用下一階可用的模型', () => {
  const claude = {
    ok: true,
    models: [
      { id: 'opus', label: 'Opus', efforts: ALL.slice(0, 5), status: 'unavailable', reason: '帳號實際驗證為目前不可用' },
      { id: 'sonnet', label: 'Sonnet', efforts: ALL.slice(0, 5), status: 'verified', reason: '' },
      { id: 'haiku', label: 'Haiku', efforts: ALL.slice(0, 5), status: 'verified', reason: '' }
    ]
  };
  const result = selectedModel({ modelSelection: { claude: { model: 'opus', effort: 'high' } }, modelDiscovery: discoveryWith([], claude) }, 'claude');
  assert.equal(result.ok, true);
  assert.deepEqual(result.selection, { model: 'sonnet', effort: 'high' });
});

test('Claude CLI 改版拿掉思考深度參數時，先改成不送深度，不讓會議卡住', () => {
  const claude = {
    ok: true,
    models: [{ id: 'opus', label: 'Opus', efforts: [], status: 'verified', reason: '' }]
  };
  const cfg = { modelSelection: { claude: { model: 'opus', effort: 'high' } }, modelDiscovery: discoveryWith([], claude), claude: { args: ['-p', '{PROMPT}'] } };
  const result = selectedModel(cfg, 'claude');
  assert.equal(result.ok, true);
  assert.equal(result.substituted, true);
  assert.deepEqual(result.selection, { model: 'opus', effort: null });
});

test('工單指定的模型不見時，在上限內自動替代；新出現的深度視為最深，不能繞過上限', () => {
  const cfg = {
    modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } },
    modelDiscovery: discoveryWith(withoutModel('gpt-5.6-terra'))
  };
  const ticket = codexSelectionForAction(cfg, { codexModel: 'gpt-5.6-terra', reasoningEffort: 'medium' });
  assert.equal(ticket.ok, true);
  assert.equal(ticket.substituted, true);
  assert.deepEqual(ticket.selection, { model: 'gpt-6-luna', effort: 'medium' });
  assert.match(ticket.notice, /這張工單原本指定的「GPT-5\.6 Terra（medium）」這次不能用/);

  const deeper = {
    modelSelection: { codex: { model: 'gpt-6-sol', effort: 'max' } },
    modelDiscovery: discoveryWith([codexModel('gpt-6-sol', 'GPT-6-Sol', [...ALL, 'extreme'])])
  };
  assert.equal(codexSelectionForAction(deeper, { codexModel: 'gpt-6-sol', reasoningEffort: 'extreme' }).code, 'ACTION_EFFORT_ABOVE_LIMIT');

  const approvedTop = {
    modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } },
    modelApprovals: { codex: ['gpt-7-nova'] },
    modelDiscovery: discoveryWith([...realModels(), codexModel('gpt-7-nova', 'GPT-7-Nova')])
  };
  assert.equal(codexSelectionForAction(approvedTop, { codexModel: 'gpt-7-nova', reasoningEffort: 'low' }).code, 'ACTION_MODEL_ABOVE_LIMIT');
});

test('Claude 規劃提示會帶入即時的 Codex 白名單與使用者上限', () => {
  const cfg = {
    modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } },
    modelDiscovery: discoveryWith([...realModels(), codexModel('gpt-6.2-sol', 'GPT-6.2-Sol')])
  };
  const text = codexPlanningText(cfg);
  assert.match(text, /- gpt-6-sol（GPT-6 Sol）：low、medium、high/);
  assert.match(text, /- gpt-6-luna（GPT-6 Luna）：low、medium、high\n/);
  assert.doesNotMatch(text, /gpt-6-astra|gpt-6\.1-sol|gpt-6\.2-sol|xhigh/);
  assert.match(text, /使用者設定的上限：gpt-6-sol，思考深度 high/);
  const prompt = claudePlanPrompt('做一個活動頁', '', [], text);
  assert.ok(prompt.includes(text));
  assert.ok(prompt.indexOf(text) < prompt.indexOf('Codex 分配規則'));

  const none = codexPlanningText({ modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } }, modelDiscovery: discoveryWith([]) });
  assert.match(none, /目前沒有可用的 Codex 模型/);
});

test('辨識 Codex 拒絕模型的錯誤訊息', () => {
  assert.equal(looksLikeModelRejection("ERROR: The 'gpt-6.1-sol' model does not exist or you do not have access to it."), true);
  assert.equal(looksLikeModelRejection('{"detail":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}'), true);
  assert.equal(looksLikeModelRejection('error: model_not_found'), true);
  assert.equal(looksLikeModelRejection('ERROR: stream disconnected before completion'), false);
  assert.equal(looksLikeModelRejection(''), false);
});

function fakeCodex(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aimr-fake-codex-'));
  const bin = path.join(dir, 'codex');
  writeFileSync(bin, [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  if [ "$a" = "gpt-6.1-sol" ]; then echo "ERROR: The \'gpt-6.1-sol\' model does not exist or you do not have access to it." >&2; exit 1; fi',
    'done',
    'echo \'<<<JSON\'',
    'echo \'{"summary":"完成"}\'',
    'echo \'JSON>>>\'',
    ''
  ].join('\n'));
  chmodSync(bin, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { bin, dir };
}

test('Codex 執行時拒絕模型：唯讀工作重新偵測後自動換模型重試一次；會改檔的工單只提示不重跑', async t => {
  const { bin, dir } = fakeCodex(t);
  let discovery = discoveryWith(realModels());
  const refreshes = [];
  const cfg = {
    timeoutMs: 10_000,
    modelSelection: { codex: { model: 'gpt-6.1-sol', effort: 'medium' } },
    codexRead: { bin, args: ['exec', '{PROMPT}'] },
    codexWrite: { bin, args: ['exec', '--write', '{PROMPT}'] }
  };
  Object.defineProperty(cfg, 'modelDiscovery', { get: () => discovery });
  Object.defineProperty(cfg, 'ensureModelsFresh', {
    value: ({ force = false } = {}) => {
      refreshes.push(force);
      if (!force) return false;
      discovery = discoveryWith(withoutModel('gpt-6.1-sol')); // 重新偵測後，CLI 已經不再列出這個模型
      return true;
    }
  });
  const logs = [];
  const read = await askCodex(cfg, '看一下專案', dir, 'read', chunk => logs.push(chunk));
  assert.equal(read.ok, true);
  assert.equal(read.data.summary, '完成');
  assert.ok(refreshes.includes(true));
  assert.ok(logs.some(line => line.includes('改用 gpt-6-sol 重試一次')));

  discovery = discoveryWith(realModels());
  const write = await askCodex(cfg, '改檔案', dir, 'write', () => {});
  assert.equal(write.ok, false);
  assert.match(write.error, /下次會改用 gpt-6-sol，按「重試」即可/);
});

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

function appFixture(t, { discoveries, versions, now }) {
  const root = mkdtempSync(path.join(tmpdir(), 'aimr-model-self-update-'));
  const workspace = path.join(root, 'workspace');
  const publicDir = path.join(root, 'public');
  const secretsDir = path.join(root, '.secrets');
  for (const dir of [workspace, publicDir, secretsDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(publicDir, 'index.html'), '<title>test</title>');
  writeFileSync(path.join(publicDir, 'login.html'), '<title>login</title>');
  writeFileSync(path.join(secretsDir, 'passcode.txt'), 'secret\n');
  const config = {
    workspace,
    listen: { local: '127.0.0.1' },
    autosaveMs: 999999,
    claude: { bin: 'claude-test' },
    codexRead: { bin: 'codex-test' },
    modelSelection: { claude: { model: 'opus', effort: 'medium' }, codex: { model: 'gpt-6-sol', effort: 'medium' } }
  };
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const calls = [];
  const app = createMeetingRoomApp({
    root, configFile, config, workspace, publicDir,
    attachmentsDir: path.join(root, 'attachments'),
    passcodeFile: path.join(secretsDir, 'passcode.txt'),
    restore: false,
    now,
    cliVersion: bin => versions[bin],
    discoverModels: options => {
      calls.push(options);
      return discoveries[Math.min(calls.length - 1, discoveries.length - 1)];
    }
  });
  t.after(() => { app.close(); rmSync(root, { recursive: true, force: true }); });
  return { app, config, configFile, calls };
}

function fullDiscovery(codexModels, versions = {}) {
  return {
    detectedAt: new Date(0).toISOString(),
    providers: {
      claude: {
        ok: true, cliVersion: versions.claude || '2.1.300', models: [
          { id: 'opus', label: 'Opus', efforts: ALL.slice(0, 5), status: 'verified', reason: '', validation: { attempted: true } },
          { id: 'sonnet', label: 'Sonnet', efforts: ALL.slice(0, 5), status: 'verified', reason: '', validation: { attempted: true } }
        ], efforts: ALL.slice(0, 5), reason: ''
      },
      codex: { ok: true, cliVersion: versions.codex || 'codex-cli 0.160.0', detectedAt: new Date(0).toISOString(), models: codexModels, efforts: [], reason: '' }
    }
  };
}

test('開放新模型會寫進設定檔；正在使用的模型不能收回；不是新模型不能開放', async t => {
  const discovery = fullDiscovery([...realModels(), codexModel('gpt-6.2-sol', 'GPT-6.2-Sol')]);
  const { app, config, configFile } = appFixture(t, {
    discoveries: [discovery],
    versions: { 'claude-test': '2.1.300', 'codex-test': 'codex-cli 0.160.0' },
    now: () => 0
  });
  const login = await request(app, '/api/login', { body: { passcode: 'secret' } });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];

  const before = (await request(app, '/api/modelConfig', { cookie })).json();
  assert.deepEqual(before.pendingApproval.map(item => item.id), ['gpt-6.2-sol']);

  const notNew = await request(app, '/api/modelApproval', { body: { who: 'codex', model: 'gpt-6-sol' }, cookie });
  assert.equal(notNew.statusCode, 400);

  const approved = await request(app, '/api/modelApproval', { body: { who: 'codex', model: 'gpt-6.2-sol' }, cookie });
  assert.equal(approved.statusCode, 200);
  const body = approved.json();
  assert.equal(body.models.codex.find(model => model.id === 'gpt-6.2-sol').selectable, true);
  assert.equal(body.pendingApproval.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')).modelApprovals, { codex: ['gpt-6.2-sol'] });

  const chosen = await request(app, '/api/modelSelection', { body: { who: 'codex', model: 'gpt-6.2-sol', effort: 'high' }, cookie });
  assert.equal(chosen.statusCode, 200);
  assert.deepEqual(config.modelSelection.codex, { model: 'gpt-6.2-sol', effort: 'high' });

  const revokeInUse = await request(app, '/api/modelApproval', { body: { who: 'codex', model: 'gpt-6.2-sol', approve: false }, cookie });
  assert.equal(revokeInUse.statusCode, 409);
});

test('CLI 改版或清單過期才自動重抓；背景重抓沿用 Claude 已驗證結果，不重複耗用量', t => {
  let nowMs = 0;
  const versions = { 'claude-test': '2.1.300', 'codex-test': 'codex-cli 0.160.0' };
  const first = fullDiscovery(realModels());
  first.providers.codex.detectedAt = new Date(0).toISOString();
  const second = fullDiscovery(withoutModel('gpt-6.1-sol'), { codex: 'codex-cli 0.161.0' });
  second.providers.claude.models = second.providers.claude.models.map(model => ({ ...model, status: 'cli_supported', validation: { attempted: false } }));
  second.providers.codex.detectedAt = new Date(10 * 60_000).toISOString();
  const { config, calls } = appFixture(t, { discoveries: [first, second], versions, now: () => nowMs });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].verifyClaudeModels, ['opus', 'sonnet', 'haiku']);

  nowMs = 60_000; // 還沒到最短間隔
  assert.equal(config.ensureModelsFresh(), false);
  nowMs = 6 * 60_000; // 到了間隔，但版本沒變、清單也沒過期
  assert.equal(config.ensureModelsFresh(), false);
  assert.equal(calls.length, 1);

  versions['codex-test'] = 'codex-cli 0.161.0';
  nowMs = 12 * 60_000;
  assert.equal(config.ensureModelsFresh(), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].verifyClaudeModels, ['haiku']); // opus、sonnet 已驗證過，只補驗還沒驗的
  const opus = config.modelDiscovery.providers.claude.models.find(model => model.id === 'opus');
  assert.equal(opus.status, 'verified');
  assert.equal(config.modelDiscovery.providers.codex.cliVersion, 'codex-cli 0.161.0');

  // 強制模式（模型被拒絕之後）不看間隔
  assert.equal(config.ensureModelsFresh({ force: true }), true);
  assert.equal(calls.length, 3);
});
