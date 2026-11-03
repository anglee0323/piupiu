// 「这个 NFT 有什么用」：看合约里实际有哪些可调用的函数（已验证源码的 ABI；没有源码就按代码里的选择器），
// 再结合项目方的说明 / 元数据描述里的关键词。只列能从合约本身确认的用途，说明里写了但合约里没有的标「说明里提到」。
import { ethers } from 'ethers';
import { translate } from '../../../shared/i18n/index.js';

// [函数名正则, 编号（文案键 ut.<编号>）, 用途, 说明]
const FN = [
  [/^(stake|stakecard|stakenft|deposit(nft)?|lock)$/i, 'stake', '质押', '可将 NFT 质押到合约中'],
  [/^(claimrewards?|harvest|claimmining|claimyield|withdrawrewards?)$/i, 'rewards', '领奖励', '持有或质押后可领取奖励'],
  [/^(pendingrewards?|earned|pendingcardrewards|userminingrate)/i, 'yield', '挖矿收益', '合约按时间累积收益'],
  [/^(renew|renewcard|extend)/i, 'renew', '有效期', 'NFT 有有效期，过期需续费'],
  [/^(hatch|evolve|levelup|upgrade(card|nft)?|breed|fuse|merge|combine|forge|craft)$/i, 'evolve', '养成 / 合成', '可孵化、升级或合成'],
  [/^(battle|attack|fight|duel|raid|play|spin|roll|gamble|flip|open(box|pack)?|reveal)$/i, 'game', '游戏 / 盲盒', '包含游戏或开盒玩法'],
  [/^(burn|redeem|burnfor|exchange)/i, 'redeem', '可兑换', '可销毁兑换其他资产'],
  [/^(vote|propose|delegate)/i, 'vote', '投票', '持有者可参与投票'],
  [/^(claim|claimairdrop|claimtoken)$/i, 'airdrop', '持有可领币', '持有者可领取代币 / 空投'],
  [/^(buyhammer|buyitem|buy(tool|pickaxe|item))/i, 'items', '道具', '游戏内需另行购买道具'],
];
// 说明 / 描述里的关键词（合约里查不到时作为「说明里提到」）
const KW = [
  [/mining|mine|miner|挖矿/i, 'yield', '挖矿收益'], [/stak(e|ing)|质押/i, 'stake', '质押'], [/game|battle|play|游戏/i, 'game', '游戏 / 盲盒'], [/blind.?box|盲盒/i, 'game', '游戏 / 盲盒'],
  [/dividend|revenue share|daily (bnb )?(distribution|allocation)|share of .*(fee|revenue|sales)|分红|收益分配|每日.*分配/i, 'dividend', '分红 / 收益分配'],
  [/airdrop|空投/i, 'airdrop', '持有可领币'], [/whitelist|白名单|allowlist/i, 'whitelist', '白名单资格'], [/membership|access|pass|会员|通行证/i, 'member', '会员 / 通行'],
  [/buyback|回购/i, 'buyback', '回购'], [/collectib|收藏|art|pfp|头像/i, 'collect', '收藏 / 头像'], [/not an investment|不可投资|no utility|仅供收藏/i, 'pure', '纯收藏（项目方声明无投资属性）'],
];

/** abi：已验证源码的 ABI；sels：代码里的选择器（没源码时用）；text：说明 + 元数据描述 */
export function utilities({ abi, sels, text }) {
  const out = new Map();
  const names = [];
  if (Array.isArray(abi)) for (const f of abi) if (f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure') names.push(f.name);
  for (const n of names) for (const [re, id, tag, why] of FN) if (re.test(n) && !out.has(tag)) out.set(tag, { id, tag, why, fn: n, src: 'contract' });
  if (!names.length && sels?.size) {
    const guess = ['stake(uint256)', 'claimRewards()', 'pendingRewards(address)', 'renew(uint256)', 'hatch(uint256)', 'evolve(uint256)', 'battle(uint256)', 'burn(uint256)', 'reveal()', 'claim()'];
    for (const sig of guess) if (sels.has(ethers.id(sig).slice(0, 10))) { const n = sig.replace(/\(.*/, ''); for (const [re, id, tag, why] of FN) if (re.test(n) && !out.has(tag)) out.set(tag, { id, tag, why, fn: n, src: 'contract' }); }
  }
  for (const [re, id, tag] of KW) if (re.test(String(text || '')) && !out.has(tag)) out.set(tag, { id, tag, why: '项目说明里提到', src: 'text' });
  const list = [...out.values()];
  return { list, summary: summarize(list) };
}

/** 一句话用途（按语言）：合约里确认的用途优先（最多 2 个）；没有才用说明里提到的；「收藏 / 头像」只在没有别的用途时出现；项目方声明纯收藏的要说出来。
 *  旧分析里的条目没有编号，按中文用途名判断、原样显示 */
export function summarize(list, lang = 'zh') {
  const L = (k) => translate(lang, k);
  const tag = (x) => (x.id && lang !== 'zh' ? L('ut.' + x.id) : x.tag);
  const declaredPure = list.some((x) => /纯收藏/.test(x.tag));
  const real = list.filter((x) => x.src === 'contract' && !/收藏/.test(x.tag)).map(tag);
  const said = list.filter((x) => x.src === 'text' && !/收藏/.test(x.tag)).map(tag);
  if (real.length) return real.slice(0, 2).join(' · ') + (declaredPure ? L('ut.sumPureTail') : '');
  if (declaredPure) return L('ut.sumPure');
  if (said.length) return said.slice(0, 2).join(' · ') + L('ut.sumSaid');
  return list.length ? L('ut.sumCollect') : L('ut.sumNone');
}
