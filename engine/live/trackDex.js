// 追踪地址在「已开盘」币上的买卖（PancakeSwap V2 池子）。
// 追踪原来只认 Flap / Four / Gang 的内盘成交，币一开盘（进了 PancakeSwap）这个地址再买卖就看不到了。
// 做法：订阅这些地址「转出 / 转入」任意 ERC-20 的 Transfer 事件（按地址过滤，不按币过滤）；币是我们行情里已开盘的，
//   就取同一笔交易里该币池子的 Swap 事件，从池子的进出量得到数量和成交额，方向按池子是收到币（= 卖）还是付出币（= 买）判断。
//   只用 WebSocket 订阅（公共节点的 eth_getLogs 不允许不带合约地址的查询，所以不能轮询补扫；订阅是支持的）。断线由 WsLogs 自动重连。
//   历史回补：公共节点只保留最近约 5000 个区块的日志，所以只能补最近约 1 小时，并且要逐个已开盘的币带地址去查。
// 只读，不发交易。结果交给 tracker.onTrade，和内盘成交走同一条路（但已开盘的成交不会触发跟单）。
import { ethers } from 'ethers';
import { NODEREAL_WSS } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';

const T_XFER = ethers.id('Transfer(address,address,uint256)');
const T_SWAP = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const abi = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);
const lc = (a) => String(a || '').toLowerCase();
const addrOf = (topic) => lc('0x' + String(topic).slice(26));

export class DexTrackWatch {
  constructor({ provider, market, getTargets, onTrade, log }) {
    Object.assign(this, { provider, market, getTargets, onTrade, logFn: log || (() => {}) });
    this.status = { connected: false, wss: null, lastError: null }; this.done = new Map(); this.sub = null;
  }

  start() { this.resub(); }

