import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function hasSecretComponent(value) {
  return path.resolve(value).split(path.sep).some(part => part.toLowerCase() === '.secrets');
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return null;
  if (value.split('/').some(part => part === '.' || part === '..')) return null;
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '');
}

function hasSymlinkComponent(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function hasSymlinkInDirectory(root, relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  if (!parts.length) return false;
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function normalizedSet(values) {
  const result = new Set();
  for (const value of values || []) {
    const normalized = normalizeRelativePath(value);
    if (normalized) result.add(normalized);
  }
  return result;
}

export function collectRegisteredAssetPaths(meeting) {
  return normalizedSet((meeting?.deliverables || []).map(item => item?.file?.rel));
}

export function collectRegisteredAttachmentPaths(meeting) {
  const paths = [];
  for (const turn of meeting?.transcript || []) {
    for (const file of turn?.files || []) paths.push(file?.rel);
  }
  return normalizedSet(paths);
}

export function resolveContainedFile({ root, requestedPath, forbiddenRoots = [] }) {
  const normalized = normalizeRelativePath(requestedPath);
  if (!normalized || normalized.split('/').some(part => part.toLowerCase() === '.secrets')) return null;

  try {
    if (!lstatSync(root).isDirectory()) return null;
    const rootReal = realpathSync(root);
    const target = path.resolve(rootReal, normalized);
    if (!isInside(rootReal, target) || hasSymlinkComponent(rootReal, normalized)) return null;
    const targetReal = realpathSync(target);
    if (!isInside(rootReal, targetReal) || hasSecretComponent(targetReal)) return null;
    for (const forbidden of forbiddenRoots) {
      let forbiddenReal;
      try { forbiddenReal = realpathSync(forbidden); } catch { continue; }
      if (isInside(forbiddenReal, rootReal) || isInside(forbiddenReal, targetReal)) return null;
    }
    return statSync(targetReal).isFile() ? targetReal : null;
  } catch {
    return null;
  }
}

export function resolveRegisteredFile({ root, requestedPath, registeredPaths, forbiddenRoots = [] }) {
  const normalized = normalizeRelativePath(requestedPath);
  if (!normalized || !normalizedSet(registeredPaths).has(normalized)) return null;
  return resolveContainedFile({ root, requestedPath: normalized, forbiddenRoots });
}

export function resolveWritablePath({ root, requestedPath, forbiddenRoots = [] }) {
  const normalized = normalizeRelativePath(requestedPath);
  if (!normalized || normalized.split('/').some(part => part.toLowerCase() === '.secrets')) return null;

  try {
    if (!lstatSync(root).isDirectory()) return null;
    const rootReal = realpathSync(root);
    const target = path.resolve(rootReal, normalized);
    if (!isInside(rootReal, target)) return null;
    if (hasSymlinkInDirectory(rootReal, normalized)) return null;
    if (hasSecretComponent(target)) return null;
    if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !statSync(target).isDirectory() && !statSync(target).isFile())) return null;
    for (const forbidden of forbiddenRoots) {
      let forbiddenReal;
      try { forbiddenReal = realpathSync(forbidden); } catch { continue; }
      if (isInside(forbiddenReal, rootReal) || isInside(forbiddenReal, target)) return null;
    }
    return target;
  } catch {
    return null;
  }
}

