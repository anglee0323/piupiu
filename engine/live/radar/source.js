// 源码与说明（方案 R3「合约与资料」）：Sourcify 已验证源码 → ABI、合约名、项目方写在合约里的说明（NatSpec）、源码注释里的链接、
// 只有管理员能调的「危险开关」（改价、暂停、增发、升级、提款…）。英文说明用公共翻译接口转中文（失败就显示原文）。
// 外部文字只当资料展示，不会触发任何操作。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from '../config.js';
import { EP } from '../endpoints.js';

const lc = (a) => String(a || '').toLowerCase();
const fetchJson = async (url, ms = 12_000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } }); if (r.status === 404) return { notFound: true }; return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
};

// 管理员开关：函数名（不区分大小写）→ 中文说明 + 风险等级（2 = 影响你的资产，1 = 影响规则）
export const RISKY = [
  [/^(set)?(mint)?(price|cost|fee|pricing)/i, '可以改价格 / 费用', 1],
  [/^(pause|unpause|setpaused|togglepause|setmintactive|setsaleactive|togglesale|setopen|setmintopen)/i, '可以暂停 / 开关铸造', 1],
  [/^(ownermint|adminmint|devmint|teammint|reserve|airdrop|mintto|mintfor)/i, '管理员可以自己铸造 / 空投', 1],
  [/^(setmaxsupply|setsupply|increasesupply|setcap)/i, '可以改总量', 1],
  [/^(upgradeto|upgradetoandcall|setimplementation)/i, '合约可升级（规则可能整个被换掉）', 2],
  [/^(withdraw|withdrawall|withdrawfunds|rescue|sweep|emergencywithdraw|withdrawfrompool)/i, '可以提走合约里的资金', 1],
  [/^(blacklist|setblacklist|addblacklist|setblocked|block|ban|setbot)/i, '可以拉黑地址', 2],
  [/^(setbaseuri|seturi|settokenuri)/i, '可以改 NFT 图片 / 元数据', 0],
  [/^(settax|setfee|setbuytax|setselltax|settaxes)/i, '可以改交易税', 2],
];
const URL_RE = /https?:\/\/[^\s"'`<>)\]]+/g;
const NOISE = /w3\.org|schema\.org|ipfs\.io\/ipfs\/$|openzeppelin|github\.com\/(ethereum|openzeppelin|vectorized|transmissions11|chiru-labs|uniswap|pancakeswap)|eips\.ethereum\.org|soliditylang|solidity\.readthedocs|consensys|chain\.link|docs\.|ethereum\.org|spdx\.org|smartcontracts\.tools|creativecommons|wikipedia/i;

const CACHE_DIR = 'radar/src/';
const cacheFile = (a) => dataFile(`${CACHE_DIR}${lc(a)}.json`);

/** 已验证源码的提要（不存整份源码，只存用得到的）。verified: true / false / null（查询失败，稍后再试） */
export async function sourceInfo(addr) {
  const a = lc(addr);
  try { const c = JSON.parse(readFileSync(cacheFile(a), 'utf8')); if (c.verified !== null && Date.now() - c.at < (c.verified ? 30 : 1) * 24 * 3600_000 && (!c.verified || 'deployer' in c)) return c; } catch { /* 没缓存 */ }
  const j = await fetchJson(`${EP.sourcify}/v2/contract/56/${a}?fields=abi,sources,compilation,userdoc,devdoc,deployment`);
  if (!j) return { verified: null, at: Date.now() };
  if (j.notFound || !j.abi) { const o = { verified: false, at: Date.now() }; save(a, o); return o; }
  const abi = j.abi;
  const fns = abi.filter((x) => x.type === 'function');
  const sources = Object.entries(j.sources || {}).filter(([k]) => !/openzeppelin|@|node_modules|lib\//i.test(k));
  const text = sources.map(([, v]) => v?.content || '').join('\n');
  const links = [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[.,;]+$/, '')))].filter((u) => !NOISE.test(u)).slice(0, 12);
  const notice = clean(j.userdoc?.notice || j.devdoc?.details || j.devdoc?.title || '');
  // 每个函数的说明（userdoc.methods / devdoc.methods 的 notice / details）
  const methodDoc = {};
  for (const [sig, d] of Object.entries(j.userdoc?.methods || {})) if (d?.notice) methodDoc[sig] = clean(d.notice);
  for (const [sig, d] of Object.entries(j.devdoc?.methods || {})) if (!methodDoc[sig] && (d?.details || d?.notice)) methodDoc[sig] = clean(d.details || d.notice);
  const risks = [];
  for (const f of fns) {
    if (f.stateMutability === 'view' || f.stateMutability === 'pure') continue;
    for (const [re, label, lvl] of RISKY) if (re.test(f.name)) { if (!risks.some((r) => r.label === label)) risks.push({ label, level: lvl, fn: f.name }); break; }
  }
  const o = {
    verified: true, at: Date.now(), name: j.compilation?.name || null, compiler: j.compilation?.compilerVersion || null,
    deployer: j.deployment?.deployer ? lc(j.deployment.deployer) : null, deployBlock: j.deployment?.blockNumber ? Number(j.deployment.blockNumber) : null, deployTx: j.deployment?.transactionHash || null,
    abi, notice, methodDoc, links, risks,
    agentGate: /IAgentId|AGENT_ID|agentId|isAgent|0x60b9262456de011f7d15a54cdd8c48baaa8b022f/i.test(text),
    hasOwner: fns.some((f) => f.name === 'owner'), renounce: fns.some((f) => f.name === 'renounceOwnership'),
  };
  save(a, o);
  return o;
}
function save(a, o) { try { mkdirSync(dataFile(CACHE_DIR), { recursive: true }); writeFileSync(cacheFile(a), JSON.stringify(o)); } catch { /* ignore */ } }
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 3000);

