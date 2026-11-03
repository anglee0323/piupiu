// 交易手续费（2026-11-02 起，官方安装版）：成交后按 0.5% 收取，付到 PiupiuFee 收款合约（contracts/PiupiuFee.sol，收到即全额转给 treasury）。
// 规则：狙击 / 跟单 / 条件单 / 手动买卖都收；失败的不收；手续费不足 FEE_MIN 的不收（小额卖出 / 小额买入）；雷达铸造不经过这里，免费。
//  - 买入：下单前从金额里扣出手续费（和币安钱包的做法一样：买 0.1 BNB = 0.0995 去买 + 0.0005 手续费），成交后记一笔应付。
//  - 卖出：成交后按实际换回的 BNB 记一笔应付；没换回 BNB（留在报价币里）时不收。
// 应付不在成交当下付：钱包空闲 PAY_IDLE_MS 后把这个钱包所有未付的合并成一笔 pay(ref) 付掉，不和狙击 / 连续下单抢钱包。
// 账本 data/fees.jsonl 只追加：due（应付）/ paid（已付，带交易哈希和包含的订单）/ fail（付款失败）。重启后从账本恢复未付。
// 收款合约不能直接用转账（baw wallet send 要求收款地址在用户地址簿里），所以走 contract-call。
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';

export const FEE_BPS = 50n;                                   // 0.5%
export const FEE_RATE = Number(FEE_BPS) / 10000;
// 收款合约（部署后填入）。为空 = 不收费（开源版、未部署前）
export const FEE_CONTRACT = '';   // 开源版不收手续费
export const FEE_TREASURY = '0xAD11aE703dFfDED3ad7caE72871BDCD44EF58CA2';
export const FEE_MIN_WEI = 20_000_000_000_000n;              // 0.00002 BNB：手续费不足这个数就不收（≈ 卖出 0.004 BNB 以下）
const PAY_IDLE_MS = 20_000;                                   // 钱包空闲这么久才付
const GAS_RESERVE_WEI = 300_000_000_000_000n;                 // 付款后至少给钱包留 0.0003 BNB 网络费
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000];           // 付款失败后的重试间隔（之后每 30 分钟）
const CONFIRM_RETRY_MS = 6 * 3600_000;                        // 预检要求在 App 里确认：6 小时后再试（不反复打扰）
const IFACE = new ethers.Interface(['function pay(bytes32 ref) payable']);

const toWei = (bnb) => { try { return ethers.parseEther(Number(bnb).toFixed(18)); } catch { return 0n; } };
/** 某个 BNB 金额对应的手续费（wei）；不足 FEE_MIN_WEI 返回 0n（不收） */
export function feeFor(bnb) {
  const w = toWei(bnb); if (w <= 0n) return 0n;
  const f = (w * FEE_BPS) / 10000n;
  return f >= FEE_MIN_WEI ? f : 0n;
}
export const feeBnb = (wei) => Number(ethers.formatEther(wei));

