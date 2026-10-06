import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const SKIP = new Set(['node_modules', '.git', 'Library', 'Applications', '.Trash', '.cache', 'System']);

// 列出某個資料夾底下的子資料夾（給選擇器用）
export function browse(dir) {
  const target = path.resolve(dir && dir.trim() ? dir.replace(/^~/, HOME) : HOME);
  if (!existsSync(target)) return { error: '找不到這個資料夾：' + target };
  let st;
  try { st = statSync(target); } catch { return { error: '無法讀取這個資料夾' }; }
  if (!st.isDirectory()) return { error: '這是一個檔案，不是資料夾' };

  let entries = [];
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map(e => {
        const full = path.join(target, e.name);
        let isProject = false, files = 0;
        try {
          const inner = readdirSync(full);
          files = inner.length;
          isProject = inner.includes('.git') || inner.includes('package.json') || inner.includes('index.html');
        } catch {}
        return { name: e.name, path: full, isProject, files };
      })
      .sort((a, b) => (b.isProject - a.isProject) || a.name.localeCompare(b.name, 'zh-Hant'));
  } catch { return { error: '沒有權限讀取這個資料夾' }; }

  return {
    path: target,
    display: target.startsWith(HOME) ? '~' + target.slice(HOME.length) : target,
    parent: target === '/' ? null : path.dirname(target),
    atHome: target === HOME,
    entries
  };
}

export function browseWithin(root, dir) {
  const base = path.resolve(root);
  const target = dir && String(dir).trim() ? dir : base;
  const inspected = inspectProject(base, target);
  if (!inspected.ok) return { error: inspected.msg };
  const result = browse(inspected.path);
  if (!result.error) result.parent = inspected.path === base ? null : result.parent;
  return result;
}

// 檢查一個路徑能不能當工作區
export function inspect(dir) {
  const target = path.resolve(String(dir || '').replace(/^~/, HOME));
  if (!existsSync(target)) return { ok: false, msg: '這個資料夾不存在' };
  if (!statSync(target).isDirectory()) return { ok: false, msg: '這是檔案，請選資料夾' };
  let files = [], isGit = false;
  try { files = readdirSync(target); isGit = files.includes('.git'); } catch {}
  return {
    ok: true, path: target,
    display: target.startsWith(HOME) ? '~' + target.slice(HOME.length) : target,
    name: path.basename(target) || target,
    count: files.length, isGit
  };
}

// 子專案只是目前優先處理的焦點，必須永遠留在固定讀取根目錄裡。
export function inspectProject(root, dir) {
  const inspected = inspect(dir);
  if (!inspected.ok) return inspected;
  const base = path.resolve(root);
  const relative = path.relative(base, inspected.path);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    return { ok: false, msg: '目前處理專案必須位於固定讀取根目錄內' };
  }
  return inspected;
}

// 最近使用過的資料夾
export function readRecent(root) {
  const f = path.join(root, '.recent-workspaces.json');
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; }
}
export function pushRecent(root, dir) {
  const f = path.join(root, '.recent-workspaces.json');
  const list = readRecent(root).filter(x => x !== dir);
  list.unshift(dir);
  const cut = list.slice(0, 8);
  try { writeFileSync(f, JSON.stringify(cut, null, 2), 'utf8'); } catch {}
  return cut;
}

// 把選擇寫回 config.json，下次啟動就記得
export function persist(root, dir) {
  const f = path.join(root, 'config.json');
  try {
    const c = JSON.parse(readFileSync(f, 'utf8'));
    c.activeProject = dir;
    writeFileSync(f, JSON.stringify(c, null, 2), 'utf8');
    return true;
  } catch { return false; }
}
