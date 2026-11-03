// 雷达分析层的纯函数单测：回执归类、参与配方（照抄 / 数量参数 / 不支持）、结论分档
import test from 'node:test';
import { EP } from '../endpoints.js';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { DICTS } from '../../../shared/i18n/index.js';
import { classify, flows } from './classify.js';
import { deriveRecipe, build, valueCandidates, normalize } from './recipe.js';
import { review } from './review.js';
import { summarize } from './utility.js';
import { RISKY } from './source.js';
import { RISK_ID } from '../../../shared/radarLabels.js';
import { T_TRANSFER, codeSelectors, cloneImpl } from './chain.js';

const ZERO32 = '0x' + '0'.repeat(64);
const pad = (a) => ethers.zeroPadValue(a, 32);
const NFT = '0x' + 'aa'.repeat(20), TOKEN = '0x' + 'bb'.repeat(20);
const U1 = '0x' + '11'.repeat(20), U2 = '0x' + '22'.repeat(20), U3 = '0x' + '33'.repeat(20);
const nftMintLog = (to, id) => ({ address: NFT, topics: [T_TRANSFER, ZERO32, pad(to), ethers.toBeHex(id, 32)], data: '0x' });
const erc20Log = (token, from, to, amt) => ({ address: token, topics: [T_TRANSFER, pad(from), pad(to)], data: ethers.toBeHex(amt, 32) });

test('flows / classify：NFT 铸造、领取、买入、无资产进出', () => {
  const rc = { status: 1, logs: [nftMintLog(U1, 7)], gasUsed: 200000n, gasPrice: 1000000000n };
  const f = flows(rc, U1);
  assert.equal(f.got.length, 1); assert.equal(f.got[0].std, '721'); assert.equal(f.got[0].mint, true);
  const nft = classify([{ rc, tx: { from: U1, value: 0n } }, { rc: { ...rc, logs: [nftMintLog(U2, 8)] }, tx: { from: U2, value: 0n } }], NFT);
  assert.equal(nft.kind, 'nft-mint'); assert.equal(nft.valueWei, 0n); assert.equal(nft.perCall, 1n); assert.equal(nft.token, NFT.toLowerCase());
  const claim = classify([{ rc: { status: 1, logs: [erc20Log(TOKEN, NFT, U1, 1000n)] }, tx: { from: U1, value: 0n } }], NFT);
  assert.equal(claim.kind, 'claim');
  const buy = classify([{ rc: { status: 1, logs: [erc20Log(TOKEN, NFT, U1, 1000n)] }, tx: { from: U1, value: 10n ** 16n } }], NFT);
  assert.equal(buy.kind, 'buy');
  const none = classify([{ rc: { status: 1, logs: [] }, tx: { from: U1, value: 0n } }], NFT);
  assert.equal(none.kind, 'interact');
  assert.equal(classify([{ rc: { status: 0, logs: [] }, tx: { from: U1, value: 0n } }], NFT).kind, 'unknown', '失败的交易不算样本');
});

test('配方：参数完全一样 → 照抄；参数里的调用者地址换成你的', () => {
  const i = new ethers.Interface(['function mint(uint256)', 'function claim(address)']);
  const same = [U1, U2, U3].map((u) => ({ from: u, input: i.encodeFunctionData('mint', [1]), value: 0n }));
  const r = deriveRecipe(same);
  assert.equal(r.supported, true); assert.equal(r.qtyWord, null);
  assert.equal(build(r, U3), i.encodeFunctionData('mint', [1]));
  const withAddr = [U1, U2].map((u) => ({ from: u, input: i.encodeFunctionData('claim', [u]), value: 0n }));
  const r2 = deriveRecipe(withAddr);
  assert.equal(r2.supported, true, '只有调用者地址不同 = 同一个配方'); assert.equal(r2.usesCaller, true);
  assert.equal(build(r2, U3).toLowerCase(), i.encodeFunctionData('claim', [U3]).toLowerCase());
  assert.equal(normalize(i.encodeFunctionData('claim', [U1]), U1).includes('11'.repeat(20)), false);
});

test('配方：只有一个小整数不同 → 数量参数；金额和数量成正比 → 单价', () => {
  const i = new ethers.Interface(['function mint(uint256)']);
  const unit = 10n ** 15n;
  const s = [[U1, 1], [U2, 3], [U3, 2]].map(([u, q]) => ({ from: u, input: i.encodeFunctionData('mint', [q]), value: unit * BigInt(q) }));
  const r = deriveRecipe(s);
  assert.equal(r.supported, true); assert.equal(r.qtyWord, 0); assert.equal(r.unitWei, String(unit));
  assert.equal(build(r, U1, 5), i.encodeFunctionData('mint', [5]));
  assert.deepEqual(valueCandidates(r, 5), [unit * 5n]);
});

