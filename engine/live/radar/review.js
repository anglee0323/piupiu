// 把分析结果翻译成人话（方案 R3「三项结论」+ 页面上的「这是什么 / 怎么运作 / 值不值得 / 怎么参与」）。
// 纯函数：输入分析事实，输出文案和结论。结论只基于确定性检查，不预测涨跌；说清楚依据和不确定的地方。
import { ethers } from 'ethers';
import { KIND_LABEL } from './classify.js';
import { summarize } from './utility.js';
import { translate } from '../../../shared/i18n/index.js';
import { riskId, reasonId } from '../../../shared/radarLabels.js';

const bnb = (wei) => { const x = Number(ethers.formatEther(BigInt(wei || 0))); return x === 0 ? '0' : x < 0.0001 ? x.toExponential(2) : String(+x.toFixed(x < 0.01 ? 5 : 4)); };
const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));
const fnShort = (f) => (f ? String(f) : null);

// 模拟失败里哪一些其实是「你已经铸过 / 已到上限 / 已经铸完」：不是风险，不该按失败显示和扣分
const WALLET_LIMIT = /(already|claimed|perwallet|per wallet|walletlimit|wallet limit|maxper|max per|maxmint|exceed.*(max|limit)|limit.*(reach|exceed))/i;
const SOLD_OUT = /(maxsupply|sold ?out|supply.*(reach|exceed)|mint.*closed|notstarted|not started)/i;
export function classifyMintFailure(text) {
  const t = String(text || '');
  if (!t) return null;
  if (WALLET_LIMIT.test(t)) return 'wallet-limit';
  if (SOLD_OUT.test(t)) return 'sold-out';
  return null;
}

/** 供应进度：NFT 用 totalSupply / maxSupply；ERC20 有 cap 也算 */
export function supplyOf(p) {
  const ts = p?.totalSupply != null ? Number(p.totalSupply) : null, mx = p?.maxSupply != null ? Number(p.maxSupply) : null;
  if (p?.erc20 && p.decimals != null) {
    const d = Number(p.decimals); const f = (v) => (v == null ? null : Number(ethers.formatUnits(BigInt(v), d)));
    const a = f(p.totalSupply), b = f(p.maxSupply);
    return { minted: a, max: b, pct: a != null && b ? Math.min(100, (a / b) * 100) : null };
  }
  return { minted: ts, max: mx && mx < 1e12 ? mx : null, pct: ts != null && mx && mx < 1e12 ? Math.min(100, (ts / mx) * 100) : null };
}

/**
 * a = {
 *   kind, cls（classify 结果）, profile（chain.profile）, src（sourceInfo）, noticeZh, fn（主函数名）,
 *   aiOnly: { state: 'verified'|'likely'|'open'|'unknown', why }, recipe, mine: [{ slot, ok, valueWei, reason }],
 *   stats: { aiCallers, callers, ratio, last10, prev10 }, received: { symbol, usd } | null, family: { count } | null
 * }
 */
