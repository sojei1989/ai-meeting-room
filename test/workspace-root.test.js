import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inspectProject } from '../server/workspace.js';
import { Orchestrator } from '../server/orchestrator.js';

test('子專案只能改變目前焦點，不能離開固定的讀取根目錄', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'aimr-workspace-root-'));
  const root = path.join(base, 'Projects');
  const project = path.join(root, 'alpha');
  const outside = path.join(base, 'outside');
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const selected = inspectProject(root, project);
  assert.equal(selected.ok, true);
  assert.equal(selected.path, project);
  assert.equal(inspectProject(root, outside).ok, false);
});

test('Orchestrator 保留 Projects 根目錄，另行記錄目前處理專案', () => {
  const root = '/example/Projects';
  const project = '/example/Projects/alpha';
  const orchestrator = new Orchestrator({}, root, () => {}, { activeProject: project });

  assert.equal(orchestrator.ws, root);
  assert.equal(orchestrator.activeProject, project);
  orchestrator.setActiveProject('/example/Projects/beta');
  assert.equal(orchestrator.ws, root);
  assert.equal(orchestrator.activeProject, '/example/Projects/beta');
});