test('配方：每个人参数都不一样（像签名）→ 不支持，并说明原因', () => {
  const i = new ethers.Interface(['function mint(bytes32,bytes32)']);
  const s = [U1, U2, U3].map(() => ({ from: U1, input: i.encodeFunctionData('mint', [ethers.hexlify(ethers.randomBytes(32)), ethers.hexlify(ethers.randomBytes(32))]), value: 0n }));
  const r = deriveRecipe(s);
  assert.equal(r.supported, false); assert.match(r.why, /2 项不同/); assert.equal(r.mech, 'unknown');
  assert.equal(deriveRecipe(s.slice(0, 1)).supported, false, '样本太少');
});

test('配方：参数带签名 / 名单证明 / 时间戳 → 不支持，并说明是哪一类', () => {
  const rb = () => ethers.hexlify(ethers.randomBytes(32));
  const mk = (sig, enc) => [U1, U2, U3].map((u) => ({ from: u, input: enc(u), value: 0n }));
  const si = new ethers.Interface(['function claim(uint256,bytes)']);
  const sig = deriveRecipe(mk(0, () => si.encodeFunctionData('claim', [1, ethers.hexlify(ethers.randomBytes(65))])));
  assert.equal(sig.supported, false); assert.equal(sig.mech, 'signature'); assert.match(sig.why, /签名/);
  const pi = new ethers.Interface(['function claim(bytes32[])']);
  const proof = deriveRecipe(mk(0, () => pi.encodeFunctionData('claim', [[rb(), rb(), rb()]])));
  assert.equal(proof.mech, 'proof'); assert.match(proof.why, /名单证明/);
  const ti = new ethers.Interface(['function mint(uint256)']);
  const ts = deriveRecipe([1790000001, 1790000099, 1790000200].map((t, k) => ({ from: [U1, U2, U3][k], input: ti.encodeFunctionData('mint', [t]), value: 0n })));
  assert.equal(ts.mech, 'timestamp'); assert.match(ts.why, /时间戳/);
});

test('valueCandidates：先试免费，再按观察到的金额从小到大', () => {
  const r = { supported: true, values: ['6800000000000000', '0'], unitWei: null };
  assert.deepEqual(valueCandidates(r), [0n, 6800000000000000n]);
});

test('结论分档：Agent 专属已验证 + 正在被抢 → 值得一试；热度一般 → 免费可铸；暂停 → 已结束；不能照抄 → 只能看', () => {
  const base = { kind: 'nft-mint', cls: { kind: 'nft-mint', valueWei: 0n, perCall: 1n, std: '721' }, profile: { totalSupply: 100n, maxSupply: 5000n, symbol: 'X' }, src: { verified: true, risks: [] },
    aiOnly: { state: 'verified' }, recipe: { supported: true, selector: '0xa0712d68', qtyWord: null }, mine: [{ slot: 1, ok: true, valueWei: '0' }] };
  assert.equal(review({ ...base, stats: { aiCallers: 30, ratio: 0.9, last10: 12, prev10: 5 } }).verdict.level, 'go');
  assert.equal(review({ ...base, stats: { aiCallers: 6, ratio: 0.9, last10: 2, prev10: 3 } }).verdict.level, 'easy');
  assert.equal(review({ ...base, aiOnly: { state: 'open' }, stats: { aiCallers: 40, ratio: 0.9, last10: 20, prev10: 5 } }).verdict.level, 'easy', '谁都能铸的不算值得一试');
  assert.equal(review({ ...base, profile: { ...base.profile, paused: true }, stats: {} }).verdict.level, 'skip');
  assert.equal(review({ ...base, recipe: { supported: false, why: '带签名' }, mine: [], stats: {} }).verdict.level, 'watch');
  const r = review({ ...base, stats: { aiCallers: 30, ratio: 0.9, last10: 12, prev10: 5 } });
  assert.match(r.explain, /NFT/); assert.match(r.oneLine, /免费/); assert.ok(r.howTo.length >= 2);
});

