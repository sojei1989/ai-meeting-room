import { existsSync, statSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { askClaude } from './adapters/claude.js';
import { askCodex } from './adapters/codex.js';
import { askGemini } from './adapters/gemini.js';
import { askOllama } from './adapters/ollama.js';
import { approvedWriteScope, resolveWritablePath, withinApprovedScope } from './safe-path.js';
import { ensureRepo, listSubprojects, workingSnapshot, snapshotDiff, checkpoint, changedPathsSince, diffSince, restore, restoreTaskChanges, headHash } from './git.js';
import { codexSelectionForAction, codexPlanningText, selectedModel } from './model-config.js';
import * as P from './prompts.js';

let uid = 0;
const OWNER = process.pid + '-' + Date.now();   // 這個伺服器程序的身分

const now = () => new Date().toTimeString().slice(0, 5);
const MANUAL_IMAGE_BLOCKER = '外部產圖工具尚未接成已驗證授權的會議室入口，請依完整規格在外部完成後手動交件。';

function isImageDeliverable(item) {
  if (P.assetKind(item && item.path) === 'image') return true;
  const text = [item && item.title, item && item.say, ...((item && item.specs) || []).flat()].join(' ');
  return /產圖|圖片|主視覺|海報|封面|縮圖|頭像|圖示|icon|logo|image|photo|\.png|\.jpe?g|\.webp|\.gif|\.svg/i.test(text);
}

function asManualDeliverable(item) {
  const { producer: _producer, by: _by, ...copy } = item || {};
  copy.tool = 'manual';
  copy.deliveryMode = 'manual';
  if (isImageDeliverable(copy)) copy.blockedReason = MANUAL_IMAGE_BLOCKER;
  return copy;
}

function imageDeliveryIssues(item) {
  if (!isImageDeliverable(item)) return [];
  const specs = Array.isArray(item && item.specs) ? item.specs : [];
  const hasValue = patterns => specs.some(pair => {
    if (!Array.isArray(pair)) return false;
    const key = String(pair[0] || '');
    const value = String(pair[1] || '').trim();
    return patterns.some(pattern => pattern.test(key)) && value !== '' && value !== '…';
  });
  const issues = [];
  if (!hasValue([/尺寸/, /解析度/, /畫布/])) issues.push('尺寸');
  if (!hasValue([/格式/, /副檔名/])) issues.push('格式');
  if (!hasValue([/數量/, /張數/])) issues.push('數量');
  const rel = String(item && item.path || '').trim();
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (!rel || path.isAbsolute(rel) || normalized === '..' || normalized.startsWith('../')) issues.push('存放路徑');
  return issues;
}

function prepareDeliverableFolder(workspace, item) {
  const requestedPath = String(item && item.path || '').trim().replace(/\/$/, '');
  const target = resolveWritablePath({
    root: workspace,
    requestedPath,
    forbiddenRoots: [path.join(workspace, '.secrets')]
  });
  if (!target) return false;

  try {
    const targetIsDirectory = existsSync(target) && statSync(target).isDirectory();
    const specifiesFile = !targetIsDirectory && path.posix.extname(path.posix.basename(requestedPath)) !== '';
    mkdirSync(specifiesFile ? path.dirname(target) : target, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function newMeeting() {
  return {
    id: 'M' + Date.now(), seq: 0, owner: OWNER,
    goal: '', phase: 0, startedAt: new Date().toISOString(),
    busy: false, busyWho: '', log: '',
    transcript: [], options: [], chosen: null,
    risks: [], actions: [], deliverables: [],
    decisions: [], checkpoints: [], plan: null, error: '', savedAt: '', ended: false,
    batch: null
  };
}

export class Orchestrator {
  constructor(cfg, workspace, broadcast, extras = {}) {
    this.cfg = cfg; this.ws = workspace; this.broadcast = broadcast;
    this.activeProject = extras.activeProject || workspace;
    this.m = newMeeting();
    // notifier：Telegram 通知（server/notify.js）。沒設定就是 null，所有 ping() 都靜靜略過。
    this.notifier = extras.notifier || null;
    // ask：可替換的 CLI 呼叫，測試時塞假的進來，不用真的開 claude / codex / gemini。
    this.ask = Object.assign({ claude: askClaude, codex: askCodex, gemini: askGemini, ollama: askOllama }, extras.ask || {});
  }

  setActiveProject(project) {
    this.activeProject = project || this.ws;
  }

  // 子專案相對於根目錄的前綴；聚焦在根目錄本身或根目錄外時回傳空字串。
  projectPrefix() {
    if (!this.activeProject || !this.ws) return '';
    const rel = path.relative(path.resolve(this.ws), path.resolve(this.activeProject));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return rel.split(path.sep).join('/');
  }

  // 工單路徑常以某個子專案為基準（例如 public/index.html），這裡換算成根目錄相對路徑。
  // 順序：已含前綴 → 目前處理的子專案 → 根目錄本身 → 所有子專案中唯一對得上的那個。
  async rootRelativeFiles(files) {
    if (!Array.isArray(files)) return { ok: true, files };
    const fits = file => approvedWriteScope({ root: this.ws, files: [file] }).ok;
    const clean = file => String(file?.path || '').replaceAll('\\', '/').replace(/^\.\//, '');
    const subs = await listSubprojects(this.ws);
    const focus = this.projectPrefix();
    const out = [];
    const unresolved = [];
    // 路徑第一層就是根目錄底下現有的資料夾（例如「品牌官網/…」），代表它本來就是根目錄相對路徑，
    // 不能再拿去各子專案猜；檢查不過時直接回報真正原因，不要誤報成「多個子專案都對得上」。
    const rootDir = raw => {
      const first = raw.split('/')[0];
      if (!first || !raw.includes('/')) return false;
      try { return statSync(path.join(this.ws, first)).isDirectory(); } catch { return false; }
    };
    for (const file of files) {
      const raw = clean(file);
      if (!raw || subs.some(s => raw.startsWith(s + '/'))) { out.push(file); continue; }
      if (focus && fits({ ...file, path: focus + '/' + raw })) { out.push({ ...file, path: focus + '/' + raw }); continue; }
      if (fits(file)) { out.push(file); continue; }
      if (rootDir(raw)) {
        const why = approvedWriteScope({ root: this.ws, files: [file] });
        return { ok: false, error: why.error };
      }
      out.push(null);
      unresolved.push({ index: out.length - 1, file, raw });
    }
    // 其他已確定的檔案若都落在同一個子專案，就優先用它（新增檔案靠這個判斷）。
    const decided = out.filter(Boolean).map(f => clean(f));
    const hinted = subs.filter(s => decided.some(p => p.startsWith(s + '/')));
    for (const { index, file, raw } of unresolved) {
      // 新增檔案時，子專案裡至少要有上一層資料夾才算對得上，否則每個子專案都會「剛好可以新增」。
      const parentExists = s => file?.op !== 'add' || !raw.replace(/\/+$/, '').includes('/')
        || existsSync(path.join(this.ws, s, path.posix.dirname(raw.replace(/\/+$/, ''))));
      let matches = subs.filter(s => parentExists(s) && fits({ ...file, path: s + '/' + raw }));
      if (matches.length > 1 && hinted.length) {
        const narrowed = matches.filter(s => hinted.includes(s));
        if (narrowed.length) matches = narrowed;
      }
      if (matches.length > 1) {
        // 取最深的那層以外若仍多個，就交給使用者決定。
        return { ok: false, error: '「' + raw + '」在多個子專案都對得上（' + matches.join('、')
          + '），請先把「目前處理專案」切到正確的子專案再重試' };
      }
      out[index] = matches.length ? { ...file, path: matches[0] + '/' + raw } : file;
    }
    return { ok: true, files: out };
  }

  // 會議室提供的模型重新偵測（有版本變動或清單過期才會真的重抓）；單獨測試時沒有就略過。
  refreshModels() {
    try { if (typeof this.cfg?.ensureModelsFresh === 'function') this.cfg.ensureModelsFresh(); } catch {}
  }

  // 這場會議如果是用「暫時替代」的模型在跑，寫進決策紀錄，事後看紀錄才知道實際用了哪個模型。
  noteModelSubstitutions() {
    for (const who of ['claude', 'codex']) {
      const current = selectedModel(this.cfg, who);
      if (current.ok && current.substituted) this.note('模型自動調整：' + current.notice);
    }
  }

  focusPrompt(prompt) {
    if (!this.activeProject || this.activeProject === this.ws) return prompt;
    return '目前優先處理的子專案：' + this.activeProject
      + '\n固定讀取根目錄：' + this.ws
      + '\n可以讀取根目錄內其他專案作為背景，但本次先聚焦上述子專案。\n\n' + prompt;
  }

  // 推一則 Telegram。永遠不等它、永遠不讓它把會議弄壞。
  ping(kind, text) {
    if (!this.notifier || typeof this.notifier.notify !== 'function') return;
    try {
      const p = this.notifier.notify(kind, text, { goal: this.m.goal });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  push() { this.dirty = true; this.broadcast({ type: 'state', state: this.m }); }
  note(text) {
    const last = this.m.decisions[this.m.decisions.length - 1];
    if (last && last.text === text) return;   // 同一句連續按不重複記
    this.m.decisions.push({ time: now(), text });
  }

  say(who, name, role, payload) {
    this.m.transcript.push(Object.assign({ who, name, role, time: now() }, payload));
    this.push();
  }

  // 給非技術使用者看的錯誤訊息，並透過 SSE 發出錯誤橫幅事件。
  // CLI 失敗時組出「真正看得懂」的原因。
  // 為什麼要這個：以前只把 stderr 當失敗原因，但 Codex 每次啟動都會把橫幅
  // （workdir / model / provider / sandbox / session id）寫進 stderr，
  // 於是畫面上出現一個紅色大框，裡面全是正常訊息，真正的錯誤在 stdout 裡卻被丟掉。
  static explainCliFailure(r) {
    const strip = (t) => String(t || '')
      .split('\n')
      .filter(line => !/^(Reading additional input from stdin|OpenAI Codex v|-{4,}|workdir:|model:|provider:|approval:|sandbox:|reasoning (effort|summaries):|session id:)/.test(line.trim()))
      .filter(line => !/codex_models_manager::cache: failed to load models cache/.test(line))
      .join('\n').trim();
    const out = strip(r.raw || r.stdout);
    const err = strip(r.stderr);
    const parts = [];
    parts.push('結束碼 ' + (r.code === undefined ? '未知' : r.code));
    if (out) parts.push('--- 執行輸出的最後一段 ---\n' + out.slice(-1200));
    if (err) parts.push('--- 錯誤輸出 ---\n' + err.slice(-600));
    if (!out && !err) parts.push('（CLI 沒有留下任何訊息，只有啟動橫幅。多半是被外力中斷，或是它自己在還沒輸出前就結束了。）');
    return parts.join('\n\n');
  }

  reportError(message, reason) {
    const time = new Date().toISOString();
    const raw = String(reason || '沒有回應').slice(0, 2500);
    this.m.error = message;
    this.say('system', '會議室', '系統', { error: true, prose: message + '。原始訊息如下：', raw });
    this.broadcast({ type: 'error', error: { message, reason: raw, time } });
    this.ping('error', message + '：' + raw.split('\n')[0].slice(0, 200));
    return { ok: false, msg: message + '：' + raw };
  }

  fail(who, r, reason) {
    // 所有 CLI 失敗都走這裡，所以原因的組法只需要一份。
    // 以前是 r.error || r.stderr，而 Codex 把開機橫幅寫進 stderr，
    // 於是七個出口全部只顯示橫幅、真正的錯誤（在 stdout）被丟掉。
    return this.reportError(who + '執行失敗', reason || Orchestrator.explainCliFailure(r));
  }

  async busy(who, fn) {
    this.m.busy = true; this.m.busyWho = who; this.m.log = ''; this.push();
    try { return await fn(); }
    catch (e) { return this.reportError(who + '失敗', e && e.message || e); }
    finally { this.m.busy = false; this.m.busyWho = ''; this.push(); }
  }

  onLog = (chunk) => {
    this.m.log = (this.m.log + chunk).slice(-4000);
    this.broadcast({ type: 'log', log: this.m.log });
  };

  transcriptText() {
    return this.m.transcript.map(t => {
      const f = t.fields ? Object.entries(t.fields).map(([k, v]) => `  ${k}：${v}`).join('\n') : '';
      const a = t.files && t.files.length ? '\n  附件：' + t.files.map(x => x.name + ' → ' + x.path).join('；') : '';
      return `【${t.name}／${t.role}】${t.time}\n${t.prose || ''}\n${f}${a}`;
    }).join('\n\n');
  }

  /* ---------- 自動存檔（每隔幾分鐘，或關鍵動作後） ---------- */
  save(root, force) {
    if (root) this.saveRoot = root;
    if (!force && !this.dirty) return null;
    if (!this.m.goal) return null;
    try {
      const dir = path.join(root, 'meetings');
      mkdirSync(dir, { recursive: true });
      const f = path.join(dir, '_current.json');

      // 防「回朔」：如果磁碟上那份比我手上的新，而且是別的程序寫的，就不要蓋掉
      if (existsSync(f)) {
        try {
          const on = JSON.parse(readFileSync(f, 'utf8'));
          if (on && on.id === this.m.id && (on.seq || 0) > (this.m.seq || 0)) {
            if (!this.conflictWarned) {
              this.conflictWarned = true;
              console.error('\n  ⚠️  偵測到另一個伺服器程序在寫同一份會議紀錄（' + on.owner + '）。');
              console.error('     這一份沒有存檔，以免把新的狀態蓋回舊的。');
              console.error('     請關掉多餘的程序：lsof -ti:' + (this.cfg.port || 4477) + ' | xargs -r kill\n');
              this.say('system', '會議室', '系統', {
                prose: '偵測到有兩個伺服器程序在跑同一場會議，為了不把你的決定蓋掉，這一份先沒有存檔。'
                     + '請把多餘的程序關掉（終端機執行 lsof -ti:' + (this.cfg.port || 4477) + ' | xargs -r kill），再重新啟動一次。'
              });
            }
            return null;
          }
        } catch {}
      }

      this.m.seq = (this.m.seq || 0) + 1;
      this.m.owner = OWNER;
      this.m.savedAt = new Date().toISOString();
      writeFileSync(f, JSON.stringify(this.m, null, 2), 'utf8');
      writeFileSync(path.join(dir, this.m.id + '.md'), this.markdown(), 'utf8');
      this.dirty = false;
      this.broadcast({ type: 'saved', at: now() });
      return this.m.savedAt;
    } catch (e) { return null; }
  }

  restore(target) {
    const item = [...(this.m.actions || []), ...(this.m.deliverables || [])].find(x => x.id === target);
    if (item) {
      if (item.status !== 'dropped') return { ok: false, msg: '只有已移除的項目可以復原' };
      item.status = this.m.actions.includes(item) ? 'pending' : 'waiting';
      item.lastError = '';
      this.note('復原：' + item.title);
      return { ok: true };
    }
    try {
      const f = path.join(target, 'meetings', '_current.json');
      if (!existsSync(f)) return false;
      const m = JSON.parse(readFileSync(f, 'utf8'));
      if (!m || !m.goal || m.ended) return false;
      m.busy = false; m.busyWho = ''; m.log = '';
      // 中斷時卡在執行中的項目，回復成待處理，讓使用者重新決定
      (m.actions || []).forEach(a => { if (a.status === 'running') a.status = 'pending'; });
      (m.deliverables || []).forEach(d => {
        if (d.status === 'generating' || d.status === 'failed') d.status = 'waiting';
        if (d.status === 'waiting') {
          Object.assign(d, asManualDeliverable(d));
          const missing = imageDeliveryIssues(d);
          d.blockedReason = missing.length
            ? '圖片交件規格不完整，還缺少：' + missing.join('、') + '。請先補齊再交給外部工具。'
            : (d.blockedReason || MANUAL_IMAGE_BLOCKER);
          delete d.lastError;
        }
      });
      delete m.imageBy;
      // 還原後把 uid 推到現有編號之後，避免新項目跟舊項目撞 id
      let mx = 0;
      for (const x of [...(m.actions || []), ...(m.deliverables || [])]) {
        const n = parseInt(String(x.id || '').replace(/^\D+/, ''), 10);
        if (Number.isFinite(n) && n > mx) mx = n;
      }
      uid = Math.max(uid, mx);

      // 自動修復：舊版 uid 重啟歸零留下的撞號資料。
      // 兩個項目同 id 時，find(x=>x.id===id) 只會抓到第一個，使用者按了鈕卻沒反應、項目一直回來問。
      const seen = new Set();
      let fixed = 0;
      for (const x of [...(m.deliverables || []), ...(m.actions || [])]) {
        if (!x.id || seen.has(x.id)) {
          x.id = 'fix' + (++uid);
          fixed++;
        }
        seen.add(x.id);
      }
      if (fixed) console.log('  已修復 ' + fixed + ' 個重複的項目編號（舊版留下的資料）');
      m.owner = OWNER;
      this.m = m;
      this.say('system', '會議室', '系統', {
        prose: '已接回上一次的會議（' + (m.savedAt ? m.savedAt.slice(0, 16).replace('T', ' ') : '') + ' 存檔）。'
             + '中途被打斷的項目已經退回「待你處理」，可以重新決定。'
      });
      return true;
    } catch { return false; }
  }

  /* ---------- 1. 使用者提出目標 ---------- */
  async start(goal, files = []) {
    this.m = newMeeting();
    this.m.goal = goal;
    this.m.phase = 1;
    await ensureRepo(this.ws);
    const h = await headHash(this.ws);
    this.m.checkpoints.push({ hash: h, label: '會議開始', time: now() });
    this.say('user', '你', '決策者', { prose: goal, files });
    this.note('提出開發目標');
    const imgs = files.filter(f => f.isImage).map(f => f.path);
    this.push();

    // Claude 規劃
    await this.busy('Claude 規劃中', async () => {
      // 先確認模型清單是新的，再把「Codex 可用模型與你的上限」放進規劃提示，Claude 才能分配工單。
      this.refreshModels();
      this.noteModelSubstitutions();
      const plan = P.claudePlanPrompt(goal, '', files, codexPlanningText(this.cfg));
      const r = await this.ask.claude(this.cfg, this.focusPrompt(plan), this.ws, this.onLog, { images: imgs });
      if (!r.ok) return this.fail('Claude', r);
      const d = r.data;
      this.say('claude', 'Claude', '策劃者', {
        prose: (d && d.summary) || r.prose,
        fields: d && d.fields, plain: d && d.plain,
        options: d && d.options, raw: d ? null : r.raw,
        parseError: r.parseError
      });
      if (d) {
        this.m.plan = d;
        this.m.options = d.options || [];
        this.m.risks = (d.risks || []).slice();
        this.m.deliverables = [];
        const n = this.addDeliverables(d.deliverables || [], 'd');
        if (n.invalid) this.note('未建立 ' + n.invalid + ' 項規格不完整的圖片交件：' + n.issues.join('；'));
      }
      this.m.phase = 2;
    });

    // Codex 評估
    await this.busy('Codex 檢查專案中', async () => {
      const r = await this.ask.codex(this.cfg, this.focusPrompt(P.codexAssessPrompt(goal, this.transcriptText(), files)), this.ws, 'read', this.onLog, { images: imgs });
      if (!r.ok) return this.fail('Codex', r);
      const d = r.data;
      this.say('codex', 'Codex', '執行者', {
        prose: (d && d.summary) || r.prose,
        fields: d && d.fields, raw: d ? null : r.raw, parseError: r.parseError
      });
      if (d && Array.isArray(d.actions)) {
        this.m.actions = d.actions.map(a => Object.assign({ status: 'pending' }, a));
      }
      if (d && Array.isArray(d.deliverables) && d.deliverables.length) {
        const n = this.addDeliverables(d.deliverables, 'cd');
        if (n.invalid) this.note('未建立 ' + n.invalid + ' 項規格不完整的圖片交件：' + n.issues.join('；'));
      }
      this.m.phase = 3;
      this.note('等你決定');
      this.ping('decide', 'Claude 規劃好了、Codex 也看完專案：'
        + this.m.actions.filter(a => a.status === 'pending').length + ' 項待核准、'
        + this.m.deliverables.filter(x => x.status === 'waiting').length + ' 項待交件，等你決定。');
    });
  }

  /* ---------- 1.5 會議中使用者發言 ---------- */
  async userSay(text, to, files = []) {
    if ((!text || !text.trim()) && !files.length) return;
    text = (text || '').trim() || '（附上檔案）';
    const imgs = files.filter(f => f.isImage).map(f => f.path);
    this.say('user', '你', '決策者', { prose: text, files });

    if (to === 'note') { this.note('你的備註：' + text.trim().slice(0, 30)); return; }
    if (this.m.busy) return;

    if (to === 'codex') {
      await this.busy('Codex 回覆中', async () => {
        const r = await this.ask.codex(this.cfg, this.focusPrompt(P.codexReplyPrompt(text, this.transcriptText(), files)), this.ws, 'read', this.onLog, { images: imgs });
        if (!r.ok) return this.fail('Codex', r);
        const d = r.data;
        this.say('codex', 'Codex', '執行者', {
          prose: (d && d.summary) || r.prose, fields: d && d.fields,
          raw: d ? null : r.raw, parseError: r.parseError
        });
        this.ping('decide', 'Codex 回覆了：' + String((d && d.summary) || r.prose || '').slice(0, 160));
        if (d && Array.isArray(d.actions) && d.actions.length) {
          const n = this.addActions(d.actions, 'u');
          if (n.added)  this.note('Codex 追加 ' + n.added + ' 項待核准操作');
          if (n.merged) this.note('Codex 更新 ' + n.merged + ' 項已存在的操作（沒有重複開單）');
          if (n.added && this.m.phase > 3) this.m.phase = 3;
        }
        if (d && Array.isArray(d.deliverables) && d.deliverables.length) {
          const n = this.addDeliverables(d.deliverables, 'ucd');
          if (n.added) this.note('Codex 追加 ' + n.added + ' 項待你人工交件');
          if (n.merged) this.note('Codex 更新 ' + n.merged + ' 項已存在的人工交件（沒有重複開單）');
          if (n.invalid) this.note('未建立 ' + n.invalid + ' 項規格不完整的圖片交件：' + n.issues.join('；'));
        }
      });
      return;
    }

    await this.busy('Claude 回覆中', async () => {
      const r = await this.ask.claude(this.cfg, this.focusPrompt(P.claudeReplyPrompt(text, this.transcriptText(), files)), this.ws, this.onLog, { images: imgs });
      if (!r.ok) return this.fail('Claude', r);
      const d = r.data;
      this.say('claude', 'Claude', '策劃者', {
        prose: (d && d.summary) || r.prose, fields: d && d.fields, plain: d && d.plain,
        options: d && d.options && d.options.length ? d.options : null,
        raw: d ? null : r.raw, parseError: r.parseError
      });
      this.ping('decide', 'Claude 回覆了：' + String((d && d.summary) || r.prose || '').slice(0, 160));
      if (d) {
        if (Array.isArray(d.options) && d.options.length) { this.m.options = d.options; this.m.chosen = null; this.m.phase = 3; }
        if (Array.isArray(d.risks) && d.risks.length) this.m.risks = this.m.risks.concat(d.risks);
        if (Array.isArray(d.deliverables) && d.deliverables.length) {
          const n = this.addDeliverables(d.deliverables, 'ud');
          if (n.added)  this.note('新增 ' + n.added + ' 項待你交件');
          if (n.merged) this.note('更新 ' + n.merged + ' 項已存在的待交件（沒有重複開單）');
          if (n.invalid) this.note('未建立 ' + n.invalid + ' 項規格不完整的圖片交件：' + n.issues.join('；'));
        }
      }
    });
  }

  /* ---------- 2. 選方案 ---------- */
  // 選定方案後自動請 Codex 依方案開工單。
  // 以前選完方案什麼都不會發生：右欄的卡片是 Codex 在你選方案「之前」開的，跟你選的方案不一定對得上，
  // 而且會中 Claude 重新給方案時根本不會有新卡。使用者得再打一句話 Codex 才動——這就是「選了不會進行」的原因。
  async choose(id) {
    const o = this.m.options.find(x => x.id === id);
    if (!o) return { ok: false, msg: '找不到這個方案' };
    this.m.chosen = id;
    this.note('選定：' + o.title);
    this.m.phase = 4;
    this.push();
    if (this.m.busy) {
      this.note('目前有工作在跑，等它結束後請對 Codex 說「依方案開單」');
      return { ok: true, planned: false };
    }

    await this.busy('Codex 依方案開單中', async () => {
      const ask = '我選定方案 ' + o.id + '「' + o.title + '」' + (o.desc ? '：' + o.desc : '') + '\n'
        + '請照這個方案實際檢查專案，把要做的操作一項一項列成待核准工單（actions），每一項標風險等級。'
        + '已經在待處理清單裡而且仍適用的工單不要重開；跟這個方案無關的不要列；需要我人工交件的放 deliverables。';
      const r = await this.ask.codex(this.cfg, this.focusPrompt(P.codexReplyPrompt(ask, this.transcriptText(), [])), this.ws, 'read', this.onLog);
      if (!r.ok) return this.fail('Codex', r);
      const d = r.data;
      this.say('codex', 'Codex', '執行者', {
        prose: (d && d.summary) || r.prose, fields: d && d.fields,
        raw: d ? null : r.raw, parseError: r.parseError
      });
      let opened = 0;
      if (d && Array.isArray(d.actions) && d.actions.length) {
        const n = this.addActions(d.actions, 'o');
        opened = n.added + n.merged;
        if (n.added)  this.note('Codex 依方案「' + o.title + '」開了 ' + n.added + ' 項待核准工單');
        if (n.merged) this.note('Codex 更新 ' + n.merged + ' 項已存在的工單（沒有重複開單）');
      }
      if (d && Array.isArray(d.deliverables) && d.deliverables.length) {
        const n = this.addDeliverables(d.deliverables, 'od');
        opened += n.added + n.merged;
        if (n.added) this.note('Codex 追加 ' + n.added + ' 項待你交件');
        if (n.invalid) this.note('未建立 ' + n.invalid + ' 項規格不完整的圖片交件：' + n.issues.join('；'));
      }
      if (opened) this.m.phase = 3;
      else this.note('Codex 認為方案「' + o.title + '」不需要新工單');
      this.ping('decide', '你選了方案「' + o.title + '」，Codex 開了 ' + opened + ' 張卡等你核准。');
    });
    return { ok: true, planned: true };
  }

  /* ---------- 3. 核准／拒絕 ---------- */
  /* ---------- 清單去重與移除 ---------- */
  // 標題正規化：去掉括號補述、標點、空白，只留字，用來判斷「是不是同一件事」
  normTitle(t) {
    return String(t || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s·、，,。.：:；;－\-_—「」『』"'`]/g, '')
      .toLowerCase();
  }

  // 判斷兩個標題是不是在講同一件事。AI 每次換句話說（「四位參與者的頭像」／「四位參與者頭像（自動產圖）」）
  // 都會開新單，所以不能只比字串相等：用「包含」＋雙字元 Dice 相似度 0.65，並要求開頭兩字相同以免誤合。
  sameTitle(a, b) {
    const x = this.normTitle(a), y = this.normTitle(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.slice(0, 2) !== y.slice(0, 2)) return false;
    if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
    const bi = t => { const o = []; for (let i = 0; i < t.length - 1; i++) o.push(t.slice(i, i + 2)); return o; };
    const A = bi(x), B = bi(y);
    if (!A.length || !B.length) return false;
    const pool = B.slice();
    let hit = 0;
    for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { pool.splice(i, 1); hit++; } }
    return (2 * hit) / (A.length + B.length) >= 0.65;
  }

  // 新增待交件：同名的（還沒完成、沒被丟掉的）就更新內容，不再開新單
  addDeliverables(list, prefix) {
    let added = 0, merged = 0, invalid = 0;
    const issues = [];
    for (const item of list) {
      const x = asManualDeliverable(item);
      const missing = imageDeliveryIssues(x);
      if (missing.length) {
        invalid++;
        issues.push((x.title || '未命名圖片交件') + '缺少：' + missing.join('、'));
        continue;
      }
      if (!prepareDeliverableFolder(this.ws, x)) {
        invalid++;
        issues.push((x.title || '未命名交件') + '的存放路徑不安全或無法建立');
        continue;
      }
      const old = this.m.deliverables.find(d =>
        this.sameTitle(d.title, x.title) && d.status !== 'delivered' && d.status !== 'dropped');
      if (old) {
        // 保留 id / status / 產圖結果，只更新描述與規格
        if (x.say) old.say = x.say;
        if (x.specs) old.specs = x.specs;
        if (x.path) old.path = x.path;
        old.tool = 'manual';
        old.deliveryMode = 'manual';
        if (x.blockedReason) old.blockedReason = x.blockedReason;
        delete old.producer;
        if (old.status === 'failed' || old.status === 'generating') old.status = 'waiting';
        merged++;
      } else {
        this.m.deliverables.push(Object.assign({ status: 'waiting' }, x, { id: prefix + (++uid) }));
        added++;
      }
    }
    return invalid ? { added, merged, invalid, issues } : { added, merged };
  }

  // 新增待核准操作：同名的（還在 pending）就更新，不再開新單
  addActions(list, prefix) {
    let added = 0, merged = 0;
    for (const x of list) {
      const old = this.m.actions.find(a => this.sameTitle(a.title, x.title) && a.status === 'pending');
      if (old) {
        const manualSelection = old.modelOverride
          ? { codexModel: old.codexModel, reasoningEffort: old.reasoningEffort, modelOverride: true }
          : null;
        Object.assign(old, x, { id: old.id, status: 'pending' }, manualSelection || {});
        merged++;
      }
      else { this.m.actions.push(Object.assign({ status: 'pending' }, x, { id: prefix + (++uid) })); added++; }
    }
    return { added, merged };
  }

  updateActionModel(id, selection) {
    const action = this.m.actions.find(item => item.id === id);
    if (!action) return { ok: false, code: 'ACTION_NOT_FOUND', msg: '找不到這張工單' };
    if (action.status !== 'pending') {
      return { ok: false, code: 'ACTION_MODEL_LOCKED', msg: '只有待核准工單可以更改模型；進行中或已結束的工單不能中途換檔' };
    }
    const candidate = {
      ...action,
      codexModel: typeof selection?.model === 'string' ? selection.model : '',
      reasoningEffort: typeof selection?.effort === 'string' ? selection.effort : ''
    };
    const validated = codexSelectionForAction(this.cfg, candidate);
    if (!validated.ok) return validated;
    action.codexModel = validated.selection.model;
    action.reasoningEffort = validated.selection.effort;
    action.modelOverride = true;
    delete action.lastError;
    this.note('手動調整工單 ' + action.id + '：' + action.codexModel + '，思考深度 ' + action.reasoningEffort);
    return { ok: true, action };
  }

  // 「這件不用了」：從待處理清單移走，但不刪紀錄
  drop(id) {
    const d = this.m.deliverables.find(x => x.id === id);
    const a = this.m.actions.find(x => x.id === id);
    const t = d || a;
    if (!t) return { ok: false, msg: '找不到這個項目' };
    if (t.status === 'delivered' || t.status === 'done' || t.status === 'running' || t.status === 'generating')
      return { ok: false, msg: '已完成或正在跑的項目不能移除' };
    t.status = 'dropped';
    this.note('移除：' + t.title);
    return { ok: true };
  }

  reject(id) {
    const a = this.m.actions.find(x => x.id === id);
    if (!a || a.status !== 'pending') return;
    a.status = 'rejected';
    this.note('拒絕：' + a.title);
    this.say('codex', 'Codex', '執行者', { prose: '收到，已從執行佇列移除「' + a.title + '」。' });
  }

  async approve(id, opts = {}) {
    if (this.m.batch && !opts.fromBatch)
      return this.reportError('核准執行失敗', '批次核准正在進行，等它跑完再核准單項');
    const a = this.m.actions.find(x => x.id === id);
    if ((!a || a.status !== 'pending') && !this.m.actions.some(x => x.status === 'pending'))
      return this.reportError('執行請求失敗', '執行佇列目前為空，沒有可執行的工單');
    if (!a) return this.reportError('核准執行失敗', '找不到工單 ' + id);
    if (a.status !== 'pending') return this.reportError('核准執行失敗', '工單目前狀態是 ' + a.status);
    if (this.m.busy) return this.reportError('核准執行失敗', '目前有另一項工作正在執行');

    this.refreshModels();
    const modelSelection = codexSelectionForAction(this.cfg, a);
    if (!modelSelection.ok) {
      a.lastError = modelSelection.msg;
      this.push();
      return this.reportError('核准執行失敗', modelSelection.msg);
    }
    if (modelSelection.substituted && modelSelection.source === 'action') {
      // 工單原本指定的模型不能用了：記下實際改用的模型，卡片和紀錄才對得起來。
      a.codexModel = modelSelection.selection.model;
      a.reasoningEffort = modelSelection.selection.effort;
      a.modelNotice = modelSelection.notice;
      this.note(modelSelection.notice);
    }

    // 工單路徑是以「目前處理的子專案」為基準寫的（例如 public/index.html），
    // 但安全檢查、還原點與越界比對都以固定根目錄為準，這裡先換算成根目錄相對路徑。
    if (Array.isArray(a.files) && a.files.length === 0) {
      return await this.runVerifyOnly(a, modelSelection.selection, opts);
    }

    const mapped = await this.rootRelativeFiles(a.files);
    const scopedFiles = mapped.ok ? mapped.files : a.files;
    const scope = mapped.ok
      ? approvedWriteScope({ root: this.ws, files: scopedFiles })
      : { ok: false, paths: [], error: mapped.error };
    if (!scope.ok) {
      a.status = 'failed';
      a.lastError = '核准路徑檢查失敗，這次沒有呼叫 Codex：' + scope.error
        + '\n工單列的檔案不會自己改變，按「重試」只會得到同樣結果。確認這件已經不需要就按「這件不用了」；還需要的話，請 Claude 依目前檔案狀態重開一張工單。';
      a.result = { summary: '執行前安全檢查失敗', outOfScope: '核准清單本身無效', tests: '未執行' };
      this.push();
      return this.reportError('核准執行失敗', a.lastError);
    }
    a.status = 'running'; this.push();

    // 沒有還原點就不准動手。這是整套核准機制唯一的退路，
    // 存不進去卻照跑，等於使用者在沒有安全網的情況下按下核准。
    let cp;
    try { cp = await checkpoint(this.ws, a.title, scope.paths); }
    catch (e) { cp = { ok: false, hash: '', error: String(e && e.message || e) }; }
    if (!cp.ok) {
      a.status = 'pending';
      a.lastError = '還原點沒有建立成功，這次沒有執行：' + (cp.error || '原因不明');
      this.push();
      return this.reportError('核准執行失敗',
        '建立還原點失敗，為了安全起見這次沒有動任何檔案。\n\n原因：' + (cp.error || '原因不明')
        + '\n\n最常見的是 .git 裡留下了鎖檔。在終端機執行：\n'
        + 'rm -f "' + this.ws + '/.git/"*.lock "' + this.ws + '/.git/objects/maintenance.lock"\n'
        + '清掉之後再按一次核准就可以了。');
    }
    this.m.checkpoints.push({
      hash: cp.hash, repos: cp.repos, watchRepos: cp.watchRepos, files: cp.files,
      label: a.title, time: now()
    });
    this.note('核准：' + a.title);

    const execution = await this.busy('Codex 執行中：' + a.title, async () => {
      const r = await this.ask.codex(this.cfg, this.focusPrompt(P.codexExecutePrompt({ ...a, files: scopedFiles }, this.transcriptText())), this.ws, 'write', this.onLog, {
        selection: modelSelection.selection,
        approvedWritePaths: scope.paths
      });
      if (!r.ok) {
        a.status = 'failed';
        a.lastError = Orchestrator.explainCliFailure(r).slice(0, 2000);
        a.result = { summary: '執行失敗' };
        this.push();
        return this.fail('Codex', r, a.lastError);
      }
      const d = r.data || {};
      const changed = await changedPathsSince(this.ws, cp);
      if (!changed.ok) {
        a.status = 'failed';
        a.lastError = '執行後無法檢查實際改動，工單停止：' + changed.error;
        a.result = { summary: '無法確認寫入範圍', outOfScope: '無法確認', tests: d.tests || '未回報' };
        this.push();
        return this.reportError('工單安全檢查失敗', a.lastError);
      }
      const outside = changed.paths.filter(file => !withinApprovedScope(file, scope));
      if (outside.length) {
        const rolledBack = await restoreTaskChanges(this.ws, cp, changed.untracked);
        a.status = 'failed';
        a.lastError = '偵測到未核准改動：' + outside.join('、')
          + (rolledBack.ok ? '。這張工單造成的變更已全部回復。' : '。自動回復失敗：' + rolledBack.error);
        a.result = {
          summary: '工單因修改未核准檔案而停止',
          outOfScope: outside.join('、'),
          tests: d.tests || '未回報',
          note: rolledBack.ok ? '已回到本工單執行前的還原點' : '需要人工檢查還原狀態',
          stat: '', hash: cp.hash
        };
        this.push();
        this.say('codex', 'Codex', '執行者', {
          prose: a.result.summary,
          fields: {
            '已停止': a.title,
            '越界路徑': outside.join('、'),
            '回復結果': rolledBack.ok ? '已回復這次全部變更' : '回復失敗：' + rolledBack.error,
            '還原點': cp.hash
          }
        });
        this.ping('error', a.id + '「' + a.title + '」碰到未核准路徑，已停止。');
        return { ok: false, msg: a.lastError };
      }
      const df = await diffSince(this.ws, cp);
      a.status = 'done';
      a.result = {
        summary: d.summary || r.prose || '已完成',
        outOfScope: d.outOfScope || '未回報',
        tests: d.tests || '未回報',
        note: d.note || '',
        stat: df.stat, hash: cp.hash
      };
      this.say('codex', 'Codex', '執行者', {
        prose: a.result.summary,
        fields: {
          '已完成': a.title,
          '實際改動': df.stat || '無變更',
          '有無超出範圍': a.result.outOfScope,
          '測試結果': a.result.tests,
          '還原點已保存': (cp.files && cp.files.length) ? cp.files.join('\n') : '這次建立空還原點，沒有待存檔案',
          '還原點': cp.hash + '（可一鍵回復）'
        }
      });
      this.m._lastDiff = df.full;
      this.ping('done', a.id + '「' + a.title + '」執行完成。'
        + (df.stat ? '改動：' + df.stat.trim().split('\n').pop().trim() : '沒有改動任何檔案。'));
    });

    if (execution && execution.ok === false && a.status === 'running') {
      a.status = 'failed';
      a.lastError = execution.msg || '執行失敗';
      this.push();
    }

    if (!opts.deferReview && this.openCount() === 0) await this.review();
    return { ok: true };
  }

  /* ---------- 3.5 批次核准 ---------- */
  // 一次核准好幾張卡，依序執行，每一張都有自己的還原點（跟單張核准完全一樣的流程）。
  // 中途有一張失敗就停下來：後面的工單常常建立在前面的結果上，硬跑等於在壞掉的地基上蓋。
  // 留在待處理的卡片不動，使用者看完失敗原因後可以重試或再批次一次。
  async approveMany(ids, label = '批次核准') {
    if (this.m.busy || this.m.batch) return this.reportError('批次核准失敗', '目前有另一項工作正在執行');
    const wanted = Array.isArray(ids) ? ids.map(String) : [];
    const queue = this.m.actions.filter(a => a.status === 'pending' && wanted.includes(a.id));
    if (!queue.length) return this.reportError('批次核准失敗', '沒有可核准的待處理工單');

    this.m.batch = { total: queue.length, index: 0, current: '', done: 0, failed: 0, stopped: false };
    this.note(label + '：' + queue.length + ' 項，依序執行');
    this.push();

    const result = { ok: true, total: queue.length, done: 0, failed: 0, skipped: [] };
    try {
      for (let i = 0; i < queue.length; i++) {
        const a = queue[i];
        if (a.status !== 'pending') { result.skipped.push(a.id); continue; }
        this.m.batch.index = i + 1; this.m.batch.current = a.title; this.push();
        await this.approve(a.id, { fromBatch: true, deferReview: true });
        if (a.status === 'done') { result.done++; this.m.batch.done++; continue; }
        result.failed++; this.m.batch.failed++; this.m.batch.stopped = true; result.ok = false;
        const rest = queue.slice(i + 1).filter(x => x.status === 'pending').map(x => x.id);
        result.skipped.push(...rest);
        this.note('批次核准中止：「' + a.title + '」失敗，後面 ' + rest.length + ' 項留在待處理');
        break;
      }
    } finally {
      this.m.batch = null;
      this.push();
    }
    if (result.ok) this.note('批次核准完成：' + result.done + ' 項全部做完');
    result.msg = result.ok
      ? '批次核准完成：' + result.done + ' 項全部做完'
      : '批次核准中止：做完 ' + result.done + ' 項，1 項失敗，' + result.skipped.length + ' 項留在待處理';
    if (this.openCount() === 0) await this.review();
    return result;
  }

  // risk 給 'low' 就只核准低風險；不給就是全部待處理。
  approveAll(risk) {
    const ids = this.m.actions.filter(a => a.status === 'pending' && (!risk || a.risk === risk)).map(a => a.id);
    return this.approveMany(ids, risk ? '批次核准（' + risk + ' 風險）' : '批次核准全部待處理');
  }

  // 「其實做完了」：Codex 跑超過時限被砍，但檔案早就寫進磁碟（a3、a5 都是這樣）。
  // 這裡不重跑 Codex，只拿還原點之後的 diff 當結果，把卡片標成完成。沒有任何改動就拒絕，避免誤標。
  async markDone(id) {
    const a = this.m.actions.find(x => x.id === id);
    if (!a) return { ok: false, msg: '找不到工單 ' + id };
    if (a.status !== 'failed') return { ok: false, msg: '只有執行失敗的工單可以標成完成' };
    const cp = [...this.m.checkpoints].reverse().find(c => c.label === a.title);
    if (!cp) return { ok: false, msg: '找不到這張卡的還原點，無法確認改了什麼' };
    const df = await diffSince(this.ws, cp);
    if (!df.stat) return { ok: false, msg: '從還原點 ' + cp.hash + ' 之後沒有任何檔案改動，看起來真的沒做' };
    a.status = 'done';
    a.lastError = '';
    a.result = { summary: '逾時被中斷，但改動已在磁碟上；由你確認後標成完成', outOfScope: '未回報（逾時）', tests: '未回報（逾時），請自行跑測試', note: '', stat: df.stat, hash: cp.hash };
    this.m._lastDiff = df.full;
    this.note('標成完成（逾時但改動已落地）：' + a.title);
    this.say('system', '會議室', '系統', {
      prose: '你確認「' + a.title + '」雖然逾時，但改動已經在磁碟上，已標成完成。',
      fields: { '實際改動': df.stat, '還原點': cp.hash + '（可一鍵回復）' }
    });
    this.push();
    if (this.openCount() === 0) await this.review();
    return { ok: true, stat: df.stat };
  }

  // 沒有列出任何檔案的工單＝只跑檢查、不准改檔。
  // 不建立還原點（避免把其他未存檔工作一起提交），改用前後指紋比對確認沒有動到任何東西。
  // 會議室自己執行中會寫的檔案（會議紀錄、pid、重啟記號），比對時要排除。
  ownRuntimePaths() {
    const base = this.saveRoot ? path.relative(path.resolve(this.ws), path.resolve(this.saveRoot)) : null;
    if (base === null || base.startsWith('..') || path.isAbsolute(base)) return { dirs: [], files: [] };
    const rel = value => (base ? base.split(path.sep).join('/') + '/' : '') + value;
    return {
      dirs: [rel('meetings/')],
      files: [rel('.meeting-room-server.pid'), rel('server/.restart-token'), rel('.recent-workspaces.json'), rel('config.json')]
    };
  }

  async runVerifyOnly(a, selection, opts = {}) {
    const before = await workingSnapshot(this.ws);
    if (!before.ok) {
      a.status = 'failed';
      a.lastError = '讀不到目前檔案狀態，這次沒有呼叫 Codex：' + before.error;
      this.push();
      return this.reportError('核准執行失敗', a.lastError);
    }
    a.status = 'running'; this.push();
    this.note('核准（只驗證）：' + a.title);
    const execution = await this.busy('Codex 驗證中：' + a.title, async () => {
      const prompt = P.codexExecutePrompt(a, this.transcriptText())
        + '\n\n本工單是「只驗證」工單：只能執行檢查與測試指令，不得修改、新增、刪除或重新命名工作區內任何檔案。'
        + '系統會在執行前後比對所有檔案，只要有變動就判定失敗。';
      const r = await this.ask.codex(this.cfg, this.focusPrompt(prompt), this.ws, 'write', this.onLog, {
        selection, approvedWritePaths: []
      });
      if (!r.ok) {
        a.status = 'failed';
        a.lastError = Orchestrator.explainCliFailure(r).slice(0, 2000);
        a.result = { summary: '執行失敗' };
        this.push();
        return this.fail('Codex', r, a.lastError);
      }
      const d = r.data || {};
      const after = await workingSnapshot(this.ws);
      const own = this.ownRuntimePaths();
      const changed = after.ok
        ? snapshotDiff(before, after).filter(k => !own.files.includes(k) && !own.dirs.some(d => k.startsWith(d)))
        : null;
      if (!changed || changed.length) {
        a.status = 'failed';
        a.lastError = changed
          ? '只驗證工單卻改動了檔案：' + changed.join('、') + '。沒有還原點可自動回復，請人工檢查。'
          : '執行後無法確認檔案狀態：' + after.error;
        a.result = { summary: '只驗證工單出現檔案變動', outOfScope: changed ? changed.join('、') : '無法確認', tests: d.tests || '未回報' };
        this.push();
        this.ping('error', a.id + '「' + a.title + '」只驗證卻動到檔案，請檢查。');
        return this.reportError('工單安全檢查失敗', a.lastError);
      }
      a.status = 'done';
      a.result = {
        summary: d.summary || r.prose || '已完成',
        outOfScope: d.outOfScope || '無',
        tests: d.tests || '未回報',
        note: d.note || '',
        stat: '只驗證，沒有改動檔案', hash: ''
      };
      this.say('codex', 'Codex', '執行者', {
        prose: a.result.summary,
        fields: { '已完成': a.title, '實際改動': '無（只驗證）', '測試結果': a.result.tests }
      });
      this.ping('done', a.id + '「' + a.title + '」驗證完成。');
    });
    if (execution && execution.ok === false && a.status === 'running') {
      a.status = 'failed';
      a.lastError = execution.msg || '執行失敗';
      this.push();
    }
    if (!opts.deferReview && this.openCount() === 0) await this.review();
    return { ok: true };
  }

  async retry(id) {
    const a = this.m.actions.find(x => x.id === id);
    const d = this.m.deliverables.find(x => x.id === id);
    if (this.m.busy) return this.reportError('重試失敗', '目前有另一項工作正在執行');
    if (a && a.status === 'failed') {
      // 只把這一項放回執行佇列；既有失敗紀錄會保留在會議紀錄中。
      a.status = 'pending';
      this.note('重新嘗試：' + a.title);
      this.push();
      return await this.approve(id);
    }
    if (d && d.status === 'failed') {
      d.status = 'waiting';
      this.note('重新產圖：' + d.title);
      this.push();
      return await this.generateAsset(id, '');
    }
    return this.reportError('重試失敗', '找不到 failed 工單 ' + id);
  }

  async retryAll() {
    if (this.m.busy) return this.reportError('全部重試失敗', '目前有另一項工作正在執行');
    const ids = [
      ...this.m.actions.filter(x => x.status === 'failed').map(x => x.id),
      ...this.m.deliverables.filter(x => x.status === 'failed').map(x => x.id)
    ];
    if (!ids.length) return this.reportError('全部重試失敗', '目前沒有 failed 工單可重新排入佇列');
    let count = 0;
    for (const id of ids) {
      const r = await this.retry(id);
      if (r && r.ok) count++;
    }
    const remaining = this.m.actions.filter(x => x.status === 'failed').length +
      this.m.deliverables.filter(x => x.status === 'failed').length;
    return { ok: remaining === 0, count, remaining, msg: remaining ? '仍有 ' + remaining + ' 項失敗' : '全部重試完成' };
  }

  openCount() {
    return this.m.actions.filter(a => a.status === 'pending' || a.status === 'failed').length +
           this.m.deliverables.filter(d => d.status === 'waiting' || d.status === 'failed').length;
  }

  /* ---------- 4. Claude 審查 ---------- */
  async review() {
    this.m.phase = 5; this.push();
    await this.busy('Claude 審查中', async () => {
      const diff = this.m._lastDiff || '（本次沒有取得 diff）';
      const r = await this.ask.claude(this.cfg, this.focusPrompt(P.claudeReviewPrompt(diff, this.transcriptText())), this.ws, this.onLog);
      if (!r.ok) return this.fail('Claude', r);
      const d = r.data;
      this.say('claude', 'Claude', '策劃者', {
        prose: (d && d.summary) || r.prose,
        fields: d && d.fields, plain: d && d.plain
      });
      this.note('Claude 審查完成');
      this.m.phase = 6;
    });
  }

  /* ---------- 5. 素材：第一版只保留人工交件 ---------- */
  async generateAsset(id, feedback) {
    const d = this.m.deliverables.find(x => x.id === id);
    if (!d) return { ok: false, code: 'DELIVERABLE_NOT_FOUND', msg: '找不到交件項目 ' + id };

    d.status = 'waiting';
    d.tool = 'manual';
    d.deliveryMode = 'manual';
    d.blockedReason = MANUAL_IMAGE_BLOCKER;
    if (feedback) d.feedback = String(feedback).trim();
    delete d.producer;
    delete d.by;
    this.note('停在人工交件：' + d.title);
    this.push();

    return {
      ok: false,
      blocked: true,
      code: 'MANUAL_DELIVERY_REQUIRED',
      msg: '外部產圖工具尚未完成獨立入口與授權驗證，因此沒有呼叫 Claude、Codex 或 Magnific。請依交件規格在外部完成後，把成品放到 ' + (d.path || '交件卡指定的路徑') + '。'
    };
  }

  setImageBy() {
    return {
      ok: false,
      blocked: true,
      code: 'AI_IMAGE_PRODUCER_FORBIDDEN',
      msg: 'Claude 與 Codex 都不負責產圖；目前只提供完整規格與明確路徑的人工交件。'
    };
  }

  assetDecide(id, ok, feedback) {
    const d = this.m.deliverables.find(x => x.id === id);
    if (!d) return this.reportError('素材決議失敗', '找不到工單 ' + id);
    if (ok) {
      d.status = 'delivered';
      this.note('採用視覺：' + d.title);
      this.say('user', '你', '決策者', { prose: '這版可以，就用這張。' });
      return { ok: true };
    }
    this.say('user', '你', '決策者', { prose: '這版不行。' + (feedback || '請重做。') });
    d.status = 'waiting';
    d.tool = 'manual';
    d.deliveryMode = 'manual';
    d.blockedReason = MANUAL_IMAGE_BLOCKER;
    d.feedback = String(feedback || '請重做。').trim();
    delete d.file;
    delete d.producer;
    delete d.by;
    this.note('改為人工重新交件：' + d.title);
    this.push();
    return { ok: true, manual: true, msg: '已退回人工交件，請依修改意見重新製作後放入指定路徑。' };
  }

  /* ---------- 6. 交件插槽（手動備援） ---------- */
  markDelivered(id) {
    const d = this.m.deliverables.find(x => x.id === id);
    if (!d) return { ok: false, msg: '找不到這個項目' };
    const relDir = ((d.path || '.').trim() || '.').replace(/\/$/, '');
    const safeDirectory = resolveWritablePath({
      root: this.ws,
      requestedPath: relDir,
      forbiddenRoots: [path.join(this.ws, '.secrets')]
    });
    if (!safeDirectory) return { ok: false, msg: '交件目標不在可寫範圍，請修正交件規格' };
    const safeRelDir = path.relative(this.ws, safeDirectory).replace(/\\/g, '/');
    const target = path.resolve(safeDirectory);
    let found = null;
    if (existsSync(target)) {
      const st = statSync(target);
      if (st.isFile()) {
        found = { name: path.basename(target), size: st.size, rel: safeRelDir };
      } else {
        // 資料夾裡可能有好幾個檔（包含上一次交錯型別的殘留），
        // 先挑型別對的，再挑最新的，不要盲抓 readdir 的最後一個。
        const wantKind = P.assetKind('x.' + P.guessAssetExt(d));
        const files = readdirSync(target)
          .filter(f => !f.startsWith('.'))
          .map(f => ({ f, st: statSync(path.join(target, f)) }))
          .filter(x => x.st.isFile());
        const sameKind = files.filter(x => P.assetKind(x.f) === wantKind);
        const pool = sameKind.length ? sameKind : files;
        pool.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
        if (pool.length) {
          found = { name: pool[0].f, size: pool[0].st.size, rel: path.posix.join(safeRelDir, pool[0].f) };
        }
      }
    }
    if (!found) {
      // 最常見的放錯：檔名對了，但少放進一層子資料夾（要 docs/assets/x.png，放成 docs/x.png）。
      // 不自動搬，只把找到的位置講清楚，讓使用者自己移。
      const want = path.basename(relDir);
      const upper = path.resolve(this.ws, path.dirname(relDir), want);
      const nearby = /\.[a-z0-9]{2,4}$/i.test(want) && upper !== target && existsSync(upper) && statSync(upper).isFile()
        ? path.posix.join(path.posix.dirname(relDir).split('/').slice(0, -1).join('/') || '.', want)
        : '';
      return { ok: false, msg: '在 ' + (d.path || '(未指定路徑)') + ' 裡找不到檔案'
        + (nearby ? '，但 ' + nearby + ' 有一個同名檔——少放進一層資料夾了，把它移到 ' + path.posix.dirname(relDir) + '/ 再按一次。' : '，請確認有放進去。') };
    }
    d.status = 'delivered';
    d.file = found;
    this.note('交件完成：' + d.title);
    this.say('codex', 'Codex', '執行者', {
      prose: '已偵測到你放進來的檔案。',
      fields: { '檔案': found.rel || found.name, '大小': Math.round(found.size / 1024) + ' KB', '下一步': '等你核准後置入' }
    });
    return { ok: true };
  }

  // 直接用打的回答一張交件卡。
  // 為什麼要有這個：很多交件其實只是「請你回答一句話」（你選哪個做法、你的位址是多少），
  // 但交件卡天生是為檔案設計的，使用者得去開檔案總管、建資料夾、打八個字、存檔、再回來按按鈕。
  // 這裡讓他在卡片上打字，伺服器代勞寫檔，AI 那邊拿到的東西完全一樣。
  answerDeliverable(id, text) {
    const d = this.m.deliverables.find(x => x.id === id);
    if (!d) return { ok: false, msg: '找不到這個項目' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, msg: '還沒有寫任何內容' };

    const rel = d.path && /\.[a-z0-9]{2,4}$/i.test(d.path)
      ? d.path
      : path.posix.join((d.path || 'meetings/deliverables').replace(/\/$/, ''), d.id + '.txt');
    const abs = resolveWritablePath({
      root: this.ws,
      requestedPath: rel,
      forbiddenRoots: [path.join(this.ws, '.secrets')]
    });
    if (!abs) return { ok: false, msg: '交件路徑不在可寫範圍，請調整交件規格' };
    const safeRel = path.relative(this.ws, abs).replace(/\\/g, '/');

    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body.endsWith('\n') ? body : body + '\n', 'utf8');
    const st = statSync(abs);

    // 密鑰類的內容絕對不進會議紀錄：紀錄最後會存成 markdown、會進 git、會被 AI 讀。
    const secret = /(^|\/)\.secrets\//.test(safeRel);
    d.status = 'delivered';
    d.file = { name: path.basename(abs), size: st.size, rel: safeRel };
    d.by = '你';
    this.note('交件完成：' + d.title);
    this.say('system', '會議室', '系統', {
      prose: secret
        ? '收到，已經寫進 ' + rel + '。內容不會出現在會議紀錄裡。'
        : '收到，已經幫你寫進 ' + rel + '。',
      fields: secret
        ? { '檔案': rel, '內容': '（密鑰類，不記錄）' }
        : { '檔案': rel, '你寫的': body.slice(0, 300) }
    });
    this.push();
    return { ok: true, rel };
  }

  /* ---------- 6. 還原 ---------- */
  async undo(hash) {
    const h = hash || (this.m.checkpoints[this.m.checkpoints.length - 1] || {}).hash;
    if (!h) return { ok: false, msg: '沒有可用的還原點' };
    const saved = this.m.checkpoints.find(c => c.hash === h);
    const ok = await restore(this.ws, saved || h);
    if (ok) {
      this.note('已回復到還原點 ' + h);
      this.say('system', '會議室', '系統', { prose: '已把工作區回復到還原點 ' + h + '。檔案已還原，會議紀錄保留。' });
    }
    return { ok, msg: ok ? '已回復' : '回復失敗' };
  }

  /* ---------- 7. 白話解釋 ---------- */
  // 白話解釋的退回鏈：explainBy 決定從哪裡開始。
  //   ollama → Ollama（PC 本機模型，免費）→ Gemini → Claude
  //   gemini → Gemini → Claude
  //   claude → Claude
  // 前面的沒設定、連不上、逾時或吐空白，就往後退，會議不受影響。
  // 回傳 { text, by, fallback }：by 告訴畫面是誰翻的，fallback 表示不是第一順位翻的。
  explainChain() {
    const cfg = this.cfg;
    const has = {
      ollama: !!(cfg.ollama && cfg.ollama.url),
      gemini: !!(cfg.gemini && cfg.gemini.bin),
      claude: true
    };
    const start = cfg.explainBy || 'claude';
    const order = start === 'ollama' ? ['ollama', 'gemini', 'claude'] : start === 'gemini' ? ['gemini', 'claude'] : ['claude'];
    return order.filter(k => has[k]);
  }

  async explain(text) {
    const prompt = P.claudeExplainPrompt(text);
    const chain = this.explainChain();
    const label = { ollama: 'Ollama', gemini: 'Gemini', claude: 'Claude' };
    for (let i = 0; i < chain.length; i++) {
      const who = chain[i];
      let r;
      try { r = await this.ask[who](this.cfg, this.focusPrompt(prompt), this.ws, null); }
      catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      const out = r && r.ok ? String(r.prose || r.raw || '').trim() : '';
      if (out) return { text: out, by: who, fallback: i > 0, model: r.model || '' };
      const next = chain[i + 1];
      const why = String(r && r.error || '沒有輸出').split('\n')[0].slice(0, 160);
      if (next) console.error('  ' + label[who] + ' 白話解釋失敗，改用 ' + label[next] + '：' + why);
      else return { text: '解釋失敗：' + why, by: who, fallback: i > 0 };
    }
    return { text: '解釋失敗：沒有任何可用的翻譯來源', by: 'claude', fallback: false };
  }

  /* ---------- 8. 產出決議 ---------- */
  markdown() {
    const m = this.m;
    const L = [];
    L.push('# 會議決議 — ' + (m.goal || '未命名'));
    L.push('');
    L.push('- 會議編號：' + m.id);
    L.push('- 開始時間：' + m.startedAt);
    L.push('- 產出時間：' + new Date().toISOString());
    const ch = m.options.find(o => o.id === m.chosen);
    L.push('- 採用方案：' + (ch ? ch.title : '未選定'));
    L.push('');
    L.push('## 決策紀錄');
    m.decisions.forEach(d => L.push('- `' + d.time + '` ' + d.text));
    L.push('');
    L.push('## 已執行');
    m.actions.filter(a => a.status === 'done').forEach(a => {
      L.push('- **' + a.title + '**（還原點 ' + (a.result && a.result.hash) + '）');
      if (a.result) {
        L.push('  - 改動：' + (a.result.stat || '無').replace(/\n/g, ' / '));
        L.push('  - 測試：' + a.result.tests);
        L.push('  - 超出範圍：' + a.result.outOfScope);
      }
    });
    L.push('');
    L.push('## 已拒絕');
    m.actions.filter(a => a.status === 'rejected').forEach(a => L.push('- ' + a.title));
    L.push('');
    L.push('## 待辦（尚未處理）');
    m.actions.filter(a => a.status === 'pending').forEach(a => L.push('- [ ] `' + a.id + '` ' + a.title + '（' + a.risk + '）'));
    m.deliverables.filter(d => d.status === 'waiting').forEach(d => L.push('- [ ] `' + d.id + '` 交件：' + d.title + ' → ' + d.path));
    L.push('');
    L.push('## 風險');
    m.risks.forEach(r => L.push('- `' + r.level + '` **' + r.title + '** — ' + r.desc));
    L.push('');
    L.push('## 完整會議紀錄');
    m.transcript.forEach(t => {
      L.push('');
      L.push('### ' + t.name + '（' + t.role + '） ' + t.time);
      if (t.prose) L.push(t.prose);
      if (t.fields) Object.entries(t.fields).forEach(([k, v]) => L.push('- **' + k + '**：' + v));
      // 錯誤訊息的原因放在 raw，以前沒寫進紀錄，匯出後只剩「原始訊息如下：」一行空白。
      if (t.raw) L.push('', '```text', String(t.raw).replace(/```/g, 'ˋˋˋ').slice(0, 4000), '```');
      if (t.plain) L.push('> 白話版：' + t.plain);
    });
    return L.join('\n');
  }
}
