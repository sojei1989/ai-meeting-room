const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_SPARK_ID = 'gpt-5.3-codex-spark';
const CODEX_SPARK_UNAVAILABLE_NOTE = 'OpenAI 已於 2026-09-14 退役這個模型，無法再選用';
const CODEX_LEGACY_NOTE = '舊世代，官方已不建議用在新工作';
const NEW_MODEL_NOTE = 'CLI 新提供的模型，等你按「開放」後才會使用';
const APPROVED_MODEL_NOTE = '你開放的新模型';

// CLI 回報的模型代號與思考深度會原樣變成指令參數，只接受單純的英數格式。
export const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

// 這幾種失敗代表「環境變了」（CLI 改版、模型下架、某個深度被拿掉、帳號暫時不能用），
// 會自動找最接近的可用模型頂上；其他失敗（不在白名單、被鎖住、格式錯）是設定本身的問題，照樣擋下。
export const HEALABLE_MODEL_CODES = Object.freeze(['MODEL_NOT_DETECTED', 'MODEL_EFFORT_NOT_DETECTED', 'MODEL_UNAVAILABLE']);

// 內建清單：已確認過的模型、中文名稱、說明與排序（能力與成本由高到低）。
// 2026-10 起它不再是唯一的可用名單：
// - Codex CLI 之後新列出的模型會自動出現在設定裡，標成「待你開放」，你按一下才會使用；
// - 內建模型如果 CLI 不再提供，會自動改用最接近的可用模型，原本的模型恢復後自動換回。
export const MODEL_CATALOG = Object.freeze({
  claude: Object.freeze([
    Object.freeze({ id: 'opus', label: 'Opus', efforts: Object.freeze([...CLAUDE_EFFORTS]), selectable: true }),
    Object.freeze({ id: 'sonnet', label: 'Sonnet', efforts: Object.freeze([...CLAUDE_EFFORTS]), selectable: true }),
    Object.freeze({ id: 'haiku', label: 'Haiku', efforts: Object.freeze([]), selectable: true }),
    Object.freeze({
      id: 'fable',
      label: 'Fable',
      efforts: Object.freeze([...CLAUDE_EFFORTS]),
      selectable: false,
      note: 'Fable 依方案可能改用額外用量點數計費；會議室在背景呼叫時無法先跳出確認，所以預設不開放'
    })
  ]),
  // 由前到後是能力與成本由高到低，要和 codexModelRank 的推估一致（測試會檢查）。
  // 2026-10-02 依 codex debug models（CLI 0.160.0）與 OpenAI Codex 模型頁更新：
  // Astra 旗艦、Sol 主力、Terra 平衡、Luna 快速；同一級新世代排前面。
  codex: Object.freeze([
    Object.freeze({ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: Object.freeze([...CODEX_EFFORTS]), selectable: true }),
    Object.freeze({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: Object.freeze([...CODEX_EFFORTS]), selectable: true }),
    Object.freeze({ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: Object.freeze([...CODEX_EFFORTS]), selectable: true }),
    Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: Object.freeze([...CODEX_EFFORTS]), selectable: true, note: CODEX_LEGACY_NOTE }),
    Object.freeze({ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: Object.freeze([...CODEX_EFFORTS]), selectable: true, note: CODEX_LEGACY_NOTE }),
    Object.freeze({ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: Object.freeze(CODEX_EFFORTS.slice(0, 5)), selectable: true }),
    Object.freeze({ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: Object.freeze(CODEX_EFFORTS.slice(0, 5)), selectable: true, note: CODEX_LEGACY_NOTE }),
    Object.freeze({ id: 'gpt-5.5', label: 'GPT-5.5', efforts: Object.freeze(CODEX_EFFORTS.slice(0, 4)), selectable: true, note: '官方預定 2026-10-14 退役' }),
    Object.freeze({ id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', efforts: Object.freeze(CODEX_EFFORTS.slice(0, 4)), selectable: true })
  ])
});

const PROVIDERS = Object.freeze(['claude', 'codex']);
const LEGACY_TIER_NAMES = Object.freeze(['light', 'standard', 'max']);
const EFFORT_VOCABULARY = Object.freeze({ claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS });
const CODEX_FAMILY_TIER = Object.freeze({ astra: 4, sol: 3, terra: 2, luna: 1 });
const CLAUDE_TIER = Object.freeze({ fable: 5, opus: 4, sonnet: 3, haiku: 2 });
const UNKNOWN_TIER = 9;

