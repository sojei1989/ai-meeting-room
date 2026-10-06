import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'));
  return match?.[1] ?? '';
}

function mediumDesktopCss() {
  const match = html.match(
    /@media\s*\(min-width\s*:\s*641px\)\s*and\s*\(max-width\s*:\s*1000px\)\s*\{([\s\S]*?)\n\}/
  );
  return match?.[1] ?? '';
}

test('641–1000px 使用獨立的頂欄排版', () => {
  const css = mediumDesktopCss();
  assert.notEqual(css, '', '必須為 641–1000px 定義獨立樣式');
  assert.match(rule(css, '.topbar'), /display\s*:\s*grid/);
  assert.match(rule(css, '.settings-panel'), /display\s*:\s*flex/);
});

test('中寬電腦版的工作區標籤不會逐字換行', () => {
  const css = mediumDesktopCss();
  const labels = rule(css, '.wschip > span:not(.nm)');
  assert.match(labels, /white-space\s*:\s*nowrap/);
  assert.match(labels, /flex\s*:\s*none/);
});

test('中寬電腦版的專案名稱會保持單行並安全縮短', () => {
  const name = rule(mediumDesktopCss(), '.wschip .nm');
  assert.match(name, /min-width\s*:\s*0/);
  assert.match(name, /overflow\s*:\s*hidden/);
  assert.match(name, /text-overflow\s*:\s*ellipsis/);
  assert.match(name, /white-space\s*:\s*nowrap/);
});

test('中寬電腦版的模型控制區可在畫面範圍內換行', () => {
  const css = mediumDesktopCss();
  const controls = rule(css, '.model-controls');
  const labels = rule(css, '.model-controls label');
  assert.match(controls, /width\s*:\s*100%/);
  assert.match(controls, /min-width\s*:\s*0/);
  assert.match(controls, /flex-wrap\s*:\s*wrap/);
  assert.match(labels, /flex\s*:\s*1\s+1\s+140px/);
  assert.match(labels, /min-width\s*:\s*0/);
});

test('寬螢幕的工作區標籤不直排、專案名稱保留可辨識寬度、提示文字不超出畫面', () => {
  const base = html.slice(0, html.indexOf('@media (max-width:1000px)')); // 寬螢幕基本樣式都寫在響應式區塊之前
  assert.match(rule(base, '.wschip > span:not(.nm)'), /white-space\s*:\s*nowrap/);
  assert.match(rule(base, '.wschip > span:not(.nm)'), /flex\s*:\s*none/);
  assert.match(rule(base, '.wschip .nm'), /min-width\s*:\s*4em/);
  assert.doesNotMatch(rule(base, '.wschip'), /max-width\s*:\s*34ch/);
  assert.match(rule(base, '.model-controls .model-hint'), /white-space\s*:\s*normal/);
});
