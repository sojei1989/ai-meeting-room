// Ollama：跑在 PC 上、經 Tailscale 過來的本機模型。目前只負責白話解釋。
// 為什麼用 fetch 不用 CLI：Ollama 本來就是 HTTP 服務，Mac 這邊不用裝任何東西。
// PC 睡著、Tailscale 斷線、模型沒拉，都會在 timeout 內回 ok:false，讓 explain() 往下退。

const DEFAULT_TIMEOUT_MS = 60_000;

function base(cfg) {
  const url = cfg && cfg.ollama && cfg.ollama.url;
  return url ? String(url).replace(/\/+$/, '') : '';
}

function signal(ms) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

function reason(error) {
  if (!error) return '原因不明';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '逾時，PC 可能睡著或 Tailscale 沒連上';
  const code = error.cause && error.cause.code;
  if (code === 'ECONNREFUSED') return 'PC 拒絕連線：Ollama 沒在跑，或 OLLAMA_HOST 還沒設成 PC 的 Tailscale IP';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return '連不到 PC：確認兩邊 Tailscale 都在線';
  return String(error.message || error);
}

// PC 上拉了哪些模型。回 { ok, models:[名字], reason }
export async function ollamaTags(cfg, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const url = base(cfg);
  if (!url) return { ok: false, models: [], reason: 'config.json 沒有設定 ollama.url' };
  try {
    const res = await fetchImpl(url + '/api/tags', { signal: signal(opts.timeoutMs || 8000) });
    if (!res.ok) return { ok: false, models: [], reason: 'HTTP ' + res.status };
    const j = await res.json();
    const models = Array.isArray(j.models) ? j.models.map(m => m.name).filter(Boolean) : [];
    return { ok: true, models, reason: models.length ? '' : 'PC 上還沒拉任何模型（ollama pull …）' };
  } catch (e) {
    return { ok: false, models: [], reason: reason(e) };
  }
}

export async function askOllama(cfg, prompt, workspace, onLog, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const url = base(cfg);
  if (!url) return { ok: false, error: 'config.json 沒有設定 ollama.url', raw: '' };
  const timeoutMs = opts.timeoutMs || cfg.ollamaTimeoutMs || DEFAULT_TIMEOUT_MS;

  let model = (cfg.ollama.model || '').trim();
  if (!model) {
    const tags = await ollamaTags(cfg, { fetch: fetchImpl });
    if (!tags.ok || !tags.models.length) return { ok: false, error: tags.reason || 'PC 上沒有可用模型', raw: '' };
    model = tags.models[0];
  }
  try {
    const res = await fetchImpl(url + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // think:false：qwen3 這類「會先想再答」的模型，不關的話回覆前面會多一大段思考過程。
      body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.3 } }),
      signal: signal(timeoutMs)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      return { ok: false, error: 'Ollama 回 HTTP ' + res.status + (detail ? '：' + detail : '') + (res.status === 404 ? '（模型 ' + model + ' 可能沒拉）' : ''), raw: '' };
    }
    const j = await res.json();
    // 舊版 Ollama 不認 think:false，就自己把 <think>…</think> 那段剪掉。
    const text = String(j.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) return { ok: false, error: 'Ollama 沒有輸出任何內容', raw: '' };
    return { ok: true, prose: text, raw: text, data: null, model };
  } catch (e) {
    return { ok: false, error: reason(e), raw: '' };
  }
}
