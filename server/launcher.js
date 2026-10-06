import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getPidFilePath,
  loadTemplateConfig,
  withPortableFlag,
  resolvePort,
  ensureWorkspaceMarker,
  resolveWorkspace,
  isTailscaleIp
} from './config.js';

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const ROOT_DIR = path.resolve(MODULE_DIR, '..');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const SECRET_FILE = path.join(ROOT_DIR, '.secrets', 'passcode.txt');
const PID_FILE = getPidFilePath();

const INPUT = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function logLine(text) {
  console.log(`  ${text}`);
}

function prompt(question, defaultValue = '') {
  const suffix = defaultValue ? `（留空沿用：${defaultValue}）` : '';
  return new Promise(resolve => {
    INPUT.question(`  ${question}${suffix}：`, answer => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue);
    });
  });
}

function commandExists(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0;
}

function commandVersion(name) {
  try {
    const child = spawnSync(name, ['--version'], { encoding: 'utf8' });
    if (child.error) return '未安裝';
    return typeof child.stdout === 'string' && child.stdout.trim()
      ? child.stdout.trim()
      : (child.stderr || '').trim().split('\n')[0] || '無回應';
  } catch {
    return '無法檢查';
  }
}

function getDefaultWorkspace() {
  return path.join(os.homedir(), 'Claude', 'Projects');
}

async function ensurePasscode() {
  const secretDir = path.dirname(SECRET_FILE);
  if (!fs.existsSync(secretDir)) fs.mkdirSync(secretDir, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    const isSymlink = fs.lstatSync(SECRET_FILE).isSymbolicLink();
    const content = isSymlink ? '' : fs.readFileSync(SECRET_FILE, 'utf8');
    if (!isSymlink && content.trim().length >= 8) return;
  }
  if (!process.stdin.isTTY) throw new Error('.secrets/passcode.txt 不存在或太短，而且這裡不是終端機、沒辦法問你。請在 Finder 雙擊 start.command 設定密碼。');
  console.log('');
  console.log('第一次啟動要先建立本機會議室密碼（建議 8 碼以上）');
  while (true) {
    const first = await prompt('  請輸入登入密碼（至少 8 碼）');
    const second = await prompt('  再輸入一次確認');
    if (first.length < 8) {
      console.log('  密碼太短，請至少 8 個字元。');
      continue;
    }
    if (first !== second) {
      console.log('  兩次輸入不同，請再試一次。');
      continue;
    }
    fs.writeFileSync(SECRET_FILE, first + '\n', { mode: 0o600 });
    fs.chmodSync(SECRET_FILE, 0o600);
    console.log('  已建立 passcode，放在 .secrets/passcode.txt');
    return;
  }
}

function validateWorkspace(value) {
  if (!value) return false;
  return fs.existsSync(value) && fs.statSync(value).isDirectory();
}

function validateTailscaleIp(value) {
  if (!value) return true;
  return isTailscaleIp(value);
}

function isOwnServerPid(pid) {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return false;
    const cmd = result.stdout.toString().trim();
    return cmd.includes('node') && cmd.includes(path.join('server', 'index.js'));
  } catch {
    return false;
  }
}

function stopPreviousServer() {
  if (!fs.existsSync(PID_FILE)) return;
  const pidText = fs.readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number(pidText);
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (!isOwnServerPid(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

// 精靈只在「config.json 不存在或壞掉」時出現。
// 以前的版本用「有沒有你的 Tailscale 位址／家目錄」來判斷要不要跑精靈，結果在你自己這台每次啟動都跑，
// 而且程式裡有個沒宣告的變數（raw）讓讀檔一定失敗、退回範本，再把範本寫回去——
// 等於每次「重新開始」都會停在終端機等你打字，還會把你的模型、Ollama、Gemini 設定全部洗掉。
// 現在：有合法的 config.json 就原封不動直接用；沒有才問，而且問不到人（不是終端機）就明講並退出，不掛著。
async function ensureConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      logLine('config.json 讀不出來（' + (error?.message || error) + '），先備份成 config.broken.json 再重新設定。');
      try { fs.copyFileSync(CONFIG_FILE, path.join(ROOT_DIR, 'config.broken.json')); } catch {}
    }
  }

  if (!process.stdin.isTTY) {
    throw new Error('找不到 config.json，而且這裡不是終端機、沒辦法問你。請在 Finder 雙擊 start.command 完成第一次設定。');
  }

  const template = loadTemplateConfig();
  logLine('首次啟動精靈：這台電腦還沒有設定檔，問你兩個問題就好');
  // 不自動沿用任何預設資料夾：一律問一次，存在的預設路徑只當建議值。
  const suggested = getDefaultWorkspace();
  let workspace = resolveWorkspace(await prompt('請輸入你的「工作資料夾」絕對路徑（你最常用的專案放這裡）', validateWorkspace(suggested) ? suggested : ''));
  while (!validateWorkspace(workspace)) {
    workspace = resolveWorkspace(await prompt('找不到這個資料夾，請再輸入一次絕對路徑'));
  }
  let tailscale = await prompt('請輸入 Tailscale 入口 IP（可留空，不開手機入口）', '');
  while (!validateTailscaleIp(tailscale)) {
    tailscale = await prompt('Tailscale IP 要是 100.64.x.x 到 100.127.x.x 之間的位址，或留空', '');
  }

  let cfg = {
    ...template,
    workspace: ensureWorkspaceMarker(ROOT_DIR, workspace),
    listen: { ...template.listen, tailscale }
  };
  cfg = withPortableFlag(cfg, { configured: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  logLine('已寫入你的專屬設定到 config.json');
  return cfg;
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function cleanPid() {
  if (!fs.existsSync(PID_FILE)) return;
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function checkTools() {
  console.log('');
  console.log('環境檢查：');
  console.log(`  Node.js：${commandExists('node') ? commandVersion('node') : '未安裝'}`);
  console.log(`  Git：${commandExists('git') ? commandVersion('git') : '未安裝'}`);
  console.log(`  Claude CLI：${commandExists('claude') ? commandVersion('claude') : '未安裝'}`);
  console.log(`  Codex CLI：${commandExists('codex') ? commandVersion('codex') : '未安裝'}`);
}

function startServer(cfg) {
  const port = resolvePort(cfg.port);
  const server = spawn(process.execPath, [path.join(MODULE_DIR, 'index.js')], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      MEETING_ROOM_PORT: String(port)
    }
  });
  writePid(server.pid);
  const onExit = code => {
    cleanPid();
    process.exit(code == null ? 0 : code);
  };
  server.on('exit', onExit);
  server.on('error', onExit);
  process.once('SIGINT', () => {
    server.kill('SIGINT');
  });
}

(async () => {
  try {
    stopPreviousServer();
    const cfg = await ensureConfig();
    await ensurePasscode();
    checkTools();
    INPUT.close();
    logLine(`工作路徑：${cfg.workspace || '(未設定)'}`);
    if (!cfg.workspace || !cfg.listen?.tailscale) {
      logLine('手機入口：未設定 Tailscale，先用本機位址啟動。');
    } else {
      logLine(`Tailscale：${cfg.listen.tailscale}`);
    }
    startServer(cfg);
  } catch (error) {
    cleanPid();
    console.error('啟動精靈發生錯誤：' + (error?.message || String(error)));
    process.exit(1);
  }
})();
