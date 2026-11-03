// 雷达分析用的链上读取：运行代码、代理解析、代码里的函数选择器、常见 getter、交易回执。
// 全部只读（eth_call / getCode / getStorage / getTransactionReceipt），走雷达自己的公共节点连接。
import { ethers } from 'ethers';
import { AGENT_ID } from './known.js';

const lc = (a) => String(a || '').toLowerCase();
export const ZERO = '0x0000000000000000000000000000000000000000';
export const T_TRANSFER = ethers.id('Transfer(address,address,uint256)');
export const T_1155_SINGLE = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
export const T_1155_BATCH = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';   // EIP-1967
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** EIP-1167 最小代理（克隆）：运行代码里直接写着实现合约地址 */
export function cloneImpl(code) {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(String(code || ''));
  return m ? '0x' + m[1].toLowerCase() : null;
}

/** 按操作码扫运行代码里的 PUSH4（函数分发表里的选择器都在这）。跳过 PUSH 的数据字节，误报比逐字节扫少得多 */
export function codeSelectors(code) {
  const hex = String(code || '').replace(/^0x/, '');
  const out = new Set();
  for (let i = 0; i < hex.length;) {
    const op = parseInt(hex.substr(i, 2), 16);
    if (op === 0x63 && i + 10 <= hex.length) out.add('0x' + hex.substr(i + 2, 8).toLowerCase());
    i += 2 + (op >= 0x60 && op <= 0x7f ? (op - 0x5f) * 2 : 0);
  }
  return out;
}

/** 选择器集合的指纹：同一套代码部署多次（构造参数 / immutable 不同，字节码哈希也不同）也能归成一个系列 */
export function selectorFingerprint(sels) {
  return ethers.id([...sels].sort().join(',')).slice(0, 18);
}

export const sel = (sig) => ethers.id(sig).slice(0, 10);

// 常见 getter（读到就用，读不到就算没有）
const G = {
  name: ['function name() view returns (string)'],
  symbol: ['function symbol() view returns (string)'],
  decimals: ['function decimals() view returns (uint8)'],
  totalSupply: ['function totalSupply() view returns (uint256)'],
  owner: ['function owner() view returns (address)'],
  paused: ['function paused() view returns (bool)'],
  maxSupply: ['function maxSupply() view returns (uint256)', 'function MAX_SUPPLY() view returns (uint256)', 'function maxTokens() view returns (uint256)', 'function cap() view returns (uint256)', 'function collectionSize() view returns (uint256)'],
  price: ['function mintPrice() view returns (uint256)', 'function price() view returns (uint256)', 'function PRICE() view returns (uint256)', 'function cost() view returns (uint256)', 'function MINT_PRICE() view returns (uint256)'],
  perWallet: ['function maxPerWallet() view returns (uint256)', 'function MAX_PER_WALLET() view returns (uint256)', 'function maxMintPerWallet() view returns (uint256)', 'function walletLimit() view returns (uint256)', 'function maxPerAddress() view returns (uint256)', 'function maxMintsPerWallet() view returns (uint256)'],
  gate: ['function nftContract() view returns (address)', 'function agentIdRegistry() view returns (address)', 'function agentNft() view returns (address)', 'function identity() view returns (address)', 'function nftGate() view returns (address)', 'function agentId() view returns (address)', 'function agentID() view returns (address)', 'function agentIdNft() view returns (address)'],
};
const walletG = {
  minted: ['function numberMinted(address) view returns (uint256)', 'function mintedCount(address) view returns (uint256)', 'function minted(address) view returns (uint256)', 'function mintedBy(address) view returns (uint256)', 'function mintCount(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'],
};
const ERC165 = new ethers.Interface(['function supportsInterface(bytes4) view returns (bool)']);

export class Chain {
  constructor(provider) { this.p = provider; this.codeC = new Map(); }

  async code(a) {
    const k = lc(a); const c = this.codeC.get(k); if (c) return c;
    const v = await this.p.getCode(k); this.codeC.set(k, v); if (this.codeC.size > 2000) this.codeC.clear();
    return v;
  }
  async impl(a, code) {
    const c = cloneImpl(code); if (c) return { impl: c, kind: '克隆（EIP-1167）' };
    const slot = await this.p.getStorage(a, IMPL_SLOT).catch(() => null);
    if (slot && !/^0x0*$/.test(slot)) return { impl: '0x' + slot.slice(-40).toLowerCase(), kind: '可升级代理（EIP-1967）' };
    const beacon = await this.p.getStorage(a, BEACON_SLOT).catch(() => null);
    if (beacon && !/^0x0*$/.test(beacon)) return { impl: null, beacon: '0x' + beacon.slice(-40).toLowerCase(), kind: '信标代理' };
    return null;
  }

