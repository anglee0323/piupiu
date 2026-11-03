// 优先级评分（0–100）：告诉用户「先看哪个」。每一项加减分都有中文理由，页面上能展开看。
// 只用确定的事实：门槛、成本、你能不能参与、热度、供应、项目信息完整度、讨论度、风险。不预测价格。
import { supplyOf } from './review.js';
import { translate } from '../../../shared/i18n/index.js';
import { riskId } from '../../../shared/radarLabels.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const REC_MIN_SCORE = 50;   // 进入「推荐」列表的最低分（声音、未读、列表共用这一条）
/** 推荐资格：分析完成 + 分数够 + 仍在活跃 + 未结束。68 分只是「优先」档位，不是另一套推荐门槛 */
export function recommendation(an, stats, state) {
  if (!an || !an.review) return { rec: false, priority: null };
  const p = priority(an, stats || {});
  // 已经铸过 / 已达上限的项目不再推荐（避免把「已铸造」推成新机会）
  const rec = p.score >= REC_MIN_SCORE && state !== 'cool' && an.review.verdict?.level !== 'skip' && !an.mineExhausted;
  return { rec, priority: p };
}

/** an：analyze() 的结果；stats：当前窗口统计。
 *  每条加减分带文案键 k（和参数 p）：why 仍是中文原文（列表、日志、旧代码按它判断），网页按当前语言用 k / p 显示 */
export function priority(an, stats = {}) {
  const parts = [];
  const add = (pts, k, p) => { if (pts) parts.push({ pts: Math.round(pts), why: translate('zh', k, p), k, ...(p ? { p } : {}) }); };
  const r = an?.review || {};
  const need = r.needWei != null ? BigInt(r.needWei) : an?.cls?.valueWei != null ? BigInt(an.cls.valueWei) : null;
  const gate = an?.aiOnly?.state;
  const kind = an?.cls?.kind;
  // 能不能参与（没法参与的再好也只能看）
  if (r.canDo) add(10, 'rs.oneClick');
  else if (an?.recipe && !an.recipe.supported) add(-15, 'rs.noOneClick');
  else if (an?.mineExhausted) add(0, 'rs.minted');
  else if ((an?.mine || []).length && (an.mine || []).some((m) => !m.ok && !m.friendly)) add(-15, 'rs.precheckFail');
  // 门槛：只有 .ai 能参与 = 参与者少
  if (gate === 'verified') add(10, 'rs.aiOnly');
  else if (gate === 'likely') add(5, 'rs.aiLikely');
  else if (gate === 'open') add(-5, 'rs.open');
  // 成本
  if (need === 0n) add(10, 'rs.free');
  else if (need != null && need <= 5n * 10n ** 15n) add(6, 'rs.costVeryLow');
  else if (need != null && need <= 2n * 10n ** 16n) add(3, 'rs.costLow');
  else if (need != null) add(-6, 'rs.costHigh');
  // 热度：.ai 参与人数 + 是否在加速
  const ai = stats.aiCallers || 0;
  add(clamp(ai * 0.5, 0, 12), 'rs.heat', { n: ai });
  if ((stats.prev10 || 0) > 0 && (stats.last10 || 0) >= stats.prev10 * 1.5 && (stats.last10 || 0) >= 4) add(4, 'rs.rising');
  else if ((stats.last10 || 0) === 0 && ai > 0) add(-6, 'rs.stalled');
  // 供应：总量小更稀缺；快铸完了来不及
  const sup = supplyOf(an?.profile || {});
  if (sup.max && sup.max <= 1000) add(5, 'rs.rare', { n: sup.max.toLocaleString() });
  else if (sup.max && sup.max <= 3000) add(2, 'rs.small', { n: sup.max.toLocaleString() });
  if (sup.pct != null && sup.pct >= 95) add(-12, 'rs.almostOut');
  else if (sup.pct != null && sup.pct >= 10 && sup.pct < 80) add(3, 'rs.left', { p: sup.pct.toFixed(0) });
  // 项目信息：有官网 / 推特 / 描述 / 用途，说明不是随手发的
  const links = an?.project?.links || [];
  if (links.some((u) => /x\.com|twitter\.com/i.test(u)) || an?.social?.official) add(7, 'rs.x');
  else add(-4, 'rs.noX');
  if (links.some((u) => !/x\.com|twitter\.com|t\.me|discord/i.test(u))) add(5, 'rs.site');
  if (an?.project?.description || an?.noticeZh) add(2, 'rs.desc');
  const util = an?.utility?.list || [];
  const useful = util.filter((u) => u.src === 'contract' && !/收藏/.test(u.tag));
  if (useful.length) add(7, 'rs.util', { tags: useful.map((u) => u.tag).slice(0, 2).join('、'), ids: useful.map((u) => u.id || '').slice(0, 2).join(',') });
  if (util.some((u) => /纯收藏/.test(u.tag))) add(-3, 'rs.pure');
  // 讨论度
  const s = an?.social;
  if (s?.count >= 15) add(8, 'rs.talk', { n: s.count });
  else if (s?.count >= 5) add(5, 'rs.talk', { n: s.count });
  else if (s?.count >= 1) add(2, 'rs.talk', { n: s.count });
  else if (s?.enabled && !s.error) add(-3, 'rs.noTalk');
  // 风险
  if (an?.src?.verified) add(2, 'rs.src');
  else if (an?.src?.verified === false) add(-6, 'rs.noSrc');
  for (const x of an?.src?.risks || []) if (x.level >= 2) add(-8, 'rs.admin', { label: x.label, id: riskId(x.label) });
  if (an?.profile?.proxy?.kind?.includes('升级')) add(-8, 'rs.upgradeable');
  if ((an?.creator?.others?.length || 0) >= 5) add(-6, 'rs.batch', { n: an.creator.others.length + 1 });
  if (an?.profile?.paused === true) add(-40, 'rs.paused');
  if (kind === 'buy' || kind === 'sell') add(-10, 'rs.trade');
  // 20 分起步。「免费 + Agent 专属 + 能一键」只到 50 分左右（今天这种合集一出就是几十个）；要进「优先」还得有推特 / 官网 / 实际用途 / 讨论度这些项目实质
  const total = clamp(Math.round(20 + parts.reduce((s2, p) => s2 + p.pts, 0)), 0, 100);
  const level = total >= 68 ? 'high' : total >= 50 ? 'mid' : 'low';
  return { score: total, level, label: { high: '优先', mid: '可关注', low: '一般' }[level], parts: parts.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)) };
}
