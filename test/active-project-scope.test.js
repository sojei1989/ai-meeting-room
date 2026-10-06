import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../server/orchestrator.js';

function gitInit(dir) {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  return run;
}

// 根目錄 root/ 底下有子專案 app/（自己的 git，登記為子模組），工單路徑以子專案為基準。
function setup() {
  const ws = mkdtempSync(path.join(tmpdir(), 'active-project-'));
  const runRoot = gitInit(ws);
  writeFileSync(path.join(ws, 'README.md'), 'root\n');
  const child = path.join(ws, 'app');
  mkdirSync(path.join(child, 'public'), { recursive: true });
  const runChild = gitInit(child);
  writeFileSync(path.join(child, 'public', 'index.html'), '<p>舊</p>\n');
  writeFileSync(path.join(child, 'other.txt'), '不可改\n');
  runChild('add', '-A'); runChild('commit', '-qm', 'init child');
  runRoot('add', '-A'); runRoot('commit', '-qm', 'init root');
  return { ws, child, runChild };
}

function fixture(ws, child, files, codex) {
  const cfg = { timeoutMs: 1000, modelSelection: { codex: { model: 'gpt-5.6-sol', effort: 'low' } } };
  const o = new Orchestrator(cfg, ws, () => {}, { ask: { codex }, activeProject: child });
  o.m.actions = [{ id: 'a1', title: '改子專案頁面', risk: 'mid', status: 'pending', files, codexModel: 'gpt-5.6-sol', reasoningEffort: 'low' }];
  return o;
}

const ok = { ok: true, data: { summary: '完成', outOfScope: '無', tests: '通過' }, prose: '' };

test('聚焦子專案時，以子專案為基準的修改路徑可以通過核准並執行', async () => {
  const { ws, child } = setup();
  let scopeSeen;
  const o = fixture(ws, child, [{ op: 'mod', path: 'public/index.html' }], async (_c, _p, _w, _m, _l, opts) => {
    scopeSeen = opts.approvedWritePaths;
    writeFileSync(path.join(child, 'public', 'index.html'), '<p>新</p>\n');
    return ok;
  });
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'done', o.m.actions[0].lastError);
  assert.deepEqual(scopeSeen, ['app/public/index.html']);
});

test('聚焦子專案時，新增檔案仍受越界檢查保護', async () => {
  const { ws, child, runChild } = setup();
  const o = fixture(ws, child, [{ op: 'add', path: 'test/new.test.js' }], async () => {
    mkdirSync(path.join(child, 'test'));
    writeFileSync(path.join(child, 'test', 'new.test.js'), '// ok\n');
    writeFileSync(path.join(child, 'other.txt'), '越界\n');
    return ok;
  });
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'failed');
  assert.match(o.m.actions[0].lastError, /app\/other\.txt/);
  assert.equal(readFileSync(path.join(child, 'other.txt'), 'utf8'), '不可改\n');
  assert.equal(runChild('status', '--porcelain').toString(), '');
});

test('工單已寫成根目錄相對路徑時不會重複加前綴', async () => {
  const { ws, child } = setup();
  const o = fixture(ws, child, [], async () => ok);
  assert.deepEqual((await o.rootRelativeFiles([{ op: 'mod', path: 'app/public/index.html' }])).files, [{ op: 'mod', path: 'app/public/index.html' }]);
  assert.deepEqual((await o.rootRelativeFiles([{ op: 'mod', path: 'README.md' }])).files, [{ op: 'mod', path: 'README.md' }]);
});

test('目前處理專案是根目錄時，會找到唯一對得上的子專案', async () => {
  const { ws, child } = setup();
  const o = fixture(ws, ws, [{ op: 'mod', path: 'public/index.html' }], async (_c, _p, _w, _m, _l, opts) => {
    assert.deepEqual(opts.approvedWritePaths, ['app/public/index.html']);
    writeFileSync(path.join(child, 'public', 'index.html'), '<p>新</p>\n');
    return ok;
  });
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'done', o.m.actions[0].lastError);
});

test('多個子專案都對得上時停下來請使用者切換專案', async () => {
  const { ws } = setup();
  const other = path.join(ws, 'site');
  mkdirSync(path.join(other, 'public'), { recursive: true });
  const run = gitInit(other);
  writeFileSync(path.join(other, 'public', 'index.html'), 'x\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  execFileSync('git', ['add', '-A'], { cwd: ws, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add site'], { cwd: ws, stdio: 'pipe' });
  let called = false;
  const o = fixture(ws, ws, [{ op: 'mod', path: 'public/index.html' }], async () => { called = true; return ok; });
  await o.approve('a1', { deferReview: true });
  assert.equal(called, false);
  assert.match(o.m.actions[0].lastError, /多個子專案/);
});

test('沒有列檔案的只驗證工單可以執行，且不會建立還原點', async () => {
  const { ws, child, runChild } = setup();
  writeFileSync(path.join(child, 'other.txt'), '使用者未存檔的工作\n');
  let mode;
  const o = fixture(ws, ws, [], async (_c, _p, _w, m) => { mode = m; return ok; });
  const headBefore = runChild('rev-parse', 'HEAD').toString();
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'done', o.m.actions[0].lastError);
  assert.equal(mode, 'write');
  assert.equal(runChild('rev-parse', 'HEAD').toString(), headBefore);
  assert.equal(readFileSync(path.join(child, 'other.txt'), 'utf8'), '使用者未存檔的工作\n');
});

test('只驗證工單若改到檔案（含原本就未存檔的檔案）會判定失敗', async () => {
  const { ws, child } = setup();
  writeFileSync(path.join(child, 'other.txt'), '未存檔\n');
  const o = fixture(ws, ws, [], async () => {
    writeFileSync(path.join(child, 'other.txt'), '被偷改\n');
    return ok;
  });
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'failed');
  assert.match(o.m.actions[0].lastError, /app\/other\.txt/);
});

test('只驗證工單執行中，會議室自己更新會議紀錄不算越界', async () => {
  const { ws, child } = setup();
  mkdirSync(path.join(child, 'meetings'));
  writeFileSync(path.join(child, 'meetings', 'M1.md'), '舊紀錄\n');
  const o = fixture(ws, ws, [], async () => {
    writeFileSync(path.join(child, 'meetings', 'M1.md'), '會議室自動存檔\n');
    writeFileSync(path.join(child, '.meeting-room-server.pid'), '123');
    return ok;
  });
  o.saveRoot = child;
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'done', o.m.actions[0].lastError);
});

test('只驗證工單執行中，雲端硬碟同步暫存檔出現或變動不算改檔', async () => {
  const { ws, child } = setup();
  const o = fixture(ws, ws, [], async () => {
    mkdirSync(path.join(child, '.tmp.driveupload'), { recursive: true });
    writeFileSync(path.join(child, '.tmp.driveupload', '9776'), '上傳中');
    writeFileSync(path.join(child, '.DS_Store'), 'finder');
    return ok;
  });
  await o.approve('a1', { deferReview: true });
  assert.equal(o.m.actions[0].status, 'done', o.m.actions[0].lastError);
});