test('核验依据：模拟通过 / 链上读取 / 源码 / 未核验分别标注，已铸造的价格标「实际成功」', () => {
  const base = { kind: 'nft-mint', cls: { kind: 'nft-mint', valueWei: 0n, perCall: 1n, std: '721' }, profile: { totalSupply: 100n, maxSupply: 5000n, symbol: 'X' }, src: { verified: true, risks: [] },
    aiOnly: { state: 'verified' }, recipe: { supported: true, selector: '0xa0712d68', qtyWord: null }, mine: [{ slot: 1, ok: true, valueWei: '0' }], stats: {} };
  const e = review(base).evidence;
  assert.equal(e.price.level, 'sim'); assert.equal(e.gate.level, 'sim'); assert.equal(e.supply.level, 'chain'); assert.equal(e.source.level, 'source');
  assert.equal(review({ ...base, historyNft: 2 }).evidence.price.level, 'done');
  const e2 = review({ ...base, mine: [], aiOnly: { state: 'unknown' }, src: { verified: false }, cls: { kind: 'nft-mint', perCall: 1n } }).evidence;
  assert.equal(e2.price.level, 'none'); assert.equal(e2.gate.level, 'none'); assert.equal(e2.source.level, 'none'); assert.equal(e2.source.k, 'ev.src.closed');
  assert.equal(review({ ...base, mine: [], aiOnly: { state: 'likely' }, src: { verified: true, agentGate: true } }).evidence.gate.level, 'source');
  assert.equal(review({ ...base, mine: [] }).evidence.price.level, 'chain', '只有他人成功调用时是链上读取');
  for (const x of Object.values(e)) assert.ok(DICTS.zh[x.k] && DICTS.en[x.k], `说明文案键 ${x.k} 两份字典都要有`);
});

test('供应事实：已铸数读不到（只知道总量）时不出现 undefined / NaN', () => {
  const base = { kind: 'nft-mint', cls: { kind: 'nft-mint', valueWei: 0n, perCall: 1n }, profile: { maxSupply: '7777' }, src: {}, aiOnly: { state: 'open' }, fn: 'mint(uint256)', recipe: { supported: true, selector: '0xa0712d68', qtyWord: null }, mine: [], stats: {} };
  const rv = review(base);
  assert.doesNotMatch(JSON.stringify(rv), /undefined|NaN/, '结论的所有文字里都不能有 undefined / NaN');
  const sup = rv.facts.find(([k]) => k === '供应')?.[1] || '';
  assert.doesNotMatch(sup, /undefined|NaN/); assert.match(sup, /7,?777/);
  const known = review({ ...base, profile: { maxSupply: '7777', totalSupply: '1000' } }).facts.find(([k]) => k === '供应')[1];
  assert.match(known, /12\.9%/);
});

