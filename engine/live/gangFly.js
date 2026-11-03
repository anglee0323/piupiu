// gang.fun「铸币飞轮」（GangFlywheelPad，V1 0x631e…B029、V2 0x2818…8a5a，2026-10-30 起主网）：
//   开盘前：10000 份同一价格铸造（每份 tokensPerShare 个币），每个钱包有额度（基础额度 + 邀请加成），每笔最多 maxPerTx 份，
//          打满（或创建者在 ≥30% 时提前开盘）前可以按铸造价卖回（扣退出费，7 天没进展后退出费为 0）；
//   开盘：按铸造价在 PancakeSwap V2 开池，之后一段保护期（买入要 Agent ID、单钱包有上限）；买入税 1%、卖出税 1–2%；
//   开盘后（postMint 开着时）：按档位价继续铸造，钱进池子，铸出的币价格不低于池子价；持有人（铸造过的钱包）分一部分税。
// 依据：gangfun/gang-launchpad 的 skill/references/fly.md、skill/gang-cli/src/fly.js、src/flywheel/*（合约接口）。
// 只支持 WBNB 计价的飞轮（mintWithBnb / mintPostWithBnb 直接付 BNB，多付的找零）；目前主网的飞轮都是 WBNB 计价。
// 开盘后在池子里的普通买卖走外盘（liveTrader.dexTrade），这里只管铸造 / 卖回 / 开盘后铸造 / 领持有人奖励。
import { ethers } from 'ethers';
import { waitReceived } from './quoteRoutes.js';