// ---------- 翻译（英文说明 → 中文）：公共接口，按原文缓存 ----------
const TR_FILE = dataFile('radar/tr.json');
let tr = {}; try { tr = JSON.parse(readFileSync(TR_FILE, 'utf8')) || {}; } catch { /* 第一次 */ }
let trT = null;
const trKey = (s) => ethers.id(s).slice(0, 18);
// 机器翻译不懂币圈词（mints 会被翻成「薄荷糖」）：翻译前先把这几个词换成中文（函数名 mint(...) 不动）
const GLOSSARY = [[/\bmints\b(?!\()/gi, '铸造次数'], [/\bminting\b/gi, '铸造'], [/\bminted\b/gi, '已铸造'], [/\bmint\b(?!\()/gi, '铸造'], [/\bminter(s)?\b/gi, '铸造者'], [/\bairdrop(s)?\b/gi, '空投'], [/\bwhitelist(ed)?\b/gi, '白名单'], [/\bgas\b/gi, 'gas 费']];
const gloss = (t) => GLOSSARY.reduce((x, [re, w]) => x.replace(re, w), t);
export async function zh(s, { auto = false } = {}) {
  const raw = String(s || '').trim(); if (!raw) return null;
  const text = auto ? raw : gloss(raw);
  if (/[\u4e00-\u9fff]/.test(text) && !/[a-z]{4,}/i.test(text.replace(/0x[0-9a-f]+/gi, ''))) return text;   // 已经是中文
  const k = trKey((auto ? 'a:' : '') + text); if (tr[k]) return tr[k];
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(`${EP.translate}/translate_a/single?client=gtx&sl=${auto ? 'auto' : 'en'}&tl=zh-CN&dt=t&q=${encodeURIComponent(text.slice(0, 3000))}`, { signal: ac.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const out = (j?.[0] || []).map((x) => x?.[0] || '').join('').trim().replace(/薄荷糖|薄荷/g, '铸造').replace(/汽油费|燃气费/g, 'gas 费').replace(/汽油|燃气/g, 'gas');   // 机器翻译不懂币圈词
    if (!out) return null;
    tr[k] = out; clearTimeout(trT); trT = setTimeout(() => { try { mkdirSync(new URL('.', TR_FILE), { recursive: true }); writeFileSync(TR_FILE, JSON.stringify(tr)); } catch { /* ignore */ } }, 2000);
    return out;
  } catch { return null; } finally { clearTimeout(t); }
}
