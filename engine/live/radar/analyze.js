// 分析一个候选合约（方案 R1–R4 的「自动初筛 + 研究 + 参与前检查」）：
//   取几笔 .ai 钱包最近的成功调用（回执）→ 归类（铸 NFT / 领取 / 发射台…）→ 合约概况（供应、价格、上限、门槛）
//   → 源码与说明（Sourcify，英文说明翻成中文）→ 参与配方 → Agent 专属对比模拟（.ai 钱包 vs 随机普通地址）
//   → 用你自己的钱包模拟（免费名额 / 要付多少 / 会被拒绝的原因）→ 人话结论
// 全部只读。约 20–40 次节点调用，候选上榜时跑一次，之后活跃期间每 10 分钟、打开详情时（超过 2 分钟）再跑。
import { ethers } from 'ethers';
import { classify, flows } from './classify.js';
import { deriveRecipe, build, valueCandidates, simulate, randomAddr, normalize } from './recipe.js';
import { nameOf, revertText } from './sigs.js';
import { sourceInfo, zh } from './source.js';
import { review, classifyMintFailure } from './review.js';
import { readSite, safeUrl } from './research.js';
import { nftMeta } from './meta.js';
import { utilities } from './utility.js';
import { socialInfo, socialEnabled, xSearchUrl } from './social.js';
import { EP } from '../endpoints.js';

/** 链上记录：NFT → OKX 合集页（按合约地址直接打开）+ BscScan 代币页；代币 → DexScreener + BscScan */
export function marketLinks(a, kind, std, received) {
  if (kind === 'nft-mint' || std === '721' || std === '1155') return [
    { name: 'OKX NFT', url: `https://web3.okx.com/zh-hans/nft/collection/bsc/${a}`, note: '合集页与挂单' },
    { name: 'BscScan', url: `https://bscscan.com/token/${a}`, note: '持有人与转账记录' },
  ];
  const t = received?.token || a;
  return [
    { name: 'DexScreener', url: received?.dex || `https://dexscreener.com/bsc/${t}`, note: '交易池与价格' },
    { name: 'BscScan', url: `https://bscscan.com/token/${t}`, note: '持有人与转账记录' },
  ];
}

const lc = (a) => String(a || '').toLowerCase();
export const ANALYSIS_VER = 16;   // 结论规则 / 字段改了就加一：旧的分析会被重新跑
const AGENTISH = /agent|\.ai|notai|onlyai|holder|identity|eligible|not.?allowed|unauthori[sz]ed|forbidden|only/i;

async function poolMap(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]).catch(() => null); } })); return out; }

/** DexScreener：领到 / 买到的代币有没有市场价（拿不到就算了） */
async function dexPrice(token) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
  try { const r = await fetch(`${EP.dexscreener}/latest/dex/tokens/${token}`, { signal: ac.signal }); const j = await r.json(); const p = (j?.pairs || []).filter((x) => x.chainId === 'bsc').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]; return p ? { usd: Number(p.priceUsd) || null, liq: p.liquidity?.usd || null, url: p.url } : null; } catch { return null; } finally { clearTimeout(t); }
}

/**
 * ctx = { chain, provider, scan, aiSet, wallets: [{ slot, address }], stats, family, prev（上一次的分析，复用不变的部分）, deep（打开详情时 = true：读官网） }
 */
