import { execFile } from 'node:child_process';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) =>
      resolve({ ok: !e, out: out || '', err: err || (e ? e.message : '') })
    );
  });
}

// 雲端硬碟同步暫存、Illustrator／Office 暫存、Finder 記錄檔：
// 這些是其他程式在背景自己產生的，不該被存進還原點，也不該算成工單越界，
// 回復時更不能刪（刪掉可能讓同步或正在開的檔案出錯）。
const NOISE_PATTERNS = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.tmp\.drive(upload|download)(\/|$)/,
  /(^|\/)~ai-[^/]*\.tmp$/,
  /(^|\/)~\$[^/]*$/,
  /(^|\/)\.~lock\.[^/]*#$/,
  /(^|\/)Icon\r$/
];
export function isNoisePath(value) {
  const file = String(value || '');
  return NOISE_PATTERNS.some(re => re.test(file));
}
const NOISE_PATHSPECS = [
  ':(exclude,glob)**/.DS_Store',
  ':(exclude,glob)**/.tmp.driveupload/**',
  ':(exclude,glob)**/.tmp.drivedownload/**',
  ':(exclude,glob)**/~ai-*.tmp',
  ':(exclude,glob)**/~$*',
  ':(exclude,glob)**/.~lock.*#'
];

function splitZero(value) {
  return value.split('\0').filter(Boolean);
}

async function repoTree(ws) {
  const root = path.resolve(ws);
  const repos = [{ root, prefix: '' }];
  for (let i = 0; i < repos.length; i += 1) {
    const repo = repos[i];
    const listed = await git(repo.root, ['ls-files', '--stage', '-z']);
    if (!listed.ok) return { ok: false, repos: [], error: listed.err.trim() || '讀不到子專案清單' };
    for (const entry of splitZero(listed.out)) {
      const match = entry.match(/^160000 [0-9a-f]+ \d+\t(.+)$/);
      if (!match) continue;
      const childRoot = path.resolve(repo.root, match[1]);
      if (!childRoot.startsWith(root + path.sep) || !existsSync(path.join(childRoot, '.git'))) continue;
      repos.push({ root: childRoot, prefix: path.posix.join(repo.prefix, match[1]) });
    }
  }
  return { ok: true, repos };
}

function checkpointState(value) {
  if (value && typeof value === 'object' && Array.isArray(value.repos)) {
    return [...value.repos, ...(Array.isArray(value.watchRepos) ? value.watchRepos : [])];
  }
  return [{ prefix: '', hash: String(value || '') }];
}

function reposForApprovedPaths(repos, approvedPaths) {
  if (!Array.isArray(approvedPaths) || approvedPaths.length === 0) return repos;
  const selected = new Map();
  for (const value of approvedPaths) {
    const relative = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
    const matches = repos
      .filter(repo => !repo.prefix || relative === repo.prefix || relative.startsWith(repo.prefix + '/'))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    if (matches[0]) selected.set(matches[0].root, matches[0]);
  }
  return [...selected.values()];
}