function modelEntry(who, modelId) {
  return MODEL_CATALOG[who]?.find(model => model.id === modelId) || null;
}

function discoveredEntry(discovery, who, modelId) {
  const provider = discovery?.providers?.[who];
  if (!provider?.ok) return null;
  return (provider.models || []).find(model => model?.id === modelId) || null;
}

function approvedSet(approvals, who) {
  const list = approvals?.[who];
  return new Set(Array.isArray(list) ? list.filter(id => typeof id === 'string' && SAFE_MODEL_ID.test(id)) : []);
}

function claudeRunnable(detected) {
  return detected?.status === 'verified' || detected?.status === 'unknown';
}

// 依代號推估能力與成本的高低：家族（Astra > Sol > Terra > Luna）優先，同家族比版本號。
// 不認得的新家族一律當成最高檔，工單才不會在你不知情時用到可能更貴的模型。
export function codexModelRank(id) {
  const text = String(id || '').toLowerCase();
  const match = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9][a-z0-9-]*))?$/.exec(text);
  const version = match ? Number(match[1]) : 0;
  const family = match?.[2] ? match[2].split('-')[0] : '';
  if (Object.hasOwn(CODEX_FAMILY_TIER, family)) return CODEX_FAMILY_TIER[family] * 1000 + version;
  if (modelEntry('codex', text)) return version; // 已知的舊款（GPT-5.5、Spark）排在各家族之後
  return UNKNOWN_TIER * 1000 + version;
}

export function modelRank(who, id) {
  if (who === 'codex') return codexModelRank(id);
  return Object.hasOwn(CLAUDE_TIER, id) ? CLAUDE_TIER[id] : UNKNOWN_TIER * 1000;
}

function modelFamily(who, id) {
  if (who !== 'codex') return '';
  const match = /^gpt-\d+(?:\.\d+)?-([a-z0-9]+)/.exec(String(id || '').toLowerCase());
  return match && Object.hasOwn(CODEX_FAMILY_TIER, match[1]) ? match[1] : '';
}

// 深度由淺到深的排名；CLI 之後才出現的新深度一律當成最深，避免工單繞過上限。
const UNKNOWN_EFFORT = 100;
function effortRank(who, effort) {
  if (effort == null || effort === '') return -1;
  const index = EFFORT_VOCABULARY[who]?.indexOf(effort) ?? -1;
  return index >= 0 ? index : UNKNOWN_EFFORT;
}

function knownEffort(who, effort) {
  return EFFORT_VOCABULARY[who]?.includes(effort) || false;
}

// effort 是否不超過上限 capEffort。兩個都是新出現的深度時無從比較，只接受完全相同。
function effortWithinCap(who, effort, capEffort) {
  const a = effortRank(who, effort);
  const b = effortRank(who, capEffort);
  if (a === UNKNOWN_EFFORT && b === UNKNOWN_EFFORT) return effort === capEffort;
  return a <= b;
}

function codexFamilyKey(id) {
  const text = String(id || '').toLowerCase();
  const match = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9][a-z0-9-]*))?$/.exec(text);
  return match ? { family: match[2] ? match[2].split('-')[0] : '', version: Number(match[1]) } : { family: text, version: 0 };
}

// 模型 id 是否不比 capId 高階。兩個都是不認得的新家族時：同家族才比版本，不同家族無從比較，一律當成超過。
function modelWithinCap(who, id, capId) {
  if (id === capId) return true;
  const top = UNKNOWN_TIER * 1000;
  const a = modelRank(who, id);
  const b = modelRank(who, capId);
  if (a >= top && b >= top) {
    if (who !== 'codex') return false;
    const x = codexFamilyKey(id);
    const y = codexFamilyKey(capId);
    return x.family === y.family && x.version <= y.version;
  }
  return a <= b;
}

function cleanEfforts(list) {
  return Array.isArray(list)
    ? [...new Set(list.filter(effort => typeof effort === 'string' && SAFE_EFFORT.test(effort)))]
    : [];
}