test('chain：克隆合约解析实现地址；按操作码扫选择器（跳过 PUSH 数据）', () => {
  const impl = 'ab'.repeat(20);
  assert.equal(cloneImpl(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`), '0x' + impl);
  assert.equal(cloneImpl('0x6080'), null);
  // PUSH4 a0712d68，然后 PUSH5 里藏着 63 xxxxxxxx 不应被当成选择器
  const sels = codeSelectors('0x63a0712d686463deadbeef00');
  assert.ok(sels.has('0xa0712d68')); assert.equal(sels.has('0xdeadbeef'), false);
});

import { priority } from './score.js';
import { utilities } from './utility.js';
import { dataUri, gatewayUrl, imageUrl } from './meta.js';

test('优先级：免费 + Agent 专属 + 能一键 + 热 → 优先；暂停 / 不能参与 → 靠后；每一分都有理由', () => {
  const good = { review: { canDo: true, needWei: '0' }, aiOnly: { state: 'verified' }, cls: { kind: 'nft-mint' }, recipe: { supported: true }, profile: { totalSupply: '300', maxSupply: '5000' }, src: { verified: true, risks: [] }, project: { links: ['https://x.com/proj'], description: 'x' }, utility: { list: [{ tag: '领奖励', src: 'contract' }] }, social: { count: 12 } };
  const p = priority(good, { aiCallers: 20, last10: 10, prev10: 4 });
  assert.equal(p.level, 'high'); assert.ok(p.score >= 70);
  assert.ok(p.parts.every((x) => typeof x.why === 'string' && x.why.length > 0));
  const bad = priority({ ...good, review: { canDo: false, needWei: null }, recipe: { supported: false, why: '带签名' }, profile: { ...good.profile, paused: true } }, { aiCallers: 2, last10: 0 });
  assert.equal(bad.level, 'low');
  assert.ok(bad.parts.some((x) => /暂停/.test(x.why)));
});

test('用途：合约里有的函数 → 确认的用途；只在说明里提到 → 标出来；什么都没有 → 纯收藏', () => {
  const abi = [{ type: 'function', name: 'claimRewards', stateMutability: 'nonpayable' }, { type: 'function', name: 'renewCard', stateMutability: 'payable' }, { type: 'function', name: 'pendingRewards', stateMutability: 'view' }];
  const u = utilities({ abi, text: 'blind-box mining card game' });
  assert.ok(u.list.some((x) => x.tag === '领奖励' && x.src === 'contract'));
  assert.ok(u.list.some((x) => x.tag === '有效期'));
  assert.ok(u.list.some((x) => x.src === 'text'), '说明里的挖矿 / 盲盒');
  assert.match(utilities({ abi: [], text: 'Collectibles only, not an investment.' }).summary, /纯收藏/);
  assert.match(utilities({ abi: [], text: 'share of the daily BNB distribution' }).summary, /分红/);
});

test('元数据：data:/ipfs:/ar: 解析，图片过大的 data URI 不返回', () => {
  assert.deepEqual(dataUri('data:application/json;base64,' + Buffer.from('{"a":1}').toString('base64')), { type: 'application/json', text: '{"a":1}' });
  assert.equal(dataUri('data:application/json,%7B%22b%22%3A2%7D').text, '{"b":2}');
  // 网关来自 endpoints.js（开源版没配置时为空，读不了就返回 null）
  const gw = EP.ipfs.filter((u) => !/mypinata/.test(u))[0];
  assert.equal(gatewayUrl('ipfs://bafyX/1.json'), gw ? gw + 'bafyX/1.json' : null);
  assert.equal(gatewayUrl('ar://abc'), EP.arweave ? EP.arweave + 'abc' : null);
  assert.equal(gatewayUrl('http://insecure'), null);
  assert.equal(imageUrl('data:image/svg+xml;base64,' + 'A'.repeat(300_000)), null);
});

import { recommendation, REC_MIN_SCORE, priority as prio } from './score.js';

test('推荐资格：分数 ≥50 + 未冷却 + 未结束；68 只是档位，不是第二套门槛', () => {
  const base = {
    review: { canDo: true, needWei: '0', verdict: { level: 'go', label: '值得一试', why: 'x' } },
    aiOnly: { state: 'verified' }, cls: { kind: 'nft-mint', valueWei: '0' }, recipe: { supported: true },
    profile: { totalSupply: '300', maxSupply: '5000' }, src: { verified: true, risks: [] },
    project: { links: ['https://x.com/p', 'https://p.xyz'], description: 'x' },
    utility: { list: [{ tag: '领奖励', src: 'contract' }] }, social: { enabled: true, count: 20 },
  };
  const hot = recommendation(base, { aiCallers: 30, last10: 12, prev10: 4 }, 'hot');
  assert.equal(hot.rec, true);
  assert.ok(hot.priority.score >= 68);
  const thin = { ...base, project: { links: [] }, utility: { list: [] }, social: { enabled: true, count: 0 }, aiOnly: { state: 'open' }, src: { verified: false, risks: [] } };
  const t = recommendation(thin, { aiCallers: 0, last10: 0 }, 'new');
  assert.equal(t.priority.score < REC_MIN_SCORE, true);
  assert.equal(t.rec, false);
  assert.equal(recommendation({ ...base }, { aiCallers: 30 }, 'cool').rec, false, '冷却不算推荐');
  assert.equal(recommendation({ ...base, review: { ...base.review, verdict: { level: 'skip' } } }, { aiCallers: 30 }, 'new').rec, false, '已结束不算推荐');
  assert.equal(recommendation(null, {}, 'new').rec, false, '没分析不算');
  // 边界：rec 与「分数 ≥ 50」严格一致
  for (const ai of [0, 4, 8, 12, 16, 20, 24]) {
    const { rec, priority: p } = recommendation(base, { aiCallers: ai, last10: 0 }, 'new');
    assert.equal(rec, p.score >= REC_MIN_SCORE, `ai=${ai}`);
  }
});

import { classifyMintFailure } from './review.js';

test('模拟失败分类：已经铸过 / 已达上限 / 售罄不是失败；余额不足等才算', () => {
  assert.equal(classifyMintFailure('FreeAlreadyClaimed'), 'wallet-limit');
  assert.equal(classifyMintFailure('AlreadyMinted'), 'wallet-limit');
  assert.equal(classifyMintFailure('ExceedMaxPerWallet'), 'wallet-limit');
  assert.equal(classifyMintFailure('MaxSupplyReached'), 'sold-out');
  assert.equal(classifyMintFailure('SoldOut'), 'sold-out');
  assert.equal(classifyMintFailure('insufficient funds'), null);
  assert.equal(classifyMintFailure('execution reverted'), null);
  assert.equal(classifyMintFailure(''), null);
});

test('已经铸过：结论为「已铸造」、不扣分、不再进入推荐、不再显示成预检失败', () => {
  const base = {
    kind: 'nft-mint', cls: { kind: 'nft-mint', valueWei: '0', perCall: 1n, std: '721' },
    profile: { totalSupply: '3436n', maxSupply: '10500n', perWallet: '10', symbol: 'SCPASS' },
    src: { verified: true, risks: [] }, aiOnly: { state: 'verified' }, recipe: { supported: true, selector: '0xa0712d68', qtyWord: null },
    mine: [{ slot: 1, ok: false, reason: 'FreeAlreadyClaimed', friendly: '本钱包已铸造过或已达上限' }],
    mineExhausted: true, historyNft: 1, stats: { aiCallers: 30, last10: 10, prev10: 4 },
  };
  const r = review(base);
  assert.equal(r.verdict.level, 'done');
  assert.match(r.verdict.why, /1 个/);
  assert.match(r.explain, /已铸造过/);
  assert.doesNotMatch(r.explain, /NaN|undefined/);
  assert.equal(r.cons.some((c) => /模拟未通过|模拟没通过/.test(c)), false, '不再显示成预检失败');
  assert.equal(recommendation(base, base.stats, 'new').rec, false, '已铸造过的不再推荐');
});

test('英文界面：简介、风险提示、评分依据、用途都有英文；中文结果不变', () => {
  const CJK = /[\u4e00-\u9fff]/;
  const base = { kind: 'nft-mint', cls: { kind: 'nft-mint', valueWei: 0n, perCall: 1n, std: '721', gasWei: 10n ** 14n }, profile: { totalSupply: 4000n, maxSupply: 5000n, perWallet: '3', symbol: 'X', proxy: { kind: '可升级代理（EIP-1967）' } },
    src: { verified: false, risks: [{ label: '可以拉黑地址', level: 2, fn: 'setBlacklist' }] }, aiOnly: { state: 'likely', why: '合约中包含 Agent ID 校验', k: 'ai.check' },
    recipe: { supported: false, why: '调用参数含名单证明', whyK: 'rc.proof' }, mine: [{ slot: 1, ok: false, reason: '余额不够' }], stats: { aiCallers: 12 },
    creator: { address: '0x' + '44'.repeat(20), name: 'maker.ai', others: [1, 2, 3, 4, 5] }, family: { count: 3 },
    utility: utilities({ abi: [{ type: 'function', name: 'stake', stateMutability: 'nonpayable' }], text: 'airdrop for holders' }) };
  const zh = review(base), en = review(base, 'en');
  assert.match(zh.explain, /是一个/); assert.ok(zh.cons.some((c) => /管理员可以拉黑地址/.test(c)));
  assert.ok(!CJK.test(en.explain), en.explain); for (const c of en.cons) assert.ok(!CJK.test(c), c);
  assert.ok(en.cons.some((c) => /Admin can blacklist addresses/.test(c)));
  assert.equal(zh.vals.perWallet, 3); assert.equal(zh.vals.supply.max, 5000);
  assert.ok(!CJK.test(summarize(base.utility.list, 'en')));
  // 评分依据：每条都有文案键，两份字典都有
  const pr = priority({ ...base, review: zh, project: { links: ['https://x.com/a', 'https://a.xyz'], description: 'x' }, social: { enabled: true, count: 6 } }, base.stats);
  for (const x of pr.parts) { assert.ok(x.k && DICTS.zh[x.k] && DICTS.en[x.k], x.k); assert.equal(x.why, DICTS.zh[x.k].replace(/\{(\w+)\}/g, (m, k) => x.p?.[k] ?? m)); }
  // 源码风险项、用途都有编号和英文
  for (const [, label] of RISKY) { const id = RISK_ID[label]; assert.ok(id && DICTS.en['risk.' + id], label); }
  for (const u of base.utility.list) assert.ok(u.id && DICTS.en['ut.' + u.id], u.tag);
});
