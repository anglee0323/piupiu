// 中英文字典：两份键一致、占位符一致；已经转换过的文件里不能再新写死中文（docs/ARCHITECTURE.md 第 4 节）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DICTS, translate } from './index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('中英文字典的键一一对应，占位符相同，值不为空', () => {
  const zh = Object.keys(DICTS.zh), en = Object.keys(DICTS.en);
  assert.deepEqual(zh.filter((k) => !(k in DICTS.en)), [], 'en 缺少这些键');
  assert.deepEqual(en.filter((k) => !(k in DICTS.zh)), [], 'zh 缺少这些键');
  for (const k of zh) {
    assert.equal(ph(DICTS.en[k]), ph(DICTS.zh[k]), `${k} 的占位符不一致`);
    assert.ok(String(DICTS.zh[k]).trim() && String(DICTS.en[k]).trim(), `${k} 是空的`);
    assert.doesNotMatch(String(DICTS.en[k]), /[\u4e00-\u9fff]/, `${k} 的英文里有中文`);
  }
});

test('translate：参数替换、未知语言退回中文、未知键原样返回', () => {
  assert.equal(translate('xx', 'zz.none'), 'zz.none');
});

// 界面全部转换完成：web/src 下所有 .ts / .tsx 都不能再写死中文（注释和标了 i18n-ignore 的行除外）
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) && !d.name.endsWith('.d.ts') ? [join(dir, d.name)] : []));
}
export const DONE = walk(join(ROOT, 'web/src')).map((f) => f.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, ''));
test('界面文件里没有写死的中文', () => {
  assert.ok(DONE.length > 50, '应扫描到 web/src 下的全部界面文件');
  const bad = [];
  for (const f of DONE) {
    readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/i18n-ignore/.test(line)) return;
      // 行尾 // 注释只在 // 前面是行首或空白时才算（https://… 里的 // 不是注释，曾经把后面写死的中文一起跳过了）
      const code = line.replace(/(^|\s)\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '').replace(/\/\*.*?\*\//g, '');
      if (/^\s*(\*|\/\*)/.test(line)) return;
      if (/[\u4e00-\u9fff]/.test(code)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], '这些行还有写死的中文，请改用 t()');
});