// Codex 每個模型支援哪些深度以 CLI 回報為準（新深度也會自動跟上）；
// Claude 的 --help 只列整體支援的深度，所以仍以內建清單為上限（例如 Haiku 不送深度）。
function effortsFor(who, catalogModel, detected) {
  if (!detected) return catalogModel ? [...catalogModel.efforts] : [];
  const reported = cleanEfforts(detected.efforts);
  if (who === 'codex' || !catalogModel) return reported;
  return catalogModel.efforts.filter(effort => reported.includes(effort));
}

// CLI 的顯示名稱是「GPT-7-Astra」，改成和內建清單一致的「GPT-7 Astra」
function prettyLabel(label) {
  return String(label || '').replace(/^(GPT-\d+(?:\.\d+)?)-(?=[A-Za-z])/, '$1 ');
}

function labelFor(who, id, discovery) {
  const known = modelEntry(who, id);
  if (known) return known.label;
  const detected = discoveredEntry(discovery, who, id);
  return prettyLabel(detected?.label || id);
}

function publicModel(model, discovery, who) {
  const provider = discovery?.providers?.[who];
  const detected = discoveredEntry(discovery, who, model.id);
  const requiresAccountVerification = who === 'claude' && provider?.ok;
  // 'unknown' = 已實際呼叫過但結果不確定（網路抖動、暫時性錯誤）。不能因此把 Claude 整個鎖死，
  // 放行後真正呼叫時若仍失敗，畫面會顯示信封裡的真正原因。從沒驗證過（cli_supported）仍然擋。
  const verified = claudeRunnable(detected);
  const selectable = model.selectable && (!provider?.ok || (!!detected && (!requiresAccountVerification || verified)));
  const efforts = effortsFor(who, model, detected);
  const missingNote = who === 'codex' && model.id === CODEX_SPARK_ID
    ? CODEX_SPARK_UNAVAILABLE_NOTE
    : '本次 CLI 偵測不到這個模型';
  const detectedNote = detected?.reason || (provider?.ok && !detected ? missingNote : '');
  const upgradeNote = detected?.upgrade && detected.upgrade !== model.id
    ? '舊世代，官方建議改用 ' + labelFor(who, detected.upgrade, discovery)
    : '';
  const note = detectedNote || upgradeNote || model.note || '';
  return {
    id: model.id,
    label: model.label,
    efforts,
    selectable,
    status: detected?.status || (provider?.ok ? (detected ? 'detected' : 'unavailable') : 'unknown'),
    ...(note ? { note } : {})
  };
}

function newModelEntry(who, detected, approved) {
  const efforts = effortsFor(who, null, detected);
  const runnable = who !== 'claude' || claudeRunnable(detected);
  const description = typeof detected.description === 'string' ? detected.description.trim().slice(0, 120) : '';
  const note = approved
    ? (runnable ? APPROVED_MODEL_NOTE : (detected.reason || '已開放，等待一次實際驗證（請按「重新檢查」）'))
    : (detected.reason || NEW_MODEL_NOTE + (description ? '。官方說明：' + description : ''));
  return {
    id: detected.id,
    label: prettyLabel(detected.label || detected.id),
    efforts,
    selectable: approved && runnable,
    status: approved ? 'approved' : 'pending',
    isNew: true,
    ...(typeof detected.defaultEffort === 'string' ? { defaultEffort: detected.defaultEffort } : {}),
    note
  };
}

