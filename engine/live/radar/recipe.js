// 参与配方（方案 R4，比方案里的「只认 mint()/mint(uint256)」更通用）：照抄 .ai 钱包成功调用的参数。
// 做法：把参数里出现的调用者地址换成占位符，比较多笔成功调用——
//   完全相同 → 可以照抄（换成你的钱包地址）
//   只有一个小整数不同 → 当作「数量」参数，让你选
//   其他情况（每个人参数都不一样：多半带服务器签名 / 个性化证明）→ 不支持一键，并按参数形状区分：签名 / 名单证明 / 时间戳 / 其他
// 付多少：观察到的金额里从小到大挨个用你的钱包模拟，第一个能通过的就是你要付的（免费名额还在就是 0）。
// 纯函数 + 一个模拟函数（eth_call，不发交易）。
import { ethers } from 'ethers';

const lc = (a) => String(a || '').toLowerCase();
const CALLER = 'c0ffee'.repeat(6) + 'c0ffee00';   // 40 位占位符（不会和真实地址撞）
const pad = (a) => '000000000000000000000000' + lc(a).replace(/^0x/, '');

export function normalize(input, from) {
  const raw = lc(input); const me = lc(from).replace(/^0x/, '');
  if (!me) return raw;
  return raw.split(pad(from)).join('000000000000000000000000' + CALLER).split(me).join(CALLER);
}
const words = (hex) => { const body = hex.slice(10); if (body.length % 64) return null; const out = []; for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64)); return out; };

// 不能照抄时判断是哪一类机制：签名白名单 / 名单证明（Merkle proof）/ 时间戳 / 随机数；只看参数的形状，不预测合约逻辑
const HASHY = 1n << 192n;
const big = (w) => BigInt('0x' + w);
function dynamicKind(ws) {
  const ptr = (i) => ws.slice(0, i).some((w) => big(w) === BigInt(i * 32));   // 前面有一个指向这里的偏移量
  for (let i = 1; i < ws.length; i++) {
    const n = big(ws[i]);
    if (n === 65n && i + 2 < ws.length && ptr(i) && big(ws[i + 1]) >= HASHY && big(ws[i + 2]) >= HASHY) return 'signature';
    if (n >= 1n && n <= 40n && i + Number(n) < ws.length && ptr(i) && ws.slice(i + 1, i + 1 + Number(n)).every((w) => big(w) >= HASHY)) return 'proof';
  }
  return null;
}
// why 是中文原文；whyK / whyP 是文案键和参数（网页按当前语言显示）
const MECH_WHY = {
  signature: '调用参数含项目方后台签发的签名，每个钱包各不相同，无法按他人的调用复用',
  proof: '调用参数含名单证明（Merkle proof），须由项目方按钱包地址提供，无法按他人的调用复用',
  timestamp: '调用参数含时间戳或有效期，每次均不相同，无法按他人的调用复用',
};
function diagnose(norms, ws, diff) {
  const kinds = norms.map((n) => { const w = words(n); return w ? dynamicKind(w) : null; });
  const dyn = kinds.find(Boolean);
  if (dyn) return { mech: dyn, why: MECH_WHY[dyn], whyK: 'rc.' + dyn };
  if (diff?.length === 1 && ws.every((w) => { const n = big(w[diff[0]]); return (n >= 1500000000n && n <= 4200000000n) || (n >= 1500000000000n && n <= 4200000000000n); })) return { mech: 'timestamp', why: MECH_WHY.timestamp, whyK: 'rc.timestamp' };
  if (!ws) return { mech: 'unknown', why: '各钱包的调用参数长度不一，通常带有签名或名单证明，无法按他人的调用复用', whyK: 'rc.lenDiff' };
  return { mech: 'unknown', why: `各钱包的调用参数中有 ${diff.length} 项不同（可能为签名、随机数或个性化证明），无法按他人的调用复用`, whyK: 'rc.diff', whyP: { n: diff.length } };
}

