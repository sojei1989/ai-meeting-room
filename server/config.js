import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const ROOT_DIR = path.resolve(MODULE_DIR, '..');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const TEMPLATE_FILE = path.join(ROOT_DIR, 'config.example.json');
const PID_FILE = path.join(ROOT_DIR, '.meeting-room-server.pid');
const PORT = 4477;

export function readConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(raw);
}

export function resolvePort(port) {
  const parsed = Number(port);
  return Number.isFinite(parsed) ? parsed : PORT;
}

export function resolveWorkspace(rawWorkspace) {
  const ws = typeof rawWorkspace === 'string' ? rawWorkspace.trim() : '';
  if (!ws) return '';
  if (ws === '~') return os.homedir();
  if (ws.startsWith('~/')) {
    return path.join(os.homedir(), ws.slice(2));
  }
  return ws;
}

export function resolveListenConfig(cfg) {
  const local = typeof cfg?.listen?.local === 'string' && cfg.listen.local.trim()
    ? cfg.listen.local.trim()
    : '127.0.0.1';
  const tailscale = typeof cfg?.listen?.tailscale === 'string'
    ? cfg.listen.tailscale.trim()
    : '';
  return { local, tailscale };
}

// Tailscale 只會發 100.64.0.0/10 的位址。限制在這個範圍，避免誤填 0.0.0.0 或區網位址，
// 讓會議室被同一個 Wi-Fi 裡的其他人連到。
// 只接受標準寫法的 IPv4：不接受前導零（100.064.0.1 會被系統當成八進位，綁到別的位址）。
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);
function parseIPv4(value) {
  const m = IPV4_RE.exec(String(value || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

export function isTailscaleIp(value) {
  const octets = parseIPv4(value);
  return Boolean(octets) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

// 本機入口只能是迴路位址（127.0.0.0/8、::1、localhost），其他位址一律退回 127.0.0.1。
export function isLoopbackHost(value) {
  const v = String(value || '').trim();
  if (v === '::1' || v === 'localhost') return true;
  const octets = parseIPv4(v);
  return Boolean(octets) && octets[0] === 127;
}

export function readTemplate() {
  const raw = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  return JSON.parse(raw);
}

export function withPortableFlag(cfg, { configured = true } = {}) {
  const next = structuredClone(cfg);
  next._portable = next._portable || {};
  next._portable.configured = configured;
  if (configured) {
    next._portable.updatedAt = new Date().toISOString();
  }
  return next;
}

export function loadTemplateConfig() {
  return readTemplate();
}

export function ensureWorkspaceMarker(root, workspace) {
  const resolved = resolveWorkspace(workspace);
  return path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
}

export function getPidFilePath() {
  return PID_FILE;
}