// 這次真正要顯示的模型清單：內建清單 + CLI 新列出的模型（等你開放）+ 你開放過但這次不見的模型。
export function effectiveModels(who, discovery, approvals) {
  const provider = discovery?.providers?.[who];
  const approved = approvedSet(approvals, who);
  const list = (MODEL_CATALOG[who] || []).map(model => publicModel(model, discovery, who));
  const seen = new Set(list.map(model => model.id));
  if (provider?.ok) {
    for (const detected of provider.models || []) {
      const id = typeof detected?.id === 'string' ? detected.id : '';
      if (!SAFE_MODEL_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      list.push(newModelEntry(who, detected, approved.has(id)));
    }
  }
  for (const id of approved) {
    if (seen.has(id)) continue;
    list.push({
      id, label: id, efforts: [], selectable: false, status: provider?.ok ? 'unavailable' : 'unknown', isNew: true,
      note: provider?.ok ? '你開放過的模型，本次 CLI 沒有提供' : '這次沒有拿到 CLI 的模型清單，無法確認你開放的新模型'
    });
  }
  return who === 'codex' ? list.sort((a, b) => codexModelRank(b.id) - codexModelRank(a.id)) : list;
}

export function modelCatalogInfo(discovery, approvals) {
  return Object.fromEntries(PROVIDERS.map(who => [who, effectiveModels(who, discovery, approvals)]));
}

export function validateModelSelection(who, selection, discovery, approvals) {
  if (!PROVIDERS.includes(who)) {
    return { ok: false, code: 'MODEL_PROVIDER_NOT_ALLOWED', msg: '不支援這個 AI 角色' };
  }
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    return { ok: false, code: 'MODEL_SELECTION_REQUIRED', msg: '模型與思考深度沒有填完整' };
  }

  const modelId = typeof selection.model === 'string' ? selection.model.trim() : '';
  const provider = discovery?.providers?.[who];
  const catalogModel = modelEntry(who, modelId);
  const detected = discoveredEntry(discovery, who, modelId);
  let entry;
  if (catalogModel) {
    if (!catalogModel.selectable) {
      return { ok: false, code: 'MODEL_NOT_VERIFIED', msg: catalogModel.note || '這個模型尚未完成可用性確認' };
    }
    if (provider?.ok && !detected) {
      const msg = who === 'codex' && modelId === CODEX_SPARK_ID
        ? CODEX_SPARK_UNAVAILABLE_NOTE
        : '本次 CLI 偵測不到這個模型，已暫停選用';
      return { ok: false, code: 'MODEL_NOT_DETECTED', msg };
    }
    entry = publicModel(catalogModel, discovery, who);
  } else {
    const safe = SAFE_MODEL_ID.test(modelId);
    if (!safe || !approvedSet(approvals, who).has(modelId)) {
      return safe && detected
        ? { ok: false, code: 'MODEL_NOT_APPROVED', msg: '這是 CLI 新提供的模型，要先在設定裡按「開放」才能使用' }
        : { ok: false, code: 'MODEL_NOT_ALLOWED', msg: '這個模型不在安全白名單內' };
    }
    if (!detected) {
      return {
        ok: false,
        code: 'MODEL_NOT_DETECTED',
        msg: provider?.ok ? '本次 CLI 偵測不到這個模型，已暫停選用' : '這次沒有拿到 CLI 的模型清單，無法確認你開放的新模型還能用'
      };
    }
    entry = newModelEntry(who, detected, true);
  }
  if (who === 'claude' && provider?.ok && !claudeRunnable(detected)) {
    const code = detected?.status === 'unavailable' ? 'MODEL_UNAVAILABLE' : 'MODEL_NOT_VERIFIED';
    return { ok: false, code, msg: detected?.reason || '這個模型尚未完成帳號可用性驗證' };
  }

  if (selection.effort != null && typeof selection.effort !== 'string') {
    return { ok: false, code: 'MODEL_EFFORT_NOT_ALLOWED', msg: '思考深度格式不正確' };
  }
  const effort = selection.effort == null || selection.effort === '' ? null : selection.effort.trim();
  if (who === 'codex' && detected) {
    // CLI 說了算：已知的深度被拿掉、或模型改成不支援深度，都算環境變了，可以自動調整；
    // 打錯字或不認得的深度是設定本身的問題，照樣擋下，不自動替換。
    if (effort !== null && !entry.efforts.includes(effort) && !knownEffort(who, effort)) {
      return { ok: false, code: 'MODEL_EFFORT_NOT_ALLOWED', msg: entry.label + ' 不支援這個思考深度' };
    }
    if (entry.efforts.length === 0 ? effort !== null : !entry.efforts.includes(effort)) {
      return { ok: false, code: 'MODEL_EFFORT_NOT_DETECTED', msg: entry.label + ' 本次沒有偵測到這個思考深度' };
    }
  } else {
    const allowed = catalogModel ? catalogModel.efforts : entry.efforts;
    if (allowed.length === 0) {
      if (effort !== null) {
        return { ok: false, code: 'MODEL_EFFORT_NOT_SUPPORTED', msg: entry.label + ' 不支援思考深度設定' };
      }
    } else if (detected && entry.efforts.length === 0) {
      // CLI 這次表示不支援思考深度參數（例如改版拿掉了 --effort）：先不送深度，也算環境變了。
      if (effort !== null) {
        return { ok: false, code: 'MODEL_EFFORT_NOT_DETECTED', msg: entry.label + ' 這次的 CLI 不接受思考深度設定' };
      }
    } else if (!allowed.includes(effort)) {
      return { ok: false, code: 'MODEL_EFFORT_NOT_ALLOWED', msg: entry.label + ' 不支援這個思考深度' };
    }
    if (detected && effort !== null && !cleanEfforts(detected.efforts).includes(effort)) {
      return { ok: false, code: 'MODEL_EFFORT_NOT_DETECTED', msg: entry.label + ' 本次沒有偵測到這個思考深度' };
    }
  }

  return { ok: true, selection: { model: modelId, effort }, model: entry };
}

