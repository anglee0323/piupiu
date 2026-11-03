// 网关会显示给用户的中文（抛出的错误、订单 / 任务的原因与说明）都要在字典里有 gw.* 模板，英文界面靠它翻译
// （web/src/lib/i18n.ts 的 lz()）。新增或改了这类中文却没加字典，这条测试会列出来。日志（console / this.log）不算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DICTS } from './index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CJK = /[\u4e00-\u9fff]/;
const FIELDS = 'reason|note|skip|why|message|msg|error|warn|hint|friendly';
const CTX = new RegExp(`(new Error\\(\\s*|\\b(?:${FIELDS})\\s*:\\s*|\\?\\s*|:\\s*|\\|\\|\\s*)$`);
const LINE_OK = new RegExp(`new Error\\(|\\b(?:${FIELDS})\\s*:`);
const LOG = /\b(console\.(log|warn|error)|this\.log|log\(|logLine|slog|wlog|appendLog|\.log\()/;
// 不是提示的中文：分组名「默认」是数据；这两处是拼接字符串的前半段（模板里写成了带参数的形式）
const SKIP = new Set(['默认', '(未知）', '保存失败：']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') && !d.name.endsWith('.test.js') ? [join(dir, d.name)] : []));
}
const unesc = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
// 模板字符串：${…} 换成 {p0} {p1}…（和字典里的写法一致）；嵌套的字符串 / 模板跳过
function scanTemplate(src, i) {
  let out = '', buf = '', n = 0, j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { buf += src.slice(j, j + 2); j += 2; continue; }
    if (c === '`') return [j, out + unesc(buf)];
    if (c === '$' && src[j + 1] === '{') {
      out += unesc(buf) + `{p${n++}}`; buf = '';
      let k = j + 2, depth = 1;
      while (k < src.length && depth) {
        const ch = src[k];
        if (ch === "'" || ch === '"') { const q = ch; k++; while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; } }
        else if (ch === '`') { k = scanTemplate(src, k)[0]; }
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        k++;
      }
      j = k; continue;
    }
    buf += c; j++;
  }
  return [j, out + unesc(buf)];
}
function literals(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out.push([i, unesc(src.slice(i + 1, j))]); i = j + 1; continue;
    }
    if (c === '`') { const [e, text] = scanTemplate(src, i); out.push([i, text]); i = e + 1; continue; }
    i++;
  }
  return out;
}

test('网关显示给用户的中文都有 gw.* 字典模板（英文界面能翻译）', () => {
  const have = new Set(Object.entries(DICTS.zh).filter(([k]) => k.startsWith('gw.')).map(([, v]) => v));
  assert.ok(have.size > 200, '字典里应有网关提示的模板');
  const files = [...walk(join(ROOT, 'engine')), join(ROOT, 'server.js')];
  const missing = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const [at, text] of literals(src)) {
      if (!CJK.test(text) || SKIP.has(text) || have.has(text)) continue;
      const lineStart = src.lastIndexOf('\n', at - 1) + 1;
      const line = src.slice(lineStart, at);
      const rec = /record\((?:[^()]|\([^()]*\))*,\s*'[a-z]+'\s*,\s*$/.test(src.slice(Math.max(0, at - 160), at));   // 狙击 / 跟单记录的原因
      if (!rec && (LOG.test(line) || !LINE_OK.test(line) || !CTX.test(src.slice(Math.max(0, at - 60), at)))) continue;
      missing.push(`${f.slice(ROOT.length)}:${src.slice(0, at).split('\n').length} ${text}`);
    }
  }
  assert.deepEqual(missing, [], '这些网关提示还没有加进 shared/i18n 的 gw.*（中文模板 + 英文）');
});

test('localize：英文界面把网关提示换成英文，参数里的网关提示也翻译；中文原样', async () => {
  const { localize } = await import('./index.js');
  assert.equal(localize('zh', '没有可卖出的余额'), '没有可卖出的余额');
  assert.equal(localize('en', '没有可卖出的余额'), 'No balance to sell');
  assert.equal(localize('en', 'BNB 余额不足（0.0123）'), 'Insufficient BNB (0.0123)');
  assert.equal(localize('en', '已提交，正在确认，请勿重复下单：币安钱包未登录'), 'Submitted and confirming. Do not place it again: The Binance wallet is not signed in');
  assert.equal(localize('en', '市值 $12345 超出保护价，跳过本份'), 'Market cap $12345 is past the protection price; this part was skipped');
  assert.equal(localize('en', 'execution reverted'), 'execution reverted', '不是网关提示的原样返回');
  assert.equal(localize('en', '未知的中文提示'), '未知的中文提示');
});
