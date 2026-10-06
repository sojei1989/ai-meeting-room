import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  closeSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';
import * as WSX from './workspace.js';
import { CAPABILITIES } from './capabilities.js';
import { isTailscaleIp, isLoopbackHost } from './config.js';
import { createAuthService } from './auth.js';
import { createNotifier } from './notify.js';
import {
  legacyModelTierInfo,
  modelConfigInfo,
  selectionForLegacyTier,
  validateModelSelection,
  MODEL_CATALOG,
  SAFE_MODEL_ID
} from './model-config.js';
import { discoverModels } from './model-discovery.js';
import {
  collectRegisteredAssetPaths,
  collectRegisteredAttachmentPaths,
  openRegisteredFile,
  resolveDeliverableUpload,
  resolveWritablePath,
  resolveContainedFile
} from './safe-path.js';

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const ROOT = path.resolve(MODULE_DIR, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const MAX_API_BODY_BYTES = 260 * 1024 * 1024;
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};
const BUILD_NUMBER = 26;

// 一份共用的 MIME 對照表。以前三個地方各自維護一份，
// 結果音檔在靜態路徑被當成不明二進位檔送出，瀏覽器不會播。
const MIME = {
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.avif':'image/avif', '.ico':'image/x-icon',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac',
  '.ogg':'audio/ogg', '.oga':'audio/ogg', '.flac':'audio/flac',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.m4v':'video/mp4',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.woff2':'font/woff2', '.pdf':'application/pdf',
  '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8', '.json':'application/json',
};
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// HTML、SVG 這類會執行腳本的檔案，若用會議室同一個來源直接打開，就能借用你的登入身分呼叫 API
// （例如代替你按核准）。附件與交件一律改成下載並加上 sandbox，圖片、PDF、影音照常預覽。
const ACTIVE_CONTENT_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs']);
function untrustedFileHeaders(filePath) {
  if (!ACTIVE_CONTENT_EXT.has(path.extname(filePath).toLowerCase())) return {};
  const downloadName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'download';
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Content-Security-Policy': 'sandbox'
  };
}
const FIXED_UI_ASSETS = new Set([
  'assets/avatar-claude.png',
  'assets/avatar-codex.png',
  'assets/avatar-tool.png',
  'assets/avatar-user.png',
  'assets/sfx/yes-my-lord.mp3'
]);
function cacheHeaderForAsset(requestedPath) {
  return FIXED_UI_ASSETS.has(requestedPath) ? 'private, max-age=3600' : 'no-store';
}

function hostnameFromHostHeader(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL('http://' + value.trim());
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function isSameOriginPost(req) {
  if (req.method !== 'POST' || req.headers.origin == null) return true;
  if (typeof req.headers.origin !== 'string' || typeof req.headers.host !== 'string') return false;
  try {
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    const requestOrigin = new URL(protocol + '//' + req.headers.host).origin;
    return new URL(req.headers.origin).origin === requestOrigin;
  } catch {
    return false;
  }
}

function hasJsonContentType(req) {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string'
    && contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function json(res, code, data, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    ...SECURITY_HEADERS
  });
  res.end(payload);
}

function empty(res, code, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(code, {
    'Content-Length': '0',
    'Cache-Control': 'no-store',
    ...headers,
    ...SECURITY_HEADERS
  });
  res.end();
}

function sendFile(res, file, cacheControl = 'no-store', extraHeaders = {}) {
  let size;
  try { size = statSync(file).size; }
  catch { return empty(res, 404); }
  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Content-Length': size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    ...SECURITY_HEADERS
  });
  const stream = createReadStream(file);
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

