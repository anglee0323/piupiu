// 推特上怎么说（可选）：配了 CRAWLERHUB_API_KEY 才查（CrawlerHub Twitter API，twitterapi.io 风格）。
// 实测按合约地址基本搜不到，按项目名能搜到「今天能打的 Agent 免费 mint」这类汇总帖，所以先按地址、再按名字搜，
// 只保留正文里真的提到这个名字 / 地址的推文。结果：讨论条数、最有影响力的几条、疑似官方账号。每个合约缓存 30 分钟。
// 没配 key 时只给「在 X 上搜」的跳转链接。
// 用量：这是用户自己的外部接口额度，和链上扫描（公共节点）无关。这里只统计本机发起的请求数，不冒充服务商余额。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataFile } from '../config.js';
import { zh } from './source.js';
import { EP } from '../endpoints.js';

const BASE = EP.xSearch;
const TTL = 30 * 60_000;
const ERR_TTL = 5 * 60_000;   // 失败的结果只缓存 5 分钟：不要一失败就把项目锁死半小时
const lc = (a) => String(a || '').toLowerCase();
const norm = (s) => lc(s).replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const file = (a) => dataFile(`radar/social/${lc(a)}.json`);
export const socialEnabled = () => !!process.env.CRAWLERHUB_API_KEY;
export const xSearchUrl = (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;

// ---------- 本机调用计数（按天） ----------
const STATS = dataFile('radar/social-stats.json');
const today = () => new Date().toISOString().slice(0, 10);
let usage = { day: '', requests: 0, failures: 0, total: 0 };
try { usage = { ...usage, ...JSON.parse(readFileSync(STATS, 'utf8')) }; } catch { /* 第一次 */ }
let statT = null;
function bump(n = 1, fail = false) {
  const d = today();
  if (usage.day !== d) { usage.day = d; usage.requests = 0; usage.failures = 0; }
  usage.requests += n; usage.total += n; if (fail) usage.failures++;
  clearTimeout(statT);
  statT = setTimeout(() => { try { mkdirSync(new URL('.', STATS), { recursive: true }); writeFileSync(STATS, JSON.stringify(usage)); } catch { /* ignore */ } }, 2000);
}
// 每日请求上限（用的是你自己的 CrawlerHub 额度）：到了就不再发请求，已有缓存照常显示，第二天（本机日期）自动恢复。默认 300，雷达设置里可改
let dailyMax = 300;
export const setSocialDailyCap = (n) => { const x = Math.round(Number(n)); if (Number.isFinite(x) && x >= 20 && x <= 5000) dailyMax = x; };
const usedToday = () => (usage.day === today() ? usage.requests : 0);
export const socialStats = () => ({ day: usage.day || today(), today: usedToday(), total: usage.total || 0, failures: usage.failures || 0, enabled: socialEnabled(), max: dailyMax, capped: usedToday() >= dailyMax });

async function search(query, retry = 1) {
  if (usedToday() >= dailyMax) return { error: `今天的 X 查询已达上限（${dailyMax} 次），明天自动恢复；也可以在雷达设置里调高` };
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
  bump(1);
  try {
    const r = await fetch(`${BASE}/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`, { signal: ac.signal, headers: { 'X-API-Key': process.env.CRAWLERHUB_API_KEY } });
    if (!r.ok) { bump(0, true); if (retry > 0 && r.status >= 500) { await new Promise((x) => setTimeout(x, 1500)); return search(query, retry - 1); } return { error: `接口返回 ${r.status}` }; }
    const j = await r.json(); return { tweets: Array.isArray(j.tweets) ? j.tweets : [] };
  } catch (e) { bump(0, true); return { error: e.name === 'AbortError' ? '超时' : e.message }; } finally { clearTimeout(t); }
}

const tweetUrl = (t) => t.url || t.twitterUrl || (t.author?.userName && t.id ? `https://x.com/${t.author.userName}/status/${t.id}` : null);
const ts = (t) => { const d = Date.parse(t.createdAt || t.created_at || ''); return Number.isFinite(d) ? d : null; };

// 相关性（v4）：同名的人 / 事很多（SHENLONG 是航天器，Goofy、Mars Plot、Charm 都是常见词）。
//   强相关：正文里有这个合约地址。
//   名字相关：整词匹配项目全名，并且同时带「Agent ID / .ai / Agentic / BNB Chain」这类本赛道语境 + 「mint / NFT」。光有 agent、token、gas 这种泛词不算。
//   清单帖：一条推文里列了 3 个以上合约地址（「今天能打的 70 个免费 mint」），只算「被收录」，不算讨论，也不用来推断官方账号。
const SCENE = /(agent ?id|\.ai\b|agentic|bnb ?chain|\bbsc\b|binance)/i;
const MINTY = /(mint|nft|铸造|免费)/i;
const ADDR_RE = /0x[0-9a-f]{40}/gi;
// 最长公共子串长度：@agentmineid 和「Agent Miner Common Hammer」共有 agentmine（9）；只共有 agent（5）不算
const common = (x, y) => { let best = 0; for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) { let k = 0; while (x[i + k] && x[i + k] === y[j + k]) k++; if (k > best) best = k; } return best; };
const addrsIn = (txt) => new Set((String(txt || '').match(ADDR_RE) || []).map(lc));
const inflight = new Map();   // 同一个合约并发查（详情 + 列表同时触发）只发一轮请求

