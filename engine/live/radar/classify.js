// 从「.ai 钱包成功调用」的交易回执里判断这是什么机会：调用之后调用者收到了什么、付出了什么。
// 纯函数（输入回执 + 交易，输出结论），便于单测。
import { T_TRANSFER, T_1155_SINGLE, T_1155_BATCH, ZERO } from './chain.js';

const lc = (a) => String(a || '').toLowerCase();
const topicAddr = (t) => '0x' + String(t).slice(26).toLowerCase();
const word = (data, i) => BigInt('0x' + (String(data).slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));

/** 一笔交易：调用者 from 收到 / 送出了哪些代币（ERC20 / 721 / 1155），谁铸造的 */
export function flows(rc, from) {
  const me = lc(from); const got = [], gave = [], minted = [];
  for (const l of rc?.logs || []) {
    const t0 = l.topics?.[0];
    if (t0 === T_TRANSFER && l.topics.length === 4) {            // ERC721
      const f = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), id = BigInt(l.topics[3]);
      const x = { token: lc(l.address), std: '721', amount: 1n, id, mint: f === ZERO };
      if (to === me) got.push(x); if (f === me) gave.push(x);
      if (f === ZERO) minted.push({ ...x, to });
    } else if (t0 === T_TRANSFER && l.topics.length === 3) {     // ERC20
      const f = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), amt = word(l.data, 0);
      const x = { token: lc(l.address), std: '20', amount: amt, mint: f === ZERO };
      if (to === me) got.push(x); if (f === me) gave.push(x);
      if (f === ZERO) minted.push({ ...x, to });
    } else if (t0 === T_1155_SINGLE) {
      const f = topicAddr(l.topics[2]), to = topicAddr(l.topics[3]);
      const x = { token: lc(l.address), std: '1155', id: word(l.data, 0), amount: word(l.data, 1), mint: f === ZERO };
      if (to === me) got.push(x); if (f === me) gave.push(x);
      if (f === ZERO) minted.push({ ...x, to });
    } else if (t0 === T_1155_BATCH) {
      const f = topicAddr(l.topics[2]), to = topicAddr(l.topics[3]);
      const x = { token: lc(l.address), std: '1155', amount: 1n, mint: f === ZERO };
      if (to === me) got.push(x); if (f === me) gave.push(x);
      if (f === ZERO) minted.push({ ...x, to });
    }
  }
  return { got, gave, minted };
}

/**
 * 归类：samples = [{ rc, tx }]（只放成功的调用），target = 被调用的合约。
 * kind：nft-mint | token-mint | claim | buy | sell | launch | interact
 */
export function classify(samples, target) {
  const tgt = lc(target);
  const votes = new Map(); const per = [];
  for (const { rc, tx } of samples) {
    if (!rc || rc.status !== 1) continue;
    const f = flows(rc, tx.from);
    const value = BigInt(tx.value || 0);
    const nft = f.got.filter((x) => x.std !== '20');
    const erc = f.got.filter((x) => x.std === '20');
    let k = 'interact';
    // 发射台：调用者自己的交易里出现「新合约铸出全部供应」，且被铸的代币不是目标合约本身
    const launched = f.minted.filter((m) => m.std === '20' && m.token !== tgt && m.token !== lc(tx.from));
    if (nft.some((x) => x.mint)) k = 'nft-mint';
    else if (launched.length && !erc.length) k = 'launch';
    else if (erc.some((x) => x.mint)) k = value > 0n ? 'buy' : 'token-mint';
    else if (erc.length) k = value > 0n || f.gave.length ? 'buy' : 'claim';
    else if (f.gave.length && !f.got.length) k = 'sell';
    else if (launched.length) k = 'launch';
    votes.set(k, (votes.get(k) || 0) + 1);
    per.push({ kind: k, value, nft, erc, gave: f.gave, launched, gasUsed: BigInt(rc.gasUsed || 0), gasPrice: BigInt(rc.gasPrice || rc.effectiveGasPrice || tx.gasPrice || 0) });
  }
  if (!per.length) return { kind: 'unknown', n: 0 };
  const kind = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const same = per.filter((p) => p.kind === kind);
  const med = (arr) => { const s = arr.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s[Math.floor(s.length / 2)] ?? 0n; };
  // 每次得到什么（取最常见的代币 + 中位数量）
  const recv = same.flatMap((p) => (kind === 'nft-mint' ? p.nft : p.erc));
  const byToken = new Map(); for (const r of recv) { const k = r.token; byToken.set(k, (byToken.get(k) || 0) + 1); }
  const mainToken = [...byToken.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const perCall = same.map((p) => (kind === 'nft-mint' ? p.nft : p.erc).filter((x) => x.token === mainToken).reduce((a, x) => a + (x.amount || 1n), 0n));
  return {
    kind, n: per.length, agree: same.length,
    valueWei: med(same.map((p) => p.value)), valueVaries: new Set(same.map((p) => String(p.value))).size > 1,
    token: mainToken, std: recv.find((x) => x.token === mainToken)?.std || null, perCall: med(perCall),
    tokenVaries: kind === 'launch' || byToken.size > 1 && kind !== 'nft-mint',
    pays: [...new Set(same.flatMap((p) => p.gave.map((g) => g.token)))],   // 付出去的代币（支付币 / 卖出的币）
    gasWei: med(same.map((p) => p.gasUsed * p.gasPrice)),
  };
}

export const KIND_LABEL = { 'nft-mint': '铸造 NFT', 'token-mint': '铸造代币', claim: '领取', buy: '买入', sell: '卖出', launch: '发射台', interact: '合约交互', unknown: '未知' };
