// 币安公开代币安全审计（只读，不需要钱包和 key）：风险等级、命中的风险项、审计到的买卖税。
// 思路和接口来自 jacke-pp/ai-wallet-binance（lib/check.mjs 的 binanceAudit），这里加了缓存和并发去重。
// 等级 >= 3 时，币安风控通常会让这个币的每笔交易都要在币安 App 里点确认（GANG 内盘币实测如此），页面上单独提示。
// 刚发出来的币常常还没有审计结果（hasResult = false），这时显示「暂无」，不当成低风险。
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { EP } from './endpoints.js';

const AUDIT_URL = EP.binanceWeb3 ? `${EP.binanceWeb3}/bapi/defi/v1/public/wallet-direct/security/token/audit` : '';
const TTL_OK = 10 * 60_000, TTL_NONE = 2 * 60_000;   // 有结果缓存 10 分钟；暂无结果 / 出错 2 分钟后再查
const cache = new Map(), inflight = new Map();
const pct = (x) => (x == null || x === '' ? null : Math.round(Number(x) * 10000) / 100);   // 接口给的是小数（0.02 = 2%）

async function fetchAudit(token, chainId) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(AUDIT_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', source: 'agent', 'user-agent': 'binance-web3/1.4 (Skill)' },
      body: JSON.stringify({ binanceChainId: String(chainId), contractAddress: token.toLowerCase(), requestId: randomUUID() }),
    });
    const j = await res.json();
    const d = j?.data;
    if (!d?.isSupported) return { available: false, reason: 'unsupported' };
    if (!d.hasResult) return { available: false, reason: 'pending' };
    const hits = (d.riskItems || []).flatMap((i) => (i.details || []).filter((x) => x.isHit).map((x) => ({ group: i.id, title: x.title, desc: x.description || '', type: x.riskType })));
    const x = d.extraInfo || {};
    return {
      available: true, level: Number(d.riskLevel), levelName: d.riskLevelEnum, buyTax: pct(x.buyTax), sellTax: pct(x.sellTax),
      verified: x.isVerified ?? null, flagged: !!x.isFlaggedByVendor, reported: !!x.isReported, unusualTax: !!(x.unusualBuyTax || x.unusualSellTax), hits,
      appConfirm: Number(d.riskLevel) >= 3,
    };
  } catch (e) {
    return { available: false, reason: 'error', error: String(e.name === 'AbortError' ? 'timeout' : e.message).slice(0, 120) };
  } finally { clearTimeout(t); }
}

export async function tokenAudit(token, { chainId = 56 } = {}) {
  if (!ethers.isAddress(String(token))) throw new Error('invalid_token');
  const k = String(token).toLowerCase(), hit = cache.get(k);
  if (hit && Date.now() - hit.at < (hit.available ? TTL_OK : TTL_NONE)) return hit;
  if (inflight.has(k)) return inflight.get(k);
  const job = fetchAudit(k, chainId).then((r) => { const v = { ...r, token: k, at: Date.now() }; cache.set(k, v); return v; }).finally(() => inflight.delete(k));
  inflight.set(k, job); return job;
}