/** names：候选名字（元数据名 / 合约名 / 代号），按顺序试；force = 忽略缓存 */
export async function socialInfo(address, names, { force = false, knownHandles = [] } = {}) {
  const a = lc(address);
  if (!force) {
    try { const c = JSON.parse(readFileSync(file(a), 'utf8')); const ttl = c.error && !c.count ? ERR_TTL : TTL; if (c.v === 4 && Date.now() - c.at < ttl) return c; } catch { /* 没缓存 */ }
  }
  if (inflight.has(a)) return inflight.get(a);
  const p = run(a, names, { force, knownHandles }).finally(() => inflight.delete(a));
  inflight.set(a, p);
  return p;
}

async function run(a, names, { knownHandles }) {
  // 只用完整的项目名搜（代号太短太泛：AGM-CARD 会匹配到「Arsenal AGM. Card vote」）；名字按整词匹配，空格 / 连字符可互换
  const cand = [...new Set((names || []).map((n) => String(n || '').trim()).filter((n) => norm(n).length >= 5 && /[a-z\u4e00-\u9fff]/i.test(n)))].slice(0, 2);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = cand.map((n) => new RegExp(`(^|[^a-z0-9])${n.split(/[\s_-]+/).map(esc).join('[\\s_-]?')}($|[^a-z0-9])`, 'i'));
  const out = { v: 4, at: Date.now(), enabled: socialEnabled(), query: cand[0] || a, searchUrl: xSearchUrl(a), count: 0, byAddr: 0, byName: 0, lists: 0, last24h: 0, top: [], official: null, error: null };
  if (!out.enabled) return out;
  const seen = new Map();
  const keep = (t) => {
    const txt = String(t.text || ''), addrs = addrsIn(txt);
    const withAddr = addrs.has(a);
    const byName = !withAddr && res.some((re) => re.test(txt)) && SCENE.test(txt) && MINTY.test(txt);
    if (!withAddr && !byName) return;
    seen.set(String(t.id || tweetUrl(t)), { t, how: withAddr ? 'addr' : 'name', list: addrs.size >= 3 });
  };
  const r1 = await search(a); if (r1.error) out.error = r1.error; for (const t of r1.tweets || []) keep(t);
  for (const n of cand) { const r = await search(`"${n}" (agent OR agentic OR nft OR mint OR bnb OR bsc)`); if (r.error) out.error ||= r.error; for (const t of r.tweets || []) keep(t); }
  const list = [...seen.values()];
  out.count = list.length;
  out.byAddr = list.filter((x) => x.how === 'addr').length;
  out.byName = list.length - out.byAddr;
  out.lists = list.filter((x) => x.list).length;
  out.last24h = list.filter((x) => (ts(x.t) || 0) > Date.now() - 86400_000).length;
  // 排序：专门讲这个项目的（不是清单帖）优先，其次带合约地址的，再按影响力
  const rank = (x) => (x.list ? 0 : 1e6) + (x.how === 'addr' ? 1e5 : 0) + (x.t.likeCount || 0) + 2 * (x.t.retweetCount || 0) + (x.t.author?.followers || 0) / 1000;
  out.top = list.sort((x, y) => rank(y) - rank(x)).slice(0, 4)
    .map(({ t, how, list: isList }) => ({ user: t.author?.userName || null, name: t.author?.name || null, followers: t.author?.followers ?? null, text: String(t.text || '').replace(/\s+/g, ' ').slice(0, 280), likes: t.likeCount || 0, rts: t.retweetCount || 0, at: ts(t), url: tweetUrl(t), how, list: isList }));
  // 推文翻成中文（本来就是中文的不翻）
  const need = out.top.filter((t) => !/[\u4e00-\u9fff]{4,}/.test(t.text));
  await Promise.all(need.map(async (t) => { t.zh = await zh(t.text, { auto: true }).catch(() => null); }));
  // 官方账号：只认两种证据——项目元数据 / 官网里给的 X 链接；或者账号名和项目名一致、而且它自己发的推文里带着这个合约地址。
  // 以前「作者名 / 被 @ 的账号里包含项目名」就算，会把同名的无关账号当成官方
  let best = knownHandles[0] ? { handle: lc(knownHandles[0]), from: '项目元数据 / 官网' } : null;
  if (!best) {
    for (const { t, how, list: isList } of list) {
      const u = t.author?.userName;
      if (how === 'addr' && !isList && u && cand.some((n) => common(norm(u), norm(n)) >= 6 || common(norm(t.author?.name), norm(n)) >= 6)) { best = { handle: lc(u), from: '该账号发布过合约地址' }; break; }
    }
  }
  if (best) out.official = { handle: best.handle, url: `https://x.com/${best.handle}`, from: best.from };
  try { mkdirSync(dataFile('radar/social/'), { recursive: true }); writeFileSync(file(a), JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}
