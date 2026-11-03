// 一键参与（方案 R4）：预检 → 你确认 → 币安钱包签名发送 → 上链后核对到账。边界（照方案 §7）：
//  - 只照抄「已验证可照抄」的配方（recipe.supported），参数里的地址换成你的钱包；
//  - 每个钱包都先用自己的地址 eth_call 模拟 + baw 预演，模拟不过的不提交；
//  - 单次金额超过雷达设置里的上限（默认 0.02 BNB）不提交；
//  - 预检 60 秒内有效，过期要重新检查；提交只发预检里通过、并且你勾选了的那几笔；
//  - 结果不确定（超时 / 断网）的只记录不重发；不做授权、不转账、不扩大权限。
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { dataFile, DRY_RUN } from '../config.js';
import * as baw from '../baw.js';
import { build, valueCandidates, simulate } from './recipe.js';
import { revertText } from './sigs.js';
import { flows } from './classify.js';
import { AGENT_ID } from './known.js';
import { readMintHistory, summarize, nftCount } from './mintHistory.js';

const TTL = 60_000;
const LOG = dataFile('radar/mints.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aidIface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

// 币安风控目前会拦截「通过开发者模式从 Agentic 钱包转出 NFT」（351803，任何收款地址、任何转出写法都一样；同地址付 BNB 能通过）。
// 原始报错是英文的「风险太高」，用户看了以为是收款地址有问题，这里换成说清原因的提示
export const NFT_BLOCKED_MSG = '币安钱包风控拒绝了本次转出：目前不支持通过开发者模式将 NFT 从 Agentic 钱包转出，与收款地址无关。NFT 仍在你的钱包中，未发生任何交易。';
export const nftRiskBlocked = (e) => e?.baw?.error?.code === 351803 || /351803|risk is too high/i.test(String(e?.message || ''));

export class Participate {
  constructor({ trader, provider, txProvider, getAnalysis, settings, emit = () => {}, log = () => {} }) {
    Object.assign(this, { trader, provider, txProvider: txProvider || provider, getAnalysis, settings, emit, log });
    this.previews = new Map();
    // 重启恢复：日志里每次状态变化一行，按 id 取最后一次。历史不能因为候选冷却 / 被隐藏 / 列表截断而消失
    this.byId = new Map(); this.byAddr = new Map();
    for (const r of readMintHistory(LOG)) this.index(r);
    if (this.byId.size) this.log(`[雷达] 恢复铸造历史 ${this.byId.size} 条（${summarize([...this.byId.values()]).size} 个项目）`);
  }
  index(r) {
    this.byId.set(r.id, r);
    const l = this.byAddr.get(r.address) || [];
    const i = l.findIndex((x) => x.id === r.id);
    if (i < 0) l.push(r); else l[i] = r;
    this.byAddr.set(r.address, l);
  }
  get records() { return [...this.byId.values()].sort((a, b) => b.ts - a.ts); }

  wallets(slots) {
    const ws = (this.trader?.wallets || []).filter((w) => !slots?.length || slots.includes(w.slot));
    return ws.map((w) => ({ slot: w.slot, address: String(w.address || '').toLowerCase(), label: w.label, ok: this.trader.slotAuth?.get(w.slot)?.state === 'ok' }));
  }

  async preview({ address, slots, qty = 1 }) {
    const an = this.getAnalysis(address);
    if (!an) throw new Error('分析尚未完成，请稍后重试');
    const recipe = an.recipe;
    if (!recipe?.supported) throw new Error(`暂不支持一键参与：${recipe?.why || '尚未找到可参照的调用方式'}`);
    const q = recipe.qtyWord != null ? Math.max(1, Math.min(100, Math.floor(Number(qty) || 1))) : 1;
    if (!this.wallets(slots).length) throw new Error('所选钱包尚未连接，请先扫码登录');   // 以前会返回空结果，页面只显示一个点不了的「确认铸造」
    const cap = ethers.parseEther(String(this.settings().maxValueBnb ?? 0.02));
    const rows = [];
    for (const w of this.wallets(slots)) {
      const row = { slot: w.slot, label: w.label, address: w.address, ok: false };
      rows.push(row);
      if (!w.ok) { row.reason = `W${w.slot} 未登录`; continue; }
      try { const r = await this.provider.call({ to: AGENT_ID, data: aidIface.encodeFunctionData('balanceOf', [w.address]) }); row.hasAgentId = BigInt(r) > 0n; } catch { row.hasAgentId = null; }
      const data = build(recipe, w.address, q);
      let last = null;
      for (const v of valueCandidates(recipe, q)) {
        const r = await simulate(this.provider, { from: w.address, to: address, data, value: v });
        if (r.ok) { Object.assign(row, { sim: true, valueWei: String(v), gas: r.gas, data }); break; }
        last = r.funds ? '余额不够' : r.data ? await revertText(r.data) : r.reason;
      }
      if (!row.sim) { row.reason = (row.hasAgentId === false ? '该钱包没有 Agent ID；' : '') + `模拟未通过：${last || '合约拒绝'}`; continue; }
      if (BigInt(row.valueWei) > cap) { row.reason = `需支付 ${ethers.formatEther(row.valueWei)} BNB，超过雷达设置中的单次上限 ${ethers.formatEther(cap)} BNB`; continue; }
      // baw 预演：币安钱包自己的模拟 + 风控提示（需要钱包开了开发者模式）
      try {
        const p = await baw.withSlot(w.slot, () => baw.contractPreview({ from: w.address, to: address, valueWei: row.valueWei, inputData: data, slot: w.slot }));
        Object.assign(row, { bawSim: p.simulation ?? null, risks: p.riskTitles || [], needAppConfirm: !!p.requireConfirmation });
        if (p.simulation != null && !/^0+$/.test(String(p.simulation))) { row.reason = `币安钱包预演未通过（代码 ${p.simulation}）`; continue; }   // 000000000 = 模拟成功
        row.ok = true;
      } catch (e) { row.reason = `币安钱包预演失败：${String(e.message).slice(0, 120)}`; }
    }
    const id = 'p' + randomBytes(5).toString('hex');
    this.previews.set(id, { id, address: String(address).toLowerCase(), qty: q, at: Date.now(), rows, fn: an.fn, symbol: an.symbol || an.name || null });
    for (const [k, v] of this.previews) if (Date.now() - v.at > 5 * TTL) this.previews.delete(k);
    return { previewId: id, expiresAt: Date.now() + TTL, qty: q, fn: an.fn, rows: rows.map(({ data, ...r }) => r) };
  }

  /** 只提交预检通过、且用户勾选了的钱包 */
  /** 今天已经「一键直铸」提交的笔数（含失败的：提交了就算） */
  quickToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return [...this.byId.values()].filter((r) => r.quick && r.ts >= d.getTime()).length;
  }

  /** quick = 页面跳过了确认框（一键直铸）。服务端自己再核一遍：开关开着、全部免费、预检没有风险提示、没超过每天上限；
   *  不满足就拒绝（预检不作废，页面退回普通确认流程） */
  /** 今天自动铸造提交的笔数 */
  autoToday() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return [...this.byId.values()].filter((r) => r.auto && r.ts >= d.getTime()).length;
  }

  /** auto = 雷达自动铸造（不经页面）。和一键直铸同样的服务端核对，另加：自动铸造开关、自己的每日上限、需要币安 App 确认的不提交（会锁住钱包） */
  async submit({ previewId, slots, quick = false, auto = false }) {
    const p = this.previews.get(previewId);
    if (!p) throw new Error('预检已失效，请重新检查');
    if (Date.now() - p.at > TTL) { this.previews.delete(previewId); throw new Error('预检已超过 60 秒，请重新检查（链上状态可能已变化）'); }
    const pick = p.rows.filter((r) => r.ok && (!slots?.length || slots.includes(r.slot)));
    if (!pick.length) throw new Error('没有可提交的钱包');
    if (auto) {
      const st = this.settings();
      if (!st.autoMint) throw new Error('未开启自动铸造');
      if (pick.some((r) => String(r.valueWei) !== '0')) throw new Error('自动铸造仅适用于免费铸造');
      if (pick.some((r) => (r.risks || []).length)) throw new Error(`币安钱包给了风险提示（${pick.find((r) => (r.risks || []).length).risks.join('；')}），不自动提交`);
      if (pick.some((r) => r.needAppConfirm)) throw new Error('需要在币安 App 中确认，不自动提交');
      const max = Number(st.autoMintMax ?? 10), used = this.autoToday();
      if (used + pick.length > max) throw new Error(`今日自动铸造已达 ${used} 次（上限 ${max} 次）`);
    }
    if (quick) {
      const st = this.settings();
      if (!st.quickMint) throw new Error('未开启一键直铸');
      if (pick.some((r) => String(r.valueWei) !== '0')) throw new Error('一键直铸仅适用于免费铸造，该项目需要付费，请通过常规方式确认');
      if (pick.some((r) => (r.risks || []).length)) throw new Error(`币安钱包给了风险提示（${pick.find((r) => (r.risks || []).length).risks.join('；')}），请通过常规方式确认`);
      const max = Number(st.quickMintMax ?? 30), used = this.quickToday();
      if (used + pick.length > max) throw new Error(`今日一键直铸已使用 ${used} 次，上限 ${max} 次；请通过常规方式确认`);
    }
    if (DRY_RUN) throw new Error('演示模式不会真实参与（需开启实盘交易）');   // 校验都过了才判断：先报真实原因，演示模式只是最后一道闸
    this.previews.delete(previewId);   // 一次预检只能提交一次，防止重复点
    const recs = pick.map((r) => ({ id: 'm' + randomBytes(5).toString('hex'), ts: Date.now(), address: p.address, symbol: p.symbol, fn: p.fn, slot: r.slot, from: r.address, valueWei: r.valueWei, qty: p.qty, status: 'sending', steps: [], ...(quick ? { quick: true } : {}), ...(auto ? { auto: true } : {}) }));
    for (const rec of recs) this.update(rec);
    // 各钱包并行（同一个钱包的 baw 调用本来就按钱包串行）
    Promise.all(recs.map((rec, i) => this.send(rec, pick[i]))).catch(() => {});
    return recs;
  }

  async send(rec, row) {
    try {
      const r = await baw.withSlot(rec.slot, () => baw.contractCall({ from: rec.from, to: rec.address, valueWei: rec.valueWei, inputData: row.data, slot: rec.slot }));
      if (r.status === 'PENDING_CONFIRMATION') { Object.assign(rec, { status: 'app-confirm', reason: '需在币安 App 中确认（确认前该钱包无法提交其他交易）' }); return this.update(rec); }
      if (!r.txHash) { Object.assign(rec, { status: 'failed', reason: `币安钱包未返回交易哈希（${r.status || '未知'}）` }); return this.update(rec); }
      Object.assign(rec, { status: 'broadcast', tx: r.txHash }); this.update(rec);
      let rc = null;
      for (const end = Date.now() + 180_000; Date.now() < end; await sleep(400)) { rc = await this.txProvider.getTransactionReceipt(r.txHash).catch(() => null); if (rc) break; }
      if (!rc) { Object.assign(rec, { status: 'unconfirmed', reason: '已广播，3 分钟内未确认；不会重复发送，请稍后在 BscScan 查询' }); return this.update(rec); }
      if (rc.status !== 1) { Object.assign(rec, { status: 'failed', reason: '链上执行失败（交易被回滚）' }); return this.update(rec); }
      // 到账核验：回执里有没有转给这个钱包的 NFT / 代币
      const f = flows(rc, rec.from);
      rec.got = f.got.map((x) => ({ token: x.token, std: x.std, amount: String(x.amount), id: x.id != null ? String(x.id) : undefined }));
      Object.assign(rec, { status: rec.got.length ? 'done' : 'done-nothing', reason: rec.got.length ? null : '交易成功，但回执中未发现转入你钱包的 NFT / 代币（可能为签到或注册类操作，或奖励稍后发放）' });
      return this.update(rec);
    } catch (e) {
      const unknown = e.code === 'UNKNOWN_SUBMIT';
      Object.assign(rec, { status: unknown ? 'unknown' : 'failed', reason: unknown ? '已提交，但未获取到结果（可能已上链）；不会重复发送，请在 BscScan 查询' : String(e.message).slice(0, 200) });
      return this.update(rec);
    }
  }

  update(rec) {
    rec.updatedAt = Date.now();
    this.index(rec);
    try { mkdirSync(new URL('.', LOG), { recursive: true }); appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
    this.emit(rec);
    if (/done|failed|unknown|unconfirmed|app-confirm|transferred/.test(rec.status)) this.log(`[雷达] 参与 ${rec.symbol || rec.address} W${rec.slot}：${rec.status}${rec.tx ? ' ' + rec.tx : ''}${rec.reason ? ' ' + rec.reason : ''}`);
    return rec;
  }
  forAddress(a) { return (this.byAddr.get(String(a).toLowerCase()) || []).slice().sort((x, y) => y.ts - x.ts); }
  /** 某个合约的汇总：成功铸造笔数、NFT 个数、转出、失败、最近时间（不是「记录条数」） */
  summary(a) {
    const list = this.forAddress(a);
    const m = summarize(list).get(String(a).toLowerCase()) || { address: String(a).toLowerCase(), symbol: null, mintTx: 0, nft: 0, transfers: 0, failed: 0, lastAt: 0 };
    return { ...m, records: list.length };
  }
  /** 所有历史（倒序，可分页）；缺失候选的项目也能从这里展示 */
  history({ limit = 200, offset = 0, address = null } = {}) {
    const all = address ? this.forAddress(address) : this.records;
    return { total: all.length, items: all.slice(offset, offset + limit).map((r) => ({ ...r, nft: nftCount(r) })) };
  }
  /** 启动时核对「已广播但没等到结果」的原交易：只按原哈希查，不重新构造、不重发 */
  async reconcile() {
    const pending = [...this.byId.values()].filter((r) => ['broadcast', 'unconfirmed', 'unknown'].includes(r.status) && r.tx && Date.now() - r.ts < 7 * 24 * 3600_000);
    if (!pending.length) return 0;
    let n = 0;
    for (const rec of pending.slice(0, 20)) {
      const rc = await this.txProvider.getTransactionReceipt(rec.tx).catch(() => null);
      if (!rc) continue;   // 还查不到：保持原状态，下次启动再核对
      if (rc.status !== 1) { Object.assign(rec, { status: 'failed', reason: '链上执行失败（重启后核对）' }); this.update(rec); n++; continue; }
      if (rec.kind === 'transfer') { Object.assign(rec, { status: 'transferred', reason: null }); this.update(rec); n++; continue; }
      const f = flows(rc, rec.from);
      rec.got = f.got.map((x) => ({ token: x.token, std: x.std, amount: String(x.amount), id: x.id != null ? String(x.id) : undefined }));
      Object.assign(rec, { status: rec.got.length ? 'done' : 'done-nothing', reason: rec.got.length ? null : '交易成功，但回执中未发现转入你钱包的 NFT / 代币（重启后核对）' });
      this.update(rec); n++;
    }
    if (n) this.log(`[雷达] 重启核对：${n} 笔已广播的记录补上了最终状态（没有重发任何交易）`);
    return n;
  }

  // ---------- 铸完之后：我的持有 + 转到常用钱包 ----------
  // Agentic 钱包没有浏览器插件 / WalletConnect，连不上 Element 这类网页市场；要挂单卖，先把 NFT 转到 MetaMask 等普通钱包。

  /** 每个已登录钱包在这个合约里持有多少、编号是哪些（能枚举就枚举，不能就用铸造记录里的编号再核对 ownerOf） */
  async holdings(address, an) {
    const a = String(address).toLowerCase();
    const std = an?.profile?.erc1155 ? '1155' : an?.profile?.erc721 || an?.cls?.kind === 'nft-mint' ? '721' : an?.profile?.erc20 ? '20' : '721';
    const I = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function tokensOfOwner(address) view returns (uint256[])', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function decimals() view returns (uint8)', 'function balanceOf(address,uint256) view returns (uint256)']);
    const call = async (fn, args) => { try { return I.decodeFunctionResult(fn, await this.provider.call({ to: a, data: I.encodeFunctionData(fn, args) })); } catch { return null; } };
    const rows = [];
    for (const w of this.wallets()) {
      if (!w.address) continue;
      const row = { slot: w.slot, address: w.address, label: w.label, std, balance: null, ids: [] };
      if (std === '1155') {
        const ids = [...new Set(this.forAddress(a).filter((r) => r.slot === w.slot).flatMap((r) => (r.got || []).map((g) => g.id)).filter(Boolean))];
        for (const id of ids.slice(0, 20)) { const b = await call('balanceOf(address,uint256)', [w.address, id]); if (b && b[0] > 0n) row.ids.push({ id: String(id), amount: String(b[0]) }); }
        row.balance = row.ids.reduce((s, x) => s + Number(x.amount), 0);
      } else {
        const b = await call('balanceOf(address)', [w.address]); row.balance = b ? (std === '20' ? null : Number(b[0])) : null;
        if (std === '20' && b) { const d = await call('decimals', []); row.amount = ethers.formatUnits(b[0], d ? Number(d[0]) : 18); }
        if (std === '721' && row.balance > 0) {
          const t = await call('tokensOfOwner', [w.address]);
          if (t) row.ids = t[0].slice(0, 50).map((x) => ({ id: String(x) }));
          else {
            for (let i = 0; i < Math.min(row.balance, 20); i++) { const x = await call('tokenOfOwnerByIndex', [w.address, i]); if (!x) break; row.ids.push({ id: String(x[0]) }); }
            if (!row.ids.length) {   // 不支持枚举：用铸造记录里的编号再核对
              const ids = [...new Set(this.forAddress(a).filter((r) => r.slot === w.slot).flatMap((r) => (r.got || []).filter((g) => g.token === a).map((g) => g.id)).filter(Boolean))];
              for (const id of ids.slice(0, 20)) { const o = await call('ownerOf', [id]); if (o && String(o[0]).toLowerCase() === w.address) row.ids.push({ id: String(id) }); }
            }
          }
        }
      }
      rows.push(row);
    }
    return { std, rows, sendTo: this.trader?.settings?.nftSendTo || this.trader?.settings?.sendTo || null };
  }

  /** 转出预检：只支持 NFT（ERC721 / 1155）；收款地址默认是设置里确认过的转出地址 */
  async transferPreview({ address, slot, tokenId, to, amount = 1 }) {
    const a = String(address).toLowerCase();
    const w = this.wallets([Number(slot)])[0];
    if (!w?.ok) throw new Error(`W${slot} 未登录`);
    to = to || this.trader?.settings?.nftSendTo;   // 不传就用设置里保存的 NFT 转出地址
    if (!to) throw new Error('尚未设置 NFT 转出地址');
    if (!ethers.isAddress(to) || /^0x0{40}$/i.test(to)) throw new Error('收款地址无效');
    const dest = ethers.getAddress(to);
    if (dest.toLowerCase() === w.address) throw new Error('收款地址与当前钱包相同');
    const an = this.getAnalysis(a);
    const is1155 = !!an?.profile?.erc1155;
    const id = BigInt(String(tokenId));
    const data = is1155
      ? new ethers.Interface(['function safeTransferFrom(address,address,uint256,uint256,bytes)']).encodeFunctionData('safeTransferFrom', [w.address, dest, id, BigInt(Math.max(1, Math.floor(amount))), '0x'])
      : new ethers.Interface(['function safeTransferFrom(address,address,uint256)']).encodeFunctionData('safeTransferFrom', [w.address, dest, id]);
    const sim = await simulate(this.provider, { from: w.address, to: a, data, value: 0n });
    if (!sim.ok) throw new Error(`模拟未通过：${sim.data ? await revertText(sim.data) : sim.reason}（收款地址为合约时可能无法接收 NFT）`);
    const destCode = await this.provider.getCode(dest).catch(() => '0x');
    let p;
    try { p = await baw.withSlot(w.slot, () => baw.contractPreview({ from: w.address, to: a, valueWei: '0', inputData: data, slot: w.slot })); }
    catch (e) { throw nftRiskBlocked(e) ? new Error(NFT_BLOCKED_MSG) : e; }
    if (p.simulation != null && !/^0+$/.test(String(p.simulation))) throw new Error(`币安钱包预演未通过（代码 ${p.simulation}）`);
    const id2 = 't' + randomBytes(5).toString('hex');
    this.previews.set(id2, { id: id2, kind: 'transfer', address: a, slot: w.slot, from: w.address, to: dest, tokenId: String(id), data, at: Date.now(), symbol: an?.symbol || an?.name || null });
    return { previewId: id2, expiresAt: Date.now() + TTL, from: w.address, to: dest, tokenId: String(id), toIsContract: destCode && destCode !== '0x', risks: p.riskTitles || [], needAppConfirm: !!p.requireConfirmation, isSendTo: [this.trader?.settings?.nftSendTo, this.trader?.settings?.sendTo].some((x) => x && String(x).toLowerCase() === dest.toLowerCase()) };
  }

  async transferSubmit({ previewId }) {
    const p = this.previews.get(previewId);
    if (!p || p.kind !== 'transfer') throw new Error('预检已失效，请重新检查');
    if (Date.now() - p.at > TTL) { this.previews.delete(previewId); throw new Error('预检超过 60 秒已过期，请重新检查'); }
    if (DRY_RUN) throw new Error('演示模式不会真实转账（需开启实盘交易）');
    this.previews.delete(previewId);
    const rec = { id: 'x' + randomBytes(5).toString('hex'), kind: 'transfer', ts: Date.now(), address: p.address, symbol: p.symbol, slot: p.slot, from: p.from, to: p.to, tokenId: p.tokenId, valueWei: '0', qty: 1, status: 'sending' };
    this.update(rec);
    (async () => {
      try {
        const r = await baw.withSlot(p.slot, () => baw.contractCall({ from: p.from, to: p.address, valueWei: '0', inputData: p.data, slot: p.slot }));
        if (r.status === 'PENDING_CONFIRMATION') { Object.assign(rec, { status: 'app-confirm', reason: '需在币安 App 中确认' }); return this.update(rec); }
        if (!r.txHash) { Object.assign(rec, { status: 'failed', reason: `未返回交易哈希（${r.status || '未知'}）` }); return this.update(rec); }
        Object.assign(rec, { status: 'broadcast', tx: r.txHash }); this.update(rec);
        let rc = null; for (const end = Date.now() + 180_000; Date.now() < end; await sleep(400)) { rc = await this.txProvider.getTransactionReceipt(r.txHash).catch(() => null); if (rc) break; }
        Object.assign(rec, rc ? (rc.status === 1 ? { status: 'transferred', reason: null } : { status: 'failed', reason: '链上执行失败' }) : { status: 'unconfirmed', reason: '已广播，3 分钟内未确认；不会重复发送' });
        this.update(rec);
      } catch (e) { Object.assign(rec, { status: e.code === 'UNKNOWN_SUBMIT' ? 'unknown' : 'failed', reason: String(e.message).slice(0, 200) }); this.update(rec); }
    })();
    return rec;
  }
}