function safeUploadName(value) {
  if (typeof value !== 'string' || !value || value.length > 120) return null;
  if (value === '.' || value === '..' || value.startsWith('.') || value.includes('\0')) return null;
  if (value.includes('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function resolveDeliverableUpload({ root, deliverablePath, uploadName, forbiddenRoots = [] }) {
  const normalizedCardPath = normalizeRelativePath(String(deliverablePath || '').replace(/\/$/, ''));
  const fileName = safeUploadName(uploadName);
  if (!normalizedCardPath || !fileName) return null;

  const cardTarget = resolveWritablePath({ root, requestedPath: normalizedCardPath, forbiddenRoots });
  if (!cardTarget) return null;

  let relativePath;
  try {
    const cardIsDirectory = existsSync(cardTarget) && statSync(cardTarget).isDirectory();
    const specifiesFile = !cardIsDirectory && path.posix.extname(path.posix.basename(normalizedCardPath)) !== '';
    if (specifiesFile) {
      if (fileName !== path.posix.basename(normalizedCardPath)) return null;
      relativePath = normalizedCardPath;
    } else {
      relativePath = path.posix.join(normalizedCardPath, fileName);
    }
  } catch {
    return null;
  }

  const target = resolveWritablePath({ root, requestedPath: relativePath, forbiddenRoots });
  if (!target) return null;
  if (existsSync(target)) return { conflict: true, relativePath, fileName };
  return { conflict: false, relativePath, fileName, path: target };
}

export function isEmptyTree(dir) {
  try {
    if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) return false;
    return readdirSync(dir).every(name => name === '.DS_Store' || isEmptyTree(path.join(dir, name)));
  } catch {
    return false;
  }
}

export function approvedWriteScope({ root, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, paths: [], error: '工單沒有列出任何核准檔案' };
  }

  const paths = [];
  const dirs = [];
  for (const file of files) {
    const op = file?.op;
    const requestedPath = file?.path;
    if (!['add', 'mod', 'del'].includes(op)) {
      return { ok: false, paths: [], error: '核准檔案的操作類型無效：' + String(op || '未填') };
    }
    // .git 裡是版本紀錄本身（還原點也靠它），交給 Codex 改會連退路一起弄壞；鎖定檔之類的問題由人或會議室處理。
    if (String(requestedPath || '').split('/').some(part => part.toLowerCase() === '.git')) {
      return { ok: false, paths: [], error: '核准路徑在版本紀錄資料夾（.git）裡：' + requestedPath + '。這類檔案不能交給 Codex 處理' };
    }
    const target = resolveWritablePath({ root, requestedPath });
    if (!target) {
      return { ok: false, paths: [], error: '核准路徑不安全或不在工作區內：' + String(requestedPath || '未填') };
    }
    // 只剩空資料夾（通常是上一次失敗回復後留下的殼，git 不追蹤空資料夾所以刪不掉）時，視為還不存在。
    const exists = existsSync(target) && !(op === 'add' && isEmptyTree(target));
    if (op === 'add' && exists) {
      return { ok: false, paths: [], error: '核准路徑與操作類型不相符：' + requestedPath + '（工單寫「新增」，但它已經存在，可能前面的工單已經建立過）' };
    }
    if ((op === 'mod' || op === 'del') && !exists) {
      return { ok: false, paths: [], error: '核准路徑與操作類型不相符：' + requestedPath + '（工單寫「' + (op === 'mod' ? '修改' : '刪除') + '」，但它已經不存在，可能已經處理掉了）' };
    }
    const normalized = normalizeRelativePath(requestedPath);
    // 核准的是資料夾時（例如整併輸出區），裡面的檔案都算在核准範圍內。
    // 以前只做完全相等比對，資料夾底下每個被搬動的檔案都被判成越界。
    if (exists && statSync(target).isDirectory() || String(requestedPath).endsWith('/')) dirs.push(normalized);
    if (paths.includes(normalized)) {
      return { ok: false, paths: [], error: '核准清單重複列出：' + normalized };
    }
    paths.push(normalized);
  }
  return { ok: true, paths, dirs };
}

// 判斷實際改動的路徑是否落在核准範圍內（完全相同，或位於核准的資料夾底下）。
export function withinApprovedScope(file, scope) {
  const value = String(file || '');
  if ((scope?.paths || []).includes(value)) return true;
  return (scope?.dirs || []).some(dir => value === dir || value.startsWith(dir.replace(/\/+$/, '') + '/'));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function openContainedFile(options) {
  const beforePath = resolveContainedFile(options);
  if (!beforePath) return null;

  let fd;
  try {
    const before = statSync(beforePath);
    fd = openSync(beforePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const afterPath = resolveContainedFile(options);
    const after = afterPath ? statSync(afterPath) : null;
    if (!opened.isFile() || afterPath !== beforePath || !sameFile(before, opened) || !sameFile(opened, after)) {
      closeSync(fd);
      return null;
    }
    return { fd, path: beforePath, size: opened.size };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    return null;
  }
}

export function openRegisteredFile({ root, requestedPath, registeredPaths, forbiddenRoots = [] }) {
  const normalized = normalizeRelativePath(requestedPath);
  if (!normalized || !normalizedSet(registeredPaths).has(normalized)) return null;
  return openContainedFile({ root, requestedPath: normalized, forbiddenRoots });
}