  get set() { return new Set(this.getTargets().map(lc)); }
  filters() {
    const who = [...this.set].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).map(pad);
    return who.length ? [{ topics: [T_XFER, who] }, { topics: [T_XFER, null, who] }] : [];
  }

  // 追踪的地址变了（添加 / 删除）：按新的名单重新订阅
  resub() {
    this.sub?.stop(); this.sub = null;
    const filters = this.filters(); if (!filters.length) return;
    this.sub = new WsLogs({ label: '追踪-开盘币', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters, onLog: (l) => this.handle(l).catch((e) => this.logFn(`[追踪-开盘币] ${e.message}`)), status: this.status }).start();
  }

  async handle(log) {
    const token = lc(log.address), t = this.market.get(token); if (!t || t.stage !== 'dex') return;
    const set = this.set, from = addrOf(log.topics[1]), to = addrOf(log.topics[2]);
    const who = set.has(from) ? from : set.has(to) ? to : null; if (!who) return;
    const key = `${log.transactionHash}|${token}|${who}`; if (this.done.has(key)) return;
    this.done.set(key, Date.now()); if (this.done.size > 2000) for (const k of [...this.done.keys()].slice(0, 500)) this.done.delete(k);
    const tr = await this.analyze(t, who, log.transactionHash, log.blockNumber); if (tr) this.onTrade(tr);
  }

  // 一笔交易里这个币在池子的买 / 卖：没有池子的 Swap（只是普通转账）返回 null。
  // 带税的币（Gang 开盘后 1% / 1%）一笔交易里池子会有好几次 Swap（税合约顺手把攒的税换成 BNB），不能取第一个：
  //   方向和数量都以「这个地址在这笔交易里这个币的净转出 / 转入」为准，再从池子的 Swap 里挑数量最接近的那一次取成交额
  async analyze(t, who, tx, block) {
    const info = await this.market.dexFeed.pairOf(t).catch(() => null); if (!info) return null;
    const r = await this.provider.getTransactionReceipt(tx); if (!r) return null;
    let sent = 0n, got = 0n;
    for (const l of r.logs) {
      if (lc(l.address) !== lc(t.address) || l.topics[0] !== T_XFER || l.topics.length < 3) continue;
      const amt = BigInt(l.data);
      if (addrOf(l.topics[1]) === who) sent += amt; if (addrOf(l.topics[2]) === who) got += amt;
    }
    const sell = sent > got, moved = sell ? sent - got : got - sent; if (moved === 0n) return null;
    const swaps = r.logs.filter((l) => lc(l.address) === info.pair && l.topics[0] === T_SWAP).map((l) => {
      const [a0In, a1In, a0Out, a1Out] = abi.decode(['uint256', 'uint256', 'uint256', 'uint256'], l.data);
      const tIn = info.tokenIs0 ? a0In : a1In, tOut = info.tokenIs0 ? a0Out : a1Out, qIn = info.tokenIs0 ? a1In : a0In, qOut = info.tokenIs0 ? a1Out : a0Out;
      const tk = sell ? tIn : tOut, q = sell ? qOut : qIn, d = tk > moved ? tk - moved : moved - tk;
      return { tk, q, d, index: l.index };
    }).filter((x) => x.tk > 0n && x.q > 0n);
    if (!swaps.length) return null;
    const sw = swaps.reduce((m, x) => (x.d < m.d ? x : m));
    const tokens = Number(ethers.formatUnits(moved, info.tDec)), q = Number(ethers.formatUnits(sw.q, info.qDec));
    if (!(tokens > 0)) return null;
    const bnbQuote = info.quote === WBNB;
    const rate = bnbQuote ? 1 : (this.market.bnbUsd ? (this.market.quoteUsd?.(t) || 0) / this.market.bnbUsd : 0);
    const ts = await this.provider.getBlock(block).then((b) => b.timestamp * 1000).catch(() => Date.now());
    const price = q / tokens;   // 报价币/个：市值用成交时点的价，不用行情里「现在」的
    return { address: t.address, token: lc(t.address), symbol: t.symbol, platform: t.platform, ts, side: sell ? 'sell' : 'buy', tokens, bnb: q, quote: bnbQuote ? 'BNB' : t.quote, bnbDirect: q * rate,
      price, trader: who, tx, usd: q * rate * (this.market.bnbUsd || 0), mcapUsd: price * (t.maxSupply || 1e9) * rate * (this.market.bnbUsd || 0), dex: true, block, logIndex: sw.index };
  }

  // 历史（添加追踪地址时补）：逐个已开盘的币，带上币的地址查这些地址的转入 / 转出，再还原成买卖。
  // 公共节点最多给最近约 5000 个区块（约 40 分钟），所以不管 hours 填多少，窗口都不超过 4500 块
  async history(addresses, { max = 400 } = {}) {
    const who = [...new Set(addresses.map(lc))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)); if (!who.length) return [];
    const head = await this.provider.getBlockNumber(), from = head - 4500, topics = who.map(pad);
    const tokens = this.market.list().filter((t) => t.stage === 'dex').slice(0, max), txs = new Map();
    for (const t of tokens) {
      for (const f of [{ topics: [T_XFER, topics] }, { topics: [T_XFER, null, topics] }]) {
        let logs = null;
        for (let k = 0; k < 3 && !logs; k++) { try { logs = await this.provider.getLogs({ ...f, address: t.address, fromBlock: from, toBlock: head }); } catch { await new Promise((ok) => setTimeout(ok, 500 * (k + 1))); } }   // 公共节点偶尔限流，重试几次
        if (!logs) { this.logFn(`[追踪-开盘币] 读取 ${t.symbol} 的转账失败，这个币的历史没补上`); continue; }
        for (const l of logs) { const w = who.find((a) => addrOf(l.topics[1]) === a || addrOf(l.topics[2]) === a); if (w) txs.set(`${l.transactionHash}|${lc(t.address)}|${w}`, l); }
      }
    }
    const out = [];
    for (const [k, l] of txs) {
      const [, token, trader] = k.split('|'); const t = this.market.get(token);
      const tr = await this.analyze(t, trader, l.transactionHash, l.blockNumber).catch(() => null);
      if (tr) out.push(tr);
    }
    return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  }
}
