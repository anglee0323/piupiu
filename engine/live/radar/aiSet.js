// .ai 钱包集合（方案 L1）：判断一个地址是否持有 Binance Agent ID NFT。查询有成本（一次 eth_call），
// 所以绝不主动全量扫，只「懒判断」：某个合约的调用者凑够人数了才查他们；结果缓存 24 小时（持有人基本不会卖）。
// 种子：names.json 里已经有 .ai 域名的地址直接算持有人（NameCache 长期积累，零成本）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from '../config.js';
import { AGENT_ID } from './known.js';

const lc = (a) => String(a || '').toLowerCase();
const AI_TTL = 24 * 3600_000;
const SEED_FILE = new URL('./ai-seed.txt', import.meta.url);

/** 内核自带的 .ai 钱包名单（scripts/radar-ai-seed.mjs 生成）：新装的电脑不用先积累几天才认得出 .ai 钱包。
 *  名单里的地址不过期（持有人基本不卖）；之后真去链上查过一次，就以查到的结果为准 */
const loadSeed = (file) => {
  const out = [];
  try { for (const l of readFileSync(file, 'utf8').split('\n')) { const k = l.trim(); if (/^[0-9a-f]{40}$/.test(k)) out.push('0x' + k); } } catch { /* 没有名单就空着 */ }
  return out;
};   // 持有 / 不持有都缓存一天（没卖过 Agent ID 的人不会突然有；卖了的人第二天重查）

/** names.all() 形如 { '0x…': 'abc.ai' }；这里只要 .ai 结尾的 */
const seedFromNames = (names) => {
  const out = new Map();
  try { for (const [a, n] of Object.entries(names?.all?.() || {})) if (String(n || '').endsWith('.ai')) out.set(lc(a), { ai: true, at: Date.now(), name: n }); } catch { /* 没有就空着 */ }
  return out;
};

export class AiSet {
  constructor({ provider, file = dataFile('radar/ai-cache.json'), names = null, seed = SEED_FILE, budgetPerMin = 30, concurrency = 4, log = () => {} }) {
    this.provider = provider; this.file = file; this.names = names; this.log = log;
    this.iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
    this.cache = seedFromNames(names);                       // 种子先上，避免一上来就查一堆已知的 .ai
    if (seed) for (const a of loadSeed(seed)) if (!this.cache.has(a)) this.cache.set(a, { ai: true, at: 0, name: null, seed: true });
    try {
      for (const [a, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) || {})) {
        if (v && typeof v === 'object') this.cache.set(lc(a), { ai: !!v.ai, at: Number(v.at) || 0, name: v.name || null });
        else if (v) this.cache.set(lc(a), { ai: true, at: Date.now(), name: String(v) });   // 旧格式：直接是名字
      }
    } catch { /* 第一次没有文件 */ }
    this.queue = []; this.queued = new Set(); this.inflight = 0;
    this.minute = { at: Date.now(), n: 0 }; this.budget = budgetPerMin; this.concurrency = concurrency;
    this.saveT = null;
  }
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      const o = {}; for (const [a, v] of this.cache) if (v.ai && !v.seed) o[a] = { ai: true, at: v.at, name: v.name || undefined };
      try { mkdirSync(new URL('.', this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(o)); } catch (e) { this.log(`ai-cache 写不进去：${e.message}`); }
    }, 3000);
  }
  /** 已缓存且没过期的结论；unknown = 还没查过 */
  peek(addr) {
    const k = lc(addr); if (!/^0x[0-9a-f]{40}$/.test(k)) return undefined;
    const v = this.cache.get(k);
    if (v && (v.seed || Date.now() - v.at < AI_TTL)) return v.ai;
    return undefined;
  }
  /** 想知道这些地址是不是 .ai：没结论的排队查（有每分钟预算，超了就等下一分钟）。立即返回当前已知部分 */
  want(addrs) {
    const out = new Map();
    const now = Date.now();
    if (now - this.minute.at > 60_000) this.minute = { at: now, n: 0 };
    for (const a of addrs || []) {
      const k = lc(a); if (!/^0x[0-9a-f]{40}$/.test(k)) continue;
      const v = this.cache.get(k);
      if (v && (v.seed || now - v.at < AI_TTL)) { out.set(k, v.ai); continue; }
      if (this.minute.n < this.budget && !this.queued.has(k)) { this.queued.add(k); this.queue.push(k); this.minute.n++; }
    }
    this.kick();
    return out;
  }
  kick() {
    while (this.inflight < this.concurrency && this.queue.length) {
      const k = this.queue.shift(); this.queued.delete(k);
      this.inflight++;
      this.check(k).catch(() => {}).finally(() => { this.inflight--; this.kick(); });
    }
  }
  async check(k) {
    let r;
    try { r = await this.provider.call({ to: AGENT_ID, data: this.iface.encodeFunctionData('balanceOf', [k]) }); }
    catch { return undefined; }   // 节点出错：不缓存，下次再查
    const ai = BigInt(r) > 0n;   // revert 会抛错，同样按「没查到」处理
    this.cache.set(k, { ai, at: Date.now(), name: this.cache.get(k)?.name || null });
    if (ai) { this.names?.peek?.(k); this.save(); }   // 是 .ai：顺手让它有个名字（handleOf 走 NameCache 自己的队列）
    return ai;
  }
  /** 统计用：已知持有 Agent ID 的地址数 */
  count() { let n = 0; for (const v of this.cache.values()) if (v.ai) n++; return n; }
}
