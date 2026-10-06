import path from 'node:path';
import { runCli } from './run.js';
import { readSecretFile } from '../notify.js';

// Gemini 只負責一件事：白話解釋（explain）。
// 為什麼獨立一個 adapter：它不需要 JSON 契約，只要純文字；也不給它任何工具，純翻譯。
// CLI 參數在 config.json 的 gemini 區塊，改版時改那裡。
//
// 登入方式：2026-06-18 起 gemini CLI 的「Sign in with Google」對個人帳號已停用（會被導去 Antigravity），
// 所以這裡走 API 金鑰：金鑰放 .secrets/gemini-api-key.txt，只在啟動 gemini 這個子程序時
// 以 GEMINI_API_KEY 環境變數塞給它，不進伺服器的 process.env、不進 log、不進會議紀錄。

export const KEY_FILE = 'gemini-api-key.txt';

function readKey(cfg) {
  if (!cfg || !cfg.secretsDir) return '';
  const key = readSecretFile(path.join(cfg.secretsDir, KEY_FILE));
  return /^[A-Za-z0-9_-]{20,}$/.test(key) ? key : '';
}

export function geminiKeyPresent(cfg) { return !!readKey(cfg); }

// 給 runCli 的 env；沒有金鑰就回 null（讓 CLI 用它自己快取的登入，如果還有的話）。
export function geminiEnv(cfg) {
  const key = readKey(cfg);
  return key ? { GEMINI_API_KEY: key } : null;
}

export async function askGemini(cfg, prompt, workspace, onLog, opts = {}) {
  const spec = cfg.gemini;
  if (!spec || !spec.bin) return { ok: false, error: 'config.json 沒有設定 gemini', raw: '', code: -1, stderr: '' };
  const timeoutMs = opts.timeoutMs || cfg.explainTimeoutMs || 90_000;
  const env = geminiEnv(cfg);
  const key = env ? env.GEMINI_API_KEY : '';
  const redact = s => key ? String(s || '').split(key).join('[gemini-key]') : String(s || '');
  const r = await runCli(spec, { prompt, workspace, timeoutMs, onLog, env });
  if (!r.ok) {
    const hint = !env ? '（沒有 .secrets/' + KEY_FILE + '，而 Google 登入已停用）' : '';
    return { ok: false, error: redact(r.stderr || ('gemini 結束碼 ' + r.code)) + hint, raw: redact(r.stdout), code: r.code, stderr: redact(r.stderr) };
  }
  // gemini CLI 偶爾會在 stdout 前面多印一行「Loaded cached credentials.」之類的狀態，濾掉。
  const text = String(r.stdout || '')
    .split('\n')
    .filter(line => !/^(Loaded cached credentials|Data collection is disabled|YOLO mode)/i.test(line.trim()))
    .join('\n').trim();
  if (!text) return { ok: false, error: 'gemini 沒有輸出任何內容', raw: '', code: r.code, stderr: redact(r.stderr) };
  return { ok: true, prose: redact(text), raw: redact(text), data: null, stderr: redact(r.stderr) };
}