export function review(a, lang = 'zh') {
  // 显示给用户的句子（简介、风险提示）按 lang 取字典；中文与原来逐字相同（测试和旧代码按原文判断）。事实表、结论等只在中文界面和日志里用，不翻译
  const L = (k, prm) => translate(lang, k, prm);
  const p = a.profile || {}, cls = a.cls || {}, st = a.stats || {}, src = a.src || {};
  const name = p.symbol || p.name || src.name || L('rv.thisContract');
  const kind = a.kind || cls.kind || 'unknown';
  const sup = supplyOf(p);
  const okMine = (a.mine || []).filter((m) => m.ok);
  const needWei = okMine.length ? okMine.map((m) => BigInt(m.valueWei || 0)).sort((x, y) => (x < y ? -1 : 1))[0] : null;
  const seenWei = cls.valueWei != null ? BigInt(cls.valueWei) : null;
  const free = needWei != null ? needWei === 0n : seenWei === 0n;
  const costText = needWei != null ? (needWei === 0n ? L('rv.freeGas') : L('rv.perMint', { v: bnb(needWei) })) : seenWei != null ? (seenWei === 0n ? L('rv.freeGas') : L('rv.aboutPerMint', { v: bnb(seenWei) })) : L('rv.unk');
  const gasText = cls.gasWei ? L('rv.gas', { v: bnb(cls.gasWei) }) : null;
  const gate = a.aiOnly?.state;
  const aiWhy = a.aiOnly?.k && lang !== 'zh' ? L(a.aiOnly.k, a.aiOnly.p) : a.aiOnly?.why;
  const gateText = gate === 'verified' ? L('rv.gate.verified')
    : gate === 'likely' ? L('rv.gate.likely', { why: aiWhy || L('ai.check') })
    : gate === 'open' ? L('rv.gate.open') : L('rv.gate.unknown');
  const perCall = cls.perCall != null && cls.perCall > 0n ? (cls.std === '20' && a.receivedDecimals != null ? Number(ethers.formatUnits(cls.perCall, a.receivedDecimals)).toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(cls.perCall)) : null;

  // ---------- 这是什么（一段话） ----------
  const lines = [];
  const fnName = fnShort(a.fn);
  const pay = free ? L('rv.noPay') : L('rv.payEach', { cost: costText });
  if (kind === 'nft-mint') lines.push(L('rv.nft', { name, forAi: gate === 'verified' || gate === 'likely' ? L('rv.forAi') : '', cost: free ? L('rv.freeMint') : L('rv.mintFee', { cost: costText }), n: perCall || 1 }));
  else if (kind === 'token-mint') lines.push(L('rv.token', { name, fn: fnName || L('rv.mintFn'), per: perCall ? L('rv.perEach', { n: perCall, sym: a.received?.symbol ? ' ' + a.received.symbol : '' }) : '', pay }));
  else if (kind === 'claim') lines.push(L('rv.claim', { fn: fnName || L('rv.claimFn'), amt: perCall ? L('rv.aboutN', { n: perCall }) : '', sym: a.received?.symbol || L('rv.tokens'), usd: a.received?.usd ? L('rv.aboutUsd', { v: a.received.usd.toFixed(2) }) : '', pay }));
  else if (kind === 'buy') lines.push(L('rv.buy', { sym: a.received?.symbol || L('rv.tokens') }));
  else if (kind === 'sell') lines.push(L('rv.sell'));
  else if (kind === 'launch') lines.push(L('rv.launch', { fn: fnName || L('rv.it') }));
  else if (kind === 'interact') lines.push(L('rv.interact', { fn: fnName || L('rv.itsFn') }));
  else lines.push(L('rv.unknownUse'));
  if (kind !== 'nft-mint' || !(gate === 'verified' || gate === 'likely')) lines.push(gateText + L('rv.end'));
  if (sup.max) lines.push(sup.pct != null ? L('rv.supplyPct', { max: n(sup.max), pct: sup.pct.toFixed(1) }) : L('rv.supply', { max: n(sup.max) }));
  else if (Number.isFinite(Number(sup.minted)) && sup.minted !== null && kind === 'nft-mint') lines.push(L('rv.mintedN', { n: n(sup.minted) }));   // 读不到已铸数量时不写（以前会出现「已铸 NaN 个」）
  if (p.perWallet != null && Number(p.perWallet) > 0 && Number(p.perWallet) < 1e6) lines.push(L('rv.perWallet', { n: n(p.perWallet) }));
  if (a.utility?.summary && !/没看到|未发现其他用途/.test(a.utility.summary)) lines.push(L('rv.utility', { s: lang === 'zh' ? a.utility.summary : summarize(a.utility.list || [], lang) }));
  if (a.family?.count > 1) lines.push(L('rv.family', { n: a.family.count }));
  if (a.creator?.name) lines.push(L('rv.creator', { name: a.creator.name, others: a.creator.others?.length ? L('rv.creatorOthers', { n: a.creator.others.length }) : '' }));

  // ---------- 怎么运作（事实表） ----------
  const facts = [
    ['类型', KIND_LABEL[kind] || kind],
    ['调用的函数', a.fn || (a.recipe?.selector ? `未知函数 ${a.recipe.selector}` : '—')],
    ['费用', costText + (gasText ? ` · ${gasText}` : '')],
  ];
  if (perCall) facts.push(['每次得到', `${perCall} ${kind === 'nft-mint' ? '个 NFT' : a.received?.symbol || ''}`.trim()]);
  facts.push(['门槛', gate === 'verified' ? 'Agent ID 专属（已验证）' : gate === 'likely' ? '疑似 Agent ID 专属' : gate === 'open' ? '不限' : '未知']);
  if (sup.max || sup.minted != null) facts.push(['供应', sup.max ? `${sup.minted != null ? n(sup.minted) : '未知'} / ${n(sup.max)}${sup.pct != null ? `（${sup.pct.toFixed(1)}%）` : ''}` : `已铸 ${n(sup.minted)}`]);   // 已铸数读不到时不能写成 undefined%
  if (p.perWallet != null && Number(p.perWallet) > 0 && Number(p.perWallet) < 1e6) facts.push(['每钱包上限', n(p.perWallet)]);
  if (p.paused === true) facts.push(['状态', '已暂停']);
  facts.push(['源码', src.verified ? `已验证（${src.name || 'Sourcify'}）` : src.verified === false ? '未公开' : '查询中']);
  if (a.creator) facts.push(['创建者', `${a.creator.name || a.creator.address}${a.creator.others?.length ? `（还部署了 ${a.creator.others.length} 个）` : ''}`]);
  if (p.proxy) facts.push(['合约结构', p.proxy.kind]);
  facts.push(['参与热度', `30 分钟 ${st.aiCallers ?? 0} 个 .ai 钱包（占 ${Math.round((st.ratio || 0) * 100)}%）· 近 10 分钟 +${st.last10 ?? 0}`]);

  // ---------- 值不值得（依据） ----------
  const pros = [], cons = [];
  if (gate === 'verified') pros.push('已验证为 Agent 专属：仅 .ai 钱包可参与，参与者数量有限');
  if (free) pros.push(okMine.length ? '你的钱包模拟通过，免费（仅需网络费用）' : '其他参与者均为免费铸造');
  else if (needWei != null && needWei <= ethers.parseEther('0.01')) pros.push(`成本低：${bnb(needWei)} BNB`);
  if ((st.aiCallers || 0) >= 20) pros.push(`热度高：30 分钟 ${st.aiCallers} 个 .ai 钱包`);
  if ((st.prev10 || 0) > 0 && (st.last10 || 0) >= st.prev10 * 1.5) pros.push('热度上升：近 10 分钟参与数增加');
  if (sup.pct != null && sup.pct < 70) pros.push(`剩余 ${(100 - sup.pct).toFixed(0)}% 尚未铸造`);
  if (src.verified) pros.push('源码已公开验证，规则可查阅');
  if (a.creator?.name) pros.push(`创建者有 .ai 身份：${a.creator.name}`);
  if (a.mineExhausted) pros.push('你的钱包已铸造过');
  if (a.creator?.others?.length >= 3) cons.push(L('rv.c.batch', { n: a.creator.others.length + 1 }));
  if (src.verified === false) cons.push(L('rv.c.closed'));
  for (const r of src.risks || []) cons.push(L('rv.c.admin', { label: lang !== 'zh' && riskId(r.label) ? L('risk.' + riskId(r.label)) : r.label, fn: r.fn }));
  if (p.proxy?.kind?.includes('升级')) cons.push(L('rv.c.upgrade'));
  if (p.paused === true) cons.push(L('rv.c.paused'));
  if (sup.pct != null && sup.pct >= 95) cons.push(L('rv.c.almost'));
  if (needWei != null && needWei > ethers.parseEther('0.05')) cons.push(L('rv.c.costly', { v: bnb(needWei) }));
  if (kind === 'buy' || kind === 'sell') cons.push(L('rv.c.trade'));
  if (kind === 'nft-mint' && !a.received?.usd) cons.push(L('rv.c.noPrice'));
  if (a.recipe && !a.recipe.supported) cons.push(L('rv.c.noOneClick', { why: a.recipe.whyK && lang !== 'zh' ? L(a.recipe.whyK, a.recipe.whyP) : a.recipe.why }));
  const mineFail = (a.mine || []).filter((m) => !m.ok);
  const hardFail = mineFail.filter((m) => !m.friendly);   // 真正没通过（余额不够、合约拒绝…）；已铸过 / 已满不算
  const failWhy = hardFail[0]?.friendly || hardFail[0]?.reason || '原因未知';
  if (hardFail.length) cons.push(L('rv.c.mineFail', { why: lang !== 'zh' && reasonId(failWhy) ? L('rv.f.' + reasonId(failWhy)) : failWhy }));
  if (a.mineExhausted) lines.push(a.historyNft ? L('rv.mineDoneN', { n: a.historyNft }) : L('rv.mineDone'));

  // ---------- 结论 ----------
  const high = (src.risks || []).some((r) => r.level >= 2) || p.proxy?.kind?.includes('升级');
  let level, label, why;
  const canDo = okMine.length > 0 && a.recipe?.supported;
  if (a.mineExhausted) { level = 'done'; label = '已铸造'; why = a.historyNft ? `你的钱包已铸造 ${a.historyNft} 个` : '你的钱包已铸造过（或已达上限）'; }
  else if (p.paused === true || (sup.pct != null && sup.pct >= 99.5)) { level = 'skip'; label = '已结束'; why = p.paused ? '合约已暂停' : '已经铸完'; }
  else if (kind === 'buy' || kind === 'sell') { level = 'watch'; label = '交易类'; why = '属于交易而非铸造，请按交易判断'; }
  else if (high && !free) { level = 'careful'; label = '谨慎'; why = cons.find((c) => /升级|拉黑|税/.test(c)) || '有较高风险的管理员权限'; }
  else if (canDo && free) {
    // 免费能铸的很多（一波 Agent 专属 NFT 热潮会同时冒出几十个）：只有「Agent 专属已验证 + 正在被抢 + 没有高风险」才算值得一试，其余是「免费可铸」
    const hot = (st.aiCallers || 0) >= 15 || ((st.prev10 || 0) > 0 && (st.last10 || 0) >= st.prev10 * 1.5 && (st.last10 || 0) >= 5);
    if (gate === 'verified' && hot) { level = 'go'; label = '值得一试'; why = `免费、仅限 .ai 钱包、热度高（近 30 分钟 ${st.aiCallers} 个 .ai）`; }
    else { level = 'easy'; label = '免费可铸'; why = gate === 'open' ? '免费，但不限钱包，稀缺性低' : hot ? '免费，热度较高，但尚未确认是否为 Agent 专属' : '免费，你的钱包可以铸造，但热度一般，价值不确定'; }
  }
  else if (canDo && needWei != null && needWei <= ethers.parseEther('0.01')) { level = 'go'; label = '可以一试'; why = `成本 ${bnb(needWei)} BNB，你的钱包可以参与`; }
  else if (canDo) { level = 'watch'; label = '看情况'; why = `可以参与，但需支付 ${bnb(needWei)} BNB，建议先了解项目`; }
  else if (a.recipe && !a.recipe.supported) { level = 'watch'; label = '只能看'; why = a.recipe.why; }
  else if ((a.mine || []).length && !okMine.length) { level = 'watch'; label = '暂时无法参与'; why = mineFail[0]?.reason || '模拟没通过'; }
  else { level = 'watch'; label = '观察中'; why = '分析中，或钱包尚未登录'; }

  // ---------- 一句话（列表里用） ----------
  const tag = [KIND_LABEL[kind] || '', free ? '免费' : needWei != null ? `${bnb(needWei)} BNB` : seenWei != null && seenWei > 0n ? `约 ${bnb(seenWei)} BNB` : '', gate === 'verified' ? 'Agent 专属' : gate === 'likely' ? '疑似 Agent 专属' : '', sup.pct != null ? `已铸 ${sup.pct.toFixed(0)}%` : ''].filter(Boolean).join(' · ');

  // ---------- 怎么参与 ----------
  const howTo = [];
  if (a.recipe?.supported) {
    howTo.push(`参照 .ai 钱包的成功调用：调用 ${fnShort(a.fn) || a.recipe.selector}${a.recipe.qtyWord != null ? '（可选择数量）' : ''}，并将参数中的地址替换为你的钱包地址。`);
    howTo.push(needWei != null ? `你的钱包需支付：${needWei === 0n ? '0 BNB（免费，仅需网络费用）' : bnb(needWei) + ' BNB'}。` : '先点击「检查」，使用你的钱包进行模拟，确认费用及能否成功。');
    howTo.push('确认后由币安钱包签名发送；上链后核对 NFT / 代币是否到账。');
  } else if (a.recipe) howTo.push(`暂不支持一键参与：${a.recipe.why}。可通过官网或 BscScan 了解参与方式。`);
  else howTo.push('正在分析调用方式。');

  // ---------- 核验依据：每项信息的可信程度（源码 < 链上读取 < 模拟通过 < 实际成功）。思路借鉴 EZbot 研究流程（MIT，0xquqi）。
  // 键是详情页「基本信息」各行的固定编号（price / perCall / supply / perWallet / gate / heat / creator / source），不随界面语言变化；
  // k 是说明文字的文案键（shared/i18n），界面按当前语言显示
  const evidence = {};
  const ev = (id, level, k) => { evidence[id] = { level, k }; };
  if (a.historyNft > 0) ev('price', 'done', 'ev.price.done');
  else if (needWei != null) ev('price', 'sim', 'ev.price.sim');
  else if (seenWei != null) ev('price', 'chain', 'ev.price.chain');
  else ev('price', 'none', 'ev.unchecked');
  if (perCall) ev('perCall', 'chain', 'ev.perCall.chain');
  if (sup.max || sup.minted != null) ev('supply', 'chain', 'ev.live');
  if (p.perWallet != null) ev('perWallet', 'chain', 'ev.live');
  if (gate === 'verified') ev('gate', 'sim', 'ev.gate.verified');
  else if (gate === 'open') ev('gate', 'sim', 'ev.gate.open');
  else if (gate === 'likely') ev('gate', src.agentGate ? 'source' : 'chain', src.agentGate ? 'ev.gate.source' : 'ev.gate.chain');
  else ev('gate', 'none', 'ev.unchecked');
  ev('heat', 'chain', 'ev.heat.chain');
  if (a.creator) ev('creator', 'chain', 'ev.creator.chain');
  if (src.verified) ev('source', 'source', 'ev.src.source');
  else ev('source', 'none', src.verified === false ? 'ev.src.closed' : 'ev.src.unknown');
  // 「基本信息」的数值（不带文字，网页按语言排版）
  const vals = {
    perCall: perCall ? { n: perCall, unit: kind === 'nft-mint' ? 'nft' : a.received?.symbol || '' } : null,
    supply: sup.max || sup.minted != null ? { minted: sup.minted, max: sup.max, pct: sup.pct } : null,
    perWallet: p.perWallet != null && Number(p.perWallet) > 0 && Number(p.perWallet) < 1e6 ? Number(p.perWallet) : null,
  };
  return { oneLine: tag, explain: lines.join('').trim(), facts, pros, cons, evidence, vals, verdict: { level, label, why }, howTo, needWei: needWei != null ? String(needWei) : null, canDo };
}
