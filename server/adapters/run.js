import { spawn } from 'node:child_process';

// 呼叫一個 CLI，回傳 { ok, stdout, stderr, code }
export function runCli(spec, { prompt, workspace, attachDir = '', images = [], timeoutMs = 300000, onLog, env = null }) {
  let args = spec.args
    .map(a => a.replace('{PROMPT}', prompt).replace('{WORKSPACE}', workspace).replace('{ATTACH}', attachDir))
    .filter(a => a !== '');   // {ATTACH} 沒設時整個參數會變空字串，直接濾掉
  // 沒有附件目錄時，連前面的 --add-dir 旗標也要拿掉
  args = args.filter((a, i, arr) => !(a === '--add-dir' && (arr[i + 1] === undefined || arr[i + 1].startsWith('-'))));
  // Codex：圖片用 --image 附上，插在 exec 後面
  if (images.length && spec.bin === 'codex') {
    const k = args.indexOf('exec');
    const extra = images.flatMap(p => ['--image', p]);
    args = k >= 0 ? [...args.slice(0, k + 1), ...extra, ...args.slice(k + 1)] : [...extra, ...args];
  }
  const cwd = (spec.cwd || '{WORKSPACE}').replace('{WORKSPACE}', workspace);

  return new Promise(resolve => {
    let out = '', err = '', done = false;
    let child;
    try {
      // stdin 必須關掉：codex exec 一旦發現 stdin 不是終端機，
      // 就會停在「Reading additional input from stdin…」等輸入，直到逾時。
      // env 只加在這個子程序身上：例如 Gemini 的 API 金鑰，不放進伺服器自己的 process.env，其他 CLI 看不到。
      child = spawn(spec.bin, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, stdout: '', stderr: String(e), code: -1 });
    }

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, stdout: out, stderr: err + '\n[逾時] 超過 ' + (timeoutMs / 1000) + ' 秒沒有回應', code: -2 });
    }, timeoutMs);

    child.stdout.on('data', d => { out += d; if (onLog) onLog(String(d)); });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, stdout: out, stderr: '無法啟動 ' + spec.bin + '：' + e.message, code: -1 });
    });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out, stderr: err, code });
    });
  });
}

// 從輸出裡撈出 <<<JSON … JSON>>> 區塊；撈不到就回 null，並保留原文
export function extractJson(text) {
  if (!text) return { data: null, prose: '' };
  const m = text.match(/<<<JSON([\s\S]*?)JSON>>>/);
  if (!m) {
    // 退而求其次：找最後一個 { … } 區塊
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) { try { return { data: JSON.parse(brace[0]), prose: text.slice(0, brace.index).trim() }; } catch {} }
    return { data: null, prose: text.trim() };
  }
  const prose = text.slice(0, m.index).trim();
  try { return { data: JSON.parse(m[1].trim()), prose }; }
  catch (e) { return { data: null, prose: text.trim(), parseError: e.message }; }
}