export class Fees {
  /**
   * @param {object} o
   * @param {boolean} o.enabled  是否真的收（实盘 + 允许真实下单 + 已配置收款合约）
   * @param {(x:{slot:number,address:string,to:string,valueWei:string,inputData:string}) => Promise<string>} o.send  发出付款交易，返回交易哈希
   * @param {(slot:number) => boolean} o.busy  钱包是否正在下单
   * @param {(slot:number) => {address?:string, bnb?:number}|null} o.wallet  当前钱包（地址、BNB 余额）
   */
  constructor({ enabled, send, busy = () => false, wallet = () => null, file = dataFile('fees.jsonl'), contract = FEE_CONTRACT, log = () => {}, onNotice = () => {} } = {}) {
    this.enabled = !!(enabled && contract); this.contract = contract; this.send = send; this.busy = busy; this.wallet = wallet;
    this.file = file; this.log = log; this.onNotice = onNotice;
    this.rows = []; this.timers = new Map(); this.fails = new Map(); this.paying = new Set();
    try { if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { this.rows.push(JSON.parse(l)); } catch { /* 坏行跳过 */ } } } catch { /* 读不了就从空开始 */ }
    if (this.enabled) for (const slot of new Set(this.owedRows().map((r) => r.slot))) this.schedule(slot, 5_000);
  }
  append(row) { this.rows.push(row); try { appendFileSync(this.file, JSON.stringify(row) + '\n'); } catch (e) { this.log(`手续费账本写不进去：${e.message}`); } }
  paidIds() { const s = new Set(); for (const r of this.rows) if (r.t === 'paid') for (const id of r.ids || []) s.add(id); return s; }
  owedRows(slot = null) { const paid = this.paidIds(); return this.rows.filter((r) => r.t === 'due' && !paid.has(r.id) && (slot == null || r.slot === slot)); }

  /** 买入下单前：应扣多少（wei）。不收费时 0n */
  buyFee(amountBnb) { return this.enabled ? feeFor(amountBnb) : 0n; }
  /** 成交后记一笔应付（订单编号去重）；返回记下的手续费（wei） */
  accrue({ id, slot, address, side, symbol, baseBnb, feeWei }) {
    if (!this.enabled || !id || feeWei == null || feeWei <= 0n) return 0n;
    if (this.rows.some((r) => r.t === 'due' && r.id === id)) return 0n;
    this.append({ t: 'due', at: Date.now(), id, slot, address, side, symbol, base: Number(baseBnb), fee: feeWei.toString() });
    this.schedule(slot);
    return feeWei;
  }
  schedule(slot, ms = PAY_IDLE_MS) {
    clearTimeout(this.timers.get(slot));
    const t = setTimeout(() => { this.timers.delete(slot); this.pay(slot).catch((e) => this.log(`手续费付款出错：${e.message}`)); }, ms);
    t.unref?.(); this.timers.set(slot, t);
  }
  async pay(slot) {
    if (!this.enabled || this.paying.has(slot)) return null;
    if (this.busy(slot)) { this.schedule(slot); return null; }
    const due = this.owedRows(slot); if (!due.length) return null;
    const total = due.reduce((s, r) => s + BigInt(r.fee), 0n);
    const w = this.wallet(slot);
    if (!w?.address) { this.schedule(slot, RETRY_MS[1]); return null; }
    if (w.bnb != null && toWei(w.bnb) < total + GAS_RESERVE_WEI) { this.schedule(slot, RETRY_MS[2]); return null; }   // 余额不够：等以后有钱了再付，不打扰交易
    this.paying.add(slot);
    const ids = due.map((r) => r.id);
    try {
      const ref = ethers.id(ids.join(','));
      const tx = await this.send({ slot, address: w.address, to: this.contract, valueWei: total.toString(), inputData: IFACE.encodeFunctionData('pay', [ref]) });
      this.append({ t: 'paid', at: Date.now(), slot, address: w.address, ids, fee: total.toString(), tx });
      this.fails.delete(slot);
      return tx;
    } catch (e) {
      const n = (this.fails.get(slot) || 0) + 1; this.fails.set(slot, n);
      this.append({ t: 'fail', at: Date.now(), slot, ids, fee: total.toString(), err: String(e.message || e).slice(0, 300) });
      // 需要在币安 App 里确认的（风控判定）：不发、不反复试，6 小时后再看；其他错误按间隔重试
      if (e.code === 'APP_CONFIRM' || e.code === 'NEEDS_CONFIRM') { this.onNotice({ slot, kind: 'confirm', message: e.message }); this.schedule(slot, CONFIRM_RETRY_MS); }
      else this.schedule(slot, RETRY_MS[Math.min(n - 1, RETRY_MS.length - 1)]);
      return null;
    } finally { this.paying.delete(slot); }
  }
  /** 给界面看：费率、累计已付、未付、最近记录 */
  summary(limit = 30) {
    const paid = this.rows.filter((r) => r.t === 'paid');
    const owed = this.owedRows();
    const paidIds = this.paidIds();
    const recent = this.rows.filter((r) => r.t === 'due').slice(-limit).reverse()
      .map((r) => ({ at: r.at, id: r.id, slot: r.slot, side: r.side, symbol: r.symbol, base: r.base, fee: feeBnb(BigInt(r.fee)), paid: paidIds.has(r.id) }));
    return {
      enabled: this.enabled, rate: FEE_RATE, contract: this.contract || null, treasury: FEE_TREASURY, minBnb: feeBnb(FEE_MIN_WEI),
      paidBnb: feeBnb(paid.reduce((s, r) => s + BigInt(r.fee), 0n)), owedBnb: feeBnb(owed.reduce((s, r) => s + BigInt(r.fee), 0n)),
      payments: paid.slice(-10).reverse().map((r) => ({ at: r.at, slot: r.slot, fee: feeBnb(BigInt(r.fee)), n: r.ids.length, tx: r.tx })),
      recent,
    };
  }
}
