// NFT / 代币的元数据（项目档案的主要来源）：contractURI（合集）+ tokenURI(1 / 0)（单个 NFT）。
// 支持 data:application/json（base64 / 明文，链上 NFT 常见）、ipfs://、ar://、https://；图片支持 data:image（链上 SVG）/ ipfs / https。
// 元数据放在 https 域名上的，这个域名大概率就是项目官网（aimonsters.club 之类）。只读，单个文件 ≤ 300KB，6 秒超时。
import { ethers } from 'ethers';
import { safeUrl } from './research.js';
import { EP } from '../endpoints.js';

const IPFS = EP.ipfs.filter((u) => !/mypinata/.test(u));
const I = new ethers.Interface(['function tokenURI(uint256) view returns (string)', 'function contractURI() view returns (string)', 'function uri(uint256) view returns (string)', 'function baseURI() view returns (string)']);

/** ipfs:// / ar:// → 可访问的 https 地址（第 n 个网关） */
export function gatewayUrl(u, n = 0) {
  const s = String(u || '').trim();
  if (/^ipfs:\/\//i.test(s)) return IPFS.length ? IPFS[n % IPFS.length] + s.replace(/^ipfs:\/\/(ipfs\/)?/i, '') : null;   // 没配置网关（开源版）：读不了
  if (/^ar:\/\//i.test(s)) return EP.arweave ? EP.arweave + s.slice(5) : null;
  if (/^https:\/\//i.test(s)) return s;
  return null;
}

/** data: URI → 文本（JSON / SVG） */
export function dataUri(s) {
  const m = /^data:([^,;]+)?(;base64)?,(.*)$/is.exec(String(s || ''));
  if (!m) return null;
  try { return { type: m[1] || 'text/plain', text: m[2] ? Buffer.from(m[3], 'base64').toString('utf8') : decodeURIComponent(m[3]) }; } catch { return null; }
}

async function fetchText(url, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json,*/*' } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer(); if (buf.byteLength > 300_000) return null;
    return Buffer.from(buf).toString('utf8');
  } catch { return null; } finally { clearTimeout(t); }
}

/** 读一个 URI 指向的 JSON（ERC721 / 1155 的 {id} 占位符替换成 1） */
export async function readJsonUri(uri) {
  const u = String(uri || '').replace(/\{id\}/g, '0'.repeat(63) + '1');
  const d = dataUri(u);
  if (d) { try { return { json: JSON.parse(d.text), host: null, onchain: true }; } catch { return null; } }
  for (let n = 0; n < (/^ipfs:/i.test(u) ? 3 : 1); n++) {
    const url = gatewayUrl(u, n); if (!url || !safeUrl(url)) return null;
    const txt = await fetchText(url); if (!txt) continue;
    try { return { json: JSON.parse(txt), host: /^https:/i.test(u) ? new URL(u).host : null, onchain: false }; } catch { return null; }
  }
  return null;
}

/** 图片：链上 SVG（data:）直接用；ipfs / ar 换成网关；太大的 data URI 不返回（页面上会很卡） */
export function imageUrl(img) {
  const s = String(img || '').trim(); if (!s) return null;
  if (/^data:image\//i.test(s)) return s.length <= 200_000 ? s : null;
  return gatewayUrl(s);
}

const pickStr = (o, ...ks) => { for (const k of ks) if (typeof o?.[k] === 'string' && o[k].trim()) return o[k].trim(); return null; };

/** 合约的元数据档案：名称、描述、图片、官网、社交链接、属性数量、是否链上存储 */
export async function nftMeta(provider, address) {
  const call = async (fn, args) => { try { const r = await provider.call({ to: address, data: I.encodeFunctionData(fn, args) }); const v = I.decodeFunctionResult(fn, r)[0]; return v ? String(v) : null; } catch { return null; } };
  const [cUri, t1, t0, u1] = await Promise.all([call('contractURI', []), call('tokenURI', [1]), call('tokenURI', [0]), call('uri', [1])]);
  const [coll, item] = await Promise.all([cUri ? readJsonUri(cUri) : null, readJsonUri(t1 || t0 || u1)]);
  if (!coll && !item) return null;
  const c = coll?.json || {}, it = item?.json || {};
  const links = new Set();
  for (const v of [pickStr(c, 'external_link', 'external_url', 'website', 'url'), pickStr(it, 'external_url', 'external_link', 'website')]) if (v && /^https:\/\//i.test(v)) links.add(v);
  const host = coll?.host || item?.host;
  if (host && !/ipfs|arweave|pinata|nftstorage|cloudflare|amazonaws|googleapis|githubusercontent|vercel\.app$/i.test(host)) links.add(`https://${host}`);
  const desc = pickStr(c, 'description') || pickStr(it, 'description');
  for (const m of String(desc || '').match(/https?:\/\/[^\s)"']+/g) || []) links.add(m.replace(/[.,]+$/, ''));
  for (const k of ['twitter', 'x', 'telegram', 'discord']) { const v = pickStr(c, k) || pickStr(it, k); if (v) links.add(/^https?:/.test(v) ? v : k === 'twitter' || k === 'x' ? `https://x.com/${v.replace(/^@/, '')}` : v); }
  return {
    name: pickStr(c, 'name') || String(pickStr(it, 'name') || '').replace(/\s*#\d+.*$/, '') || null,
    description: desc ? desc.slice(0, 1500) : null,
    image: imageUrl(pickStr(c, 'image', 'image_url', 'logo') || pickStr(it, 'image', 'image_url', 'image_data')),
    onchain: !!(coll?.onchain || item?.onchain),
    attributes: Array.isArray(it.attributes) ? it.attributes.slice(0, 12).map((x) => ({ k: String(x.trait_type ?? ''), v: String(x.value ?? '') })) : [],
    links: [...links].slice(0, 8),
  };
}