/** samples：[{ from, input, value }]（只放 .ai 钱包成功的调用，新的在前）；返回配方或不支持的原因 */
export function deriveRecipe(samples) {
  const ok = samples.filter((s) => s?.input && s.input.length >= 10);
  if (ok.length < 2) return { supported: false, why: '成功调用样本太少（至少要 2 笔），再等一会', whyK: 'rc.few' };
  const bySel = new Map(); for (const s of ok) { const k = s.input.slice(0, 10).toLowerCase(); bySel.set(k, [...(bySel.get(k) || []), s]); }
  const [selector, group] = [...bySel.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (group.length < 2) return { supported: false, why: '大家调用的函数不一样，看不出固定玩法', whyK: 'rc.mixed', selector };
  const norms = group.map((s) => normalize(s.input, s.from));
  const values = [...new Set(group.map((s) => BigInt(s.value || 0)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const base = { selector, samples: group.length, values: values.map(String) };
  if (norms.every((n) => n === norms[0])) return { ...base, supported: true, template: norms[0], qtyWord: null, usesCaller: norms[0].includes(CALLER) };
  const ws = norms.map(words);
  if (ws.some((w) => !w) || ws.some((w) => w.length !== ws[0].length)) return { ...base, supported: false, ...diagnose(norms, null, null) };
  const diff = []; for (let i = 0; i < ws[0].length; i++) if (ws.some((w) => w[i] !== ws[0][i])) diff.push(i);
  const nums = (i) => ws.map((w) => BigInt('0x' + w[i]));
  if (diff.length === 1 && nums(diff[0]).every((n) => n > 0n && n <= 1000n)) {
    const q = nums(diff[0]);
    const tmpl = '0x' + norms[0].slice(2, 10) + ws[0].map((w, i) => (i === diff[0] ? 'QTY'.padEnd(64, '_') : w)).join('');
    // 金额和数量成正比 → 单价；否则按观察到的金额挨个试
    const unit = group.map((s, i) => (q[i] ? BigInt(s.value || 0) / q[i] : 0n));
    const perUnit = unit.every((u) => u === unit[0]) && group.every((s, i) => BigInt(s.value || 0) === unit[0] * q[i]);
    return { ...base, supported: true, template: tmpl, qtyWord: diff[0], qtySeen: [...new Set(q.map(Number))].sort((a, b) => a - b), unitWei: perUnit ? String(unit[0]) : null, usesCaller: tmpl.includes(CALLER) };
  }
  return { ...base, supported: false, ...diagnose(norms, ws, diff) };
}

/** 用配方生成某个钱包的调用数据 */
export function build(recipe, wallet, qty = 1) {
  let d = recipe.template.split(CALLER).join(lc(wallet).replace(/^0x/, ''));
  if (recipe.qtyWord != null) d = d.replace('QTY'.padEnd(64, '_'), BigInt(Math.max(1, Math.floor(qty))).toString(16).padStart(64, '0'));
  return d;
}

/** 这个钱包要付多少可以试：单价 × 数量，或者观察到的金额从小到大（0 永远先试：免费名额） */
export function valueCandidates(recipe, qty = 1) {
  if (recipe.unitWei != null) return [BigInt(recipe.unitWei) * BigInt(Math.max(1, qty))];
  return [...new Set([0n, ...recipe.values.map((v) => BigInt(v))])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 6);
}

/** 从 ethers 的错误里挖出回滚数据 */
export function revertData(e) {
  const c = [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data];
  for (const x of c) if (typeof x === 'string' && /^0x[0-9a-f]*$/i.test(x)) return x;
  const m = /(0x[0-9a-f]{8,})/i.exec(String(e?.info?.error?.message || e?.shortMessage || e?.message || ''));
  return m ? m[1] : null;
}

/** eth_call 模拟；override：给这个地址临时加余额（只在「随机普通地址」对比时用，你的钱包按真实余额模拟） */
export async function simulate(provider, { from, to, data, value = 0n, override = false }) {
  const tx = { from, to, data, value: ethers.toQuantity(value) };
  try {
    const params = override ? [tx, 'latest', { [from]: { balance: '0x56bc75e2d63100000' } }] : [tx, 'latest'];
    const ret = await provider.send('eth_call', params);
    let gas = null; try { gas = await provider.estimateGas({ from, to, data, value }); } catch { /* 估不出不影响结论 */ }
    return { ok: true, ret, gas: gas != null ? String(gas) : null };
  } catch (e) {
    const msg = String(e?.info?.error?.message || e?.shortMessage || e?.message || '');
    if (override && /override|unsupported|invalid.*param/i.test(msg)) return { ok: false, unsupported: true, reason: '节点不支持临时余额' };
    if (/insufficient funds/i.test(msg)) return { ok: false, funds: true, reason: '余额不够' };
    return { ok: false, data: revertData(e), reason: msg.slice(0, 160) };
  }
}

export const randomAddr = () => ethers.Wallet.createRandom().address.toLowerCase();
