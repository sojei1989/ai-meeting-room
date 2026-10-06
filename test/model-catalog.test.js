import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, modelCatalogInfo, validateModelSelection, codexSelectionForAction } from '../server/model-config.js';
import { parseCodexModels } from '../server/model-discovery.js';

// 2026-10-02 `codex debug models`（Codex CLI 0.160.0）實際輸出的節錄
const levels = list => list.map(effort => ({ effort }));
const FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_OUTPUT = JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: levels(FULL.slice(0, 5)) },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_reasoning_levels: levels(FULL.slice(0, 5)) },
  { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue', visibility: 'hide', supported_reasoning_levels: levels(FULL) },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: levels(FULL.slice(0, 4)) },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', supported_reasoning_levels: levels(FULL.slice(0, 5)) }
] });

test('Codex 白名單依能力與成本由高到低排列，2026-10 的新模型都在', () => {
  assert.deepEqual(MODEL_CATALOG.codex.map(model => model.id), [
    'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark'
  ]);
});

test('CLI 列出的可見模型都在白名單內，隱藏模型不會被列入', () => {
  const detected = parseCodexModels(CODEX_OUTPUT);
  const ids = MODEL_CATALOG.codex.map(model => model.id);
  for (const model of detected) assert.ok(ids.includes(model.id), model.id);
  assert.equal(detected.some(model => model.id.includes('daybreak') || model.id === 'codex-auto-review'), false);
});

test('白名單的思考深度和 CLI 回報一致', () => {
  for (const model of parseCodexModels(CODEX_OUTPUT)) {
    const entry = MODEL_CATALOG.codex.find(item => item.id === model.id);
    assert.deepEqual([...entry.efforts], model.efforts, model.id);
  }
});

test('偵測到新模型時可以選用；Luna 不能選 ultra；Spark 顯示退役原因', () => {
  const discovery = { providers: { codex: { ok: true, models: parseCodexModels(CODEX_OUTPUT).map(model => ({ ...model, status: 'detected', reason: '' })) } } };
  assert.equal(validateModelSelection('codex', { model: 'gpt-6.1-sol', effort: 'medium' }, discovery).ok, true);
  assert.equal(validateModelSelection('codex', { model: 'gpt-6-luna', effort: 'ultra' }, discovery).ok, false);
  const spark = modelCatalogInfo(discovery).codex.find(model => model.id === 'gpt-5.3-codex-spark');
  assert.equal(spark.selectable, false);
  assert.match(spark.note, /退役/);
  const legacy = modelCatalogInfo(discovery).codex.find(model => model.id === 'gpt-5.6-sol');
  assert.equal(legacy.selectable, true);
  assert.match(legacy.note, /舊世代/);
});

test('上限設在 GPT-6 Sol 時，工單不能指定 GPT-6.1 Sol，但可以用 GPT-6 Luna', () => {
  const cfg = { modelSelection: { codex: { model: 'gpt-6-sol', effort: 'high' } } };
  assert.equal(codexSelectionForAction(cfg, { codexModel: 'gpt-6.1-sol', reasoningEffort: 'medium' }).code, 'ACTION_MODEL_ABOVE_LIMIT');
  assert.equal(codexSelectionForAction(cfg, { codexModel: 'gpt-6-luna', reasoningEffort: 'low' }).ok, true);
});

test('Fable 預設不開放並寫明原因', () => {
  const fable = MODEL_CATALOG.claude.find(model => model.id === 'fable');
  assert.equal(fable.selectable, false);
  assert.match(fable.note, /額外用量/);
});