async function pendingFiles(repo) {
  const [tracked, staged, untracked] = await Promise.all([
    git(repo.root, ['diff', '--name-only', '-z', 'HEAD']),
    git(repo.root, ['diff', '--cached', '--name-only', '-z', 'HEAD']),
    git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  if (!tracked.ok || !staged.ok || !untracked.ok) {
    return { ok: false, files: [], error: (tracked.err || staged.err || untracked.err || '讀不到待存檔案').trim() };
  }
  const prefix = value => path.posix.join(repo.prefix, value);
  return {
    ok: true,
    files: [...new Set([...splitZero(tracked.out), ...splitZero(staged.out), ...splitZero(untracked.out)].map(prefix))].sort()
  };
}

// 列出根目錄底下所有子專案（git 子模組）的相對前綴，不含根目錄本身。
export async function listSubprojects(ws) {
  const tree = await repoTree(ws);
  if (!tree.ok) return [];
  return tree.repos.map(repo => repo.prefix).filter(Boolean);
}

// 只驗證、不改檔的工單用：記下所有專案的 HEAD 與每個未存檔檔案的內容指紋，
// 執行後再比一次，就知道有沒有偷偷改到東西。
export async function workingSnapshot(ws) {
  const tree = await repoTree(ws);
  if (!tree.ok) return { ok: false, error: tree.error };
  const entries = {};
  for (const repo of tree.repos) {
    const head = (await git(repo.root, ['rev-parse', 'HEAD'])).out.trim();
    entries['HEAD:' + repo.prefix] = head;
    const pending = await pendingFiles(repo);
    if (!pending.ok) return { ok: false, error: pending.error };
    // 雲端硬碟同步暫存等背景雜訊不列入比對，否則 Google Drive 一上傳就會誤判成工單改檔。
    for (const rel of pending.files.filter(file => !isNoisePath(file))) {
      const abs = path.resolve(ws, rel);
      let sig = 'missing';
      try {
        const st = statSync(abs);
        sig = st.isFile() ? createHash('sha1').update(readFileSync(abs)).digest('hex') : 'dir';
      } catch {}
      entries[rel] = sig;
    }
  }
  return { ok: true, entries };
}

export function snapshotDiff(before, after) {
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...keys].filter(k => before.entries[k] !== after.entries[k]).sort();
}

export async function ensureRepo(ws) {
  if (!existsSync(path.join(ws, '.git'))) {
    await git(ws, ['init']);
    await git(ws, ['add', '-A']);
    await git(ws, ['commit', '-m', '會議室初始還原點', '--allow-empty']);
  }
}

export async function checkpoint(ws, label, approvedPaths) {
  // 為什麼要回報得這麼細：以前失敗只回 ok:false，而呼叫端沒看這個欄位，
  // 於是 .git 被鎖住時「以為存好了」照樣開跑，
  // 事後按「回到修改前」會退到更早的地方，中間的東西默默不見。
  const tree = await repoTree(ws);
  if (!tree.ok) return { ok: false, hash: '', error: tree.error };
  const targets = reposForApprovedPaths(tree.repos, approvedPaths);
  if (!targets.length) return { ok: false, hash: '', error: '核准檔案不屬於任何可建立還原點的專案' };
  const saved = [];
  const watchRepos = [];
  const files = [];
  // 子專案先存，外層才能把更新後的子專案指標一起放進還原點。
  for (const repo of [...targets].reverse()) {
    const before = (await git(repo.root, ['rev-parse', '--short', 'HEAD'])).out.trim();
    const pending = await pendingFiles(repo);
    if (!pending.ok) return { ok: false, hash: before, error: pending.error };
    files.push(...pending.files.filter(file => !isNoisePath(file)));
    const add = await git(repo.root, ['add', '-A', '--', '.', ...NOISE_PATHSPECS]);
    if (!add.ok) return { ok: false, hash: before, error: '無法把改動加入版本控制：' + add.err.trim() };
    const r = await git(repo.root, ['commit', '-m', '還原點：' + label, '--allow-empty']);
    const after = (await git(repo.root, ['rev-parse', '--short', 'HEAD'])).out.trim();
    if (!r.ok) return { ok: false, hash: after || before, error: r.err.trim() || '建立還原點的指令失敗' };
    if (!after || after === before) return { ok: false, hash: before, error: '還原點編號沒有變，代表這次其實沒有存進去' };
    saved.push({ prefix: repo.prefix, hash: after });
  }
  if (Array.isArray(approvedPaths) && approvedPaths.length) {
    const targetRoots = new Set(targets.map(repo => repo.root));
    for (const repo of tree.repos) {
      if (targetRoots.has(repo.root)) continue;
      const status = await git(repo.root, ['status', '--porcelain', '-z', '--untracked-files=all']);
      if (!status.ok) return { ok: false, hash: '', error: status.err.trim() || '讀不到其他專案狀態' };
      // 已有未存檔工作的其他專案不能提交或回復；乾淨專案則納入變更監看。
      if (status.out) continue;
      const hash = (await git(repo.root, ['rev-parse', '--short', 'HEAD'])).out.trim();
      if (hash) watchRepos.push({ prefix: repo.prefix, hash });
    }
  }
  saved.sort((a, b) => a.prefix.localeCompare(b.prefix));
  watchRepos.sort((a, b) => a.prefix.localeCompare(b.prefix));
  const outer = saved.find(repo => repo.prefix === '');
  return {
    ok: true,
    hash: (outer || saved[0]).hash,
    repos: saved,
    watchRepos,
    files: [...new Set(files)].sort()
  };
}

export async function diffSince(ws, checkpoint) {
  const stats = [];
  const fulls = [];
  const fresh = [];
  for (const repo of checkpointState(checkpoint)) {
    const cwd = path.resolve(ws, repo.prefix);
    const r = await git(cwd, ['diff', '--ignore-submodules=all', repo.hash, '--stat']);
    const full = await git(cwd, ['diff', '--ignore-submodules=all', repo.hash]);
  // git diff 看不到還沒加入版本控制的新檔（Codex 新增的檔案就是這種），
  // 不補上的話「實際改動」會漏掉新檔，逾時救回時甚至會誤判成「沒做」。
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
    const prefix = value => path.posix.join(repo.prefix, value);
    stats.push(...r.out.split('\n').filter(Boolean).map(line => repo.prefix ? ' ' + repo.prefix + '/' + line.trimStart() : line));
    fulls.push(repo.prefix ? '子專案：' + repo.prefix + '\n' + full.out : full.out);
    fresh.push(...untracked.out.split('\n').map(x => x.trim()).filter(Boolean).map(prefix));
  }
  const stat = [...stats, ...fresh.map(f => ' ' + f + ' | 新檔')].filter(Boolean).join('\n');
  return { stat, full: fulls.join('\n').slice(0, 20000), untracked: fresh };
}

export async function changedPathsSince(ws, checkpoint) {
  const paths = [];
  const fresh = [];
  for (const repo of checkpointState(checkpoint)) {
    const cwd = path.resolve(ws, repo.prefix);
    const tracked = await git(cwd, ['diff', '--ignore-submodules=all', '--name-only', '-z', repo.hash]);
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (!tracked.ok || !untracked.ok) {
      return { ok: false, paths: [], untracked: [], error: (tracked.err || untracked.err || '讀不到實際改動').trim() };
    }
    const prefix = value => path.posix.join(repo.prefix, value);
    paths.push(...splitZero(tracked.out).map(prefix).filter(file => !isNoisePath(file)));
    fresh.push(...splitZero(untracked.out).map(prefix).filter(file => !isNoisePath(file)));
  }
  return {
    ok: true,
    paths: [...new Set([...paths, ...fresh])].sort(),
    untracked: fresh
  };
}

export async function restoreTaskChanges(ws, checkpoint, untracked = []) {
  const states = checkpointState(checkpoint);
  // 先復原外層，再復原子專案內容，避免只退回子專案指標。
  for (const repo of states) {
    const reset = await git(path.resolve(ws, repo.prefix), ['reset', '--hard', repo.hash]);
    if (!reset.ok) return { ok: false, error: reset.err.trim() || '無法回復已追蹤檔案' };
  }
  try {
    const root = path.resolve(ws);
    for (const relative of untracked.filter(file => !isNoisePath(file))) {
      const target = path.resolve(root, relative);
      const inside = target !== root && target.startsWith(root + path.sep);
      if (inside && existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

export async function restore(ws, hash) {
  return (await restoreTaskChanges(ws, hash)).ok;
}

export async function headHash(ws) {
  const h = await git(ws, ['rev-parse', '--short', 'HEAD']);
  return h.out.trim();
}
