#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const projectRoot = process.cwd();

function parseArgs(argv) {
  const args = { platform: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') {
      args.platform = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (!arg.startsWith('--') && !args.out) {
      args.out = arg;
    }
  }
  return args;
}

function die(message) {
  console.error(`[build-release] ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.platform !== 'mac') {
  die('目前只支援 --platform mac');
}
if (!args.out) {
  die('請提供輸出路徑，例如 --out dist/ai-meeting-room-mac.zip');
}

const outPath = path.resolve(projectRoot, args.out);
const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });

const includes = [
  'start.command',
  'package.json',
  'config.example.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'server',
  'public',
];

// 執行時才會產生、或只屬於某台電腦的檔案，一律不進發行包
const excludes = [
  '*.DS_Store',
  'server/.restart-token',
  '.meeting-room-server.pid',
  'config.json',
  '.secrets/*',
];

for (const item of includes) {
  const abs = path.join(projectRoot, item);
  if (!fs.existsSync(abs)) {
    die(`缺少必要檔案：${item}`);
  }
}

const result = spawnSync('zip', ['-qr', outPath, ...includes, '-x', ...excludes], {
  cwd: projectRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.error) {
  die(`執行 zip 失敗：${result.error.message}`);
}
if (result.status !== 0) {
  die(`zip 回傳錯誤代碼：${result.status}`);
}

const stat = fs.statSync(outPath);
console.log(`已產生發行包：${outPath}`);
console.log(`檔案大小：${stat.size} bytes`);