export const FLY_PADS = ['0x631e66560F4FAE4e486B65349edE48189E48B029', '0x281889ad915c1A95ffc4922235c6314b3Cbd8a5a'].map((a) => a.toLowerCase());
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const padI = new ethers.Interface([
  'function mintWithBnb(address token, uint256 shares, uint256 minShares, address referrer) payable returns (uint256 spent)',
  'function withdraw(address token, uint256 shares, uint256 minPayout) returns (uint256 payout)',
  'function mintPostWithBnb(address token, uint256 shares, uint256 minTokensOut, address referrer) payable returns (uint256 tokensOut, uint256 spent)',
  'function accounts(address token, address user) view returns (uint32 preShares, uint32 used, uint32 bonus, bool minted, uint64 windowStart, uint128 windowSpent, uint256 baseline)',
  'function quotaLeft(address token, address user) view returns (uint256)',
  'function previewMint(address token, address user, uint256 shares) view returns (uint256 accepted, uint256 cost, uint256 fee)',
  'function previewMintPost(address token, address user, uint256 shares) view returns (uint256 accepted, uint256 paid, uint256 fee, uint256 tokensOut, bool ok)',
  'function previewWithdraw(address token, address user, uint256 shares) view returns (uint256 payout, uint256 fee)',
  'function dividendVault() view returns (address)',
]);
const tokI = new ethers.Interface(['function launchpad() view returns (address)', 'function balanceOf(address) view returns (uint256)']);
const vaultI = new ethers.Interface(['function pending(address token, address user) view returns (uint256)', 'function claim(address token) returns (uint256)']);
const wbnbI = new ethers.Interface(['function withdraw(uint256)', 'function balanceOf(address) view returns (uint256)']);
const minOut = (v, slip) => (v * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
// 合约的拒绝原因 → 用户能看懂的说明（选择器来自 IFlywheelPad 的 error）
const REASONS = {
  NotAgent: '钱包没有 Agent ID，无法铸造', NotMinting: '铸造已结束（已打满或已开盘）', NotLaunched: '尚未开盘', TooEarly: '还没到时间',
  Slippage: '价格变化超过滑点', PaceExceeded: '超过每 30 分钟的铸造上限，请稍后再试', PostMintOff: '这个飞轮开盘后不能继续铸造',
  PriceBelowAverage: '池子价格低于近期均价，开盘后铸造暂停', PriceBelowRecentHigh: '池子价格低于近期高点，开盘后铸造暂停', PriceAbovePool: '铸造价高于池子价，开盘后铸造暂停',
  CapExceeded: '已到总量上限', BnbNotQuote: '这个飞轮不是 BNB 计价', TooFewShares: '份数不足',
};
const SELECTORS = Object.fromEntries(Object.keys(REASONS).map((n) => [ethers.id(`${n}()`).slice(0, 10), n]));
function friendly(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  const name = typeof data === 'string' ? SELECTORS[data.slice(0, 10)] : null;
  return name ? REASONS[name] : errMsg(e);
}

export class GangFly {
  constructor(provider, send) { this.provider = provider; this.send = send; this.pads = new Map(); }

  async call(to, i, fn, args, extra = {}) { return i.decodeFunctionResult(fn, await this.provider.call({ to, data: i.encodeFunctionData(fn, args), ...extra })); }

  /** 代币所在的飞轮发射台（GangMintToken.launchpad()），只认两个官方地址 */
  async pad(token) {
    const k = String(token).toLowerCase();
    if (this.pads.has(k)) return this.pads.get(k);
    const p = String((await this.call(token, tokI, 'launchpad', []))[0]).toLowerCase();
    if (!FLY_PADS.includes(p)) throw new Error('不是 gang.fun 铸币飞轮的代币');
    this.pads.set(k, p); return p;
  }

  /** 钱包在这个飞轮里的情况：剩余额度、开盘前持有的份数（可卖回）、已用额度、邀请加成；可领的持有人奖励 */
  async account(token, wallet) {
    const p = await this.pad(token);
    const [a, left, vault] = await Promise.all([this.call(p, padI, 'accounts', [token, wallet]), this.call(p, padI, 'quotaLeft', [token, wallet]).then((x) => x[0]), this.vault(p)]);
    const pending = vault ? await this.call(vault, vaultI, 'pending', [token, wallet]).then((x) => x[0]).catch(() => 0n) : 0n;
    return { pad: p, quotaLeft: Number(left), preShares: Number(a.preShares), used: Number(a.used), bonus: Number(a.bonus), minted: a.minted, pendingReward: pending };
  }
  async vault(p) { this.vaults ||= new Map(); if (!this.vaults.has(p)) this.vaults.set(p, await this.call(p, padI, 'dividendVault', []).then((x) => x[0]).catch(() => null)); return this.vaults.get(p); }

  /** BNB 金额 → 份数：按每份价格（含铸造费）向下取整，不超过剩余额度和每笔上限 */
  shareCount(amountBnb, perShareWei, quotaLeft, maxPerTx) {
    const wei = ethers.parseEther(Number(amountBnb).toFixed(18).replace(/\.?0+$/, '') || '0');
    const n = perShareWei > 0n ? Number(wei / perShareWei) : 0;
    return Math.max(0, Math.min(n, quotaLeft, maxPerTx || 10));
  }

  /** 开盘前铸造的报价：amountBnb 能铸几份、实际花多少、能拿到多少个币 */
  async previewMint({ token, wallet, amountBnb, fly }) {
    const p = await this.pad(token);
    const left = Number((await this.call(p, padI, 'quotaLeft', [token, wallet]))[0]);
    const per = (BigInt(fly.sharePriceWei) * BigInt(10000 + Math.round(fly.mintFeePct * 100))) / 10000n;
    const shares = this.shareCount(amountBnb, per, left, fly.maxPerTx);
    if (shares < 1) return { shares: 0, quotaLeft: left, note: left < 1 ? '这个钱包的铸造额度已用完' : `金额不足 1 份（每份约 ${ethers.formatEther(per)} BNB，含铸造费）` };
    const r = await this.call(p, padI, 'previewMint', [token, wallet, BigInt(shares)]);
    return { pad: p, shares, accepted: Number(r.accepted), cost: r.cost, fee: r.fee, spend: r.cost + r.fee, tokens: Number(r.accepted) * fly.tokensPerShare, quotaLeft: left };
  }

  /** 开盘前铸造：mintWithBnb（付 BNB，多付的找零） */
  async mint({ wallet, token, amountBnb, step, fly }) {
    const q = await this.previewMint({ token, wallet, amountBnb, fly });
    if (!q.shares) throw new Error(q.note);
    if (q.accepted < 1) throw new Error('这个钱包的铸造额度已用完');
    step(`铸造 ${q.accepted} 份，花费 ${ethers.formatEther(q.spend)} BNB（含铸造费 ${ethers.formatEther(q.fee)}）`, 0);
    const data = padI.encodeFunctionData('mintWithBnb', [token, BigInt(q.accepted), BigInt(q.accepted), ethers.ZeroAddress]);
    try { await this.provider.call({ from: wallet, to: q.pad, data, value: q.spend }); } catch (e) { throw new Error(`链上模拟失败：${friendly(e)}`); }
    const tx = await this.send({ wallet, to: q.pad, valueWei: q.spend, inputData: data, label: '铸币飞轮 · 铸造', step });
    return { venue: '铸币飞轮 · 开盘前铸造', expected: q.tokens, txHash: tx, hashes: [tx], note: `铸造 ${q.accepted} 份` };
  }

  /** 开盘后铸造的报价：按 1 份的价格估算份数，再精确预览 */
  async previewMintPost({ token, wallet, amountBnb, fly }) {
    const p = await this.pad(token);
    const left = Number((await this.call(p, padI, 'quotaLeft', [token, wallet]))[0]);
    if (left < 1) return { shares: 0, quotaLeft: left, note: '这个钱包的铸造额度已用完' };
    const one = await this.call(p, padI, 'previewMintPost', [token, wallet, 1n]);
    if (!one.ok) return { shares: 0, quotaLeft: left, note: '开盘后铸造暂停（池子价格规则），可以直接在池子里买' };
    const shares = this.shareCount(amountBnb, one.paid + one.fee, left, fly.maxPerTx);
    if (shares < 1) return { shares: 0, quotaLeft: left, note: `金额不足 1 份（现在每份约 ${ethers.formatEther(one.paid + one.fee)} BNB）` };
    const r = await this.call(p, padI, 'previewMintPost', [token, wallet, BigInt(shares)]);
    if (!r.ok) return { shares: 0, quotaLeft: left, note: '开盘后铸造暂停（池子价格规则），可以直接在池子里买' };
    return { pad: p, shares, accepted: Number(r.accepted), paid: r.paid, fee: r.fee, spend: r.paid + r.fee, tokensOut: r.tokensOut, tokens: Number(ethers.formatEther(r.tokensOut)), quotaLeft: left };
  }

  /** 开盘后铸造：mintPostWithBnb（最少拿到 tokensOut × (1 − 滑点)；多付 1% 防止价格在这一块里变动，多的找零） */
  async mintPost({ wallet, token, amountBnb, slippage, step, fly }) {
    const q = await this.previewMintPost({ token, wallet, amountBnb, fly });
    if (!q.shares) throw new Error(q.note);
    const value = (q.spend * 101n) / 100n;
    step(`开盘后铸造 ${q.accepted} 份，预计 ${ethers.formatEther(q.tokensOut)} 个，花费约 ${ethers.formatEther(q.spend)} BNB`, 0);
    const data = padI.encodeFunctionData('mintPostWithBnb', [token, BigInt(q.accepted), minOut(q.tokensOut, slippage), ethers.ZeroAddress]);
    try { await this.provider.call({ from: wallet, to: q.pad, data, value }); } catch (e) { throw new Error(`链上模拟失败：${friendly(e)}`); }
    const tx = await this.send({ wallet, to: q.pad, valueWei: value, inputData: data, label: '铸币飞轮 · 开盘后铸造', step });
    return { venue: '铸币飞轮 · 开盘后铸造', expected: q.tokens, txHash: tx, hashes: [tx], note: `铸造 ${q.accepted} 份` };
  }

  /** 卖回的报价：pct% 的开盘前份数（至少 1 份） */
  async previewWithdraw({ token, wallet, pct }) {
    const p = await this.pad(token);
    const a = await this.call(p, padI, 'accounts', [token, wallet]);
    const have = Number(a.preShares);
    if (have < 1) return { shares: 0, note: '没有可卖回的份数（只有开盘前铸造、还没卖回的份数可以卖回）' };
    const shares = pct >= 100 ? have : Math.max(1, Math.floor((have * pct) / 100));
    const r = await this.call(p, padI, 'previewWithdraw', [token, wallet, BigInt(shares)]);
    return { pad: p, shares, have, payout: r.payout, fee: r.fee };
  }

  /** 卖回：withdraw（按铸造价退回 WBNB，扣退出费）→ 需要时把 WBNB 换回 BNB */
  async withdraw({ wallet, token, pct, step, toBnb = true }) {
    const q = await this.previewWithdraw({ token, wallet, pct });
    if (!q.shares) throw new Error(q.note);
    step(`卖回 ${q.shares} / ${q.have} 份，得到 ${ethers.formatEther(q.payout)} WBNB（退出费 ${ethers.formatEther(q.fee)}）`, 0);
    const data = padI.encodeFunctionData('withdraw', [token, BigInt(q.shares), q.payout]);
    try { await this.provider.call({ from: wallet, to: q.pad, data }); } catch (e) { throw new Error(`链上模拟失败：${friendly(e)}`); }
    const hashes = [];
    try { hashes.push(await this.send({ wallet, to: q.pad, inputData: data, label: '铸币飞轮 · 卖回', step })); }
    catch (e) {
      // 卖回要在币安 App 里确认（高风险代币常这样）：确认后 WBNB 到账再换回 BNB（交给上层 followUp）；以前确认后 WBNB 就留在钱包里了
      const fromBlock = toBnb ? await this.provider.getBlockNumber().then((b) => b - 2).catch(() => undefined) : null;
      if (toBnb && ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) e.afterConfirm = async (log) => {
        const got = await waitReceived({ provider: this.provider, token: WBNB, wallet, senders: [q.pad], fromBlock });
        if (got <= 0n) return { note: '5 分钟内没收到 WBNB（可能在 App 里拒绝了），没有换回 BNB' };
        const tx = await this.unwrap({ wallet, amount: got, step: log });
        return { venue: '铸币飞轮 · 卖回 → BNB', expected: Number(ethers.formatEther(got)), txHash: tx, hashes: [tx] };
      };
      throw e;
    }
    if (toBnb) hashes.push(await this.unwrap({ wallet, amount: q.payout, step }));
    return { venue: `铸币飞轮 · 卖回${toBnb ? ' → BNB' : '（得到 WBNB）'}`, expected: Number(ethers.formatEther(q.payout)), txHash: hashes.at(-1), hashes, note: `卖回 ${q.shares} 份` };
  }

  /** 领持有人奖励（分红金库 claim，奖励是 WBNB）→ 需要时换回 BNB */
  async claim({ wallet, token, step, toBnb = true }) {
    const p = await this.pad(token), v = await this.vault(p);
    if (!v) throw new Error('读不到这个飞轮的分红金库');
    const pending = (await this.call(v, vaultI, 'pending', [token, wallet]))[0];
    if (pending <= 0n) throw new Error('暂无可领取的持有人奖励');
    const data = vaultI.encodeFunctionData('claim', [token]);
    try { await this.provider.call({ from: wallet, to: v, data }); } catch (e) { throw new Error(`链上模拟失败：${friendly(e)}`); }
    const hashes = [await this.send({ wallet, to: v, inputData: data, label: '铸币飞轮 · 领取持有人奖励', step })];
    if (toBnb) hashes.push(await this.unwrap({ wallet, amount: pending, step }));
    return { venue: '铸币飞轮 · 领取持有人奖励', expected: Number(ethers.formatEther(pending)), txHash: hashes.at(-1), hashes };
  }

  // WBNB 到账后解包成 BNB：按链上余额，最多等约 10 秒；解包数量不超过本次应到的数量
  async unwrap({ wallet, amount, step }) {
    let bal = 0n;
    for (let i = 0; i < 34; i++) { bal = (await this.call(WBNB, wbnbI, 'balanceOf', [wallet]))[0]; if (bal >= amount) break; await sleep(300); }
    const qty = bal < amount ? bal : amount;
    if (qty <= 0n) throw new Error('没有读到 WBNB 到账，没有换回 BNB（可在资产页把 WBNB 换回 BNB）');
    return this.send({ wallet, to: WBNB, inputData: wbnbI.encodeFunctionData('withdraw', [qty]), label: 'WBNB→BNB 解包', step });
  }

  async balanceOf(token, wallet) { return (await this.call(token, tokI, 'balanceOf', [wallet]))[0]; }
}

export const isWbnbQuote = (a) => !a || String(a).toLowerCase() === WBNB || a === ethers.ZeroAddress;