function describe(who, selection, discovery) {
  if (!selection || typeof selection.model !== 'string' || !selection.model) return '未設定的模型';
  return labelFor(who, selection.model, discovery) + (selection.effort ? '（' + selection.effort + '）' : '');
}

// 在不超過上限的深度裡，挑最接近原本設定、但不比原本更深的那個；找不到就回 undefined（這個模型不適合當替代）。
// 原本是「模型預設」（null）時，以 CLI 的預設深度或 medium 為準。不認得的新深度不會被自動挑中。
function pickEffort(who, efforts, wanted, capEffort, fallback) {
  if (!efforts.length) return null;
  const pool = capEffort === undefined ? efforts : efforts.filter(effort => effortWithinCap(who, effort, capEffort));
  if (wanted && pool.includes(wanted)) return wanted;
  const medium = effortRank(who, 'medium');
  if (!wanted && fallback && pool.includes(fallback) && effortRank(who, fallback) <= medium) return fallback;
  const target = wanted ? effortRank(who, wanted) : medium;
  const notDeeper = pool.filter(effort => knownEffort(who, effort) && effortRank(who, effort) <= target);
  if (!notDeeper.length) return undefined;
  return notDeeper.reduce((best, effort) => (effortRank(who, effort) > effortRank(who, best) ? effort : best));
}

// 原本的選擇不能用時找替代，而且絕不比原本更高階（不會更貴）：
// 同一個模型換深度 → 同家族裡不比原本新的最近一版 → 其他不比原本高階的最近一個。
// 都沒有就不替代，讓你自己決定要不要升級。工單另外受使用者上限限制。
function healSelection(who, wanted, discovery, approvals, limits = {}) {
  const wantId = typeof wanted?.model === 'string' ? wanted.model.trim() : '';
  const candidates = effectiveModels(who, discovery, approvals).filter(model =>
    model.selectable
    && modelWithinCap(who, model.id, wantId)
    && (limits.capModel === undefined || modelWithinCap(who, model.id, limits.capModel)));
  if (!candidates.length) return null;
  const family = modelFamily(who, wantId);
  const byRankDesc = (a, b) => modelRank(who, b.id) - modelRank(who, a.id);
  const ordered = [
    ...candidates.filter(model => model.id === wantId),
    ...(family ? candidates.filter(model => modelFamily(who, model.id) === family).sort(byRankDesc) : []),
    ...candidates.slice().sort(byRankDesc)
  ];
  const wantedEffort = typeof wanted?.effort === 'string' && wanted.effort ? wanted.effort : null;
  for (const model of ordered) {
    const effort = pickEffort(who, model.efforts, wantedEffort, limits.capEffort, model.defaultEffort);
    if (effort === undefined) continue;
    const result = validateModelSelection(who, { model: model.id, effort }, discovery, approvals);
    if (result.ok) return result;
  }
  return null;
}

// 回傳「這次實際要用」的模型。設定檔裡記的是你的選擇；它暫時不能用時自動找替代，
// 但不改寫你的設定，所以原本的模型恢復後會自動換回。
export function selectedModel(cfg, who) {
  const wanted = cfg?.modelSelection?.[who];
  const discovery = cfg?.modelDiscovery;
  const approvals = cfg?.modelApprovals;
  const direct = validateModelSelection(who, wanted, discovery, approvals);
  if (direct.ok || !HEALABLE_MODEL_CODES.includes(direct.code)) return direct;
  const healed = healSelection(who, wanted, discovery, approvals);
  if (!healed) {
    return { ...direct, msg: direct.msg + '，也找不到可以暫時替代、而且不比它高階的模型。請到設定改選其他模型，或按「重新檢查」' };
  }
  const name = who === 'claude' ? 'Claude' : 'Codex';
  return {
    ...healed,
    substituted: true,
    preferred: { model: String(wanted.model || ''), effort: typeof wanted.effort === 'string' ? wanted.effort : null },
    reason: direct.msg,
    notice: name + '：你設定的「' + describe(who, wanted, discovery) + '」這次不能用（' + direct.msg + '），暫時改用「'
      + describe(who, healed.selection, discovery) + '」；原本的模型恢復後會自動換回。'
  };
}

