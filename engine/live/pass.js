// Piupiu Pass（contracts/PiupiuPass.sol）：Agent ID 持有者免费领取的不可转让通行证。
// 只是一枚可选的徽章：不影响任何现有功能，不领也能照常使用；领取免费，只付网络费。
// 流程和雷达铸造一致：先预检（币安钱包预演，60 秒有效）→ 用户确认 → 才提交。从不自动领取。
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import * as baw from './baw.js';
import { DRY_RUN, env } from './config.js';

/// 通行证合约（BSC 主网，BscScan 已验证）。为空 = 功能关闭（界面不显示入口）。可用环境变量 PIUPIU_PASS 覆盖。
export const PASS_CONTRACT = env('PIUPIU_PASS', '0x7Ff80cDcf465c19deCe061a509c8B5444Ddf9B77');   // 2026-11-21 部署并通过 BscScan 验证
const IFACE = new ethers.Interface([
  'function claim() returns (uint256)',
  'function passOf(address) view returns (uint256)',
  'function holdsAgentId(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
]);
const TTL = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a || '').toLowerCase();

export class Pass {
  /**
   * @param {object} o
   * @param {object} o.trader     钱包列表 / 登录状态（trader.wallets、trader.slotAuth）
   * @param {object} o.provider   读链用的节点
   * @param {object} [o.txProvider] 等待回执用的节点
   * @param {string} [o.contract]
   */
  constructor({ trader, provider, txProvider, contract = PASS_CONTRACT, log = () => {} } = {}) {
    Object.assign(this, { trader, provider, txProvider: txProvider || provider, log });
    this.contract = ethers.isAddress(contract || '') ? ethers.getAddress(contract) : '';
    this.previews = new Map();
    this.jobs = new Map();   // slot -> 最近一次领取的状态（给界面轮询）
  }
  get available() { return !!this.contract && !!this.provider; }
  read() { return new ethers.Contract(this.contract, IFACE, this.provider); }
  wallets() {
    return (this.trader?.wallets || []).map((w) => ({ slot: w.slot, label: w.label, address: lc(w.address), ok: this.trader.slotAuth?.get(w.slot)?.state === 'ok', agentName: this.trader.slotAuth?.get(w.slot)?.agentId || null }));
  }

  /** 给界面看：合约地址、总领取数、每个钱包的领取状态 */
  async view() {
    if (!this.available) return { available: false };
    const c = this.read();
    const total = await c.totalSupply().then((n) => Number(n)).catch(() => null);
    const rows = await Promise.all(this.wallets().map(async (w) => {
      const row = { slot: w.slot, label: w.label, address: w.address, loggedIn: w.ok, agentName: w.agentName, holdsAgentId: null, passId: null, claimed: null, job: this.jobs.get(w.slot) || null };
      if (!w.address) return row;
      try {
        const id = Number(await c.passOf(w.address));
        row.passId = id || null; row.claimed = id > 0;
        row.holdsAgentId = row.claimed ? true : await c.holdsAgentId(w.address);
      } catch { /* 读不到就留空，界面显示「暂时读不到」，不当成没领 */ }
      return row;
    }));
    return { available: true, contract: this.contract, total, wallets: rows };
  }

  /** 预检：钱包要已登录、持有 Agent ID、还没领；再让币安钱包预演一次。不发交易 */
  async preview({ slot }) {
    if (!this.available) throw new Error('通行证功能暂未开放');
    const w = this.wallets().find((x) => x.slot === Number(slot));
    if (!w) throw new Error('找不到这个钱包');
    if (!w.ok) throw new Error(`W${w.slot} 未登录，请先扫码登录`);
    const c = this.read();
    if (Number(await c.passOf(w.address)) > 0) throw new Error('这个钱包已经领过通行证了');
    if (!(await c.holdsAgentId(w.address))) throw new Error('这个钱包没有 Agent ID，无法领取通行证');
    const data = IFACE.encodeFunctionData('claim', []);
    let pv;
    try { pv = await baw.withSlot(w.slot, () => baw.contractPreview({ from: w.address, to: this.contract, valueWei: '0', inputData: data, slot: w.slot })); }
    catch (e) { throw new Error(`币安钱包预演失败：${String(e.message).slice(0, 160)}（请确认已在币安 App 里开启开发者模式）`); }
    const id = 'p' + randomBytes(5).toString('hex');
    const out = { id, slot: w.slot, address: w.address, label: w.label, to: this.contract, risks: pv.riskTitles || [], needAppConfirm: !!pv.requireConfirmation, simulation: pv.simulation || null, at: Date.now() };
    this.previews.set(id, { ...out, data });
    return out;
  }

  /** 确认提交：一次预检只能提交一次；真正的签名在币安钱包里完成。立即返回，结果靠 view() 里的 job 轮询 */
  async submit({ previewId }) {
    const p = this.previews.get(previewId);
    if (!p) throw new Error('预检已失效，请重新检查');
    if (Date.now() - p.at > TTL) { this.previews.delete(previewId); throw new Error('预检已超过 60 秒，请重新检查（链上状态可能已变化）'); }
    if (DRY_RUN) throw new Error('演示模式不会真实领取（需开启实盘交易）');
    this.previews.delete(previewId);
    const job = { status: 'sending', at: Date.now(), tx: null, reason: null };
    this.jobs.set(p.slot, job);
    this.send(p, job).catch((e) => this.log(`[通行证] ${e.message}`));
    return { slot: p.slot, ...job };
  }

  async send(p, job) {
    try {
      const r = await baw.withSlot(p.slot, () => baw.contractCall({ from: p.address, to: this.contract, valueWei: '0', inputData: p.data, slot: p.slot }));
      if (r.status === 'PENDING_CONFIRMATION') return Object.assign(job, { status: 'app-confirm', reason: '需在币安 App 中确认（确认前该钱包无法提交其他交易）' });
      if (!r.txHash) return Object.assign(job, { status: 'failed', reason: `币安钱包未返回交易哈希（${r.status || '未知'}）` });
      Object.assign(job, { status: 'broadcast', tx: r.txHash });
      let rc = null;
      for (const end = Date.now() + 180_000; Date.now() < end; await sleep(500)) { rc = await this.txProvider.getTransactionReceipt(r.txHash).catch(() => null); if (rc) break; }
      if (!rc) return Object.assign(job, { status: 'unconfirmed', reason: '已广播，3 分钟内未确认；不会重复发送，请稍后在 BscScan 查询' });
      if (rc.status !== 1) return Object.assign(job, { status: 'failed', reason: '链上执行失败（交易被回滚）' });
      const id = Number(await this.read().passOf(p.address).catch(() => 0));
      return Object.assign(job, { status: 'done', passId: id || null });
    } catch (e) {
      const unknown = e.code === 'UNKNOWN_SUBMIT';
      return Object.assign(job, { status: unknown ? 'unknown' : 'failed', reason: unknown ? '已提交，但未获取到结果（可能已上链）；不会重复发送，请在 BscScan 查询' : String(e.message).slice(0, 200) });
    }
  }
}
