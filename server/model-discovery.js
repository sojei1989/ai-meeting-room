import { spawnSync } from 'node:child_process';
import { parseClaudeEnvelope, claudeEnvelopeError, classifyClaudeError, claudeErrorHint } from './adapters/claude-envelope.js';

const TIMEOUT_MS = 20_000;
const DEFAULT_CLAUDE_CANDIDATES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);

function failure(source, detectedAt, result, fallback) {
  const detail = result?.error?.message || result?.stderr || result?.stdout || fallback;
  return {
    ok: false,
    source,
    detectedAt,
    models: [],
    efforts: [],
    reason: String(detail || '指令沒有回傳可辨識的資料').trim().slice(0, 500)
  };
}

function run(exec, bin, args, source, detectedAt) {
  try {
    const result = exec(bin, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    if (result?.error || result?.status !== 0) return failure(source, detectedAt, result, '指令執行失敗');
    return { ok: true, source, detectedAt, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    return failure(source, detectedAt, { error }, '指令執行失敗');
  }
}

export function parseCodexModels(text) {
  // 前面可能夾著 CLI 的警告文字；JSON 也可能被排版過，所以用「{ 後面接 "models"」找起點。
  const start = String(text || '').search(/\{\s*"models"\s*:/);
  if (start < 0) throw new Error('Codex 沒有回傳模型目錄');
  const parsed = JSON.parse(text.slice(start));
  if (!Array.isArray(parsed.models)) throw new Error('Codex 模型目錄格式不正確');
  return parsed.models
    .filter(model => model && model.visibility === 'list' && typeof model.slug === 'string')
    .map(model => ({
      id: model.slug,
      label: typeof model.display_name === 'string' ? model.display_name : model.slug,
      efforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map(level => level?.effort).filter(Boolean)
        : [],
      // 下面幾欄是 CLI 額外提供的線索：預設深度、官方建議的升級對象、清單排序與一句說明。
      ...(typeof model.default_reasoning_level === 'string' ? { defaultEffort: model.default_reasoning_level } : {}),
      ...(typeof model.upgrade?.model === 'string' ? { upgrade: model.upgrade.model } : {}),
      ...(Number.isFinite(model.priority) ? { priority: model.priority } : {}),
      ...(typeof model.description === 'string' && model.description ? { description: model.description.slice(0, 200) } : {})
    }));
}

export function parseClaudeHelp(text) {
  const modelLine = text.match(/--model <model>[\s\S]*?(?=\n\s*(?:-\w|--[a-z])|$)/i)?.[0] || '';
  const examples = [...modelLine.matchAll(/(?:'|\b)(fable|opus|sonnet|haiku)(?:'|\b)/gi)]
    .map(match => match[1].toLowerCase());
  const effortMatch = text.match(/--effort <level>[\s\S]*?\(([^)]+)\)/i);
  const efforts = effortMatch
    ? effortMatch[1].split(',').map(item => item.trim()).filter(Boolean)
    : [];
  return {
    aliases: [...new Set(examples)],
    efforts,
    supports: {
      modelParameter: /--model <model>/i.test(text),
      effortParameter: /--effort <level>/i.test(text)
    }
  };
}

function claudeAttempt(exec, bin, id, detectedAt) {
  const args = [
    '-p', '--model', id, '--output-format', 'json', '--no-session-persistence',
    '這是模型可用性驗證，請只回覆 OK。'
  ];
  let result;
  try {
    result = exec(bin, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
  const env = parseClaudeEnvelope(result?.stdout);
  const envelopeError = claudeEnvelopeError(env);
  if (!result?.error && result?.status === 0 && !envelopeError) return { ok: true };
  // 原因優先順序：啟動錯誤（含逾時）→ 信封裡的錯誤 → stderr → 其他輸出。
  // 不再把整段 JSON 信封當原因：那樣只會看到 usage 統計，真正原因被截掉。
  const reason = String(
    result?.error?.message
    || envelopeError
    || String(result?.stderr || '').trim()
    || (env ? 'Claude 結束碼 ' + result?.status + '，但沒有附上原因' : String(result?.stdout || '').trim())
    || 'Claude 結束碼 ' + result?.status
  ).trim().slice(0, 500);
  return { ok: false, reason };
}

function claudeValidation(exec, bin, id, detectedAt) {
  const validation = { attempted: true, consumesQuota: true, verifiedAt: detectedAt };
  let attempt = claudeAttempt(exec, bin, id, detectedAt);
  // 網路抖動、剛開機鑰匙圈還沒解鎖這類暫時性失敗，重試一次再下結論。
  if (!attempt.ok && !['unavailable', 'auth'].includes(classifyClaudeError(attempt.reason))) {
    attempt = claudeAttempt(exec, bin, id, detectedAt);
  }
  if (attempt.ok) {
    return { status: 'verified', reason: '帳號已完成實際呼叫驗證', validation };
  }
  const kind = classifyClaudeError(attempt.reason);
  if (kind === 'unavailable') {
    return { status: 'unavailable', reason: '帳號實際驗證為目前不可用：' + attempt.reason, validation };
  }
  return {
    status: 'unknown',
    errorKind: kind,
    reason: '實際驗證失敗，仍無法判定：' + attempt.reason + claudeErrorHint(kind),
    validation
  };
}

export function discoverModels(options = {}) {
  const exec = options.exec || spawnSync;
  const detectedAt = (options.now || (() => new Date()))().toISOString();
  const codexSource = 'codex debug models';
  const claudeSource = 'claude --help';
  const codexRun = run(exec, options.codexBin || 'codex', ['debug', 'models'], codexSource, detectedAt);
  const claudeVersionRun = run(exec, options.claudeBin || 'claude', ['--version'], 'claude --version', detectedAt);
  const claudeRun = run(exec, options.claudeBin || 'claude', ['--help'], claudeSource, detectedAt);

  let codex = codexRun;
  if (codexRun.ok) {
    try {
      const models = parseCodexModels(codexRun.stdout);
      codex = { ok: true, source: codexSource, detectedAt, models, efforts: [...new Set(models.flatMap(model => model.efforts))], reason: '' };
    } catch (error) {
      codex = failure(codexSource, detectedAt, { error }, 'Codex 模型資料無法解析');
    }
  }

  let claude = claudeRun;
  if (claudeRun.ok) {
    try {
      const parsed = parseClaudeHelp(claudeRun.stdout);
      if (!parsed.supports.modelParameter) throw new Error('Claude 說明沒有模型參數');
      const candidates = [...new Set(options.claudeCandidates || DEFAULT_CLAUDE_CANDIDATES)];
      const verify = new Set(options.verifyClaudeModels || []);
      const models = candidates.map(id => {
        const base = {
          id,
          label: id[0].toUpperCase() + id.slice(1),
          efforts: parsed.supports.effortParameter ? parsed.efforts : [],
          status: 'cli_supported',
          reason: 'CLI 支援模型參數，但帳號尚未實際驗證',
          validation: { attempted: false, consumesQuota: false }
        };
        return verify.has(id)
          ? { ...base, ...claudeValidation(exec, options.claudeBin || 'claude', id, detectedAt) }
          : base;
      });
      claude = {
        ok: true,
        source: claudeSource,
        detectedAt,
        cliVersion: claudeVersionRun.ok ? claudeVersionRun.stdout.trim().slice(0, 200) : '',
        versionReason: claudeVersionRun.ok ? '' : claudeVersionRun.reason,
        aliases: parsed.aliases,
        supports: parsed.supports,
        efforts: parsed.efforts,
        models,
        reason: ''
      };
    } catch (error) {
      claude = failure(claudeSource, detectedAt, { error }, 'Claude 模型資料無法解析');
      claude.cliVersion = claudeVersionRun.ok ? claudeVersionRun.stdout.trim().slice(0, 200) : '';
      claude.versionReason = claudeVersionRun.ok ? '' : claudeVersionRun.reason;
    }
  }

  return Object.freeze({ detectedAt, providers: Object.freeze({ claude, codex }) });
}
