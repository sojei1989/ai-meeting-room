// Telegram 通知 —— AI 跑完一輪、要你決定、或出錯時，把一句話推到你手機。
//
// 三條鐵律：
//   1. token 與 chat id 只從 .secrets/ 讀，讀法跟密碼檔一樣嚴（不是一般檔案、是捷徑、空白 → 視為未設定）。
//   2. token 的內容永遠不出現在 log、錯誤訊息、會議紀錄或回傳給畫面的 JSON。
//      Telegram 的 API 網址本身就含 token，所以任何錯誤訊息在印出前都先 redact()。
//   3. 通知失敗不影響會議：這裡的任何錯誤都吞掉，只印一行不含機密的原因。

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SECRET_BYTES = 512;
const DEFAULT_THROTTLE_MS = 6000;     // 同一類事情六秒內只推一次，跟畫面提示音一致
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TEXT = 1200;                // Telegram 上限 4096，這裡再保守一點

export const TOKEN_FILE = 'telegram-token.txt';
export const CHAT_ID_FILE = 'telegram-chat-id.txt';

const KINDS = {
  decide: '🟡 需要你決定',
  done:   '🟢 Codex 做完了',
  error:  '🔴 出錯了',
  test:   '🔔 通知測試',
  info:   'ℹ️ 會議室'
};

// 跟 auth.js 的 loadPasscodeDigest 同一套防護：不跟捷徑、確認開到的就是看到的那個檔。
// 也給 adapters/gemini.js 讀 API 金鑰用。
export function readSecretFile(file) {
  let fd;
  try {
    const parentBefore = lstatSync(path.dirname(file));
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return '';
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const visible = lstatSync(file);
    const parentAfter = lstatSync(path.dirname(file));
    if (!opened.isFile() || visible.isSymbolicLink()
      || opened.dev !== visible.dev || opened.ino !== visible.ino
      || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino
      || opened.size < 1 || opened.size > MAX_SECRET_BYTES) return '';
    return readFileSync(fd, 'utf8').trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

// 回傳 { ok, token, chatId, reason }。reason 只會提到檔名，不提內容。
export function loadTelegramSecrets(secretsDir) {
  const token = readSecretFile(path.join(secretsDir, TOKEN_FILE));
  const chatId = readSecretFile(path.join(secretsDir, CHAT_ID_FILE));
  const missing = [];
  if (!token) missing.push('缺 .secrets/' + TOKEN_FILE);
  else if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) missing.push('.secrets/' + TOKEN_FILE + ' 格式不像 Telegram bot token');
  if (!chatId) missing.push('缺 .secrets/' + CHAT_ID_FILE);
  else if (!/^-?\d{1,20}$/.test(chatId)) missing.push('.secrets/' + CHAT_ID_FILE + ' 應該只有數字');
  if (missing.length) return { ok: false, token: '', chatId: '', reason: missing.join('；') };
  return { ok: true, token, chatId, reason: '' };
}

export function composeMessage(kind, text, meta = {}) {
  const head = KINDS[kind] || KINDS.info;
  const body = String(text || '').trim();
  const goal = String(meta.goal || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  const lines = [head];
  if (body) lines.push(body);
  if (goal) lines.push('— ' + goal.slice(0, 60));
  return lines.join('\n').slice(0, MAX_TEXT);
}

export function createNotifier(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const throttleMs = Number.isFinite(options.throttleMs) ? options.throttleMs : DEFAULT_THROTTLE_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const log = typeof options.log === 'function' ? options.log : (line => console.error(line));
  const secrets = options.secrets || loadTelegramSecrets(options.secretsDir || '');
  const lastSent = new Map();

  // 任何要印出來的字串都先過這裡：把 token 換掉，順便把「bot<token>」網址形式也蓋掉。
  function redact(value) {
    let s = String(value == null ? '' : value);
    if (secrets.token) s = s.split(secrets.token).join('[token]');
    return s.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[token]');
  }

  async function notify(kind, text, meta = {}) {
    if (!secrets.ok) return { ok: false, skipped: 'unconfigured', reason: secrets.reason };
    if (typeof fetchImpl !== 'function') return { ok: false, skipped: 'nofetch', reason: '這個 Node 沒有 fetch' };
    const t = now();
    const last = lastSent.get(kind);
    if (!meta.force && last !== undefined && t - last < throttleMs) return { ok: false, skipped: 'throttled' };
    lastSent.set(kind, t);

    const message = redact(composeMessage(kind, text, meta));
    try {
      const res = await fetchImpl('https://api.telegram.org/bot' + secrets.token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: secrets.chatId, text: message, disable_web_page_preview: true }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      });
      if (!res || !res.ok) {
        const status = res ? res.status : 0;
        const reason = status === 401 ? 'token 不被 Telegram 接受（401）'
          : status === 400 ? 'chat id 可能不對，或你還沒對機器人按過 Start（400）'
          : status === 429 ? '推太密被 Telegram 限速（429）'
          : 'HTTP ' + status;
        log('  Telegram 通知失敗：' + reason);
        return { ok: false, status, reason };
      }
      return { ok: true };
    } catch (error) {
      const reason = redact(error && error.name === 'TimeoutError' ? '連不上 Telegram（逾時）' : (error && error.message || error));
      log('  Telegram 通知失敗：' + reason);
      return { ok: false, reason };
    }
  }

  return { configured: secrets.ok, reason: secrets.reason, notify, redact };
}
