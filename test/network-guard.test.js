import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { isTailscaleIp, isLoopbackHost, resolveWorkspace } from '../server/config.js';

test('Tailscale 位址只接受 100.64.0.0/10', () => {
  for (const ok of ['100.64.0.1', '100.100.100.100', '100.127.255.254']) assert.equal(isTailscaleIp(ok), true, ok);
  for (const bad of ['', '0.0.0.0', '192.168.1.10', '100.63.255.255', '100.128.0.1', '100.64.0.256', '100.64.0', 'abc', '100.064.0.1', '0100.64.0.1']) {
    assert.equal(isTailscaleIp(bad), false, bad);
  }
});

test('本機入口只接受迴路位址', () => {
  for (const ok of ['127.0.0.1', '127.0.0.2', '::1', 'localhost', ' 127.0.0.1 ']) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ['0.0.0.0', '192.168.1.10', '', '100.64.0.1', '127.00.0.1']) assert.equal(isLoopbackHost(bad), false, bad);
});

test('工作資料夾的 ~ 會展開到家目錄底下', () => {
  assert.equal(resolveWorkspace('~'), os.homedir());
  assert.equal(resolveWorkspace('~/Projects'), path.join(os.homedir(), 'Projects'));
  assert.equal(resolveWorkspace('/tmp/x'), '/tmp/x');
  assert.equal(resolveWorkspace(''), '');
});
