// 恢复订单日志中的最终状态；逐行容错，同一订单只保留最后一次更新。
import { readFileSync } from 'node:fs';

export function readOrderHistory(file, limit = 300) {
  let text; try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const orders = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row.id || !row.token || !row.status) continue;
      const ts = Number(row.ts) || Date.parse(row.at);
      if (!Number.isFinite(ts)) continue;
      orders.set(row.id, { ...row, ts, steps: (row.steps || []).map((s) => typeof s === 'string' ? { name: s } : s) });
    } catch { /* 中断写入的坏行不影响其他订单 */ }
  }
  return [...orders.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}
