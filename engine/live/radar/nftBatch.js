// NFT 批量转出（Gateway）：一次点击转出同一合集的多个 NFT 到「NFT 转出地址」。
// 两步，中间必须有人确认：
//   preview：逐个预检（链上模拟 + 币安钱包预演，不发交易），汇总成一个批次返回给入口（网页 / 以后的 Telegram）展示；
//   submit：用户确认后按批次逐个提交，遇到第一个失败就停（后面的不再发），批次只能提交一次。
// 以前这段流程写在网页里（web/src/lib/nftTransfer.ts），换入口就得重写；现在入口只负责「展示 + 确认」。
import { randomBytes } from 'node:crypto';

export const MAX_PER_BATCH = 10;   // 一次最多转 10 个（每个都是一笔链上交易）

/**
 * part：radar/participate.js 的实例（transferPreview / transferSubmit，单个 NFT 的预检与提交）
 * getDest()：当前保存的 NFT 转出地址
 */
export function createNftBatch({ part, getDest, now = () => Date.now() }) {
  const batches = new Map();

  async function preview({ address, items }) {
    const dest = getDest();
    if (!dest) throw new Error('还没有设置 NFT 转出地址：先填一次收款钱包地址（比如你的 OKX 钱包）');
    const list = (Array.isArray(items) ? items : [])
      .map((x) => ({ slot: Number(x?.slot), tokenId: String(x?.tokenId ?? x?.id ?? '') }))
      .filter((x) => Number.isInteger(x.slot) && x.slot > 0 && /^\d+$/.test(x.tokenId));
    if (!list.length) throw new Error('没有要转出的 NFT');
    const pick = list.slice(0, MAX_PER_BATCH);
    const rows = [];
    for (const it of pick) {
      // 有一个预检不过就整批不过：批次里的都能转才让用户确认
      const p = await part.transferPreview({ address, slot: it.slot, tokenId: it.tokenId });
      rows.push({ slot: it.slot, tokenId: p.tokenId ?? it.tokenId, previewId: p.previewId, expiresAt: p.expiresAt, risks: p.risks || [], needAppConfirm: !!p.needAppConfirm, to: p.to });
    }
    for (const [k, b] of batches) if (now() > b.expiresAt) batches.delete(k);   // 顺手清掉过期的
    const batchId = 'b' + randomBytes(6).toString('hex');
    const expiresAt = Math.min(...rows.map((r) => r.expiresAt || now() + 60_000));
    batches.set(batchId, { address: String(address).toLowerCase(), rows, expiresAt });
    return {
      batchId, expiresAt, dest: rows[0]?.to || dest,
      rows: rows.map(({ previewId, ...r }) => r),   // previewId 留在 Gateway 里，入口只拿批次号
      risks: [...new Set(rows.flatMap((r) => r.risks))],
      needAppConfirm: rows.some((r) => r.needAppConfirm),
      skipped: list.length - pick.length,           // 超过上限没放进这批的个数（再点一次转剩下的）
    };
  }

  async function submit({ batchId }) {
    const b = batches.get(String(batchId || ''));
    if (!b) throw new Error('预检已失效，请重新检查');
    batches.delete(String(batchId));   // 只能提交一次
    if (now() > b.expiresAt) throw new Error('预检超过 60 秒已过期，请重新检查');
    const results = [];
    for (const r of b.rows) {
      try { await part.transferSubmit({ previewId: r.previewId }); results.push({ tokenId: r.tokenId, slot: r.slot, ok: true }); }
      catch (e) { results.push({ tokenId: r.tokenId, slot: r.slot, ok: false, error: e.message }); break; }
    }
    const sent = results.filter((x) => x.ok).length;
    return { sent, total: b.rows.length, failed: results.find((x) => !x.ok) || null, results };
  }

  return { preview, submit };
}
