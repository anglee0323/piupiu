// 雷达铸造 / 转出历史：从 data/radar/mints.jsonl 恢复最终状态。
// 日志是追加写的，每次状态变化一行；同一个 id 只保留最后一次有效状态（后面一行坏数据不能把前面的成功记录顶掉）。
// 失败尝试、成功铸造、转出分开统计：成功铸造的「笔数」不等于铸到的 NFT「数量」（一笔可能铸 5 个）。
import { readFileSync } from 'node:fs';

const lc = (a) => String(a || '').toLowerCase();
export const isAddress = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
const STATUS = new Set(['sending', 'broadcast', 'done', 'done-nothing', 'failed', 'unknown', 'unconfirmed', 'app-confirm', 'transferred']);

/** 逐行容错读取，按 id 去重，按时间倒序 */
export function readMintHistory(file, limit = 5000) {
  let text; try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.id || !isAddress(r.address)) continue;
    const ts = Number(r.ts); if (!Number.isFinite(ts) || ts <= 0) continue;
    const prev = byId.get(r.id);
    if (prev && prev.status === 'done' && r.status === 'sending') continue;   // 日志顺序异常时不让成功记录退回发送中
    byId.set(r.id, { ...r, address: lc(r.address), ts, kind: r.kind === 'transfer' ? 'transfer' : 'mint', status: STATUS.has(r.status) ? r.status : 'unknown' });
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** 一笔记录铸到几个 NFT（721 每个算 1，1155 按数量，代币不算） */
export function nftCount(rec) {
  if (!rec || rec.kind === 'transfer' || rec.status !== 'done') return 0;
  return (rec.got || []).reduce((s, g) => s + (g?.std === '721' ? 1 : g?.std === '1155' ? Number(g.amount) || 0 : 0), 0);
}

/** 按地址汇总：成功铸造笔数、NFT 个数、转出笔数、失败次数、最近时间 */
export function summarize(records) {
  const m = new Map();
  for (const r of records) {
    let s = m.get(r.address);
    if (!s) { s = { address: r.address, symbol: r.symbol || null, mintTx: 0, nft: 0, transfers: 0, failed: 0, lastAt: 0 }; m.set(r.address, s); }
    if (r.symbol && !s.symbol) s.symbol = r.symbol;
    s.lastAt = Math.max(s.lastAt, r.ts);
    if (r.kind === 'transfer') { if (r.status === 'transferred') s.transfers++; continue; }
    if (r.status === 'done') { s.mintTx++; s.nft += nftCount(r); }
    else if (['failed', 'unknown', 'unconfirmed', 'app-confirm'].includes(r.status)) s.failed++;
  }
  return m;
}