function sendOpenFile(res, opened, cacheControl = 'no-store', extraHeaders = {}) {
  let fdClosed = false;
  try {
    if (!opened?.fd || !opened.path || typeof opened.size !== 'number') return empty(res, 404);
    res.writeHead(200, {
      'Content-Type': mimeOf(opened.path),
      'Content-Length': opened.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
      ...SECURITY_HEADERS
    });
    const stream = createReadStream(null, { fd: opened.fd, autoClose: false });
    stream.once('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    stream.once('close', () => {
      if (!fdClosed) {
        fdClosed = true;
        try { closeSync(opened.fd); } catch {}
      }
    });
    res.once('finish', () => {
      if (!fdClosed) {
        fdClosed = true;
        try { closeSync(opened.fd); } catch {}
      }
    });
    stream.pipe(res);
  } catch {
    if (!fdClosed) {
      fdClosed = true;
      try { closeSync(opened.fd); } catch {}
    }
    return empty(res, 404);
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        const error = new Error('request too large');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text || '{}'));
      } catch {
        const error = new Error('invalid JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export function createMeetingRoomApp(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const configFile = options.configFile || path.join(root, 'config.json');
  const cfg = options.config || JSON.parse(readFileSync(configFile, 'utf8'));
  const workspaceRoot = path.resolve(options.workspaceRoot || options.workspace || path.resolve(root, cfg.workspaceRoot || cfg.workspace));
  const requestedProject = path.resolve(options.activeProject || cfg.activeProject || workspaceRoot);
  const initialProject = WSX.inspectProject(workspaceRoot, requestedProject).ok ? requestedProject : workspaceRoot;
  const publicDir = path.resolve(options.publicDir || path.join(root, 'public'));
  const attachmentsDir = path.resolve(options.attachmentsDir || path.join(root, 'meetings', 'attachments'));
  const passcodeFile = path.resolve(options.passcodeFile || path.join(root, '.secrets', 'passcode.txt'));
  const forbiddenRoots = (options.forbiddenRoots || [path.join(root, '.secrets')]).map(item => path.resolve(item));
  const openDirectory = options.openDirectory || (directory => {
    if (process.platform !== 'darwin') return false;
    return spawnSync('open', [directory], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  });
  const allowedHostnames = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    cfg.listen?.local,
    cfg.listen?.tailscale
  ].filter(Boolean).map(value => String(value).trim().replace(/^\[|\]$/g, '').toLowerCase()));

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });
  cfg.attachDir = attachmentsDir;
  cfg.secretsDir = path.join(root, '.secrets');
  const discoverModelCapabilities = options.discoverModels || discoverModels;
  const clock = options.now || (() => Date.now());
  // 測試直接塞一份固定的偵測結果時，不要在背景偷偷重抓。
  const fixedDiscovery = !!options.modelDiscovery && !options.discoverModels;
  // 版本檢查很便宜（兩個 --version），但也不必每次呼叫 AI 都做。
  const modelCheckIntervalMs = Math.max(0, Number(options.modelCheckIntervalMs ?? 5 * 60_000));
  // CLI 沒改版時，帳號可用的 Codex 模型也可能在伺服器端更新，所以清單最多沿用一小時。
  const codexListMaxAgeMs = Math.max(0, Number(options.codexListMaxAgeMs ?? 60 * 60_000));
  const modelWatchMs = Math.max(0, Number(options.modelWatchMs ?? 30 * 60_000));
  function cliVersion(bin) {
    try {
      const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
      return result.status === 0 ? String(result.stdout || result.stderr || '').trim().slice(0, 200) : '';
    } catch { return ''; }
  }
  const readCliVersion = options.cliVersion || cliVersion;
  const claudeBin = () => cfg.claude?.bin || 'claude';
  const codexBin = () => cfg.codexRead?.bin || 'codex';
  function approvedClaudeModels() {
    const list = cfg.modelApprovals?.claude;
    return Array.isArray(list) ? list.filter(id => typeof id === 'string' && SAFE_MODEL_ID.test(id)) : [];
  }
  // 每個 Claude 模型最近一次「實際呼叫驗證」的結果。某次偵測失敗時也保留，
  // 背景重抓才不會因為上一次失敗就把每個模型重新驗一遍（會耗用量，也會卡住伺服器）。
  const claudeVerification = new Map();
  function rememberClaudeVerification(result) {
    const provider = result?.providers?.claude;
    if (!provider?.ok) return;
    for (const model of provider.models || []) {
      if (model?.validation?.attempted) claudeVerification.set(model.id, model);
    }
  }
  function runModelDiscovery({ full = true } = {}) {
    // Claude 模型必須實際呼叫過一次（status: 'verified'）才可執行；
    // 沒把名單傳進去的話，所有 Claude 模型都會卡在「帳號尚未實際驗證」。
    // 完整檢查（啟動、按「重新檢查」）每個都驗；背景自動檢查只驗還沒驗過的。
    const wanted = [...new Set([...MODEL_CATALOG.claude.filter(model => model.selectable).map(model => model.id), ...approvedClaudeModels()])];
    const known = full ? new Map() : claudeVerification;
    const verifyClaudeModels = wanted.filter(id => !known.has(id));
    let result = discoverModelCapabilities({ claudeBin: cfg.claude?.bin, codexBin: cfg.codexRead?.bin, verifyClaudeModels });
    for (const [who, bin] of [['claude', claudeBin()], ['codex', codexBin()]]) {
      const provider = result?.providers?.[who];
      if (provider && !provider.cliVersion) provider.cliVersion = readCliVersion(bin);
    }
    const claude = result?.providers?.claude;
    if (known.size && claude?.ok && Array.isArray(claude.models)) {
      const models = claude.models.map(model => {
        const old = known.get(model.id);
        if (!old || model.validation?.attempted) return model;
        const { status, reason, validation, errorKind } = old;
        return { ...model, status, reason, validation, ...(errorKind ? { errorKind } : {}) };
      });
      result = Object.freeze({ ...result, providers: Object.freeze({ ...result.providers, claude: { ...claude, models } }) });
    }
    rememberClaudeVerification(result);
    return result;
  }
  let modelDiscovery = options.modelDiscovery || runModelDiscovery();
  if (options.modelDiscovery) rememberClaudeVerification(options.modelDiscovery);
  let lastModelCheck = clock();
  let lastForcedCheck = -Infinity;
  Object.defineProperty(cfg, 'modelDiscovery', {
    get: () => modelDiscovery,
    enumerable: false,
    configurable: true
  });

  // 主動跟上 CLI 改版：AI 開工前（最多每 5 分鐘一次）比對兩邊 CLI 的版本，
  // 版本變了、或 Codex 清單超過一小時，就自動重抓一次。force 用在模型被拒絕之後。
  function ensureModelsFresh({ force = false } = {}) {
    if (fixedDiscovery) return false;
    const nowMs = clock();
    if (!force && nowMs - lastModelCheck < modelCheckIntervalMs) return false;
    // 被拒絕後的強制重抓最多每分鐘一次，避免一直失敗時每次呼叫都卡住重抓。
    if (force && nowMs - lastForcedCheck < 60_000) return false;
    if (force) lastForcedCheck = nowMs;
    lastModelCheck = nowMs;
    if (!force) {
      const before = modelDiscovery?.providers || {};
      const codexAge = nowMs - (Date.parse(before.codex?.detectedAt || '') || 0);
      const versionChanged = readCliVersion(claudeBin()) !== (before.claude?.cliVersion || '')
        || readCliVersion(codexBin()) !== (before.codex?.cliVersion || '');
      if (!versionChanged && before.codex?.ok && codexAge < codexListMaxAgeMs) return false;
    }
    modelDiscovery = runModelDiscovery({ full: false });
    afterModelDiscovery();
    return true;
  }
  Object.defineProperty(cfg, 'ensureModelsFresh', {
    value: ensureModelsFresh,
    enumerable: false,
    configurable: true,
    writable: true
  });

  const clients = new Set();
  let activeProject = initialProject;
  let orch;

  function broadcast(message) {
    const payload = 'data: ' + JSON.stringify(message) + '\n\n';
    for (const client of clients) {
      try { client.write(payload); } catch {}
    }
  }

  // Telegram 通知：token 與 chat id 只從 .secrets/ 讀；沒設定就整個略過，不影響會議。
  const notifier = options.notifier || createNotifier({ secretsDir: path.join(root, '.secrets') });
  orch = options.orchestrator || new Orchestrator(cfg, workspaceRoot, broadcast, { notifier, activeProject });
  if (typeof orch.setActiveProject === 'function') orch.setActiveProject(activeProject);
  if (options.restore !== false && typeof orch.restore === 'function') orch.restore(root);

  const auth = createAuthService({ ...options.authOptions, passcodeFile });
  const authSweepMs = Math.max(1, Number(options.authSweepMs) || 30_000);
  const authSweepTimer = setInterval(() => auth.sweepExpired(), authSweepMs);
  authSweepTimer.unref?.();

  const autosaveMs = Math.max(1, Number(cfg.autosaveMs) || 180_000);
  const autosaveTimer = typeof orch.save === 'function'
    ? setInterval(() => orch.save(root), autosaveMs)
    : null;
  autosaveTimer?.unref?.();

  function modelTierInfo() {
    return legacyModelTierInfo(cfg);
  }

  // 內建清單、CLI 新列出的模型（待你開放）、自動替代的說明，全部由 model-config 算好。
  function currentModelConfig() {
    return modelConfigInfo(cfg);
  }

  // 每次重新偵測後：把結果推給畫面；如果「自動替代」的情況有變，記進會議的決策紀錄。
  let lastSubstitutionKey = '';
  function afterModelDiscovery() {
    const info = currentModelConfig();
    const key = JSON.stringify(info.notices || {});
    if (key !== lastSubstitutionKey) {
      lastSubstitutionKey = key;
      if (orch && typeof orch.note === 'function') {
        for (const notice of Object.values(info.notices || {})) orch.note('模型自動調整：' + notice.msg);
        if (info.notices && typeof orch.push === 'function') orch.push();
      }
    }
    broadcast({ type: 'modelConfig', ...info });
    broadcast({ type: 'modelTiers', ...modelTierInfo() });
  }
  afterModelDiscovery();
  // 閒置時也定期看一下 CLI 有沒有改版（只跑 --version，很便宜），讓設定畫面隨時是新的。
  const modelWatchTimer = modelWatchMs && !fixedDiscovery
    ? setInterval(() => { try { ensureModelsFresh(); } catch {} }, modelWatchMs)
    : null;
  modelWatchTimer?.unref?.();

  function saveConfig(nextConfig = cfg) {
    const persisted = { ...nextConfig };
    delete persisted.attachDir;
    delete persisted.secretsDir;
    const temporaryFile = configFile + '.tmp-' + process.pid;
    try {
      writeFileSync(temporaryFile, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
      renameSync(temporaryFile, configFile);
    } catch (error) {
      try { unlinkSync(temporaryFile); } catch {}
      throw error;
    }
  }

  function saveModelSelection(who, selection) {
    const nextSelection = { ...(cfg.modelSelection || {}), [who]: selection };
    saveConfig({ ...cfg, modelSelection: nextSelection });
    cfg.modelSelection = nextSelection;
  }

  function wsInfo() {
    const rootInfo = WSX.inspect(workspaceRoot);
    const projectInfo = WSX.inspect(activeProject);
    return {
      path: activeProject,
      display: projectInfo.display || activeProject,
      name: projectInfo.name || '',
      count: projectInfo.count || 0,
      isGit: !!projectInfo.isGit,
      workspaceRoot: {
        path: workspaceRoot,
        display: rootInfo.display || workspaceRoot,
        name: rootInfo.name || ''
      },
      activeProject: {
        path: activeProject,
        display: projectInfo.display || activeProject,
        name: projectInfo.name || ''
      },
      recent: WSX.readRecent(root).map(directory => {
        const recent = WSX.inspect(directory);
        return { path: directory, display: recent.display || directory, name: recent.name || directory };
      })
    };
  }

  function publicFile(requestedPath) {
    return resolveContainedFile({
      root: publicDir,
      requestedPath,
      forbiddenRoots
    });
  }

  function requireAuthentication(req, res, pathname) {
    const session = auth.authenticate(req.headers.cookie);
    if (session.ok) return session;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      empty(res, 303, { Location: '/login.html' });
    } else {
      json(res, 401, { error: '請先登入' });
    }
    return null;
  }

  async function routeRequest(req, res) {
    if (req.headers.host != null) {
      const hostname = hostnameFromHostHeader(req.headers.host);
      if (!hostname || !allowedHostnames.has(hostname)) {
        return json(res, 403, { error: '不允許的連線網址' });
      }
    }
    if (!isSameOriginPost(req)) return json(res, 403, { error: '不允許跨網站送出操作' });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: '無效的請求' });
    }
    const pathname = url.pathname;

    // 登入頁與它唯一需要的 180px 圖示可公開；其他檔案都要先驗證。
    if (req.method === 'GET' && (pathname === '/login' || pathname === '/login.html')) {
      const file = publicFile('login.html');
      return file ? sendFile(res, file) : json(res, 503, { error: '登入頁目前無法使用' });
    }
    // 主畫面 App 需要的靜態檔：圖示與 manifest。都不含任何機密，允許未登入讀取。
    if (req.method === 'GET' && pathname === '/assets/manifest.webmanifest') {
      const file = publicFile('assets/manifest.webmanifest');
      return file ? sendFile(res, file, 'public, max-age=3600') : empty(res, 404);
    }
    if (req.method === 'GET' && /^\/assets\/icon-(180|192|512|1024)\.png$/.test(pathname)) {
      const file = publicFile(pathname.slice(1));
      return file ? sendFile(res, file, 'public, max-age=3600') : empty(res, 404);
    }
    if (req.method === 'GET' && pathname === '/assets/icon-180.png') {
      const file = publicFile('assets/icon-180.png');
      return file ? sendFile(res, file, 'public, max-age=3600') : empty(res, 404);
    }
    if (pathname === '/api/login') {
      if (req.method !== 'POST') return json(res, 405, { error: '不支援這個操作' }, { Allow: 'POST' });
      if (!hasJsonContentType(req)) return json(res, 415, { error: '只接受 JSON 格式' });
      let payload;
      try {
        payload = await readJsonBody(req, MAX_LOGIN_BODY_BYTES);
      } catch (error) {
        return json(res, error?.status === 413 ? 413 : 400, { error: '登入資料無法處理' });
      }
      const result = auth.login(payload.passcode, req.socket?.remoteAddress || 'unknown');
      if (result.ok) return json(res, 200, { ok: true }, { 'Set-Cookie': result.setCookie });
      if (result.status === 429) {
        return json(res, 429, { ok: false, error: '嘗試次數過多，請稍後再試' }, {
          'Retry-After': String(result.retryAfter)
        });
      }
      if (result.status === 503) {
        return json(res, 503, { ok: false, error: '密碼鎖尚未設定，會議內容保持關閉' });
      }
      return json(res, 401, { ok: false, error: '密碼不正確' });
    }

    // 驗證放在所有現有與未來路由之前，避免新增 API 時忘記上鎖。
    const session = requireAuthentication(req, res, pathname);
    if (!session) return;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const file = publicFile('index.html');
      return file ? sendFile(res, file) : empty(res, 404);
    }

    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      let requestedPath;
      try { requestedPath = decodeURIComponent(pathname.slice(1)); }
      catch { return empty(res, 404); }
      const file = publicFile(requestedPath);
      const cacheControl = cacheHeaderForAsset(requestedPath);
      return file ? sendFile(res, file, cacheControl) : empty(res, 404);
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        ...SECURITY_HEADERS
      });
      res.write(': connected\n\n');
      res.write('data: ' + JSON.stringify({ type: 'workspace', ws: wsInfo() }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'modelConfig', ...currentModelConfig() }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'modelTiers', ...modelTierInfo() }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'state', state: orch.m }) + '\n\n');
      clients.add(res);

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20_000);
      ping.unref?.();
      let closed = false;
      let unregister = () => {};
      const closeConnection = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clients.delete(res);
        unregister();
        try { res.end(); } catch {}
      };
      unregister = auth.registerConnection(session.sessionId, closeConnection);
      req.once('close', closeConnection);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, orch.m);

    if (req.method === 'GET' && pathname === '/api/attachment') {
      const file = openRegisteredFile({
        root: attachmentsDir,
        requestedPath: url.searchParams.get('rel') || '',
        registeredPaths: collectRegisteredAttachmentPaths(orch.m),
        forbiddenRoots
      });
      return file ? sendOpenFile(res, file, 'no-store', untrustedFileHeaders(file.path)) : empty(res, 404);
    }

    if (req.method === 'GET' && pathname === '/api/asset') {
      const file = openRegisteredFile({
        root: workspaceRoot,
        requestedPath: url.searchParams.get('path') || '',
        registeredPaths: collectRegisteredAssetPaths(orch.m),
        forbiddenRoots
      });
      if (!file) return empty(res, 404);
      return sendOpenFile(res, file, 'no-store', untrustedFileHeaders(file.path));
    }

    // 職能分工表只有 capabilities.js 一份，畫面從這裡拿，不要再抄一份。
    if (req.method === 'GET' && pathname === '/api/capabilities') return json(res, 200, CAPABILITIES);
    if (req.method === 'GET' && pathname === '/api/workspace') return json(res, 200, wsInfo());
    if (req.method === 'GET' && pathname === '/api/modelConfig') return json(res, 200, currentModelConfig());
    if (req.method === 'GET' && pathname === '/api/browse') {
      return json(res, 200, WSX.browseWithin(workspaceRoot, url.searchParams.get('path') || workspaceRoot));
    }

    // ---- 環境自我檢查 ----
    if (req.method === 'GET' && pathname === '/api/doctor') {
      const { runCli } = await import('./adapters/run.js');
      const { geminiKeyPresent } = await import('./adapters/gemini.js');
      const { ollamaTags } = await import('./adapters/ollama.js');
      const ollama = cfg.ollama?.url ? await ollamaTags(cfg) : { ok: false, models: [], reason: 'config.json 沒有設定 ollama' };
      const claude = await runCli({ bin: cfg.claude.bin, args: ['--version'], cwd: '{WORKSPACE}' }, { prompt: '', workspace: workspaceRoot, timeoutMs: 20_000 });
      const codex = await runCli({ bin: cfg.codexRead.bin, args: ['--version'], cwd: '{WORKSPACE}' }, { prompt: '', workspace: workspaceRoot, timeoutMs: 20_000 });
      const gemini = cfg.gemini?.bin
        ? await runCli({ bin: cfg.gemini.bin, args: ['--version'], cwd: '{WORKSPACE}' }, { prompt: '', workspace: workspaceRoot, timeoutMs: 20_000 })
        : { ok: false, stderr: 'config.json 沒有設定 gemini', code: -1 };
      const claudeMcpResult = await runCli({ bin: cfg.claude.bin, args: ['mcp', 'list'], cwd: '{WORKSPACE}' }, { prompt: '', workspace: workspaceRoot, timeoutMs: 30_000 });
      const codexMcpResult = await runCli({ bin: cfg.codexRead.bin, args: ['mcp', 'list'], cwd: '{WORKSPACE}' }, { prompt: '', workspace: workspaceRoot, timeoutMs: 30_000 });
      const claudeMcp = (claudeMcpResult.stdout || '') + (claudeMcpResult.stderr || '');
      const codexMcp = (codexMcpResult.stdout || '') + (codexMcpResult.stderr || '');
      const imageTool = /magnific|firefly|adobe_for_creativity/i;
      return json(res, 200, {
        claude: claude.ok ? claude.stdout.trim() : ('無法執行：' + (claude.stderr || claude.code)),
        codex: codex.ok ? codex.stdout.trim() : ('無法執行：' + (codex.stderr || codex.code)),
        gemini: gemini.ok ? gemini.stdout.trim() : ('無法執行：' + (gemini.stderr || gemini.code)),
        explainBy: cfg.explainBy || 'claude',
        ollama: ollama.ok
          ? ('連得上 ' + cfg.ollama.url + '，模型：' + (ollama.models.join('、') || '（沒有）') + (cfg.ollama.model ? '，目前用 ' + cfg.ollama.model : '，目前用第一個'))
          : ('連不上：' + ollama.reason),
        geminiKey: geminiKeyPresent(cfg) ? '已設定（.secrets/gemini-api-key.txt）' : '未設定（Google 登入已停用，需要 .secrets/gemini-api-key.txt）',
        telegram: notifier.configured ? '已設定' : ('未設定：' + (notifier.reason || '')),
        mcp: claudeMcp.trim().slice(0, 700) || '（沒有讀到 MCP 清單）',
        codexMcp: codexMcp.trim().slice(0, 700) || '（沒有讀到 MCP 清單）',
        canImage: imageTool.test(claudeMcp),
        codexCanImage: imageTool.test(codexMcp),
        workspace: workspaceRoot,
        activeProject
      });
    }

    if (req.method !== 'POST') return empty(res, 404);
    if (!hasJsonContentType(req)) return json(res, 415, { error: '只接受 JSON 格式' });

    let payload;
    try {
      payload = await readJsonBody(req, MAX_API_BODY_BYTES);
    } catch (error) {
      return json(res, error?.status === 413 ? 413 : 400, { error: '請求資料無法處理' });
    }

    if (pathname === '/api/logout') {
      auth.logout(req.headers.cookie);
      return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie });
    }

    if (pathname === '/api/upload') {
      // 前端送 { files:[{name,type,data(base64)}] }，存進 meetings/attachments/<日期>/。
      const day = new Date().toISOString().slice(0, 10);
      const directory = resolveWritablePath({
        root: attachmentsDir,
        requestedPath: day,
        forbiddenRoots
      });
      if (!directory) return json(res, 500, { ok: false, msg: '附件目錄無法取得，請先聯絡管理者' });
      mkdirSync(directory, { recursive: true });
      const files = [];
      for (const file of (payload.files || []).slice(0, 10)) {
        const safeName = String(file.name || 'file').replace(/[\/\\:*?"<>|]/g, '_').slice(-80);
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const name = stamp + '-' + safeName;
        const rel = path.posix.join(day, name);
        const absolute = resolveWritablePath({
          root: attachmentsDir,
          requestedPath: rel,
          forbiddenRoots
        });
        if (!absolute) continue;
        const buffer = Buffer.from(String(file.data || '').split(',').pop(), 'base64');
        if (buffer.length > 25 * 1024 * 1024) continue;
        writeFileSync(absolute, buffer);
        const extension = path.extname(name).toLowerCase();
        files.push({
          name: safeName,
          path: absolute,
          rel: day + '/' + name,
          type: file.type || '',
          size: buffer.length,
          isImage: ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)
        });
      }
      return json(res, 200, { ok: true, files });
    }
    if (pathname === '/api/deliverable/open-folder') {
      const deliverable = (orch.m.deliverables || []).find(item => item.id === payload.id);
      if (!deliverable?.path) return json(res, 400, { ok: false, code: 'DELIVERABLE_NOT_FOUND', msg: '找不到這張交件卡' });
      const target = resolveWritablePath({ root: workspaceRoot, requestedPath: deliverable.path, forbiddenRoots });
      if (!target) return json(res, 400, { ok: false, code: 'UNSAFE_DELIVERABLE_PATH', msg: '這張卡的交件路徑不安全' });
      let directory = target;
      try {
        if (!statSync(target).isDirectory()) directory = path.dirname(target);
      } catch {
        directory = path.extname(target) ? path.dirname(target) : target;
      }
      try {
        if (!statSync(directory).isDirectory()) throw new Error('not a directory');
      } catch {
        return json(res, 400, { ok: false, code: 'DELIVERABLE_FOLDER_MISSING', msg: '交件資料夾尚未準備完成' });
      }
      return openDirectory(directory)
        ? json(res, 200, { ok: true })
        : json(res, 501, { ok: false, code: 'OPEN_FOLDER_UNAVAILABLE', msg: '這台主機目前無法直接開啟資料夾' });
    }
    if (pathname === '/api/deliverable/upload') {
      const deliverable = (orch.m.deliverables || []).find(item => item.id === payload.id);
      if (!deliverable?.path || deliverable.status !== 'waiting') {
        return json(res, 400, { ok: false, code: 'DELIVERABLE_NOT_WAITING', msg: '找不到可收件的交件卡' });
      }
      const incoming = Array.isArray(payload.files) ? payload.files.slice(0, 10) : [];
      if (!incoming.length) return json(res, 400, { ok: false, code: 'NO_FILES', msg: '沒有收到檔案' });
      const prepared = [];
      for (const file of incoming) {
        const destination = resolveDeliverableUpload({
          root: workspaceRoot,
          deliverablePath: deliverable.path,
          uploadName: file?.name,
          forbiddenRoots
        });
        if (!destination) return json(res, 400, { ok: false, code: 'INVALID_FILE_NAME', msg: '檔名或目的路徑不符合這張交件卡' });
        if (destination.conflict) return json(res, 409, {
          ok: false,
          code: 'FILE_EXISTS',
          fileName: destination.fileName,
          msg: '已有同名檔，沒有覆蓋。請保留原檔或先改名後再上傳。'
        });
        const encoded = String(file?.data || '');
        if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
          return json(res, 400, { ok: false, code: 'INVALID_FILE_DATA', msg: '檔案內容無法處理' });
        }
        const buffer = Buffer.from(encoded, 'base64');
        if (buffer.length > 25 * 1024 * 1024) {
          return json(res, 413, { ok: false, code: 'FILE_TOO_LARGE', msg: '單一檔案不可超過 25MB' });
        }
        prepared.push({ destination, buffer });
      }
      const written = [];
      try {
        for (const item of prepared) {
          writeFileSync(item.destination.path, item.buffer, { flag: 'wx' });
          written.push(item.destination.path);
        }
      } catch (error) {
        for (const file of written) {
          try { unlinkSync(file); } catch {}
        }
        if (error?.code === 'EEXIST') return json(res, 409, { ok: false, code: 'FILE_EXISTS', msg: '已有同名檔，沒有覆蓋。' });
        return json(res, 500, { ok: false, code: 'UPLOAD_FAILED', msg: '檔案未寫入，請稍後再試' });
      }
      return json(res, 200, {
        ok: true,
        files: prepared.map(item => ({ name: item.destination.fileName, rel: item.destination.relativePath, size: item.buffer.length }))
      });
    }
    if (pathname === '/api/goal') {
      if (!payload.goal && !(payload.files || []).length) return json(res, 400, { error: '請輸入開發目標' });
      json(res, 200, { ok: true });
      orch.start(payload.goal || '（見附件）', payload.files || [])
        .catch(() => broadcast({ type: 'state', state: orch.m }));
      return;
    }
    if (pathname === '/api/setWorkspace') {
      const inspected = WSX.inspectProject(workspaceRoot, payload.path || '');
      if (!inspected.ok) return json(res, 200, { ok: false, msg: inspected.msg });
      activeProject = inspected.path;
      if (typeof orch.setActiveProject === 'function') orch.setActiveProject(inspected.path);
      WSX.pushRecent(root, inspected.path);
      WSX.persist(root, inspected.path);
      broadcast({ type: 'workspace', ws: wsInfo() });
      orch.say('system', '會議室', '系統', {
        prose: '目前處理專案已切換到「' + inspected.name + '」（' + inspected.display + '）。固定讀取根目錄仍是 Projects。'
          + (inspected.isGit
            ? '這個資料夾有 git，還原點功能可以正常運作。'
            : '這個資料夾還沒有 git，第一次執行時會自動建立還原點。')
      });
      return json(res, 200, { ok: true, ws: wsInfo() });
    }
    if (pathname === '/api/imageBy') {
      return json(res, 409, {
        ok: false,
        blocked: true,
        code: 'AI_IMAGE_PRODUCER_FORBIDDEN',
        msg: 'Claude 與 Codex 都不負責產圖；目前只提供完整規格與明確路徑的人工交件。'
      });
    }
    if (pathname === '/api/modelTier') {
      const who = payload.who === 'claude' || payload.who === 'codex' ? payload.who : '';
      const tier = ['light', 'standard', 'max'].includes(payload.tier) ? payload.tier : '';
      const validated = selectionForLegacyTier(cfg, who, tier);
      if (!validated.ok) return json(res, 400, { ok: false, code: validated.code, msg: validated.msg });
      saveModelSelection(who, validated.selection);
      orch.note(who + ' 思考深度切換為 ' + validated.selection.effort);
      orch.push();
      broadcast({ type: 'modelConfig', ...currentModelConfig() });
      broadcast({ type: 'modelTiers', ...modelTierInfo() });
      return json(res, 200, { ok: true, ...modelTierInfo() });
    }
    if (pathname === '/api/modelSelection') {
      const who = payload.who === 'claude' || payload.who === 'codex' ? payload.who : '';
      const validated = validateModelSelection(who, { model: payload.model, effort: payload.effort }, modelDiscovery, cfg.modelApprovals);
      if (!validated.ok) return json(res, 400, { ok: false, code: validated.code, msg: validated.msg });
      saveModelSelection(who, validated.selection);
      orch.note(who + ' 模型切換為 ' + validated.selection.model
        + (validated.selection.effort ? '，思考深度 ' + validated.selection.effort : '，使用模型預設思考方式'));
      orch.push();
      broadcast({ type: 'modelConfig', ...currentModelConfig() });
      broadcast({ type: 'modelTiers', ...modelTierInfo() });
      return json(res, 200, { ok: true, ...currentModelConfig() });
    }
    if (pathname === '/api/modelDiscovery/refresh') {
      modelDiscovery = runModelDiscovery({ full: true });
      lastModelCheck = clock();
      afterModelDiscovery();
      return json(res, 200, { ok: true, ...currentModelConfig() });
    }
    if (pathname === '/api/modelApproval') {
      // 新模型要你按「開放」才會使用；也可以收回。只接受這次 CLI 真的有列出的新模型。
      const who = payload.who === 'claude' || payload.who === 'codex' ? payload.who : '';
      const id = typeof payload.model === 'string' ? payload.model.trim() : '';
      const approve = payload.approve !== false;
      if (!who || !SAFE_MODEL_ID.test(id)) {
        return json(res, 400, { ok: false, code: 'MODEL_APPROVAL_INVALID', msg: '無效的模型' });
      }
      const listed = (currentModelConfig().models[who] || []).find(model => model.id === id);
      const approvedNow = new Set(Array.isArray(cfg.modelApprovals?.[who]) ? cfg.modelApprovals[who] : []);
      if (approve && listed?.status !== 'pending') {
        return json(res, 400, { ok: false, code: 'MODEL_NOT_PENDING', msg: '這個模型目前不是等待開放的新模型' });
      }
      if (!approve && !approvedNow.has(id)) {
        return json(res, 400, { ok: false, code: 'MODEL_NOT_APPROVED', msg: '這個模型本來就沒有開放' });
      }
      if (!approve && cfg.modelSelection?.[who]?.model === id) {
        return json(res, 409, { ok: false, code: 'MODEL_IN_USE', msg: '目前正在使用這個模型，請先換成別的模型再收回' });
      }
      if (approve) approvedNow.add(id); else approvedNow.delete(id);
      const nextApprovals = { ...(cfg.modelApprovals || {}), [who]: [...approvedNow] };
      saveConfig({ ...cfg, modelApprovals: nextApprovals });
      cfg.modelApprovals = nextApprovals;
      orch.note((approve ? '開放新模型 ' : '收回模型 ') + (listed?.label || id));
      orch.push();
      afterModelDiscovery();
      return json(res, 200, { ok: true, ...currentModelConfig() });
    }
    if (pathname === '/api/actionModelSelection') {
      if (typeof orch.updateActionModel !== 'function') return json(res, 501, { ok: false, msg: '這個版本不支援工單模型覆寫' });
      const result = orch.updateActionModel(payload.id, { model: payload.model, effort: payload.effort });
      if (!result.ok) return json(res, result.code === 'ACTION_NOT_FOUND' ? 404 : 400, result);
      orch.push();
      orch.save(root, true);
      return json(res, 200, result);
    }
    if (pathname === '/api/genAsset') {
      const deliverable = (orch.m.deliverables || []).find(item => item.id === payload.id);
      if (!deliverable) return json(res, 404, { ok: false, code: 'DELIVERABLE_NOT_FOUND', msg: '找不到交件項目' });
      deliverable.status = 'waiting';
      deliverable.tool = 'manual';
      deliverable.deliveryMode = 'manual';
      deliverable.blockedReason = '外部產圖工具尚未接成已驗證授權的會議室入口，請依完整規格在外部完成後手動交件。';
      delete deliverable.producer;
      delete deliverable.by;
      if (typeof orch.note === 'function') orch.note('停在人工交件：' + deliverable.title);
      if (typeof orch.push === 'function') orch.push();
      if (typeof orch.save === 'function') orch.save(root, true);
      return json(res, 409, {
        ok: false,
        blocked: true,
        code: 'MANUAL_DELIVERY_REQUIRED',
        msg: '外部產圖工具尚未完成獨立入口與授權驗證，因此沒有呼叫 Claude、Codex 或 Magnific。請依交件規格在外部完成後，把成品放到 ' + (deliverable.path || '交件卡指定的路徑') + '。'
      });
    }
    if (pathname === '/api/assetDecide') {
      const result = orch.assetDecide(payload.id, !!payload.ok, payload.feedback || '');
      orch.push();
      orch.save(root, true);
      return json(res, 200, result);
    }
    if (pathname === '/api/restart') {
      // 先存檔，回完話再用結束碼 89 離開，start.command 的迴圈會把伺服器重開。
      orch.save(root, true);
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(89), 200);
      return;
    }
    if (pathname === '/api/save') return json(res, 200, { ok: true, at: orch.save(root, true) });
    if (pathname === '/api/say') {
      json(res, 200, { ok: true });
      orch.userSay(payload.text || '', payload.to || 'claude', payload.files || []);
      return;
    }
    if (pathname === '/api/choose') {
      // 選方案後會叫 Codex 依方案開單，跟 /api/say 一樣先回 200，進度走 SSE。
      json(res, 200, { ok: true });
      Promise.resolve(orch.choose(payload.id))
        .then(() => orch.save(root, true))
        .catch(error => orch.reportError('依方案開單失敗', error?.message || error));
      return;
    }
    if (pathname === '/api/reject') {
      orch.reject(payload.id);
      orch.push();
      orch.save(root, true);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/approve') {
      json(res, 200, { ok: true });
      orch.approve(payload.id).catch(error => orch.reportError('核准執行失敗', error?.message || error));
      return;
    }
    // 批次核准：跟單張一樣先回 200，讓畫面透過 SSE 看進度（state.batch）。
    if (pathname === '/api/approveMany') {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter(x => typeof x === 'string') : [];
      if (!ids.length) return json(res, 400, { ok: false, msg: '沒有指定要核准的工單' });
      if (typeof orch.approveMany !== 'function') return json(res, 501, { ok: false, msg: '這個版本不支援批次核准' });
      json(res, 200, { ok: true, count: ids.length });
      orch.approveMany(ids).catch(error => orch.reportError('批次核准失敗', error?.message || error));
      return;
    }
    if (pathname === '/api/approveAll') {
      const risk = ['low', 'mid', 'high'].includes(payload.risk) ? payload.risk : '';
      if (typeof orch.approveAll !== 'function') return json(res, 501, { ok: false, msg: '這個版本不支援批次核准' });
      const count = (orch.m.actions || []).filter(a => a.status === 'pending' && (!risk || a.risk === risk)).length;
      if (!count) return json(res, 400, { ok: false, msg: risk ? '沒有待處理的 ' + risk + ' 風險工單' : '沒有待處理的工單' });
      json(res, 200, { ok: true, count });
      orch.approveAll(risk).catch(error => orch.reportError('批次核准失敗', error?.message || error));
      return;
    }
    if (pathname === '/api/notifyTest') {
      if (!notifier.configured) return json(res, 200, { ok: false, msg: 'Telegram 尚未設定：' + (notifier.reason || '') });
      const r = await notifier.notify('test', '這則收到就代表 Telegram 接好了。', { goal: orch.m?.goal || '', force: true });
      return json(res, 200, r.ok ? { ok: true, msg: '已送出，看一下手機' } : { ok: false, msg: 'Telegram 沒收：' + (r.reason || r.skipped || '原因不明') });
    }
    if (pathname === '/api/retry') {
      const result = await orch.retry(payload.id);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (pathname === '/api/markDone') {
      if (typeof orch.markDone !== 'function') return json(res, 501, { ok: false, msg: '這個版本不支援' });
      const result = await orch.markDone(payload.id);
      orch.save(root, true);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (pathname === '/api/retryAll') {
      const result = await orch.retryAll();
      return json(res, result.ok ? 200 : 400, result);
    }
    if (pathname === '/api/drop') {
      const result = orch.drop(payload.id);
      orch.push();
      orch.save(root, true);
      return json(res, 200, result);
    }
    if (pathname === '/api/restore') {
      const restoreId = typeof payload?.id === 'string' ? payload.id : '';
      const restorable = ['actions', 'deliverables'].some(key =>
        Array.isArray(orch.m?.[key]) && orch.m[key].some(item => item?.id === restoreId)
      );
      if (!restoreId || !restorable) {
        return json(res, 400, { ok: false, error: '找不到可還原的項目' });
      }
      const result = orch.restore(payload.id);
      orch.push();
      orch.save(root, true);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (pathname === '/api/answer') {
      const result = orch.answerDeliverable(payload.id, payload.text || '');
      orch.save(root, true);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (pathname === '/api/delivered') {
      const result = orch.markDelivered(payload.id);
      orch.push();
      orch.save(root, true);
      return json(res, 200, result);
    }
    if (pathname === '/api/undo') return json(res, 200, await orch.undo(payload.hash));
    if (pathname === '/api/explain') {
      const r = await orch.explain(payload.text || '');
      return json(res, 200, typeof r === 'string' ? { text: r, by: 'claude' } : r);
    }
    if (pathname === '/api/end') {
      const markdown = orch.markdown();
      const name = 'meeting-' + new Date().toISOString().slice(0, 10) + '-' + orch.m.id + '.md';
      const file = path.join(root, 'meetings', name);
      writeFileSync(file, markdown, 'utf8');
      orch.m.ended = true;
      orch.save(root, true);
      orch.say('system', '會議室', '系統', {
        prose: '會議紀錄已存成 meetings/' + name + '，這場會議結束了。'
      });
      return json(res, 200, { ok: true, file: 'meetings/' + name });
    }

    return empty(res, 404);
  }

  function handleRequest(req, res) {
    routeRequest(req, res).catch(() => {
      if (!res.headersSent) return json(res, 500, { error: '伺服器處理失敗' });
      res.destroy();
    });
  }

  function close() {
    clearInterval(authSweepTimer);
    if (modelWatchTimer) clearInterval(modelWatchTimer);
    if (autosaveTimer) clearInterval(autosaveTimer);
    auth.dispose();
    for (const client of clients) {
      try { client.end(); } catch {}
    }
    clients.clear();
  }

  return {
    handleRequest,
    broadcast,
    close,
    save: () => typeof orch.save === 'function' ? orch.save(root, true) : null,
    authConfigured: auth.configured,
    notifierConfigured: notifier.configured,
    notifierReason: notifier.reason || ''
  };
}

function listenFailure(error, host, port) {
  const code = error?.code || 'UNKNOWN';
  if (code === 'EADDRNOTAVAIL') return `這台 Mac 目前沒有 ${host} 這個位址（${code}）`;
  if (code === 'EADDRINUSE') return `${host}:${port} 已被其他程序使用（${code}）`;
  if (code === 'EACCES') return `系統不允許使用 ${host}:${port}（${code}）`;
  return `無法綁定 ${host}:${port}（${code}）`;
}

export function startMeetingRoomServer() {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  const workspaceRoot = path.resolve(ROOT, cfg.workspaceRoot || cfg.workspace);
  const port = Number(cfg.port) || 4477;
  const requestedLocal = String(cfg.listen?.local || '127.0.0.1').trim();
  const localHost = isLoopbackHost(requestedLocal) ? requestedLocal : '127.0.0.1';
  const requestedTailscale = String(cfg.listen?.tailscale || '').trim();
  const tailscaleHost = isTailscaleIp(requestedTailscale) ? requestedTailscale : '';
  const app = createMeetingRoomApp({ root: ROOT, configFile: CONFIG_FILE, config: cfg, workspaceRoot });
  const localServer = http.createServer(app.handleRequest);
  let tailscaleServer;

  localServer.once('error', error => {
    console.error('');
    console.error('  本機入口啟動失敗：' + listenFailure(error, localHost, port));
    app.close();
    process.exit(1);
  });

  localServer.listen(port, localHost, () => {
    console.log('');
    console.log(`  三方開發會議室已啟動   build ${BUILD_NUMBER}`);
    console.log('  Mac 本機入口： http://' + localHost + ':' + port);
    console.log('  讀取根目錄： ' + workspaceRoot);
    console.log('  目前處理專案： ' + (cfg.activeProject || workspaceRoot));
    console.log(app.authConfigured
      ? '  密碼鎖：已啟用'
      : '  密碼鎖：尚未設定，會議內容保持關閉');
    console.log(app.notifierConfigured
      ? '  Telegram 通知：已啟用'
      : '  Telegram 通知：未設定（' + app.notifierReason + '）');
    console.log('  白話解釋：' + ({ ollama: 'Ollama（PC）→ Gemini → Claude，前面失敗自動往後退', gemini: 'Gemini（失敗自動退回 Claude）' }[cfg.explainBy] || 'Claude'));
    console.log('  要結束請按 Control + C');
    console.log('');

    if (localHost !== requestedLocal) {
      console.log('  注意：config.json 的本機位址 ' + requestedLocal + ' 不是迴路位址，為了安全改用 127.0.0.1。');
    }
    if (requestedTailscale && !tailscaleHost) {
      console.log('  手機入口未開啟：config.json 的 Tailscale 位址 ' + requestedTailscale + ' 不在 Tailscale 網段（100.64.0.0/10），為了安全不開放；Mac 本機仍可使用。');
      console.log('');
      return;
    }
    if (!tailscaleHost) {
      console.log('  手機入口未開啟：config.json 沒有設定 Tailscale 位址；Mac 本機仍可使用。');
      console.log('');
      return;
    }

    tailscaleServer = http.createServer(app.handleRequest);
    tailscaleServer.once('error', error => {
      console.log('  手機入口未開啟： http://' + tailscaleHost + ':' + port);
      console.log('  原因：' + listenFailure(error, tailscaleHost, port) + '；Mac 本機仍可使用。');
      console.log('');
    });
    tailscaleServer.listen(port, tailscaleHost, () => {
      console.log('  Tailscale 手機入口： http://' + tailscaleHost + ':' + port);
      console.log('');
    });
  });

  const shutdown = () => {
    try { app.save(); } catch {}
    app.close();
    console.log('\n  會議已存檔，再見。');
    process.exit(0);
  };
  process.once('SIGINT', shutdown);

  return { app, localServer, get tailscaleServer() { return tailscaleServer; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE) {
  startMeetingRoomServer();
}