  async read(to, sigs, args = [], from) {
    for (const sig of [].concat(sigs)) {
      const i = new ethers.Interface([sig]); const fn = i.fragments[0];
      try {
        const r = await this.p.call({ to, from, data: i.encodeFunctionData(fn, args) });
        if (!r || r === '0x') continue;
        const v = i.decodeFunctionResult(fn, r)[0];
        return { v, sig: fn.format('sighash') };
      } catch { /* 下一个写法 */ }
    }
    return null;
  }

  /** 合约概况：只读代码里确实有的 getter（代理合约按实现合约的代码判断），省调用 */
  async profile(a) {
    const code = await this.code(a);
    const size = (code.length - 2) / 2;
    const px = size > 0 ? await this.impl(a, code) : null;
    const implCode = px?.impl ? await this.code(px.impl).catch(() => '0x') : null;
    const sels = codeSelectors(implCode || code);
    const has = (sig) => sels.has(sel(sig.replace(/^function /, '').replace(/ view.*$/, '').replace(/\s+/g, '')));
    const pickHas = (list) => list.filter((s) => has(s));
    const out = { size, codeHasAgentId: (code + (implCode || '')).toLowerCase().includes(AGENT_ID.slice(2)), proxy: px, implSize: implCode ? (implCode.length - 2) / 2 : null, sels, family: px?.impl ? 'impl:' + px.impl : 'sel:' + selectorFingerprint(sels) };
    const one = async (k, list = G[k]) => { const l = sels.size ? pickHas(list) : list; if (!l.length) return; const r = await this.read(a, l); if (r) out[k] = r.v; if (r && k !== 'name' && k !== 'symbol') out[k + 'Sig'] = r.sig; };
    await Promise.all(['name', 'symbol', 'decimals', 'totalSupply', 'owner', 'paused', 'maxSupply', 'price', 'perWallet', 'gate'].map((k) => one(k)));
    if (out.gate && lc(out.gate) !== AGENT_ID) out.gateOther = lc(out.gate);
    out.gateIsAgentId = !!out.gate && lc(out.gate) === AGENT_ID;
    // 标准：ERC721 / ERC1155 / ERC20（有 decimals）
    const sup = async (id) => { try { const r = await this.p.call({ to: a, data: ERC165.encodeFunctionData('supportsInterface', [id]) }); return ERC165.decodeFunctionResult('supportsInterface', r)[0] === true; } catch { return false; } };
    if (sels.has('0x01ffc9a7') || !sels.size) { out.erc721 = await sup('0x80ac58cd'); out.erc1155 = !out.erc721 && await sup('0xd9b67a26'); }
    out.erc20 = !out.erc721 && !out.erc1155 && out.decimals != null;
    return out;
  }

  /** 某个钱包在这个合约里已经铸了多少（读得到才有） */
  async mintedBy(a, wallet, sels) {
    const l = sels?.size ? walletG.minted.filter((s) => sels.has(sel(s.replace(/^function /, '').replace(/ view.*$/, '')))) : walletG.minted;
    const r = await this.read(a, l, [wallet]);
    return r ? { n: Number(r.v), via: r.sig } : null;
  }

  /** NFT 的图片 / 描述 / 外部链接（tokenURI(1 或 0) / contractURI），拿不到返回 null */
  async meta(a) {
    const tryUri = async (sig, args) => { const r = await this.read(a, sig, args); return r ? String(r.v) : null; };
    const uri = await tryUri('function contractURI() view returns (string)', []) || await tryUri('function tokenURI(uint256) view returns (string)', [1]) || await tryUri('function tokenURI(uint256) view returns (string)', [0]) || await tryUri('function uri(uint256) view returns (string)', [1]);
    if (!uri) return null;
    return { uri: uri.slice(0, 400) };
  }

  /** 内存里没有调用记录时（重启后）：从合约最近发出的事件反查交易（每段 450 块，最多回看约 3000 块 ≈ 20 分钟） */
  async recentTxs(a, { want = 12, maxBlocks = 3000 } = {}) {
    const head = await this.p.getBlockNumber();
    const hashes = [];
    for (let to = head; to > head - maxBlocks && hashes.length < want * 2; to -= 450) {
      let logs = []; try { logs = await this.p.getLogs({ address: a, fromBlock: to - 449, toBlock: to }); } catch { break; }
      for (const l of logs.reverse()) if (!hashes.includes(l.transactionHash)) hashes.push(l.transactionHash);
    }
    const out = [];
    for (const h of hashes.slice(0, want * 2)) {
      const tx = await this.tx(h); if (!tx || lc(tx.to) !== lc(a)) continue;
      out.push({ t: Date.now(), from: lc(tx.from), hash: h, sel: tx.data.slice(0, 10), value: tx.value });
      if (out.length >= want) break;
    }
    return out;
  }

  async receipt(h) { return this.p.getTransactionReceipt(h).catch(() => null); }
  async tx(h) { return this.p.getTransaction(h).catch(() => null); }
}
