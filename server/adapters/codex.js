import { runCli, extractJson } from './run.js';
import { codexSelectionForAction, selectedModel, HEALABLE_MODEL_CODES } from '../model-config.js';

// Codex 自己回報「這個模型不能用」的常見說法。只看錯誤輸出（stderr），
// 不看模型回答的內容，避免回答裡剛好提到這些字就誤判。
const MODEL_REJECTED = /model[^\n]{0,120}?(?:is not supported|not supported|does not exist|not found|unsupported|is not available|not available|no access|deprecated|retired)|model_not_found|unknown model|invalid model/i;

export function looksLikeModelRejection(stderr) {
  return MODEL_REJECTED.test(String(stderr || ''));
}

// 會議室提供的「需要時重新偵測模型」；單獨測試 adapter 時沒有這個功能就略過。
function refreshModels(cfg, force = false) {
  try {
    return typeof cfg?.ensureModelsFresh === 'function' ? !!cfg.ensureModelsFresh({ force }) : false;
  } catch {
    return false;
  }
}

export function codexSpec(cfg, mode, selection) {
  const selected = selection
    ? codexSelectionForAction(cfg, {
        codexModel: selection.model,
        reasoningEffort: selection.effort
      })
    : selectedModel(cfg, 'codex');
  if (!selected.ok) return selected;
  const base = mode === 'write' ? cfg.codexWrite : cfg.codexRead;
  const args = [...base.args];
  const at = args.indexOf('{PROMPT}');
  const extra = ['--model', selected.selection.model];
  if (selected.selection.effort) extra.push('-c', 'model_reasoning_effort=' + selected.selection.effort);
  args.splice(at >= 0 ? at : args.length, 0, ...extra);
  return {
    ok: true,
    spec: { ...base, args },
    selection: selected.selection,
    ...(selected.substituted ? { notice: selected.notice } : {})
  };
}

export async function askCodex(cfg, prompt, workspace, mode, onLog, opts = {}) {
  refreshModels(cfg);
  let prepared = codexSpec(cfg, mode, opts.selection);
  // 偵測結果可能剛好過期：強制重抓一次再判斷，抓完還是不行才回報失敗。
  if (!prepared.ok && HEALABLE_MODEL_CODES.includes(prepared.code) && refreshModels(cfg, true)) {
    prepared = codexSpec(cfg, mode, opts.selection);
  }
  if (!prepared.ok) return { ok: false, error: prepared.msg, raw: '', code: -1, stderr: prepared.msg };
  if (prepared.notice && onLog) onLog('[會議室] ' + prepared.notice + '\n');
  const allowed = Array.isArray(opts.approvedWritePaths) ? opts.approvedWritePaths : [];
  const scopedPrompt = mode === 'write' && allowed.length
    ? prompt + '\n\n系統已記錄本工單唯一允許修改的相對路徑：\n' + allowed.map(p => '- ' + p).join('\n')
      + '\n不得修改、新增、刪除或重新命名其他路徑；執行後系統會用 Git 實際差異檢查並自動回復越界工單。'
    : prompt;
  const r = await runCli(prepared.spec, { prompt: scopedPrompt, workspace, timeoutMs: cfg.timeoutMs, onLog, attachDir: cfg.attachDir || '', images: opts.images || [] });
  if (!r.ok) {
    const failure = { ok: false, error: r.stderr || ('codex 結束碼 ' + r.code), raw: r.stdout || '', code: r.code, stderr: r.stderr || '' };
    // Codex 拒絕了這個模型：重新偵測一次。換得到別的模型時，唯讀工作直接重試一次；
    // 會改檔的工單不自動重跑（避免重複動手），改成提示你按「重試」。
    if (opts.modelRetry !== false && looksLikeModelRejection(r.stderr) && refreshModels(cfg, true)) {
      const next = codexSpec(cfg, mode, opts.selection);
      const changed = next.ok && (next.selection.model !== prepared.selection.model || next.selection.effort !== prepared.selection.effort);
      if (changed && mode !== 'write') {
        if (onLog) onLog('[會議室] Codex 不接受 ' + prepared.selection.model + '，已重新偵測模型並改用 ' + next.selection.model + ' 重試一次\n');
        return askCodex(cfg, prompt, workspace, mode, onLog, { ...opts, modelRetry: false });
      }
      if (changed) failure.error += '\n\n（會議室已重新偵測模型，下次會改用 ' + next.selection.model + '，按「重試」即可。）';
    }
    return failure;
  }
  const { data, prose, parseError } = extractJson(r.stdout);
  return { ok: true, data, prose, raw: r.stdout, parseError, stderr: r.stderr };
}
