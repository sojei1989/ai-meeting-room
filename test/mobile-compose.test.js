import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function mobileCss() {
  const start = html.indexOf('@media (max-width:640px)');
  assert.notEqual(start, -1, '必須有手機版樣式');
  return html.slice(start, html.indexOf('</style>', start));
}

test('手機輸入框以單行觸控高度起跳，並保留逐行增高與高度上限', () => {
  const css = mobileCss();
  assert.match(css, /\.compose textarea\s*\{[^}]*min-height\s*:\s*44px[^}]*height\s*:\s*44px/s);
  assert.match(html, /e\.target\.id\s*===\s*['"]sayBox['"][\s\S]*?style\.height\s*=\s*['"]auto['"][\s\S]*?Math\.min\(e\.target\.scrollHeight,\s*180\)/);
});

test('手機鍵盤開啟時會收起收件者列與下排工具列', () => {
  const css = mobileCss();
  assert.match(css, /html\.mobile-keyboard-open\s+\.compose\s+\.to\s*,\s*html\.mobile-keyboard-open\s+\.footbar\s*\{\s*display\s*:\s*none\s*\}/s);
});

test('只有手機輸入框取得焦點且可視高度明顯縮小時，才切換鍵盤模式', () => {
  assert.match(html, /mobileSettings\.matches\s*&&\s*window\.visualViewport/);
  assert.match(html, /document\.activeElement\s*===\s*\$\(['"]#sayBox['"]\)/);
  assert.match(html, /window\.innerHeight\s*-\s*viewportHeight\s*>\s*120/);
  assert.match(html, /classList\.toggle\(['"]mobile-keyboard-open['"],\s*keyboardOpen\)/);
});

test('鍵盤關閉或離開手機寬度時會恢復控制區', () => {
  assert.match(html, /classList\.remove\(['"]mobile-keyboard-open['"]\)/);
  assert.match(html, /visualViewport\.addEventListener\(['"]resize['"],\s*syncViewportHeight\)/);
  assert.match(html, /window\.addEventListener\(['"]resize['"],\s*syncViewportHeight\)/);
});
