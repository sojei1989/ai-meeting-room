// claude -p --output-format json 失敗時，stdout 仍是一個 JSON 信封，
// 真正的原因在 result／error／api_error_status 這幾個欄位，而且常常排在很後面。
// 以前直接把整段 stdout 截前 500 字當原因，結果只看到 usage 統計，看不到為什麼失敗。
export function parseClaudeEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const env = JSON.parse(text);
    return env && typeof env === 'object' && !Array.isArray(env) ? env : null;
  } catch {
    return null;
  }
}

function pick(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string') return value.message.trim();
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

// 回傳「人看得懂的失敗原因」；信封不是錯誤時回空字串。
export function claudeEnvelopeError(env) {
  if (!env) return '';
  const failed = env.is_error === true || (typeof env.subtype === 'string' && env.subtype.startsWith('error'));
  if (!failed) return '';
  const parts = [];
  const main = pick(env.result) || pick(env.error);
  if (main) parts.push(main);
  if (Array.isArray(env.errors)) parts.push(...env.errors.map(pick).filter(Boolean));
  if (env.api_error_status != null) parts.push('API 狀態碼 ' + env.api_error_status);
  if (env.subtype && env.subtype !== 'success') parts.push('類型 ' + env.subtype);
  return [...new Set(parts)].join('；') || 'Claude 回報失敗，但沒有附上原因（類型 ' + (env.subtype || '未知') + '）';
}

// 把失敗原因分類，讓畫面能講人話。
export function classifyClaudeError(reason) {
  const text = String(reason || '');
  if (/not logged in|please run \/login|invalid api key|authentication|oauth|401|unauthori[sz]ed|credential|keychain/i.test(text)) return 'auth';
  if (/usage limit|rate limit|429|overloaded|529|quota|credit balance/i.test(text)) return 'limit';
  if (/invalid model|model .*not (found|available)|does not have access|not available|permission|無權|不可用|404/i.test(text)) return 'unavailable';
  if (/ETIMEDOUT|timed out|timeout|ENOTFOUND|ECONNRE|network|fetch failed|socket/i.test(text)) return 'network';
  return 'other';
}

export function claudeErrorHint(kind) {
  return {
    auth: '（Claude 沒有登入或登入過期：在 Mac 終端機執行 claude，輸入 /login 重新登入後，按「重新偵測模型」。）',
    limit: '（Claude 用量已達上限或伺服器忙碌，稍後再按「重新偵測模型」。）',
    network: '（連線逾時或網路中斷，確認網路後按「重新偵測模型」。）',
    unavailable: '',
    other: ''
  }[kind] || '';
}