// 單張工單沒有指定時沿用全域設定，讓舊會議可以繼續執行。
// 有指定時則把全域設定視為使用者允許的最高檔：模型依 codexModelRank 比高低，
// 思考深度依 CODEX_EFFORTS 由低到高（CLI 新出現的深度視為最深）。
export function codexSelectionForAction(cfg, action) {
  const hasModel = typeof action?.codexModel === 'string' && action.codexModel.trim() !== '';
  const hasEffort = typeof action?.reasoningEffort === 'string' && action.reasoningEffort.trim() !== '';
  if (!hasModel && !hasEffort) {
    const current = selectedModel(cfg, 'codex');
    // 精簡測試或舊整合層可能把全域設定留給 adapter 注入；不在流程層
    // 改變這個既有行為。正式執行時 adapter 仍會再次驗證。
    return current.ok
      ? { ...current, source: 'global' }
      : { ok: true, selection: undefined, source: 'global' };
  }
  if (!hasModel) {
    return { ok: false, code: 'ACTION_MODEL_SELECTION_REQUIRED', msg: '這張工單的模型與思考深度沒有填完整，請重新選擇' };
  }

  const cap = selectedModel(cfg, 'codex');
  if (!cap.ok) return cap;

  const discovery = cfg?.modelDiscovery;
  const approvals = cfg?.modelApprovals;
  // 深度沒填只在「這個模型本身不支援深度」時合法，交給 validateModelSelection 判斷。
  const wanted = { model: action.codexModel, effort: hasEffort ? action.reasoningEffort : null };
  let selected = validateModelSelection('codex', wanted, discovery, approvals);
  let substitution = null;
  if (!selected.ok && HEALABLE_MODEL_CODES.includes(selected.code)) {
    const healed = healSelection('codex', wanted, discovery, approvals, {
      capModel: cap.selection.model,
      capEffort: cap.selection.effort
    });
    if (healed) {
      substitution = {
        substituted: true,
        preferred: { model: action.codexModel, effort: wanted.effort },
        reason: selected.msg,
        notice: '這張工單原本指定的「' + describe('codex', wanted, discovery) + '」這次不能用（' + selected.msg + '），改用「'
          + describe('codex', healed.selection, discovery) + '」。'
      };
      selected = healed;
    }
  }
  if (!selected.ok) return selected;

  if (!modelWithinCap('codex', selected.selection.model, cap.selection.model)) {
    return { ok: false, code: 'ACTION_MODEL_ABOVE_LIMIT', msg: '這張工單指定的模型超過目前允許的最高檔，請重新選擇' };
  }
  if (!effortWithinCap('codex', selected.selection.effort, cap.selection.effort)) {
    return { ok: false, code: 'ACTION_EFFORT_ABOVE_LIMIT', msg: '這張工單指定的思考深度超過目前允許的最高檔，請重新選擇' };
  }

  return { ...selected, source: 'action', ...(substitution || {}) };
}

