import { runCli, extractJson } from './run.js';
import { selectedModel } from '../model-config.js';
import { parseClaudeEnvelope, claudeEnvelopeError, classifyClaudeError, claudeErrorHint } from './claude-envelope.js';

export function claudeSpec(cfg) {
  const selected = selectedModel(cfg, 'claude');
  if (!selected.ok) return selected;
  const args = [...cfg.claude.args];
  const at = args.indexOf('{PROMPT}');
  const extra = ['--model', selected.selection.model];
  if (selected.selection.effort) extra.push('--effort', selected.selection.effort);
  args.splice(at >= 0 ? at : args.length, 0, ...extra);
  return {
    ok: true,
    spec: { ...cfg.claude, args },
    selection: selected.selection,
    ...(selected.substituted ? { notice: selected.notice } : {})
  };
}

// claude -p --output-format json 會回一個 JSON 信封，真正的答案在 .result
function unwrap(stdout) {
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === 'string') return env.result;
    if (env && typeof env.text === 'string') return env.text;
  } catch {}
  return stdout;
}

export async function askClaude(cfg, prompt, workspace, onLog, opts = {}) {
  // 開工前順便確認 CLI 有沒有改版（最多每幾分鐘一次，由會議室決定要不要真的重抓）。
  try { if (typeof cfg?.ensureModelsFresh === 'function') cfg.ensureModelsFresh(); } catch {}
  const prepared = claudeSpec(cfg);
  if (!prepared.ok) return { ok: false, error: prepared.msg, raw: '', code: -1, stderr: prepared.msg };
  if (prepared.notice && onLog) onLog('[會議室] ' + prepared.notice + '\n');
  const r = await runCli(prepared.spec, { prompt, workspace, timeoutMs: cfg.timeoutMs, onLog, attachDir: cfg.attachDir || '', images: opts.images || [] });
  const envelopeError = claudeEnvelopeError(parseClaudeEnvelope(r.stdout));
  if (!r.ok || envelopeError) {
    // 失敗時把信封裡的真正原因放進 stderr，畫面「錯誤輸出」才看得到，不會只剩 usage 統計。
    const reason = envelopeError
      ? envelopeError + claudeErrorHint(classifyClaudeError(envelopeError))
      : (r.stderr || ('claude 結束碼 ' + r.code));
    const stderr = [envelopeError ? reason : '', r.stderr || ''].filter(Boolean).join('\n');
    return { ok: false, error: reason, raw: envelopeError ? '' : (r.stdout || ''), code: r.code === 0 ? 1 : r.code, stderr };
  }
  const text = unwrap(r.stdout);
  const { data, prose, parseError } = extractJson(text);
  return { ok: true, data, prose, raw: text, parseError, stderr: r.stderr };
}
