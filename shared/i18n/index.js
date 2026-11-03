// 中英文：网关和界面共用这一份字典（docs/ARCHITECTURE.md 第 4 节）。
//   键按区域命名（nav.*、wallet.*、settings.*…），发布后不改名；改措辞只改值。
//   参数用 {name} 占位：translate('en', 'auto.dailyMax', { n: 10 })。
//   en 缺的键退回中文（测试会检查两份字典的键是否一致）。
import zh from './zh.js';
import en from './en.js';

export const LANGS = ['zh', 'en'];
export const DICTS = { zh, en };

export function translate(lang, key, params) {
  const d = DICTS[lang] || zh;
  let s = d[key] ?? zh[key];
  if (s == null) return key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  return s;
}

// 网关返回的中文提示（报错、订单原因、任务记录）按字典里 gw.* 的中文模板生成；
// 其他语言按模板反查出参数，换成对应语言的句子；参数本身如果也是网关提示，继续往下翻译。没有对上的原样返回。
let matchers = null;
function buildMatchers() {
  const list = [];
  for (const k of Object.keys(zh)) {
    if (!k.startsWith('gw.')) continue;
    const ps = [];
    const src = zh[k].split(/(\{p\d+\})/).map((part) => {
      const m = /^\{(p\d+)\}$/.exec(part);
      if (m) { ps.push(m[1]); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    list.push({ k, re: new RegExp('^' + src + '$'), ps, lit: zh[k].replace(/\{p\d+\}/g, '').length });
  }
  return list.sort((a, b) => b.lit - a.lit);   // 固定文字多的先比，避免宽泛的模板抢先
}
export function localize(lang, text, depth = 0) {
  const s = text == null ? '' : String(text);
  if (!s || depth > 4 || lang === 'zh' || !DICTS[lang] || !/[\u4e00-\u9fff]/.test(s)) return s;
  matchers ??= buildMatchers();
  for (const m of matchers) {
    const r = m.re.exec(s);
    if (!r) continue;
    let out = DICTS[lang][m.k] ?? zh[m.k];
    m.ps.forEach((p, i) => { out = out.replace('{' + p + '}', localize(lang, r[i + 1], depth + 1)); });
    return out;
  }
  if (s.includes('；')) return s.split('；').map((x) => localize(lang, x, depth + 1)).join('; ');   // 两句拼在一起的：分别翻译
  return s;
}