// 給 Claude 規劃用：目前可以指派給工單的 Codex 模型、深度與使用者上限，全部來自即時偵測。
export function codexPlanningText(cfg) {
  const cap = selectedModel(cfg, 'codex');
  if (!cap.ok) {
    return 'Codex 模型白名單：目前沒有可用的 Codex 模型（' + cap.msg + '）。這次規劃的 Codex 工單一律標成資料不完整，不可標成可執行。';
  }
  const rows = effectiveModels('codex', cfg?.modelDiscovery, cfg?.modelApprovals)
    .filter(model => model.selectable && modelWithinCap('codex', model.id, cap.selection.model))
    .map(model => {
      const efforts = model.efforts.filter(effort => effortWithinCap('codex', effort, cap.selection.effort));
      if (model.efforts.length && !efforts.length) return '';
      return '- ' + model.id + '（' + model.label + '）：'
        + (model.efforts.length ? efforts.join('、') : '不設定思考深度（reasoningEffort 留空字串）')
        + (model.note ? '；' + model.note : '');
    })
    .filter(Boolean);
  const live = cfg?.modelDiscovery?.providers?.codex?.ok;
  return [
    'Codex 模型白名單（' + (live ? '會議室依 CLI 即時偵測' : 'CLI 這次沒有回報清單，先依內建清單') + '，已排除超過使用者上限的組合；由高到低）：',
    ...rows,
    '使用者設定的上限：' + cap.selection.model + (cap.selection.effort ? '，思考深度 ' + cap.selection.effort : '') + '。'
      + 'codexModel 只能填上面列出的代號，reasoningEffort 只能填同一行列出的深度。',
    ...(cap.substituted ? ['注意：' + cap.notice] : [])
  ].join('\n');
}

export function modelConfigInfo(cfg) {
  const current = {};
  const preferred = {};
  const errors = {};
  const notices = {};
  for (const who of PROVIDERS) {
    const result = selectedModel(cfg, who);
    const saved = cfg?.modelSelection?.[who];
    current[who] = result.ok ? result.selection : null;
    preferred[who] = saved && typeof saved === 'object' && typeof saved.model === 'string'
      ? { model: saved.model, effort: typeof saved.effort === 'string' ? saved.effort : null }
      : null;
    if (!result.ok) errors[who] = { code: result.code, msg: result.msg };
    if (result.ok && result.substituted) notices[who] = { code: 'MODEL_SUBSTITUTED', msg: result.notice, reason: result.reason };
  }
  const models = modelCatalogInfo(cfg?.modelDiscovery, cfg?.modelApprovals);
  const pendingApproval = [];
  for (const who of PROVIDERS) {
    for (const model of models[who]) {
      if (model.status === 'pending') pendingApproval.push({ provider: who, id: model.id, label: model.label, reason: model.note });
    }
  }
  return {
    current,
    preferred,
    models,
    discovery: cfg?.modelDiscovery || null,
    approvals: {
      claude: [...approvedSet(cfg?.modelApprovals, 'claude')],
      codex: [...approvedSet(cfg?.modelApprovals, 'codex')]
    },
    pendingApproval,
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(Object.keys(notices).length ? { notices } : {})
  };
}

function legacyTierSelections(cfg, who) {
  const current = selectedModel(cfg, who);
  if (!current.ok) return null;
  const efforts = current.model.efforts;
  if (!efforts.length) return { standard: current.selection };
  return {
    light: { model: current.selection.model, effort: efforts[0] },
    standard: {
      model: current.selection.model,
      effort: efforts.includes('medium') ? 'medium' : efforts[Math.floor((efforts.length - 1) / 2)]
    },
    max: { model: current.selection.model, effort: efforts[efforts.length - 1] }
  };
}

// 舊畫面仍只有 light / standard / max。這層只改目前模型的 effort，
// 不再用三個檔位暗中綁定模型；等畫面工單完成後即可移除。
export function legacyModelTierInfo(cfg) {
  const current = {};
  const tiers = {};
  for (const who of PROVIDERS) {
    const choices = legacyTierSelections(cfg, who);
    if (!choices) continue;
    tiers[who] = choices;
    const effort = selectedModel(cfg, who).selection?.effort ?? null;
    current[who] = Object.entries(choices).find(([, selection]) => selection.effort === effort)?.[0]
      || (effort === null ? 'standard' : 'max');
  }
  return { current, tiers };
}

export function selectionForLegacyTier(cfg, who, tier) {
  if (!PROVIDERS.includes(who) || !LEGACY_TIER_NAMES.includes(tier)) {
    return { ok: false, code: 'LEGACY_TIER_NOT_ALLOWED', msg: '無效的算力檔位' };
  }
  const selection = legacyTierSelections(cfg, who)?.[tier];
  if (!selection) return { ok: false, code: 'LEGACY_TIER_NOT_ALLOWED', msg: '目前模型沒有這個算力檔位' };
  return validateModelSelection(who, selection, cfg?.modelDiscovery, cfg?.modelApprovals);
}