export async function analyze(address, ctx) {
  const a = lc(address);
  const { chain, provider, scan, aiSet, prev } = ctx;
  const started = Date.now();
  // 1) 样本：已知 .ai 钱包最近的调用 → 交易 + 回执（新的在前，最多 8 笔）
  let recent = scan ? scan.recent(a, 80) : [];
  let aiEv = recent.filter((e) => aiSet.peek(e.from) === true && e.hash).slice(0, 8);
  if (aiEv.length < 2) {   // 重启后内存里没记录：从合约事件反查最近的调用，调用者是不是 .ai 直接查
    const back = await chain.recentTxs(a).catch(() => []);
    for (const e of back) if (aiSet.peek(e.from) === undefined) await aiSet.check(e.from).catch(() => null);
    recent = [...recent, ...back.filter((e) => !recent.some((r) => r.hash === e.hash))];
    aiEv = recent.filter((e) => aiSet.peek(e.from) === true && e.hash).slice(0, 8);
  }
  const fetched = await poolMap(aiEv, 4, async (e) => { const [tx, rc] = await Promise.all([chain.tx(e.hash), chain.receipt(e.hash)]); return tx && rc ? { tx, rc, e } : null; });
  const samples = fetched.filter(Boolean);
  const good = samples.filter((s) => s.rc.status === 1);
  const failed = samples.length - good.length;

  // 2) 合约概况 + 源码（代理合约的源码在实现合约上）
  const profile = await chain.profile(a);
  let src = await sourceInfo(a);
  if (src.verified === false && profile.proxy?.impl) { const s2 = await sourceInfo(profile.proxy.impl); if (s2.verified) src = { ...s2, viaImpl: profile.proxy.impl }; }

  // 3) 归类 + 配方 + 函数名
  const cls = good.length ? classify(good.map((s) => ({ rc: s.rc, tx: s.tx })), a) : prev?.cls || { kind: 'unknown', n: 0 };
  const recipe = good.length >= 2 ? deriveRecipe(good.map((s) => ({ from: s.tx.from, input: s.tx.data, value: s.tx.value }))) : prev?.recipe || null;
  const selector = recipe?.selector || good[0]?.tx?.data?.slice(0, 10) || prev?.selector || null;
  const fn = selector ? await nameOf(selector, src.abi) : null;

  // 4) Agent 专属：同一笔调用，.ai 钱包 vs 随机普通地址
  let aiOnly = prev?.aiOnly || { state: 'unknown', why: null };
  const s0 = good[0];
  if (s0) {
    const rnd = randomAddr();
    const rData = recipe?.supported ? build(recipe, rnd, recipe.qtyWord != null ? Number(BigInt('0x' + s0.tx.data.slice(10 + recipe.qtyWord * 64, 10 + recipe.qtyWord * 64 + 64))) : 1) : normalize(s0.tx.data, s0.tx.from).split('c0ffee'.repeat(6) + 'c0ffee00').join(rnd.slice(2));
    const [simAi, simRnd] = await Promise.all([
      simulate(provider, { from: s0.tx.from, to: a, data: s0.tx.data, value: BigInt(s0.tx.value || 0), override: true }),
      simulate(provider, { from: rnd, to: a, data: rData, value: BigInt(s0.tx.value || 0), override: true }),
    ]);
    const rndWhy = simRnd.ok ? null : (simRnd.data ? await revertText(simRnd.data, src.abi) : simRnd.reason);
    const staticHint = src.agentGate || profile.codeHasAgentId || profile.gateIsAgentId;
    // why 是中文原文；k / p 是文案键和参数（英文界面用）
    if (simRnd.ok) aiOnly = { state: 'open', why: '普通地址模拟同样成功', k: 'ai.open' };
    else if (simRnd.unsupported) aiOnly = staticHint ? { state: 'likely', why: '合约中包含 Agent ID 校验', k: 'ai.check' } : { state: 'unknown', why: '节点不支持对比模拟', k: 'ai.noOverride' };
    else if (simAi.ok || AGENTISH.test(String(rndWhy))) aiOnly = { state: 'verified', why: `普通地址被拒绝：${rndWhy || '合约拒绝'}`, ...(rndWhy ? { k: 'ai.rejected', p: { r: rndWhy } } : { k: 'ai.rejectedPlain' }) };
    else aiOnly = staticHint ? { state: 'likely', why: `合约中包含 Agent ID 校验；普通地址被拒绝（${rndWhy || '原因不明'}）`, ...(rndWhy ? { k: 'ai.checkRejected', p: { r: rndWhy } } : { k: 'ai.checkRejectedPlain' }) } : { state: 'unknown', why: rndWhy };
  } else if (aiOnly.state === 'unknown' && (src.agentGate || profile.codeHasAgentId || profile.gateIsAgentId)) aiOnly = { state: 'likely', why: '合约中包含 Agent ID 校验', k: 'ai.check' };

  // 5) 用你自己的钱包模拟：先试免费，再按观察到的金额从小到大试
  const mine = [];
  if (recipe?.supported) {
    for (const w of ctx.wallets || []) {
      const data = build(recipe, w.address, 1);
      let row = null, lastWhy = null;
      for (const v of valueCandidates(recipe, 1)) {
        const r = await simulate(provider, { from: w.address, to: a, data, value: v });
        if (r.ok) { row = { slot: w.slot, address: w.address, ok: true, valueWei: String(v), gas: r.gas }; break; }
        lastWhy = r.funds ? '余额不够' : r.data ? await revertText(r.data, src.abi) : r.reason;
      }
      const minted = await chain.mintedBy(a, w.address, profile.sels).catch(() => null);
      if (row) mine.push({ ...row, minted: minted?.n ?? null });
      else {
        // 失败原因分两类：已经铸过 / 已到上限 / 已铸完 = 不是风险；其余才算真的没通过
        // 这个钱包已经持有 / 铸过（链上读到数量 > 0）：再铸被拒（价格变了 WrongValue、名额用完、无原因回滚）都只是「铸过了」，不是风险
        const kind = classifyMintFailure(lastWhy) || (minted?.n > 0 ? 'wallet-limit' : null);
        mine.push({ slot: w.slot, address: w.address, ok: false, reason: lastWhy || '模拟失败', minted: minted?.n ?? null,
          friendly: kind === 'wallet-limit' ? '本钱包已铸造过或已达上限' : kind === 'sold-out' ? '已经铸完' : null, limit: kind });
      }
    }
  }

  // 6) 收到的代币：名字 / 精度 / 市场价
  let received = prev?.received || null, receivedDecimals = prev?.receivedDecimals ?? null;
  if (cls.token && cls.std === '20' && (!received || received.token !== cls.token)) {
    const [sym, dec] = await Promise.all([chain.read(cls.token, 'function symbol() view returns (string)'), chain.read(cls.token, 'function decimals() view returns (uint8)')]);
    receivedDecimals = dec ? Number(dec.v) : 18;
    const px = await dexPrice(cls.token);
    const per = cls.perCall ? Number(ethers.formatUnits(cls.perCall, receivedDecimals)) : null;
    received = { token: cls.token, symbol: sym ? String(sym.v) : null, priceUsd: px?.usd || null, usd: px?.usd && per ? px.usd * per : null, liq: px?.liq || null, dex: px?.url || null };
  } else if (cls.token && cls.std !== '20' && cls.token !== a) {
    const sym = await chain.read(cls.token, 'function symbol() view returns (string)');
    received = { token: cls.token, symbol: sym ? String(sym.v) : null };
  }

  // 7) 说明（英文 → 中文）+ 资料
  const notice = src.notice || null;
  const same = prev?.v === ANALYSIS_VER;   // 版本变了（比如翻译规则改了）就不复用上次的翻译
  const noticeZh = notice ? (same && prev?.notice === notice && prev?.noticeZh ? prev.noticeZh : await zh(notice)) : null;
  const fnDoc = fn && src.methodDoc ? src.methodDoc[fn] || null : null;
  const fnDocZh = fnDoc ? (same && prev?.fnDoc === fnDoc && prev?.fnDocZh ? prev.fnDocZh : await zh(fnDoc)) : null;
  const links = [...new Set([...(src.links || []), ...(ctx.userLinks || [])])];
  let site = prev?.site || null;
  if (ctx.deep && (!site || Date.now() - (site.at || 0) > 6 * 3600_000 || ctx.userLinks?.some((u) => !site.pages?.some((p) => p.url === u)))) {
    const site0 = links.find((u) => safeUrl(u) && !/x\.com|twitter\.com|t\.me|discord/i.test(u));
    const pages = [];
    if (site0) pages.push(...await readSite(site0));
    for (const u of ctx.userLinks || []) if (u !== site0) pages.push(...await readSite(u));
    for (const p of pages) if (p.ok && (p.desc || p.text)) p.zh = await zh((p.desc || '') + (p.desc ? '' : p.text.slice(0, 600)));
    site = { at: Date.now(), pages };
  }

  // 8) 项目档案：元数据（名称 / 描述 / 图片 / 官网 / 社交）+ NFT 用途 + 推特讨论（详情打开或排在前面时才查推特）
  const meta = same && prev?.metaAt && Date.now() - prev.metaAt < 6 * 3600_000 ? prev.metaRaw : await nftMeta(provider, a).catch(() => null);
  const utility = utilities({ abi: src.abi, sels: profile.sels, text: [notice, meta?.description].filter(Boolean).join(' ') });
  const descZh = meta?.description ? (same && prev?.project?.description === meta.description && prev?.project?.descriptionZh ? prev.project.descriptionZh : await zh(meta.description)) : null;
  const allLinks = [...new Set([...(meta?.links || []), ...links, ...((site?.pages || []).flatMap((p) => p.links || []))])];
  const xHandles = allLinks.map((u) => /https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{2,15})(?:[/?]|$)/.exec(u)?.[1]).filter((h) => h && !/^(search|intent|home|share|i)$/i.test(h));
  const projName = meta?.name || src.name || (profile.name ? String(profile.name) : null);
  const names = [projName, profile.name ? String(profile.name) : null, profile.symbol ? String(profile.symbol) : null].filter(Boolean);
  let social = same ? prev?.social || null : null;
  // 旧版本（v<4，相关性规则太松）或超过 30 分钟：重新查。只有「这次请求失败」才保留上次同版本的结果，
  // 查询成功但 0 条就是 0 条（以前 0 条时会一直沿用旧版本找到的无关推文）
  if (social && social.v !== 4) social = null;
  const staleSocial = !social?.enabled || Date.now() - (social.at || 0) > 30 * 60_000;
  if (ctx.social && staleSocial) { const fresh = await socialInfo(a, names, { knownHandles: xHandles }).catch(() => null); if (fresh) social = fresh.error && !fresh.count && social ? { ...social, error: fresh.error } : fresh; }
  if (!social && socialEnabled()) social = { v: 4, enabled: true, pending: true, searchUrl: xSearchUrl(a), count: 0, top: [], official: xHandles[0] ? { handle: xHandles[0], url: `https://x.com/${xHandles[0]}`, from: '项目元数据 / 官网' } : null };
  if (!social) social = { enabled: false, searchUrl: xSearchUrl(projName ? `"${projName}"` : a), count: 0, top: [], official: xHandles[0] ? { handle: xHandles[0], url: `https://x.com/${xHandles[0]}`, from: '项目元数据 / 官网' } : null };
  const project = { name: projName, description: meta?.description || null, descriptionZh: descZh, image: meta?.image || null, onchain: !!meta?.onchain, attributes: meta?.attributes || [], links: allLinks.slice(0, 10) };

  const stats = ctx.stats || {};
  const creator = src.deployer ? { address: src.deployer, name: ctx.nameOf?.(src.deployer) || null, others: ctx.creatorOthers?.(src.deployer, a) || [] } : null;
  // 「已经铸过 / 已达上限」：所有要参与的钱包都因为上限或售罄而模拟失败（不是风险）
  const mineExhausted = mine.length > 0 && mine.every((m) => !m.ok && m.friendly);
  const rin = { kind: cls.kind, cls, profile, src, noticeZh, fn, aiOnly, recipe, mine, mineExhausted, historyNft: ctx.historyNft || 0, stats, received, receivedDecimals, family: ctx.family, creator, utility };
  const r = review(rin), rEn = review(rin, 'en');   // 英文界面只用到简介和风险提示
  return {
    v: ANALYSIS_VER, at: Date.now(), ms: Date.now() - started, address: a,
    // 样本调用（详情页「大家在做什么」在内存没有记录时用）：谁、调了什么、付了多少、得到什么
    calls: await Promise.all(samples.slice(0, 12).map(async (s) => {
      const f = s.rc.status === 1 ? flows(s.rc, s.tx.from) : { got: [] };
      return { t: s.e.t, from: lc(s.tx.from), hash: s.tx.hash, fn: s.tx.data.slice(0, 10) === selector ? fn : s.tx.data.slice(0, 10), value: ethers.formatEther(s.tx.value || 0n), ok: s.rc.status === 1, block: s.rc.blockNumber,
        got: f.got.slice(0, 4).map((x) => ({ token: x.token, std: x.std, amount: x.std === '721' ? '1' : String(x.amount) })) };
    })),
    name: profile.name ? String(profile.name) : null, symbol: profile.symbol ? String(profile.symbol) : null,
    selector, fn, cls: { ...cls, valueWei: cls.valueWei != null ? String(cls.valueWei) : null, perCall: cls.perCall != null ? String(cls.perCall) : null, gasWei: cls.gasWei != null ? String(cls.gasWei) : null },
    samples: samples.length, failed, recipe, aiOnly, mine, mineExhausted, received, receivedDecimals,
    profile: { size: profile.size, codeHasAgentId: profile.codeHasAgentId, proxy: profile.proxy, family: profile.family, erc721: !!profile.erc721, erc1155: !!profile.erc1155, erc20: !!profile.erc20,
      totalSupply: profile.totalSupply != null ? String(profile.totalSupply) : null, maxSupply: profile.maxSupply != null ? String(profile.maxSupply) : null, decimals: profile.decimals != null ? Number(profile.decimals) : null,
      perWallet: profile.perWallet != null ? String(profile.perWallet) : null, price: profile.price != null ? String(profile.price) : null, paused: profile.paused ?? null, owner: profile.owner ? lc(profile.owner) : null },
    src: { verified: src.verified, name: src.name || null, risks: src.risks || [], agentGate: !!src.agentGate, viaImpl: src.viaImpl || null, links, deployer: src.deployer || null, deployBlock: src.deployBlock || null },
    creator,
    notice, noticeZh, fnDoc, fnDocZh, site, review: r, reviewEn: { explain: rEn.explain, cons: rEn.cons },
    project, utility, social, metaRaw: meta, metaAt: meta ? (same && prev?.metaAt ? prev.metaAt : Date.now()) : null,
    markets: marketLinks(a, cls.kind, cls.std, received),
  };
}
